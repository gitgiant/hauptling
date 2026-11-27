import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/*
 * Test commands for a checkout. hauptling.json (optional) overrides any field:
 *   { "install": [argv], "test": [argv], "junit": "path", "gpu": [argv], "gpuMemMB": 6144, "gateGpu": false, "pushToMain": false,
 *     "testConcurrency": 1 }
 * "gpu" is the command for `test request --gpu` (never auto-detected); "gpuMemMB" the free VRAM a GPU job
 * waits for; "gateGpu" makes the merge gate run "gpu" after "test". "testConcurrency" is how many of the repo's
 * CPU test jobs may run at once at most (read from the base branch; unset: as many as the host has room for).
 * Placeholders in argv: {selector} (dropped when empty), {junit} (absolute report path).
 * Without junit the result comes from the exit code alone.
 */

const read = (p) => JSON.parse(readFileSync(p, 'utf8'));

export function detect(dir) {
  const cfgPath = join(dir, 'hauptling.json');
  const own = existsSync(cfgPath) ? read(cfgPath) : {};
  return { ...auto(dir), ...own, source: existsSync(cfgPath) ? 'hauptling.json' : 'auto' };
}

function auto(dir) {
  const has = (f) => existsSync(join(dir, f));
  if (has('package.json')) {
    const pkg = read(join(dir, 'package.json'));
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    const pm = has('pnpm-lock.yaml') ? 'pnpm' : has('yarn.lock') ? 'yarn' : 'npm';
    const install = pm === 'pnpm' ? ['pnpm', 'install', '--frozen-lockfile'] : pm === 'yarn' ? ['yarn', 'install', '--frozen-lockfile']
      : has('package-lock.json') ? ['npm', 'ci', '--no-audit', '--no-fund'] : ['npm', 'install', '--no-audit', '--no-fund'];
    const exec = pm === 'npm' ? ['npx', '--no-install'] : [pm, 'exec'];
    const script = pkg.scripts?.test || '';
    if (deps.vitest) return { install, test: [...exec, 'vitest', 'run', '--reporter=junit', '--outputFile={junit}', '{selector}'], junit: '{junit}' };
    if (/node\s+--test/.test(script)) {
      return { install, test: ['node', '--test', '--test-reporter=junit', '--test-reporter-destination={junit}', '{selector}'], junit: '{junit}' };
    }
    if (deps.jest) return { install, test: [...exec, 'jest', '--ci', '{selector}'] };
    return { install, test: [pm, 'test'] };
  }
  if (has('pyproject.toml') || has('pytest.ini') || has('setup.py') || has('requirements.txt')) {
    const install = has('requirements.txt') ? ['python3', '-m', 'pip', 'install', '-r', 'requirements.txt'] : has('pyproject.toml') ? ['python3', '-m', 'pip', 'install', '-e', '.'] : null;
    return { install, test: ['python3', '-m', 'pytest', '--junitxml={junit}', '{selector}'], junit: '{junit}' };
  }
  if (has('Cargo.toml')) return { install: null, test: ['cargo', 'test', '{selector}'] };
  if (has('go.mod')) return { install: null, test: ['go', 'test', '{selector}'], defaultSelector: './...' };
  return { install: null, test: null };
}

/** Fills placeholders; an empty selector removes its argument. Selector may hold several space-separated items. */
export function fill(argv, { selector = '', junit = '' }) {
  if (!argv) return null;
  const sel = String(selector || '').trim().split(/\s+/).filter(Boolean);
  return argv.flatMap(a => a === '{selector}' ? sel : [a.replaceAll('{junit}', junit).replaceAll('{selector}', sel.join(' '))]);
}
