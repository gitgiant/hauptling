import { spawn } from 'node:child_process';
import { appendFileSync, cpSync, existsSync, globSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { detect, fill } from './detect.mjs';
import { parseJunit } from './junit.mjs';

/*
 * Deterministic test execution (no LLM), inside a fresh test container (`hauptling test-exec`).
 * The broker has already checked the sha out at /work; this runs the detected (or hauptling.json)
 * install and test commands, reads JUnit when available, collects artifacts and writes
 * /artifacts/report.json.
 */

/** A line that reports one test result: lab gate (`ok   x` / `FAIL x`), TAP (`ok 3`, `not ok 3`), node:test and mocha (✔ ✖). */
const RESULT = /^\s*(ok\b|not ok\b|FAIL\b|✔|✖|✓|✗|PASS\b)/;

/**
 * Live progress of a job, written to <out>/progress.json as output arrives (at most every `every` ms) and passed to
 * `onProgress`: { step: 'install' | 'tests', line, results: result lines seen, at }. `line` is the latest result line,
 * or before the first one the latest non-empty line.
 */
export function progressTracker(out, { onProgress = () => {}, every = 1000, now = Date.now } = {}) {
  let p = { step: 'install', line: '', results: 0, at: now() };
  let partial = ''; let last = 0;
  const emit = (force) => {
    if (!force && now() - last < every) return;
    last = now();
    p = { ...p, at: last };
    try { writeFileSync(join(out, 'progress.json'), JSON.stringify(p)); } catch {}
    onProgress(p);
  };
  return {
    step(step) { p = { ...p, step, line: '', results: 0 }; partial = ''; emit(true); },
    take(chunk) {
      const lines = (partial + chunk).split(/\r?\n|\r/);
      partial = lines.pop();
      for (const l of lines) {
        const t = l.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').trim();
        if (!t) continue;
        const result = RESULT.test(t);
        if (result) p.results++;
        if (result || !p.results) p.line = t.slice(0, 160);
      }
      emit(false);
    },
    flush() { emit(true); },
    get current() { return p; },
  };
}

function run(argv, { cwd, timeout, log, onData = () => {} }) {
  return new Promise((resolve) => {
    const started = Date.now();
    // Windows (host runner): npm & co. are .cmd shims, so go through the shell; no process groups there.
    const win = process.platform === 'win32';
    const child = win
      ? spawn(argv.map(a => (/[\s"&|<>^]/.test(a) ? `"${a.replaceAll('"', '\\"')}"` : a)).join(' '), [], { cwd, env: { ...process.env, CI: '1' }, stdio: ['ignore', 'pipe', 'pipe'], shell: true, windowsHide: true })
      : spawn(argv[0], argv.slice(1), { cwd, env: { ...process.env, CI: '1' }, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    const kill = () => { try { if (win) spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); else process.kill(-child.pid, 'SIGKILL'); } catch {} };
    let out = '';
    // The log grows as output arrives, so the watchdog and the dashboard see a live job.
    const take = (d) => { out += d; if (out.length > 4 << 20) out = out.slice(-2 << 20); try { appendFileSync(log, d); } catch {} onData(String(d)); };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; kill(); }, timeout * 1000);
    child.on('error', (e) => { out += `\n${e.message}`; });
    child.on('close', (code) => {
      clearTimeout(timer);
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

export const HEARTBEAT_MS = 30e3;

/**
 * Touches <out>/heartbeat now and every `every` ms until the returned stop() is called: the broker's
 * test watchdog takes a job whose log and heartbeat both stay unchanged for `testStallSec` as hung.
 */
export function heartbeat(out, every = HEARTBEAT_MS) {
  const beat = () => { try { writeFileSync(join(out, 'heartbeat'), `${Date.now()}\n`); } catch {} };
  beat();
  const timer = setInterval(beat, every);
  timer.unref?.();
  return () => clearInterval(timer);
}

/**
 * Runs install + tests in `dir`; writes the log, progress.json and artifacts into `out`, with a heartbeat while it
 * runs. `onProgress(p)` gets each progress update (see progressTracker).
 */
export async function execTests(dir, opts, out, { onProgress } = {}) {
  mkdirSync(out, { recursive: true });
  const stop = heartbeat(out);
  const progress = progressTracker(out, { onProgress });
  try { return await runTests(dir, opts, out, progress); } finally { stop(); progress.flush(); }
}

async function runTests(dir, { selector = '', timeout_s = 1800, artifacts = [], gpu = false }, out, progress) {
  const log = join(out, 'test.log');
  const t0 = Date.now();
  const base = { passed: 0, failed: 0, skipped: 0, failures: [], artifacts: [], log_path: log };
  const step = async (argv, timeout) => run(argv, { cwd: dir, timeout, log, onData: progress.take });
  const finish = (report) => ({ ...report, artifacts: artifacts.length ? collectArtifacts(dir, artifacts, out) : [] });
  const cfg = detect(dir);
  const testArgv = gpu ? cfg.gpu : cfg.test;
  if (!testArgv) return { ...base, status: 'error', duration_s: 0, notes: gpu ? 'No "gpu": [argv] command in hauptling.json' : 'No test command detected; add hauptling.json with "test": [argv]' };
  let r;
  if (cfg.install) {
    progress.step('install');
    r = await step(cfg.install, 900);
    if (r.code !== 0) return { ...base, status: 'error', duration_s: (Date.now() - t0) / 1000, notes: `install failed (${cfg.install.join(' ')}): ${r.out.trim().split('\n').pop()}`.slice(0, 300) };
  }
  const junit = join(dir, '.hauptling-junit.xml');
  const argv = fill(testArgv, { selector: selector || cfg.defaultSelector || '', junit });
  progress.step('tests');
  r = await step(argv, timeout_s);
  const duration_s = (Date.now() - t0) / 1000;
  if (r.timedOut) return finish({ ...base, status: 'timeout', duration_s, notes: `timed out after ${timeout_s}s` });
  const junitPath = cfg.junit ? cfg.junit.replaceAll('{junit}', junit) : null;
  const resolved = junitPath && !isAbsolute(junitPath) ? join(dir, junitPath) : junitPath;
  if (resolved && existsSync(resolved)) {
    const j = parseJunit(readFileSync(resolved, 'utf8'));
    const status = r.code === 0 && j.failed === 0 ? 'pass' : j.failed ? 'fail' : 'error';
    return finish({ ...base, ...j, status, duration_s, notes: status === 'error' ? `exit ${r.code} with no failing tests in JUnit` : `${cfg.source}: ${argv.join(' ')}`.slice(0, 300) });
  }
  const tail = r.out.trim().split('\n').slice(-20).join('\n');
  return finish({ ...base, status: r.code === 0 ? 'pass' : 'fail', duration_s, failures: r.code === 0 ? [] : [{ test_id: argv.join(' '), loc: '', message: `exit code ${r.code}`, excerpt: tail }], notes: 'no JUnit output; result from exit code' });
}
