import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db.mjs';
import { createCore } from '../src/core.mjs';
import { createHub, JOIN_TTL_MS, LOST_AFTER_MS, OFFLINE_AFTER_MS } from '../src/hub.mjs';
import { checkHubUrl, createSatellite, joinHub, readSatellite, satelliteFile } from '../src/satellite.mjs';
import { brokerHandler } from '../src/server.mjs';
import * as keyStore from '../src/keys.mjs';
import { loadModels } from '../src/models.mjs';

/** Hub and satellite tests (PRD "Several hosts"): two brokers in this process, each with its own home, store and port. */

const waitFor = async (cond, what, ms = 5000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await cond()) return; await new Promise(r => setTimeout(r, 10)); }
  throw new Error(`timed out waiting for ${what}`);
};

/**
 * A broker in this process. `opts`: a clock function, or {clock, host, github, notify, joinTo: hub broker}; with
 * `joinTo` it joins that hub first and runs as its satellite (`sat`: the link, not started yet).
 */
async function startBroker(t, name, opts = {}) {
  const { clock = () => Date.now(), host = {}, github = {}, notify = () => false, joinTo = null, capabilities = CAPS } = typeof opts === 'function' ? { clock: opts } : opts;
  const homeDir = mkdtempSync(join(tmpdir(), `hl-${name}-`));
  const db = openDb(join(homeDir, 'hauptling.db'));
  const logs = [];
  const log = (m) => logs.push(m);
  let core, sat = null, config = null;
  const hub = createHub({ db, log, clock, emit: (...a) => core.emit(...a), pingMs: 50 });
  if (joinTo) {
    ({ config } = await joinAs(joinTo, { homeDir }, name));
    sat = createSatellite({ db, config, log, heartbeatMs: 40, minDelayMs: 10, maxDelayMs: 40, capabilities: async () => capabilities, onCommand: (c) => core.command(c) });
    t.after(() => sat.stop());
  }
  core = createCore({ db, host, github, notify, hub, satellite: sat, remoteWaitMs: 3000, log, keys: { ...keyStore, getKey: () => null, getBudget: () => null }, models: () => loadModels(join(tmpdir(), 'none.json')), workerUrl: 'http://127.0.0.1:1', runnerToken: 'RUN' });
  const server = createServer(brokerHandler({ core, hub, dash: { handle: async () => false }, adminToken: `ADMIN-${name}`, log }));
  server.requestTimeout = 0;
  const listen = (port = 0) => new Promise(r => server.listen(port, '127.0.0.1', r));
  await listen();
  const port = server.address().port;
  const down = () => { hub.close(); server.closeAllConnections(); return new Promise(r => server.close(r)); };
  t.after(async () => { if (server.listening) await down(); });
  const url = `http://127.0.0.1:${port}`;
  const api = async (call, args = {}, tok = `ADMIN-${name}`, host) => {
    const res = await fetch(`${url}/api/${call}`, { method: 'POST', headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json', ...(host ? { 'x-hauptling-host': host } : {}) }, body: JSON.stringify(args) });
    return { status: res.status, ...(await res.json()) };
  };
  return { homeDir, db, hub, core, url, port, api, logs, down, up: () => listen(port), sat, config, host, github };
}

const CAPS = { vendors: { claude: ['hl-w1', 'hl-w2'] }, free: { claude: 2 }, gpu: false, maxWorkers: 6 };

/** Joins `sat` to `hub` as `name` (the satellite's home is HAUPTLING_HOME while joining) and returns its saved config. */
async function joinAs(hub, sat, name = 'sat1') {
  const { result } = await hub.api('hub.token');
  const prev = process.env.HAUPTLING_HOME;
  process.env.HAUPTLING_HOME = sat.homeDir;
  try {
    await joinHub(hub.url, result.token, { name });
    return { config: readSatellite(), file: satelliteFile(), token: result.token };
  } finally { if (prev === undefined) delete process.env.HAUPTLING_HOME; else process.env.HAUPTLING_HOME = prev; }
}

function link(t, sat, config, opts = {}) {
  const s = createSatellite({ db: sat.db, config, log: sat.log ?? (() => {}), heartbeatMs: 40, minDelayMs: 10, maxDelayMs: 40,
    capabilities: async () => CAPS, ...opts });
  t.after(() => s.stop());
  return s;
}

/** A hub agent row that lives on `host`. */
async function agentOn(hub, host, id = `claude_opus-5-5_${host === 'hub' ? 'aaaaa' : 'bbbbb'}`) {
  const d = (await hub.api('delegator.start', { repo: 'gitgiant/demo' })).result.id;
  const at = new Date().toISOString();
  hub.db.prepare(`INSERT INTO agents (id, delegator, vendor, model, repo, base, branch, brief, title, state, token, created_at, updated_at, host)
    VALUES (?, ?, 'claude', 'opus-5-5', 'gitgiant/demo', 'main', ?, 'b', 't', 'working', ?, ?, ?, ?)`).run(id, d, `hl/${id}`, `tok-${id}`, at, at, host);
  return { id, delegator: d };
}

const hubEvents = (hub, kind) => hub.db.prepare(`SELECT * FROM events WHERE kind ${kind ? '= ?' : 'IS NOT ?'} ORDER BY id`).all(kind ?? null);

test('a join token is exchanged once for a key saved 600; reused, expired and unknown tokens are refused', async (t) => {
  let now = Date.now();
  const hub = await startBroker(t, 'hub', () => now);
  const sat = await startBroker(t, 'sat');
  const { config, file, token } = await joinAs(hub, sat);
  assert.equal(config.host, 'sat1');
  assert.equal(config.hub, hub.url);
  assert.match(config.key, /^hls_/);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  const row = hub.db.prepare('SELECT * FROM hosts').get();
  assert.equal(row.name, 'sat1');
  assert.notEqual(row.key_hash, config.key, 'only the hash is stored');
  assert.equal(hub.db.prepare('SELECT COUNT(*) n FROM join_tokens WHERE hash = ?').get(token).n, 0, 'only the token hash is stored');

  await assert.rejects(joinHub(hub.url, token, { name: 'sat2' }), /used or expired/);
  const { result: late } = await hub.api('hub.token');
  now += JOIN_TTL_MS + 1;
  await assert.rejects(joinHub(hub.url, late.token, { name: 'sat2' }), /used or expired/);
  await assert.rejects(joinHub(hub.url, 'hlj_made-up', { name: 'sat2' }), /used or expired/);
  const { result: fresh } = await hub.api('hub.token');
  await assert.rejects(joinHub(hub.url, fresh.token, { name: 'hub' }), /names the hub itself/);
  assert.equal(hub.db.prepare('SELECT COUNT(*) n FROM hosts').get().n, 1);
});

test('the hub URL must be https unless loopback or tailnet', () => {
  assert.equal(checkHubUrl('https://old.tailff0f31.ts.net/'), 'https://old.tailff0f31.ts.net');
  assert.equal(checkHubUrl('http://100.101.2.3:47800'), 'http://100.101.2.3:47800');
  assert.equal(checkHubUrl('http://127.0.0.1:47800'), 'http://127.0.0.1:47800');
  assert.throws(() => checkHubUrl('http://example.com'), /Plain http/);
  assert.throws(() => checkHubUrl('http://100.200.0.1'), /Plain http/);
  assert.throws(() => checkHubUrl('ftp://x'), /http\(s\)/);
});

test('a satellite key is refused on admin, delegator and hub calls, and only works with its own host name', async (t) => {
  const hub = await startBroker(t, 'hub');
  const sat = await startBroker(t, 'sat');
  const { config } = await joinAs(hub, sat);
  for (const call of ['delegator.start', 'delegator.list', 'agents', 'spawn', 'hub.token', 'satellite.list', 'satellite.revoke', 'slots.set', 'shutdown', 'test.request']) {
    const r = await hub.api(call, {}, config.key, 'sat1');
    assert.match(r.error, /not allowed for satellite sat1/, call);
  }
  assert.equal((await hub.api('agents', {}, config.key)).status, 401, 'no host header');
  assert.equal((await hub.api('agents', {}, config.key, 'other')).status, 401, 'another host name');
  const other = await fetch(`${hub.url}/hub/state`, { method: 'POST', headers: { authorization: `Bearer ${config.key}`, 'x-hauptling-host': 'sat2' }, body: '{"capabilities":{}}' });
  assert.equal(other.status, 401);
  // Admin and worker tokens are no satellite keys either.
  assert.equal((await fetch(`${hub.url}/hub/state`, { method: 'POST', headers: { authorization: 'Bearer ADMIN-hub', 'x-hauptling-host': 'sat1' }, body: '{}' })).status, 401);
  assert.ok(hub.logs.some(l => l.includes('hub sat1 POST /api/delegator.start')), 'calls are logged with the host');
  assert.ok(hub.logs.some(l => /hub refused POST \/hub\/state from sat2/.test(l)));
  assert.equal(hub.db.prepare('SELECT COUNT(*) n FROM delegators').get().n, 0);
});

test('heartbeats mark a satellite online with its capabilities; silence marks it offline', async (t) => {
  let now = Date.now();
  const hub = await startBroker(t, 'hub', () => now);
  const sat = await startBroker(t, 'sat');
  const { config } = await joinAs(hub, sat);
  assert.equal(hub.hub.list()[0].online, false, 'joined but not yet linked');
  const s = link(t, sat, config).start();
  await waitFor(() => hub.hub.list()[0]?.capabilities, 'state');
  const [h] = (await hub.api('satellite.list')).result;
  assert.equal(h.online, true);
  assert.equal(h.linked, true);
  assert.deepEqual(h.capabilities.vendors, { claude: ['hl-w1', 'hl-w2'] });
  assert.equal(s.status().connected, true);
  const beats = () => hub.logs.filter(l => l === 'hub sat1 POST /hub/state').length;
  const n = beats();
  await waitFor(() => beats() >= n + 2, 'repeated heartbeats');

  hub.hub.tick(now + OFFLINE_AFTER_MS - 1000);
  assert.equal(hub.hub.list()[0].online, true, 'a recent heartbeat keeps it online');
  await s.stop();
  now += OFFLINE_AFTER_MS + 1;
  hub.hub.tick();
  const off = hub.hub.list()[0];
  assert.equal(off.online, false);
  assert.ok(off.offlineSince);
  assert.ok(hub.logs.some(l => l.startsWith('hub sat1 offline')));
});

test('events queued while the hub is down are replayed in order, exactly once', async (t) => {
  const hub = await startBroker(t, 'hub');
  const sat = await startBroker(t, 'sat');
  const { config } = await joinAs(hub, sat);
  const remote = await agentOn(hub, 'sat1');
  const local = await agentOn(hub, 'hub');
  const s = link(t, sat, config);
  s.queue(remote.id, 'report', 'one');            // queued before the first connect
  s.start();
  await waitFor(() => hubEvents(hub, 'report').length === 1, 'first event');

  await hub.down();
  await waitFor(() => !s.status().connected, 'link drop');
  s.queue(remote.id, 'report', 'two');
  s.queue(local.id, 'report', 'not yours');         // an agent on another host: dropped by the hub
  s.queue(remote.id, 'gate-failed', 'three');
  s.queue(remote.id, 'host-lost', 'forged');         // a hub-only kind: dropped
  assert.equal(s.status().queued, 4);
  await hub.up();
  await waitFor(() => s.status().queued === 0, 'replay');

  const got = hub.db.prepare('SELECT agent, kind, text, delegator FROM events WHERE agent IS NOT NULL ORDER BY id').all().map(e => ({ ...e }));
  assert.deepEqual(got, [
    { agent: remote.id, kind: 'report', text: 'one', delegator: remote.delegator },
    { agent: remote.id, kind: 'report', text: 'two', delegator: remote.delegator },
    { agent: remote.id, kind: 'gate-failed', text: 'three', delegator: remote.delegator },
  ]);
  assert.ok(hub.logs.some(l => l.includes(`dropped event 3 (report for ${local.id})`)));

  // A lost answer means the satellite sends the same ids again: the hub skips them.
  const again = await fetch(`${hub.url}/hub/events`, { method: 'POST', headers: { authorization: `Bearer ${config.key}`, 'x-hauptling-host': 'sat1' },
    body: JSON.stringify({ events: [{ id: 2, agent: remote.id, kind: 'report', text: 'two' }, { id: 1, agent: remote.id, kind: 'report', text: 'one' }] }) });
  assert.deepEqual(await again.json(), { acked: 5 });
  assert.equal(hubEvents(hub, 'report').length, 2);
  s.queue(remote.id, 'report', 'six');
  await waitFor(() => hubEvents(hub, 'report').length === 3, 'next event');
  assert.equal(hub.db.prepare('SELECT last_seq FROM hosts').get().last_seq, 6);
});

test('a revoked key is cut off: the link closes, the satellite stops dialling and every call is refused', async (t) => {
  const hub = await startBroker(t, 'hub');
  const sat = await startBroker(t, 'sat');
  const { config } = await joinAs(hub, sat);
  const logs = [];
  const s = link(t, { ...sat, log: (m) => logs.push(m) }, config).start();
  await waitFor(() => hub.hub.list()[0]?.linked, 'link');
  assert.deepEqual((await hub.api('satellite.revoke', { host: 'sat1' })).result, { host: 'sat1', revoked: true });
  await waitFor(() => s.status().revoked, 'satellite sees the revocation');
  assert.equal(s.status().connected, false);
  assert.ok(logs.some(l => /refused this host's key/.test(l)));
  const [h] = hub.hub.list();
  assert.equal(h.revoked, true);
  assert.equal(h.online, false);
  assert.equal(h.linked, false);
  const state = await fetch(`${hub.url}/hub/state`, { method: 'POST', headers: { authorization: `Bearer ${config.key}`, 'x-hauptling-host': 'sat1' }, body: '{"capabilities":{}}' });
  assert.equal(state.status, 401);
  assert.equal((await fetch(`${hub.url}/hub/link`, { headers: { authorization: `Bearer ${config.key}`, 'x-hauptling-host': 'sat1' } })).status, 401);
  assert.equal((await hub.api('agents', {}, config.key, 'sat1')).status, 401);
  // Joining again with a new token gives a new key; the old one stays dead.
  const again = await joinAs(hub, sat);
  assert.notEqual(again.config.key, config.key);
  assert.equal((await hub.api('agents', {}, config.key, 'sat1')).status, 401);
  assert.match((await hub.api('agents', {}, again.config.key, 'sat1')).error, /not allowed for satellite/);
});

test('[host-lost] reaches each delegator with live agents once the satellite is offline 24 h', async (t) => {
  let now = Date.now();
  const hub = await startBroker(t, 'hub', () => now);
  const sat = await startBroker(t, 'sat');
  const { config } = await joinAs(hub, sat);
  const a = await agentOn(hub, 'sat1', 'claude_opus-5-5_ccccc');
  const b = await agentOn(hub, 'sat1', 'codex_gpt-6_ddddd');
  const ended = await agentOn(hub, 'sat1', 'claude_opus-5-5_eeeee');
  hub.db.prepare("UPDATE agents SET state = 'merged' WHERE id = ?").run(ended.id);
  const s = link(t, sat, config).start();
  await waitFor(() => hub.hub.list()[0]?.online, 'online');
  await s.stop();
  const t0 = now;
  now = t0 + OFFLINE_AFTER_MS + 1;
  hub.hub.tick();
  now = t0 + LOST_AFTER_MS - 1000;
  hub.hub.tick();
  assert.equal(hubEvents(hub, 'host-lost').length, 0, 'not before 24 h');
  now = t0 + LOST_AFTER_MS + 60e3;
  hub.hub.tick();
  hub.hub.tick();
  const lost = hubEvents(hub, 'host-lost');
  assert.deepEqual(lost.map(e => e.delegator).sort(), [a.delegator, b.delegator].sort(), 'once per delegator with live agents');
  assert.match(lost[0].text, /sat1 has been offline since .*Nothing was killed/);
  assert.equal(hub.db.prepare("SELECT COUNT(*) n FROM agents WHERE state = 'working'").get().n, 2, 'nothing is killed');
  // Back online, then gone another 24 h: a new [host-lost].
  const s2 = link(t, sat, config).start();
  await waitFor(() => hub.hub.list()[0]?.online, 'back online');
  await s2.stop();
  const t1 = now;
  now = t1 + OFFLINE_AFTER_MS + 1;
  hub.hub.tick();
  now = t1 + LOST_AFTER_MS + 60e3;
  hub.hub.tick();
  assert.equal(hubEvents(hub, 'host-lost').length, 4);
});

test('without satellites the hub answers as before and has none to list', async (t) => {
  const hub = await startBroker(t, 'hub');
  assert.deepEqual((await hub.api('satellite.list')).result, []);
  assert.equal((await hub.api('delegator.start', { repo: 'gitgiant/demo' })).ok, true);
  assert.equal((await hub.api('agents', {}, 'nope')).status, 401);
  hub.hub.tick();
  assert.equal(hubEvents(hub).length, 0);
});

// ---------- part 2: placement, commands, mirror ----------

/** A worker host that records what it is asked to do; git answers from a tiny model, test jobs pass. */
function fakeHost({ gpu = false, maxWorkers = 6 } = {}) {
  const calls = [];
  const typed = [];
  return {
    calls, typed, workRoot: '/hl/work',
    async run(slot, argv) {
      calls.push([slot, ...argv]);
      const g = argv[0] === 'git' ? argv.slice(3) : null;
      if (g?.[0] === 'rev-parse' && g[1] === '--abbrev-ref') return { stdout: 'main\n' };
      if (g?.[0] === 'rev-parse') return { stdout: 'abc1234def\n' };
      if (g?.[0] === 'rev-list') return { stdout: '1\n' };
      if (argv[0] === 'cat') throw new Error('no file');
      return { stdout: '' };
    },
    async startWorker({ slot, id }) { calls.push(['start', slot, id]); },
    async stopWorker(slot, id) { calls.push(['stop', id]); },
    async pauseWorker(slot, id) { calls.push(['pause', id]); },
    async unpauseWorker(slot, id) { calls.push(['unpause', id]); },
    async tmuxType(slot, id, text) { typed.push([id, text]); },
    async tmuxAlive() { return true; },
    async runTestJob(job) { calls.push(['test', job.id]); return { id: job.id, sha: job.sha, status: 'pass', passed: 3, failed: 0, skipped: 0, failures: [], duration_s: 1 }; },
    gpuAvailable: async () => gpu,
    maxWorkers: () => maxWorkers,
    attachArgv: () => ['tmux'],
  };
}

function fakeGithub() {
  const log = [];
  return {
    log,
    gitAuthEnv: async () => ({}),
    prFind: async () => null,
    prCreate: async (slug, head) => { log.push(['create', head]); return { url: `https://github.com/${slug}/pull/7`, number: 7 }; },
    requiredChecks: async () => [],
    prAutoMerge: async (s, n) => log.push(['auto', n]),
    prMerge: async (s, n) => log.push(['merge', n]),
    prView: async () => ({ state: log.some(l => l[0] === 'merge') ? 'MERGED' : 'OPEN', headRefOid: 'abc1234def', statusCheckRollup: [] }),
  };
}

/** A hub core with satellites as plain rows (no link): enough for placement. */
function placementHub({ hubHost = fakeHost(), satellites = {} } = {}) {
  const db = openDb(':memory:');
  let core;
  const hub = createHub({ db, emit: (...a) => core.emit(...a) });
  core = createCore({ db, host: hubHost, github: fakeGithub(), hub, keys: { ...keyStore, getKey: () => null, getBudget: () => null }, models: () => loadModels(join(tmpdir(), 'none.json')), workerUrl: 'http://127.0.0.1:1', runnerToken: 'RUN' });
  const at = new Date().toISOString();
  for (const [name, { online = true, ...caps }] of Object.entries(satellites)) {
    db.prepare('INSERT INTO hosts (name, key_hash, created_at, online, capabilities) VALUES (?, ?, ?, ?, ?)').run(name, `hash-${name}`, at, online ? 1 : 0, JSON.stringify({ ...CAPS, ...caps }));
  }
  const spawn = async (args = {}) => core.call('spawn', { brief: '# Task\nDo it.', vendor: 'claude', mode: 'cheapest', ...args });
  const row = (id) => db.prepare('SELECT * FROM agents WHERE id = ?').get(id);
  const commands = (host) => db.prepare('SELECT * FROM commands WHERE host = ? ORDER BY id').all(host).map(c => ({ ...c, body: JSON.parse(c.body) }));
  return { db, core, hub, spawn, row, commands, hubHost };
}

test('placement: a bound delegator, a spawn --host override, and auto-placement least busy first (hub on a tie)', async () => {
  const p = placementHub({ satellites: { sat1: {}, sat2: {} } });
  const bound = await p.core.call('delegator.start', { repo: 'gitgiant/demo', max: 10, host: 'sat2' });
  assert.equal(bound.host, 'sat2');
  const a = await p.spawn({ delegator: bound.id });
  assert.equal(a.host, 'sat2');
  assert.equal(a.state, 'spawning');
  const [cmd] = p.commands('sat2');
  assert.equal(cmd.type, 'spawn');
  assert.equal(cmd.body.agent.id, a.id);
  assert.equal(cmd.body.agent.repo, 'gitgiant/demo');
  assert.deepEqual(cmd.body.delegator, { id: bound.id, gate: true, automerge: true });
  assert.equal(p.row(a.id).slot, null, 'no hub slot for a remote agent');

  const here = await p.spawn({ delegator: bound.id, host: 'hub' });
  assert.equal(here.host, 'hub', 'spawn --host overrides the delegator');
  assert.equal(p.row(here.id).slot, 'hl-w1');

  // Auto: the hub runs one worker now, sat1 none, sat2 one → sat1; then hub, sat1 and sat2 all have one → hub first.
  const d = (await p.core.call('delegator.start', { repo: 'gitgiant/demo', max: 10 })).id;
  assert.equal((await p.spawn({ delegator: d })).host, 'sat1');
  assert.equal((await p.spawn({ delegator: d })).host, 'hub');
  // hub 2, sat1 1, sat2 1 → sat1 (by name on a tie between satellites)
  assert.equal((await p.spawn({ delegator: d })).host, 'sat1');
  // sat1 is full for claude (2 signed-in slots) → sat2
  assert.equal((await p.spawn({ delegator: d })).host, 'sat2');

  await assert.rejects(p.core.call('delegator.start', { repo: 'gitgiant/demo', host: 'nope' }), /No host nope: use hub, sat1, sat2 or auto/);
  const set = await p.core.call('delegator.set', { delegator: bound.id, host: 'auto' });
  assert.equal(set.host, undefined, 'auto unbinds');
});

test('placement: GPU tasks only on GPU hosts, offline hosts never, local repos only on the hub; nothing fits → queued', async () => {
  const p = placementHub({ satellites: { sat1: { gpu: false }, gpu1: { gpu: true }, down: { gpu: true, online: false } } });
  const d = (await p.core.call('delegator.start', { repo: 'gitgiant/demo', max: 10 })).id;
  assert.equal((await p.spawn({ delegator: d, gpu: true })).host, 'gpu1');
  assert.equal((await p.spawn({ delegator: d, gpu: true })).host, 'gpu1');
  const waiting = await p.spawn({ delegator: d, gpu: true });
  assert.equal(waiting.state, 'queued', 'gpu1 is full, the hub and sat1 have no GPU, down is offline');
  assert.equal(p.row(waiting.id).host, 'hub', 'not placed yet');
  assert.equal(p.commands('down').length, 0);

  // Pinned to an offline host: waits too, then goes there once it is back.
  const pinned = await p.spawn({ delegator: d, host: 'down' });
  assert.equal(pinned.state, 'queued');
  p.db.prepare("UPDATE hosts SET online = 1 WHERE name = 'down'").run();
  await p.core.startAll();
  assert.equal(p.row(pinned.id).host, 'down');
  assert.equal(p.row(waiting.id).host, 'down', 'the GPU task fits there too');

  // Local path repos: refused on a satellite, auto-placed only on the hub.
  await assert.rejects(p.spawn({ delegator: d, repo: '/home/me/proj', host: 'sat1' }), /local path: local repos run on the hub only/);
  await assert.rejects(p.core.call('delegator.start', { repo: '/home/me/proj', host: 'sat1' }), /local repos run on the hub only/);
  const local = (await p.core.call('delegator.start', { repo: '/home/me/proj', max: 10 })).id;
  for (let i = 0; i < 3; i++) assert.equal((await p.spawn({ delegator: local })).host, 'hub');
  const full = await p.spawn({ delegator: local });
  assert.equal(full.state, 'queued', 'the hub is out of claude slots; satellites would fit but a local repo stays here');
  assert.equal(p.row(full.id).host, 'hub');
});

test('placement: maxWorkers per host, and the delegator limit counts agents on every host', async () => {
  const p = placementHub({ hubHost: fakeHost({ maxWorkers: 1 }), satellites: { sat1: { maxWorkers: 1 } } });
  const d = (await p.core.call('delegator.start', { repo: 'gitgiant/demo', max: 3 })).id;
  assert.equal((await p.spawn({ delegator: d })).host, 'hub');
  assert.equal((await p.spawn({ delegator: d })).host, 'sat1');
  assert.equal((await p.spawn({ delegator: d })).state, 'queued', 'both hosts at maxWorkers');
  // A satellite agent still queued there counts toward the delegator's max.
  const other = (await p.core.call('delegator.start', { repo: 'gitgiant/demo', max: 1 })).id;
  const at = new Date().toISOString();
  p.db.prepare(`INSERT INTO agents (id, delegator, vendor, model, repo, base, branch, brief, title, state, token, created_at, updated_at, host)
    VALUES ('claude_x_fffff', ?, 'claude', 'x', 'gitgiant/demo', 'main', 'b', 'b', 't', 'queued', 'tok-f', ?, ?, 'sat1')`).run(other, at, at);
  p.db.prepare("UPDATE hosts SET capabilities = ? WHERE name = 'sat1'").run(JSON.stringify({ ...CAPS, maxWorkers: 5 }));
  assert.equal((await p.spawn({ delegator: other })).state, 'queued');
});

/** Hub + satellite brokers with a delegator on the hub; `spawn` places an agent on sat1 and waits until it works there. */
async function twoHosts(t) {
  const toasts = [];
  const satToasts = [];
  const hub = await startBroker(t, 'hub', { host: fakeHost({ maxWorkers: 1 }), github: fakeGithub(), notify: (n) => toasts.push(n) });
  const sat = await startBroker(t, 'sat1', { joinTo: hub, host: fakeHost(), github: fakeGithub(), notify: (n) => satToasts.push(n) });
  sat.sat.start();
  await waitFor(() => hub.hub.list()[0]?.capabilities, 'satellite state');
  const d = (await hub.api('delegator.start', { repo: 'gitgiant/demo', max: 5, host: 'sat1' })).result.id;
  const spawn = async () => {
    const r = (await hub.api('spawn', { delegator: d, brief: '# Remote task\nDo it.', vendor: 'claude', mode: 'cheapest' })).result;
    await waitFor(() => hub.db.prepare('SELECT state FROM agents WHERE id = ?').get(r.id).state === 'working', 'agent working on sat1');
    return r;
  };
  const hubRow = (id) => hub.db.prepare('SELECT * FROM agents WHERE id = ?').get(id);
  const satRow = (id) => sat.db.prepare('SELECT * FROM agents WHERE id = ?').get(id);
  const events = async () => (await hub.api('wait', { delegator: d, timeout: 0 })).result.events;
  return { hub, sat, d, spawn, hubRow, satRow, events, toasts, satToasts };
}

test('a spawn on a satellite runs there; report, gate-passed and merged reach the hub\'s wait', async (t) => {
  const { hub, sat, d, spawn, hubRow, satRow, events } = await twoHosts(t);
  const { id, host } = await spawn();
  assert.equal(host, 'sat1');
  assert.ok(sat.host.calls.some(c => c[0] === 'start' && c[2] === id), 'the satellite started the worker');
  assert.equal(hub.host.calls.length, 0, 'the hub ran nothing');
  assert.equal(satRow(id).delegator, d);
  assert.notEqual(satRow(id).token, hubRow(id).token, 'the worker has the satellite\'s own token');
  assert.equal(hubRow(id).slot, 'hl-w1', 'the hub mirrors the satellite\'s slot');
  assert.equal((await hub.api('agents', { delegator: d })).result[0].status, 'working: Remote task');

  // The worker reports to its own broker (the satellite): PR, gate test on the satellite's queue, merge, poll.
  const who = sat.core.authenticate(satRow(id).token, 'x');
  await sat.core.call('report', { text: 'did it' }, who);
  await waitFor(() => hubRow(id).state === 'merged', 'merged on the hub');
  const kinds = (await events()).map(e => e.kind);
  assert.deepEqual(kinds.filter(k => ['report', 'gate-passed', 'merged'].includes(k)), ['report', 'gate-passed', 'merged']);
  assert.deepEqual(sat.github.log, [['create', `hl/${id}`], ['merge', 7]], 'the satellite used its own gh');
  assert.equal(hub.github.log.length, 0);
  const r = hubRow(id);
  assert.equal(r.pr_url, 'https://github.com/gitgiant/demo/pull/7');
  assert.equal(r.gate, 'tests');
  assert.equal(r.sha, 'abc1234def');
  const [job] = hub.db.prepare('SELECT * FROM tests').all();
  assert.equal(job.host, 'sat1', 'the gate job ran on the satellite; the hub mirrors it');
  assert.equal(job.state, 'done');
  assert.equal(JSON.parse(job.report).status, 'pass');
  assert.equal((await hub.api('test.get', { id: job.id })).result.report.passed, 3);
  assert.equal(sat.db.prepare('SELECT COUNT(*) n FROM events').get().n, 0, 'the satellite keeps no delegator events');
  await waitFor(() => !hub.db.prepare('SELECT 1 FROM commands WHERE acked_at IS NULL').get(), 'spawn acknowledged');
});

test('an ask on a satellite is answered on the hub; mail between hosts goes both ways', async (t) => {
  const { hub, sat, spawn, hubRow, satRow, toasts, satToasts } = await twoHosts(t);
  const { id } = await spawn();
  const who = sat.core.authenticate(satRow(id).token, 'x');
  await sat.core.call('ask', { question: 'Which way?', choices: ['A', 'B'] }, who);
  await waitFor(() => hub.db.prepare('SELECT * FROM asks').get(), 'ask mirrored');
  const q = hub.db.prepare('SELECT * FROM asks').get();
  assert.equal(q.question, 'Which way?');
  assert.ok(q.remote_id);
  assert.equal(toasts[0].title, `${id} asks`, 'the hub notifies you');
  assert.match(toasts[0].links.page, new RegExp(`/ask/${q.id}\\?k=`), 'with the hub\'s answer page');
  assert.equal(satToasts.length, 0, 'nothing pops up on the satellite');
  assert.equal(hubRow(id).state, 'blocked');
  const r = (await hub.api('answer', { ask: q.id, choice: 1 })).result;
  assert.equal(r.answered, 'B');
  assert.equal(satRow(id).state, 'working');
  assert.ok(sat.db.prepare('SELECT answer FROM asks WHERE id = ?').get(q.remote_id).answer === 'B');
  assert.match(sat.db.prepare("SELECT text FROM mail WHERE recipient = ? AND sender = 'user'").get(id).text, /Which way\?.*B/);

  // A stall the satellite's watch notices is shown on the hub.
  sat.db.prepare("UPDATE identities SET seen_at = '2020-01-01T00:00:00.000Z' WHERE identity = ?").run(id);
  await sat.core.watch();
  await waitFor(() => toasts.some(n => n.title === `${id} may be stuck (sat1)`), 'stall notification on the hub');
  await waitFor(() => hubRow(id).state === 'blocked', 'blocked mirrored');
  assert.equal(satToasts.length, 0);

  // Worker on sat1 → an identity only the hub knows (the delegator's own session).
  hub.db.prepare("INSERT INTO identities (identity, family, model, seen_at) VALUES ('claude_opus-5-5_aaaaa', 'claude', 'opus-5-5', ?)").run(new Date().toISOString());
  await sat.core.call('mail.send', { to: 'claude_opus-5-5_aaaaa', text: 'hello from sat1' }, who);
  await waitFor(() => hub.db.prepare("SELECT 1 FROM mail WHERE recipient = 'claude_opus-5-5_aaaaa'").get(), 'mail up to the hub');
  assert.equal(hub.db.prepare("SELECT sender FROM mail WHERE recipient = 'claude_opus-5-5_aaaaa'").get().sender, id);
  // Hub → the worker on sat1.
  await hub.api('mail.send', { from: 'claude_opus-5-5_aaaaa', to: id, text: 'hello back' });
  await waitFor(() => sat.db.prepare("SELECT 1 FROM mail WHERE recipient = ? AND text = 'hello back'").get(id), 'mail down to sat1');
});

test('pause, resume, reply and kill reach the satellite exactly once, also when it was offline', async (t) => {
  const { hub, sat, d, spawn, hubRow, satRow, events } = await twoHosts(t);
  const { id } = await spawn();
  const count = (kind) => sat.host.calls.filter(c => c[0] === kind && c[1] === id).length;
  const userMail = () => sat.db.prepare("SELECT COUNT(*) n FROM mail WHERE recipient = ? AND sender = 'user'").get(id).n;

  assert.deepEqual((await hub.api('pause', { agent: id })).result, { paused: id });
  assert.equal(hubRow(id).state, 'paused');
  assert.deepEqual((await hub.api('unpause', { agent: id })).result, { resumed: id });
  assert.deepEqual((await hub.api('reply', { agent: id, text: 'keep going' })).result, { sent: [id] });
  assert.equal(userMail(), 1);

  // Offline: commands wait on the hub and are delivered once on reconnect.
  await sat.sat.stop();
  await waitFor(() => !hub.hub.linked('sat1'), 'link closed');
  const p = (await hub.api('pause', { agent: id })).result;
  assert.equal(p.queued, true);
  assert.match(p.note, /host offline/);
  assert.equal((await hub.api('reply', { agent: id, text: 'while you were away' })).result.queued, true);
  assert.equal(count('pause'), 1);
  assert.equal(hub.hub.list()[0].pendingCommands, 2);
  const status = (await hub.api('agents', { delegator: d })).result[0];
  assert.equal(status.host, 'sat1');
  hub.db.prepare("UPDATE hosts SET online = 0 WHERE name = 'sat1'").run();
  assert.equal((await hub.api('agents', { delegator: d })).result[0].host_offline, true, '`status` shows host offline');

  sat.sat.start();
  await waitFor(() => hub.hub.list()[0].pendingCommands === 0, 'delivered on reconnect');
  await waitFor(() => satRow(id).state === 'paused' && userMail() === 2, 'pause and reply ran');
  assert.equal(count('pause'), 2);
  // Every reconnect resends unacknowledged commands; the satellite skips ids it already ran.
  const last = hub.db.prepare('SELECT * FROM commands ORDER BY id DESC LIMIT 1').get();
  assert.equal(sat.sat.command({ id: last.id, ...JSON.parse(last.body), type: last.type }), null);
  await sat.sat.stop();
  await waitFor(() => !hub.hub.linked('sat1'), 'link closed again');
  sat.sat.start();
  await waitFor(() => hub.hub.linked('sat1'), 'relinked');
  await new Promise(r => setTimeout(r, 100));
  assert.equal(count('pause'), 2);
  assert.equal(userMail(), 2);

  // Kill while offline: the hub ends it at once (the delegator's place frees); the satellite stops the worker on reconnect.
  await sat.sat.stop();
  await waitFor(() => !hub.hub.linked('sat1'), 'link closed for kill');
  assert.equal((await hub.api('kill', { agent: id })).result.queued, true);
  assert.equal(hubRow(id).state, 'killed');
  assert.match((await events()).find(e => e.kind === 'killed').text, /sat1 is offline/);
  sat.sat.start();
  await waitFor(() => satRow(id).state === 'killed', 'killed on sat1');
  assert.equal(count('stop'), 1);
  await waitFor(() => hub.hub.list()[0].pendingCommands === 0, 'kill acknowledged');
  assert.equal(hubRow(id).state, 'killed', 'stays killed');
});

test('a satellite refusing a spawn fails the agent on the hub; attach points at the host', async (t) => {
  const { hub, sat, d, spawn } = await twoHosts(t);
  const { id } = await spawn();
  assert.match((await hub.api('attach', { agent: id })).error, /runs on sat1: run `hauptling attach/);
  // A spawn command whose agent the satellite won't take (forged local repo): [failed] on the hub.
  const at = new Date().toISOString();
  hub.db.prepare(`INSERT INTO agents (id, delegator, vendor, model, repo, base, branch, brief, title, state, token, created_at, updated_at, host)
    VALUES ('claude_x_99999', ?, 'claude', 'x', '/local/repo', 'main', 'b', 'b', 't', 'spawning', 'tok-9', ?, ?, 'sat1')`).run(d, at, at);
  hub.hub.command('sat1', 'spawn', { agent: { id: 'claude_x_99999', repo: '/local/repo', vendor: 'claude' }, delegator: { id: d } });
  await waitFor(() => hub.db.prepare("SELECT state FROM agents WHERE id = 'claude_x_99999'").get().state === 'failed', 'failed on the hub');
  assert.match(hub.db.prepare("SELECT text FROM events WHERE kind = 'failed'").get().text, /local repos run on the hub only/);
  void sat;
});

test('with no satellites, placement, slots and tests stay on the hub as before', async () => {
  const p = placementHub();
  const d = (await p.core.call('delegator.start', { repo: 'gitgiant/demo', max: 5 })).id;
  const ids = [];
  for (let i = 0; i < 4; i++) ids.push(await p.spawn({ delegator: d }));
  assert.deepEqual(ids.map(r => [r.host, r.state]), [['hub', 'spawning'], ['hub', 'spawning'], ['hub', 'spawning'], ['hub', 'queued']]);
  assert.equal(p.db.prepare('SELECT COUNT(*) n FROM commands').get().n, 0);
  await assert.rejects(p.spawn({ delegator: d, host: 'sat1' }), /No host sat1: use hub or auto/);
  const agents = await p.core.call('agents', { delegator: d });
  assert.ok(agents.every(a => a.host === 'hub' && !('host_offline' in a)));
});

test('a test writer on a satellite hands its spec tests to the implementer through the hub', async (t) => {
  const { hub, sat, d, hubRow, satRow, events } = await twoHosts(t);
  const r = (await hub.api('spawn', { delegator: d, brief: '# Specced\nDo it.', vendor: 'claude', mode: 'cheapest', testWriter: { vendor: 'claude' } })).result;
  assert.equal(r.testWriter.host, 'sat1');
  assert.equal(hubRow(r.id).state, 'waiting');
  await waitFor(() => satRow(r.testWriter.id)?.state === 'working', 'test writer working on sat1');
  assert.equal(satRow(r.id), undefined, 'the implementer is not sent before the tests are ready');
  await sat.core.call('report', { text: 'spec tests' }, sat.core.authenticate(satRow(r.testWriter.id).token, 'x'));
  await waitFor(() => satRow(r.id)?.state === 'working', 'implementer working on sat1');
  assert.equal(satRow(r.id).start_from, `hl/${r.id}`, 'it starts from the test writer\'s branch');
  assert.equal(hubRow(r.testWriter.id).state, 'handed-off');
  assert.ok((await events()).some(e => e.kind === 'tests-ready'));
});
