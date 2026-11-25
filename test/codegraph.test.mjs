import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SERVER, cacheDir, enabled, mcpConfig, save, seed } from '../src/codegraph.mjs';

test('mcpConfig: CodeGraph plus allowlisted repo servers only; unknown names reported', () => {
  assert.deepEqual(mcpConfig({ codegraph: true }).config, { mcpServers: { codegraph: SERVER } });
  assert.deepEqual(mcpConfig({ codegraph: false }).config, { mcpServers: {} });
  const repoMcp = { mcpServers: { a: { command: 'a' }, b: { command: 'b' }, codegraph: { command: 'evil' } } };
  const r = mcpConfig({ codegraph: true, repoCfg: { mcp: ['a', 'codegraph', 'zz'] }, repoMcp });
  assert.deepEqual(r.config.mcpServers, { codegraph: SERVER, a: { command: 'a' } });
  assert.deepEqual(r.missing, ['zz']);
  assert.equal(enabled({}), true);
  assert.equal(enabled({ codegraph: false }), false);
});

test('cacheDir: one directory per repo, safe names', () => {
  assert.match(cacheDir('gitgiant/demo'), /codegraph[\\/]gitgiant_demo$/);
  assert.match(cacheDir('https://github.com/gitgiant/demo.git'), /codegraph[\\/]gitgiant_demo$/);
  assert.match(cacheDir('/home/me/work/My Repo'), /codegraph[\\/]home_me_work_My_Repo$/);
});

test('seed/save: the index round-trips between cache and clone, kept out of git', () => {
  const root = mkdtempSync(join(tmpdir(), 'hl-cg-'));
  const clone = join(root, 'clone');
  const cache = join(root, 'cache');
  mkdirSync(join(clone, '.git', 'info'), { recursive: true });
  assert.equal(seed(cache, clone), false); // no cache yet: the worker builds the index
  assert.equal(readFileSync(join(clone, '.codegraph', '.gitignore'), 'utf8'), '*\n');
  assert.match(readFileSync(join(clone, '.git', 'info', 'exclude'), 'utf8'), /\.codegraph\//);
  writeFileSync(join(clone, '.codegraph', 'codegraph.db'), 'DB1');
  writeFileSync(join(clone, '.codegraph', 'other'), 'x');
  assert.equal(save(clone, cache), true);
  assert.equal(readFileSync(join(cache, 'codegraph.db'), 'utf8'), 'DB1');
  assert.equal(existsSync(join(cache, 'other')), false);
  const clone2 = join(root, 'clone2');
  mkdirSync(clone2);
  assert.equal(seed(cache, clone2), true);
  assert.equal(readFileSync(join(clone2, '.codegraph', 'codegraph.db'), 'utf8'), 'DB1');
});
