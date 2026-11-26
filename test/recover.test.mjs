import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.HAUPTLING_HOME = mkdtempSync(join(tmpdir(), 'hl-recover-'));
const { dockerHost } = await import('../src/docker.mjs');
const { openDb } = await import('../src/db.mjs');
const { createCore } = await import('../src/core.mjs');

const SHA = 'abc1234def';
const settle = () => new Promise(r => setTimeout(r, 20));

/** A fake docker with at most one container per test job: { id, status, exit() }. */
function fakeDocker() {
  const containers = new Map();
  const removed = [];
  const find = (ref) => [...containers.values()].find(c => c.id === ref || c.name === ref);
  const docker = async ([cmd, ...args]) => {
    const ref = args.at(-1);
    if (cmd === 'ps') return { stdout: [...containers.values()].map(c => `${c.id} ${c.job}\n`).join('') };
    if (cmd === 'rm') {
      for (const r of args.slice(1)) { const c = find(r); if (c) { containers.delete(c.job); removed.push(c.job); c.exit(137); } }
      return { stdout: '' };
    }
    const c = find(ref);
    if (!c) throw new Error(`docker ${cmd}: No such object: ${ref}`);
    if (cmd === 'inspect') return { stdout: args[1].includes('.Id') ? `${c.id} ${c.status} ${new Date().toISOString()}\n` : `${c.status}\n` };
    if (cmd === 'wait') return { stdout: `${await c.exited}\n` };
    return { stdout: '', stderr: '' };
  };
  const add = (job, status = 'running') => {
    let done;
    const exited = new Promise(r => { done = r; });
    const c = { id: `cid-${job}`, name: `hauptling-test-${job}`, job, status, exited, exit(code = 0) { c.status = 'exited'; done(code); } };
    if (status !== 'running') done(0);
    containers.set(job, c);
    return c;
  };
  return { docker, containers, removed, add };
}

const writeReport = (job, status = 'pass') => {
  const art = join(process.env.HAUPTLING_HOME, 'jobs', `${job}-artifacts`);
  mkdirSync(art, { recursive: true });
  writeFileSync(join(art, 'report.json'), JSON.stringify({ status, passed: 2, failed: 0, skipped: 0, failures: [], artifacts: [], log_path: '/artifacts/test.log' }));
};

/** A broker restarting with one job in state `running` (repo-only, so no worker is needed). */
async function restarted({ gpu = false } = {}) {
  rmSync(join(process.env.HAUPTLING_HOME, 'jobs'), { recursive: true, force: true });
  const fake = fakeDocker();
  const real = dockerHost({ docker: fake.docker });
  const runs = [];
  const host = { adoptTestJob: real.adoptTestJob, removeTestContainers: real.removeTestContainers, killTestJob: real.killTestJob, testLiveness: real.testLiveness, runTestJob: (job) => { runs.push(job.id); return new Promise(() => {}); } };
  const db = openDb(':memory:');
  const reports = [];
  const core = createCore({ db, host, github: {}, notify: () => {}, log: (m) => { if (m.startsWith('test report')) reports.push(m); } });
  const insert = (id) => db.prepare(`INSERT INTO tests (id, requester, repo, sha, selector, gpu, artifacts, timeout_s, round, purpose, state, claimed_at, created_at)
    VALUES (?, 'user', '/repo', ?, '', ?, '[]', 1800, 1, 'agent', 'running', ?, ?)`).run(id, SHA, gpu ? 1 : 0, new Date().toISOString(), new Date().toISOString());
  insert('t_1');
  const row = (id = 't_1') => db.prepare('SELECT * FROM tests WHERE id = ?').get(id);
  return { fake, core, db, runs, reports, row, insert };
}

test('restart: a running test container is adopted, not requeued, and reported once', async () => {
  const env = await restarted();
  const c = env.fake.add('t_1');
  const stale = env.fake.add('t_old', 'exited');
  assert.deepEqual(await env.core.recover(), { requeued: 0, adopted: 1 });
  await env.core.pump();
  await settle();
  assert.equal(env.row().state, 'running');
  assert.deepEqual(env.fake.removed, [stale.job], 'only the leftover container is removed');
  await env.core.watchTests();
  assert.equal(env.row().state, 'running');

  writeReport('t_1');
  c.exit(0);
  await settle();
  assert.equal(env.row().state, 'done');
  assert.equal(JSON.parse(env.row().report).passed, 2);
  assert.match(JSON.parse(env.row().report).log_path, /t_1-artifacts\/test\.log$/);
  assert.deepEqual(env.fake.removed, ['t_old', 't_1']);
  assert.deepEqual(env.runs, []);
  assert.deepEqual(env.reports, [], 'no second report');
});

test('restart: a finished container has its result collected', async () => {
  const env = await restarted();
  env.fake.add('t_1', 'exited');
  writeReport('t_1', 'fail');
  assert.deepEqual(await env.core.recover(), { requeued: 0, adopted: 1 });
  await settle();
  assert.equal(JSON.parse(env.row().report).status, 'fail');
  assert.equal(env.fake.containers.size, 0);
  assert.deepEqual(env.runs, []);
});

test('restart: gone, never started or exited without a report → requeued', async () => {
  for (const status of [null, 'created', 'exited']) {
    const env = await restarted();
    if (status) env.fake.add('t_1', status);
    assert.deepEqual(await env.core.recover(), { requeued: 1 }, String(status));
    assert.equal(env.row().state, 'queued');
    assert.equal(env.fake.containers.size, 0);
    await env.core.pump();
    assert.deepEqual(env.runs, ['t_1']);
  }
});

test('restart: an adopted GPU job holds the GPU queue; gpu pause --now still kills and requeues it', async () => {
  const env = await restarted({ gpu: true });
  env.fake.add('t_1');
  await env.core.recover();
  env.insert('t_2');
  env.db.prepare("UPDATE tests SET state = 'queued', claimed_at = NULL WHERE id = 't_2'").run();
  await env.core.pump();
  assert.deepEqual(env.runs, []);
  await env.core.call('gpu.pause', { now: true });
  await settle();
  assert.equal(env.row().state, 'queued');
  assert.equal(env.row().report, null);
  await env.core.call('gpu.resume');
  await settle();
  assert.deepEqual(env.runs, ['t_1'], 'the queue moved on once the adopted run ended');
});
