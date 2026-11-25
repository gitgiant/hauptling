import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDb } from '../src/db.mjs';
import { createCore } from '../src/core.mjs';
import * as keyStore from '../src/keys.mjs';
import { createDashboard, dashToken, headline, stripAnsi } from '../src/dashboard.mjs';
import { loadModels } from '../src/models.mjs';

function fakeHost() {
  return {
    calls: [],
    async run(_slot, argv) {
      this.calls.push(argv);
      if (argv.includes('merge-base')) return { stdout: 'abc123\n' };
      if (argv.includes('--stat=120')) return { stdout: ' a.js | 2 +-\n' };
      if (argv.includes('--no-color')) return { stdout: 'diff --git a/a.js b/a.js\n@@ -1 +1 @@\n-old\n+new\n' };
      return { stdout: '' };
    },
    workRoot: '/hl/work',
    async startWorker() {}, async tmuxType() {}, async stopWorker() {}, async tmuxAlive() { return true; },
    async tmuxCapture() { return '\x1b[1mhello\x1b[0m world\n'; },
    attachArgv: () => [], async hostGit() { return 'main'; },
  };
}
const gh = { gitAuthEnv: async () => ({}), prFind: async () => null, prCreate: async () => ({ url: 'u', number: 1 }), requiredChecks: async () => [], prAutoMerge: async () => {}, prMerge: async () => {}, prView: async () => ({ state: 'OPEN', statusCheckRollup: [] }) };

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'hl-dash-'));
  const dbPath = join(dir, 'hauptling.db');
  const db = openDb(dbPath);
  const host = fakeHost();
  const core = createCore({ db, host, github: gh, keys: { ...keyStore, getKey: () => null, getBudget: () => null }, notify: () => true, models: () => loadModels(join(tmpdir(), 'none.json')), workerUrl: 'http://w', publicUrl: 'http://127.0.0.1:47800', runnerToken: 'RUN' });
  const dash = createDashboard({ db, dbPath, core, host });
  await core.call('delegator.start', { repo: 'gitgiant/demo' });
  const { id } = await core.call('spawn', { brief: 'task brief', vendor: 'claude', mode: 'cheapest' });
  await new Promise(r => setTimeout(r, 20));
  const tok = dashToken(db);
  /** Fake request through the handler. */
  async function req(path, { method = 'GET', cookie = `hl_dash=${tok}`, headers = {}, body, addr = '127.0.0.1' } = {}) {
    const chunks = body ? [JSON.stringify(body)] : [];
    const r = { method, url: path, headers: { host: '127.0.0.1:47800', ...(cookie ? { cookie } : {}), ...headers }, socket: { localAddress: addr }, on() {}, async *[Symbol.asyncIterator]() { yield* chunks; } };
    const res = { code: 0, headers: {}, body: '', writeHead(c, h) { this.code = c; this.headers = h || {}; }, end(b) { this.body += b ?? ''; }, write(b) { this.body += b; } };
    const handled = await dash.handle(r, res, new URL(path, 'http://x'));
    let json = null;
    try { json = JSON.parse(res.body); } catch {}
    return { handled, ...res, json };
  }
  return { db, core, dash, host, id, tok, req, done: () => { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('dashboard auth: token → cookie, no cookie → 401, docker0 → 403, other paths untouched', async () => {
  const s = await setup();
  assert.equal((await s.req('/api/agents')).handled, false);
  assert.equal((await s.req('/', { cookie: null })).code, 401);
  assert.equal((await s.req('/dash/board', { cookie: null })).code, 401);
  assert.equal((await s.req(`/?k=wrong`, { cookie: null })).code, 401);
  const signIn = await s.req(`/?k=${s.tok}`, { cookie: null });
  assert.equal(signIn.code, 302);
  assert.match(signIn.headers['set-cookie'], /^hl_dash=.+; HttpOnly; SameSite=Strict; Path=\//);
  const page = await s.req('/');
  assert.equal(page.code, 200);
  assert.match(page.body, /<title>Hauptling<\/title>/);
  assert.equal((await s.req('/web/app.js')).code, 200);
  assert.equal((await s.req('/web/../../src/core.mjs')).handled, false, 'URL parsing resolves dot segments: not a dashboard path');
  assert.equal((await s.req('/web/..%2f..%2fsrc%2fcore.mjs')).code, 404, 'encoded slashes stay literal: no path escape');
  assert.equal((await s.req('/dash/board', { addr: '172.17.0.1' })).code, 403, 'containers reach the broker on docker0');
  const rotated = dashToken(s.db, { rotate: true });
  assert.notEqual(rotated, s.tok);
  assert.equal((await s.req('/dash/board')).code, 401, 'old cookie stops working after --new-token');
  s.done();
});

test('screen of a dead container: ended answer (last screen kept), no error, no log noise', async () => {
  const s = await setup();
  const url = `/dash/agent/${s.id}/screen`;
  assert.equal((await s.req(url)).json.text, 'hello world');
  s.host.tmuxCapture = async () => { throw new Error('docker exec: Error response from daemon: No such container: hl-x'); };
  const r = await s.req(url);
  assert.equal(r.code, 200);
  assert.equal(r.json.ended, true);
  assert.equal(r.json.text, 'hello world', 'last saved screen');
  assert.match(r.json.note, /ended/);
  s.host.tmuxCapture = async () => { throw new Error('tmux exploded'); };
  assert.equal((await s.req(url)).code, 400, 'other capture errors still surface');
  s.db.prepare("UPDATE agents SET state = 'merged' WHERE id = ?").run(s.id);
  assert.equal((await s.req(url)).json.ended, true);
  s.done();
});

test('dashboard board, detail and actions', async () => {
  const s = await setup();
  const who = s.core.authenticate(s.db.prepare('SELECT token FROM agents WHERE id = ?').get(s.id).token, 'ADMIN');
  await s.core.call('ask', { question: 'Which DB?', choices: ['SQLite', 'Postgres'] }, who);
  const b = (await s.req('/dash/board')).json;
  assert.equal(b.blocked, 1);
  const a = b.agents.find(x => x.id === s.id);
  assert.equal(a.ask.question, 'Which DB?');
  assert.equal(a.token, undefined, 'no worker token on the board');
  assert.equal((await s.req(`/dash/agent/${s.id}/screen`)).json.text, 'hello world');
  const d = (await s.req(`/dash/agent/${s.id}/diff`)).json;
  assert.equal(d.files[0].path, 'a.js');
  assert.match(d.stat, /a\.js/);
  assert.ok((await s.req(`/dash/agent/${s.id}/events`)).json.items.some(i => i.kind === 'ask'));
  // Actions need POST + X-Hauptling; cross-origin is refused.
  assert.equal((await s.req('/dash/do/answer', { method: 'POST', body: { ask: a.ask.id, choice: 0 } })).code, 403);
  assert.equal((await s.req('/dash/do/answer', { method: 'POST', headers: { 'x-hauptling': '1', origin: 'http://evil.example' }, body: { ask: a.ask.id, choice: 0 } })).code, 403);
  assert.equal((await s.req('/dash/do/spawn', { method: 'POST', headers: { 'x-hauptling': '1' }, body: {} })).code, 404, 'no spawning from the dashboard');
  const ans = await s.req('/dash/do/answer', { method: 'POST', headers: { 'x-hauptling': '1', origin: 'http://127.0.0.1:47800' }, body: { ask: a.ask.id, choice: 0 } });
  assert.equal(ans.json.result.answered, 'SQLite');
  await s.req('/dash/do/kill', { method: 'POST', headers: { 'x-hauptling': '1' }, body: { agent: s.id } });
  assert.equal(s.db.prepare('SELECT state FROM agents WHERE id = ?').get(s.id).state, 'killed');
  assert.equal((await s.req('/dash/history?q=')).json[0].id, s.id);
  s.done();
});

test('SQLite explorer: browse + read-only SQL, secrets masked even under an alias', async () => {
  const s = await setup();
  const agentTok = s.db.prepare('SELECT token FROM agents WHERE id = ?').get(s.id).token;
  const t = (await s.req('/dash/db/table?name=agents&filter=claude')).json;
  assert.equal(t.total, 1);
  assert.equal(t.rows[0][t.columns.indexOf('token')], '•••');
  assert.equal((await s.req('/dash/db/table?name=nope')).code, 400);
  const q = (await s.req('/dash/db/query', { method: 'POST', headers: { 'x-hauptling': '1' }, body: { sql: "SELECT token AS x, 'pre' || token AS y, id FROM agents" } })).json;
  assert.deepEqual(q.rows[0].slice(0, 2), ['•••', 'pre•••']);
  assert.ok(!JSON.stringify(q).includes(agentTok));
  const kv = (await s.req('/dash/db/query', { method: 'POST', headers: { 'x-hauptling': '1' }, body: { sql: "SELECT value FROM kv WHERE key = 'dash:token'" } })).json;
  assert.equal(kv.rows[0][0], '•••', 'the dashboard token itself is masked');
  assert.match((await s.req('/dash/db/query', { method: 'POST', headers: { 'x-hauptling': '1' }, body: { sql: 'DELETE FROM agents' } })).json.error, /Only SELECT/);
  const sneaky = await s.req('/dash/db/query', { method: 'POST', headers: { 'x-hauptling': '1' }, body: { sql: 'WITH x AS (SELECT 1) DELETE FROM agents' } });
  assert.equal(sneaky.code, 400, 'read-only connection refuses writes');
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM agents').get().n, 1);
  const big = (await s.req('/dash/db/query', { method: 'POST', headers: { 'x-hauptling': '1' }, body: { sql: 'WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n LIMIT 5000) SELECT i FROM n' } })).json;
  assert.equal(big.rows.length, 1000);
  assert.equal(big.truncated, true);
  const slow = await s.req('/dash/db/query', { method: 'POST', headers: { 'x-hauptling': '1' }, body: { sql: 'WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n) SELECT COUNT(*) FROM n' } });
  assert.match(slow.json.error, /longer than 2 s/);
  s.done();
});

test('stripAnsi removes colours, cursor moves and OSC titles', () => {
  assert.equal(stripAnsi('\x1b[31mred\x1b[0m \x1b[2K\x1b]0;title\x07ok\r'), 'red ok');
});

test('web terminal: frames from the agent pane; input off until switched on, gated keys, idle timeout', async () => {
  const s = await setup();
  const sent = [];
  s.host.tmuxScreen = async () => '\x1b[32mgreen\x1b[0m prompt> ';
  s.host.tmuxKeys = async (slot, id, args) => sent.push(args);
  const { checkKeys, createTerminals } = await import('../src/terminal.mjs');
  assert.throws(() => checkKeys([{ t: 'key', v: 'rm -rf' }]), /Bad key/);
  assert.throws(() => checkKeys([]), /1–200/);
  let t = 1_000_000;
  const terms = createTerminals({ db: s.db, host: s.host, slotDir: () => '/x', now: () => t });
  assert.equal((await terms.screen(s.id)).text, '\x1b[32mgreen\x1b[0m prompt> ');
  await assert.rejects(terms.keys(s.id, [{ t: 'lit', v: 'y' }]), /Input is off/);
  terms.input(s.id, true);
  await terms.keys(s.id, [{ t: 'lit', v: 'yes' }, { t: 'key', v: 'Enter' }, { t: 'key', v: 'C-c' }]);
  assert.deepEqual(sent, [['-l', 'yes'], ['Enter'], ['C-c']]);
  t += 9 * 60e3;
  assert.equal(terms.inputState(s.id).input, true, 'typing extends the 10 min window');
  t += 11 * 60e3;
  assert.equal(terms.inputState(s.id).input, false, 'off after 10 min without typing');
  assert.throws(() => terms.resolve('../../etc'), /No live session/);
  await assert.rejects(terms.startLogin('hl-w1; rm', 'claude'), /slot and vendor/);
  await assert.rejects(terms.startLogin('hl-w1', 'claude'), /is running on hl-w1 with this claude sign-in/, 'no second sign-in while its worker runs');
  assert.equal(terms.runningOn('hl-w1', 'codex'), null, 'other vendors on the same slot are not locked');
  // Over HTTP: input + keys need the X-Hauptling header like every action.
  const on = await s.req(`/dash/term/${s.id}/input`, { method: 'POST', headers: { 'x-hauptling': '1' }, body: { on: true } });
  assert.equal(on.json.input, true);
  assert.equal((await s.req(`/dash/term/${s.id}/keys`, { method: 'POST', body: { keys: [{ t: 'lit', v: 'x' }] } })).code, 403);
  s.done();
});

test('usage panel and spend: slot × vendor limits, sign-in state, totals of final usage', async () => {
  const s = await setup();
  s.db.prepare("INSERT INTO slot_usage VALUES ('hl-w1', 'claude', '5h', 42, '2026-11-24T20:00:00Z', '2026-11-24T15:00:00Z')").run();
  s.db.prepare('UPDATE agents SET usage = ? WHERE id = ?').run(JSON.stringify({ cost_usd: 1.5, cost_estimated: false, tokens_in: 1000, tokens_out: 100, limits: [] }), s.id);
  s.db.prepare("INSERT INTO slot_usage VALUES ('hl-w2', 'claude', '5h', 55, '2026-11-24T20:00:00Z', '2026-11-24T16:00:00Z')").run();
  const u = (await s.req('/dash/usage')).json;
  assert.deepEqual(u.vendors.map(v => v.vendor), ['claude', 'codex', 'agy'], 'one card per vendor account');
  const claude = u.vendors.find(v => v.vendor === 'claude');
  assert.deepEqual(claude.limits.map(l => [l.window, l.used_pct, l.slot]), [['5h', 55, 'hl-w2']], 'newest reading from any slot');
  assert.equal(claude.slots.find(x => x.slot === 'hl-w1').busy, s.id, 'Sign in locked for the running worker\'s vendor');
  assert.equal(u.vendors.find(v => v.vendor === 'codex').slots.find(x => x.slot === 'hl-w1').busy, null);
  assert.equal(claude.slots[0].login, 'hauptling login hl-w1 claude');
  assert.equal(u.spend.total.cost_usd, 1.5);
  assert.equal(u.spend.byVendor[0].key, 'claude');
  assert.equal((await s.req('/dash/board')).json.agents[0].usage.cost_usd, 1.5);
  s.done();
});

test('host load: CPU, memory and GPU as whole percents', async () => {
  const { dash, host, done } = await setup();
  host.gpuUtil = async () => 37;
  try {
    for (let i = 0; i < 1e6; i++); // some CPU between samples
    const { cpu, mem, gpu } = await dash.hostLoad();
    assert.equal(gpu, 37);
    for (const v of [cpu, mem]) assert.ok(v === null || (Number.isInteger(v) && v >= 0 && v <= 100), `got ${v}`);
    assert.ok(mem > 0);
  } finally { done(); }
});

test('headline: one sentence per situation, for the human watching', () => {
  const base = { base: 'main', title: 'Add terrain LOD' };
  const gateTest = (over) => ({ purpose: 'gate', gpu: false, state: 'done', status: 'pass', passed: 9, failed: 0, ...over });
  const cases = [
    [{ state: 'blocked', ask: { question: 'Which API?' } }, 'Needs your answer: Which API?'],
    [{ state: 'blocked', status: 'blocked: idle without report' }, 'Stuck: idle without report; attach or message it'],
    [{ state: 'queued' }, 'Queued: waiting for a free worker slot'],
    [{ state: 'waiting', depends_on: 'w_1' }, 'Waiting for its spec tests from w_1'],
    [{ state: 'working' }, 'Working on it'],
    [{ state: 'working', role: 'tests' }, 'Writing the spec tests'],
    [{ state: 'working', test: { purpose: 'request', gpu: true, state: 'running' } }, 'Running GPU tests'],
    [{ state: 'working', test: { purpose: 'request', state: 'done', status: 'fail', passed: 3, failed: 2 } }, 'Working; last tests fail (3/5)'],
    [{ state: 'working', ci_note: 'abc', pr_number: 7 }, 'Fixing a CI failure on PR #7'],
    [{ state: 'done', gate: 'ci', pr_number: 7 }, 'PR #7 open, waiting for CI to merge'],
    [{ state: 'done', gate: 'tests', test: gateTest({ state: 'queued', status: null }) }, 'Waiting to run merge gate'],
    [{ state: 'done', gate: 'tests', test: gateTest({ state: 'queued', status: null, position: 2 }) }, 'Merge gate queued, 2nd in line'],
    [{ state: 'done', gate: 'tests', test: gateTest({ state: 'running', status: null }) }, 'Running merge gate'],
    [{ state: 'working', test: { purpose: 'agent', state: 'queued', position: 11 } }, 'Tests queued, 11th in line'],
    [{ state: 'working', test: { purpose: 'agent', gpu: true, state: 'queued', position: 1 } }, 'GPU tests queued, 1st in line'],
    [{ state: 'done', gate: 'tests', test: gateTest() }, 'Ready to merge into main'],
    [{ state: 'done', gate: 'tests', test: gateTest({ status: 'fail', passed: 8, failed: 1 }) }, 'Merge gate fail (8/9); the delegator decides'],
    [{ state: 'done', gate: 'none' }, 'Done: report sent to the delegator'],
    [{ state: 'merged' }, 'Merged into main'],
    [{ state: 'exited', report: 'r', gate: 'tests', test: gateTest({ status: 'error', passed: 0 }) }, 'Session exited; merge gate error'],
    [{ state: 'exited' }, 'Session exited without reporting'],
    [{ state: 'failed', report: 'spawn failed: no slot' }, 'Failed: spawn failed: no slot'],
  ];
  for (const [a, want] of cases) assert.equal(headline({ ...base, ...a }), want);
});

test('dashboard: CPU test queue in the header, queue position in the headline, Run now', async () => {
  const s = await setup();
  const ahead = (await s.core.call('test.request', { repo: 'gitgiant/other', sha: 'o1' })).id;
  const gate = (await s.core.call('test.request', { agent: s.id, sha: 'abc', purpose: 'gate' })).id;
  let b = (await s.req('/dash/board')).json;
  assert.deepEqual(b.tests, { running: [], queued: 2, limit: 2 });
  let a = b.agents.find(x => x.id === s.id);
  assert.equal(a.test.position, 2);
  assert.match(a.headline, /queued, 2nd in line/);
  // Run now (POST action like kill): the agent's job starts ahead of the older one.
  s.host.runTestJob = () => new Promise(() => {});
  const r = await s.req('/dash/do/test.run', { method: 'POST', headers: { 'x-hauptling': '1' }, body: { id: gate } });
  assert.deepEqual(r.json.result, { started: gate });
  b = (await s.req('/dash/board')).json;
  assert.deepEqual(b.tests.running.map(t => [t.id, t.agent, t.repo]), [[gate, s.id, 'gitgiant/demo']]);
  assert.equal(b.tests.queued, 1);
  a = b.agents.find(x => x.id === s.id);
  assert.equal(a.test.position, null);
  assert.match(a.headline, /^Running /);
  assert.equal((await s.req('/dash/do/test.run', { method: 'POST', headers: { 'x-hauptling': '1' }, body: { id: gate } })).code, 400, 'queued jobs only');
  assert.equal(s.db.prepare('SELECT state FROM tests WHERE id = ?').get(ahead).state, 'queued');
  s.done();
});
