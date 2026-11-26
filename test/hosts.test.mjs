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

async function startBroker(t, name, clock = () => Date.now()) {
  const homeDir = mkdtempSync(join(tmpdir(), `hl-${name}-`));
  const db = openDb(join(homeDir, 'hauptling.db'));
  const logs = [];
  const log = (m) => logs.push(m);
  let core;
  const hub = createHub({ db, log, clock, emit: (...a) => core.emit(...a), pingMs: 50 });
  core = createCore({ db, host: {}, github: {}, hub, log, keys: { ...keyStore, getKey: () => null, getBudget: () => null }, models: () => loadModels(join(tmpdir(), 'none.json')), workerUrl: 'http://127.0.0.1:1', runnerToken: 'RUN' });
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
  return { homeDir, db, hub, core, url, port, api, logs, down, up: () => listen(port) };
}

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
    capabilities: async () => ({ vendors: { claude: ['hl-w1', 'hl-w2'] }, free: { claude: 2 }, gpu: false, maxWorkers: 6 }), ...opts });
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
