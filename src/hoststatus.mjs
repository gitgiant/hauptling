import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { home } from './util.mjs';

/*
 * The delegator's own usage (token economy): the host CLI's status line runs `hauptling usage <vendor> --host`,
 * which forwards the vendor JSON to the broker and then runs the user's previous status-line command (kept in
 * ~/.hauptling/statusline-prev.json) so its output is what the user sees. Codex has no status line: the broker
 * reads the host's ~/.codex session log instead. No model tokens.
 */

const OURS = (v) => `hauptling usage ${v} --host`;
const SETTINGS = { claude: (h) => join(h, '.claude', 'settings.json'), agy: (h) => join(h, '.gemini', 'antigravity-cli', 'settings.json') };
const prevPath = () => join(home(), 'statusline-prev.json');
const readJson = (p) => (existsSync(p) ? JSON.parse(readFileSync(p, 'utf8') || '{}') : {});
const writeJson = (p, v) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, JSON.stringify(v, null, 2) + '\n'); };

/** Points the host's Claude and agy status lines at hauptling, keeping any previous command to chain. Idempotent. */
export function installStatusLines(h = homedir()) {
  const prev = readJson(prevPath());
  const done = [];
  for (const [vendor, path] of Object.entries(SETTINGS)) {
    const p = path(h);
    if (!existsSync(dirname(p))) continue; // that CLI isn't installed on the host
    const s = readJson(p);
    if (s.statusLine?.command !== OURS(vendor)) {
      if (s.statusLine?.command) prev[vendor] = s.statusLine.command;
      s.statusLine = { ...(s.statusLine || {}), type: 'command', command: OURS(vendor) };
      writeJson(p, s);
    }
    done.push(`${vendor}: ${p}${prev[vendor] ? ` (chains: ${prev[vendor]})` : ''}`);
  }
  writeJson(prevPath(), prev);
  return done;
}

/** Runs the user's previous status-line command with the same stdin; null when there is none or it fails. */
export function chained(vendor, stdin) {
  const cmd = readJson(prevPath())[vendor];
  if (!cmd) return null;
  const r = spawnSync('sh', ['-c', cmd], { input: stdin, encoding: 'utf8', timeout: 2000 });
  return r.status === 0 ? r.stdout.replace(/\n$/, '') : null;
}
