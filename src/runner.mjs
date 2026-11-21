import { spawn } from 'node:child_process';
import { cpSync, existsSync, globSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { detect, fill } from './detect.mjs';
import { parseJunit } from './junit.mjs';

/*
 * Deterministic test execution (no LLM), inside a fresh test container (`hauptling test-exec`).
 * The broker has already checked the sha out at /work; this runs the detected (or hauptling.json)
 * install and test commands, reads JUnit when available, collects artifacts and writes
 * /artifacts/report.json.
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

/** Runs install + tests in `dir`; writes the log and artifacts into `out`. */
export async function execTests(dir, { selector = '', timeout_s = 1800, artifacts = [] }, out) {
  mkdirSync(out, { recursive: true });
  const log = join(out, 'test.log');
  const t0 = Date.now();
  const base = { passed: 0, failed: 0, skipped: 0, failures: [], artifacts: [], log_path: log };
  const step = async (argv, timeout) => run(argv, { cwd: dir, timeout, log });
  const finish = (report) => ({ ...report, artifacts: artifacts.length ? collectArtifacts(dir, artifacts, out) : [] });
  const cfg = detect(dir);
  if (!cfg.test) return { ...base, status: 'error', duration_s: 0, notes: 'No test command detected; add hauptling.json with "test": [argv]' };
  let r;
  if (cfg.install) {
    r = await step(cfg.install, 900);
    if (r.code !== 0) return { ...base, status: 'error', duration_s: (Date.now() - t0) / 1000, notes: `install failed (${cfg.install.join(' ')}): ${r.out.trim().split('\n').pop()}`.slice(0, 300) };
  }
  const junit = join(dir, '.hauptling-junit.xml');
  const argv = fill(cfg.test, { selector: selector || cfg.defaultSelector || '', junit });
  r = await step(argv, timeout_s);
  const duration_s = (Date.now() - t0) / 1000;
  if (r.timedOut) return finish({ ...base, status: 'timeout', duration_s, notes: `timed out after ${timeout_s}s` });
  const junitPath = cfg.junit ? cfg.junit.replaceAll('{junit}', junit) : null;
  const resolved = junitPath && !junitPath.startsWith('/') ? join(dir, junitPath) : junitPath;
  if (resolved && existsSync(resolved)) {
    const j = parseJunit(readFileSync(resolved, 'utf8'));
    const status = r.code === 0 && j.failed === 0 ? 'pass' : j.failed ? 'fail' : 'error';
    return finish({ ...base, ...j, status, duration_s, notes: status === 'error' ? `exit ${r.code} with no failing tests in JUnit` : `${cfg.source}: ${argv.join(' ')}`.slice(0, 300) });
  }
  const tail = r.out.trim().split('\n').slice(-20).join('\n');
  return finish({ ...base, status: r.code === 0 ? 'pass' : 'fail', duration_s, failures: r.code === 0 ? [] : [{ test_id: argv.join(' '), loc: '', message: `exit code ${r.code}`, excerpt: tail }], notes: 'no JUnit output; result from exit code' });
}
