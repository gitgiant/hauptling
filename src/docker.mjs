import { execFile, execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, cpSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, rmSync, statSync, writeFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { BROKER_PORT, home, shellLine } from './util.mjs';
import { workerKeyEnv } from './keys.mjs';
import { INSTALL_TIMEOUT_S } from './vendors.mjs';
import * as codegraph from './codegraph.mjs';
import * as sessions from './sessions.mjs';

/*
 * Where workers run: a fresh Docker container per task.
 *   - clone on the host in ~/.hauptling/work/<agent>, bind-mounted at /work (git stays host-side)
 *   - only the agent's vendor dir(s) from the slot's credentials ~/.hauptling/slots/<slot>/<dir>, mounted at
 *     /home/worker/.vendor/<dir> (a slot runs one worker per vendor; vendors never see each other's tokens)
 *   - internal network `hauptling-int` (no route out); `hauptling-egress` is the only exit
 *     (CONNECT proxy with allowlist) and relays the broker port to the host
 *   - tmux inside the container runs the vendor TUI; attach with `docker exec -it … tmux attach`
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const NET = 'hauptling-int';
export const PROXY = 'hauptling-egress';
export const PROXY_URL = `http://${PROXY}:3128`;
export const WORKER_BROKER_URL = `http://${PROXY}:${BROKER_PORT}`;
const uid = () => `${process.getuid()}:${process.getgid()}`;
/** Local test jobs whose container has been started: id → { at: start ms, art: artifacts dir }. */
const testRuns = new Map();
const testContainer = (id) => `hauptling-test-${String(id).replace(/[^a-zA-Z0-9_-]/g, '-')}`;
export const container = (id) => `hl-${String(id).replace(/[^a-zA-Z0-9_-]/g, '-')}`;

/** Whether this process can use the Docker socket directly (else go through `sg docker`). */
export function hasDockerGroup() {
  try {
    const line = readFileSync('/etc/group', 'utf8').split('\n').find(l => l.startsWith('docker:'));
    return Boolean(line) && process.getgroups().includes(Number(line.split(':')[2]));
  } catch { return false; }
}
/** argv for docker; uses `sg docker` right after setup added you to the group (until you log in again). */
export const dockerArgv = (args) => (hasDockerGroup() || process.getuid() === 0 ? ['docker', ...args] : ['sg', 'docker', '-c', shellLine(['docker', ...args])]);

export function docker(args, { input, timeout = 120e3 } = {}) {
  const argv = dockerArgv(args);
  return new Promise((resolve, reject) => {
    const child = execFile(argv[0], argv.slice(1), { timeout, maxBuffer: 32 << 20 }, (err, stdout, stderr) => {
      if (err) { err.message = `docker ${args[0]}: ${(stderr || err.message).trim().slice(-800)}`; err.stdout = stdout; reject(err); }
      else resolve({ stdout, stderr });
    });
    if (input !== undefined) child.stdin.end(input);
  });
}

export function config() {
  const p = join(home(), 'config.json');
  const c = existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : {};
  return { memory: '2560m', cpus: 3, gpu: true, gpuMemory: '6g', gpuCpus: 4, gpuMemMB: 6144, gpuWaitMinutes: 30, testConcurrency: 2, maxWorkers: 6, testStallSec: 300, testRetries: 2, ...c };
}

// ---------- GPU (phase 3) ----------
/** nvidia-smi on PATH, or WSL's copy (the Windows driver exposes it there). */
let smiPath; // probed once per process: the probe is a synchronous spawn
const nvidiaSmi = () => (smiPath !== undefined ? smiPath : (smiPath = ['nvidia-smi', '/usr/lib/wsl/lib/nvidia-smi'].find(b => { try { execFileSync(b, ['-L'], { stdio: 'ignore', timeout: 15e3 }); return true; } catch { return false; } }) || null));
export const hasGpu = () => Boolean(nvidiaSmi());

/** Free VRAM in MiB on the first GPU (your desktop shares it), or null when unknown. */
export function gpuFreeMB() {
  const bin = nvidiaSmi();
  if (!bin) return Promise.resolve(null);
  return new Promise((resolve) => execFile(bin, ['--query-gpu=memory.free', '--format=csv,noheader,nounits'], { timeout: 15e3 }, (err, out) => {
    const n = parseInt(String(out).split('\n')[0], 10);
    resolve(err || Number.isNaN(n) ? null : n);
  }));
}

/** GPU utilization % of the first GPU (for the dashboard's load graph), or null. */
export function gpuUtil() {
  const bin = nvidiaSmi();
  if (!bin) return Promise.resolve(null);
  return new Promise((resolve) => execFile(bin, ['--query-gpu=utilization.gpu', '--format=csv,noheader,nounits'], { timeout: 15e3 }, (err, out) => {
    const n = parseInt(String(out).split('\n')[0], 10);
    resolve(err || Number.isNaN(n) ? null : n);
  }));
}

/** GPU tests are on: not disabled in config, a GPU on the host, and Docker has the NVIDIA runtime. */
export async function gpuAvailable() {
  if (config().gpu === false || !hasGpu()) return false;
  const r = await docker(['info', '--format', '{{json .Runtimes}}'], { timeout: 20e3 }).catch(() => null);
  return Boolean(r && /nvidia/.test(r.stdout));
}

export const DEFAULT_ALLOW = `# Hosts worker containers may reach (one per line; "*.example.com" matches subdomains).
# Blocked attempts are logged to ~/.hauptling/egress/egress.log. Changes apply within seconds.
anthropic.com
*.anthropic.com
claude.ai
*.claude.ai
claude.com
*.claude.com
openai.com
*.openai.com
chatgpt.com
*.chatgpt.com
googleapis.com
*.googleapis.com
accounts.google.com
oauth2.googleapis.com
antigravity.google
*.antigravity.google
github.com
*.github.com
*.githubusercontent.com
registry.npmjs.org
*.npmjs.org
registry.yarnpkg.com
pypi.org
files.pythonhosted.org
crates.io
*.crates.io
proxy.golang.org
sum.golang.org
archive.ubuntu.com
security.ubuntu.com
deb.nodesource.com
`;

// ---------- images ----------

function walk(dir, out = []) {
  for (const name of readdirSync(dir).sort()) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out); else out.push(p);
  }
  return out;
}

function agyBinary() {
  try {
    const p = execFileSync('sh', ['-c', 'command -v agy'], { encoding: 'utf8' }).trim();
    return p ? realpathSync(p) : null;
  } catch { return null; }
}

/** Golden image tag: hash of hauptling's own files, the Dockerfile and the agy binary. */
export function baseImageTag() {
  const h = createHash('sha256');
  for (const f of ['bin', 'src', 'skills', 'docker', 'models.json', 'package.json'].flatMap(p => (statSync(join(ROOT, p)).isDirectory() ? walk(join(ROOT, p)) : [join(ROOT, p)]))) {
    h.update(f.slice(ROOT.length)); h.update(readFileSync(f));
  }
  const agy = agyBinary();
  if (agy) h.update(`${agy}:${statSync(agy).size}:${statSync(agy).mtimeMs}`);
  return `hauptling-worker:${h.digest('hex').slice(0, 12)}`;
}

const imageExists = async (tag) => docker(['image', 'inspect', tag], { timeout: 30e3 }).then(() => true, () => false);

export async function ensureBaseImage({ log = () => {}, stdio } = {}) {
  const tag = baseImageTag();
  if (await imageExists(tag)) return tag;
  const ctx = join(home(), 'build', 'worker');
  rmSync(ctx, { recursive: true, force: true });
  mkdirSync(join(ctx, 'hauptling'), { recursive: true });
  for (const p of ['bin', 'src', 'skills', 'models.json', 'package.json']) cpSync(join(ROOT, p), join(ctx, 'hauptling', p), { recursive: true });
  const agy = agyBinary();
  if (agy) cpSync(agy, join(ctx, 'agy'));
  else writeFileSync(join(ctx, 'agy'), '#!/bin/sh\necho "agy is not installed in this image (install the Antigravity CLI on the host and rerun setup)" >&2\nexit 127\n');
  cpSync(join(ROOT, 'docker', 'worker.Dockerfile'), join(ctx, 'Dockerfile'));
  log(`building ${tag} (first time takes a few minutes)`);
  const argv = dockerArgv(['build', '-t', tag, '-t', 'hauptling-worker:latest', ctx]);
  await new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), { stdio: stdio || ['ignore', 'ignore', 'pipe'] });
    let err = '';
    child.stderr?.on('data', d => { err = (err + d).slice(-4000); });
    child.on('exit', code => (code === 0 ? resolve() : reject(new Error(`image build failed: ${err.trim().split('\n').slice(-5).join(' | ')}`))));
  });
  return tag;
}

/** Image for a checkout: its hauptling.Dockerfile (FROM ${BASE}) built on the golden image, else the golden image. */
export async function imageFor(dir, opts) {
  const base = await ensureBaseImage(opts);
  const file = join(dir, 'hauptling.Dockerfile');
  if (!existsSync(file)) return base;
  const tag = `hauptling-repo:${createHash('sha256').update(base).update(readFileSync(file)).digest('hex').slice(0, 12)}`;
  if (await imageExists(tag)) return tag;
  await docker(['build', '-f', file, '--build-arg', `BASE=${base}`, '-t', tag, dir], { timeout: 1800e3 });
  return tag;
}

// ---------- network + egress proxy ----------

/**
 * The internal network and the egress proxy. Concurrent callers share one run (two spawns at once used
 * to both recreate the proxy and collide on its name). A running proxy on an older image is kept while
 * worker or test containers use it (replacing it cuts their network); it is updated on the next call
 * with nothing running, or with `force` (setup).
 */
let ensuring = null;
export function ensureNetwork(opts = {}) {
  ensuring ||= ensureNetworkOnce(opts).finally(() => { ensuring = null; });
  return ensuring;
}

async function ensureNetworkOnce({ log = () => {}, force = false, dk = docker, baseImage = () => ensureBaseImage({ log }) } = {}) {
  if (!(await dk(['network', 'inspect', NET]).then(() => true, () => false))) {
    await dk(['network', 'create', '--internal', NET]).catch(async (e) => {
      if (!(await dk(['network', 'inspect', NET]).then(() => true, () => false))) throw e; // created meanwhile by another process: fine
    });
    log(`created network ${NET}`);
  }
  const dir = join(home(), 'egress');
  mkdirSync(dir, { recursive: true });
  if (!existsSync(join(dir, 'allow.txt'))) writeFileSync(join(dir, 'allow.txt'), DEFAULT_ALLOW);
  const image = await baseImage();
  const info = await dk(['inspect', '-f', '{{.State.Running}} {{.Config.Image}}', PROXY]).then(r => r.stdout.trim(), () => '');
  if (info === `true ${image}`) return { proxy: 'current' };
  if (info.startsWith('true ') && !force) {
    const users = (await dk(['ps', '-q', '--filter', 'label=hauptling.agent']).then(r => r.stdout, () => '')).trim()
      + (await dk(['ps', '-q', '--filter', 'label=hauptling.test']).then(r => r.stdout, () => '')).trim();
    if (users) { log(`${PROXY} runs an older image; keeping it while containers use it`); return { proxy: 'kept' }; }
  }
  await dk(['rm', '-f', PROXY]).catch(() => {});
  try {
    await dk(['run', '-d', '--name', PROXY, '--restart', 'unless-stopped', '--init', '--user', uid(),
      '--add-host', 'host.docker.internal:host-gateway', '-v', `${dir}:/egress`, '--label', 'hauptling=egress',
      image, 'hauptling', 'egress', '--allow', '/egress/allow.txt', '--log', '/egress/egress.log', '--relay', `host.docker.internal:${BROKER_PORT}`]);
  } catch (e) {
    // Another process (setup, a second broker command) started it first: accept theirs if it runs our image.
    const now = await dk(['inspect', '-f', '{{.State.Running}} {{.Config.Image}}', PROXY]).then(r => r.stdout.trim(), () => '');
    if (now === `true ${image}`) return { proxy: 'current' };
    throw e;
  }
  await dk(['network', 'connect', '--alias', PROXY, NET, PROXY]);
  log(`started ${PROXY}`);
  return { proxy: 'started' };
}

/**
 * `docker run` env for every container on the internal network (workers, test jobs, sign-ins, doctor probes).
 * NODE_USE_ENV_PROXY: Node's built-in fetch (undici: corepack's first-use download, other Node tools) ignores
 * HTTPS_PROXY without it, and containers have no DNS.
 */
export const proxyEnv = () => ['HTTPS_PROXY', 'HTTP_PROXY', 'https_proxy', 'http_proxy'].flatMap(k => ['-e', `${k}=${PROXY_URL}`])
  .concat(['-e', `NO_PROXY=${PROXY},localhost,127.0.0.1`, '-e', `no_proxy=${PROXY},localhost,127.0.0.1`, '-e', 'NODE_USE_ENV_PROXY=1']);

/** Last `token_count` payload of the newest rollout log under these session roots written since `since` (ISO), or null. */
async function codexRollout(roots, since) {
  const t0 = Date.parse(since || 0) || 0;
  let newest = null;
  const days = [];
  for (const root of roots.filter(existsSync)) {
    const mine = [];
    for (const y of readdirSync(root).sort().reverse().slice(0, 2)) for (const m of readdirSync(join(root, y)).sort().reverse().slice(0, 2)) for (const d of readdirSync(join(root, y, m)).sort().reverse().slice(0, 3)) mine.push(join(root, y, m, d));
    days.push(...mine.slice(0, 3));
  }
  for (const dir of days) {
    for (const f of readdirSync(dir)) {
      if (!f.startsWith('rollout-') || !f.endsWith('.jsonl')) continue;
      const st = statSync(join(dir, f));
      if (st.mtimeMs >= t0 && (!newest || st.mtimeMs > newest.mtime)) newest = { path: join(dir, f), mtime: st.mtimeMs, size: st.size };
    }
  }
  if (!newest) return null;
  const { lastTokenCount } = await import('./usage.mjs');
  const fd = openSync(newest.path, 'r');
  try {
    const len = Math.min(newest.size, 512 << 10);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, newest.size - len);
    return lastTokenCount(buf.toString('utf8'));
  } finally { closeSync(fd); }
}

/** Each vendor's config dirs inside a slot (and inside a worker, under /home/worker/.vendor). */
export const VENDOR_DIRS = { claude: ['claude'], codex: ['codex', 'codex-key'], agy: ['gemini'] };

export function slotDir(slot) {
  const d = join(home(), 'slots', slot);
  for (const v of Object.values(VENDOR_DIRS).flat()) mkdirSync(join(d, v), { recursive: true });
  return d;
}

/** `-v` flags mounting only this vendor's dirs from the slot: a codex worker on hl-w2 never sees hl-w2's Claude token. */
export function vendorMounts(slot, vendor) {
  const dirs = VENDOR_DIRS[vendor];
  if (!dirs) throw new Error(`Unknown vendor ${vendor}`);
  const d = slotDir(slot);
  return dirs.flatMap(v => ['-v', `${join(d, v)}:/home/worker/.vendor/${v}`]);
}

// ---------- worker host (what core.mjs drives) ----------

/**
 * `docker run` args for a task container: its own clone at /work, its own /home/worker (container-local),
 * and only its vendor's credentials dir(s) from the slot, so workers of other vendors can share the slot.
 */
export function workerRunArgs({ slot, id, dir, vendor, env = {}, apiKey = false, mcpFile, image, limits = config() }) {
  const git = { GIT_AUTHOR_NAME: `hauptling ${slot}`, GIT_AUTHOR_EMAIL: `${slot}@hauptling.local`, GIT_COMMITTER_NAME: `hauptling ${slot}`, GIT_COMMITTER_EMAIL: `${slot}@hauptling.local` };
  return ['run', '-d', '--name', container(id), '--init', '--user', uid(), '--network', NET,
    '--memory', String(limits.memory), '--cpus', String(limits.cpus), '--label', `hauptling.agent=${id}`, '--label', `hauptling.slot=${slot}`, '--label', `hauptling.vendor=${vendor}`,
    '-v', `${dir}:/work`, ...vendorMounts(slot, vendor), '-v', `${mcpFile}:/etc/claude-code/managed-mcp.json:ro`, ...proxyEnv(),
    ...Object.entries({ ...env, ...(apiKey ? workerKeyEnv(vendor) : {}), ...git }).flatMap(([k, v]) => ['-e', `${k}=${v}`]),
    image, 'sleep', 'infinity'];
}

const mcpPath = (id) => join(home(), 'mcp', `${id}.json`);
const sessionStore = (id) => join(home(), 'sessions', String(id).replace(/[^a-zA-Z0-9_-]/g, '-'));

export function dockerHost({ log = () => {}, docker: dockerCmd = docker } = {}) {
  const exec = (id, args, opts) => docker(['exec', container(id), ...args], opts);
  const workRoot = join(home(), 'work');

  /** Runs argv on the host (clones, git); `user` is ignored: the clone belongs to you. */
  function run(_slot, argv, { env = {}, input, timeout = 600e3 } = {}) {
    return new Promise((resolve, reject) => {
      const child = execFile(argv[0], argv.slice(1), { timeout, maxBuffer: 16 << 20, env: { ...process.env, ...env } }, (err, stdout, stderr) => {
        if (err) { err.message = `${argv[0]} failed: ${(stderr || err.message).trim().slice(-600)}`; err.stdout = stdout; reject(err); }
        else resolve({ stdout, stderr });
      });
      if (input !== undefined) child.stdin.end(input);
    });
  }

  const cliCommand = ({ argv, resumeArgv }) => {
    const fresh = `exec ${shellLine(argv)}`;
    return resumeArgv ? `${shellLine(resumeArgv)} || ${fresh}` : fresh;
  };

  async function startTui(id, opts) {
    await exec(id, ['tmux', 'new-session', '-d', '-s', 'main', '-x', '220', '-y', '50', '-c', '/work', cliCommand(opts)]);
    await exec(id, ['tmux', 'set-option', '-t', 'main', 'remain-on-exit', 'on']).catch(() => {});
  }

  async function workerState(id) {
    try {
      const { stdout } = await docker(['container', 'inspect', '--format', '{{.State.Status}}', container(id)]);
      return stdout.trim();
    } catch (e) {
      if (/No such (container|object)/i.test(e.message)) return 'missing';
      throw e;
    }
  }

  // ---------- test jobs ----------
  function jobPaths(job) {
    const name = job.attempt > 1 ? `${job.id}.${job.attempt}` : job.id;
    const dir = join(home(), 'jobs', name);
    return { dir, art: `${dir}-artifacts` };
  }
  /** Past this (timeout_s plus install time) after the container started, the job fails as a timeout. */
  const hardCapMs = (job) => ((job.timeout_s || 1800) + 1200) * 1000;
  const failed = (job, notes, extra = {}) => ({ id: job.id, sha: job.sha, status: 'error', passed: 0, failed: 0, skipped: 0, failures: [], artifacts: [], duration_s: 0, log_path: join(jobPaths(job).art, 'test.log'), notes: notes.slice(0, 300), ...extra });
  /** The runner's report.json, or null while it is missing or half written. */
  function readReport(art) {
    try { return JSON.parse(readFileSync(join(art, 'report.json'), 'utf8')); } catch { return null; }
  }
  /** The runner's report with host paths; drops the job's checkout. */
  function finished(job, report) {
    const { dir, art } = jobPaths(job);
    rmSync(dir, { recursive: true, force: true });
    const hostPath = (p) => (p && p.startsWith('/artifacts') ? join(art, p.slice('/artifacts'.length)) : p);
    return { ...report, id: job.id, sha: job.sha, log_path: hostPath(report.log_path), artifacts: (report.artifacts || []).map(hostPath) };
  }
  /**
   * Waits for the job's container (`launch` resolves to its id), reads the report, removes the container.
   * Removal is by id: a later attempt reuses the name.
   */
  async function collect(job, startedAt, launch) {
    const { art } = jobPaths(job);
    const live = { at: Date.now(), art };
    testRuns.set(job.id, live);
    let id = null;
    let error = null;
    try {
      id = await launch();
      const { stdout } = await dockerCmd(['wait', id], { timeout: Math.max(30e3, startedAt + hardCapMs(job) - Date.now()) });
      if (!readReport(art)) {
        const logs = await dockerCmd(['logs', '--tail', '5', id]).then(r => `${r.stdout}${r.stderr || ''}`.trim(), () => '');
        error = new Error(`exit ${stdout.trim()}${logs ? `: ${logs}` : ''}`);
      }
    } catch (e) { error = e; }
    try {
      const report = readReport(art);
      if (report) return finished(job, report);
      // Past the hard cap: fail as a timeout, never rerun.
      if (error.killed) return failed(job, `test container timed out: ${error.message}`, { status: 'timeout' });
      return failed(job, `test container failed: ${error.message}`, { lost: `container ended without a result: ${error.message}`.slice(0, 200) });
    } finally {
      await dockerCmd(['rm', '-f', id || testContainer(job.id)]).catch(() => {});
      if (testRuns.get(job.id) === live) testRuns.delete(job.id);
    }
  }

  return {
    kind: 'docker',
    workRoot,
    run,
    async startWorker({ slot, id, dir, vendor, argv, resumeArgv, env, apiKey = false, mcp = { mcpServers: {} }, codegraphCache = null }) {
      await ensureNetwork({ log });
      const image = await imageFor(dir, { log });
      const c = config();
      // Claude's managed MCP list (exclusive: the repo's own .mcp.json servers stay out unless copied in).
      const mcpFile = mcpPath(id);
      mkdirSync(dirname(mcpFile), { recursive: true });
      writeFileSync(mcpFile, JSON.stringify(mcp, null, 2));
      if (codegraphCache) codegraph.seed(codegraphCache, dir);
      await docker(['rm', '-f', container(id)]).catch(() => {});
      await docker(workerRunArgs({ slot, id, dir, vendor, env, apiKey, mcpFile, image, limits: c }));
      // Also installs the repo's dependencies (through the proxy; a failure is noted in the brief, never fatal).
      await exec(id, ['hauptling', 'prepare', vendor, '/work'], { timeout: (INSTALL_TIMEOUT_S + 120) * 1000 });
      if (codegraphCache) {
        // Before the agent starts, so the saved index is the base commit's. A failure only costs the index.
        const t0 = Date.now();
        try { await exec(id, codegraph.SETUP, { timeout: 1800e3 }); codegraph.save(dir, codegraphCache); log(`codegraph ${id}: index ready in ${Math.round((Date.now() - t0) / 1000)} s`); }
        catch (e) { log(`codegraph ${id}: ${e.message}`); }
      }
      await startTui(id, { argv, resumeArgv });
    },
    pauseWorker: (_slot, id) => docker(['pause', container(id)], { timeout: 15e3 }),
    async unpauseWorker(_slot, id) {
      try { await docker(['unpause', container(id)], { timeout: 15e3 }); }
      catch (e) { if (await workerState(id) !== 'running') throw e; }
    },
    async restartWorker(opts) {
      const { id } = opts;
      const state = await workerState(id);
      if (state === 'paused') await docker(['unpause', container(id)]);
      else if (state !== 'running') return false;
      // Check the saved tmux session inside the container. If only tmux died, recreate it there.
      const { stdout } = await exec(id, ['sh', '-c', 'tmux has-session -t main 2>/dev/null && echo yes || echo no']);
      if (stdout.trim() === 'yes') {
        await exec(id, ['tmux', 'respawn-pane', '-k', '-t', 'main:', '-c', '/work', cliCommand(opts)]);
      } else await startTui(id, opts);
      return true;
    },
    async tmuxAlive(_slot, id) {
      try { return (await exec(id, ['tmux', 'display-message', '-p', '-t', 'main:', '#{pane_dead}'], { timeout: 15e3 })).stdout.trim() === '0'; } catch { return false; }
    },
    async tmuxCapture(_slot, id, lines = 20) {
      return (await exec(id, ['tmux', 'capture-pane', '-p', '-t', 'main:', '-S', `-${lines}`], { timeout: 15e3 })).stdout;
    },
    /** Visible pane with colour codes (web terminal frames). */
    async tmuxScreen(_slot, id) {
      return (await exec(id, ['tmux', 'capture-pane', '-p', '-e', '-t', 'main:'], { timeout: 5e3 })).stdout;
    },
    /** Raw send-keys args (web terminal input): ['-l', text] or [keyName]. */
    async tmuxKeys(_slot, id, args) {
      await exec(id, ['tmux', 'send-keys', '-t', 'main:', ...args], { timeout: 5e3 });
    },
    async tmuxType(_slot, id, text) {
      await exec(id, ['tmux', 'send-keys', '-t', 'main:', '-l', String(text).replace(/\s*\n\s*/g, ' ')], { timeout: 15e3 });
      await new Promise(r => setTimeout(r, 300));
      await exec(id, ['tmux', 'send-keys', '-t', 'main:', 'Enter'], { timeout: 15e3 });
    },
    async stopWorker(_slot, id, { paused = false } = {}) {
      if (paused) await docker(['unpause', container(id)]).catch(() => {});
      await docker(['rm', '-f', container(id)]).catch(() => {});
      rmSync(mcpPath(id), { force: true });
    },
    attachArgv: (_slot, id) => dockerArgv(['exec', '-it', container(id), 'tmux', 'attach', '-t', 'main']),
    // Parked workers (PRD "Parking"): the vendor session transcript, copied between a slot and ~/.hauptling/sessions/<agent>/.
    saveSession: ({ slot, vendor, id, sessionId }) => sessions.saveSession({ slotRoot: slotDir(slot), store: sessionStore(id), vendor, sessionId }),
    restoreSession: ({ slot, vendor, id, billing }) => sessions.restoreSession({ slotRoot: slotDir(slot), store: sessionStore(id), vendor, billing }),
    dropSession: (id) => sessions.dropSession(sessionStore(id)),

    /**
     * Runs one test job: checkout on the host, tests in a fresh detached container; returns the report. A
     * container that ends without a report (removed, crashed, docker failed) gives an error report with `lost`
     * set: the broker's watchdog reruns those. Each attempt gets its own checkout and artifacts dir.
     */
    async runTestJob(job, { env = {} } = {}) {
      const { dir, art } = jobPaths(job);
      rmSync(dir, { recursive: true, force: true });
      rmSync(art, { recursive: true, force: true });
      mkdirSync(art, { recursive: true });
      try {
        await run(null, ['git', 'clone', '--quiet', '--no-checkout', job.url, dir], { env });
        await run(null, ['git', '-C', dir, 'checkout', '--quiet', '--detach', job.sha]);
      } catch (e) { return failed(job, `checkout failed: ${e.message}`); }
      await ensureNetwork({ log });
      const image = await imageFor(dir, { log });
      const c = config();
      const limits = job.gpu ? ['--gpus', 'all', '--memory', String(c.gpuMemory), '--cpus', String(c.gpuCpus)] : ['--memory', String(c.memory), '--cpus', String(c.cpus)];
      return collect(job, Date.now(), async () => {
        await dockerCmd(['rm', '-f', testContainer(job.id)]).catch(() => {});
        // Detached and without --rm, so the container and its result outlive a broker restart.
        const { stdout } = await dockerCmd(['run', '-d', '--init', '--name', testContainer(job.id), '--user', uid(), '--network', NET, ...limits,
          '--label', `hauptling.test=${job.id}`, '-v', `${dir}:/work`, '-v', `${art}:/artifacts`, ...proxyEnv(),
          image, 'hauptling', 'test-exec', ...(job.gpu ? ['--gpu'] : []), '--selector', job.selector || '', '--timeout', String(job.timeout_s || 1800), '--artifacts', JSON.stringify(job.artifacts || [])],
        { timeout: hardCapMs(job) });
        return stdout.trim();
      });
    },

    /**
     * Broker start: `{ collect() }` for a job whose container from before the restart still runs or whose
     * report is written; null when there is no result to recover.
     */
    async adoptTestJob(job) {
      const { art } = jobPaths(job);
      let found = null;
      try {
        const [id, status, startedAt] = (await dockerCmd(['inspect', '-f', '{{.Id}} {{.State.Status}} {{.State.StartedAt}}', testContainer(job.id)], { timeout: 20e3 })).stdout.trim().split(' ');
        found = { id, status, startedAt: Date.parse(startedAt) || Date.now() };
      } catch (e) { if (!readReport(art) && !/no such (object|container)/i.test(e.message)) throw e; }
      if (found && ['running', 'paused', 'restarting'].includes(found.status)) return { collect: () => collect(job, found.startedAt, async () => found.id) };
      if (!readReport(art)) return null;
      return {
        collect: async () => {
          const report = finished(job, readReport(art));
          if (found) await dockerCmd(['rm', '-f', found.id]).catch(() => {});
          return report;
        },
      };
    },

    /**
     * Watchdog probe for a running job: `preparing` (checkout or image build, no container yet), `done`
     * (report written), `running`, `exited` or `gone` (container state), `unknown` (docker didn't answer);
     * `activity` is the latest of the container start, its test.log and the runner's heartbeat (ms).
     */
    async testLiveness(id) {
      const live = testRuns.get(id);
      if (!live) return { state: 'preparing' };
      if (existsSync(join(live.art, 'report.json'))) return { state: 'done' };
      const mtime = (f) => { try { return statSync(join(live.art, f)).mtimeMs; } catch { return 0; } };
      const activity = Math.max(live.at, mtime('heartbeat'), mtime('test.log'));
      let state;
      try { state = (await dockerCmd(['inspect', '-f', '{{.State.Status}}', testContainer(id)], { timeout: 20e3 })).stdout.trim(); } catch (e) { state = /no such (object|container)/i.test(e.message) ? 'gone' : 'unknown'; }
      if (existsSync(join(live.art, 'report.json'))) return { state: 'done' };
      if (state === 'gone' && Date.now() - live.at < 60e3) state = 'running'; // `docker run` may not have created it yet
      return { state: ['created', 'running', 'restarting', 'paused'].includes(state) ? 'running' : ['gone', 'unknown'].includes(state) ? state : 'exited', activity };
    },
    testWatchdog: () => { const c = config(); return { stallSec: c.testStallSec, retries: c.testRetries }; },

    /** `gpu pause --now`: stop a running test job's container (the broker has already requeued it). */
    async killTestJob(id) { await dockerCmd(['rm', '-f', testContainer(id)]).catch(() => {}); },
    /** Broker start: remove test containers left from before a restart, except those of the `keep` jobs. */
    async removeTestContainers(keep = []) {
      const lines = (await dockerCmd(['ps', '-a', '--filter', 'label=hauptling.test', '--format', '{{.ID}} {{.Label "hauptling.test"}}'])).stdout.split('\n');
      const ids = lines.map(l => l.trim().split(' ')).filter(([id, job]) => id && !keep.includes(job)).map(([id]) => id);
      if (ids.length) await dockerCmd(['rm', '-f', ...ids]);
    },
    gpuAvailable, gpuFreeMB, gpuUtil,
    /** Last `token_count` payload of the newest Codex session log in the slot written since `since` (ISO), or null. */
    async codexUsage(slot, since) {
      // codex: subscription sign-in; codex-key: API key mode (separate CODEX_HOME).
      return codexRollout(['codex', 'codex-key'].map(h => join(slotDir(slot), h, 'sessions')), since);
    },
    /** The same for the host's own Codex (a Codex delegator; token economy). */
    async hostCodexUsage(since) {
      return codexRollout([join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'sessions')], since);
    },
    gpuConfig: () => { const c = config(); return { memMB: c.gpuMemMB, waitMinutes: c.gpuWaitMinutes }; },
    testConcurrency: () => config().testConcurrency,
    maxWorkers: () => config().maxWorkers,

    /** argv for an interactive sign-in in a throwaway container with the slot's credentials for this vendor. */
    loginArgv(slot, vendor, vendorArgv) {
      return dockerArgv(['run', '--rm', '-it', '--init', '--user', uid(), '--network', NET, ...vendorMounts(slot, vendor), ...proxyEnv(), baseImageTag(), ...vendorArgv]);
    },
  };
}

export const dockerReady = () => docker(['info', '--format', '{{.ServerVersion}}'], { timeout: 20e3 }).then(r => r.stdout.trim(), () => null);
export { dirname };
