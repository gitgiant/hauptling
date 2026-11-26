import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';

/*
 * Parked workers (PRD "Parking"): a worker's vendor session transcript is copied out of its slot when its
 * container is removed, and into whichever slot it later resumes on. An allowlist: only transcript files
 * named by the session id, under each vendor's session root. Never credentials or other slot files.
 */

/** Session roots inside a slot dir (`~/.hauptling/slots/<slot>/`), per vendor. agy: none known, so it unparks fresh. */
export const SESSION_ROOTS = { claude: ['claude/projects'], codex: ['codex/sessions', 'codex-key/sessions'], agy: [] };

const ID = /^[A-Za-z0-9_-]{4,128}$/;

/** Regular files under `dir` (symlinks are skipped, never followed). */
function files(dir, out = []) {
  let entries = [];
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) files(p, out);
    else if (e.isFile()) out.push(p);
  }
  return out;
}

/**
 * Transcript files of `sessionId` in a slot dir, as slot-relative paths. Claude: `projects/<cwd>/<id>.jsonl` and
 * everything under `projects/<cwd>/<id>/` (subagent transcripts, tool results). Codex: rollout files whose name
 * contains the id, anywhere under `sessions/`.
 */
export function sessionFiles(slotRoot, vendor, sessionId) {
  if (!sessionId || !ID.test(sessionId)) return [];
  const out = [];
  for (const root of SESSION_ROOTS[vendor] || []) {
    const base = join(slotRoot, root);
    if (!existsSync(base) || lstatSync(base).isSymbolicLink()) continue;
    for (const f of files(base)) {
      const rel = relative(base, f).split(sep);
      const ok = vendor === 'claude'
        ? rel.length >= 2 && (rel[1] === `${sessionId}.jsonl` || (rel.length >= 3 && rel[1] === sessionId))
        : rel.at(-1).includes(sessionId) && rel.at(-1).endsWith('.jsonl');
      if (ok) out.push(join(root, ...rel));
    }
  }
  return out.sort();
}

/** Copies the session out of the slot into `store` (replacing an older copy). Returns the slot-relative paths copied. */
export function saveSession({ slotRoot, store, vendor, sessionId }) {
  const list = sessionFiles(slotRoot, vendor, sessionId);
  rmSync(join(store, 'files'), { recursive: true, force: true });
  for (const rel of list) {
    const to = join(store, 'files', rel);
    mkdirSync(dirname(to), { recursive: true });
    cpSync(join(slotRoot, rel), to, { dereference: false });
  }
  return list;
}

/**
 * Copies a saved session into a slot dir. Codex: into the dir the new container uses (`codex-key` on the API
 * key, else `codex`), whichever one it was saved from. Returns the slot-relative paths written.
 */
export function restoreSession({ slotRoot, store, vendor, billing = null }) {
  const from = join(store, 'files');
  const out = [];
  for (const f of files(from)) {
    const rel = relative(from, f).split(sep);
    if (!(SESSION_ROOTS[vendor] || []).some(r => rel.join('/').startsWith(`${r}/`))) continue; // only what save could have written
    if (vendor === 'codex') rel[0] = billing === 'api' ? 'codex-key' : 'codex';
    const to = join(slotRoot, ...rel);
    mkdirSync(dirname(to), { recursive: true });
    cpSync(f, to);
    out.push(rel.join('/'));
  }
  return out.sort();
}

export function dropSession(store) { rmSync(store, { recursive: true, force: true }); }
