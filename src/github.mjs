import { execFile } from 'node:child_process';

/** Host-side GitHub via your `gh` login. Workers never hold GitHub credentials. */

const ghBin = () => process.env.HAUPTLING_GH || 'gh';

export function gh(args, { timeout = 60e3 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(ghBin(), args, { timeout, maxBuffer: 8 << 20 }, (err, stdout, stderr) => {
      if (err) { err.message = `gh ${args.slice(0, 2).join(' ')}: ${(stderr || err.message).trim().slice(-500)}`; err.stderr = stderr; reject(err); }
      else resolve(stdout.trim());
    });
  });
}

let cachedToken = null;
export async function ghToken() {
  cachedToken ||= await gh(['auth', 'token']);
  return cachedToken;
}

/** Env that lets one git command authenticate to github.com without storing the token anywhere. */
export async function gitAuthEnv() {
  const basic = Buffer.from(`x-access-token:${await ghToken()}`).toString('base64');
  return { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader', GIT_CONFIG_VALUE_0: `Authorization: Basic ${basic}`, GIT_TERMINAL_PROMPT: '0' };
}

export async function prCreate(slug, head, base, title, body) {
  const url = await gh(['pr', 'create', '-R', slug, '--head', head, '--base', base, '--title', title, '--body', body]);
  const line = url.split('\n').pop();
  return { url: line, number: Number(line.split('/').pop()) };
}

export async function prFind(slug, head) {
  const out = JSON.parse(await gh(['pr', 'list', '-R', slug, '--head', head, '--state', 'open', '--json', 'number,url']));
  return out[0] || null;
}

/** Required status checks on the base branch; [] when unprotected or none required. */
export async function requiredChecks(slug, base) {
  try {
    const r = JSON.parse(await gh(['api', `repos/${slug}/branches/${encodeURIComponent(base)}/protection/required_status_checks`]));
    return [...(r.contexts || []), ...(r.checks || []).map(c => c.context)];
  } catch (e) {
    if (/404|Not Found|not protected/i.test(e.message)) return [];
    throw e;
  }
}

export const prAutoMerge = (slug, n) => gh(['pr', 'merge', String(n), '-R', slug, '--auto', '--squash', '--delete-branch']);
export const prMerge = (slug, n) => gh(['pr', 'merge', String(n), '-R', slug, '--squash', '--delete-branch']);
export async function prView(slug, n) {
  return JSON.parse(await gh(['pr', 'view', String(n), '-R', slug, '--json', 'state,headRefOid,statusCheckRollup']));
}
