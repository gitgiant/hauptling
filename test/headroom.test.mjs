import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.mjs';
import { createCore } from '../src/core.mjs';
import { headline } from '../src/dashboard.mjs';
import * as keyStore from '../src/keys.mjs';
import { loadModels } from '../src/models.mjs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const HOUR = 3600e3;
const settle = () => new Promise(r => setTimeout(r, 20));

async function setup({ keys = {}, pct } = {}) {
  const db = openDb(':memory:');
  const host = {
    workRoot: '/hl/work', alive: true,
    async run() { return { stdout: '' }; },
    async startWorker() {}, async stopWorker() {}, async tmuxType() {},
    async tmuxAlive() { return true; }, async tmuxCapture() { return ''; },
    attachArgv: () => [], async hostGit() { return 'main'; },
    headroomPct: () => pct,
  };
  const toasts = [];
  const core = createCore({ db, host, github: { gitAuthEnv: async () => ({}), prFind: async () => null }, notify: t => toasts.push(t),
    keys: { ...keyStore, getKey: () => null, getBudget: () => null, getExhausted: () => null, ...keys },
    models: () => loadModels(join(tmpdir(), 'none.json')), workerUrl: 'http://172.0.0.1:47800', runnerToken: 'RUN' });
  await core.call('delegator.start', { repo: 'gitgiant/demo', max: 6 });
  let seq = 0;
  /** A reading; later calls are newer. */
  const reading = (vendor, used, { window = '5h', resets = HOUR, slot = 'hl-w1' } = {}) => db.prepare(`INSERT OR REPLACE INTO slot_usage (slot, vendor, window, used_pct, resets_at, at) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(slot, vendor, window, used, resets == null ? null : new Date(Date.now() + resets).toISOString(), new Date(Date.UTC(2026, 0, 1) + ++seq * 1000).toISOString());
  const spawn = async (args = {}) => { const r = await core.call('spawn', { brief: 'task', mode: 'cheapest', ...args }); await settle(); return r; };
  const row = (id) => db.prepare('SELECT * FROM agents WHERE id = ?').get(id);
  const events = () => db.prepare("SELECT text FROM events WHERE kind = 'headroom'").all();
  return { db, core, toasts, reading, spawn, row, events };
}

test('round robin skips a vendor at 85% and takes the next', async () => {
  const { reading, spawn } = await setup();
  reading('claude', 85);
  assert.equal((await spawn()).vendor, 'codex');
  assert.equal((await spawn()).vendor, 'agy');
  assert.equal((await spawn()).vendor, 'codex');
});

test('a passed reset counts as free; the newest reading from any slot wins', async () => {
  const { reading, spawn } = await setup();
  reading('claude', 95, { resets: -1000 });
  assert.equal((await spawn()).vendor, 'claude');
  reading('codex', 100);
  reading('codex', 10, { slot: 'hl-w2' });
  const r = await spawn();
  assert.deepEqual([r.vendor, r.state], ['codex', 'spawning']);
});

test('headroomPct in the config moves the threshold', async () => {
  const { reading, spawn } = await setup({ pct: 90 });
  reading('claude', 85);
  assert.equal((await spawn()).vendor, 'claude');
});

test('all vendors full: spawns queue with one event and notification, then start in order', async () => {
  const { core, reading, spawn, row, events, toasts } = await setup();
  reading('claude', 91);
  reading('codex', 84, { window: 'week', resets: 2 * HOUR });
  reading('agy', 80, { resets: 3 * HOUR });
  const a = await spawn(), b = await spawn();
  assert.deepEqual([a.state, b.state], ['queued', 'queued']);
  assert.match(a.waiting, /^waiting for headroom \(claude 91% 5h, codex 84% week, agy 80% 5h; next reset .*\d\d:\d\d\)$/);
  await core.poll();
  assert.equal(events().length, 1);
  assert.match(events()[0].text, /claude 91%.*next reset/);
  assert.equal(toasts.length, 1);
  const listed = await core.call('agents', {});
  assert.match(headline(listed[0]), /^Waiting for headroom \(claude 91% 5h/);

  reading('codex', 20, { window: 'week', slot: 'hl-w2' });
  await core.poll();
  await settle();
  // Those that changed vendor have new ids by now.
  const [x, y] = await Promise.all([a, b].map(async s => row((await core.call('agent.resolve', { agent: s.id })).id)));
  for (const r of [x, y]) {
    assert.notEqual(r.state, 'queued');
    assert.equal(r.vendor, 'codex');
    assert.match(r.model, /./);
  }
  assert.ok(x.updated_at <= y.updated_at);

  // A new stretch is announced again.
  reading('codex', 99, { window: 'week' });
  await spawn();
  assert.equal(events().length, 2);
  assert.equal(toasts.filter(t => t.title === 'Spawns are waiting for headroom').length, 2);
});

test('an api-billed vendor is never skipped', async () => {
  const { reading, spawn } = await setup({ keys: { getKey: v => (v === 'claude' ? 'sk-test' : null) } });
  reading('claude', 100);
  const r = await spawn();
  assert.deepEqual([r.vendor, r.state, r.billing, r.warning], ['claude', 'spawning', 'api', undefined]);
});

test('an explicit vendor, or a model implying one, starts at 85% with a warning', async () => {
  const { reading, spawn } = await setup();
  reading('codex', 85);
  const r = await spawn({ vendor: 'codex' });
  assert.equal(r.state, 'spawning');
  assert.match(r.warning, /codex is at 85% of its 5h window/);
  const model = loadModels(join(tmpdir(), 'none.json')).vendors.codex.models[0].id;
  const m = await spawn({ model, mode: 'suggest', allowTier: true });
  assert.deepEqual([m.vendor, m.state], ['codex', 'spawning']);
  assert.match(m.warning, /85%/);
});

test('the test writer skips a vendor without headroom', async () => {
  const { reading, spawn } = await setup();
  reading('codex', 85);
  const r = await spawn({ vendor: 'claude', testWriter: {} });
  assert.equal(r.testWriter.vendor, 'claude');
  const s = await spawn({ vendor: 'claude', testWriter: {} });
  assert.equal(s.testWriter.vendor, 'agy');
});

test('a queued agent moved to another vendor is renamed; the old id still works', async () => {
  const { db, core, reading, spawn, row } = await setup();
  for (const v of ['claude', 'codex', 'agy']) reading(v, 90);
  const r = await spawn({ testWriter: {} });
  const old = r.testWriter.id, impl = r.id;
  const to = row(old).vendor === 'codex' ? 'agy' : 'codex';
  await core.call('mail.send', { from: 'user', to: old, text: 'hello' });
  db.prepare("INSERT INTO kv (key, value) VALUES (?, 'x')").run(`stall:${old}`);

  reading(to, 10);
  await core.poll();
  await settle();
  assert.equal(row(old), undefined);
  const moved = db.prepare("SELECT * FROM agents WHERE role = 'tests'").get();
  assert.match(moved.id, new RegExp(`^${to}_.+_[0-9a-f]{5}$`));
  assert.notEqual(moved.state, 'queued');
  // The test writer commits on the implementer's task branch, which keeps its name.
  assert.equal(moved.branch, `hl/${impl}`);
  assert.equal(row(impl).depends_on, moved.id);
  const renamed = db.prepare("SELECT agent, text FROM events WHERE kind = 'renamed'").all();
  assert.equal(renamed.length, 1);
  assert.equal(renamed[0].agent, moved.id);
  assert.ok(renamed[0].text.startsWith(`${old} → ${moved.id} (headroom`));
  assert.equal(db.prepare('SELECT recipient FROM mail').get().recipient, moved.id);
  assert.ok(db.prepare('SELECT 1 FROM kv WHERE key = ?').get(`stall:${moved.id}`));

  const suffix = old.split('_').pop();
  for (const name of [old, suffix]) assert.deepEqual(await core.call('agent.resolve', { agent: name }), { id: moved.id, renamed: true });
  assert.deepEqual(await core.call('agent.resolve', { agent: moved.id }), { id: moved.id, renamed: false });
  assert.deepEqual((await core.call('reply', { agent: old, text: 'go on' })).sent, [moved.id]);
  assert.deepEqual(await core.call('mail.send', { from: 'user', to: suffix, text: 'again' }), [moved.id]);
  assert.deepEqual(await core.call('kill', { agent: old }), { killed: moved.id });
  assert.equal(row(moved.id).state, 'killed');
});

test('the renamed agent gets the new branch; the spawn answers with the new id', async () => {
  const { db, core, reading, spawn, row } = await setup();
  for (const v of ['claude', 'codex', 'agy']) reading(v, 90);
  const r = await spawn();
  const before = row(r.id);
  reading(before.vendor === 'agy' ? 'codex' : 'agy', 10);
  await core.poll();
  await settle();
  const now = db.prepare('SELECT * FROM agents').get();
  assert.notEqual(now.id, r.id);
  assert.ok(now.id.startsWith(`${now.vendor}_`));
  assert.equal(now.branch, `hl/${now.id}`);
  assert.equal((await core.call('agent.get', { agent: r.id })).id, now.id);
});

test('no rename when vendor and model stay the same', async () => {
  const { db, core, reading, spawn, row } = await setup();
  for (const v of ['claude', 'codex', 'agy']) reading(v, 90);
  const r = await spawn();
  reading(r.vendor, 10);
  await core.poll();
  await settle();
  assert.notEqual(row(r.id).state, 'queued');
  assert.equal(row(r.id).branch, `hl/${r.id}`);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM events WHERE kind = 'renamed'").get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM aliases').get().n, 0);
});
