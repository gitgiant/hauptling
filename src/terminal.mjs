import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, symlinkSync } from 'node:fs';
import { join as pathJoin } from 'node:path';
import { HELD, isHeld } from './db.mjs';
import { shellLine } from './util.mjs';

/*
 * Web terminal sessions (phase 4b), no pty: frames come from `tmux capture-pane -e` (screen with
 * colour codes), input goes through `tmux send-keys`.
 *   agent sessions:  `<agent id>`            the worker's tmux in its container (host.tmuxScreen/tmuxKeys)
 *   login sessions:  `login-<slot>-<vendor>`  a vendor sign-in on the host (browser OAuth callbacks reach
 *                    the host, not containers), in tmux on a private socket, slot credentials via env
 *   remote sessions: `<agent id>` of an agent on a satellite (part 3): its screen and keys go through the hub's
 *                    `rpc` (`term.screen`, `term.keys`); the input switch stays here, on the hub.
 * Input is off until switched on and turns itself off 10 minutes after the last key.
 * Agent windows follow the smallest viewer that asks for a size (PRD "Web terminal size"); sign-in sessions don't.
 */

export const INPUT_IDLE_MS = 10 * 60e3;
/** Bounds a viewer's size is clamped to: [min, max]. */
export const SIZE_COLS = [40, 400];
export const SIZE_ROWS = [10, 150];
/** At most one resize per agent in this long; an unchanged size is re-applied every RESIZE_REFRESH_MS while viewed. */
export const RESIZE_GAP_MS = 500;
export const RESIZE_REFRESH_MS = 2000;
/** On a satellite: a relayed size not refreshed for this long is undone. */
export const RESIZE_LEASE_MS = 15e3;
/** A restore with no viewer left is given up after this many failures. */
const RESTORE_TRIES = 5;
const SOCKET = ['-L', 'hauptling'];
const KEYS = new Set(['Enter', 'BSpace', 'Tab', 'BTab', 'Escape', 'Up', 'Down', 'Left', 'Right', 'Home', 'End', 'PPage', 'NPage', 'DC', 'IC', 'Space',
  ...'abcdefghijklmnopqrstuvwxyz'.split('').map(c => `C-${c}`)]);
const LOGIN = { claude: ['claude'], codex: ['codex', 'login'], agy: ['agy'] };
const LOGIN_RE = /^login-(hl-[\w-]+)-(claude|codex|agy)$/;
const LIVE = ['spawning', 'restarting', 'paused', 'working', 'blocked', 'done'];
/** A relayed screen is cut to this (a tmux screen is a few KB; this only guards against a runaway pane). */
export const SCREEN_MAX = 256 * 1024;
/** Relayed scrollback is cut to its last this-many bytes (500 lines with colour codes stay well under). */
export const HISTORY_MAX = 1024 * 1024;

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

/**
 * Raw terminal input (what `hauptling attach` reads from stdin in raw mode) → a keys batch. Ctrl-] is the
 * detach key: everything from it on is dropped and `detach` is set.
 */
export function keysFromBytes(str) {
  const SEQ = { '[A': 'Up', '[B': 'Down', '[C': 'Right', '[D': 'Left', '[H': 'Home', '[F': 'End', 'OA': 'Up', 'OB': 'Down', 'OC': 'Right', 'OD': 'Left', 'OH': 'Home', 'OF': 'End',
    '[1~': 'Home', '[4~': 'End', '[2~': 'IC', '[3~': 'DC', '[5~': 'PPage', '[6~': 'NPage', '[Z': 'BTab' };
  const keys = [];
  const lit = (c) => { const p = keys[keys.length - 1]; if (p?.t === 'lit' && p.v.length < 4000) p.v += c; else keys.push({ t: 'lit', v: c }); };
  const key = (v) => keys.push({ t: 'key', v });
  for (let i = 0; i < str.length; i++) {
    const c = str[i], code = c.charCodeAt(0);
    if (c === '\x1d') return { keys, detach: true };
    if (c === '\x1b') {
      const seq = Object.keys(SEQ).find(k => str.startsWith(k, i + 1));
      if (seq) { key(SEQ[seq]); i += seq.length; } else key('Escape');
    } else if (c === '\r' || c === '\n') key('Enter');
    else if (c === '\t') key('Tab');
    else if (c === '\x7f' || c === '\b') key('BSpace');
    else if (code >= 1 && code <= 26) key(`C-${String.fromCharCode(96 + code)}`);
    else if (code >= 32) lit(c);
  }
  return { keys, detach: false };
}

/** A viewer's `{ cols, rows }`, rounded down and clamped; throws unless both are numbers. */
export function clampSize(size) {
  const clamp = (v, [min, max]) => {
    if (!Number.isFinite(v)) throw new Error('size: { cols, rows } as numbers, or null');
    return Math.min(Math.max(Math.floor(v), min), max);
  };
  return { cols: clamp(size?.cols, SIZE_COLS), rows: clamp(size?.rows, SIZE_ROWS) };
}

/** `rpc(host, op, args)`: on the hub, a request to a satellite over its link (hub.rpc); null elsewhere. */
export function createTerminals({ db, host, slotDir, loginTmux = tmux, hold = () => () => {}, rpc = null, log = () => {}, now = () => Date.now(), later = (fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return () => clearTimeout(t); } }) {
  const inputUntil = new Map(); // session → epoch ms
  /** session → { views: viewer → size|null, sent: last applied key, held: a web size may be in force, at, busy, cancel, fails } */
  const sizing = new Map();
  const leases = new Map(); // on a satellite: agent → cancel of the pending restore

  const agentRow = (id) => db.prepare('SELECT * FROM agents WHERE id = ?').get(id);
  /** Resolves a session id to what it drives; throws for anything else. */
  function resolve(sid) {
    const m = LOGIN_RE.exec(sid);
    if (m) return { kind: 'login', sid, slot: m[1], vendor: m[2] };
    const a = agentRow(sid);
    if (!a || !a.slot || !LIVE.includes(a.state) || isHeld(a)) throw new Error(`No live session ${sid}`);
    if (a.host && a.host !== 'hub') {
      if (!rpc) throw new Error(`${sid} runs on ${a.host}; its terminal is there`);
      return { kind: 'remote', sid, host: a.host, id: a.id, state: a.state };
    }
    return { kind: 'agent', sid, slot: a.slot, id: a.id, state: a.state };
  }

  /**
   * The screen now, and `history`: the scrollback above it (null when unknown). Remote sessions pass `since` and
   * `sinceHistory` (hashes of the last screen and history they got): an unchanged one comes back as null, and
   * `hash` / `historyHash` name new ones.
   */
  async function screen(sid, since = null, sinceHistory = null) {
    const s = resolve(sid);
    if (s.state === 'paused' || s.state === 'restarting') return { text: null, history: null, alive: true };
    if (s.kind === 'remote') {
      const r = await rpc(s.host, 'term.screen', { agent: s.id, since, sinceHistory });
      const text = r?.same || typeof r?.text !== 'string' ? null : r.text.slice(0, SCREEN_MAX);
      const history = typeof r?.history === 'string' ? r.history.slice(-HISTORY_MAX) : null;
      return { text, hash: text === null ? undefined : r.hash, history, historyHash: history === null ? undefined : r.historyHash, alive: r?.alive !== false };
    }
    if (s.kind === 'agent') {
      const [text, history, alive] = await Promise.all([host.tmuxScreen(s.slot, s.id), Promise.resolve(host.tmuxHistory?.(s.slot, s.id)).catch(() => null), host.tmuxAlive(s.slot, s.id)]);
      return { text, history: history ?? null, alive };
    }
    const dead = await tmux(['display-message', '-p', '-t', `${sid}:`, '#{pane_dead}']).then(o => o.trim() === '1', () => null);
    if (dead === null) return { text: '', history: null, alive: false, gone: true };
    const [text, history] = await Promise.all([tmux(['capture-pane', '-p', '-e', '-t', `${sid}:`]), tmux(['capture-pane', '-p', '-e', '-t', `${sid}:`, '-S', '-500', '-E', '-1']).catch(() => null)]);
    return { text, history, alive: !dead };
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
    if (s.kind === 'remote') {
      await rpc(s.host, 'term.keys', { agent: s.id, keys: batch }).catch(e => {
        throw /offline/.test(e.message) ? new Error(`${s.host} is offline; keys are not queued`) : e;
      });
      return inputState(sid);
    }
    for (const k of batch) {
      const args = k.t === 'lit' ? ['-l', k.v] : [k.v];
      if (s.kind === 'agent') await host.tmuxKeys(s.slot, s.id, args);
      else await tmux(['send-keys', '-t', `${sid}:`, ...args]);
    }
    return inputState(sid);
  }

  /**
   * On a satellite: keys the hub relays for one of its agents (the hub keeps the input switch; `hauptling attach`
   * on the hub has none). Never a login session.
   */
  async function relayKeys(id, batch) {
    const s = resolve(id);
    if (s.kind !== 'agent') throw new Error(`No live session ${id}`);
    if (['paused', 'restarting'].includes(s.state)) throw new Error(`Session is ${s.state}`);
    checkKeys(batch);
    for (const k of batch) await host.tmuxKeys(s.slot, s.id, k.t === 'lit' ? ['-l', k.v] : [k.v]);
    return { ok: true };
  }

  /** A worker of this vendor running on the slot: it refreshes the same credential file. */
  const runningOn = (slot, vendor) => db.prepare(`SELECT id FROM agents WHERE slot = ? AND vendor = ? AND state IN ('spawning','restarting','paused','working','blocked','done') AND NOT ${HELD}`).get(slot, vendor)?.id || null;

  // ---------- window size ----------
  const sizeEntry = (sid) => {
    let z = sizing.get(sid);
    if (!z) sizing.set(sid, z = { views: new Map(), sent: null, held: false, at: -Infinity, busy: null, cancel: null, fails: 0 });
    return z;
  };
  /** A viewer (one open terminal stream) arrives; it counts for the size once it sends one. */
  function join(sid, viewer) {
    if (!LOGIN_RE.test(sid)) sizeEntry(sid).views.set(viewer, null);
  }
  /** A viewer's size, or null to stop counting it. Unknown viewers (a closed stream) are ignored. */
  function resize(sid, viewer, size) {
    const clean = size == null ? null : clampSize(size);
    const z = sizing.get(sid);
    if (!z?.views.has(viewer)) return Promise.resolve();
    z.views.set(viewer, clean);
    return sync(sid);
  }
  function leave(sid, viewer) {
    return sizing.get(sid)?.views.delete(viewer) ? sync(sid) : Promise.resolve();
  }
  function drop(sid) {
    sizing.get(sid)?.cancel?.();
    sizing.delete(sid);
  }
  /** Runs `sync` again in `ms`: the rate limit, and a restore that no open stream would retry. */
  function again(sid, z, ms) {
    z.cancel ||= later(() => { z.cancel = null; return sync(sid); }, ms);
  }
  /** Brings the agent's window to what its viewers want; called on every change and on each stream poll. */
  function sync(sid) {
    const z = sizing.get(sid);
    if (!z) return Promise.resolve();
    if (z.busy) return z.busy;
    const sizes = [...z.views.values()].filter(Boolean);
    const want = sizes.length ? { cols: Math.min(...sizes.map(s => s.cols)), rows: Math.min(...sizes.map(s => s.rows)) } : null;
    if (!want && !z.held) {
      if (!z.views.size) drop(sid);
      return Promise.resolve();
    }
    const key = want ? `${want.cols}x${want.rows}` : '';
    const wait = z.at + (key !== z.sent ? RESIZE_GAP_MS : RESIZE_REFRESH_MS) - now();
    if (wait > 0) {
      if (key !== z.sent || !want) again(sid, z, wait); // a restore may have no stream left to retry it
      return Promise.resolve();
    }
    let s;
    try { s = resolve(sid); } catch { drop(sid); return Promise.resolve(); } // the agent ended: its window is gone
    if (s.state === 'paused' || s.state === 'restarting') {
      if (!want) again(sid, z, RESIZE_REFRESH_MS);
      return Promise.resolve();
    }
    z.at = now();
    if (want) z.held = true;
    z.busy = (async () => {
      if (s.kind === 'remote') await rpc(s.host, 'term.resize', { agent: s.id, size: want });
      else await host.tmuxResize(s.slot, s.id, want);
    })().then(() => {
      z.busy = null; z.sent = key; z.fails = 0;
      if (!want) z.held = false;
      return sync(sid); // a viewer changed meanwhile
    }, (e) => {
      z.busy = null; z.sent = key;
      if (!z.fails++) log(`terminal size ${sid}: ${e.message}`);
      if (want) return;
      if (z.fails < RESTORE_TRIES) again(sid, z, RESIZE_REFRESH_MS);
      else { z.held = false; if (!z.views.size) drop(sid); }
    });
    return z.busy;
  }

  /** On a satellite: the size the hub relays for one of its agents (null restores). */
  async function relayResize(id, size) {
    const clean = size == null ? null : clampSize(size);
    const s = resolve(id);
    if (s.kind !== 'agent') throw new Error(`No live session ${id}`);
    leases.get(id)?.();
    leases.delete(id);
    const expire = () => { leases.set(id, later(() => relayResize(id, null).catch(e => log(`terminal size ${id}: ${e.message}`)), RESIZE_LEASE_MS)); };
    if (s.state === 'paused' || s.state === 'restarting') { expire(); return { ok: true }; } // restored once it is live
    if (clean) expire();
    await host.tmuxResize(s.slot, s.id, clean);
    return { ok: true };
  }

  /** At broker start nobody is watching yet: this host's agents get their default size back. */
  async function restoreSizes() {
    const rows = db.prepare(`SELECT id, slot FROM agents WHERE slot IS NOT NULL AND (host IS NULL OR host = 'hub') AND state IN ('spawning','working','blocked','done')`).all();
    await Promise.all(rows.filter(a => !sizing.has(a.id)).map(a => Promise.resolve(host.tmuxResize?.(a.slot, a.id, null)).catch(e => log(`terminal size ${a.id}: ${e.message}`))));
  }

  /** Starts a vendor sign-in on the host in tmux, input on. Same env as `hauptling login`. */
  async function startLogin(slot, vendor) {
    if (!/^hl-[\w-]+$/.test(slot) || !LOGIN[vendor]) throw new Error('slot and vendor (claude, codex, agy) are required');
    // Refresh tokens rotate (Claude, Codex; agy's MCP tokens): a second process refreshing the same file signs the other out.
    const busy = runningOn(slot, vendor);
    if (busy) throw new Error(`${busy} is running on ${slot} with this ${vendor} sign-in; signing in again now could sign it out mid-task. Wait until it ends (or kill it), then sign in.`);
    const release = hold(slot, vendor); // not while a usage refresh runs this sign-in
    try { return await openLogin(slot, vendor); } finally { release(); }
  }
  async function openLogin(slot, vendor) {
    const sid = `login-${slot}-${vendor}`;
    await loginTmux(['kill-session', '-t', sid]).catch(() => {});
    const dir = slotDir(slot);
    const env = vendor === 'claude' ? { CLAUDE_CONFIG_DIR: pathJoin(dir, 'claude') } : vendor === 'codex' ? { CODEX_HOME: pathJoin(dir, 'codex') } : {};
    if (vendor === 'agy') {
      const fake = pathJoin(dir, 'agy-home');
      mkdirSync(fake, { recursive: true });
      if (!existsSync(pathJoin(fake, '.gemini'))) symlinkSync(pathJoin(dir, 'gemini'), pathJoin(fake, '.gemini'));
      env.HOME = fake;
    }
    const cmd = shellLine(['env', ...Object.entries(env).map(([k, v]) => `${k}=${v}`), ...LOGIN[vendor]]);
    await loginTmux(['new-session', '-d', '-s', sid, '-x', '120', '-y', '36', '-c', dir, cmd]);
    await loginTmux(['set-option', '-t', sid, 'remain-on-exit', 'on']).catch(() => {});
    inputUntil.set(sid, now() + INPUT_IDLE_MS);
    log(`login session ${sid}`);
    return { sid };
  }

  async function stopLogin(sid) {
    if (!LOGIN_RE.test(sid)) throw new Error(`Not a login session: ${sid}`);
    inputUntil.delete(sid);
    await tmux(['kill-session', '-t', sid]).catch(() => {});
  }

  return { resolve, screen, input, inputState, keys, relayKeys, join, resize, leave, sync, relayResize, restoreSizes, startLogin, stopLogin, runningOn };
}

/** Whether a dashboard sign-in for this slot × vendor is still running (tmux on this host). */
export const signingIn = (slot, vendor) => tmux(['display-message', '-p', '-t', `login-${slot}-${vendor}:`, '#{pane_dead}']).then(o => o.trim() === '0', () => false);
/** Ends a dashboard sign-in for this slot × vendor, if one is open. */
export const stopSignin = (slot, vendor) => tmux(['kill-session', '-t', `login-${slot}-${vendor}`]).then(() => true, () => false);

/**
 * `hauptling attach` on the hub for an agent on a satellite (PRD "Part 3"): redraws the relayed screen when it
 * changes and sends keystrokes (`stdin` in raw mode); Ctrl-] detaches. `call(name, args)` is the broker API.
 * Resolves with the reason it stopped.
 */
export function attachRemote({ call, agent, host, stdin = process.stdin, stdout = process.stdout, everyMs = 250 }) {
  return new Promise((resolveDone) => {
    let hash = null, busy = false, stopped = false, status = '', sending = Promise.resolve();
    const draw = (text) => stdout.write(`\x1b[H\x1b[2J${text.replace(/\r?\n/g, '\r\n')}`);
    const say = (text) => { if (text !== status) { status = text; stdout.write(`\r\n\x1b[7m ${text} \x1b[0m`); } };
    const stop = (why) => {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      stdin.off('data', onData);
      try { stdin.setRawMode?.(false); } catch {}
      stdin.pause?.();
      stdout.write('\r\n');
      resolveDone(why);
    };
    const tick = async () => {
      if (busy || stopped) return;
      busy = true;
      try {
        const s = await call('term.screen', { agent, since: hash });
        if (stopped) return;
        if (typeof s?.text === 'string') { hash = s.hash ?? null; status = ''; draw(s.text); }
        else if (status) { status = ''; hash = null; } // back online: force a redraw on the next poll
        if (s && s.alive === false) stop('session ended');
      } catch (e) {
        if (/is offline/.test(e.message)) say(`${host} is offline; waiting for it to reconnect (Ctrl-] detaches)`);
        else if (/No (live session|agent)/.test(e.message)) stop(e.message);
        else say(e.message);
      } finally { busy = false; }
    };
    const onData = (chunk) => {
      const { keys, detach } = keysFromBytes(chunk.toString('utf8'));
      if (keys.length) sending = sending.then(() => call('term.keys', { agent, keys })).catch(e => say(/is offline/.test(e.message) ? `${host} is offline; keys are not queued` : e.message));
      if (detach) stop('detached');
    };
    try { stdin.setRawMode?.(true); } catch {}
    stdin.on('data', onData);
    stdin.resume?.();
    const timer = setInterval(tick, everyMs);
    timer.unref?.();
    tick();
  });
}
