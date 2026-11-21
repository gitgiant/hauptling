import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db.mjs';
import * as mail from '../src/mail.mjs';
import { githubSlug, identityFor, parseArgs, wslPath, shellLine } from '../src/util.mjs';
import { launchArgv, loadModels, nextVendor, pick } from '../src/models.mjs';
import { detect, fill } from '../src/detect.mjs';
import { parseJunit } from '../src/junit.mjs';
import { hookOutput, prepare } from '../src/vendors.mjs';
import { toastXml } from '../src/platform/toast.mjs';
import { collectArtifacts } from '../src/runner.mjs';

const SID = '3f9a2c1e-0000-4000-8000-000000000001';

test('identities and args', () => {
  assert.equal(identityFor('claude', 'claude-haiku-5-5', SID), 'claude_haiku-5-5_3f9a2');
  assert.equal(identityFor('codex', 'gpt-5.5', SID), 'codex_gpt-5.5_3f9a2c1e000040008000000000000001');
  assert.deepEqual(parseArgs(['a', '--choice', 'x', '--choice', 'y', '--test-writer', '--model=m'], { repeat: ['choice'], bool: ['test-writer'] }),
    { _: ['a'], choice: ['x', 'y'], testWriter: true, model: 'm' });
  assert.equal(wslPath('C:\\Users\\g\\repo'), '/mnt/c/Users/g/repo');
  assert.equal(githubSlug('gitgiant/hauptling'), 'gitgiant/hauptling');
  assert.equal(githubSlug('https://github.com/gitgiant/hauptling.git'), 'gitgiant/hauptling');
  assert.equal(githubSlug('C:\\Users\\g\\repo'), null);
  assert.equal(shellLine(['echo', "it's"]), `'echo' 'it'\\''s'`);
});

test('mailbox: register, send, broadcast, take once, upgrade, prune', () => {
  const db = openDb(':memory:');
  const a = mail.register(db, 'claude', SID, 'unknown', 'nullpunkt');
  assert.equal(a, 'claude_unknown_3f9a2');
  const b = mail.register(db, 'codex', '11111111-2222-4333-8444-555555555555', 'gpt-5.5');
  assert.deepEqual(mail.send(db, b, '3f9a2', 'hello'), [a]);
  const upgraded = mail.register(db, 'claude', SID, 'claude-opus-5-5');
  assert.equal(upgraded, 'claude_opus-5-5_3f9a2');
  const got = mail.take(db, upgraded);
  assert.equal(got.length, 1);
  assert.match(got[0], /^\[11111111222243338444555555555555 \d\d:\d\d\] hello$/);
  assert.deepEqual(mail.take(db, upgraded), []);
  assert.deepEqual(mail.send(db, upgraded, 'codex', 'all codex'), [b]);
  assert.throws(() => mail.send(db, upgraded, b, 'x'.repeat(301)), /1–300/);
  mail.setStatus(db, upgraded, 'working: thing');
  assert.deepEqual(mail.peers(db), ['claude_opus-5-5_3f9a2 [nullpunkt]: working: thing']);
  assert.deepEqual(mail.prune(db, 12, Date.now() + 13 * 3600e3), ['codex_gpt-5.5_11111111222243338444555555555555']);
  assert.deepEqual(mail.prune(db, 12, Date.now() + 73 * 3600e3), ['claude_opus-5-5_3f9a2']);
});

test('models: pick, round robin, launch argv', () => {
  const cfg = loadModels(join(tmpdir(), 'none.json'));
  const db = openDb(':memory:');
  assert.deepEqual([1, 2, 3, 4].map(() => nextVendor(db, cfg)), ['claude', 'codex', 'agy', 'claude']);
  assert.equal(pick(cfg, 'claude', 'cheapest').id, 'haiku-5-5');
  assert.equal(pick(cfg, 'claude', 'rule', 'hard').tier, 3);
  assert.throws(() => pick(cfg, 'claude', 'suggest'), /--model/);
  const codexHigh = { id: 'x', model: 'gpt-6.2-astra', args: ['-c', 'model_reasoning_effort="high"'] };
  const argv = launchArgv(cfg, 'codex', codexHigh, 'Read brief');
  assert.deepEqual(argv.slice(0, 3), ['codex', '-c', 'model_reasoning_effort="high"']);
  assert.equal(argv.at(-1), 'Read brief');
});

test('detect + fill + junit', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hl-'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'node --test test/' } }));
  writeFileSync(join(dir, 'package-lock.json'), '{}');
  const cfg = detect(dir);
  assert.deepEqual(cfg.install, ['npm', 'ci', '--no-audit', '--no-fund']);
  assert.deepEqual(fill(cfg.test, { selector: '', junit: '/j.xml' }), ['node', '--test', '--test-reporter=junit', '--test-reporter-destination=/j.xml']);
  assert.deepEqual(fill(cfg.test, { selector: 'a.test.mjs b.test.mjs', junit: '/j' }).slice(-2), ['a.test.mjs', 'b.test.mjs']);
  writeFileSync(join(dir, 'hauptling.json'), JSON.stringify({ test: ['make', 'check'] }));
  assert.deepEqual(detect(dir).test, ['make', 'check']);
  const j = parseJunit(`<testsuites><testsuite><testcase classname="m" name="ok"/><testcase name="bad" file="a.js" line="3"><failure message="expected 1 &amp; got 2">AssertionError
  at a.js:3:1</failure></testcase><testcase name="s"><skipped/></testcase></testsuite></testsuites>`);
  assert.deepEqual([j.passed, j.failed, j.skipped], [1, 1, 1]);
  assert.equal(j.failures[0].message, 'expected 1 & got 2');
  assert.equal(j.failures[0].loc, 'a.js:3');
});

test('vendors: hook output shapes and prepare is idempotent', () => {
  assert.deepEqual(hookOutput('claude', 'Stop', { block: 'mail' }), { decision: 'block', reason: 'mail' });
  assert.deepEqual(hookOutput('agy', 'Stop', { block: 'mail' }), { decision: 'continue', reason: 'mail' });
  assert.deepEqual(hookOutput('agy', 'PreInvocation', { context: 'x' }), { injectSteps: [{ ephemeralMessage: 'x' }] });
  assert.equal(hookOutput('agy', 'PostToolUse', { context: 'x' }), null);
  assert.equal(hookOutput('codex', 'PostToolUse', { context: 'x' }).hookSpecificOutput.additionalContext, 'x');
  const home = mkdtempSync(join(tmpdir(), 'hlh-'));
  mkdirSync(join(home, '.claude'));
  writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'mine' }] }] } }));
  for (const v of ['claude', 'codex', 'agy']) { prepare(v, '/w/x', home); prepare(v, '/w/x', home); }
  const s = JSON.parse(readFileSync(join(home, '.claude', 'settings.json'), 'utf8'));
  assert.equal(s.hooks.Stop.length, 2);
  assert.equal(JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8')).projects['/w/x'].hasTrustDialogAccepted, true);
  assert.equal(readFileSync(join(home, '.codex', 'config.toml'), 'utf8').match(/trust_level/g).length, 1);
  assert.equal(JSON.parse(readFileSync(join(home, '.codex', 'hooks.json'), 'utf8')).hooks.SessionStart.length, 1);
  const agy = JSON.parse(readFileSync(join(home, '.gemini', 'config', 'hooks.json'), 'utf8'));
  assert.equal(agy['hauptling-Stop'].Stop[0].command, 'hauptling hook agy Stop');
  assert.deepEqual(JSON.parse(readFileSync(join(home, '.gemini', 'antigravity-cli', 'settings.json'), 'utf8')).permissions.allow, ['command(hauptling)']);
});

test('toast xml: up to 4 choices plus Other, buttons open answer-page links', () => {
  const page = 'http://127.0.0.1:47800/ask/7?k=abc';
  const x = toastXml({ title: 'a', body: 'x < y', choices: ['1', '2', '3', '4', '5'], links: { page, choice: (i) => `${page}&choice=${i}` } });
  assert.equal((x.match(/<action /g) || []).length, 5);
  assert.match(x, /ask\/7\?k=abc&amp;choice=3/);
  assert.match(x, /content="Other…"[^>]*arguments="http:\/\/127\.0\.0\.1:47800\/ask\/7\?k=abc"/);
  assert.match(x, /x &lt; y/);
});

test('artifacts: globs relative to the checkout, no escaping it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hla-'));
  mkdirSync(join(dir, 'out'));
  writeFileSync(join(dir, 'out', 'a.png'), 'x');
  writeFileSync(join(dir, 'out', 'b.txt'), 'y');
  const dest = join(dir, '..', `${dir.split('/').pop()}-art`);
  const got = collectArtifacts(dir, ['out/*.png', '../*', '/etc/passwd'], dest);
  assert.deepEqual(got, [join(dest, 'out', 'a.png')]);
});
