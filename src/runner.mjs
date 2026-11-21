import { spawn } from 'node:child_process';
import { cpSync, existsSync, globSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { call } from './client.mjs';
import { detect, fill } from './detect.mjs';
import { parseJunit } from './junit.mjs';

/*
 * Deterministic test runner (no LLM), run as the `hl-test` user. Claims jobs from the broker,
 * checks the sha out in a fresh clone, runs the detected (or hauptling.json) commands, reads
 * JUnit when available, posts the report.
 */

function run(argv, { cwd, timeout, log }) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(argv[0], argv.slice(1), { cwd, env: { ...process.env, CI: '1' }, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    let out = '';
    const take = (d) => { out += d; if (out.length > 4 << 20) out = out.slice(-2 << 20); };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, timeout * 1000);
    child.on('error', (e) => { out += `\n${e.message}`; });
    child.on('close', (code) => {
      clearTimeout(timer);
      writeFileSync(log, out, { flag: 'a' });
      resolve({ code, timedOut, out, secs: (Date.now() - started) / 1000 });
    });
  });
}

/** Copies files matching the job's artifact globs (relative to the checkout) into <root>/<id>-artifacts. */
export function collectArtifacts(dir, globs, dest) {
  const out = [];
  for (const pattern of globs || []) {
    if (pattern.startsWith('/') || pattern.includes('..')) continue;
    for (const rel of globSync(pattern, { cwd: dir })) {
      mkdirSync(dirname(join(dest, rel)), { recursive: true });
      cpSync(join(dir, rel), join(dest, rel), { recursive: true });
      out.push(join(dest, rel));
      if (out.length >= 200) return out;
    }
  }
  return out;
}

export async function runJob(job, root = join(homedir(), 'jobs')) {
  const report = await runInner(job, root);
  const dir = join(root, job.id);
  if (job.artifacts?.length && existsSync(dir)) report.artifacts = collectArtifacts(dir, job.artifacts, join(root, `${job.id}-artifacts`));
  return report;
}

async function runInner(job, root) {
  const dir = join(root, job.id);
  const log = join(root, `${job.id}.log`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  const t0 = Date.now();
  const base = { id: job.id, sha: job.sha, passed: 0, failed: 0, skipped: 0, failures: [], artifacts: [], log_path: log };
  const step = async (argv, timeout) => run(argv, { cwd: dir, timeout, log });
  let r = await run(['git', 'clone', '--quiet', '--no-checkout', job.url, dir], { cwd: root, timeout: 600, log });
  if (r.code === 0) r = await step(['git', 'checkout', '--quiet', '--detach', job.sha], 120);
  if (r.code !== 0) return { ...base, status: 'error', duration_s: (Date.now() - t0) / 1000, notes: `checkout failed: ${r.out.trim().split('\n').pop()}`.slice(0, 300) };
  const cfg = detect(dir);
  if (!cfg.test) return { ...base, status: 'error', duration_s: 0, notes: 'No test command detected; add hauptling.json with "test": [argv]' };
  if (cfg.install) {
    r = await step(cfg.install, 900);
    if (r.code !== 0) return { ...base, status: 'error', duration_s: (Date.now() - t0) / 1000, notes: `install failed (${cfg.install.join(' ')}): ${r.out.trim().split('\n').pop()}`.slice(0, 300) };
  }
  const junit = join(dir, '.hauptling-junit.xml');
  const selector = job.selector || cfg.defaultSelector || '';
  const argv = fill(cfg.test, { selector, junit });
  r = await step(argv, job.timeout_s || 1800);
  const duration_s = (Date.now() - t0) / 1000;
  if (r.timedOut) return { ...base, status: 'timeout', duration_s, notes: `timed out after ${job.timeout_s}s` };
  const junitPath = cfg.junit ? cfg.junit.replaceAll('{junit}', junit) : null;
  const resolved = junitPath && !junitPath.startsWith('/') ? join(dir, junitPath) : junitPath;
  if (resolved && existsSync(resolved)) {
    const j = parseJunit(readFileSync(resolved, 'utf8'));
    const status = r.code === 0 && j.failed === 0 ? 'pass' : j.failed ? 'fail' : 'error';
    return { ...base, ...j, status, duration_s, notes: status === 'error' ? `exit ${r.code} with no failing tests in JUnit` : `${cfg.source}: ${argv.join(' ')}`.slice(0, 300) };
  }
  const tail = r.out.trim().split('\n').slice(-20).join('\n');
  return { ...base, status: r.code === 0 ? 'pass' : 'fail', duration_s, failures: r.code === 0 ? [] : [{ test_id: argv.join(' '), loc: '', message: `exit code ${r.code}`, excerpt: tail }], notes: 'no JUnit output; result from exit code' };
}

export async function runnerLoop({ idleExit = 1800e3 } = {}) {
  let last = Date.now();
  for (;;) {
    if (Date.now() - last > idleExit) return; // the broker starts a new runner when a job is queued
    let job;
    try { ({ job } = await call('test.claim', { wait: 25 })); }
    catch (e) { console.error(e.message); await new Promise(r => setTimeout(r, 5000)); continue; }
    if (!job) continue;
    last = Date.now();
    let report;
    try { report = await runJob(job); } catch (e) { report = { id: job.id, sha: job.sha, status: 'error', passed: 0, failed: 0, skipped: 0, failures: [], duration_s: 0, notes: e.message.slice(0, 300) }; }
    await call('test.report', { id: job.id, report }).catch(e => console.error(e.message));
  }
}
