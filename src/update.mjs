import { execFile, spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { IMAGE_INPUTS } from './docker.mjs';
import { home } from './util.mjs';

/*
 * Updating this checkout to origin/main (PRD "Update from the dashboard"). The broker and `hauptling update`
 * share it. The image build and the broker restart run as new processes, so they run the code just merged.
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const MAX_COMMITS = 50;

const gitIn = (root) => (args) => new Promise((resolve, reject) => {
  // No terminal to answer a password prompt: fail instead of hanging.
  execFile('git', ['-C', root, ...args], { timeout: 120e3, maxBuffer: 8 << 20, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }, (err, stdout, stderr) => {
    if (err) reject(new Error(`git ${args[0]}: ${(stderr || err.message).trim()}`)); else resolve(stdout.trimEnd());
  });
});

/** Runs this checkout's CLI and waits for it; unless `stdio` shows its output, a failure carries the last of it. */
export function runCli(args, { root = ROOT, stdio = 'pipe' } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(root, 'bin', 'hauptling.mjs'), ...args], { stdio });
    let tail = '';
    for (const s of [child.stdout, child.stderr]) s?.on('data', d => { tail = (tail + d).slice(-4000); });
    child.on('error', reject);
    child.on('close', code => (code === 0 ? resolve() : reject(new Error(tail.trim().split('\n').slice(-5).join(' | ') || `hauptling ${args.join(' ')} exited with ${code}`))));
  });
}

/** `hauptling broker restart`, detached: it outlives the broker it stops. Resolves once it has started. */
function restartDetached(root) {
  return new Promise((resolve, reject) => {
    mkdirSync(home(), { recursive: true });
    const out = openSync(join(home(), 'broker.log'), 'a'); // why a restart failed, if it does
    const child = spawn(process.execPath, [join(root, 'bin', 'hauptling.mjs'), 'broker', 'restart'], { detached: true, stdio: ['ignore', out, out] });
    closeSync(out);
    child.on('error', reject);
    child.on('spawn', () => { child.unref(); resolve(); });
  });
}

/**
 * `build` rebuilds the worker image, `restart` restarts the broker, `announce(from, to)` tells the delegators.
 * `restartTimeoutMs`: how long a process that asked for a restart may live on before that counts as failed.
 */
export function createUpdater({ root = ROOT, git = gitIn(root), build = () => runCli(['image'], { root }), restart = () => restartDetached(root),
  announce = async () => {}, log = () => {}, clock = Date.now, cacheMs = 60e3, restartTimeoutMs = 60e3 } = {}) {
  let fetched = null; // { at, done: Promise }
  let report = null;
  let progress = null; // { phase: 'pulling'|'building image'|'restarting'|'failed', from, to, error? }
  let busy = false;
  const listeners = new Set();
  const set = (p) => { progress = p; for (const f of listeners) f(p); };

  function fetchMain(force) {
    if (!force && fetched && clock() - fetched.at < cacheMs) return fetched.done;
    const f = { at: clock(), done: git(['fetch', '--quiet', 'origin', '+refs/heads/main:refs/remotes/origin/main']) };
    f.done.catch(() => { if (fetched === f) fetched = null; });
    fetched = f;
    return f.done;
  }

  /** The checkout against origin/main, plus the full ids and changed files `start` needs. */
  async function inspect(force) {
    await fetchMain(force);
    const [head, main, branch, status] = await Promise.all([
      git(['rev-parse', 'HEAD']), git(['rev-parse', 'refs/remotes/origin/main']),
      git(['rev-parse', '--abbrev-ref', 'HEAD']), git(['status', '--porcelain', '--untracked-files=no']),
    ]);
    const [counts, subjects, current, latest] = await Promise.all([
      git(['rev-list', '--left-right', '--count', `${head}...${main}`]), git(['log', '--format=%s', `--max-count=${MAX_COMMITS}`, `${head}..${main}`]),
      git(['rev-parse', '--short', head]), git(['rev-parse', '--short', main]),
    ]);
    const [ahead, behind] = counts.split(/\s+/).map(Number);
    const files = status.split('\n').filter(Boolean).map(l => l.slice(3));
    report = { current, latest, behind, ahead, dirty: files.length > 0, branch, commits: subjects ? subjects.split('\n') : [] };
    return { report, head, main, files };
  }

  const check = async () => (await inspect(false)).report;

  function refusal({ report: r, files }) {
    if (r.branch !== 'main') return r.branch === 'HEAD' ? 'the checkout is not on a branch (detached HEAD), not main' : `on branch ${r.branch}, not main`;
    if (files.length) return `uncommitted changes in ${files.slice(0, 3).join(', ')}${files.length > 3 ? ` and ${files.length - 3} more files` : ''}`;
    if (r.ahead && r.behind) return `main has diverged from origin/main (${r.ahead} ahead, ${r.behind} behind)`;
    if (r.ahead) return `main is ahead of origin/main by ${r.ahead} commit${r.ahead === 1 ? '' : 's'}`;
    return null;
  }

  async function apply(from, to, head, main) {
    try {
      set({ phase: 'pulling', from, to });
      await git(['merge', '--ff-only', '--quiet', main]);
      if (await git(['diff', '--name-only', head, main, '--', ...IMAGE_INPUTS])) {
        set({ phase: 'building image', from, to });
        try { await build(); } catch (e) {
          // Back to the old commit, so the update can be tried again.
          const undone = await git(['reset', '--quiet', '--keep', head]).then(() => `the checkout is back at ${from}`, (r) => `the checkout stays at ${to} (${r.message})`);
          throw new Error(`image build failed, ${undone}: ${e.message}`);
        }
      }
      log(`updated ${from} → ${to}`);
      await Promise.resolve().then(() => announce(from, to)).catch(e => log(`update: delegators not told: ${e.message}`));
      set({ phase: 'restarting', from, to });
      await restart().catch(e => { throw new Error(`updated to ${to}, but the restart failed (run \`hauptling broker restart\`): ${e.message}`); });
      setTimeout(() => fail(from, to, `updated to ${to}, but the broker did not restart; run \`hauptling broker restart\``), restartTimeoutMs).unref();
    } catch (e) { fail(from, to, e.message); }
  }

  function fail(from, to, error) {
    busy = false;
    log(`update ${from} → ${to}: ${error}`);
    set({ phase: 'failed', from, to, error });
  }

  /**
   * Checks that an update can run and claims it. Throws why not; `{ upToDate }` when there is nothing to do;
   * else `{ from, to, commits, run }`, where `run()` does it (never rejects: see `status()`).
   */
  async function start() {
    if (busy) throw new Error('An update is already running');
    busy = true;
    let found;
    try {
      found = await inspect(true);
      const why = refusal(found);
      if (why) throw new Error(`Not updating: ${why}`);
    } catch (e) { busy = false; throw e; }
    const { report: r, head, main } = found;
    if (!r.behind) { busy = false; return { upToDate: true, current: r.current }; }
    return { from: r.current, to: r.latest, commits: r.commits, run: () => apply(r.current, r.latest, head, main) };
  }

  return {
    check, start,
    status: () => progress,
    /** For the dashboard's dot: what the last check found on main that isn't here, else null. */
    available: () => (report?.behind ? { behind: report.behind, latest: report.latest } : null),
    onChange: (f) => { listeners.add(f); },
  };
}
