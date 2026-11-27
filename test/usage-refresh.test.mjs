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
import { noReset, normalizeUsage } from '../src/usage.mjs';
import { codexRateLimits } from '../src/docker.mjs';

const NOW = Date.parse('2026-11-27T08:00:00Z');
// Shapes: claude 2.1.332 (seen), codex 0.172.0 app-server bindings, agy 1.5.16 struct tags.
const CLAUDE = JSON.stringify({ is_error: false, num_turns: 0, result: 'You are currently using your subscription to power your Claude Code usage\n\nCurrent session: 35% used · resets Nov 27, 10:40am (UTC)\nCurrent week (all models): 91% used · resets Nov 28, 3am (UTC)\nCurrent week (Fable): 3% used · resets Nov 28, 3am (UTC)' });
const CODEX = { rateLimits: { primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 1795776000 }, secondary: { usedPercent: 40, windowDurationMins: 10080, resetsAt: null } } };
const AGY = JSON.stringify({ quota: { groups: [
  { name: 'Gemini', buckets: [{ id: 'gemini-5h', window: '5h', remaining_fraction: 0.75, reset_time: '2026-11-27T11:00:00Z' }, { id: 'gemini-weekly', window: 'weekly', remaining_fraction: 0.5 }] },
  { name: 'Other', buckets: [{ id: '3p-5h', window: '5h', remaining_fraction: 0.4, reset_time: '2026-11-27T12:00:00Z' }, { id: 'off-5h', disabled: true, remaining_fraction: 0 }] },
] } });
// agy 1.5.16, `agy --output-format json --print /usage` (seen 2026-11-27; descriptions cut).
const AGY_REAL = JSON.stringify({ conversation_id: '', status: 'SUCCESS', response: 'Gemini Models\tWeekly Limit Remaining\t51%\n', num_turns: 0, command: { name: 'usage', data: { groups: [
  { name: 'Gemini Models', buckets: [{ id: 'gemini-weekly', name: 'Weekly Limit Remaining', window: 'weekly', remaining_fraction: 0.5134958624839783, reset_time: '2026-12-03T07:45:43Z' },
    { id: 'gemini-5h', name: 'Five Hour Limit Remaining', window: '5h', remaining_fraction: 0.8666097521781921, reset_time: '2026-11-28T00:32:53Z' }] },
  { name: 'Claude and GPT models', buckets: [{ id: '3p-weekly', name: 'Weekly Limit Remaining', window: 'weekly', remaining_fraction: 1, reset_time: '1970-01-01T00:00:00Z' },
    { id: '3p-5h', name: 'Five Hour Limit Remaining', window: '5h', remaining_fraction: 1, reset_time: '1970-01-01T00:00:00Z' }] }] } } });
const OUTPUT = { claude: CLAUDE, codex: CODEX, agy: AGY };

test('probe parsers: each vendor answer → 5h and week windows', () => {
  assert.deepEqual(parseProbe('claude', CLAUDE, NOW), [{ window: '5h', used_pct: 35, resets_at: '2026-11-27T10:40:00.000Z' }, { window: 'week', used_pct: 91, resets_at: '2026-11-28T03:00:00.000Z' }]);
  assert.deepEqual(parseProbe('codex', CODEX).map(l => [l.window, l.used_pct]), [['5h', 12], ['week', 40]]);
  assert.deepEqual(parseProbe('agy', AGY), [{ window: '5h', used_pct: 25, resets_at: '2026-11-27T11:00:00Z' }, { window: 'week', used_pct: 50, resets_at: null }, { window: '3p-5h', used_pct: 60, resets_at: '2026-11-27T12:00:00Z' }]);
  assert.deepEqual(parseProbe('agy', AGY_REAL), [{ window: 'week', used_pct: 48.7, resets_at: '2026-12-03T07:45:43Z' }, { window: '5h', used_pct: 13.3, resets_at: '2026-11-28T00:32:53Z' },
    { window: '3p-week', used_pct: 0, resets_at: null }, { window: '3p-5h', used_pct: 0, resets_at: null }], 'Gemini and Claude/GPT are separate windows');
  assert.equal(claudeReset('3:05pm (UTC)', NOW), '2026-11-27T15:05:00.000Z');
  assert.equal(claudeReset('1am (UTC)', NOW), '2026-11-28T01:00:00.000Z');
  assert.equal(claudeReset('Jan 2, 3am (UTC)', Date.parse('2026-12-30T00:00:00Z')), '2027-01-02T03:00:00.000Z');
  assert.equal(claudeReset('Nov 28, 3am (Europe/Berlin)', NOW), null);
  assert.throws(() => parseProbe('claude', JSON.stringify({ result: 'You are using an API key' })), /no plan usage/);
  assert.throws(() => parseProbe('claude', JSON.stringify({ num_turns: 1, result: '' })), /model turn/);
  assert.throws(() => parseProbe('agy', '{"status":"ERROR","error":"authentication failed"}'), /authentication failed/);
  assert.equal(shortError('visit https://accounts.example/o?x=1\nnow'), 'visit <url> now');
});

test('agy: an unset reset time (empty, missing, 0, the epoch) is null, never 1969', () => {
  const unset = ['', undefined, 0, '0', '1970-01-01T00:00:00Z', '0001-01-01T00:00:00Z'];
  for (const reset_time of unset) {
    const out = JSON.stringify({ quota: { groups: [{ name: 'Gemini', buckets: [{ id: 'gemini-5h', window: '5h', remaining_fraction: 1, reset_time, reset_in_seconds: 0 }] }] } });
    assert.deepEqual(parseProbe('agy', out), [{ window: '5h', used_pct: 0, resets_at: null }], String(reset_time));
    assert.equal(normalizeUsage('agy', { quota: { 'gemini-5h': { remaining_fraction: 1, reset_time } } }).limits[0].resets_at, null, String(reset_time));
  }
  const relative = JSON.stringify({ quota: [{ window: '5h', remaining_fraction: 0.5, reset_time: '', reset_in_seconds: 60 }] });
  assert.ok(Date.parse(parseProbe('agy', relative)[0].resets_at) > Date.now());
  assert.deepEqual([noReset(0), noReset(12)], ['not started', 'no reset time']);
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
  const probes = [], signedOut = [];
  const host = {
    workRoot: '/hl/work', async run() { return { stdout: '' }; }, async startWorker() {}, async stopWorker() {}, async tmuxType() {}, async hostGit() { return 'main'; },
    signedIn: async (slots) => slots,
    signingIn,
    signOut: (slot, vendor) => { signedOut.push(`${slot}:${vendor}`); return true; },
    usageProbe: (slot, vendor, o) => { probes.push(`${slot}:${vendor}`); return probe(slot, vendor, o); },
  };
  const core = createCore({ db, host, github: { gitAuthEnv: async () => ({}) }, keys: { ...keyStore, getKey: () => null, getBudget: () => null }, notify: () => true, models: () => loadModels(join(tmpdir(), 'none.json')), workerUrl: 'http://w', publicUrl: 'http://127.0.0.1:47800' });
  const dash = createDashboard({ db, dbPath, core, host });
  const { delegator } = await core.call('delegator.start', { repo: 'gitgiant/demo' });
  const readings = () => db.prepare('SELECT slot, vendor, window, used_pct FROM slot_usage ORDER BY vendor, window').all().map(r => `${r.slot} ${r.vendor} ${r.window} ${r.used_pct}`);
  return { db, core, dash, probes, signedOut, delegator, readings, done: () => { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}
const byVendor = (r) => Object.fromEntries(r.vendors.map(v => [v.vendor, v]));
const tick = () => new Promise(r => setTimeout(r, 20));

test('refresh records readings per vendor, warns at 90%, and is rate limited', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const s = await setup();
  const r = byVendor(await s.core.call('usage.refresh'));
  assert.deepEqual(Object.values(r).map(v => v.status), ['ok', 'ok', 'ok']);
  assert.deepEqual(s.readings(), ['hl-w1 agy 3p-5h 60', 'hl-w1 agy 5h 25', 'hl-w1 agy week 50', 'hl-w1 claude 5h 35', 'hl-w1 claude week 91', 'hl-w1 codex 5h 12', 'hl-w1 codex week 40']);
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

test('sign out: removes the sign-in of a slot and its readings; refused while a refresh or sign-in uses it', async () => {
  const s = await setup({ signingIn: async (slot) => slot === 'hl-w3' });
  await s.core.call('usage.refresh');
  assert.ok(s.readings().some(r => r.startsWith('hl-w1 agy')));
  assert.deepEqual(await s.core.call('signin.out', { slot: 'hl-w1', vendor: 'agy' }), { slot: 'hl-w1', vendor: 'agy', was_signed_in: true });
  assert.deepEqual(s.signedOut, ['hl-w1:agy']);
  assert.ok(!s.readings().some(r => r.startsWith('hl-w1 agy')), 'the old account\'s windows are gone');
  assert.ok(s.readings().some(r => r.startsWith('hl-w1 claude')), 'other vendors keep theirs');
  await assert.rejects(s.core.call('signin.out', { slot: 'hl-w3', vendor: 'agy' }), /signing in/);
  await assert.rejects(s.core.call('signin.out', { slot: 'hl-w9', vendor: 'agy' }), /slot .* and a vendor/);
  await s.core.call('signin.begin', { slot: 'hl-w2', vendor: 'agy' });
  await assert.rejects(s.core.call('signin.out', { slot: 'hl-w2', vendor: 'agy' }), /signing in/);
  assert.deepEqual(s.signedOut, ['hl-w1:agy']);
  s.done();
});

test('signOutSlot removes only the credential file; dashboard sign-in builds the slot paths', async () => {
  const { signOutSlot, CREDS } = await import('../src/docker.mjs');
  const { createTerminals } = await import('../src/terminal.mjs');
  const { mkdirSync, writeFileSync, existsSync, lstatSync } = await import('node:fs');
  const dir = mkdtempSync(join(tmpdir(), 'hl-signout-'));
  mkdirSync(join(dir, 'gemini/antigravity-cli'), { recursive: true });
  writeFileSync(join(dir, CREDS.agy), 'token');
  writeFileSync(join(dir, 'gemini/antigravity-cli/settings.json'), '{}');
  assert.equal(signOutSlot('hl-w1', 'agy', dir), true);
  assert.equal(signOutSlot('hl-w1', 'agy', dir), false);
  assert.ok(!existsSync(join(dir, CREDS.agy)) && existsSync(join(dir, 'gemini/antigravity-cli/settings.json')));
  const db = openDb(':memory:');
  const ran = [];
  const terms = createTerminals({ db, host: {}, slotDir: () => dir, loginTmux: async (args) => { ran.push(args); return ''; } });
  assert.deepEqual(await terms.startLogin('hl-w1', 'agy'), { sid: 'login-hl-w1-agy' });
  assert.ok(lstatSync(join(dir, 'agy-home/.gemini')).isSymbolicLink());
  assert.match(ran.find(a => a[0] === 'new-session').at(-1), new RegExp(`HOME=${join(dir, 'agy-home')}.* 'agy'$`));
  await terms.startLogin('hl-w1', 'claude');
  assert.match(ran.filter(a => a[0] === 'new-session')[1].at(-1), new RegExp(`CLAUDE_CONFIG_DIR=${join(dir, 'claude')}`));
  db.close();
  rmSync(dir, { recursive: true, force: true });
});
