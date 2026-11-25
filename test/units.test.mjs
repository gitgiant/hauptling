import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db.mjs';
import * as mail from '../src/mail.mjs';
import { githubSlug, identityFor, parseArgs, wslPath, shellLine } from '../src/util.mjs';
import { checkTier, effortFor, launchArgv, loadModels, nextVendor, pick, setPrefer, table } from '../src/models.mjs';
import { spendLine } from '../src/usage.mjs';
import { detect, fill } from '../src/detect.mjs';
import { parseJunit } from '../src/junit.mjs';
import { hookOutput, managedFiles, prepare } from '../src/vendors.mjs';
import { toastXml } from '../src/platform/toast.mjs';
import { collectArtifacts } from '../src/runner.mjs';

const SID = '3f9a2c1e-0000-4000-8000-000000000001';

test('identities and args', () => {
  assert.equal(identityFor('claude', 'claude-haiku-5-5', SID), 'claude_haiku-5-5_3f9a2');
  assert.equal(identityFor('codex', 'gpt-5.5', SID), 'codex_gpt-5.5_3f9a2c1e000040008000000000000001');
  assert.throws(() => parseArgs(['--sha', '--gpu'], { bool: ['gpu'] }), /--sha needs a value/);
  assert.deepEqual(parseArgs(['--x=--y']), { _: [], x: '--y' });
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

test('vendors: hook output shapes and prepare is idempotent', (t) => {
  assert.deepEqual(hookOutput('claude', 'Stop', { block: 'mail' }), { decision: 'block', reason: 'mail' });
  assert.deepEqual(hookOutput('agy', 'Stop', { block: 'mail' }), { decision: 'continue', reason: 'mail' });
  assert.deepEqual(hookOutput('agy', 'PreInvocation', { context: 'x' }), { injectSteps: [{ ephemeralMessage: 'x' }] });
  assert.equal(hookOutput('agy', 'PostToolUse', { context: 'x' }), null);
  assert.equal(hookOutput('codex', 'PostToolUse', { context: 'x' }).hookSpecificOutput.additionalContext, 'x');
  // prepare() honours these (set inside worker containers); keep the test hermetic.
  const saved = { CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, CODEX_HOME: process.env.CODEX_HOME };
  delete process.env.CLAUDE_CONFIG_DIR; delete process.env.CODEX_HOME;
  t.after(() => { for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v; });
  const home = mkdtempSync(join(tmpdir(), 'hlh-'));
  mkdirSync(join(home, '.claude'));
  writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'mine' }] }, { hooks: [{ type: 'command', command: 'hauptling hook claude Stop' }] }] }, statusLine: { type: 'command', command: 'hauptling usage claude' } }));
  mkdirSync(join(home, '.codex'));
  writeFileSync(join(home, '.codex', 'hooks.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'hauptling hook codex Stop' }] }] } }));
  for (const v of ['claude', 'codex', 'agy']) { prepare(v, '/w/x', home); prepare(v, '/w/x', home); }
  const s = JSON.parse(readFileSync(join(home, '.claude', 'settings.json'), 'utf8'));
  assert.deepEqual(s.hooks.Stop, [{ hooks: [{ type: 'command', command: 'mine' }] }], 'old Hauptling hooks removed, the user\'s kept');
  assert.equal(s.statusLine, undefined);
  assert.equal(JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8')).projects['/w/x'].hasTrustDialogAccepted, true);
  assert.equal(readFileSync(join(home, '.codex', 'config.toml'), 'utf8').match(/trust_level/g).length, 1);
  assert.deepEqual(JSON.parse(readFileSync(join(home, '.codex', 'hooks.json'), 'utf8')).hooks.Stop, []);
  const m = managedFiles();
  const claude = JSON.parse(m['/etc/claude-code/managed-settings.json']);
  assert.equal(claude.allowManagedHooksOnly, true);
  assert.equal(claude.hooks.Stop[0].hooks[0].command, 'hauptling hook claude Stop');
  assert.equal(claude.statusLine.command, 'hauptling usage claude');
  assert.equal(JSON.parse(m['/etc/codex/hooks.json']).hooks.PostToolUse[0].hooks[0].command, 'hauptling hook codex PostToolUse');
  assert.match(m['/etc/codex/requirements.toml'], /^allow_managed_hooks_only = true$/m);
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

test('egress allowlist: exact hosts, *.subdomains, comments', async () => {
  const { allowed, parseAllow } = await import('../src/egress.mjs');
  const rules = parseAllow('# c\nGitHub.com\n*.anthropic.com  # api\n\n');
  assert.equal(allowed(rules, 'github.com'), true);
  assert.equal(allowed(rules, 'api.github.com'), false);
  assert.equal(allowed(rules, 'api.anthropic.com'), true);
  assert.equal(allowed(rules, 'anthropic.com'), false);
  assert.equal(allowed(rules, 'evilanthropic.com'), false);
  assert.equal(allowed(rules, 'example.com'), false);
});

test('prefer caps the worker tier: above it only with allowTier; rule mode clamps; cheapest unaffected', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'hl-')), 'models.json');
  writeFileSync(file, JSON.stringify({ order: ['claude'] }));
  setPrefer('cheap', file);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).order, ['claude'], 'other overrides kept');
  const cfg = loadModels(file);
  const opus = cfg.vendors.claude.models.find(m => m.tier === 3);
  assert.throws(() => checkTier(cfg, 'claude', opus), /--allow-tier/);
  assert.equal(checkTier(cfg, 'claude', opus, true), opus);
  assert.equal(pick(cfg, 'claude', 'rule', 'hard').tier, 1);
  assert.equal(pick(cfg, 'claude', 'cheapest').tier, 1);
  assert.match(table(cfg).split('\n')[0], /prefer: cheap/);
  assert.throws(() => setPrefer('free', file), /prefer must be/);
});

test('spend line: a window that reset mid-task or had no reading at launch shows no delta', () => {
  const line = spendLine({
    usage: { tokens_in: 1.5e6, tokens_out: 4e4, cost_usd: 1.2, cost_estimated: true },
    start: { '5h': { used_pct: 10, resets_at: 'A' }, week: { used_pct: 50, resets_at: 'W' } },
    now: { '5h': { used_pct: 3, resets_at: 'B' }, week: { used_pct: 53.4, resets_at: 'W' }, day: { used_pct: 9, resets_at: 'D' } },
    rounds: 2,
  });
  assert.equal(line, '1.5M in/40k out tok · ~$1.20 · week +3 · 2 test rounds');
});

test('effort: spawn override > model entry > tier default; vendors without effortArgs refuse an override', () => {
  const cfg = loadModels(join(tmpdir(), 'none.json'));
  const sonnet = cfg.vendors.claude.models.find(m => m.tier === 2);
  assert.equal(effortFor(cfg, 'claude', sonnet), 'medium');
  assert.equal(effortFor(cfg, 'claude', { ...sonnet, effort: 'high' }), 'high');
  assert.equal(effortFor(cfg, 'claude', sonnet, 'max'), 'max');
  assert.equal(effortFor(cfg, 'agy', cfg.vendors.agy.models[0]), null);
  assert.throws(() => effortFor(cfg, 'agy', cfg.vendors.agy.models[0], 'low'), /model ids carry the effort/);
  const argv = launchArgv(cfg, 'codex', cfg.vendors.codex.models[0], 'go', 'low');
  assert.ok(argv.includes('model_reasoning_effort="low"'));
  assert.equal(argv.at(-1), 'go');
});
