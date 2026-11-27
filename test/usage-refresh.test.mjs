import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDb } from '../src/db.mjs';
import { createCore } from '../src/core.mjs';
import * as keyStore from '../src/keys.mjs';
import { createDashboard, dashToken } from '../src/dashboard.mjs';
import { loadModels } from '../src/models.mjs';
import { claudeReset, parseProbe, shortError } from '../src/usage-refresh.mjs';
import { codexRateLimits } from '../src/docker.mjs';

const NOW = Date.parse('2026-11-27T08:00:00Z');
// Shapes: claude 2.1.332 (seen), codex 0.172.0 app-server bindings, agy 1.5.16 struct tags.
const CLAUDE = JSON.stringify({ is_error: false, num_turns: 0, result: 'You are currently using your subscription to power your Claude Code usage\n\nCurrent session: 35% used · resets Nov 27, 10:40am (UTC)\nCurrent week (all models): 91% used · resets Nov 28, 3am (UTC)\nCurrent week (Fable): 3% used · resets Nov 28, 3am (UTC)' });
const CODEX = { rateLimits: { primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 1795776000 }, secondary: { usedPercent: 40, windowDurationMins: 10080, resetsAt: null } } };
const AGY = JSON.stringify({ quota: { groups: [
  { name: 'Gemini', buckets: [{ id: 'gemini-5h', window: '5h', remaining_fraction: 0.75, reset_time: '2026-11-27T11:00:00Z' }, { id: 'gemini-weekly', window: 'weekly', remaining_fraction: 0.5 }] },
  { name: 'Other', buckets: [{ id: '3p-5h', window: '5h', remaining_fraction: 0.4, reset_time: '2026-11-27T12:00:00Z' }, { id: 'off-5h', disabled: true, remaining_fraction: 0 }] },
] } });
const OUTPUT = { claude: CLAUDE, codex: CODEX, agy: AGY };

test('probe parsers: each vendor answer → 5h and week windows', () => {
  assert.deepEqual(parseProbe('claude', CLAUDE, NOW), [{ window: '5h', used_pct: 35, resets_at: '2026-11-27T10:40:00.000Z' }, { window: 'week', used_pct: 91, resets_at: '2026-11-28T03:00:00.000Z' }]);
  assert.deepEqual(parseProbe('codex', CODEX).map(l => [l.window, l.used_pct]), [['5h', 12], ['week', 40]]);
  assert.deepEqual(parseProbe('agy', AGY), [{ window: '5h', used_pct: 60, resets_at: '2026-11-27T12:00:00Z' }, { window: 'week', used_pct: 50, resets_at: null }]);
  assert.equal(claudeReset('3:05pm (UTC)', NOW), '2026-11-27T15:05:00.000Z');
  assert.equal(claudeReset('1am (UTC)', NOW), '2026-11-28T01:00:00.000Z');
  assert.equal(claudeReset('Jan 2, 3am (UTC)', Date.parse('2026-12-30T00:00:00Z')), '2027-01-02T03:00:00.000Z');
  assert.equal(claudeReset('Nov 28, 3am (Europe/Berlin)', NOW), null);
  assert.throws(() => parseProbe('claude', JSON.stringify({ result: 'You are using an API key' })), /no plan usage/);
  assert.throws(() => parseProbe('claude', JSON.stringify({ num_turns: 1, result: '' })), /model turn/);
  assert.throws(() => parseProbe('agy', '{"status":"ERROR","error":"authentication failed"}'), /authentication failed/);
  assert.equal(shortError('visit https://accounts.example/o?x=1\nnow'), 'visit <url> now');
});

test('codex app-server exchange: initialize, then rate limits; errors surface', async () => {
  const server = (reply) => [process.execPath, '-e', `require('readline').createInterface({input:process.stdin}).on('line',l=>{const m=JSON.parse(l);if(m.id===1)console.log('{"id":1,"result":{}}');if(m.id===2)console.log(JSON.stringify({id:2,...${JSON.stringify(reply)}}))})`];
  assert.deepEqual(await codexRateLimits(server({ result: CODEX }), { timeoutMs: 10e3 }), CODEX);
  await assert.rejects(codexRateLimits(server({ error: { message: 'authentication required' } }), { timeoutMs: 10e3 }), /authentication required/);
  await assert.rejects(codexRateLimits([process.execPath, '-e', ''], { timeoutMs: 10e3 }), /without an answer/);
});

async function setup({ probe = async (_s, v) => OUTPUT[v], signingIn = async () => false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'hl-refresh-'));
  const dbPath = join(dir, 'hauptling.db');
  const db = openDb(dbPath);
  const probes = [];
  const host = {
    workRoot: '/hl/work', async run() { return { stdout: '' }; }, async startWorker() {}, async stopWorker() {}, async tmuxType() {}, async hostGit() { return 'main'; },
    signedIn: async (slots) => slots,
    signingIn,
    usageProbe: (slot, vendor, o) => { probes.push(`${slot}:${vendor}`); return probe(slot, vendor, o); },
  };
  const core = createCore({ db, host, github: { gitAuthEnv: async () => ({}) }, keys: { ...keyStore, getKey: () => null, getBudget: () => null }, notify: () => true, models: () => loadModels(join(tmpdir(), 'none.json')), workerUrl: 'http://w', publicUrl: 'http://127.0.0.1:47800' });
  const dash = createDashboard({ db, dbPath, core, host });
  const { delegator } = await core.call('delegator.start', { repo: 'gitgiant/demo' });
  const readings = () => db.prepare('SELECT slot, vendor, window, used_pct FROM slot_usage ORDER BY vendor, window').all().map(r => `${r.slot} ${r.vendor} ${r.window} ${r.used_pct}`);
  return { db, core, dash, probes, delegator, readings, done: () => { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}
const byVendor = (r) => Object.fromEntries(r.vendors.map(v => [v.vendor, v]));
const tick = () => new Promise(r => setTimeout(r, 20));

test('refresh records readings per vendor, warns at 90%, and is rate limited', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const s = await setup();
  const r = byVendor(await s.core.call('usage.refresh'));
  assert.deepEqual(Object.values(r).map(v => v.status), ['ok', 'ok', 'ok']);
  assert.deepEqual(s.readings(), ['hl-w1 agy 5h 60', 'hl-w1 agy week 50', 'hl-w1 claude 5h 35', 'hl-w1 claude week 91', 'hl-w1 codex 5h 12', 'hl-w1 codex week 40']);
  const warned = s.db.prepare("SELECT text FROM events WHERE kind = 'usage-high'").all();
  assert.equal(warned.length, 1);
  assert.match(warned[0].text, /^claude week window at 91%/);
  await assert.rejects(s.core.call('usage.refresh'), /try again in 30 s/);
  assert.equal(s.probes.length, 3);
  t.mock.timers.setTime(NOW + 31e3);
  await s.core.call('usage.refresh');
  assert.equal(s.probes.length, 6);
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM events WHERE kind = 'usage-high'").get().n, 1);
  s.done();
});

test('a failing or hanging vendor does not block the others; a hanging one keeps its slot held', async () => {
  const s = await setup({ probe: (_s, v) => (v === 'claude' ? Promise.reject(new Error('boom')) : v === 'agy' ? new Promise(() => {}) : Promise.resolve(CODEX)) });
  const r = byVendor(await s.core.refreshAllUsage({ timeoutMs: 50 }));
  assert.deepEqual([r.claude.status, r.claude.note, r.codex.status, r.agy.status], ['failed', 'boom', 'ok', 'failed']);
  assert.match(r.agy.note, /timed out/);
  assert.deepEqual(s.readings(), ['hl-w1 codex 5h 12', 'hl-w1 codex week 40']);
  assert.ok(!s.core.freeSlots('agy').includes('hl-w1'), 'the CLI has not ended: no worker may take its sign-in');
  assert.ok(s.core.freeSlots('claude').includes('hl-w1'));
  assert.equal(s.core.lastRefresh('claude').note, 'boom');
  s.done();
});

test('no refresh on a slot × vendor with a live worker or a sign-in; the next free slot is asked', async () => {
  const s = await setup({ signingIn: async (slot, v) => v === 'codex' && slot === 'hl-w1' });
  const { id } = await s.core.call('spawn', { brief: 'task', vendor: 'claude', mode: 'cheapest' });
  await tick();
  assert.equal(s.db.prepare('SELECT slot FROM agents WHERE id = ?').get(id).slot, 'hl-w1');
  await s.core.call('signin.begin', { slot: 'hl-w1', vendor: 'agy' });
  await s.core.call('usage.refresh');
  assert.deepEqual(s.probes.sort(), ['hl-w2:agy', 'hl-w2:claude', 'hl-w2:codex']);
  s.done();
});

test('every slot busy: skipped, nothing run; spawns and sign-ins wait while a refresh holds a slot', async () => {
  let finish;
  const s = await setup({ probe: (_s, v) => (v === 'claude' ? new Promise(r => { finish = () => r(CLAUDE); }) : Promise.resolve(OUTPUT[v])) });
  s.db.prepare("INSERT OR REPLACE INTO kv (key, value) VALUES ('slots', ?)").run(JSON.stringify(['hl-w1']));
  await s.core.call('signin.begin', { slot: 'hl-w1', vendor: 'agy' });
  const running = s.core.call('usage.refresh');
  await tick();
  await assert.rejects(s.core.call('signin.begin', { slot: 'hl-w1', vendor: 'claude' }), /being refreshed/);
  await assert.rejects(s.dash.terms.startLogin('hl-w1', 'claude'), /being refreshed/);
  const { id } = await s.core.call('spawn', { brief: 'task', vendor: 'claude', mode: 'cheapest' });
  assert.equal(s.db.prepare('SELECT state FROM agents WHERE id = ?').get(id).state, 'queued');
  finish();
  const r = byVendor(await running);
  assert.equal(r.agy.status, 'skipped');
  assert.match(r.agy.note, /refreshes while a worker runs.*signing in/);
  assert.ok(!s.probes.includes('hl-w1:agy'));
  await tick();
  assert.notEqual(s.db.prepare('SELECT state FROM agents WHERE id = ?').get(id).state, 'queued', 'started once the refresh let go');
  s.done();
});

test('POST /dash/usage/refresh: cookie and X-Hauptling required; 429 when repeated', async () => {
  const s = await setup();
  const tok = dashToken(s.db);
  async function post({ cookie = `hl_dash=${tok}`, headers = { 'x-hauptling': '1' }, addr = '127.0.0.1' } = {}) {
    const req = { method: 'POST', headers: { host: '127.0.0.1:47800', ...(cookie ? { cookie } : {}), ...headers }, socket: { localAddress: addr }, on() {}, async *[Symbol.asyncIterator]() {} };
    const res = { code: 0, body: '', writeHead(c) { this.code = c; }, end(b) { this.body += b ?? ''; }, write(b) { this.body += b; } };
    await s.dash.handle(req, res, new URL('http://x/dash/usage/refresh'));
    return res;
  }
  assert.equal((await post({ cookie: null })).code, 401);
  assert.equal((await post({ headers: {} })).code, 403);
  assert.equal((await post({ addr: '172.17.0.1' })).code, 403);
  assert.equal(s.probes.length, 0);
  const ok = await post();
  assert.equal(ok.code, 200);
  assert.equal(JSON.parse(ok.body).vendors.length, 3);
  assert.equal((await post()).code, 429);
  await assert.rejects(s.core.call('usage.refresh', {}, { role: 'agent', agent: 'x' }), /not allowed for workers/);
  s.done();
});
