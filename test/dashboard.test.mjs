import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDb } from '../src/db.mjs';
import { createCore } from '../src/core.mjs';
import { createDashboard, dashToken, stripAnsi } from '../src/dashboard.mjs';
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
  const core = createCore({ db, host, github: gh, notify: () => true, models: () => loadModels(join(tmpdir(), 'none.json')), workerUrl: 'http://w', publicUrl: 'http://127.0.0.1:47800', runnerToken: 'RUN' });
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
