import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { shellLine } from './util.mjs';

/*
 * Web terminal sessions (phase 4b), no pty: frames come from `tmux capture-pane -e` (screen with
 * colour codes), input goes through `tmux send-keys`.
 *   agent sessions:  `<agent id>`            the worker's tmux in its container (host.tmuxScreen/tmuxKeys)
 *   login sessions:  `login-<slot>-<vendor>`  a vendor sign-in on the host (browser OAuth callbacks reach
 *                    the host, not containers), in tmux on a private socket, slot credentials via env
 * Input is off until switched on and turns itself off 10 minutes after the last key.
 */

export const INPUT_IDLE_MS = 10 * 60e3;
const SOCKET = ['-L', 'hauptling'];
const KEYS = new Set(['Enter', 'BSpace', 'Tab', 'BTab', 'Escape', 'Up', 'Down', 'Left', 'Right', 'Home', 'End', 'PPage', 'NPage', 'DC', 'IC', 'Space',
  ...'abcdefghijklmnopqrstuvwxyz'.split('').map(c => `C-${c}`)]);
const LOGIN = { claude: ['claude'], codex: ['codex', 'login'], agy: ['agy'] };
const LOGIN_RE = /^login-(hl-[\w-]+)-(claude|codex|agy)$/;

const tmux = (args, { timeout = 10e3 } = {}) => new Promise((resolve, reject) => {
  execFile('tmux', [...SOCKET, ...args], { timeout }, (err, stdout, stderr) => (err ? reject(new Error((stderr || err.message).trim())) : resolve(stdout)));
});

/** Validates a keys batch: [{ t: 'lit', v: 'text' } | { t: 'key', v: 'Enter' }]. */
export function checkKeys(keys) {
  if (!Array.isArray(keys) || !keys.length || keys.length > 200) throw new Error('keys: 1–200 items');
  for (const k of keys) {
    if (k?.t === 'lit' && typeof k.v === 'string' && k.v.length && k.v.length <= 4000) continue;
    if (k?.t === 'key' && KEYS.has(k.v)) continue;
    throw new Error(`Bad key ${JSON.stringify(k).slice(0, 60)}`);
  }
  return keys;
}

export function createTerminals({ db, host, slotDir, log = () => {}, now = () => Date.now() }) {
  const inputUntil = new Map(); // session → epoch ms

  const agentRow = (id) => db.prepare('SELECT * FROM agents WHERE id = ?').get(id);
  /** Resolves a session id to what it drives; throws for anything else. */
  function resolve(sid) {
    const m = LOGIN_RE.exec(sid);
    if (m) return { kind: 'login', sid, slot: m[1], vendor: m[2] };
    const a = agentRow(sid);
    if (!a || !a.slot || !['spawning', 'restarting', 'paused', 'working', 'blocked', 'done'].includes(a.state)) throw new Error(`No live session ${sid}`);
    return { kind: 'agent', sid, slot: a.slot, id: a.id, state: a.state };
  }

  async function screen(sid) {
    const s = resolve(sid);
    if (s.state === 'paused' || s.state === 'restarting') return { text: null, alive: true };
    if (s.kind === 'agent') return { text: await host.tmuxScreen(s.slot, s.id), alive: await host.tmuxAlive(s.slot, s.id) };
    const dead = await tmux(['display-message', '-p', '-t', `${sid}:`, '#{pane_dead}']).then(o => o.trim() === '1', () => null);
    if (dead === null) return { text: '', alive: false, gone: true };
    return { text: await tmux(['capture-pane', '-p', '-e', '-t', `${sid}:`]), alive: !dead };
  }

  function input(sid, on) {
    const s = resolve(sid);
    if (on && ['paused', 'restarting'].includes(s.state)) throw new Error(`Session is ${s.state}`);
    if (on) inputUntil.set(sid, now() + INPUT_IDLE_MS); else inputUntil.delete(sid);
    return inputState(sid);
  }
  function inputState(sid) {
    const state = agentRow(sid)?.state;
    if (state === 'paused' || state === 'restarting') {
      inputUntil.delete(sid);
      return { input: false, until: null, state };
    }
    const until = inputUntil.get(sid) || 0;
    if (until && until <= now()) inputUntil.delete(sid);
    return { input: until > now(), until: until > now() ? new Date(until).toISOString() : null };
  }

  async function keys(sid, batch) {
    const s = resolve(sid);
    checkKeys(batch);
    if (!inputState(sid).input) throw new Error('Input is off for this session: switch it on first');
    inputUntil.set(sid, now() + INPUT_IDLE_MS);
    for (const k of batch) {
      const args = k.t === 'lit' ? ['-l', k.v] : [k.v];
      if (s.kind === 'agent') await host.tmuxKeys(s.slot, s.id, args);
      else await tmux(['send-keys', '-t', `${sid}:`, ...args]);
    }
    return inputState(sid);
  }

  /** Starts a vendor sign-in on the host in tmux, input on. Same env as `hauptling login`. */
  /** A worker of this vendor running on the slot: it refreshes the same credential file. */
  const runningOn = (slot, vendor) => db.prepare("SELECT id FROM agents WHERE slot = ? AND vendor = ? AND state IN ('spawning','restarting','paused','working','blocked','done')").get(slot, vendor)?.id || null;

  async function startLogin(slot, vendor) {
    if (!/^hl-[\w-]+$/.test(slot) || !LOGIN[vendor]) throw new Error('slot and vendor (claude, codex, agy) are required');
    // Refresh tokens rotate (Claude, Codex; agy's MCP tokens): a second process refreshing the same file signs the other out.
    const busy = runningOn(slot, vendor);
    if (busy) throw new Error(`${busy} is running on ${slot} with this ${vendor} sign-in; signing in again now could sign it out mid-task. Wait until it ends (or kill it), then sign in.`);
    const sid = `login-${slot}-${vendor}`;
    await tmux(['kill-session', '-t', sid]).catch(() => {});
    const dir = slotDir(slot);
    const env = vendor === 'claude' ? { CLAUDE_CONFIG_DIR: join(dir, 'claude') } : vendor === 'codex' ? { CODEX_HOME: join(dir, 'codex') } : {};
    if (vendor === 'agy') {
      const fake = join(dir, 'agy-home');
      mkdirSync(fake, { recursive: true });
      if (!existsSync(join(fake, '.gemini'))) symlinkSync(join(dir, 'gemini'), join(fake, '.gemini'));
      env.HOME = fake;
    }
    const cmd = shellLine(['env', ...Object.entries(env).map(([k, v]) => `${k}=${v}`), ...LOGIN[vendor]]);
    await tmux(['new-session', '-d', '-s', sid, '-x', '120', '-y', '36', '-c', dir, cmd]);
    await tmux(['set-option', '-t', sid, 'remain-on-exit', 'on']).catch(() => {});
    inputUntil.set(sid, now() + INPUT_IDLE_MS);
    log(`login session ${sid}`);
    return { sid };
  }

  async function stopLogin(sid) {
    if (!LOGIN_RE.test(sid)) throw new Error(`Not a login session: ${sid}`);
    inputUntil.delete(sid);
    await tmux(['kill-session', '-t', sid]).catch(() => {});
  }

  return { resolve, screen, input, inputState, keys, startLogin, stopLogin, runningOn };
}
