import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

/** Host store directory. Only meaningful on the host; workers talk to the broker over HTTP. */
export const home = () => process.env.HAUPTLING_HOME || join(homedir(), '.hauptling');

export const BROKER_PORT = Number(process.env.HAUPTLING_PORT || 47800);
export const MAIL_MAX = 300;
export const STATUS_MAX = 100;
export const VENDORS = ['claude', 'codex', 'agy'];

export const hex = (bytes) => randomBytes(bytes).toString('hex');
export const token = () => randomBytes(24).toString('base64url');
export const now = () => new Date().toISOString();

export function bounded(text, max = MAIL_MAX, what = 'Text') {
  text = String(text ?? '').trim();
  if (!text || text.length > max) throw new Error(`${what} must contain 1–${max} characters; say less`);
  return text;
}

export function sanitizeModel(model) {
  const cleaned = String(model || '').toLowerCase().replace(/^claude-/, '').replace(/[^a-z0-9.-]+/g, '-').replace(/^-+|-+$/g, '');
  return cleaned || 'unknown';
}

const IDENTITY = /^(claude|codex|agy)_([a-z0-9][a-z0-9.-]*)_([0-9a-f]{5}|[0-9a-f]{32})$/;
export const isIdentity = (name) => IDENTITY.test(name || '');
export const isFamily = (name) => VENDORS.includes(name);
export function assertIdentity(name) {
  if (!isIdentity(name)) throw new Error(`Identity must look like family_model_key (family claude|codex|agy), got "${name}"`);
  return name;
}

/** Identity of a hand-started session: Claude/agy use 5 session-id characters, Codex the whole UUID (its prefixes repeat). */
export function identityFor(family, model, sessionId) {
  const sid = String(sessionId).toLowerCase().replaceAll('-', '');
  if (!/^[0-9a-f]{32}$/.test(sid)) throw new Error('A session UUID is required');
  return `${family}_${sanitizeModel(model)}_${family === 'codex' ? sid : sid.slice(0, 5)}`;
}

/** POSIX shell quoting, for commands handed to tmux. */
export const sq = (s) => `'${String(s).replaceAll("'", `'\\''`)}'`;
export const shellLine = (argv) => argv.map(sq).join(' ');

/** Parses `--flag value`, repeated flags into arrays, and bare `--switch`. */
export function parseArgs(argv, { repeat = [], bool = [] } = {}) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { out._.push(...argv.slice(i + 1)); break; }
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const [k, inline] = a.slice(2).split(/=(.*)/s);
    const key = k.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    if (bool.includes(k) && inline === undefined) { out[key] = true; continue; }
    const v = inline ?? argv[++i];
    if (v === undefined || (inline === undefined && v.startsWith('--'))) throw new Error(`--${k} needs a value`);
    if (repeat.includes(k)) (out[key] ||= []).push(v); else out[key] = v;
  }
  return out;
}

/** `C:\Users\x\repo` → `/mnt/c/Users/x/repo` (WSL view of a host path). */
export function wslPath(p) {
  const m = /^([a-zA-Z]):[\\/](.*)$/.exec(p);
  return m ? `/mnt/${m[1].toLowerCase()}/${m[2].replaceAll('\\', '/')}` : p.replaceAll('\\', '/');
}

/** GitHub `owner/name` from a URL or shorthand, or null for local repos. */
export function githubSlug(repo) {
  const m = /^(?:https:\/\/github\.com\/|git@github\.com:)?([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(repo || '');
  return m && !/^[a-zA-Z]:/.test(repo) && !repo.startsWith('/') && !repo.startsWith('.') ? `${m[1]}/${m[2]}` : null;
}
