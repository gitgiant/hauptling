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
export async function fileIssue({ gh, repo, title, body }) {
  if (!String(title || '').trim()) throw new Error('Title is required');
  let label = true;
  try { await gh(['label', 'create', ISSUE_LABEL, '-R', repo, '--description', 'Reported from the Hauptling dashboard', '--color', '0e8a16']); }
  catch (e) { if (!/already exists/i.test(e.message)) label = false; }
  const create = (withLabel) => gh(issueArgv(repo, title.trim(), { label: withLabel }), { input: body });
  let out;
  try { out = await create(label); }
  catch (e) { if (!label || !/label/i.test(e.message)) throw e; out = await create(false); }
  const url = /https:\/\/\S+/.exec(out)?.[0];
  if (!url) throw new Error(`gh returned no issue URL: ${out.slice(-200)}`);
  return url;
}

export const originUrl = () => run('git', ['remote', 'get-url', 'origin']);
