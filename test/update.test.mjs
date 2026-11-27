import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createUpdater } from '../src/update.mjs';
import { openDb } from '../src/db.mjs';
import { createCore } from '../src/core.mjs';
import { createDashboard, dashToken } from '../src/dashboard.mjs';
import { updateView, afterHello } from '../web/dashboard/update.js';

const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const git = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
function commit(dir, file, subject) {
  mkdirSync(dirname(join(dir, file)), { recursive: true });
  writeFileSync(join(dir, file), `${subject}\n`);
  git(dir, 'add', file);
  git(dir, 'commit', '--quiet', '-m', subject);
}

/** A bare origin, the checkout under test (`host`) and a clone that publishes to origin; Docker and restart stubbed. */
function repos(t, opts = {}) {
  const root = mkdtempSync(join(tmpdir(), 'hl-update-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const [origin, host, dev] = ['origin.git', 'host', 'dev'].map(n => join(root, n));
  execFileSync('git', ['init', '--quiet', '--bare', origin], { env });
  git(origin, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  execFileSync('git', ['clone', '--quiet', origin, dev], { env, stdio: 'ignore' });
  git(dev, 'checkout', '--quiet', '-b', 'main');
  commit(dev, 'src/core.mjs', 'first');
  git(dev, 'push', '--quiet', 'origin', 'main');
  execFileSync('git', ['clone', '--quiet', origin, host], { env, stdio: 'ignore' });
  const publish = (file, subject) => { commit(dev, file, subject); git(dev, 'push', '--quiet', 'origin', 'main'); };
  const calls = [];
  const logs = [];
  const clock = { now: 1000 };
  const updater = createUpdater({
    root: host, clock: () => clock.now, log: (m) => logs.push(m),
    build: async () => calls.push('build'), restart: async () => calls.push('restart'),
    announce: async (from, to) => calls.push(`announce ${from} ${to}`), ...opts,
  });
  const head = () => git(host, 'rev-parse', '--short', 'HEAD');
  return { host, publish, updater, calls, logs, clock, head };
}

test('check reports how far main is behind, with subjects', async (t) => {
  const r = repos(t);
  const first = await r.updater.check();
  assert.deepEqual(first, { current: r.head(), latest: r.head(), behind: 0, ahead: 0, dirty: false, branch: 'main', commits: [] });
  assert.equal(r.updater.available(), null);
  r.publish('README.md', 'docs');
  r.publish('src/core.mjs', 'a fix');
  r.clock.now += 60e3;
  const c = await r.updater.check();
  assert.equal(c.behind, 2);
  assert.deepEqual(c.commits, ['a fix', 'docs']);
  assert.notEqual(c.latest, c.current);
  assert.deepEqual(r.updater.available(), { behind: 2, latest: c.latest });
});

test('the fetch is rate limited to one a minute; local state is read fresh', async (t) => {
  const r = repos(t);
  await r.updater.check();
  r.publish('README.md', 'docs');
  writeFileSync(join(r.host, 'src/core.mjs'), 'edited\n');
  r.clock.now += 59e3;
  const cached = await r.updater.check();
  assert.equal(cached.behind, 0, 'no second fetch');
  assert.equal(cached.dirty, true);
  r.clock.now += 1e3;
  assert.equal((await r.updater.check()).behind, 1);
});

test('apply fast-forwards, builds only when image files changed, then restarts', async (t) => {
  const r = repos(t, { restartTimeoutMs: 1e9 });
  r.publish('README.md', 'docs');
  const from = r.head();
  const plan = await r.updater.start();
  assert.deepEqual(plan.commits, ['docs']);
  assert.equal(r.head(), from, 'nothing happens before run()');
  const phases = [];
  r.updater.onChange(s => phases.push(s.phase));
  await plan.run();
  assert.equal(r.head(), plan.to);
  assert.deepEqual(r.calls, [`announce ${from} ${plan.to}`, 'restart']);
  assert.deepEqual(phases, ['pulling', 'restarting']);
  assert.deepEqual(r.logs, [`updated ${from} → ${plan.to}`]);
  await assert.rejects(r.updater.start(), /already running/);
});

test('apply rebuilds the image when a baked file changed', async (t) => {
  const r = repos(t, { restartTimeoutMs: 1e9 });
  r.publish('src/runner.mjs', 'runner');
  const plan = await r.updater.start();
  await plan.run();
  assert.deepEqual(r.calls, ['build', `announce ${plan.from} ${plan.to}`, 'restart']);
});

test('a failed image build puts the checkout back and does not restart', async (t) => {
  let fail = true;
  const r = repos(t, { build: async () => { if (fail) throw new Error('no space'); }, restartTimeoutMs: 1e9 });
  r.publish('src/runner.mjs', 'runner');
  const from = r.head();
  await (await r.updater.start()).run();
  assert.equal(r.head(), from);
  assert.deepEqual(r.calls, []);
  assert.match(r.updater.status().error, /image build failed, the checkout is back at .*no space/);
  fail = false;
  const again = await r.updater.start();
  await again.run();
  assert.equal(r.head(), again.to);
});

test('nothing to do: no restart', async (t) => {
  const r = repos(t);
  assert.deepEqual(await r.updater.start(), { upToDate: true, current: r.head() });
  assert.deepEqual(await r.updater.start(), { upToDate: true, current: r.head() }, 'not left claimed');
  assert.deepEqual(r.calls, []);
});

test('refused on a dirty tree (untracked files are fine)', async (t) => {
  const r = repos(t);
  r.publish('README.md', 'docs');
  writeFileSync(join(r.host, 'notes.txt'), 'mine\n');
  assert.ok((await r.updater.start()).run);
  const s = repos(t);
  s.publish('README.md', 'docs');
  writeFileSync(join(s.host, 'src/core.mjs'), 'edited\n');
  await assert.rejects(s.updater.start(), /Not updating: uncommitted changes in src\/core\.mjs$/);
  await assert.rejects(s.updater.start(), /uncommitted/, 'a refusal does not claim the updater');
});

test('refused on another branch, when ahead and when diverged', async (t) => {
  const r = repos(t);
  r.publish('README.md', 'docs');
  git(r.host, 'checkout', '--quiet', '-b', 'feature');
  await assert.rejects(r.updater.start(), /on branch feature, not main/);
  git(r.host, 'checkout', '--quiet', 'main');
  commit(r.host, 'local.txt', 'local');
  const head = r.head();
  await assert.rejects(r.updater.start(), /diverged from origin\/main \(1 ahead, 1 behind\)/);
  assert.equal(r.head(), head);
  const s = repos(t);
  commit(s.host, 'local.txt', 'local');
  await assert.rejects(s.updater.start(), /ahead of origin\/main by 1 commit$/);
});

test('dashboard: update endpoints need the cookie and header; the restart follows the response', async (t) => {
  const order = [];
  const r = repos(t, { restart: async () => order.push('restart'), restartTimeoutMs: 1e9 });
  r.publish('README.md', 'docs');
  const dir = mkdtempSync(join(tmpdir(), 'hl-update-db-'));
  const dbPath = join(dir, 'hauptling.db');
  const db = openDb(dbPath);
  const core = createCore({ db, host: {}, notify: () => true, workerUrl: 'http://w', publicUrl: 'http://x', runnerToken: 'RUN' });
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  const dash = createDashboard({ db, dbPath, core, host: {}, updater: r.updater });
  const tok = dashToken(db);
  async function req(path, { cookie = `hl_dash=${tok}`, headers = { 'x-hauptling': '1' } } = {}) {
    const q = { method: 'POST', url: path, headers: { host: '127.0.0.1:47800', ...(cookie ? { cookie } : {}), ...headers }, socket: { localAddress: '127.0.0.1' }, async *[Symbol.asyncIterator]() {} };
    const res = { code: 0, body: '', writeHead(c) { this.code = c; }, end(b) { this.body += b ?? ''; order.push(`response ${this.code}`); } };
    await dash.handle(q, res, new URL(path, 'http://x'));
    return { code: res.code, json: JSON.parse(res.body) };
  }
  for (const path of ['/dash/update/check', '/dash/update/apply']) {
    assert.equal((await req(path, { cookie: null })).code, 401);
    assert.equal((await req(path, { headers: {} })).code, 403);
  }
  assert.ok(!order.includes('restart'));
  assert.equal((await req('/dash/update/check')).json.behind, 1);
  assert.equal((await dash.snapshot()).update.behind, 1, 'the dot');
  order.length = 0;
  const done = new Promise(resolve => r.updater.onChange(s => s.phase === 'restarting' && setImmediate(resolve)));
  const applied = await req('/dash/update/apply');
  assert.equal(applied.code, 202);
  assert.equal(applied.json.to, r.updater.status().to);
  await done;
  assert.deepEqual(order, ['response 202', 'restart']);
  const again = await req('/dash/update/apply');
  assert.equal(again.code, 400);
  assert.match(again.json.error, /already running/);
});

test('update.announce tells active delegators only, and not workers', async (t) => {
  const db = openDb(':memory:');
  t.after(() => db.close());
  const core = createCore({ db, host: {}, notify: () => true, workerUrl: 'http://w', publicUrl: 'http://x', runnerToken: 'RUN' });
  const a = await core.call('delegator.start', { repo: 'o/a' });
  const b = await core.call('delegator.start', { repo: 'o/b' });
  await core.call('delegator.end', { delegator: b.id });
  await core.call('update.announce', { from: 'aaa', to: 'bbb' });
  assert.deepEqual(db.prepare("SELECT delegator, text FROM events WHERE kind = 'updated'").all().map(e => ({ ...e })), [{ delegator: a.id, text: 'aaa → bbb' }]);
  await assert.rejects(async () => core.call('update.announce', {}, { role: 'agent', agent: 'x' }), /not allowed/);
});

test('menu text, and reload or finish after reconnecting', () => {
  assert.equal(updateView({ report: { behind: 0, ahead: 0, current: 'abc' } }).text, 'Up to date (abc)');
  const v = updateView({ report: { behind: 2, commits: ['x', 'y'] } });
  assert.deepEqual([v.text, v.commits, v.apply], ['2 new commits', ['x', 'y'], true]);
  const restarting = { phase: 'restarting', to: 'bbb' };
  const first = { boot: '1', assets: 'A' };
  assert.deepEqual(afterHello(null, first, null), { reload: false, update: null });
  assert.equal(afterHello(first, { boot: '2', assets: 'B' }, restarting).reload, true);
  assert.deepEqual(afterHello(first, { boot: '2', assets: 'A' }, restarting), { reload: false, update: { phase: 'done', to: 'bbb' } });
  assert.equal(afterHello(first, first, restarting).update, restarting, 'same broker: still restarting');
});
