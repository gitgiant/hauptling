import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir, release } from 'node:os';
import { fileURLToPath } from 'node:url';
import { githubSlug } from './util.mjs';

/** "Report an issue" from the dashboard (F2): build a scrubbed body and file it with the host's `gh`. */

export const DEFAULT_ISSUE_REPO = 'gitgiant/hauptling';
export const ISSUE_LABEL = 'dashboard';
const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** Shapes of credentials that must never leave the machine, whatever their origin. */
const PATTERNS = [
  [/\b(?:sk|rk|pk)-[A-Za-z0-9_-]{16,}/g, '•••'],
  [/\bAIza[\w-]{30,}/g, '•••'],
  [/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[\w]{20,})/g, '•••'],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, '•••'],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, '•••'],
  [/\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}/g, '•••'],
  [/\b(Bearer|Basic)\s+[\w.~+/=-]{8,}/gi, '$1 •••'],
  [/\b(authorization|cookie|set-cookie|x-api-key|api[-_]?key)(\s*[:=]\s*)[^\r\n]+/gi, '$1$2•••'],
  [/\bhl_dash=[^\s;]+/g, 'hl_dash=•••'],
  [/\b(token|nonce|secret|password|passwd)(["']?\s*[:=]\s*["']?)[\w.~+/=-]{8,}/gi, '$1$2•••'],
];

/** Home directories to hide: the broker user's and any /home/x, /Users/x, C:\Users\x path. */
const HOME_PATTERNS = [/\/home\/[^/\s'"`]+/g, /\/Users\/[^/\s'"`]+/g, /\/mnt\/[a-z]\/Users\/[^/\s'"`]+/gi, /[A-Za-z]:\\+Users\\+[^\\\s'"`]+/g];

/**
 * Removes secrets from text: exact `secrets` values (agent/dashboard/admin tokens, nonces), known
 * API-key and cookie shapes, and the user's home path (→ ~).
 * @param {string} text
 * @param {string[]} [secrets]
 * @param {string} [home]
 */
export function scrubText(text, secrets = [], home = homedir()) {
  let out = String(text ?? '');
  for (const s of [...new Set(secrets)].filter(s => s && s.length >= 8).sort((a, b) => b.length - a.length)) out = out.replaceAll(s, '•••');
  if (home && home.length > 1) out = out.replaceAll(home, '~').replaceAll(home.replaceAll('/', '\\'), '~');
  for (const re of HOME_PATTERNS) out = out.replace(re, '~');
  for (const [re, to] of PATTERNS) out = out.replace(re, to);
  return out;
}

/** `owner/name` to file issues in: host config `issueRepo`, else the checkout's origin, else the default. */
export function issueRepo(cfg, originUrl) {
  return (cfg?.issueRepo && githubSlug(cfg.issueRepo)) || githubSlug(originUrl) || DEFAULT_ISSUE_REPO;
}

const run = (cmd, args) => new Promise((resolve) => execFile(cmd, args, { timeout: 5e3, cwd: ROOT }, (err, stdout) => resolve(err ? '' : stdout.trim())));

/** What the broker knows: version/commit, OS, last 20 log lines. */
export async function brokerFacts(logPath) {
  const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
  const commit = await run('git', ['rev-parse', '--short', 'HEAD']);
  const wsl = /microsoft|wsl/i.test(release());
  const os = wsl ? 'WSL' : process.platform === 'darwin' ? 'macOS' : process.platform === 'linux' ? 'Linux' : process.platform;
  let log = [];
  try { log = readFileSync(logPath, 'utf8').trimEnd().split('\n').slice(-20); } catch {}
  return { version, commit, os: `${os} (${release()})`, log };
}

/**
 * The issue body: the user's description plus, when asked, a short context block.
 * `client` is what the browser reports (view, tab, agent, viewport, theme); `facts` is brokerFacts().
 */
export function buildBody({ description = '', include = true, client = {}, facts = {} }) {
  const parts = [String(description).trim()];
  if (include) {
    const a = client.agent;
    const lines = [
      `- Dashboard: ${client.view || '?'}${client.tab ? ` / ${client.tab}` : ''}`,
      a ? `- Agent: ${a.id} (${a.vendor || '?'}, ${a.state || '?'})` : null,
      `- Viewport: ${client.viewport || '?'}, theme ${client.theme || '?'}`,
      `- Hauptling: ${facts.version || '?'}${facts.commit ? ` (${facts.commit})` : ''}`,
      `- OS: ${facts.os || '?'}`,
    ].filter(Boolean);
    parts.push(`<details><summary>Context</summary>\n\n${lines.join('\n')}\n\nBroker log (last ${facts.log?.length || 0} lines):\n\n\`\`\`\n${(facts.log || []).join('\n')}\n\`\`\`\n</details>`);
  }
  return parts.filter(Boolean).join('\n\n');
}

export const issueArgv = (repo, title, { label = false } = {}) =>
  ['issue', 'create', '-R', repo, '--title', title, '--body-file', '-', ...(label ? ['--label', ISSUE_LABEL] : [])];

/**
 * Files the issue with `gh` (injected, so tests can stub it). Tries the `dashboard` label (creating it
 * if missing) and files without it if that fails. Returns the issue URL.
 * @param {{ gh: (args: string[], opts?: object) => Promise<string>, repo: string, title: string, body: string }} o
 */
export async function fileIssue({ gh, repo, title, body, screenshot }) {
  if (!String(title || '').trim()) throw new Error('Title is required');
  let note = '';
  if (screenshot) {
    try { body = `${body}\n\n![screenshot](${await uploadScreenshot({ gh, repo, image: screenshot })})`; }
    catch (e) { note = `Screenshot not attached: ${e.message}`; body = `${body}\n\n_${note}_`; }
  }
  let label = true;
  try { await gh(['label', 'create', ISSUE_LABEL, '-R', repo, '--description', 'Reported from the Hauptling dashboard', '--color', '0e8a16']); }
  catch (e) { if (!/already exists/i.test(e.message)) label = false; }
  const create = (withLabel) => gh(issueArgv(repo, title.trim(), { label: withLabel }), { input: body });
  let out;
  try { out = await create(label); }
  catch (e) { if (!label || !/label/i.test(e.message)) throw e; out = await create(false); }
  const url = /https:\/\/\S+/.exec(out)?.[0];
  if (!url) throw new Error(`gh returned no issue URL: ${out.slice(-200)}`);
  return note ? { url, note } : url;
}

export const SCREENSHOT_BRANCH = 'issue-screenshots';
export const SCREENSHOT_MAX = 5 * 1024 * 1024;

/** Decodes a base64 image (optionally a data: URL); throws unless it is PNG or JPEG (magic bytes) and under 5 MB. */
export function checkImage(b64) {
  const raw = String(b64 || '').replace(/^data:[^,]*,/, '');
  if (raw.length > Math.ceil(SCREENSHOT_MAX * 4 / 3) + 4) throw new Error('Screenshot is over 5 MB');
  const buf = Buffer.from(raw, 'base64');
  if (buf.length > SCREENSHOT_MAX) throw new Error('Screenshot is over 5 MB');
  const png = buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const jpg = buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  if (!png && !jpg) throw new Error('Screenshot is not a PNG or JPEG image');
  return { buf, ext: png ? 'png' : 'jpg' };
}

const api = (gh, method, path, json) => gh(['api', '-X', method, path, '--input', '-'], { input: JSON.stringify(json) });

/** Commits the image to the orphan `issue-screenshots` branch (made first if missing); returns the embeddable URL. */
export async function uploadScreenshot({ gh, repo, image, now = new Date() }) {
  const { buf, ext } = checkImage(image);
  try { await gh(['api', `repos/${repo}/git/ref/heads/${SCREENSHOT_BRANCH}`]); }
  catch {
    const tree = JSON.parse(await api(gh, 'POST', `repos/${repo}/git/trees`, { tree: [{ path: 'README.md', mode: '100644', type: 'blob', content: 'Screenshots attached to issues filed from the Hauptling dashboard.\n' }] }));
    const commit = JSON.parse(await api(gh, 'POST', `repos/${repo}/git/commits`, { message: 'Start issue-screenshots', tree: tree.sha, parents: [] }));
    await api(gh, 'POST', `repos/${repo}/git/refs`, { ref: `refs/heads/${SCREENSHOT_BRANCH}`, sha: commit.sha });
  }
  const path = `${now.toISOString().slice(0, 7)}/${randomBytes(8).toString('hex')}.${ext}`;
  await api(gh, 'PUT', `repos/${repo}/contents/${path}`, { message: 'Add screenshot', content: buf.toString('base64'), branch: SCREENSHOT_BRANCH });
  return `https://github.com/${repo}/blob/${SCREENSHOT_BRANCH}/${path}?raw=true`;
}

export const originUrl = () => run('git', ['remote', 'get-url', 'origin']);
