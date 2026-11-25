import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HOME = mkdtempSync(join(tmpdir(), 'hl-keys-'));
process.env.HAUPTLING_HOME = HOME;
const keys = await import('../src/keys.mjs');
const { prepare } = await import('../src/vendors.mjs');
const { logins } = await import('../src/setup.mjs');

const KEY = 'sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

test('key store: set (600), hint, list, remove; rejects junk', () => {
  assert.throws(() => keys.setKey('claude', 'short'), /does not look like an API key/);
  assert.throws(() => keys.setKey('gpt', KEY), /Unknown vendor/);
  assert.equal(keys.setKey('claude', `  ${KEY}\n`).hint, '…6789');
  assert.equal(statSync(join(HOME, 'keys', 'claude')).mode & 0o777, 0o600);
  assert.equal(statSync(join(HOME, 'keys')).mode & 0o777, 0o700);
  assert.equal(keys.getKey('claude'), KEY);
  assert.deepEqual(keys.keyHints(), { claude: '…6789', codex: null, agy: null });
  assert.deepEqual(keys.workerKeyEnv('claude'), { ANTHROPIC_API_KEY: KEY });
  assert.deepEqual(keys.workerKeyEnv('codex', 'sk-proj-x'), { OPENAI_API_KEY: 'sk-proj-x', CODEX_HOME: '/home/worker/.vendor/codex-key' }, 'codex keeps the ChatGPT sign-in untouched');
  assert.deepEqual(keys.workerKeyEnv('agy'), {}, 'no key → sign-in as before');
  assert.equal(keys.removeKey('claude').removed, true);
  assert.equal(keys.getKey('claude'), null);
});

test('logins: a key covers every slot of its vendor', () => {
  keys.setKey('codex', 'sk-proj-0123456789abcdefghij');
  const l = logins(['hl-w8', 'hl-w9'], ['codex', 'claude']);
  assert.deepEqual(l.filter(x => x.vendor === 'codex').map(x => [x.ok, x.key]), [[true, '…ghij'], [true, '…ghij']]);
  assert.ok(l.filter(x => x.vendor === 'claude').every(x => !x.key && x.ok === false), 'no key, no sign-in → not ok');
  keys.removeKey('codex');
});

test('prepare in key mode: Claude key pre-approved + onboarding skipped; Codex key stored in its own home', () => {
  const cfg = join(HOME, 'slot', 'claude');
  mkdirSync(cfg, { recursive: true });
  writeFileSync(join(cfg, '.claude.json'), JSON.stringify({ customApiKeyResponses: { approved: [], rejected: [KEY.slice(-20)] } }));
  prepare('claude', '/work', HOME, { env: { CLAUDE_CONFIG_DIR: cfg, ANTHROPIC_API_KEY: KEY } });
  const st = JSON.parse(readFileSync(join(cfg, '.claude.json'), 'utf8'));
  assert.deepEqual(st.customApiKeyResponses, { approved: [KEY.slice(-20)], rejected: [] });
  assert.equal(st.hasCompletedOnboarding, true);
  assert.equal(st.projects['/work'].hasTrustDialogAccepted, true);

  const codexHome = join(HOME, 'slot', 'codex-key');
  const calls = [];
  const run = (bin, argv, opts) => { calls.push([bin, ...argv, opts.input, opts.env.CODEX_HOME]); writeFileSync(join(codexHome, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: opts.input })); return { status: 0 }; };
  prepare('codex', '/work', HOME, { env: { CODEX_HOME: codexHome, OPENAI_API_KEY: 'sk-proj-key1' }, run });
  assert.deepEqual(calls, [['codex', 'login', '--with-api-key', 'sk-proj-key1', codexHome]]);
  prepare('codex', '/work', HOME, { env: { CODEX_HOME: codexHome, OPENAI_API_KEY: 'sk-proj-key1' }, run });
  assert.equal(calls.length, 1, 'same key: no second login');
  prepare('codex', '/work', HOME, { env: { CODEX_HOME: codexHome, OPENAI_API_KEY: 'sk-proj-key2' }, run });
  assert.equal(calls.length, 2, 'changed key: login again');
  assert.ok(readFileSync(join(codexHome, 'hooks.json'), 'utf8').includes('hauptling hook codex'));
  assert.throws(() => prepare('codex', '/work', HOME, { env: { CODEX_HOME: codexHome, OPENAI_API_KEY: 'sk-proj-key3' }, run: () => ({ status: 1, stderr: 'bad key' }) }), /bad key/);
});
