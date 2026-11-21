import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { BROKER_PORT, VENDORS } from './util.mjs';
import { call, ensureBroker } from './client.mjs';
import { readBrokerFile } from './brokerfile.mjs';
import { platform } from './platform/index.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const step = (m) => console.log(`\n▶ ${m}`);
const ok = (m) => console.log(`  ✓ ${m}`);
const bad = (m) => console.log(`  ✗ ${m}`);
const slotNames = (n) => Array.from({ length: n }, (_, i) => `hl-w${i + 1}`);

/** Credential file per vendor, relative to a slot's home: present and non-empty means signed in. */
const CREDS = { claude: '.claude/.credentials.json', codex: '.codex/auth.json', agy: '.gemini/antigravity-cli/antigravity-oauth-token' };
const LOGIN = { claude: ['claude'], codex: ['codex', 'login'], agy: ['agy'] };
const LOGIN_HINT = {
  claude: 'Claude starts; sign in when it asks (or type /login), then type /exit.',
  codex: 'Codex prints a sign-in link; finish it in the browser and it exits by itself.',
  agy: 'agy starts; sign in when it asks, then exit it (/exit).',
};

/**
 * One-shot setup, safe to rerun: delegator skill, worker users and tools (sudo), broker restart,
 * sign-in for every slot × vendor without credentials, then doctor.
 */
export async function setup({ slots = 3, vendors = VENDORS, workers = true, login: doLogin = true }) {
  const plat = await platform();
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 5)) throw new Error(`Node ${process.versions.node} is too old; need 22.5+ (install.sh installs it)`);

  step('Delegator skill');
  for (const dir of [join(homedir(), '.claude', 'skills', 'delegator'), join(homedir(), '.agents', 'skills', 'delegator')]) {
    mkdirSync(dir, { recursive: true });
    cpSync(join(ROOT, 'skills', 'delegator'), dir, { recursive: true });
    ok(dir);
  }
  for (const line of plat.setupHost({ root: ROOT })) ok(line);
  gitIdentity();

  if (workers) {
    step('Workers (sudo): git, tmux, gh, vendor CLIs, hauptling, users hl-w1… and hl-test');
    plat.provisionWorkers({ slots, root: ROOT });
  }

  step('Broker');
  await restartBroker();
  await call('slots.set', { slots: slotNames(slots) });
  ok(`slots: ${slotNames(slots).join(', ')}`);

  if (doLogin) await loginMissing(plat, slotNames(slots), vendors);
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

/** Which slot × vendor pairs have credentials (checked as each slot user). */
export function logins(plat, slots, vendors) {
  return slots.flatMap(slot => {
    const r = plat.asUserSync(slot, ['sh', '-c', 'for f; do test -s "$HOME/$f" && echo "$f"; done; true', 'sh', ...vendors.map(v => CREDS[v])]);
    const have = new Set((r.stdout || '').split('\n').map(s => s.trim()));
    return vendors.map(v => ({ slot, vendor: v, ok: have.has(CREDS[v]) }));
  });
}

async function loginMissing(plat, slots, vendors) {
  step('Vendor sign-in (each slot signs in once per vendor)');
  const missing = logins(plat, slots, vendors).filter(l => !l.ok);
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
    runLogin(plat, m.slot, m.vendor);
    rl.resume();
  }
  rl.close();
}

function runLogin(plat, slot, vendor) {
  console.log(`    ${LOGIN_HINT[vendor]}`);
  const argv = plat.asUser(slot, LOGIN[vendor]);
  spawnSync(argv[0], argv.slice(1), { stdio: 'inherit' });
  logins(plat, [slot], [vendor])[0].ok ? ok(`${slot} ${vendor} signed in`) : bad(`${slot} ${vendor} still not signed in`);
}

/** Checks everything a worker needs; prints a report, returns true when all pass. */
export async function doctor({ slots, vendors = VENDORS } = {}) {
  const plat = await platform();
  step('Doctor');
  let all = true;
  const check = (cond, good, fail) => { if (cond) ok(good); else { bad(fail); all = false; } };
  const have = (bin) => spawnSync('sh', ['-c', `command -v ${bin}`]).status === 0;
  check(true, `Node ${process.versions.node}`);
  for (const bin of ['git', 'tmux', 'gh', 'hauptling', ...vendors]) check(have(bin), `has ${bin}`, `${bin} not on PATH: rerun setup`);
  check(gitGet('git', 'user.name') && gitGet('git', 'user.email'), `git identity ${gitGet('git', 'user.name')}`, 'git has no user.name/user.email: rerun setup or `git config --global`');
  try { execFileSync('gh', ['auth', 'status'], { stdio: 'ignore' }); ok('gh signed in (PRs, merges)'); }
  catch { bad('gh not signed in: run `gh auth login` (needed for GitHub repos)'); all = false; }
  let names;
  try {
    const info = await ensureBroker();
    ok(`broker on 127.0.0.1:${info.port}`);
    names = slots ? slotNames(slots) : await call('slots.get');
  } catch (e) { bad(`broker: ${e.message}`); return false; }
  for (const u of [...names, 'hl-test']) {
    const r = plat.asUserSync(u, ['true']);
    check(r.status === 0, `worker user ${u}`, `cannot run as ${u} (${(r.stderr || '').trim() || 'missing'}): rerun setup`);
  }
  const reach = plat.asUserSync(names[0], ['node', '-e', `fetch('http://127.0.0.1:${BROKER_PORT}/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))`]);
  check(reach.status === 0, 'workers reach the broker', 'workers cannot reach the broker');
  for (const l of logins(plat, names, vendors)) check(l.ok, `${l.slot} ${l.vendor} signed in`, `${l.slot} ${l.vendor} not signed in: \`hauptling login ${l.slot} ${l.vendor}\``);
  console.log(all ? '\nAll good. Start Claude, Codex or agy here and run /delegator.' : '\nFix the ✗ items above, then run `hauptling doctor` again.');
  return all;
}

/** Signs one slot in to one vendor, in this terminal. */
export async function login(slot, vendor) {
  if (!/^hl-(w\d+|test)$/.test(slot || '') || !LOGIN[vendor]) throw new Error('login <hl-wN> <claude|codex|agy>');
  runLogin(await platform(), slot, vendor);
}
