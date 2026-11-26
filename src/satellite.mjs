import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { kvDel, kvGet, kvSet } from './db.mjs';
import { home, now } from './util.mjs';

/*
 * Satellite side of the hub/satellite link (PRD "Several hosts"). `hauptling satellite join` trades a join
 * token for a key kept in ~/.hauptling/satellite.json (600); a broker that finds that file dials the hub:
 * one SSE link for commands, POSTs for state (every 30 s) and events. Events wait in the `outbox` table
 * while the hub is unreachable and are replayed in id order on reconnect; the hub skips ids it already has.
 */

export const satelliteFile = () => join(home(), 'satellite.json');
export const readSatellite = () => (existsSync(satelliteFile()) ? JSON.parse(readFileSync(satelliteFile(), 'utf8')) : null);

/** This host's default satellite name: its host name, lowercased to [a-z0-9.-]. */
export const defaultName = () => hostname().toLowerCase().replace(/[^a-z0-9.-]+/g, '-').replace(/^[^a-z0-9]+/, '').slice(0, 63) || 'satellite';

/** Plain http only to loopback or a tailnet address (Tailscale encrypts those), so the key never travels in clear. */
export function checkHubUrl(u) {
  let url;
  try { url = new URL(u); } catch { throw new Error(`Hub URL must look like https://hub.your-tailnet.ts.net, got "${u}"`); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error(`Hub URL must be http(s), got "${u}"`);
  const h = url.hostname.replace(/^\[|\]$/g, '');
  const tailnetIp = /^100\.(\d+)\.\d+\.\d+$/.exec(h);
  const trusted = h === 'localhost' || h === '::1' || /^127\./.test(h) || h.endsWith('.ts.net') || (tailnetIp && +tailnetIp[1] >= 64 && +tailnetIp[1] <= 127);
  if (url.protocol === 'http:' && !trusted) throw new Error(`Plain http is only allowed to loopback or a tailnet address (100.64.0.0/10, *.ts.net); use https for ${h}`);
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

/** `hauptling satellite join`: exchanges the one-time token for this host's key and saves it. */
export async function joinHub(hubUrl, joinToken, { name = defaultName(), fetchImpl = fetch } = {}) {
  const hub = checkHubUrl(hubUrl);
  if (!joinToken) throw new Error('satellite join <hub-url> <token>: the token comes from `hauptling hub token` on the hub');
  let res;
  try {
    res = await fetchImpl(`${hub}/hub/join`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ host: name, token: joinToken }), signal: AbortSignal.timeout(15e3) });
  } catch (e) { throw new Error(`Hub unreachable at ${hub} (${e.cause?.code || e.message})`); }
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.key) throw new Error(body.error || `HTTP ${res.status}`);
  mkdirSync(home(), { recursive: true, mode: 0o700 });
  writeFileSync(satelliteFile(), JSON.stringify({ hub, host: body.host, key: body.key, joinedAt: now() }, null, 2), { mode: 0o600 });
  chmodSync(satelliteFile(), 0o600);
  return { hub, host: body.host };
}

/** Event kinds that carry JSON for the hub's mirror (PRD "Part 2"); they may be longer than an event's 600 characters. */
export const MIRROR_KINDS = new Set(['state', 'test', 'ask', 'mail', 'notify', 'cmd']);
const MIRROR_MAX = 64 * 1024;
const BATCH_BYTES = 512 * 1024;

/** Parses a text/event-stream body into {event, data} messages; `:` comments (pings) are skipped. */
async function* sseMessages(body) {
  const decoder = new TextDecoder();
  let buf = '';
  for await (const chunk of body) {
    buf += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, '\n');
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      let event = 'message';
      const data = [];
      for (const line of block.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
      }
      if (data.length) yield { event, data: data.join('\n') };
    }
  }
}

/**
 * The satellite's link. `capabilities()` → {vendors: {vendor: [signed-in slots]}, free: {vendor: n}, gpu, maxWorkers}.
 * `onCommand(cmd)` receives hub commands (part 2). Timers and randomness are injectable for tests.
 */
export function createSatellite({ db, config, capabilities = async () => ({}), onCommand = () => {}, log = () => {}, fetchImpl = fetch, heartbeatMs = 30e3, minDelayMs = 1e3, maxDelayMs = 60e3, random = Math.random }) {
  const { hub, host, key } = config;
  const headers = { authorization: `Bearer ${key}`, 'x-hauptling-host': host };
  let stopped = false, connected = false, revoked = false;
  let ctl = null, loop = null, flushing = Promise.resolve(), delay = minDelayMs, wake = null;

  // A new join restarts the hub's event ids for this host; whatever an old membership left queued is dropped.
  if (kvGet(db, 'satellite_joined') !== String(config.joinedAt)) {
    db.exec('DELETE FROM outbox');
    kvDel(db, 'satellite_cmd_last');
    kvSet(db, 'satellite_joined', String(config.joinedAt));
  }
  const chains = new Map(); // agent (or '') → promise: one agent's commands run in order

  const queued = () => db.prepare('SELECT COUNT(*) n FROM outbox').get().n;
  const markRevoked = () => { if (!revoked) log(`satellite: the hub refused this host's key; run \`hauptling satellite join\` again with a new token`); revoked = true; ctl?.abort(); };

  async function post(path, body) {
    const res = await fetchImpl(`${hub}${path}`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(20e3) });
    const b = await res.json().catch(() => ({}));
    if (res.status === 401) markRevoked();
    if (!res.ok) throw new Error(b.error || `HTTP ${res.status}`);
    return b;
  }

  const prune = (acked) => { if (Number.isSafeInteger(acked)) db.prepare('DELETE FROM outbox WHERE seq <= ?').run(acked); };

  /** Sends the outbox in id order, 100 at a time; one flush at a time. */
  function flush() {
    const run = async () => {
      for (;;) {
        let size = 0;
        const batch = db.prepare('SELECT * FROM outbox ORDER BY seq LIMIT 100').all().filter((r, i) => (size += r.text.length + 200) <= BATCH_BYTES || i === 0);
        if (!batch.length) return;
        const { acked } = await post('/hub/events', { events: batch.map(r => ({ id: r.seq, agent: r.agent, kind: r.kind, text: r.text, at: r.at })) });
        prune(acked);
        if (!(acked >= batch.at(-1).seq)) return;
      }
    };
    flushing = flushing.catch(() => {}).then(run);
    return flushing;
  }

  /** Queues an event for the hub; sent at once when linked, else on reconnect. */
  function queue(agent, kind, text, at = now()) {
    const { lastInsertRowid } = db.prepare('INSERT INTO outbox (agent, kind, text, at) VALUES (?, ?, ?, ?)').run(agent ?? null, kind, String(text).slice(0, MIRROR_KINDS.has(kind) ? MIRROR_MAX : 600), at);
    if (connected) flush().catch(e => log(`satellite: sending events failed: ${e.message}`));
    return Number(lastInsertRowid);
  }

  /**
   * A hub command, exactly once: ids at or below the last one started are resends and skipped. The id is
   * recorded before it runs; its result goes back as a `cmd` event through the outbox. One agent's commands
   * run in order, without holding up the link (a restart can take a while).
   */
  function command(cmd) {
    const id = Number(cmd?.id);
    if (!Number.isSafeInteger(id) || id <= Number(kvGet(db, 'satellite_cmd_last') || 0)) return null;
    kvSet(db, 'satellite_cmd_last', id);
    const key = typeof cmd.agent === 'string' ? cmd.agent : cmd.agent?.id || '';
    const run = (chains.get(key) || Promise.resolve()).then(async () => {
      let r;
      try { r = { id, ok: true, result: (await onCommand(cmd)) ?? null }; }
      catch (e) { r = { id, ok: false, error: e.message }; log(`satellite: command ${id} ${cmd.type} failed: ${e.message}`); }
      queue(key || null, 'cmd', JSON.stringify(r));
    });
    chains.set(key, run);
    run.then(() => { if (chains.get(key) === run) chains.delete(key); });
    return run;
  }

  async function beat() {
    await post('/hub/state', { capabilities: await capabilities() });
    await flush();
  }

  async function connectOnce() {
    ctl = new AbortController();
    const res = await fetchImpl(`${hub}/hub/link`, { headers: { ...headers, accept: 'text/event-stream' }, signal: ctl.signal });
    if (res.status === 401) return markRevoked();
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    connected = true;
    delay = minDelayMs;
    log(`satellite: linked to ${hub} as ${host}`);
    const timer = setInterval(() => beat().catch(e => { log(`satellite: heartbeat failed: ${e.message}`); ctl.abort(); }), heartbeatMs);
    try {
      const first = beat();
      first.catch(() => {});
      for await (const m of sseMessages(res.body)) {
        if (m.event === 'hello') prune(JSON.parse(m.data).acked);
        else if (m.event === 'command') { try { command(JSON.parse(m.data)); } catch (e) { log(`satellite: bad command: ${e.message}`); } }
        else if (m.event === 'revoked') { const why = JSON.parse(m.data).why; if (why === 'revoked') markRevoked(); else log(`satellite: hub closed the link (${why})`); break; }
      }
      await first;
    } finally {
      clearInterval(timer);
      connected = false;
      ctl.abort();
    }
  }

  async function run() {
    while (!stopped && !revoked) {
      try { await connectOnce(); } catch (e) { if (!stopped && !revoked) log(`satellite: link to ${hub} lost: ${e.message}`); }
      if (stopped || revoked) break;
      const wait = delay * (0.8 + 0.4 * random());
      delay = Math.min(delay * 2, maxDelayMs);
      await new Promise(r => { wake = r; setTimeout(r, wait).unref?.(); });
      wake = null;
    }
  }

  return {
    queue, flush, command,
    start() { if (!loop) { stopped = false; revoked = false; delay = minDelayMs; loop = run(); } return this; },
    async stop() { stopped = true; ctl?.abort(); wake?.(); await loop; loop = null; },
    status: () => ({ hub, host, connected, revoked, queued: queued() }),
  };
}
