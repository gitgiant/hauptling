import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOME = mkdtempSync(join(tmpdir(), 'hl-ceiling-'));
process.env.HAUPTLING_HOME = HOME;
const { openDb } = await import('../src/db.mjs');
const { createCore } = await import('../src/core.mjs');
const { headline } = await import('../src/dashboard.mjs');
const keys = await import('../src/keys.mjs');
const { logins } = await import('../src/setup.mjs');
const { ceilingTier, loadModels, tierName } = await import('../src/models.mjs');

const cfg = loadModels(join(HOME, 'none.json'));
const KEY = 'sk-ant-api03-0123456789abcdefghij';

/** A core on the real key store: `upTo`/`budget` for claude; `signed`: slots signed in to claude's plan. */
function setup({ upTo = 2, budget = null, signed = ['hl-w1', 'hl-w2', 'hl-w3'] } = {}) {
  for (const v of ['claude', 'codex', 'agy']) keys.removeKey(v);
  keys.setKey('claude', KEY);
  if (budget) keys.setBudget('claude', budget);
  if (upTo) keys.setUpTo('claude', upTo);
  const db = openDb(':memory:');
  const toasts = [];
  const host = {
    started: [], signed, async run() { return { stdout: 'abc\n' }; }, workRoot: '/w', async startWorker(w) { this.started.push(w); }, async tmuxType() {}, async stopWorker() {},
    async tmuxAlive() { return true; }, async tmuxCapture() { return ''; }, attachArgv: () => [], async hostGit() { return 'main'; }, async codexUsage() { return null; },
    async signedIn() { return this.signed; },
  };
  const gh = { gitAuthEnv: async () => ({}), prFind: async () => null, prCreate: async () => ({}), requiredChecks: async () => [], prAutoMerge: async () => {}, prMerge: async () => {}, prView: async () => ({ state: 'OPEN', statusCheckRollup: [] }) };
  const core = createCore({ db, host, github: gh, keys, notify: t => toasts.push(t), models: () => cfg, workerUrl: 'http://w', publicUrl: 'http://127.0.0.1:47800', runnerToken: 'RUN' });
  const row = (id) => db.prepare('SELECT * FROM agents WHERE id = ?').get(id);
  const plan = (pct) => {
    const future = new Date(Date.now() + 3600e3).toISOString();
    db.prepare('DELETE FROM slot_usage').run();
    if (pct != null) db.prepare("INSERT INTO slot_usage VALUES ('hl-w1', 'claude', '5h', ?, ?, ?)").run(pct, future, new Date().toISOString());
  };
  const start = () => core.call('delegator.start', { repo: 'gitgiant/demo', max: 8 });
  const spawn = async (model, more = {}) => { const r = await core.call('spawn', { brief: 'task', vendor: 'claude', model, ...more }); await settle(); return r; };
  return { db, host, core, toasts, row, plan, start, spawn };
}
const settle = () => new Promise(r => setTimeout(r, 20));

test('ceiling sonnet: opus runs on the plan, sonnet and haiku on the API', async () => {
  const { host, core, row, start, spawn } = setup();
  await start();
  for (const [model, billing] of [['opus-5-5', 'plan'], ['sonnet-5-5', 'api'], ['haiku-5-5', 'api']]) {
    const r = await spawn(model);
    assert.deepEqual([r.billing, r.aboveCeiling, row(r.id).billing], [billing, billing === 'plan' ? true : undefined, billing], model);
    assert.equal(host.started.at(-1).apiKey, billing === 'api', model);
  }
  assert.equal(core.billingFor('claude', 'fable-5-2'), 'plan');
  assert.equal(core.billingFor('claude', 'not-in-models-json'), 'plan', 'unknown tier never uses the key');
});

test('ceiling with a budget: over 90% sonnet goes to the plan, as without a ceiling', async () => {
  const { db, core, start, spawn } = setup({ budget: 100 });
  await start();
  const a = await spawn('sonnet-5-5');
  assert.equal(a.billing, 'api');
  db.prepare('UPDATE agents SET usage = ? WHERE id = ?').run(JSON.stringify({ cost_usd: 90 }), a.id);
  const b = await spawn('sonnet-5-5');
  assert.deepEqual([b.billing, b.aboveCeiling], ['plan', undefined]);
  assert.equal(core.billingFor('claude', 'haiku-5-5'), 'plan');
});

test('no-budget key with a ceiling: opus starts only on a signed-in slot, else it waits for the plan', async () => {
  const { host, core, row, start, spawn } = setup({ signed: [] });
  await start();
  const r = await spawn('opus-5-5');
  const note = 'waiting for plan (opus above API ceiling sonnet)';
  assert.deepEqual([r.state, r.billing, r.aboveCeiling, r.waiting], ['queued', 'plan', true, note]);
  assert.equal(headline({ ...row(r.id), headroom: core.headroomNote(row(r.id)) }), 'Waiting for plan (opus above API ceiling sonnet)');
  assert.equal((await spawn('sonnet-5-5')).billing, 'api', 'the key covers a slot without a sign-in');
  host.signed = ['hl-w3'];
  await core.poll();
  await settle();
  assert.deepEqual([row(r.id).slot, row(r.id).billing], ['hl-w3', 'plan']);
});

test('opus queued while the plan is at 100% never goes to the API', async () => {
  const { host, core, row, plan, start, spawn } = setup();
  await start();
  plan(100);
  const r = await spawn('opus-5-5');
  assert.equal(r.waiting, 'waiting for plan (opus above API ceiling sonnet)');
  await core.poll();
  await settle();
  assert.deepEqual([row(r.id).state, row(r.id).billing, host.started.length], ['queued', null, 0]);
  plan(null);
  await core.poll();
  await settle();
  assert.deepEqual([row(r.id).state, row(r.id).billing, host.started.at(-1).apiKey], ['working', 'plan', false]);
});

test('out of credit: models above the ceiling still spawn on the plan, the rest are refused', async () => {
  const { start, spawn } = setup();
  await start();
  keys.markExhausted('claude');
  assert.equal((await spawn('opus-5-5')).billing, 'plan');
  await assert.rejects(spawn('sonnet-5-5'), /API credit ran out/);
});

test('rotation: an above-ceiling test writer and implementer follow their own model', async () => {
  const { db, start, spawn } = setup({ upTo: 1 });
  await start();
  const r = await spawn('haiku-5-5', { testWriter: { vendor: 'claude', model: 'sonnet-5-5' } });
  assert.deepEqual([r.testWriter.billing, r.testWriter.aboveCeiling], ['plan', true]);
  assert.equal(db.prepare('SELECT billing FROM agents WHERE id = ?').get(r.testWriter.id).billing, 'plan');
});

test('rotation-chosen above-ceiling spawn: held by plan headroom, announced once, then starts on the plan', async () => {
  const { db, core, row, plan, start } = setup({ upTo: 1 });
  const order = cfg.order;
  cfg.order = ['claude'];
  try {
    await start();
    plan(85);
    const r = await core.call('spawn', { brief: 'task', mode: 'rule', difficulty: 'hard' });
    await settle();
    await core.poll();
    await core.poll();
    assert.equal(r.waiting, 'waiting for plan (opus above API ceiling haiku)');
    const events = db.prepare("SELECT text FROM events WHERE kind = 'headroom'").all();
    assert.equal(events.length, 1);
    assert.match(events[0].text, /waiting for plan/);
    plan(null);
    await core.poll();
    await settle();
    assert.equal(row(r.id).billing, 'plan');
  } finally { cfg.order = order; }
});

test('--up-to: a tier or a model name; unknown and ambiguous names are refused', () => {
  for (const v of ['2', 'sonnet', 'sonnet-5-5', 'claude-sonnet-5-5', 'Sonnet']) assert.equal(ceilingTier(cfg, 'claude', v), 2, v);
  assert.equal(ceilingTier(cfg, 'claude', 'opus'), 3);
  assert.equal(ceilingTier(cfg, 'claude', 'off'), null);
  assert.equal(tierName(cfg, 'claude', 2), 'sonnet');
  for (const v of ['gpt', 'sonne', '4', '0', '5']) assert.throws(() => ceilingTier(cfg, 'claude', v), /--up-to takes|several tiers/, v);
  assert.throws(() => ceilingTier(cfg, 'codex', 'gpt'), /several tiers/);
});

test('logins: with a ceiling, slot sign-ins count again; the key still covers the slot', () => {
  keys.setKey('claude', KEY);
  keys.setUpTo('claude', 2);
  const [l] = logins(['hl-w9'], ['claude']);
  assert.deepEqual([l.ok, l.covered, l.upTo], [false, true, 2]);
  keys.setUpTo('claude', null);
  assert.equal(logins(['hl-w9'], ['claude'])[0].ok, true);
  keys.removeKey('claude');
});

test('CLI: key set/budget/up-to store the ceiling, key list shows it, off and rm clear it', () => {
  keys.removeKey('claude');
  const bin = fileURLToPath(new URL('../bin/hauptling.mjs', import.meta.url));
  mkdirSync(join(HOME, 'slots', 'hl-w1'), { recursive: true });
  const run = (...args) => spawnSync(process.execPath, [bin, 'key', ...args], { env: { ...process.env, HAUPTLING_HOME: HOME }, input: `${KEY}\n`, encoding: 'utf8' });
  const bad = run('set', 'claude', '--up-to', 'sonet');
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /got "sonet"/);
  assert.equal(keys.getKey('claude'), null, 'refused before anything is stored');
  const set = run('set', 'claude', '--up-to', 'sonnet');
  assert.match(set.stdout, /up to sonnet \(tier 2\)|models up to sonnet \(tier 2\)/);
  assert.match(set.stdout, /warning: .*hl-w1.* not signed in to claude/);
  assert.match(run('list').stdout, /claude +API key …ghij up to sonnet \(tier 2\)/);
  assert.equal(run('up-to', 'claude', 'sonet').status, 1);
  assert.equal(keys.getUpTo('claude'), 2);
  assert.equal(run('up-to', 'claude', 'off').status, 0);
  assert.equal(keys.getUpTo('claude'), null);
  assert.doesNotMatch(run('list').stdout, /up to sonnet/);
  assert.match(run('budget', 'claude', '100', '--up-to', '1').stdout, /up to haiku \(tier 1\) first, up to \$100/);
  assert.equal(run('budget', 'claude', '50', '--up-to', 'off').status, 0);
  assert.equal(keys.getUpTo('claude'), null);
  run('up-to', 'claude', '3');
  run('rm', 'claude');
  assert.equal(keys.getUpTo('claude'), null);
});
