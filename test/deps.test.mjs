import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { proxyEnv, PROXY_URL } from '../src/docker.mjs';
import { installDeps } from '../src/vendors.mjs';
import { CLONE_EXCLUDES } from '../src/core.mjs';

const envOf = (args) => Object.fromEntries(args.filter((_, i) => args[i - 1] === '-e').map(kv => [kv.slice(0, kv.indexOf('=')), kv.slice(kv.indexOf('=') + 1)]));

test('container env: proxy variables plus NODE_USE_ENV_PROXY=1 (Node fetch ignores HTTPS_PROXY without it)', () => {
  const env = envOf(proxyEnv());
  assert.equal(env.HTTPS_PROXY, PROXY_URL);
  assert.equal(env.https_proxy, PROXY_URL);
  assert.equal(env.NODE_USE_ENV_PROXY, '1');
  assert.match(env.NO_PROXY, /hauptling-egress/);
});

test('clone excludes keep the pnpm store and node_modules out of commits', () => {
  for (const p of ['.hauptling/', '.pnpm-store/', 'node_modules/']) assert.ok(CLONE_EXCLUDES.includes(p), p);
});

function clone(files) {
  const dir = mkdtempSync(join(tmpdir(), 'hl-deps-'));
  for (const [f, c] of Object.entries(files)) { mkdirSync(join(dir, f, '..'), { recursive: true }); writeFileSync(join(dir, f), c); }
  return dir;
}

test('prepare runs the detected install command in the clone and saves its log', () => {
  const dir = clone({ 'package.json': '{"scripts":{"test":"node --test"}}', 'pnpm-lock.yaml': '', '.hauptling/brief.md': '# Task\n' });
  const calls = [];
  const run = (cmd, args, opts) => { calls.push({ cmd, args, opts }); return { status: 0, stdout: 'Done in 1s\n', stderr: '' }; };
  const r = installDeps(dir, { env: { PATH: '/bin', HTTPS_PROXY: PROXY_URL, NODE_USE_ENV_PROXY: '1' }, run, timeoutS: 5 });
  assert.deepEqual(r, { status: 'ok', cmd: 'pnpm install --frozen-lockfile' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, 'pnpm');
  assert.deepEqual(calls[0].args, ['install', '--frozen-lockfile']);
  assert.equal(calls[0].opts.cwd, dir);
  assert.equal(calls[0].opts.timeout, 5000);
  assert.equal(calls[0].opts.env.NODE_USE_ENV_PROXY, '1');
  assert.match(readFileSync(join(dir, '.hauptling', 'install.log'), 'utf8'), /\$ pnpm install --frozen-lockfile\nDone in 1s/);
  assert.equal(readFileSync(join(dir, '.hauptling', 'brief.md'), 'utf8'), '# Task\n'); // success: brief untouched
});

test('hauptling.json install overrides detection; a failure is noted at the top of the brief, not thrown', () => {
  const dir = clone({ 'hauptling.json': '{"install":["make","deps"],"test":["make","test"]}', '.hauptling/brief.md': '# Task\n' });
  const run = () => ({ status: 1, stdout: '', stderr: 'line1\ngetaddrinfo EAI_AGAIN registry.npmjs.org\n' });
  const r = installDeps(dir, { env: {}, run });
  assert.equal(r.status, 'failed');
  const brief = readFileSync(join(dir, '.hauptling', 'brief.md'), 'utf8');
  assert.match(brief, /^> \*\*Dependency install failed \(exit 1\): .*EAI_AGAIN registry\.npmjs\.org.*Run `make deps` yourself/);
  assert.ok(brief.endsWith('# Task\n'));
});

test('install timeout is reported as such', () => {
  const dir = clone({ 'hauptling.json': '{"install":["sleep","99"]}', '.hauptling/brief.md': 'x' });
  const run = () => ({ status: null, signal: 'SIGKILL', stdout: '', stderr: '', error: Object.assign(new Error('spawnSync sleep ETIMEDOUT'), { code: 'ETIMEDOUT' }) });
  installDeps(dir, { env: {}, run, timeoutS: 3 });
  assert.match(readFileSync(join(dir, '.hauptling', 'brief.md'), 'utf8'), /timed out after 3 s/);
});

test('no install command: nothing runs', () => {
  const dir = clone({ 'README.md': 'hi' });
  const r = installDeps(dir, { run: () => assert.fail('ran') });
  assert.deepEqual(r, { status: 'none' });
  assert.ok(!existsSync(join(dir, '.hauptling', 'install.log')));
});

test('real spawn: install runs in the clone with the env (no stub)', () => {
  const dir = clone({ 'hauptling.json': JSON.stringify({ install: ['sh', '-c', 'echo "$NODE_USE_ENV_PROXY" > marker'] }) });
  assert.equal(installDeps(dir, { env: { PATH: process.env.PATH, NODE_USE_ENV_PROXY: '1' } }).status, 'ok');
  assert.equal(readFileSync(join(dir, 'marker'), 'utf8'), '1\n');
});
