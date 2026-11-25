import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildBody, checkImage, uploadScreenshot, fileIssue, issueArgv, issueRepo, scrubText } from '../src/report.mjs';
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

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('rest')]);
const stubGh = ({ missing = false, failPut = false } = {}) => {
  const calls = [];
  const gh = async (args, opts) => {
    calls.push({ args, input: opts?.input });
    const path = args[0] === 'api' ? args.find(a => a.startsWith('repos/')) : '';
    if (args[0] === 'api' && args.length === 2 && missing) throw new Error('gh api: Not Found');
    if (path?.endsWith('/git/trees')) return JSON.stringify({ sha: 't1' });
    if (path?.endsWith('/git/commits')) return JSON.stringify({ sha: 'c1' });
    if (failPut && args.includes('PUT')) throw new Error('gh api: 403');
    return args[0] === 'issue' ? 'https://github.com/o/r/issues/9' : '{}';
  };
  return { gh, calls };
};

test('uploadScreenshot PUTs base64 content to the issue-screenshots branch', async () => {
  const { gh, calls } = stubGh();
  const url = await uploadScreenshot({ gh, repo: 'o/r', image: PNG.toString('base64'), now: new Date('2026-11-25T00:00:00Z') });
  assert.match(url, /^https:\/\/github\.com\/o\/r\/blob\/issue-screenshots\/2026-11\/[0-9a-f]{16}\.png\?raw=true$/);
  const put = calls.find(c => c.args.includes('PUT'));
  assert.deepEqual(put.args.slice(0, 4), ['api', '-X', 'PUT', `repos/o/r/contents/${url.split('/issue-screenshots/')[1].replace('?raw=true', '')}`]);
  assert.deepEqual(JSON.parse(put.input), { message: 'Add screenshot', content: PNG.toString('base64'), branch: 'issue-screenshots' });
  assert.ok(!calls.some(c => c.args.includes('POST')));
});

test('uploadScreenshot creates the orphan branch with a README when missing', async () => {
  const { gh, calls } = stubGh({ missing: true });
  await uploadScreenshot({ gh, repo: 'o/r', image: PNG.toString('base64') });
  const posts = calls.filter(c => c.args.includes('POST'));
  assert.deepEqual(posts.map(c => c.args.find(a => a.startsWith('repos/'))), ['repos/o/r/git/trees', 'repos/o/r/git/commits', 'repos/o/r/git/refs']);
  assert.equal(JSON.parse(posts[0].input).tree[0].path, 'README.md');
  assert.deepEqual(JSON.parse(posts[1].input).parents, []);
  assert.deepEqual(JSON.parse(posts[2].input), { ref: 'refs/heads/issue-screenshots', sha: 'c1' });
  assert.ok(calls.indexOf(posts[2]) < calls.findIndex(c => c.args.includes('PUT')));
});

test('checkImage rejects non-images and oversized payloads', () => {
  assert.throws(() => checkImage(Buffer.from('hello world, not an image').toString('base64')), /not a PNG or JPEG/);
  assert.throws(() => checkImage(Buffer.concat([PNG, Buffer.alloc(5 * 1024 * 1024)]).toString('base64')), /over 5 MB/);
  assert.equal(checkImage(`data:image/png;base64,${PNG.toString('base64')}`).ext, 'png');
  assert.equal(checkImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1]).toString('base64')).ext, 'jpg');
});

test('fileIssue embeds the image link, or a note when the upload failed', async () => {
  const ok = stubGh();
  const url = await fileIssue({ gh: ok.gh, repo: 'o/r', title: 't', body: 'b', screenshot: PNG.toString('base64') });
  assert.equal(url, 'https://github.com/o/r/issues/9');
  assert.match(ok.calls.find(c => c.args[0] === 'issue').input, /b\n\n!\[screenshot\]\(https:\/\/github\.com\/o\/r\/blob\/issue-screenshots\/.+\.png\?raw=true\)$/);
  const bad = stubGh({ failPut: true });
  const r = await fileIssue({ gh: bad.gh, repo: 'o/r', title: 't', body: 'b', screenshot: PNG.toString('base64') });
  assert.match(r.note, /Screenshot not attached/);
  assert.match(bad.calls.find(c => c.args[0] === 'issue').input, /Screenshot not attached/);
  assert.ok(!bad.calls.find(c => c.args[0] === 'issue').input.includes('![screenshot]'));
});
