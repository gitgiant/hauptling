import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runClaimed, runnerLoop } from '../src/host-runner.mjs';
import { execTests } from '../src/runner.mjs';

/** A git repo with a hauptling.json whose "gpu" command writes the commit it ran on. */
function repo(gpu) {
  const dir = mkdtempSync(join(tmpdir(), 'hl-runner-repo-'));
  const g = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' }).trim();
  g('init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'hauptling.json'), JSON.stringify({ test: ['true'], gpu }));
  g('add', '.');
  g('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'one');
  const sha = g('rev-parse', 'HEAD');
  return { dir, sha };
}

test('runner loop: claims a GPU job, runs the "gpu" command on the checked-out sha, reports, cleans up', async () => {
  const r = repo(['node', '-e', "require('fs').writeFileSync('ran.txt', 'gpu')"]);
  const root = mkdtempSync(join(tmpdir(), 'hl-runner-'));
  const job = { id: 't_1', url: r.dir, sha: r.sha, selector: '', timeout_s: 60, artifacts: ['ran.txt'], gpu: true };
  const calls = [];
  const call = async (name, args) => {
    calls.push([name, args]);
    if (name === 'test.claim') return { job: calls.filter(c => c[0] === 'test.claim').length === 1 ? job : null };
    return { ok: true };
  };
  const report = await runnerLoop({ call, gpu: true, once: true, root });
  assert.equal(report.status, 'pass', report.notes);
  assert.equal(report.id, 't_1');
  assert.equal(report.sha, r.sha);
  assert.deepEqual(calls[0], ['test.claim', { gpu: true, wait: 25 }]);
  const sent = calls.find(c => c[0] === 'test.report');
  assert.equal(sent[1].id, 't_1');
  assert.equal(sent[1].report.status, 'pass');
  assert.equal(readFileSync(join(root, 't_1-artifacts', 'ran.txt'), 'utf8'), 'gpu', 'artifact collected from the gpu command');
  assert.equal(existsSync(join(root, 't_1')), false, 'checkout removed');
});

test('runner: a failing command is a fail report; a bad sha or a throwing exec is an error report', async () => {
  const r = repo(['node', '-e', 'process.exit(3)']);
  const root = mkdtempSync(join(tmpdir(), 'hl-runner-'));
  const base = { url: r.dir, sha: r.sha, timeout_s: 60, gpu: true };
  const failed = await runClaimed({ ...base, id: 't_f' }, { root, exec: execTests });
  assert.equal(failed.status, 'fail');
  assert.match(failed.failures[0].message, /exit code 3/);
  const bad = await runClaimed({ ...base, id: 't_b', sha: 'deadbeef'.repeat(5) }, { root });
  assert.equal(bad.status, 'error');
  assert.match(bad.notes, /checkout failed/);
  const threw = await runClaimed({ ...base, id: 't_x' }, { root, exec: async () => { throw new Error('boom'); } });
  assert.equal(threw.status, 'error');
  assert.match(threw.notes, /runner: boom/);
});

test('runner loop: broker errors are retried, not fatal', async () => {
  let n = 0;
  const call = async (name) => {
    if (name !== 'test.claim') return {};
    n++;
    if (n === 1) throw new Error('Broker unreachable');
    return { job: null };
  };
  await runnerLoop({ call, gpu: true, root: mkdtempSync(join(tmpdir(), 'hl-runner-')), retryMs: 1, stop: () => n >= 3 });
  assert.equal(n, 3);
});

test('runner loop: heartbeats carry the job id and its progress (step, latest line, results so far)', async () => {
  const r = repo(['node', '-e', "console.log('ok   one'); console.log('ok   two'); setTimeout(() => {}, 300)"]);
  const root = mkdtempSync(join(tmpdir(), 'hl-runner-'));
  const job = { id: 't_p', url: r.dir, sha: r.sha, timeout_s: 60, gpu: true };
  const beats = [];
  let claims = 0;
  const call = async (name, args) => {
    if (name === 'test.claim') return { job: ++claims === 1 ? job : null };
    if (name === 'test.heartbeat') beats.push(args);
    return { ok: true };
  };
  const report = await runnerLoop({ call, gpu: true, once: true, root, progressMs: 0 });
  assert.equal(report.status, 'pass', report.notes);
  const last = beats.filter(b => b.progress).pop();
  assert.equal(last.id, 't_p');
  assert.equal(last.progress.step, 'tests');
  assert.equal(last.progress.results, 2);
  assert.equal(last.progress.line, 'ok   two');
});
