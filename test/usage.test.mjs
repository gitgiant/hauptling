import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDb } from '../src/db.mjs';
import { createCore } from '../src/core.mjs';
import { loadModels } from '../src/models.mjs';
import { lastTokenCount, normalizeUsage, scrub, statusText } from '../src/usage.mjs';

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
  assert.deepEqual(u.limits, [{ window: '5h', used_pct: 75, resets_at: '2026-11-24T20:00:00Z' }, { window: 'week', used_pct: 40, resets_at: '2026-11-30T00:00:00Z' }]);
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

function setup() {
  const db = openDb(':memory:');
  const toasts = [];
  const host = {
    calls: [], async run() { return { stdout: 'abc\n' }; }, workRoot: '/w', async startWorker() {}, async tmuxType() {}, async stopWorker() {},
    async tmuxAlive() { return true; }, async tmuxCapture() { return ''; }, attachArgv: () => [], async hostGit() { return 'main'; },
    codex: null, async codexUsage() { return this.codex; },
  };
  const gh = { gitAuthEnv: async () => ({}), prFind: async () => null, prCreate: async () => ({}), requiredChecks: async () => [], prAutoMerge: async () => {}, prMerge: async () => {}, prView: async () => ({ state: 'OPEN', statusCheckRollup: [] }) };
  const core = createCore({ db, host, github: gh, notify: t => toasts.push(t), models: () => loadModels(join(tmpdir(), 'none.json')), workerUrl: 'http://w', publicUrl: 'http://127.0.0.1:47800', runnerToken: 'RUN' });
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
