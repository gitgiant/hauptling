import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { execTests, HEARTBEAT_MS } from './runner.mjs';

/*
 * `hauptling runner [--gpu]`: an external test runner on the host itself, no container. It claims jobs
 * from the broker (test.claim, runner token), checks the sha out in its own work dir, runs the repo's
 * hauptling.json command through the same execTests as a test container, and reports (test.report).
 * Meant for GPU jobs that a container can't run, such as WebGPU in Chrome on WSL2 (no Vulkan driver
 * there): run it on Windows, set `"gpuRunner": "host"` in the broker's config.json. Repo code then runs
 * unsandboxed on the host, so use it for repos you trust.
 */

const errorReport = (job, notes) => ({ id: job.id, sha: job.sha, status: 'error', passed: 0, failed: 0, skipped: 0, failures: [], duration_s: 0, notes: String(notes).slice(0, 300) });

function git(args, cwd) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error(`git ${args[0]}: ${(r.stderr || r.error?.message || '').trim().split('\n').pop()}`);
}

/** Runs one claimed job to a report (never throws: failures become an error report). */
export async function runClaimed(job, { root, exec = execTests, checkout = defaultCheckout }) {
  const dir = join(root, job.id), out = join(root, `${job.id}-artifacts`);
  rmSync(dir, { recursive: true, force: true });
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  try { checkout(job, dir); } catch (e) { return errorReport(job, `checkout failed: ${e.message}`); }
  try {
    const report = await exec(dir, { selector: job.selector || '', timeout_s: job.timeout_s || 1800, artifacts: job.artifacts || [], gpu: job.gpu }, out);
    return { ...report, id: job.id, sha: job.sha };
  } catch (e) {
    return errorReport(job, `runner: ${e.message}`);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  }
}

function defaultCheckout(job, dir) {
  git(['clone', '--quiet', '--no-checkout', job.url, dir]);
  git(['-c', 'advice.detachedHead=false', 'checkout', '--quiet', '--detach', job.sha], dir);
}

/**
 * Claim → run → report, until `once` has run a job or `stop()` returns true. `call` is the broker client.
 * Heartbeats (test.heartbeat) go out while a job runs.
 */
export async function runnerLoop({ call, gpu = false, once = false, root, log = () => {}, stop = () => false, ...opts }) {
  mkdirSync(root, { recursive: true });
  log(`runner: claiming ${gpu ? 'GPU' : 'CPU'} jobs; work dir ${root}`);
  while (!stop()) {
    let job;
    try { ({ job } = await call('test.claim', { gpu, wait: 25 })); } catch (e) {
      log(`runner: ${e.message}`);
      await new Promise(r => setTimeout(r, opts.retryMs ?? 10e3));
      continue;
    }
    if (!job) continue;
    log(`runner: ${job.id} ${job.url} ${job.sha.slice(0, 7)}${job.selector ? ` (${job.selector})` : ''}`);
    const beat = setInterval(() => call('test.heartbeat', {}).catch(() => {}), HEARTBEAT_MS);
    let report;
    try { report = await runClaimed(job, { root, ...opts }); } finally { clearInterval(beat); }
    log(`runner: ${job.id} ${report.status} (${report.passed} passed, ${report.failed} failed) ${report.notes || ''}`);
    try { await call('test.report', { id: job.id, report }); } catch (e) { log(`runner: report ${job.id}: ${e.message}`); }
    if (once) return report;
  }
}
