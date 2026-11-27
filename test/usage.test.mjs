import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDb } from '../src/db.mjs';
import { createCore } from '../src/core.mjs';
import * as keyStore from '../src/keys.mjs';
import { loadModels } from '../src/models.mjs';
import { accumulate, estimateCost, lastTokenCount, normalizeUsage, outOfCredit, scrub, statusText, poolOf, windowLabel } from '../src/usage.mjs';

// The key store reads and writes under here, never the real ~/.hauptling.
const HOME = mkdtempSync(join(tmpdir(), 'hl-usage-'));
process.env.HAUPTLING_HOME = HOME;
after(() => rmSync(HOME, { recursive: true, force: true }));

// Shapes copied from real payloads (Claude Code and agy status line docs; a Codex 0.172 rollout file).
const CLAUDE = {
  model: { id: 'claude-opus-5-5', display_name: 'Opus 5.5' },
  cost: { total_cost_usd: 1.2345 },
  context_window: { total_input_tokens: 52000, total_output_tokens: 4100, context_window_size: 200000, used_percentage: 26 },
  rate_limits: { five_hour: { used_percentage: 91.5, resets_at: 1795265351 }, seven_day: { used_percentage: 40, resets_at: 1795446077 } },
};
const AGY = {
  model: { id: 'gemini-3-pro' }, email: 'someone@example.com', plan_tier: 'pro',
  context_window: { total_input_tokens: 9000, total_output_tokens: 700, used_percentage: 4.5 },
  cost: { total_usd: 0.05, estimated: true },
  quota: {
    'gemini-5h': { remaining_fraction: 0.25, reset_time: '2026-11-24T20:00:00Z' },
    '3p-5h': { remaining_fraction: 0.9, reset_time: '2026-11-24T21:00:00Z' },
    'gemini-weekly': { remaining_fraction: 0.6, reset_time: '2026-11-30T00:00:00Z' },
  },
};
const CODEX_LINE = JSON.stringify({ timestamp: '2026-11-21T12:36:28.491Z', type: 'event_msg', payload: { type: 'token_count',
  info: { total_token_usage: { input_tokens: 113086, cached_input_tokens: 101120, output_tokens: 1017, total_tokens: 114103 },
    last_token_usage: { input_tokens: 17841, output_tokens: 79, total_tokens: 17920 }, model_context_window: 258400 },
  rate_limits: { primary: { used_percent: 1.0, window_minutes: 300, resets_at: 1795265351 }, secondary: { used_percent: 73.0, window_minutes: 10080, resets_at: 1795446077 }, plan_type: 'plus' } } });

test('usage: Claude status line → tokens, reported cost, context %, 5h/week used', () => {
  const u = normalizeUsage('claude', CLAUDE);
  assert.deepEqual({ ...u, limits: undefined }, { model: 'claude-opus-5-5', tokens_in: 52000, tokens_out: 4100, context_pct: 26, cost_usd: 1.2345, cost_estimated: false, limits: undefined });
  assert.deepEqual(u.limits, [{ window: '5h', used_pct: 91.5, resets_at: new Date(1795265351e3).toISOString() }, { window: 'week', used_pct: 40, resets_at: new Date(1795446077e3).toISOString() }]);
  assert.equal(statusText(u), 'hauptling · ctx 26% · $1.23 · 5h 92% · week 40%');
  assert.deepEqual(normalizeUsage('claude', { model: { id: 'x' } }).limits, [], 'no rate_limits before the first response');
});

test('usage: agy quota "remaining" → used (fullest bucket per window); email never forwarded', () => {
  assert.equal(scrub(AGY).email, undefined);
  const u = normalizeUsage('agy', scrub(AGY));
  assert.equal(u.cost_usd, 0.05);
  assert.equal(u.cost_estimated, true);
  assert.deepEqual(u.limits, [{ window: '5h', used_pct: 75, resets_at: '2026-11-24T20:00:00Z' }, { window: '3p-5h', used_pct: 10, resets_at: '2026-11-24T21:00:00Z' }, { window: 'week', used_pct: 40, resets_at: '2026-11-30T00:00:00Z' }],
    'the Claude/GPT ("3p") buckets are their own windows');
  assert.equal(statusText(u), 'hauptling · ctx 5% · ~$0.05 · 5h 75% · week 40%', 'a Gemini worker shows the Gemini windows');
  assert.equal(statusText({ ...u, model: 'Claude Sonnet 5.5 (Medium)' }), 'hauptling · ctx 5% · ~$0.05 · 5h 10%', 'a Claude worker on agy shows the Claude/GPT ones');
  assert.deepEqual([poolOf('agy', 'claude-opus-5-5-high'), poolOf('agy', 'gpt-oss-120b-medium'), poolOf('agy', 'gemini-4-neon-high'), poolOf('claude', 'claude-opus-5-5')], ['3p', '3p', '', '']);
  assert.deepEqual([windowLabel('3p-week', 'agy'), windowLabel('5h', 'agy'), windowLabel('5h', 'claude')], ['Claude/GPT week', 'Gemini 5h', '5h']);
});

test('usage: Codex rollout tail → last token_count; cost estimated from models.json prices or unknown', () => {
  const tail = `{"type":"event_msg","payload":{"type":"token_count","info":null,"rate_limits":{"primary":{"used_percent":0.5,"window_minutes":300}}}}\nnot json\n${CODEX_LINE}\n{"type":"response_item","payload":{"type":"message"}}\n{"half a line`;
  const p = lastTokenCount(tail);
  const u = normalizeUsage('codex', p, { usd_in: 1.25, usd_out: 10 });
  assert.equal(u.tokens_in, 113086);
  assert.equal(u.context_pct, 6.9);
  assert.equal(u.cost_usd, 0.1515);
  assert.equal(u.cost_estimated, true);
  assert.deepEqual(u.limits.map(l => [l.window, l.used_pct]), [['5h', 1], ['week', 73]]);
  assert.equal(normalizeUsage('codex', p, { usd_in: null, usd_out: null }).cost_usd, null, 'unknown price → unknown cost');
  assert.equal(lastTokenCount('{"type":"session_meta"}\n'), null);
});

test('usage: estimate Codex cost using a shipped models.json price', () => {
  const cfg = loadModels(join(tmpdir(), 'none.json'));
  const luna = cfg.vendors.codex.models.find(model => model.id === 'gpt-6-luna');
  assert.equal(estimateCost(luna, 1_000_000, 1_000_000), 0.6);
});

/** `keys`: { key, budget } stands in for ~/.hauptling/keys (none by default). */
function setup({ key = null, budget = null, realKeys = false } = {}) {
  for (const v of ['claude', 'codex', 'agy']) keyStore.removeKey(v);
  const db = openDb(':memory:');
  const toasts = [];
  const host = {
    calls: [], async run() { return { stdout: 'abc\n' }; }, workRoot: '/w', started: [], async startWorker(w) { this.started.push(w); }, async tmuxType() {}, async stopWorker() {},
    async tmuxAlive() { return true; }, async tmuxCapture() { return ''; }, attachArgv: () => [], async hostGit() { return 'main'; },
    codex: null, async codexUsage() { return this.codex; },
  };
  const gh = { gitAuthEnv: async () => ({}), prFind: async () => null, prCreate: async () => ({}), requiredChecks: async () => [], prAutoMerge: async () => {}, prMerge: async () => {}, prView: async () => ({ state: 'OPEN', statusCheckRollup: [] }) };
  const keys = realKeys ? keyStore : { ...keyStore, getKey: () => key, getBudget: () => budget };
  const core = createCore({ db, host, github: gh, keys, notify: t => toasts.push(t), models: () => loadModels(join(tmpdir(), 'none.json')), workerUrl: 'http://w', publicUrl: 'http://127.0.0.1:47800', runnerToken: 'RUN' });
  return { db, host, core, toasts };
}
const settle = () => new Promise(r => setTimeout(r, 20));

test('usage.report: stored on the agent and its slot; 90% warns once per window; workers only', async () => {
  const { db, core, toasts } = setup();
  await core.call('delegator.start', { repo: 'gitgiant/demo' });
  const { id } = await core.call('spawn', { brief: 'task', vendor: 'claude', mode: 'cheapest' });
  await settle();
  const who = core.authenticate(db.prepare('SELECT token FROM agents WHERE id = ?').get(id).token, 'ADMIN');
  const r = await core.call('usage.report', { vendor: 'claude', payload: CLAUDE }, who);
  assert.match(r.text, /ctx 26%/);
  assert.equal(JSON.parse(db.prepare('SELECT usage FROM agents WHERE id = ?').get(id).usage).cost_usd, 1.2345);
  assert.deepEqual(db.prepare('SELECT slot, vendor, window, used_pct FROM slot_usage ORDER BY window').all().map(r => ({ ...r })), [
    { slot: 'hl-w1', vendor: 'claude', window: '5h', used_pct: 91.5 }, { slot: 'hl-w1', vendor: 'claude', window: 'week', used_pct: 40 }]);
  await core.call('usage.report', { vendor: 'claude', payload: CLAUDE }, who);
  assert.equal(toasts.length, 1, 'one warning per window and reset');
  assert.match(toasts[0].title, /claude usage 92%/);
  const ev = (await core.call('wait', { timeout: 0 })).events.find(e => e.kind === 'usage-high');
  assert.match(ev.text, /claude 5h window at 92%/);
  await assert.rejects(core.call('usage.report', { vendor: 'codex', payload: {} }, who), /from a claude worker/);
  await assert.rejects(core.call('usage.report', { vendor: 'claude', payload: CLAUDE }), /status line/);
});

test('100% of a vendor account (reported from any slot): new spawns of that vendor wait for the reset; other vendors start', async () => {
  const { db, core } = setup();
  await core.call('delegator.start', { repo: 'gitgiant/demo', max: 5 });
  const future = new Date(Date.now() + 3600e3).toISOString();
  db.prepare("INSERT INTO slot_usage VALUES ('hl-w2', 'claude', '5h', 100, ?, ?)").run(future, future);
  const c = await core.call('spawn', { brief: 'a', vendor: 'claude', mode: 'cheapest' });
  const x = await core.call('spawn', { brief: 'b', vendor: 'codex', mode: 'cheapest' });
  await settle();
  assert.equal(db.prepare('SELECT state FROM agents WHERE id = ?').get(c.id).state, 'queued', 'one account: hl-w1 and hl-w3 are just as exhausted');
  assert.equal(db.prepare('SELECT slot FROM agents WHERE id = ?').get(x.id).slot, 'hl-w1', 'codex is not blocked by claude limits');
  const rr = await core.call('spawn', { brief: 'c', mode: 'cheapest' });
  assert.notEqual(rr.vendor, 'claude', 'round robin skips the exhausted vendor');
  db.prepare("UPDATE slot_usage SET resets_at = ? WHERE vendor = 'claude'").run(new Date(Date.now() - 1000).toISOString());
  await core.poll();
  await settle();
  assert.ok(db.prepare('SELECT slot FROM agents WHERE id = ?').get(c.id).slot, 'starts once the window has reset');
});

test('Codex usage comes from the session log via poll; a missing log leaves usage unknown', async () => {
  const { db, core, host } = setup();
  await core.call('delegator.start', { repo: 'gitgiant/demo' });
  const { id } = await core.call('spawn', { brief: 'task', vendor: 'codex', mode: 'cheapest' });
  await settle();
  await core.poll();
  assert.equal(db.prepare('SELECT usage FROM agents WHERE id = ?').get(id).usage, null);
  host.codex = JSON.parse(CODEX_LINE).payload;
  await core.poll();
  const u = JSON.parse(db.prepare('SELECT usage FROM agents WHERE id = ?').get(id).usage);
  assert.equal(u.tokens_out, 1017);
  assert.equal(db.prepare("SELECT used_pct FROM slot_usage WHERE vendor = 'codex' AND window = 'week'").get().used_pct, 73);
});

test('API budget: API first until 90% of it is spent, then the plan; one warning per period', async () => {
  const { db, core, host, toasts } = setup({ key: 'sk-ant-api03-test', budget: { usd: 100, resets_on: 1 } });
  await core.call('delegator.start', { repo: 'gitgiant/demo', max: 5 });
  const future = new Date(Date.now() + 3600e3).toISOString();
  db.prepare("INSERT INTO slot_usage VALUES ('hl-w2', 'claude', '5h', 100, ?, ?)").run(future, future);
  const a = await core.call('spawn', { brief: 'a', vendor: 'claude', mode: 'cheapest' });
  await settle();
  assert.equal(a.billing, 'api');
  assert.equal(db.prepare('SELECT state FROM agents WHERE id = ?').get(a.id).state, 'working', 'on the API the plan limit does not hold it back');
  assert.equal(host.started.at(-1).apiKey, true);
  const report = (id, cost) => core.call('usage.report', { vendor: 'claude', payload: { ...CLAUDE, rate_limits: undefined, cost: { total_cost_usd: cost } } },
    core.authenticate(db.prepare('SELECT token FROM agents WHERE id = ?').get(id).token, 'ADMIN'));
  await report(a.id, 89.99);
  assert.equal(core.budgetState('claude').spent, 89.99);
  assert.equal(toasts.length, 0, 'under $90: no warning');
  const b = await core.call('spawn', { brief: 'b', vendor: 'claude', mode: 'cheapest' });
  await settle();
  assert.equal(b.billing, 'api');
  await report(b.id, 0.02);
  await report(b.id, 0.03);
  assert.equal(toasts.length, 1, 'one warning per period');
  assert.match(toasts[0].title, /claude API budget 90%/);
  assert.match((await core.call('wait', { timeout: 0 })).events.find(e => e.kind === 'api-budget').text, /new claude workers use your plan/);
  const c = await core.call('spawn', { brief: 'c', vendor: 'claude', mode: 'cheapest' });
  await settle();
  assert.equal(db.prepare('SELECT state FROM agents WHERE id = ?').get(c.id).state, 'queued', 'budget used up and the plan at 100%: waits');
  db.prepare("DELETE FROM slot_usage").run();
  await core.poll();
  await settle();
  const row = db.prepare('SELECT state, billing FROM agents WHERE id = ?').get(c.id);
  assert.deepEqual({ ...row }, { state: 'working', billing: 'plan' });
  assert.equal(host.started.at(-1).apiKey, false, 'plan workers get no key');
  db.prepare("UPDATE agents SET created_at = ? WHERE billing = 'api'").run(new Date(Date.now() - 40 * 86400e3).toISOString());
  assert.equal(core.billingFor('claude'), 'api', 'last period\'s spend does not count');
});

test('billing without a budget: a key covers every spawn, no key means the plan', () => {
  assert.equal(setup({ key: 'sk-ant-api03-test' }).core.billingFor('claude'), 'api');
  assert.equal(setup().core.billingFor('claude'), 'plan');
  assert.equal(setup().core.budgetState('claude'), null);
});

test('handoff-due: once per window at 85%, only to delegators running on that vendor\'s CLI', async () => {
  const { db, core } = setup();
  const { id: dc } = await core.call('delegator.start', { repo: 'gitgiant/demo', cli: 'claude' });
  const { id } = await core.call('spawn', { delegator: dc, brief: 'task', vendor: 'claude', mode: 'cheapest' });
  const { id: dx } = await core.call('delegator.start', { repo: 'gitgiant/demo', cli: 'codex' });
  await settle();
  const who = core.authenticate(db.prepare('SELECT token FROM agents WHERE id = ?').get(id).token, 'ADMIN');
  await core.call('usage.report', { vendor: 'claude', payload: CLAUDE }, who);
  await core.call('usage.report', { vendor: 'claude', payload: CLAUDE }, who);
  const due = (await core.call('wait', { delegator: dc, timeout: 0 })).events.filter(e => e.kind === 'handoff-due');
  assert.equal(due.length, 1);
  assert.match(due[0].text, /5h window at 92%.*hauptling handoff/);
  assert.equal((await core.call('wait', { delegator: dx, timeout: 0 })).events.filter(e => e.kind === 'handoff-due').length, 0);
});

test('host usage: the delegator\'s own CLI drives handoff-due; once it reports, slot readings no longer do', async () => {
  const { db, core } = setup();
  const { id: d } = await core.call('delegator.start', { repo: 'gitgiant/demo', cli: 'claude' });
  const low = structuredClone(CLAUDE);
  low.rate_limits.five_hour.used_percentage = 20;
  await core.call('usage.host', { vendor: 'claude', payload: low });
  const { id } = await core.call('spawn', { delegator: d, brief: 'task', vendor: 'claude', mode: 'cheapest' });
  await settle();
  const who = core.authenticate(db.prepare('SELECT token FROM agents WHERE id = ?').get(id).token, 'ADMIN');
  await core.call('usage.report', { vendor: 'claude', payload: CLAUDE }, who);
  const kinds = async () => (await core.call('wait', { delegator: d, timeout: 0 })).events.filter(e => e.kind === 'handoff-due');
  assert.equal((await kinds()).length, 0, 'the slot account at 92% is not the delegator\'s');
  await core.call('usage.host', { vendor: 'claude', payload: CLAUDE });
  assert.equal((await kinds()).length, 1);
  await assert.rejects(core.call('usage.host', { vendor: 'claude', payload: CLAUDE }, who), /not allowed for workers/);
});

test('host status lines: installed idempotently; the previous command is chained with the same stdin', async () => {
  const { installStatusLines, chained } = await import('../src/hoststatus.mjs');
  const { mkdtempSync, mkdirSync, writeFileSync, readFileSync } = await import('node:fs');
  const h = mkdtempSync(join(tmpdir(), 'hl-home-'));
  process.env.HAUPTLING_HOME = join(h, '.hauptling');
  mkdirSync(join(h, '.claude'));
  writeFileSync(join(h, '.claude', 'settings.json'), JSON.stringify({ model: 'x', statusLine: { type: 'command', command: 'cat' } }));
  installStatusLines(h);
  installStatusLines(h);
  const s = JSON.parse(readFileSync(join(h, '.claude', 'settings.json'), 'utf8'));
  assert.equal(s.statusLine.command, 'hauptling usage claude --host');
  assert.equal(s.model, 'x');
  assert.equal(chained('claude', 'hello'), 'hello', 'the user\'s own line still shows');
  assert.equal(chained('agy', '{}'), null, 'agy not installed on this host: nothing chained');
  process.env.HAUPTLING_HOME = HOME;
});

const row = (db, id) => ({ ...db.prepare('SELECT * FROM agents WHERE id = ?').get(id) });
const usageOf = (db, id) => JSON.parse(row(db, id).usage);
async function send(core, db, id, { cost, tokens = [1000, 100], session = 's1' }) {
  const who = core.authenticate(row(db, id).token, 'ADMIN');
  return core.call('usage.report', { vendor: 'claude', payload: { session_id: session, model: CLAUDE.model, cost: { total_cost_usd: cost },
    context_window: { total_input_tokens: tokens[0], total_output_tokens: tokens[1] } } }, who);
}
async function spawnOne(core, vendor = 'claude') {
  const r = await core.call('spawn', { brief: 'task', vendor, mode: 'cheapest' });
  await settle();
  return r;
}
const KEY = 'sk-ant-api03-test-0000000000';
const SCREEN = '> continue\n  ⎿  Credit balance too low · Add funds: https://platform.claude.com/settings/billing\n\n> ';

test('usage accumulates across CLI sessions: a lower cost or a new session id folds the finished one in', async () => {
  const { db, core } = setup({ key: KEY });
  await core.call('delegator.start', { repo: 'gitgiant/demo' });
  const { id } = await spawnOne(core);
  await send(core, db, id, { cost: 5, tokens: [150000, 900] });
  await send(core, db, id, { cost: 6, tokens: [40000, 200] }); // compaction: the context shrinks, same session
  assert.deepEqual([usageOf(db, id).cost_usd, usageOf(db, id).tokens_in], [6, 40000]);
  const r = await send(core, db, id, { cost: 0.5, tokens: [2000, 50] }); // lower cost: a new session
  assert.match(r.text, /\$6\.50/);
  await send(core, db, id, { cost: 1, tokens: [3000, 60] });
  assert.deepEqual([usageOf(db, id).cost_usd, usageOf(db, id).tokens_in, usageOf(db, id).tokens_out], [7, 43000, 260]);
  await send(core, db, id, { cost: 2, tokens: [10, 1], session: 's2' }); // new id, though the cost is higher
  assert.equal(usageOf(db, id).cost_usd, 9);
  assert.equal(core.budgetState('claude'), null);
  assert.equal(core.spend(row(db, id)).includes('$9.00'), true);
});

test('usage accumulate: rows from before sessions were tracked, and Codex token totals going down', () => {
  const legacy = { tokens_in: 100, tokens_out: 10, cost_usd: 3, cost_estimated: false };
  const u = accumulate(legacy, { tokens_in: 5, tokens_out: 1, cost_usd: 0.2, cost_estimated: false }, { vendor: 'claude', sessionId: 'x', reported: 0.2 });
  assert.deepEqual([u.cost_usd, u.tokens_in], [3.2, 105]);
  const a = accumulate(null, { tokens_in: 1000, tokens_out: 100, cost_usd: 1, cost_estimated: true }, { vendor: 'codex' });
  const b = accumulate(a, { tokens_in: 200, tokens_out: 20, cost_usd: 0.2, cost_estimated: true }, { vendor: 'codex' });
  assert.deepEqual([b.cost_usd, b.tokens_in, b.tokens_out, b.cost_estimated], [1.2, 1200, 120, true]);
  const c = accumulate(b, { tokens_in: null, tokens_out: null, cost_usd: null, cost_estimated: true }, { vendor: 'codex' });
  assert.deepEqual([c.cost_usd, c.tokens_in], [1.2, 1200], 'a reading without totals keeps them');
});

test('an api agent reporting cost 0 with tokens gets an estimate; a plan agent keeps the reported 0', async () => {
  for (const [key, estimated] of [[KEY, true], [null, false]]) {
    const { db, core } = setup({ key });
    await core.call('delegator.start', { repo: 'gitgiant/demo' });
    const { id } = await spawnOne(core);
    await send(core, db, id, { cost: 0, tokens: [156000, 280] });
    const u = usageOf(db, id);
    assert.equal(u.cost_estimated, estimated);
    assert.equal(u.cost_usd > 0, estimated);
    if (!estimated) continue;
    await send(core, db, id, { cost: 0, tokens: [1000, 10] });
    assert.equal(usageOf(db, id).cost_usd, u.cost_usd, 'the estimate does not go down within a session');
    await send(core, db, id, { cost: 0, tokens: [156000, 280], session: 's2' });
    assert.equal(usageOf(db, id).cost_usd, Math.round(u.cost_usd * 2 * 1e4) / 1e4);
  }
});

test('out-of-credit patterns: the vendor error line, not text that quotes it', () => {
  assert.ok(outOfCredit('claude', SCREEN));
  assert.ok(outOfCredit('codex', '■ Quota exceeded. Check your plan and billing details.'));
  assert.ok(!outOfCredit('claude', '  12 - A screen with "Credit balance too low" blocks the agent'));
  assert.ok(!outOfCredit('agy', SCREEN));
});

test('out of credit with a budget: blocked, one event and notification, then the plan until set again', async () => {
  const { db, core, host, toasts } = setup({ realKeys: true });
  keyStore.setKey('claude', KEY);
  keyStore.setBudget('claude', 100);
  await core.call('delegator.start', { repo: 'gitgiant/demo', max: 9 });
  await settle();
  const a = await spawnOne(core);
  assert.equal(a.billing, 'api');
  host.tmuxCapture = async () => SCREEN;
  await core.watch();
  assert.equal(row(db, a.id).state, 'blocked');
  assert.equal(db.prepare('SELECT text FROM status WHERE identity = ?').get(a.id).text, 'blocked: API credit ran out');
  db.prepare("UPDATE agents SET state = 'working' WHERE id = ?").run(a.id); // activity, then the same error again
  await core.watch();
  assert.equal(row(db, a.id).state, 'blocked');
  const events = (await core.call('wait', { timeout: 0 })).events.filter(e => e.kind === 'api-exhausted');
  assert.equal(events.length, 1);
  assert.match(events[0].text, /kill it.*respawn.*working tree/s);
  assert.equal(toasts.length, 1);
  assert.equal(core.keyOut('claude').until, keyStore.periodEnd(1));
  assert.equal((await spawnOne(core)).billing, 'plan');
  assert.equal(keyStore.getExhausted('claude', new Date(Date.parse(keyStore.periodEnd(1)) + 1)), null, 'the period reset clears it');
  keyStore.setKey('claude', KEY);
  assert.equal(core.keyOut('claude'), null);
  db.prepare("UPDATE agents SET state = 'working' WHERE id = ?").run(a.id);
  await core.watch();
  assert.equal(row(db, a.id).state, 'working', 'old text on the screen after the reset');
  assert.equal((await spawnOne(core)).billing, 'api');
});

test('out of credit without a budget: spawns refused and queued ones wait until key set or key budget', async () => {
  const { db, core, host, toasts } = setup({ realKeys: true });
  keyStore.setKey('claude', KEY);
  await core.call('delegator.start', { repo: 'gitgiant/demo', max: 1 });
  const a = await spawnOne(core);
  const queued = await spawnOne(core);
  host.tmuxCapture = async () => SCREEN;
  await core.watch();
  assert.equal(toasts.length, 1);
  await assert.rejects(spawnOne(core), /API credit ran out.*hauptling key set claude/);
  const other = await core.call('spawn', { brief: 'rr', mode: 'cheapest' });
  assert.notEqual(other.vendor, 'claude', 'round robin skips the refused vendor');
  await core.call('kill', { agent: other.id }); // it waits on the limit of 1; out of the way
  host.tmuxCapture = async () => '';
  await core.call('kill', { agent: a.id });
  await settle();
  assert.equal(row(db, queued.id).state, 'queued');
  keyStore.setKey('claude', KEY);
  await core.poll();
  await settle();
  assert.equal(row(db, queued.id).state, 'working');
  for (const clear of [() => keyStore.setBudget('claude', 50), () => keyStore.setBudget('claude', 'off'), () => keyStore.removeKey('claude')]) {
    keyStore.markExhausted('claude');
    clear();
    assert.equal(keyStore.getExhausted('claude'), null);
  }
});

test('a worker started before the current key was set does not mark that key', async () => {
  const { db, core, host, toasts } = setup({ realKeys: true });
  keyStore.setKey('claude', KEY);
  await core.call('delegator.start', { repo: 'gitgiant/demo' });
  const a = await spawnOne(core);
  keyStore.setKey('claude', KEY);
  host.tmuxCapture = async () => SCREEN;
  await core.watch();
  assert.equal(row(db, a.id).state, 'blocked');
  assert.equal(core.keyOut('claude'), null);
  assert.equal(toasts.length, 0);
});
