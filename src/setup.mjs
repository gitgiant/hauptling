import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, symlinkSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { BROKER_PORT, VENDORS, home } from './util.mjs';
import { call, ensureBroker } from './client.mjs';
import { readBrokerFile } from './brokerfile.mjs';
import { platform } from './platform/index.mjs';
import { getBudget, keyHints } from './keys.mjs';
import { NET, PROXY, PROXY_URL, WORKER_BROKER_URL, baseImageTag, docker, dockerReady, ensureBaseImage, ensureNetwork, slotDir, config, hasGpu, gpuAvailable } from './docker.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const step = (m) => console.log(`\n▶ ${m}`);
const ok = (m) => console.log(`  ✓ ${m}`);
const bad = (m) => console.log(`  ✗ ${m}`);
const slotNames = (n) => Array.from({ length: n }, (_, i) => `hl-w${i + 1}`);

/** Credential file per vendor inside a slot dir: present and non-empty means signed in. */
const CREDS = { claude: 'claude/.credentials.json', codex: 'codex/auth.json', agy: 'gemini/antigravity-cli/antigravity-oauth-token' };
const LOGIN = { claude: ['claude'], codex: ['codex', 'login'], agy: ['agy'] };
const LOGIN_HINT = {
  claude: 'Claude starts; sign in when it asks (or type /login), then type /exit.',
  codex: 'Codex opens a sign-in page in your browser and exits by itself when done.',
  agy: 'agy starts; sign in when it asks, then exit it (/exit).',
};

/**
 * One-shot setup, safe to rerun: delegator skill, host tools + Docker (sudo), worker image,
 * network + egress proxy, broker restart, sign-in for every slot × vendor without credentials, doctor.
 */
export async function setup({ slots = 3, vendors = VENDORS, host = true, login: doLogin = true }) {
  const plat = await platform();
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 5)) throw new Error(`Node ${process.versions.node} is too old; need 22.5+ (install.sh installs it)`);

  step('Delegator skill');
  for (const dir of [join(homedir(), '.claude', 'skills', 'delegator'), join(homedir(), '.agents', 'skills', 'delegator')]) {
    mkdirSync(dir, { recursive: true });
    cpSync(join(ROOT, 'skills', 'delegator'), dir, { recursive: true });
    ok(dir);
  }
  step('Delegator usage (host status lines → hauptling; your previous status line still shows)');
  const { installStatusLines } = await import('./hoststatus.mjs');
  for (const line of installStatusLines()) ok(line);
  for (const line of plat.setupHost({ root: ROOT })) ok(line);
  gitIdentity();

  if (host) {
    step('Host (sudo): git, gh, Docker Engine, NVIDIA Container Toolkit (if a GPU), hauptling on PATH');
    const r = spawnSync('sudo', ['bash', join(ROOT, 'scripts', 'setup-host.sh'), ROOT, userInfo().username, home(), config().gpu === false ? 'nogpu' : 'gpu'], { stdio: 'inherit' });
    if (r.status !== 0) throw new Error('Host setup failed (see output above)');
  }

  step('Worker image and network');
  if (!(await dockerReady())) throw new Error('Docker is not running: `sudo service docker start` (WSL) or `sudo systemctl start docker`');
  ok(`image ${await ensureBaseImage({ log: (m) => console.log(`  … ${m}`), stdio: ['ignore', 'inherit', 'inherit'] })}`);
  await ensureNetwork({ force: true });
  ok(`network ${NET}, proxy ${PROXY} (allowlist: ~/.hauptling/egress/allow.txt)`);
  for (const s of slotNames(slots)) slotDir(s);

  step('Broker');
  await restartBroker();
  await call('slots.set', { slots: slotNames(slots) });
  ok(`slots: ${slotNames(slots).join(', ')} (credentials in ~/.hauptling/slots/)`);

  if (doLogin) await loginMissing(slotNames(slots), vendors);
  return doctor({ slots, vendors });
}

const gitGet = (bin, key) => spawnSync(bin, ['config', '--global', key], { encoding: 'utf8' }).stdout?.trim() || '';

/** Local merges commit as you: copy the Windows git identity into WSL when WSL has none. */
function gitIdentity() {
  if (gitGet('git', 'user.name') && gitGet('git', 'user.email')) return ok(`git identity: ${gitGet('git', 'user.name')}`);
  const name = gitGet('git.exe', 'user.name');
  const email = gitGet('git.exe', 'user.email');
  if (name && email) {
    execFileSync('git', ['config', '--global', 'user.name', name]);
    execFileSync('git', ['config', '--global', 'user.email', email]);
    return ok(`git identity copied from Windows: ${name}`);
  }
  bad('git has no user.name/user.email: set them with `git config --global` (local merges commit as you)');
}

async function restartBroker() {
  const info = readBrokerFile();
  if (info) {
    await fetch(`http://127.0.0.1:${info.port}/api/shutdown`, { method: 'POST', headers: { authorization: `Bearer ${info.adminToken}` } }).catch(() => {});
    await new Promise(r => setTimeout(r, 500));
  }
  const i = await ensureBroker();
  ok(`broker ${i.pid} on 127.0.0.1:${i.port}`);
}

/**
 * Per slot × vendor: signed in, or covered by an API key (`hauptling key set`), which every slot shares.
 * A key with a monthly budget covers nothing on its own: spawns fall back to the sign-ins once it is used up.
 */
export const logins = (slots, vendors) => {
  const keys = keyHints();
  const signedIn = (slot, v) => spawnSync('test', ['-s', join(slotDir(slot), CREDS[v])]).status === 0;
  return slots.flatMap(slot => vendors.map(v => (keys[v] && !getBudget(v) ? { slot, vendor: v, ok: true, key: keys[v] }
    : { slot, vendor: v, ok: signedIn(slot, v), ...(keys[v] ? { key: keys[v], budget: getBudget(v) } : {}) })));
};

async function loginMissing(slots, vendors) {
  step('Vendor sign-in (each slot signs in once per vendor; kept across containers)');
  const missing = logins(slots, vendors).filter(l => !l.ok);
  if (!missing.length) return ok('every slot is signed in to every vendor');
  if (!process.stdin.isTTY) {
    for (const m of missing) bad(`${m.slot} ${m.vendor}: run \`hauptling login ${m.slot} ${m.vendor}\``);
    return;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  for (const m of missing) {
    const answer = (await rl.question(`  ${m.slot} → ${m.vendor}: sign in now? [Y/n/q] `)).trim().toLowerCase();
    if (answer === 'q') break;
    if (answer === 'n') continue;
    rl.pause();
    runLogin(m.slot, m.vendor);
    rl.resume();
  }
  rl.close();
}

/**
 * Signs a slot in on the host (browser OAuth callbacks reach the host, not containers), with each
 * vendor's config pointed at the slot's credentials dir.
 */
function runLogin(slot, vendor) {
  console.log(`    ${LOGIN_HINT[vendor]}`);
  const dir = slotDir(slot);
  const env = { ...process.env };
  if (vendor === 'claude') env.CLAUDE_CONFIG_DIR = join(dir, 'claude');
  if (vendor === 'codex') env.CODEX_HOME = join(dir, 'codex');
  if (vendor === 'agy') {
    const fake = join(dir, 'agy-home');
    mkdirSync(fake, { recursive: true });
    if (!existsSync(join(fake, '.gemini'))) symlinkSync(join(dir, 'gemini'), join(fake, '.gemini'));
    env.HOME = fake;
  }
  spawnSync(LOGIN[vendor][0], LOGIN[vendor].slice(1), { stdio: 'inherit', env, cwd: dir });
  logins([slot], [vendor])[0].ok ? ok(`${slot} ${vendor} signed in`) : bad(`${slot} ${vendor} still not signed in`);
}

/** Runs a shell snippet in a throwaway worker container on the internal network. */
const probe = (script) => docker(['run', '--rm', '--network', NET, '-e', `HTTPS_PROXY=${PROXY_URL}`, '-e', `https_proxy=${PROXY_URL}`, baseImageTag(), 'sh', '-c', script], { timeout: 60e3 })
  .then(r => r.stdout.trim(), e => `ERR ${e.message}`);

/** Checks everything a worker needs; prints a report, returns true when all pass. */
export async function doctor({ slots, vendors = VENDORS } = {}) {
  step('Doctor');
  let all = true;
  const check = (cond, good, fail) => { if (cond) ok(good); else { bad(fail); all = false; } };
  const have = (bin) => spawnSync('sh', ['-c', `command -v ${bin}`]).status === 0;
  check(true, `Node ${process.versions.node}`);
  for (const bin of ['git', 'gh', 'docker', 'hauptling', ...vendors]) check(have(bin), `has ${bin}`, `${bin} not on PATH: rerun setup`);
  check(gitGet('git', 'user.name') && gitGet('git', 'user.email'), `git identity ${gitGet('git', 'user.name')}`, 'git has no user.name/user.email: rerun setup or `git config --global`');
  try {
    execFileSync('gh', ['auth', 'status'], { stdio: 'ignore' });
    execFileSync('gh', ['auth', 'setup-git'], { stdio: 'ignore' }); // git push uses the gh login too
    ok('gh signed in (PRs, merges, git push)');
  }
  catch { bad('gh not signed in: run `gh auth login` (needed for GitHub repos)'); all = false; }
  const dv = await dockerReady();
  check(dv, `Docker ${dv}`, 'Docker not reachable: start it (`sudo service docker start`) or open a new terminal after setup added you to the docker group');
  if (!dv) return report(all);
  const tag = baseImageTag();
  const hasImage = await docker(['image', 'inspect', tag]).then(() => true, () => false);
  check(hasImage, `image ${tag}`, `image ${tag} not built: rerun setup`);
  const proxyUp = (await docker(['inspect', '-f', '{{.State.Running}}', PROXY]).then(r => r.stdout.trim(), () => '')) === 'true';
  check(proxyUp, `egress proxy ${PROXY} running`, `${PROXY} not running: rerun setup`);
  let names;
  try {
    const info = await ensureBroker();
    ok(`broker on 127.0.0.1:${info.port}`);
    const dash = await fetch(`http://127.0.0.1:${info.port}/`).then(r => r.status, () => 0);
    check(dash === 401 || dash === 200, `dashboard at http://127.0.0.1:${info.port}/ (open it: hauptling dashboard)`, `dashboard not served (HTTP ${dash}): restart the broker (\`hauptling broker stop\`)`);
    names = slots ? slotNames(slots) : await call('slots.get');
  } catch (e) { bad(`broker: ${e.message}`); return report(false); }
  if (hasImage && proxyUp) {
    const out = await probe(`node -e "fetch('${WORKER_BROKER_URL}/health').then(r=>console.log('broker', r.status),()=>console.log('broker fail'))"; `
      + `curl -s -o /dev/null -w 'allowed %{http_code}\\n' https://api.anthropic.com/ ; curl -s -o /dev/null -w 'blocked %{http_code}\\n' https://example.com/ ; true`);
    check(/broker 200/.test(out), 'containers reach the broker (via egress relay)', `containers cannot reach the broker: ${out.split('\n')[0]}`);
    check(/allowed [1-5]\d\d/.test(out), 'egress allows vendor APIs', `egress to api.anthropic.com failed: ${out}`);
    check(/blocked 000/.test(out) || /blocked 403/.test(out), 'egress blocks other hosts', `example.com was reachable: ${out}`);
  }
  if (config().gpu === false) ok('GPU: disabled in ~/.hauptling/config.json');
  else if (!hasGpu()) ok('GPU: none (GPU tests disabled)');
  else if (!(await gpuAvailable())) { bad('GPU found but Docker has no NVIDIA runtime: rerun setup (installs the NVIDIA Container Toolkit)'); all = false; }
  else if (hasImage) {
    const smi = await docker(['run', '--rm', '--gpus', 'all', baseImageTag(), 'nvidia-smi', '-L'], { timeout: 90e3 }).then(r => r.stdout.trim(), e => `ERR ${e.message}`);
    check(/^GPU \d/m.test(smi), `GPU in containers: ${smi.split('\n')[0].replace(/ \(UUID.*\)/, '')}`, `GPU container check failed: ${smi.slice(0, 200)}`);
  }
  for (const [v, h] of Object.entries(keyHints())) {
    if (!h || !vendors.includes(v)) continue;
    const b = getBudget(v);
    ok(b ? `${v}: API key ${h} first, up to $${b.usd} a month (resets on day ${b.resets_on}), then the slots' sign-ins`
      : `${v}: API key ${h} (billed per token; every slot uses it — \`hauptling key rm ${v}\` to go back to sign-ins)`);
  }
  for (const l of logins(names, vendors)) if (!l.key || l.budget) check(l.ok, `${l.slot} ${l.vendor} signed in`, `${l.slot} ${l.vendor} not signed in: \`hauptling login ${l.slot} ${l.vendor}\` (or \`hauptling key set ${l.vendor}\`)`);
  return report(all);
}

function report(all) {
  console.log(all ? '\nAll good. Start Claude, Codex or agy here and run /delegator.' : '\nFix the ✗ items above, then run `hauptling doctor` again.');
  return all;
}

/** Signs one slot in to one vendor, in this terminal. */
export async function login(slot, vendor, { force = false } = {}) {
  if (!/^hl-w\d+$/.test(slot || '') || !LOGIN[vendor]) throw new Error('login <hl-wN> <claude|codex|agy>');
  // Refresh tokens rotate: signing in while a worker of this vendor runs on the slot can sign that worker out.
  const busy = force ? null : (await call('agents', { all: true }).catch(() => []))
    .find(a => a.slot === slot && a.vendor === vendor && ['spawning', 'working', 'blocked', 'done'].includes(a.state));
  if (busy) throw new Error(`${busy.id} is running on ${slot} with this ${vendor} sign-in; signing in again now could sign it out mid-task. Wait until it ends (or kill it), or pass --force.`);
  runLogin(slot, vendor);
}
export { BROKER_PORT };
