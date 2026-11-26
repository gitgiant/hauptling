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
  for (const x of [a, b]) {
    assert.notEqual(row(x.id).state, 'queued');
    assert.equal(row(x.id).vendor, 'codex');
    assert.match(row(x.id).model, /./);
  }
  assert.ok(row(a.id).updated_at <= row(b.id).updated_at);

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
