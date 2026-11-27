import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { openDb } from '../src/db.mjs';
import { createCore } from '../src/core.mjs';
import { createDashboard, dashToken } from '../src/dashboard.mjs';
import * as keyStore from '../src/keys.mjs';
import { loadModels } from '../src/models.mjs';
import { movable, canDrop, dropSide, keyMove } from '../web/dashboard/queue.js';

// Pausing queued agents and queue priority (PRD "Queue priority"): Docker and gh stubbed.

const host = () => ({
  workRoot: '/hl/work',
  async run(slot, argv) {
    if (argv[0] === 'git' && argv[3] === 'rev-parse') return { stdout: 'main\n' };
    if (argv[0] === 'cat') throw new Error('no file');
    return { stdout: '' };
  },
  async startWorker() {}, async stopWorker() {}, async tmuxType() {}, async tmuxAlive() { return true; }, async tmuxCapture() { return ''; },
  async pauseWorker() { throw new Error('nothing to freeze'); }, async unpauseWorker() { throw new Error('nothing to thaw'); },
  dropSession() {}, saveSession() { return []; }, attachArgv: () => [],
});
const tick = () => new Promise(r => setTimeout(r, 20));

/** A delegator that runs one agent at a time: the first spawn starts, the rest queue. */
async function setup(spawns = 4) {
  const dir = mkdtempSync(join(tmpdir(), 'hl-queue-'));
  const dbPath = join(dir, 'hauptling.db');
  const db = openDb(dbPath);
  const h = host();
  const core = createCore({ db, host: h, github: { gitAuthEnv: async () => ({}) }, keys: { ...keyStore, getKey: () => null, getBudget: () => null }, notify: () => true, models: () => loadModels(join(dir, 'none.json')), workerUrl: 'http://w', publicUrl: 'http://127.0.0.1:47800', runnerToken: 'RUN' });
  const { id: delegator } = await core.call('delegator.start', { repo: 'gitgiant/demo', max: 1 });
  const ids = [];
  for (let i = 0; i < spawns; i++) ids.push((await core.call('spawn', { delegator, brief: `task ${i}`, vendor: 'claude', mode: 'cheapest' })).id);
  await tick();
  const row = (id) => db.prepare('SELECT * FROM agents WHERE id = ?').get(id);
  const order = async (d = delegator) => (await core.call('queue.list', { delegator: d })).queue.map(q => q.id);
  const finish = async (id) => { await core.call('kill', { agent: id }); await tick(); };
  const done = () => { db.close(); rmSync(dir, { recursive: true, force: true }); };
  return { db, dbPath, core, h, delegator, ids, row, order, finish, done };
}

test('a paused queued agent is skipped, keeps its place, and starts by priority once unpaused', async () => {
  const s = await setup();
  const [run, a, b, c] = s.ids;
  await s.core.call('pause', { agent: a });
  assert.deepEqual([s.row(a).state, s.row(a).paused_state], ['paused', 'queued']);
  assert.deepEqual(await s.order(), [a, b, c]);
  await s.finish(run);
  assert.equal(s.row(a).state, 'paused');
  assert.equal(s.row(b).state, 'working', 'it counts toward no limit: the next one starts');
  await s.core.call('unpause', { agent: a });
  assert.equal(s.row(a).state, 'queued');
  await s.finish(b);
  assert.equal(s.row(a).state, 'working');
  assert.equal(s.row(c).state, 'queued');
  const events = s.db.prepare("SELECT kind FROM events WHERE agent = ? AND kind IN ('paused','resumed')").all(a).map(e => e.kind);
  assert.deepEqual(events, ['paused', 'resumed']);
  s.done();
});

test('unpausing with a free place starts it at once; a paused test writer keeps its implementer waiting', async () => {
  const s = await setup(1);
  const r = await s.core.call('spawn', { delegator: s.delegator, brief: 'tdd', vendor: 'claude', mode: 'cheapest', testWriter: {} });
  await s.core.call('pause', { agent: r.testWriter.id });
  await s.finish(s.ids[0]);
  assert.equal(s.row(r.id).state, 'waiting');
  await s.core.call('unpause', { agent: r.testWriter.id });
  await tick();
  assert.equal(s.row(r.testWriter.id).state, 'working');
  s.done();
});

test('queue move changes which agent starts next; waiting agents keep their priority', async () => {
  const s = await setup();
  const [run, a, b, c] = s.ids;
  const move = (agent, to) => s.core.call('queue.move', { agent, ...to });
  await move(c, { top: true });
  assert.deepEqual(await s.order(), [c, a, b]);
  await move(c, { bottom: true });
  assert.deepEqual(await s.order(), [a, b, c]);
  await move(c, { before: b });
  assert.deepEqual(await s.order(), [a, c, b]);
  await move(a, { after: c });
  assert.deepEqual(await s.order(), [c, a, b]);
  assert.equal(new Set(s.ids.map(id => s.row(id).priority)).size, 4, 'priorities stay distinct');
  await assert.rejects(move(run, { top: true }), /only queued agents/);
  await assert.rejects(move(a, {}), /one of/);
  await assert.rejects(move(a, { top: true, bottom: true }), /one of/);
  await s.finish(run);
  assert.equal(s.row(c).state, 'working');
  assert.equal(s.row(a).state, 'queued');
  s.done();
});

test('delegators have independent queues', async () => {
  const s = await setup(2);
  const { id: other } = await s.core.call('delegator.start', { repo: 'gitgiant/other', max: 1 });
  const ids = [];
  for (let i = 0; i < 3; i++) ids.push((await s.core.call('spawn', { delegator: other, brief: 'x', vendor: 'codex', mode: 'cheapest' })).id);
  assert.deepEqual(await s.order(other), ids.slice(1));
  await assert.rejects(s.core.call('queue.move', { agent: ids[2], before: s.ids[1] }), /not in the queue/);
  await s.core.call('queue.move', { agent: ids[2], top: true });
  assert.deepEqual(await s.order(), [s.ids[1]]);
  assert.deepEqual(await s.order(other), [ids[2], ids[1]]);
  s.done();
});

test('an unparking agent goes before a top-priority queued one, paused or reworked included', async () => {
  const s = await setup();
  const [run, a, b, c] = s.ids;
  s.db.prepare("UPDATE agents SET unpark = 'mail arrived', dir = '/hl/work/x' WHERE id = ?").run(c);
  await s.core.call('queue.move', { agent: b, top: true });
  assert.deepEqual(await s.order(), [c, b, a]);
  await assert.rejects(s.core.call('queue.move', { agent: b, before: c }), /Unparking agents always start first/);
  await s.core.call('pause', { agent: c });
  await s.core.call('restart', { agent: c }); // a paused unparking agent: restart puts it back, no container needed
  assert.equal(s.row(c).state, 'queued');
  await s.finish(run);
  assert.notEqual(s.row(c).state, 'queued');
  assert.equal(s.row(b).state, 'queued');
  s.done();
});

test('worker tokens cannot pause, list or move; the move endpoint needs the cookie and the header', async () => {
  const s = await setup();
  const [run, a, b] = s.ids;
  const worker = s.core.authenticate(s.row(run).token, 'ADMIN');
  for (const [call, args] of [['pause', { agent: a }], ['queue.list', {}], ['queue.move', { agent: b, top: true }]]) {
    await assert.rejects(s.core.call(call, args, worker), /not allowed/i);
  }
  const dash = createDashboard({ db: s.db, dbPath: s.dbPath, core: s.core, host: s.h });
  const cookie = `hl_dash=${dashToken(s.db)}`;
  const post = async (headers) => {
    const r = { method: 'POST', url: '', headers: { host: '127.0.0.1:47800', ...headers }, socket: { localAddress: '127.0.0.1' }, on() {}, async *[Symbol.asyncIterator]() { yield JSON.stringify({ top: true }); } };
    const res = { code: 0, body: '', writeHead(c) { this.code = c; }, end(x) { this.body += x ?? ''; } };
    await dash.handle(r, res, new URL(`/dash/agents/${b}/move`, 'http://x'));
    return res;
  };
  assert.equal((await post({ 'x-hauptling': '1' })).code, 401);
  assert.equal((await post({ 'x-hauptling': '1', authorization: `Bearer ${s.row(run).token}` })).code, 401);
  assert.equal((await post({ cookie })).code, 403);
  assert.deepEqual((await s.order()).slice(0, 2), [a, b]);
  assert.equal((await post({ cookie, 'x-hauptling': '1' })).code, 200);
  assert.equal((await s.order())[0], b);
  await s.core.call('pause', { agent: a });
  const res = { body: '', writeHead() {}, end(x) { this.body += x ?? ''; } };
  await dash.handle({ method: 'GET', headers: { host: '127.0.0.1:47800', cookie }, socket: { localAddress: '127.0.0.1' }, on() {} }, res, new URL('/dash/board', 'http://x'));
  const board = JSON.parse(res.body);
  const row = (id) => board.agents.find(x => x.id === id);
  assert.deepEqual([row(b).queue, row(a).queue, row(run).queue], [1, 2, null]);
  assert.equal(row(a).headline, 'Paused by you');
  s.done();
});

test('migration numbers existing rows by creation, per delegator', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hl-queue-'));
  const path = join(dir, 'hauptling.db');
  openDb(path).close();
  const old = new DatabaseSync(path);
  old.exec('ALTER TABLE agents DROP COLUMN priority');
  const add = old.prepare("INSERT INTO agents (id, delegator, vendor, model, repo, base, branch, brief, title, state, token, created_at, updated_at) VALUES (?, ?, 'claude', 'm', 'r', 'main', 'b', 'b', 't', 'queued', ?, ?, ?)");
  for (const [id, d, at] of [['late', 'd1', '2026-01-03'], ['early', 'd1', '2026-01-01'], ['other', 'd2', '2026-01-02'], ['tie', 'd1', '2026-01-03']]) add.run(id, d, id, at, at);
  old.close();
  const read = () => { const db = openDb(path); const r = Object.fromEntries(db.prepare('SELECT id, priority FROM agents').all().map(a => [a.id, a.priority])); db.close(); return r; };
  assert.deepEqual(read(), { early: 1, late: 2, tie: 3, other: 1 });
  const db = openDb(path);
  db.exec("UPDATE agents SET priority = 9 WHERE id = 'early'");
  db.close();
  assert.equal(read().early, 9, 'only once');
  rmSync(dir, { recursive: true, force: true });
});

test('board: which cards trade places, the drop side and the keyboard moves', () => {
  const q = (id, queue, extra = {}) => ({ id, queue, delegator: 'd', ...extra });
  const rows = [q('u', 1, { unpark: 'mail' }), q('a', 2), q('b', 3), q('c', 4), q('x', 1, { delegator: 'e' }), q('r', null)];
  const [u, a, b, , x, r] = rows;
  assert.ok(movable(a) && !movable(r));
  assert.ok(canDrop(a, b));
  for (const other of [a, u, x, r]) assert.ok(!canDrop(a, other), other.id);
  const box = { left: 0, top: 0, width: 100, height: 40 };
  assert.equal(dropSide({ x: 90, y: 10 }, box), 'before');
  assert.equal(dropSide({ x: 90, y: 10 }, box, true), 'after');
  assert.deepEqual(keyMove(rows, 'b', 'up'), { before: 'a' });
  assert.deepEqual(keyMove(rows, 'b', 'down'), { after: 'c' });
  assert.deepEqual(keyMove(rows, 'c', 'top'), { top: true });
  assert.equal(keyMove(rows, 'a', 'up'), null);
  assert.equal(keyMove(rows, 'a', 'top'), null);
  assert.equal(keyMove(rows, 'r', 'up'), null);
});
