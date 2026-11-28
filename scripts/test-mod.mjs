#!/usr/bin/env node
// `npm run test:mod`: checks the Claude CLI mod (claude-mod/, PRD "Claude CLI mod") with Claude Code's own tools,
// `claude plugin validate` and `claude plugin test`. Skips cleanly where `claude` is not installed, and skips
// the tests where Claude Code has hooks modules turned off (a Hauptling worker's managed settings do).
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MOD = join(dirname(fileURLToPath(import.meta.url)), '..', 'claude-mod');
const claude = (...args) => spawnSync('claude', args, { encoding: 'utf8', shell: process.platform === 'win32' });

const version = claude('--version');
if (version.error || version.status !== 0) {
  console.log('test:mod skipped: claude is not installed');
  process.exit(0);
}

const validate = claude('plugin', 'validate', MOD);
if (validate.status !== 0) {
  process.stdout.write(validate.stdout + validate.stderr);
  console.error('test:mod: claude plugin validate failed');
  process.exit(1);
}
console.log('claude plugin validate: passed');

const tests = claude('plugin', 'test', MOD);
const out = tests.stdout + tests.stderr;
if (/hooks modules are turned off/.test(out)) {
  console.log(`test:mod: claude plugin test skipped: ${out.trim().replace(/^claude plugin test:\s*/, '')}`);
  process.exit(0);
}
process.stdout.write(out);
process.exit(tests.status ?? 1);
