import { createHash } from 'node:crypto';
import { tx } from './db.mjs';
import { token } from './util.mjs';

/*
 * Hub side of the hub/satellite link (PRD "Several hosts"). Satellites dial out to the hub's broker port:
 *   POST /hub/join    {host, token} → {host, key}       one-time join token, no auth header
 *   GET  /hub/link    text/event-stream: hello, command, revoked, `: ping`
 *   POST /hub/state   {capabilities} → {acked}         the 30 s heartbeat
 *   POST /hub/events  {events:[{id, agent, kind, text, at}]} → {acked}
 *   POST /hub/reply   {req, ok, result|error}           the answer to an `rpc` (part 3: terminal, diff, timeline)
 * Commands (part 2) are stored in `commands` and resent, in id order, every time the link opens, until the
 * satellite's `cmd` event acknowledges them (core's `receive` calls `ack`).
 * Auth: `Authorization: Bearer hls_…` and `X-Hauptling-Host: <name>`. Only SHA-256 hashes of keys and tokens are stored.
 */

export const JOIN_TTL_MS = 15 * 60e3;
export const OFFLINE_AFTER_MS = 90e3;
export const LOST_AFTER_MS = 24 * 3600e3;
export const RPC_WAIT_MS = 20e3;
export const REPLY_MAX = 4 << 20;
const HOST_NAME = /^[a-z0-9][a-z0-9.-]{0,62}$/;
const KIND = /^[a-z][a-z0-9-]{0,39}$/;
/** Kinds only the hub raises. */
const HUB_KINDS = new Set(['host-lost']);
/** Agent states that still hold (or wait for) a worker; ended and failed ones don't care where their host went. */
const LIVE = ['queued', 'waiting', 'spawning', 'restarting', 'paused', 'working', 'blocked', 'done', 'parked'];

const sha = (s) => createHash('sha256').update(String(s)).digest('hex');
const iso = (ms) => (ms == null ? null : new Date(ms).toISOString());

export class HubError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export function checkHostName(name) {
  const n = String(name || '').toLowerCase();
  if (!HOST_NAME.test(n)) throw new HubError(400, `Host name must be 1–63 of a-z, 0-9, '.', '-', got "${name}"`);
  if (n === 'hub') throw new HubError(400, '"hub" names the hub itself; pick another name (--name)');
  return n;
}

/**
 * `emit(delegator, agent, kind, text, at)` is core's event writer (it wakes `wait`).
 * `clock` is injectable so tests can move time (offline after 90 s, `[host-lost]` after 24 h).
 */
export function createHub({ db, emit, log = () => {}, clock = () => Date.now(), pingMs = 15e3 }) {
  const links = new Map(); // host → open SSE response
  const waiters = new Map(); // command id → resolve
  const rpcs = new Map(); // rpc req id → {host, resolve, reject, timer}
  let rpcSeq = 0;
  // Core binds these (it is created after the hub): `receive` takes each new satellite event inside the events
  // transaction (default: a plain delegator event); `onState` runs after a heartbeat (placement may now fit).
  let receive = (host, a, kind, text, at) => emit(a.delegator, a.id, kind, text, at);
  let onState = () => {};
  let onResult = () => {}; // (host, command, result) once a command is acknowledged
  const row = (name) => db.prepare('SELECT * FROM hosts WHERE name = ?').get(name);

  function issueToken() {
    const t = `hlj_${token()}`;
    const at = clock();
    db.prepare('DELETE FROM join_tokens WHERE expires_at < ?').run(at - LOST_AFTER_MS);
    db.prepare('INSERT INTO join_tokens (hash, expires_at) VALUES (?, ?)').run(sha(t), at + JOIN_TTL_MS);
    return { token: t, expiresAt: iso(at + JOIN_TTL_MS) };
  }

  /** Exchanges a join token for a satellite key. Re-joining a name replaces its key and restarts its event ids. */
  function join({ host, token: t } = {}) {
    const name = checkHostName(host);
    const at = clock();
    const key = `hls_${token()}`;
    tx(db, () => {
      const j = typeof t === 'string' && db.prepare('SELECT * FROM join_tokens WHERE hash = ?').get(sha(t));
      if (!j || j.used_at || j.expires_at <= at) throw new HubError(401, 'Join token unknown, used or expired; run `hauptling hub token` on the hub for a new one');
      db.prepare('UPDATE join_tokens SET used_at = ? WHERE hash = ?').run(at, j.hash);
      db.prepare(`INSERT INTO hosts (name, key_hash, created_at, online, last_seq) VALUES (?, ?, ?, 0, 0)
        ON CONFLICT (name) DO UPDATE SET key_hash = excluded.key_hash, last_seq = 0`).run(name, sha(key), iso(at));
    });
    closeLink(name, 'rejoined');
    log(`hub ${name} joined`);
    return { host: name, key };
  }

  /** Satellite key + X-Hauptling-Host → caller, or null. Revoked keys (key_hash NULL) never match. */
  function authenticate(key, hostHeader) {
    if (typeof key !== 'string' || !key.startsWith('hls_')) return null;
    const h = db.prepare('SELECT name FROM hosts WHERE key_hash = ?').get(sha(key));
    if (!h || String(hostHeader || '').toLowerCase() !== h.name) return null;
    return { role: 'satellite', host: h.name };
  }

  function seen(name) {
    const h = row(name);
    if (!h.online) log(`hub ${name} online`);
    db.prepare('UPDATE hosts SET last_seen = ?, online = 1, offline_since = NULL, lost_at = NULL WHERE name = ?').run(clock(), name);
  }

  function state(name, { capabilities } = {}) {
    if (capabilities == null || typeof capabilities !== 'object' || Array.isArray(capabilities)) throw new HubError(400, 'capabilities must be an object');
    const json = JSON.stringify(capabilities);
    if (json.length > 16384) throw new HubError(400, 'capabilities too large');
    db.prepare('UPDATE hosts SET capabilities = ? WHERE name = ?').run(json, name);
    try { onState(name); } catch (e) { log(`hub ${name} state: ${e.message}`); }
    return { acked: row(name).last_seq };
  }

  /** Takes events in id order, skipping ids already taken (replays); answers the highest id now held. */
  function events(name, { events: list } = {}) {
    if (!Array.isArray(list) || list.length > 500) throw new HubError(400, 'events must be an array of at most 500');
    const sorted = list.map(e => ({ ...e, id: Number(e?.id) })).filter(e => Number.isSafeInteger(e.id) && e.id > 0).sort((a, b) => a.id - b.id);
    return tx(db, () => {
      let last = row(name).last_seq;
      for (const e of sorted) {
        if (e.id <= last) continue;
        last = e.id;
        if (e.kind === 'cmd') { // a command's result; not tied to one agent (`delegator` commands)
          let r = null;
          try { r = JSON.parse(e.text); } catch {}
          if (!r || !ack(name, r.id, r)) log(`hub ${name} dropped event ${e.id} (cmd): no pending command ${r?.id ?? '?'} for ${name}`);
          continue;
        }
        const a = typeof e.agent === 'string' && db.prepare('SELECT id, delegator, host, state FROM agents WHERE id = ?').get(e.agent);
        const kind = String(e.kind || '');
        if (!a || a.host !== name || !KIND.test(kind) || HUB_KINDS.has(kind)) {
          log(`hub ${name} dropped event ${e.id} (${kind || '?'} for ${e.agent || 'no agent'}): not an agent on ${name}, or a bad kind`);
          continue;
        }
        const at = typeof e.at === 'string' && !Number.isNaN(Date.parse(e.at)) ? e.at : undefined;
        try { receive(name, a, kind, String(e.text ?? ''), at); }
        catch (err) { log(`hub ${name} event ${e.id} (${kind} for ${a.id}) not applied: ${err.message}`); }
      }
      db.prepare('UPDATE hosts SET last_seq = ? WHERE name = ?').run(last, name);
      return { acked: last };
    });
  }

  function sse(res, event, data) { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); }

  function openLink(name, req, res) {
    closeLink(name, 'replaced by a new link');
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'x-accel-buffering': 'no' });
    links.set(name, res);
    sse(res, 'hello', { host: name, acked: row(name).last_seq });
    for (const c of pending(name)) sse(res, 'command', c);
    const ping = setInterval(() => res.write(': ping\n\n'), pingMs);
    ping.unref?.();
    const done = () => { clearInterval(ping); if (links.get(name) === res) { links.delete(name); failRpcs(name); } };
    req.on('close', done);
    res.on('close', done);
  }

  function closeLink(name, why) {
    const res = links.get(name);
    if (!res) return;
    links.delete(name);
    failRpcs(name);
    try { sse(res, 'revoked', { why }); res.end(); } catch {}
  }

  /**
   * Part 3: a request the satellite answers now (terminal, diff, timeline). Sent on the link, never stored or
   * replayed: offline → fails at once; the link closing or `ms` passing → fails. The answer comes on /hub/reply.
   */
  function rpc(name, op, args = {}, ms = RPC_WAIT_MS) {
    const res = links.get(name);
    if (!res) return Promise.reject(new HubError(503, `${name} is offline`));
    const req = ++rpcSeq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { rpcs.delete(req); reject(new HubError(504, `${name} did not answer ${op} within ${Math.round(ms / 1000)} s`)); }, ms);
      timer.unref?.();
      rpcs.set(req, { host: name, resolve, reject, timer });
      sse(res, 'rpc', { ...args, req, op });
    });
  }
  function failRpcs(name) {
    for (const [req, r] of rpcs) if (r.host === name) { rpcs.delete(req); clearTimeout(r.timer); r.reject(new HubError(503, `${name} is offline`)); }
  }
  function reply(name, { req, ok, result, error } = {}) {
    const r = rpcs.get(Number(req));
    if (!r || r.host !== name) return { taken: false }; // late, or another host's request
    rpcs.delete(Number(req));
    clearTimeout(r.timer);
    if (ok) r.resolve(result ?? null); else r.reject(new HubError(502, `${name}: ${error || 'failed'}`));
    return { taken: true };
  }

  const pending = (name) => db.prepare('SELECT id, type, body FROM commands WHERE host = ? AND acked_at IS NULL ORDER BY id').all(name)
    .map(c => ({ ...JSON.parse(c.body), id: c.id, type: c.type }));

  /**
   * Stores a command for a satellite and sends it if the link is open (else when it next opens).
   * → {id, sent}. Callers inside a transaction get it stored with their own writes.
   */
  function command(name, type, body = {}) {
    const { lastInsertRowid } = db.prepare('INSERT INTO commands (host, type, body, created_at) VALUES (?, ?, ?, ?)').run(name, type, JSON.stringify(body), iso(clock()));
    const id = Number(lastInsertRowid);
    const res = links.get(name);
    if (res) sse(res, 'command', { ...body, id, type });
    log(`hub ${name} command ${id} ${type}${body.agent ? ` ${typeof body.agent === 'string' ? body.agent : body.agent.id}` : ''}${res ? '' : ' (queued: offline)'}`);
    return { id, sent: Boolean(res) };
  }

  /** The satellite's `cmd` event: the command ran (once); `result` is {ok, result|error}. */
  function ack(name, id, result) {
    const r = db.prepare('UPDATE commands SET acked_at = ?, result = ? WHERE id = ? AND host = ? AND acked_at IS NULL').run(iso(clock()), JSON.stringify(result ?? null), Number(id), name);
    if (!r.changes) return false;
    const c = db.prepare('SELECT type, body FROM commands WHERE id = ?').get(Number(id));
    try { onResult(name, { ...JSON.parse(c.body), id: Number(id), type: c.type }, result); } catch (e) { log(`hub ${name} command ${id} result: ${e.message}`); }
    waiters.get(Number(id))?.(result);
    return true;
  }

  /** Resolves with the command's result, or null after `ms`. */
  function result(id, ms = 30e3) {
    const done = db.prepare('SELECT result FROM commands WHERE id = ? AND acked_at IS NOT NULL').get(id);
    if (done) return Promise.resolve(JSON.parse(done.result));
    return new Promise(resolve => {
      const timer = setTimeout(() => { waiters.delete(id); resolve(null); }, ms);
      timer.unref?.();
      waiters.set(id, (r) => { clearTimeout(timer); waiters.delete(id); resolve(r); });
    });
  }

  const linked = (name) => links.has(name);
  /** Core's hooks; see `receive` and `onState` above. */
  function bind(hooks = {}) { ({ receive = receive, onState = onState, onResult = onResult } = hooks); }

  function revoke({ host } = {}) {
    const name = String(host || '').toLowerCase();
    const h = row(name);
    if (!h) throw new Error(`No satellite ${host}`);
    const at = clock();
    db.prepare('UPDATE hosts SET key_hash = NULL, online = 0, offline_since = COALESCE(offline_since, ?) WHERE name = ?').run(at, name);
    closeLink(name, 'revoked');
    log(`hub ${name} revoked`);
    return { host: name, revoked: true };
  }

  function list() {
    return db.prepare('SELECT * FROM hosts ORDER BY name').all().map(h => ({
      name: h.name, online: Boolean(h.online), revoked: !h.key_hash, linked: links.has(h.name),
      lastSeen: iso(h.last_seen), offlineSince: iso(h.offline_since), lost: Boolean(h.lost_at), joinedAt: h.created_at,
      capabilities: h.capabilities ? JSON.parse(h.capabilities) : null,
      agents: db.prepare(`SELECT COUNT(*) n FROM agents WHERE host = ? AND state IN (${LIVE.map(() => '?').join(',')})`).get(h.name, ...LIVE).n,
      pendingCommands: db.prepare('SELECT COUNT(*) n FROM commands WHERE host = ? AND acked_at IS NULL').get(h.name).n,
    }));
  }

  /** Every 30 s: silence → offline; 24 h offline → one `[host-lost]` per delegator with live agents there; acknowledged commands kept a week. */
  function tick(at = clock()) {
    db.prepare('DELETE FROM commands WHERE acked_at IS NOT NULL AND acked_at < ?').run(iso(at - 7 * 24 * 3600e3));
    for (const h of db.prepare('SELECT name, last_seen FROM hosts WHERE online = 1 AND (last_seen IS NULL OR last_seen < ?)').all(at - OFFLINE_AFTER_MS)) {
      db.prepare('UPDATE hosts SET online = 0, offline_since = ? WHERE name = ?').run(h.last_seen ?? at, h.name);
      log(`hub ${h.name} offline (silent since ${iso(h.last_seen)})`);
    }
    for (const h of db.prepare('SELECT name, offline_since FROM hosts WHERE online = 0 AND lost_at IS NULL AND offline_since IS NOT NULL AND offline_since <= ?').all(at - LOST_AFTER_MS)) {
      db.prepare('UPDATE hosts SET lost_at = ? WHERE name = ?').run(at, h.name);
      const rows = db.prepare(`SELECT delegator, GROUP_CONCAT(id, ', ') ids FROM agents WHERE host = ? AND state IN (${LIVE.map(() => '?').join(',')}) GROUP BY delegator`).all(h.name, ...LIVE);
      for (const r of rows) emit(r.delegator, null, 'host-lost', `${h.name} has been offline since ${iso(h.offline_since)} (over 24 h); its agents ${r.ids} are unreachable. Nothing was killed: they continue if it comes back, or \`hauptling kill\` them and spawn again.`);
      log(`hub ${h.name} lost (offline over 24 h)`);
    }
  }

  /** Serves /hub/*; returns false for other paths. */
  async function handle(req, res, url) {
    if (!url.pathname.startsWith('/hub/')) return false;
    const send = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    const body = async (max = 1 << 20) => {
      let raw = '';
      for await (const chunk of req) { raw += chunk; if (raw.length > max) throw new HubError(413, 'Body too large'); }
      try { return raw ? JSON.parse(raw) : {}; } catch { throw new HubError(400, 'Bad JSON'); }
    };
    const path = url.pathname;
    try {
      if (path === '/hub/join' && req.method === 'POST') return send(200, join(await body())), true;
      const hostHeader = req.headers['x-hauptling-host'];
      const who = authenticate((req.headers.authorization || '').replace(/^Bearer /, ''), hostHeader);
      if (!who) {
        log(`hub refused ${req.method} ${path} from ${hostHeader || '?'}: bad or revoked key`);
        return send(401, { error: 'Bad or revoked satellite key; join again with a new `hauptling hub token`' }), true;
      }
      if (path !== '/hub/reply') log(`hub ${who.host} ${req.method} ${path}`); // replies come several a second while a terminal is open
      seen(who.host);
      if (path === '/hub/link' && req.method === 'GET') return openLink(who.host, req, res), true;
      if (path === '/hub/state' && req.method === 'POST') return send(200, state(who.host, await body())), true;
      if (path === '/hub/events' && req.method === 'POST') return send(200, events(who.host, await body())), true;
      if (path === '/hub/reply' && req.method === 'POST') return send(200, reply(who.host, await body(REPLY_MAX))), true;
      return send(404, { error: 'Not found' }), true;
    } catch (e) {
      log(`hub error ${path}: ${e.message}`);
      if (!res.headersSent) send(e.status || 400, { error: e.message });
      return true;
    }
  }

  const close = () => { for (const name of [...links.keys()]) { const r = links.get(name); links.delete(name); r.end(); } };

  return { handle, authenticate, issueToken, join, revoke, list, tick, command, ack, result, linked, rpc, bind, close };
}
