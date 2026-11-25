import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildBody, fileIssue, issueArgv, issueRepo, scrubText } from '../src/report.mjs';
import { shouldOpenReport, trapTarget } from '../web/dashboard/report.js';

test('scrubText removes tokens, API keys, cookies and the home path', () => {
  const dash = 'Zk3_tokenValue-1234567890abcdef';
  const text = [
    `dash ${dash} in the log`,
    'key sk-ant-api03-abcdefghijklmnop1234 and AIzaSyA1234567890abcdefghijklmnopqrstuvw',
    'Cookie: hl_dash=abc123def456; other=1',
    'Authorization: Bearer abcdefgh12345678',
    'at /home/alice/.hauptling/broker.log and C:\\Users\\Bob\\x',
    'plain text stays',
  ].join('\n');
  const out = scrubText(text, [dash], '/home/alice');
  for (const bad of [dash, 'sk-ant', 'AIzaSy', 'abc123def456', 'abcdefgh12345678', 'alice', 'Bob']) assert.ok(!out.includes(bad), `${bad} leaked:\n${out}`);
  assert.match(out, /~\/\.hauptling\/broker\.log/);
  assert.match(out, /plain text stays/);
});

test('buildBody adds context only when asked', () => {
  const facts = { version: '0.1.0', commit: 'abc1234', os: 'WSL', log: ['l1', 'l2'] };
  const client = { view: 'board', tab: 'diff', agent: { id: 'a1', vendor: 'claude', state: 'working' }, viewport: '1x2', theme: 'dark' };
  const on = buildBody({ description: 'broken', client, facts });
  assert.match(on, /Agent: a1 \(claude, working\)/);
  assert.match(on, /Hauptling: 0\.1\.0 \(abc1234\)/);
  assert.match(on, /l1\nl2/);
  assert.equal(buildBody({ description: 'broken', include: false, client, facts }), 'broken');
});

test('issueRepo: config, then origin, then the default', () => {
  assert.equal(issueRepo({ issueRepo: 'me/fork' }, 'https://github.com/x/y.git'), 'me/fork');
  assert.equal(issueRepo({}, 'git@github.com:x/y.git'), 'x/y');
  assert.equal(issueRepo({}, ''), 'gitgiant/hauptling');
});

test('fileIssue builds the gh argv with the label, body on stdin', async () => {
  const calls = [];
  const gh = async (args, opts) => { calls.push({ args, opts }); return args[0] === 'issue' ? 'https://github.com/o/r/issues/7\n' : ''; };
  const url = await fileIssue({ gh, repo: 'o/r', title: ' Bug ', body: 'the body' });
  assert.equal(url, 'https://github.com/o/r/issues/7');
  const create = calls.find(c => c.args[0] === 'issue');
  assert.deepEqual(create.args, ['issue', 'create', '-R', 'o/r', '--title', 'Bug', '--body-file', '-', '--label', 'dashboard']);
  assert.equal(create.opts.input, 'the body');
  assert.deepEqual(issueArgv('o/r', 't'), ['issue', 'create', '-R', 'o/r', '--title', 't', '--body-file', '-']);
});

test('fileIssue skips the label when it cannot be created, and surfaces gh errors', async () => {
  const calls = [];
  const gh = async (args) => {
    calls.push(args);
    if (args[0] === 'label') throw new Error('gh label create: forbidden');
    return 'https://github.com/o/r/issues/8';
  };
  await fileIssue({ gh, repo: 'o/r', title: 't', body: 'b' });
  assert.ok(!calls.at(-1).includes('--label'));
  const bad = async () => { throw new Error('gh issue create: not logged in'); };
  await assert.rejects(fileIssue({ gh: bad, repo: 'o/r', title: 't', body: 'b' }), /not logged in/);
  await assert.rejects(fileIssue({ gh, repo: 'o/r', title: ' ', body: 'b' }), /Title is required/);
});

test('F2 is ignored while the terminal has input on, or the dialog is open', () => {
  assert.equal(shouldOpenReport({ key: 'F2' }), true);
  assert.equal(shouldOpenReport({ key: 'F2' }, { terminalInput: true }), false);
  assert.equal(shouldOpenReport({ key: 'F2' }, { open: true }), false);
  assert.equal(shouldOpenReport({ key: 'F2', ctrlKey: true }), false);
  assert.equal(shouldOpenReport({ key: 'F3' }), false);
});

test('trapTarget wraps Tab inside the dialog', () => {
  const f = ['a', 'b', 'c'];
  assert.equal(trapTarget(f, 'c', false), 'a');
  assert.equal(trapTarget(f, 'a', true), 'c');
  assert.equal(trapTarget(f, 'b', false), null);
  assert.equal(trapTarget(f, 'outside', false), 'a');
});
