import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { installMod } from '../src/setup.mjs';
import { IMAGE_INPUTS } from '../src/docker.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

// A `claude` that keeps marketplaces and plugins in a JSON file and logs every call.
const FAKE = `#!${process.execPath}
const fs = require('node:fs');
const file = process.env.FAKE_STATE, args = process.argv.slice(2);
const s = JSON.parse(fs.readFileSync(file, 'utf8'));
s.calls.push(args.join(' '));
const [, a, b, c] = args;
let out = '';
if (a === '--help') out = 'Commands:\\n  list [options]\\n' + (s.old ? '' : '  test [dir]   Run a mod\\'s tests\\n');
else if (a === 'marketplace' && b === 'list') out = JSON.stringify(s.markets);
else if (a === 'marketplace' && b === 'add') s.markets = [{ name: 'hauptling', source: 'directory', path: c }];
else if (a === 'list') out = JSON.stringify(s.plugins);
else if (a === 'install' && !s.broken) s.plugins.push({ id: b, scope: 'user', enabled: true });
else { process.stderr.write('boom\\n'); process.exitCode = 1; }
fs.writeFileSync(file, JSON.stringify(s));
process.stdout.write(out);
`;

function host(state = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'hl-mod-'));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'claude'), FAKE);
  chmodSync(join(bin, 'claude'), 0o755);
  const file = join(dir, 'state.json');
  writeFileSync(file, JSON.stringify({ calls: [], markets: [], plugins: [], ...state }));
  const env = { PATH: bin, HOME: dir, FAKE_STATE: file };
  const read = () => JSON.parse(readFileSync(file, 'utf8'));
  const run = (opts = {}) => installMod({ env, managed: join(dir, 'managed.json'), ...opts });
  const changes = () => read().calls.filter(c => /^plugin (marketplace add|install|enable|disable)/.test(c));
  return { dir, bin, env, file, read, run, changes };
}
const text = (lines) => lines.map(l => l[1]).join('\n');

test('first run adds the marketplace and installs the plugin; the second changes nothing', () => {
  const h = host();
  const first = h.run();
  assert.deepEqual(h.changes(), [`plugin marketplace add ${resolve(ROOT)}`, 'plugin install hauptling@hauptling --scope user']);
  assert.ok(first.every(l => l[0]), text(first));
  assert.match(text(first), /claude plugin disable hauptling@hauptling/);
  const second = h.run();
  assert.equal(h.changes().length, 2);
  assert.match(text(second), /installed and enabled/);
  assert.doesNotMatch(text(second), /Windows/);
});

test('a moved checkout is re-pointed without reinstalling', () => {
  const h = host({ markets: [{ name: 'hauptling', source: 'directory', path: '/old/hauptling' }], plugins: [{ id: 'hauptling@hauptling', scope: 'user', enabled: true }] });
  assert.match(text(h.run({ root: h.dir })), /re-pointed/);
  assert.deepEqual(h.changes(), [`plugin marketplace add ${h.dir}`]);
});

test('a disabled mod stays disabled', () => {
  const h = host({ plugins: [{ id: 'hauptling@hauptling', scope: 'user', enabled: false }] });
  assert.match(text(h.run()), /disabled and stays so/);
  assert.equal(h.changes().filter(c => !c.startsWith('plugin marketplace')).length, 0);
});

test('skips with one line when claude is missing or too old', () => {
  const none = installMod({ env: { PATH: '/nonexistent' } });
  assert.deepEqual(none, [[true, 'skipped: Claude Code is not installed here']]);
  const h = host({ old: true });
  const lines = h.run();
  assert.equal(lines.length, 1);
  assert.match(lines[0][1], /too old for mods/);
  assert.deepEqual(h.read().calls, ['plugin --help']);
});

test('a failing claude command is reported, not thrown', () => {
  const lines = host({ broken: true }).run();
  assert.equal(lines[0][0], false);
  assert.match(lines[0][1], /plugin install .* failed: boom/);
});

test('says which setting keeps the mod from loading', () => {
  const h = host();
  mkdirSync(join(h.dir, '.claude'));
  writeFileSync(join(h.dir, '.claude', 'settings.json'), '{"disableAllHooks": true}');
  writeFileSync(join(h.dir, 'managed.json'), '{"allowManagedHooksOnly": true}');
  const bad = h.run().filter(l => !l[0]);
  assert.equal(bad.length, 2, text(bad));
  assert.match(text(bad), /disableAllHooks[\s\S]*allowManagedHooksOnly/);
});

test('in WSL: ignores a Windows claude and prints the command to run on Windows', () => {
  const lines = installMod({ root: '/home/u/hauptling', env: { PATH: '/mnt/c/Users/u/npm', WSL_DISTRO_NAME: 'Ubuntu' } });
  assert.match(lines[0][1], /not installed here/);
  assert.ok(lines[1][1].includes('claude plugin install hauptling --marketplace "\\\\wsl.localhost\\Ubuntu\\home\\u\\hauptling"'), lines[1][1]);
});

// The real CLI, in an empty home with only the fake claude on PATH: setup stops at the Docker check, after the mod step.
const cliSetup = (h, ...flags) => spawnSync(process.execPath, [join(ROOT, 'bin', 'hauptling.mjs'), 'setup', '--no-host', '--no-login', ...flags],
  { encoding: 'utf8', env: { ...h.env, HAUPTLING_HOME: join(h.dir, '.hauptling') }, timeout: 60e3 });

test('`hauptling setup` installs the mod, and `--no-mod` skips it', () => {
  const skipped = host();
  const off = cliSetup(skipped, '--no-mod');
  assert.match(off.stdout, /skipped \(--no-mod\)/, off.stderr);
  assert.deepEqual(skipped.read().calls, []);
  const h = host();
  const on = cliSetup(h);
  assert.match(on.stdout, /hauptling@hauptling installed/, on.stderr);
  assert.equal(h.changes().length, 2);
});

test('the checkout is a folder marketplace offering the mod', () => {
  const market = JSON.parse(readFileSync(join(ROOT, '.claude-plugin', 'marketplace.json'), 'utf8'));
  const plugin = JSON.parse(readFileSync(join(ROOT, 'claude-mod', '.claude-plugin', 'plugin.json'), 'utf8'));
  assert.equal(market.name, 'hauptling');
  assert.deepEqual(market.plugins.map(p => [p.name, p.source]), [[plugin.name, './claude-mod']]);
});

test('the worker image does not carry the mod', () => {
  assert.ok(!IMAGE_INPUTS.some(p => /claude-mod|claude-plugin/.test(p)));
});
