import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.mjs';
import { createCore } from '../src/core.mjs';
import * as keyStore from '../src/keys.mjs';
import { loadModels } from '../src/models.mjs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

/** Fake worker host: records commands, answers git queries from a tiny model. */
function fakeHost() {
  const calls = [];
  const typed = [];
  const state = { dirty: '', ahead: '1', head: 'abc1234def' };
  return {
    calls, typed, state,
    async run(user, argv, opts = {}) {
      calls.push([user, ...argv]);
      if (opts.input !== undefined) state.input = opts.input;
      const g = argv[0] === 'git' ? argv.slice(3) : null;
      if (g?.[0] === 'rev-parse' && g[1] === '--abbrev-ref') return { stdout: 'main\n' };
      if (g?.[0] === 'rev-parse') return { stdout: `${state.head}\n` };
      if (g?.[0] === 'status') return { stdout: state.dirty };
      if (g?.[0] === 'rev-list') return { stdout: `${state.ahead}\n` };
      if (argv[0] === 'cat' && argv[1].endsWith('.mcp.json')) { if (!state.mcpJson) throw new Error('no file'); return { stdout: JSON.stringify(state.mcpJson) }; }
      if (argv[0] === 'cat' && argv[1].endsWith('hauptling.json')) { if (!state.config) throw new Error('no file'); return { stdout: JSON.stringify(state.config) }; }
      return { stdout: '' };
    },
    workRoot: '/hl/work',
    async startWorker({ slot, id, dir, argv, env, mcp, codegraphCache }) { calls.push(['tmux', slot, id, dir, argv, env]); state.mcp = mcp; state.codegraphCache = codegraphCache; },
    async tmuxType(user, session, text) { typed.push([session, text]); },
    async stopWorker(user, session) { calls.push(['kill', session]); },
    alive: true, screen: '',
    async tmuxAlive() { return this.alive; },
    async tmuxCapture() { return this.screen; },
    attachArgv: (u, s) => ['wsl.exe', '-u', u, 'tmux', 'attach', '-t', s],
    async hostGit() { return 'main'; },
  };
}

function fakeGithub({ required = [] } = {}) {
  const log = [];
  return {
    log,
    gitAuthEnv: async () => ({ X: '1' }),
    prFind: async () => null,
    prCreate: async (slug, head, base, title) => { log.push(['create', slug, head, base, title]); return { url: `https://github.com/${slug}/pull/5`, number: 5 }; },
    requiredChecks: async () => required,
    prAutoMerge: async (s, n) => log.push(['auto', n]),
    prMerge: async (s, n) => log.push(['merge', n]),
    prView: async () => ({ state: 'MERGED', headRefOid: 'abc1234def', statusCheckRollup: [] }),
  };
}

const settle = () => new Promise(r => setTimeout(r, 20));

function setup(gh = fakeGithub()) {
  const db = openDb(':memory:');
  const host = fakeHost();
  const toasts = [];
  const core = createCore({ db, host, github: gh, keys: { ...keyStore, getKey: () => null, getBudget: () => null }, notify: t => toasts.push(t), models: () => loadModels(join(tmpdir(), 'none.json')), workerUrl: 'http://172.0.0.1:47800', runnerToken: 'RUN' });
  return { db, host, core, gh, toasts };
}

test('pause holds its slot, hooks, mail, and CPU and GPU jobs until unpause restores the state', async () => {
  const { core, db, host } = setup();
  await core.call('delegator.start', { repo: 'gitgiant/demo', max: 1 });
  host.gpuAvailable = async () => true;
  host.pauseWorker = async (slot, id) => host.calls.push(['pause', slot, id]);
  host.unpauseWorker = async (slot, id) => host.calls.push(['unpause', slot, id]);
  const { id } = await core.call('spawn', { brief: 'task', vendor: 'claude', mode: 'cheapest' });
  await settle();
  const row = () => db.prepare('SELECT * FROM agents WHERE id = ?').get(id);
  const who = core.authenticate(row().token, 'ADMIN');
  await core.call('ask', { question: 'Which approach?', choices: ['A', 'B'] }, who);
  for (const action of ['pause', 'unpause', 'restart']) {
    await assert.rejects(core.call(action, { agent: id }, who), /not allowed for workers/);
  }
  const cpu = await core.call('test.request', { agent: id, sha: 'abc' });
  const gpu = await core.call('test.request', { agent: id, sha: 'abc', gpu: true });
  const other = await core.call('test.request', { repo: 'gitgiant/other', sha: 'def' });
  await core.call('pause', { agent: id });
  assert.equal(row().state, 'paused');
  assert.equal(row().slot, 'hl-w1');
  assert.deepEqual(host.calls.at(-1), ['pause', 'hl-w1', id]);

  const after = await core.call('spawn', { brief: 'next task', vendor: 'claude', mode: 'cheapest' });
  assert.equal(after.state, 'queued');
  let probes = 0;
  host.tmuxAlive = async () => { probes++; return false; };
  await core.watch(Date.now() + 3600e3);
  assert.equal(probes, 0);
  assert.equal(row().state, 'paused');
  await core.call('mail.send', { from: 'user', to: id, text: 'stay queued' });
  assert.deepEqual(await core.call('hook', { event: 'Stop' }, who), {});
  assert.equal(host.typed.length, 0);
  assert.equal(db.prepare('SELECT seen_at FROM mail WHERE recipient = ?').get(id).seen_at, null);
  assert.equal((await core.call('test.claim', { wait: 0 })).job.id, other.id);
  assert.equal((await core.call('test.claim', { wait: 0 })).job, null);
  assert.equal((await core.call('test.claim', { gpu: true, wait: 0 })).job, null);
  await assert.rejects(core.call('test.run', { id: cpu.id }), /paused/);

  await core.call('unpause', { agent: id });
  assert.equal(row().state, 'blocked');
  assert.deepEqual(host.calls.at(-1), ['unpause', 'hl-w1', id]);
  assert.equal((await core.call('test.claim', { wait: 0 })).job.id, cpu.id);
  assert.equal((await core.call('test.claim', { gpu: true, wait: 0 })).job.id, gpu.id);
  assert.deepEqual((await core.call('wait', { timeout: 0 })).events.map(e => e.kind), ['paused', 'resumed']);
});

test('a running merge gate can finish during pause and applies its result on resume', async () => {
  const { core, db, host } = setup();
  host.pauseWorker = async () => {};
  host.unpauseWorker = async () => {};
  await core.call('delegator.start', { repo: 'gitgiant/demo', automerge: false });
  const { id } = await core.call('spawn', { brief: 'task', vendor: 'claude', mode: 'cheapest' });
  await settle();
  const agent = () => db.prepare('SELECT * FROM agents WHERE id = ?').get(id);
  const who = core.authenticate(agent().token, 'ADMIN');
  await core.call('report', { text: 'ready for tests' }, who);
  await settle();
  const { job } = await core.call('test.claim', { wait: 0 });
  await core.call('pause', { agent: id });
  await core.call('test.report', { id: job.id, report: { sha: job.sha, status: 'fail', passed: 0, failed: 1 } });
  assert.equal(agent().state, 'paused');
  assert.equal(agent().paused_state, 'done');
  await core.call('unpause', { agent: id });
  assert.equal(agent().state, 'working');
  assert.ok((await core.call('wait', { timeout: 0 })).events.some(e => e.kind === 'gate-failed'));
});

test('restart resumes recorded Claude and Codex sessions and keeps a fresh launch ready', async () => {
  for (const [vendor, sessionId, expected] of [
    ['claude', 'claude-session', ['--resume', 'claude-session']],
    ['codex', 'codex-session', ['resume', 'codex-session']],
    ['agy', 'agy-session', null],
    ['claude', null, null],
  ]) {
    const { core, db, host } = setup();
    await core.call('delegator.start', { repo: 'gitgiant/demo' });
    const { id } = await core.call('spawn', { brief: 'original task', vendor, mode: 'cheapest' });
    await settle();
    const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(id);
    const who = core.authenticate(agent.token, 'ADMIN');
    if (sessionId) await core.call('hook', { vendor, event: 'SessionStart', sessionId }, who);
    await core.call('mail.send', { from: 'user', to: id, text: 'unread follow-up' });
    host.calls.length = 0;
    let options;
    host.restartWorker = async opts => { options = opts; return vendor !== 'agy'; };
    await core.call('restart', { agent: id });
    assert.equal(options.dir, agent.dir);
    assert.equal(options.slot, agent.slot);
    assert.equal(options.env.HAUPTLING_TOKEN, agent.token);
    assert.equal(options.argv[0], vendor);
    const preamble = 'You were restarted; continue from the current state of the branch and working tree.';
    assert.ok(options.argv.at(-1).startsWith(preamble));
    assert.ok(host.state.input.startsWith(preamble));
    assert.match(host.state.input, /original task/);
    if (expected) {
      assert.equal(options.resumeArgv[0], vendor);
      assert.ok(options.resumeArgv.includes(expected[0]));
      assert.equal(options.resumeArgv.at(-2), expected[1]);
    } else assert.equal(options.resumeArgv, undefined);
    assert.equal(host.calls.some(c => c.includes('clone') || c.includes('checkout') || c.includes('rm')), false);
    assert.equal(host.calls.some(c => c[0] === 'tmux'), vendor === 'agy', 'a missing container reuses the existing clone');
    assert.equal(db.prepare('SELECT seen_at FROM mail WHERE recipient = ?').get(id).seen_at, null);
    const updated = db.prepare('SELECT state, branch FROM agents WHERE id = ?').get(id);
    assert.equal(updated.state, 'working');
    assert.equal(updated.branch, agent.branch);
    assert.ok((await core.call('wait', { timeout: 0 })).events.some(e => e.kind === 'restarted'));
    db.close();
  }
});

test('spawn → hooks → mail wake → report → PR without required checks → gate test → merge → slot freed', async () => {
  const { db, host, core, gh } = setup();
  const { id: d } = await core.call('delegator.start', { repo: 'gitgiant/demo', cli: 'claude' });
  const s = await core.call('spawn', { brief: '# Add thing\nDo it.', model: 'haiku-5-5', vendor: 'claude' });
  assert.equal(s.state, 'spawning');
  await settle();
  const a = db.prepare('SELECT * FROM agents WHERE id = ?').get(s.id);
  assert.equal(a.state, 'working');
  assert.equal(a.slot, 'hl-w1');
  const tmux = host.calls.find(c => c[0] === 'tmux');
  const argv = tmux[4];
  assert.equal(argv[0], 'claude');
  assert.equal(argv[argv.indexOf('--model') + 1], 'claude-haiku-5-5');
  assert.equal(argv[argv.indexOf('--effort') + 1], 'low', 'tier 1 gets the tier-1 effort');
  assert.equal(tmux[5].HAUPTLING_AGENT, s.id);
  assert.ok(host.calls.some(c => c.includes('clone') && c.includes('https://github.com/gitgiant/demo.git')));

  const who = core.authenticate(a.token, 'ADMIN');
  assert.deepEqual(who, { role: 'agent', agent: s.id });
  await assert.rejects(core.call('kill', { agent: s.id }, who), /not allowed/);

  const start = await core.call('hook', { vendor: 'claude', event: 'SessionStart', sessionId: 'x' }, who);
  assert.match(start.context, /identity/);
  assert.deepEqual(await core.call('hook', { vendor: 'claude', event: 'Stop' }, who), {});
  await core.call('reply', { agent: s.id, text: 'use the fast path' });
  assert.match(host.typed[0][1], /use the fast path/);
  await core.call('mail.send', { from: 'user', to: s.id, text: 'second note' });
  assert.equal(host.typed.length, 1, 'not idle anymore: no second wake');
  const post = await core.call('hook', { vendor: 'claude', event: 'PostToolUse' }, who);
  assert.match(post.context, /second note/);

  host.state.dirty = ' M x.js';
  host.run = ((orig) => async (u, argv, o) => { if (argv.includes('commit')) host.state.dirty = ''; return orig(u, argv, o); })(host.run);
  const r = await core.call('report', { text: 'Added thing with tests' }, who);
  assert.equal(r.committed, true, 'leftover changes are committed for the worker');
  assert.equal(r.pushed, true);
  assert.ok(host.calls.some(c => c.includes('push') && c.includes(`HEAD:refs/heads/hl/${s.id}`)));
  await settle();
  assert.deepEqual(gh.log[0], ['create', 'gitgiant/demo', `hl/${s.id}`, 'main', 'Add thing']);
  const ev = await core.call('wait', { timeout: 1 });
  assert.equal(ev.events[0].kind, 'report');
  assert.match(ev.events[0].text, /spent: .*test round/, 'the delegator sees what the task spent');

  const runner = core.authenticate('RUN', 'ADMIN');
  const { job } = await core.call('test.claim', { wait: 0 }, runner);
  assert.equal(job.sha, 'abc1234def');
  await assert.rejects(core.call('test.report', { id: job.id, report: { sha: 'other', status: 'pass' } }, runner), /rejected/);
  await core.call('test.report', { id: job.id, report: { sha: 'abc1234def', status: 'pass', passed: 3, failed: 0, skipped: 0, failures: [], duration_s: 1 } }, runner);
  assert.deepEqual(gh.log.at(-1), ['merge', 5]);
  const after = db.prepare('SELECT state FROM agents WHERE id = ?').get(s.id);
  assert.equal(after.state, 'merged');
  const kinds = (await core.call('wait', { timeout: 1 })).events.map(e => e.kind);
  assert.deepEqual(kinds, ['gate-passed', 'merged']);
  assert.equal(core.authenticate(a.token, 'ADMIN'), null, 'token dies with the agent');
  assert.ok(d);
});

test('a newer report supersedes the agent\'s older gate jobs; only the newest sha merges', async () => {
  const { db, core, host, gh } = setup();
  await core.call('delegator.start', { repo: 'gitgiant/demo' });
  const { id } = await core.call('spawn', { brief: 'task', vendor: 'claude', mode: 'cheapest' });
  await settle();
  const who = core.authenticate(db.prepare('SELECT token FROM agents WHERE id = ?').get(id).token, 'ADMIN');
  const gates = () => db.prepare("SELECT sha, state, report FROM tests WHERE agent = ? AND purpose = 'gate' ORDER BY created_at, rowid").all(id);
  const runner = core.authenticate('RUN', 'ADMIN');
  const pass = (job) => core.call('test.report', { id: job.id, report: { sha: job.sha, status: 'pass', passed: 1, failed: 0, skipped: 0, failures: [], duration_s: 1 } }, runner);
  // Queued gate for sha A is cancelled by a second report (sha B).
  host.state.head = 'aaaa111';
  await core.call('report', { text: 'first' }, who); await settle();
  host.state.head = 'bbbb222';
  await core.call('report', { text: 'second' }, who); await settle();
  assert.deepEqual(gates().map(g => [g.sha, g.state]), [['aaaa111', 'done'], ['bbbb222', 'queued']]);
  assert.equal(JSON.parse(gates()[0].report).status, 'cancelled');
  const { job } = await core.call('test.claim', { wait: 0 }, runner);
  assert.equal(job.sha, 'bbbb222', 'only the newest gate runs');
  assert.equal((await core.call('test.claim', { wait: 0 }, runner)).job, null);
  // A running gate for B is stopped when C is reported; its late result merges nothing.
  const killed = [];
  host.killTestJob = async (tid) => { killed.push(tid); };
  host.state.head = 'cccc333';
  await core.call('report', { text: 'third' }, who); await settle();
  assert.deepEqual(killed, [job.id]);
  await assert.rejects(pass(job), /already reported/);
  assert.equal(gh.log.filter(l => l[0] === 'merge').length, 0, 'cancelled gate merged nothing');
  const evs = db.prepare("SELECT kind FROM events WHERE kind LIKE 'gate-%'").all();
  assert.deepEqual(evs, []);
  const c = (await core.call('test.claim', { wait: 0 }, runner)).job;
  assert.equal(c.sha, 'cccc333');
  await pass(c);
  assert.deepEqual(gh.log.filter(l => l[0] === 'merge'), [['merge', 5]]);
  assert.equal(db.prepare('SELECT state FROM agents WHERE id = ?').get(id).state, 'merged');
});

test('required checks → auto-merge; queue beyond 3; ask → toast → answer; round 3 blocks', async () => {
  const { db, core, gh, host, toasts } = setup(fakeGithub({ required: ['ci'] }));
  await core.call('delegator.start', { repo: 'gitgiant/demo' });
  const ids = [];
  for (let i = 0; i < 4; i++) ids.push((await core.call('spawn', { brief: `task ${i}`, mode: 'cheapest' })).id);
  await settle();
  const states = ids.map(id => db.prepare('SELECT state, vendor FROM agents WHERE id = ?').get(id));
  assert.deepEqual(states.map(s => s.state), ['working', 'working', 'working', 'queued']);
  assert.deepEqual(states.map(s => s.vendor), ['claude', 'codex', 'agy', 'claude']);

  const a0 = db.prepare('SELECT token FROM agents WHERE id = ?').get(ids[0]);
  const who = core.authenticate(a0.token, 'ADMIN');
  const q = await core.call('ask', { question: 'Which DB?', choices: ['sqlite', 'postgres'] }, who);
  assert.equal(toasts[0].choices[1], 'postgres');
  const page = new URL(toasts[0].links.page);
  assert.equal(core.askForPage(q.ask, 'wrong'), null);
  assert.equal(core.askForPage(q.ask, page.searchParams.get('k')).question, 'Which DB?');
  assert.match(toasts[0].links.choice(1), /&choice=1$/);
  assert.equal(db.prepare('SELECT state FROM agents WHERE id = ?').get(ids[0]).state, 'blocked');
  await core.call('hook', { vendor: 'claude', event: 'Stop' }, who);
  await core.call('answer', { ask: q.ask, choice: 1 });
  assert.match(host.typed.at(-1)[1], /\[user .*Which DB\?": postgres/);

  for (let i = 1; i <= 2; i++) await core.call('test.request', { selector: 'x' }, who);
  assert.equal(db.prepare('SELECT state FROM agents WHERE id = ?').get(ids[0]).state, 'working', 'two rounds run freely');
  await core.call('test.request', { selector: 'x' }, who);
  assert.equal(db.prepare('SELECT state FROM agents WHERE id = ?').get(ids[0]).state, 'blocked');
  assert.match(toasts.at(-1).body, /round 3/);

  await core.call('report', { text: 'ok' }, who);
  await settle();
  assert.deepEqual(gh.log.at(-1), ['auto', 5]);
  await core.poll();
  await settle();
  assert.equal(db.prepare('SELECT state FROM agents WHERE id = ?').get(ids[0]).state, 'merged');
  assert.equal(db.prepare('SELECT state FROM agents WHERE id = ?').get(ids[3]).state, 'working', 'queued agent took the freed slot');
});

test('hand-started sessions use the mailbox via hooks; handoff/resume', async () => {
  const { core } = setup();
  const r = await core.call('hook', { vendor: 'codex', event: 'SessionStart', sessionId: '11111111-2222-4333-8444-555555555555', model: 'gpt-5.5', cwd: 'C:\\w\\nullpunkt' });
  assert.match(r.context, /codex_gpt-5.5_1111/);
  await core.call('delegator.start', { repo: 'x/y' });
  await core.call('handoff', { text: 'Goal: X. Next: Y.' });
  const res = await core.call('resume', { cli: 'codex' });
  assert.equal(res.delegator.handoff, 'Goal: X. Next: Y.');
  assert.equal(res.delegator.cli, 'codex');
  assert.deepEqual(await core.call('mail.peers', {}), []);
});

test('watch: stuck on a permission prompt → blocked + notified once; activity resumes; exited TUI frees the slot', async () => {
  const { db, core, host, toasts } = setup();
  await core.call('delegator.start', { repo: 'x/y' });
  const { id } = await core.call('spawn', { brief: 'task', vendor: 'agy', mode: 'cheapest' });
  await settle();
  const who = core.authenticate(db.prepare('SELECT token FROM agents WHERE id = ?').get(id).token, 'ADMIN');
  db.prepare("UPDATE identities SET seen_at = ? WHERE identity = ?").run(new Date(Date.now() - 11 * 60e3).toISOString(), id);
  host.screen = 'Requesting permission for:\n  git push\nRun this command?';
  await core.watch();
  await core.watch();
  assert.equal(db.prepare('SELECT state FROM agents WHERE id = ?').get(id).state, 'blocked');
  assert.equal(toasts.length, 1);
  assert.match(toasts[0].body, /permission prompt/);
  await core.call('hook', { vendor: 'agy', event: 'PostToolUse' }, who);
  assert.equal(db.prepare('SELECT state FROM agents WHERE id = ?').get(id).state, 'working');
  host.alive = false;
  await core.watch();
  assert.equal(db.prepare('SELECT state FROM agents WHERE id = ?').get(id).state, 'exited');
  assert.equal((await core.call('wait', { timeout: 1 })).events.at(-1).kind, 'exited');
});

test('watch: idle without reporting → blocked + notified once; under threshold or already reported → untouched', async () => {
  const { db, core, host, toasts } = setup();
  await core.call('delegator.start', { repo: 'x/y' });
  const a = (await core.call('spawn', { brief: 'task', vendor: 'agy', mode: 'cheapest' })).id;
  const b = (await core.call('spawn', { brief: 'task', vendor: 'agy', mode: 'cheapest' })).id;
  const c = (await core.call('spawn', { brief: 'task', vendor: 'agy', mode: 'cheapest' })).id;
  await settle();
  const ago = m => new Date(Date.now() - m * 60e3).toISOString();
  const seen = db.prepare('UPDATE identities SET seen_at = ? WHERE identity = ?');
  db.prepare('UPDATE agents SET idle = 1 WHERE id IN (?, ?, ?)').run(a, b, c);
  seen.run(ago(16), a); seen.run(ago(5), b); seen.run(ago(16), c);
  db.prepare("UPDATE agents SET state = 'done' WHERE id = ?").run(c);
  host.screen = 'line zero\nline one\n\nI am stuck, which file?\n\n  \nplease advise\n';
  await core.watch();
  await core.watch();
  const st = id => db.prepare('SELECT state FROM agents WHERE id = ?').get(id).state;
  assert.equal(st(a), 'blocked');
  assert.equal(st(b), 'working');
  assert.equal(st(c), 'done');
  assert.equal(toasts.length, 1);
  assert.match(toasts[0].body, /I am stuck, which file\? \| please advise/);
  assert.doesNotMatch(toasts[0].body, /line zero/);
  assert.match(toasts[0].body, new RegExp(`hauptling attach ${a}`));
  assert.deepEqual(toasts[0].choices, []);
});

test('pushToMain: no PR; passing gate test rebases and pushes to base', async () => {
  const { db, core, host, gh } = setup();
  await core.call('delegator.start', { repo: 'gitgiant/demo' });
  const { id } = await core.call('spawn', { brief: 'task', vendor: 'claude', mode: 'cheapest' });
  await settle();
  host.state.config = { pushToMain: true };
  const who = core.authenticate(db.prepare('SELECT token FROM agents WHERE id = ?').get(id).token, 'ADMIN');
  await core.call('report', { text: 'done' }, who);
  await settle();
  assert.equal(gh.log.length, 0, 'no PR');
  const runner = core.authenticate('RUN', 'ADMIN');
  const { job } = await core.call('test.claim', { wait: 0 }, runner);
  await core.call('test.report', { id: job.id, report: { sha: job.sha, status: 'pass', passed: 1, failed: 0, skipped: 0, failures: [], duration_s: 1 } }, runner);
  assert.ok(host.calls.some(c => c.includes('push') && c.includes('HEAD:refs/heads/main')));
  assert.equal(db.prepare('SELECT state FROM agents WHERE id = ?').get(id).state, 'merged');
});

test('test writer: runs first on the task branch; implementer starts from its commits', async () => {
  const { db, core, host } = setup();
  await core.call('delegator.start', { repo: 'x/y' });
  const r = await core.call('spawn', { brief: '# Save format v2\nRound-trips.', vendor: 'claude', model: 'opus-5-5', testWriter: { vendor: 'codex' } });
  await settle();
  assert.equal(r.state, 'waiting');
  assert.equal(r.testWriter.model, 'gpt-6-luna', 'cheapest model by default');
  const tw = db.prepare('SELECT * FROM agents WHERE id = ?').get(r.testWriter.id);
  assert.equal(tw.branch, `hl/${r.id}`);
  const twBrief = host.calls.find(c => c[1] === 'sh' && c.at(-2).endsWith('.hauptling/brief.md') && c.at(-2).includes(tw.id));
  assert.ok(twBrief);
  const who = core.authenticate(tw.token, 'ADMIN');
  const rep = await core.call('report', { text: 'spec tests for v2 round-trip' }, who);
  assert.match(rep.note, /handed to the implementer/);
  await settle();
  assert.equal(db.prepare('SELECT state FROM agents WHERE id = ?').get(tw.id).state, 'handed-off');
  const impl = db.prepare('SELECT * FROM agents WHERE id = ?').get(r.id);
  assert.equal(impl.state, 'working');
  assert.equal(impl.start_from, `hl/${r.id}`);
  assert.ok(host.calls.some(c => c.includes('checkout') && c.includes(`origin/hl/${r.id}`) && c.includes(impl.dir)));
  const kinds = (await core.call('wait', { timeout: 1 })).events.map(e => e.kind);
  assert.deepEqual(kinds, ['tests-ready']);
});

/** A worker on gitgiant/demo with hauptling.json `cfg`, and a fake GPU host that runs jobs on demand. */
async function gpuSetup(cfg, { free = 8000, available = true } = {}) {
  const env = setup();
  const { db, core, host } = env;
  host.gpu = { available, free, runs: [], killed: [] };
  host.gpuAvailable = async () => host.gpu.available;
  host.gpuFreeMB = async () => host.gpu.free;
  host.gpuConfig = () => ({ memMB: 6144, waitMinutes: 30 });
  host.killTestJob = async (id) => { host.gpu.killed.push(id); host.gpu.runs.find(r => r.job.id === id)?.done(null); };
  // Jobs block until the test calls done(report); a killed job resolves null (→ error report, discarded).
  host.runTestJob = (job) => new Promise(resolve => host.gpu.runs.push({ job, done: (r) => resolve(r || { id: job.id, sha: job.sha, status: 'error', passed: 0, failed: 0, skipped: 0, failures: [], duration_s: 0, notes: 'killed' }) }));
  const pass = (job) => ({ id: job.id, sha: job.sha, status: 'pass', passed: 1, failed: 0, skipped: 0, failures: [], duration_s: 1 });
  await core.call('delegator.start', { repo: 'gitgiant/demo' });
  const { id } = await core.call('spawn', { brief: 'task', vendor: 'claude', mode: 'cheapest' });
  await settle();
  host.state.config = cfg;
  const who = core.authenticate(db.prepare('SELECT token FROM agents WHERE id = ?').get(id).token, 'ADMIN');
  return { ...env, id, who, pass, state: (t) => db.prepare('SELECT state, gpu FROM tests WHERE id = ?').get(t) };
}

test('gpu: rejected without a GPU or a "gpu" command; runs on its own queue beside the CPU queue', async () => {
  let g = await gpuSetup({ gpu: ['pytest', '-m', 'gpu', '{selector}'] }, { available: false });
  await assert.rejects(g.core.call('test.request', { gpu: true }, g.who), /no GPU on this host/);
  g = await gpuSetup({});
  await assert.rejects(g.core.call('test.request', { gpu: true }, g.who), /"gpu": \[argv\]/);
  g = await gpuSetup({ gpu: ['pytest', '-m', 'gpu'] });
  const gpuJob = await g.core.call('test.request', { gpu: true }, g.who);
  const cpuJob = await g.core.call('test.request', {}, g.who);
  await settle();
  assert.equal(g.host.gpu.runs.length, 2, 'one GPU and one CPU job run at the same time');
  assert.deepEqual(g.host.gpu.runs.map(r => r.job.gpu).sort(), [false, true]);
  const second = await g.core.call('test.request', { gpu: true }, g.who);
  await settle();
  assert.equal(g.state(second.id).state, 'queued', 'GPU jobs run one at a time');
  g.host.gpu.runs.find(r => r.job.id === gpuJob.id).done(g.pass(g.host.gpu.runs.find(r => r.job.id === gpuJob.id).job));
  await settle();
  assert.equal(g.state(gpuJob.id).state, 'done');
  assert.equal(g.state(second.id).state, 'running');
  assert.equal(g.state(cpuJob.id).state, 'running');
});

test('gpu: held while VRAM is short; error after the wait limit; gpuMemMB overrides the need', async () => {
  const g = await gpuSetup({ gpu: ['run-gpu'], gpuMemMB: 2000 }, { free: 1000 });
  const t = await g.core.call('test.request', { gpu: true }, g.who);
  await settle();
  assert.equal(g.state(t.id).state, 'queued');
  assert.equal(g.host.gpu.runs.length, 0);
  assert.equal(await g.core.gpuReady(Date.now() + 29 * 60e3), false);
  assert.equal(await g.core.gpuReady(Date.now() + 31 * 60e3), true);
  const r = await g.core.call('test.get', { id: t.id });
  assert.equal(r.report.status, 'error');
  assert.match(r.report.notes, /GPU busy: 1000 MiB free, needs 2000 MiB/);
  const t2 = await g.core.call('test.request', { gpu: true }, g.who);
  g.host.gpu.free = 2500;
  await g.core.poll();
  await settle();
  assert.equal(g.state(t2.id).state, 'running', '2000 MiB needed, 2500 free');
});

test('gpu pause: holds new jobs, lets the running one finish; --now kills and requeues it without a new round; resume', async () => {
  const g = await gpuSetup({ gpu: ['run-gpu'] });
  const a = await g.core.call('test.request', { gpu: true }, g.who);
  await settle();
  const b = await g.core.call('test.request', { gpu: true }, g.who);
  const p = await g.core.call('gpu.pause');
  assert.deepEqual(p.running, [a.id]);
  g.host.gpu.runs[0].done(g.pass(g.host.gpu.runs[0].job));
  await settle();
  assert.equal(g.state(a.id).state, 'done');
  assert.equal(g.state(b.id).state, 'queued', 'paused: next job waits');
  await g.core.call('gpu.resume');
  await settle();
  assert.equal(g.state(b.id).state, 'running');
  const c = await g.core.call('test.request', { gpu: true }, g.who);
  const hard = await g.core.call('gpu.pause', { now: true });
  assert.deepEqual(hard.requeued, [b.id]);
  await settle();
  assert.deepEqual(g.host.gpu.killed, [b.id]);
  assert.equal(g.state(b.id).state, 'queued', 'killed job is requeued, its error report discarded');
  assert.equal((await g.core.call('test.get', { id: b.id })).report, null);
  const status = await g.core.call('gpu.status');
  assert.equal(status.paused, true);
  assert.deepEqual(status.queued.map(t => t.id), [b.id, c.id], 'requeued job is first in line');
  await g.core.call('gpu.resume');
  await settle();
  assert.equal(g.state(b.id).state, 'running');
  assert.equal(g.host.gpu.runs.at(-1).job.id, b.id);
  assert.equal(g.db.prepare('SELECT COUNT(*) n FROM tests WHERE agent = ?').get(g.id).n, 3, 'no extra test round');
});

test('broker restart cancels ended agents’ tests and requeues live agents’ running jobs', async () => {
  const { db, core, host } = setup();
  let removed = 0;
  const stopped = [];
  host.removeTestContainers = async () => { removed++; };
  await core.call('delegator.start', { repo: 'gitgiant/demo' });
  const killed = await core.call('spawn', { brief: 'killed task', vendor: 'claude', mode: 'cheapest' });
  const live = await core.call('spawn', { brief: 'live task', vendor: 'claude', mode: 'cheapest' });
  await settle();
  const token = db.prepare('SELECT token FROM agents WHERE id = ?');
  const gate = db.prepare('SELECT id, state, report FROM tests WHERE agent = ?');
  for (const agent of [killed, live]) {
    await core.call('report', { text: 'done' }, core.authenticate(token.get(agent.id).token, 'ADMIN'));
  }
  await settle();
  db.prepare("UPDATE tests SET state = 'running'").run();
  db.prepare("UPDATE agents SET state = 'killed' WHERE id = ?").run(killed.id);
  const runner = blockingRunner(host);
  host.killTestJob = async id => { stopped.push(id); };

  assert.deepEqual(await core.recover(), { requeued: 1 });
  assert.equal(removed, 1);
  assert.deepEqual(stopped, [gate.get(killed.id).id]);
  assert.equal(gate.get(killed.id).state, 'done');
  assert.equal(JSON.parse(gate.get(killed.id).report).status, 'cancelled');
  assert.equal(gate.get(live.id).state, 'queued');
  assert.deepEqual(runner.runs, []);
});

test('PR polling cancels a queued gate after an external merge', async () => {
  const { db, core, host, gh } = setup();
  await core.call('delegator.start', { repo: 'gitgiant/demo' });
  const { id } = await core.call('spawn', { brief: 'merge externally', vendor: 'claude', mode: 'cheapest' });
  await settle();
  const agent = db.prepare('SELECT token, state FROM agents WHERE id = ?');
  await core.call('report', { text: 'done' }, core.authenticate(agent.get(id).token, 'ADMIN'));
  await settle();
  const gate = db.prepare("SELECT state, report FROM tests WHERE agent = ? AND purpose = 'gate'");
  assert.equal(gate.get(id).state, 'queued');
  const runner = blockingRunner(host);

  await core.call('poll', {});
  assert.equal(agent.get(id).state, 'merged');
  assert.equal(gate.get(id).state, 'done');
  assert.equal(JSON.parse(gate.get(id).report).status, 'cancelled');
  assert.deepEqual(runner.runs, []);
  assert.deepEqual(db.prepare("SELECT kind FROM events WHERE kind = 'merged'").all().map(e => e.kind), ['merged']);
  assert.equal(gh.log.filter(l => l[0] === 'merge').length, 0);
});

test('gateGpu: CPU gate passes → GPU gate queued ("gate: waiting for GPU") → GPU pass merges', async () => {
  const g = await gpuSetup({ pushToMain: true, gpu: ['run-gpu'], gateGpu: true });
  await g.core.call('report', { text: 'done' }, g.who);
  await settle();
  const cpu = g.host.gpu.runs.find(r => !r.job.gpu);
  cpu.done(g.pass(cpu.job));
  await settle();
  assert.equal(g.db.prepare('SELECT state FROM agents WHERE id = ?').get(g.id).state, 'done', 'not merged yet');
  assert.equal(g.db.prepare('SELECT text FROM status WHERE identity = ?').get(g.id).text, 'gate: waiting for GPU');
  const gpu = g.host.gpu.runs.find(r => r.job.gpu);
  assert.ok(gpu, 'GPU gate job started');
  gpu.done(g.pass(gpu.job));
  await settle();
  assert.equal(g.db.prepare('SELECT state FROM agents WHERE id = ?').get(g.id).state, 'merged');
});

test('CodeGraph: on by default (MCP server, cache, brief line); hauptling.json turns it off and allowlists repo servers', async () => {
  const { db, host, core } = setup();
  await core.call('delegator.start', { repo: 'gitgiant/demo', cli: 'claude' });
  await core.call('spawn', { brief: '# A\nDo it.', model: 'haiku-5-5', vendor: 'claude' });
  await settle();
  assert.deepEqual(Object.keys(host.state.mcp.mcpServers), ['codegraph']);
  assert.match(host.state.codegraphCache, /codegraph[\\/]gitgiant_demo$/);
  assert.match(host.state.input, /codegraph_explore/);

  host.state.config = { codegraph: false, mcp: ['db', 'nope'] };
  host.state.mcpJson = { mcpServers: { db: { command: 'node', args: ['db.mjs'] }, other: { command: 'x' } } };
  const b = await core.call('spawn', { brief: '# B\nDo it.', model: 'haiku-5-5', vendor: 'claude' });
  await settle();
  assert.deepEqual(host.state.mcp, { mcpServers: { db: { command: 'node', args: ['db.mjs'] } } });
  assert.equal(host.state.codegraphCache, null);
  assert.doesNotMatch(host.state.input, /codegraph/);
  assert.ok(db.prepare("SELECT 1 FROM events WHERE agent = ? AND kind = 'mcp-missing' AND text LIKE '%nope%'").get(b.id));
});

test('several delegators: no --delegator is refused when ambiguous; each session keeps its own repo, agents and events; end', async () => {
  const { db, core } = setup();
  const { id: a } = await core.call('delegator.start', { repo: 'gitgiant/one', cli: 'claude' });
  await core.call('spawn', { brief: 'one task', vendor: 'claude', mode: 'cheapest' });
  const { id: b } = await core.call('delegator.start', { repo: 'gitgiant/two', cli: 'claude' });
  await assert.rejects(core.call('spawn', { brief: 'x', vendor: 'claude', mode: 'cheapest' }), new RegExp(`Several delegators are active: ${a} \\(gitgiant/one\\), ${b} \\(gitgiant/two\\)`));
  await assert.rejects(core.call('wait', { timeout: 0 }), /Pass --delegator ID/);
  await assert.rejects(core.call('agents', {}), /Several delegators/);
  await assert.rejects(core.call('resume', {}), /Several delegators/);
  const sa = await core.call('spawn', { delegator: a, brief: 'two', vendor: 'claude', mode: 'cheapest' });
  const sb = await core.call('spawn', { delegator: b, brief: 'three', vendor: 'claude', mode: 'cheapest' });
  await settle();
  const repo = (id) => db.prepare('SELECT repo, delegator FROM agents WHERE id = ?').get(id);
  assert.deepEqual({ ...repo(sa.id) }, { repo: 'gitgiant/one', delegator: a });
  assert.deepEqual({ ...repo(sb.id) }, { repo: 'gitgiant/two', delegator: b }, 'B spawns into B\'s repo');
  assert.equal((await core.call('agents', { delegator: a })).length, 2);
  assert.equal((await core.call('agents', { delegator: b })).length, 1);
  await assert.rejects(core.call('delegator.end', { delegator: b }), new RegExp(`${b} still has agents: ${sb.id}`));
  await core.call('kill', { agent: sb.id });
  await core.call('delegator.end', { delegator: b });
  assert.equal(db.prepare('SELECT active FROM delegators WHERE id = ?').get(b).active, 0);
  assert.equal((await core.call('agents', {})).length, 2, 'one active again: no flag needed');
});

test('clones exclude the brief, pnpm\'s store and node_modules from git, so `hauptling report` never commits them', async () => {
  const { host, core } = setup();
  await core.call('delegator.start', { repo: 'gitgiant/demo' });
  await core.call('spawn', { brief: 'task', vendor: 'claude', mode: 'cheapest' });
  await settle();
  const sh = host.calls.find(c => c[1] === 'sh' && String(c[3]).includes('info/exclude'));
  assert.match(sh[3], /printf '%s\\n' \.hauptling\/ \.pnpm-store\/ node_modules\/ >> "\$1\/\.git\/info\/exclude"/);
});

test('resume --repo continues only that repo\'s delegator; another repo\'s session gets none', async () => {
  const { core } = setup();
  const { id: space } = await core.call('delegator.start', { repo: '/w/nullpunkt' });
  const { id: hl } = await core.call('delegator.start', { repo: 'gitgiant/hauptling' });
  assert.equal((await core.call('resume', { repo: ['/w/nullpunkt'] })).delegator.id, space);
  assert.equal((await core.call('resume', { repo: ['/w/hauptling', 'gitgiant/hauptling'] })).delegator.id, hl, 'a local clone matches its GitHub owner/name');
  assert.deepEqual(await core.call('resume', { repo: ['/w/other'] }), { delegator: null, repo: '/w/other' });
  await core.call('delegator.end', { delegator: hl });
  assert.equal((await core.call('resume', { repo: ['gitgiant/hauptling'] })).delegator, null, 'ended delegators are not resumed');
});

/** Jobs block until the test finishes them; killTestJob ends a run like `docker rm -f` would. */
function blockingRunner(host) {
  const runs = [];
  const killed = [];
  host.runTestJob = (job) => new Promise(resolve => runs.push({ job, done: (status = 'pass') => resolve({ id: job.id, sha: job.sha, status, passed: 1, failed: 0, skipped: 0, failures: [], duration_s: 1 }) }));
  host.killTestJob = async (id) => { killed.push(id); runs.find(r => r.job.id === id)?.done('error'); };
  return { runs, killed };
}

test('kill cancels the agent\'s queued and running test jobs; cancelled gates emit nothing', async () => {
  const { db, core, host, gh } = setup();
  host.testConcurrency = () => 1;
  const r = blockingRunner(host);
  await core.call('delegator.start', { repo: 'gitgiant/demo' });
  const a = (await core.call('spawn', { brief: 'task a', vendor: 'claude', mode: 'cheapest' })).id;
  const b = (await core.call('spawn', { brief: 'task b', vendor: 'claude', mode: 'cheapest' })).id;
  await settle();
  const who = (id) => core.authenticate(db.prepare('SELECT token FROM agents WHERE id = ?').get(id).token, 'ADMIN');
  await core.call('report', { text: 'a done' }, who(a)); await settle();
  await core.call('report', { text: 'b done' }, who(b)); await settle();
  const gate = (id) => db.prepare("SELECT id, state, report FROM tests WHERE agent = ? AND purpose = 'gate'").get(id);
  assert.equal(gate(a).state, 'running');
  assert.equal(gate(b).state, 'queued');
  await db.prepare('DELETE FROM events').run();

  // Queued: cancelled, never runs.
  await core.call('kill', { agent: b }); await settle();
  assert.equal(gate(b).state, 'done');
  assert.equal(JSON.parse(gate(b).report).status, 'cancelled');
  // Running: container stopped, its late result discarded.
  await core.call('kill', { agent: a }); await settle();
  assert.deepEqual(r.killed, [gate(a).id]);
  assert.equal(JSON.parse(gate(a).report).status, 'cancelled');
  assert.equal(r.runs.length, 1, 'b\'s gate never started');
  assert.deepEqual(db.prepare("SELECT kind FROM events WHERE kind LIKE 'gate-%'").all(), []);
  assert.equal(gh.log.filter(l => l[0] === 'merge').length, 0);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM tests WHERE state != 'done'").get().n, 0);
});

test('CPU jobs: up to testConcurrency at once, one per repo, FIFO; Run now starts one past the limit', async () => {
  const { db, core, host } = setup();
  host.testConcurrency = () => 2;
  const r = blockingRunner(host);
  const req = (repo) => core.call('test.request', { repo, sha: `sha-${repo}` }).then(x => x.id);
  const x1 = await req('gitgiant/a');
  const x2 = await req('gitgiant/a');
  const y1 = await req('gitgiant/b');
  const z1 = await req('gitgiant/c');
  await settle();
  const st = (id) => db.prepare('SELECT state FROM tests WHERE id = ?').get(id).state;
  assert.deepEqual([x1, x2, y1, z1].map(st), ['running', 'queued', 'running', 'queued'], 'two repos run together; a\'s second job waits');
  r.runs.find(x => x.job.id === x1).done(); await settle();
  assert.deepEqual([x1, x2, y1, z1].map(st), ['done', 'running', 'running', 'queued'], 'a\'s jobs run in order, ahead of c');
  await assert.rejects(core.call('test.run', { id: x1 }), /not queued/);
  assert.deepEqual(await core.call('test.run', { id: z1 }), { started: z1 });
  await settle();
  assert.equal(st(z1), 'running');
  assert.equal(r.runs.length, 4, 'three running, past the limit of 2');
  for (const run of r.runs.slice(1)) run.done();
  await settle();
  assert.deepEqual([x2, y1, z1].map(st), ['done', 'done', 'done']);
});

test('delegator merge settings: default gated; gate off merges at once; toggling off cancels a queued gate; auto-merge off stops at [ready]', async () => {
  const kinds = (db) => db.prepare('SELECT kind FROM events ORDER BY id').all().map(e => e.kind);
  const spawnReport = async (ctx, d, head) => {
    const { db, core, host } = ctx;
    const { id } = await core.call('spawn', { brief: 'task', vendor: 'claude', mode: 'cheapest', delegator: d });
    await settle();
    const who = core.authenticate(db.prepare('SELECT token FROM agents WHERE id = ?').get(id).token, 'ADMIN');
    host.state.head = head;
    await core.call('report', { text: 'done' }, who); await settle();
    return id;
  };
  const state = (db, id) => db.prepare('SELECT state FROM agents WHERE id = ?').get(id).state;
  const gateJobs = (db) => db.prepare("SELECT state FROM tests WHERE purpose = 'gate'").all().map(t => t.state);

  // Default stays gated.
  let ctx = setup();
  const { id: dd } = await ctx.core.call('delegator.start', { repo: 'gitgiant/demo' });
  assert.deepEqual({ ...ctx.db.prepare('SELECT gate, automerge FROM delegators WHERE id = ?').get(dd) }, { gate: 1, automerge: 1 });
  await spawnReport(ctx, dd, 'aaaa111');
  assert.deepEqual(gateJobs(ctx.db), ['queued']);
  assert.equal(ctx.gh.log.filter(l => l[0] === 'merge').length, 0);

  // Gate off at start: the report merges, no test job, no gate-* events.
  ctx = setup();
  const { id: d1 } = await ctx.core.call('delegator.start', { repo: 'gitgiant/demo', gate: false });
  const a1 = await spawnReport(ctx, d1, 'aaaa111');
  assert.deepEqual(gateJobs(ctx.db), []);
  assert.deepEqual(ctx.gh.log.filter(l => l[0] === 'merge'), [['merge', 5]]);
  assert.equal(state(ctx.db, a1), 'merged');
  assert.deepEqual(kinds(ctx.db), ['report', 'merged']);

  // Toggling off cancels the queued gate and merges.
  ctx = setup();
  const { id: d2 } = await ctx.core.call('delegator.start', { repo: 'gitgiant/demo' });
  const a2 = await spawnReport(ctx, d2, 'aaaa111');
  assert.deepEqual(gateJobs(ctx.db), ['queued']);
  assert.deepEqual(await ctx.core.call('delegator.set', { delegator: d2, gate: false }), { delegator: d2, gate: false, automerge: true });
  assert.deepEqual(gateJobs(ctx.db), ['done']);
  assert.equal(JSON.parse(ctx.db.prepare("SELECT report FROM tests WHERE purpose = 'gate'").get().report).status, 'cancelled');
  assert.deepEqual(ctx.gh.log.filter(l => l[0] === 'merge'), [['merge', 5]]);
  assert.equal(state(ctx.db, a2), 'merged');
  assert.deepEqual(kinds(ctx.db), ['report', 'merged']);
  // Turning it back on only affects later reports.
  await ctx.core.call('delegator.set', { delegator: d2, gate: true });
  assert.equal(ctx.db.prepare('SELECT gate FROM delegators WHERE id = ?').get(d2).gate, 1);

  // Local repo, gate off: merges like `hauptling merge`.
  ctx = setup();
  ctx.host.hostGit = async (repo, args) => (args[0] === 'status' ? '' : 'main');
  const { id: d3 } = await ctx.core.call('delegator.start', { repo: '/tmp/demo', gate: false });
  const a3 = await spawnReport(ctx, d3, 'aaaa111');
  assert.equal(state(ctx.db, a3), 'merged');
  assert.deepEqual(gateJobs(ctx.db), []);

  // Auto-merge off: [ready], no merge, then a manual merge.
  ctx = setup();
  const { id: d4 } = await ctx.core.call('delegator.start', { repo: 'gitgiant/demo', gate: false, automerge: false });
  const a4 = await spawnReport(ctx, d4, 'aaaa111');
  assert.equal(state(ctx.db, a4), 'done');
  assert.deepEqual(ctx.gh.log.filter(l => l[0] === 'merge'), []);
  assert.deepEqual(kinds(ctx.db), ['report', 'ready']);
  await ctx.core.call('merge', { agent: a4 });
  assert.deepEqual(ctx.gh.log.filter(l => l[0] === 'merge'), [['merge', 5]]);
  assert.equal(state(ctx.db, a4), 'merged');
});

test('migration: a delegators table from before the merge settings gains gate and automerge (default on)', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'hl-mig-')), 'old.db');
  const old = new DatabaseSync(path);
  old.exec(`CREATE TABLE delegators (id TEXT PRIMARY KEY, cli TEXT, repo TEXT, max_agents INTEGER NOT NULL DEFAULT 3,
    handoff TEXT, handoff_at TEXT, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL);
    INSERT INTO delegators (id, created_at) VALUES ('d_old', 'x');`);
  old.close();
  const db = openDb(path);
  assert.deepEqual({ ...db.prepare('SELECT gate, automerge FROM delegators WHERE id = ?').get('d_old') }, { gate: 1, automerge: 1 });
  db.close();
});

/** Test watchdog: jobs block until finished; liveness per job is set by the test (docker and clock stubbed). */
function watchedRunner(host, { stallSec = 300, retries = 2 } = {}) {
  const r = blockingRunner(host);
  const live = {};
  host.testLiveness = async (id) => live[id] || { state: 'preparing' };
  host.testWatchdog = () => ({ stallSec, retries });
  return { ...r, live };
}
const testRow = (db, id) => db.prepare('SELECT state, attempt, retry_note, report FROM tests WHERE id = ?').get(id);

test('watchdog: a vanished container is killed and requeued at the front of its repo', async () => {
  const { db, core, host } = setup();
  host.testConcurrency = () => 1;
  const w = watchedRunner(host);
  const first = (await core.call('test.request', { repo: 'gitgiant/a', sha: 's1' })).id;
  const later = (await core.call('test.request', { repo: 'gitgiant/a', sha: 's2' })).id;
  await settle();
  await core.watchTests();
  assert.equal(testRow(db, first).state, 'running', 'preparing (no container yet) is not watched');
  w.live[first] = { state: 'gone' };
  await core.watchTests(); await settle();
  assert.deepEqual(w.killed, [first]);
  const row = testRow(db, first);
  assert.equal(row.state, 'running', 'rerun at once, ahead of the later job of its repo');
  assert.equal(row.attempt, 2);
  assert.match(row.retry_note, /^retrying \(2\/3\): container gone/);
  assert.equal(testRow(db, later).state, 'queued');
  assert.deepEqual(w.runs.map(x => [x.job.id, x.job.attempt]), [[first, 1], [first, 2]]);
  w.live[first] = { state: 'running', activity: Date.now() };
  await core.watchTests();
  assert.equal(testRow(db, first).attempt, 2, 'a live container is left alone');
  w.runs[1].done(); await settle();
  assert.equal(JSON.parse(testRow(db, first).report).status, 'pass');
  assert.equal(testRow(db, later).state, 'running');
});

test('watchdog: no heartbeat past testStallSec → killed and requeued; a long test with heartbeats is not', async () => {
  const { db, core, host } = setup();
  const w = watchedRunner(host, { stallSec: 300 });
  const id = (await core.call('test.request', { repo: 'gitgiant/a', sha: 's1' })).id;
  await settle();
  const t0 = Date.now();
  // Heartbeat every 30 s for 40 minutes (longer than timeout_s would allow a hang): never killed.
  for (let s = 30; s <= 2400; s += 30) {
    w.live[id] = { state: 'running', activity: t0 + s * 1000 };
    await core.watchTests(t0 + (s + 29) * 1000);
  }
  assert.deepEqual(w.killed, []);
  assert.equal(testRow(db, id).attempt, 1);
  // Then silence: not yet at 300 s, killed past it.
  const last = t0 + 2400e3;
  await core.watchTests(last + 299e3);
  assert.deepEqual(w.killed, []);
  await core.watchTests(last + 301e3); await settle();
  assert.deepEqual(w.killed, [id]);
  assert.match(testRow(db, id).retry_note, /^retrying \(2\/3\): no output or heartbeat for 301s/);
  assert.equal(w.runs.at(-1).job.attempt, 2);
});

test('watchdog: a run that comes back lost (container ended without a result) is requeued', async () => {
  const { db, core, host } = setup();
  watchedRunner(host);
  const runs = [];
  host.runTestJob = (job) => new Promise(resolve => runs.push({ job, resolve }));
  const id = (await core.call('test.request', { repo: 'gitgiant/a', sha: 's1' })).id;
  await settle();
  runs[0].resolve({ id, sha: 's1', status: 'error', passed: 0, failed: 0, skipped: 0, failures: [], duration_s: 0, notes: 'test container failed', lost: 'container ended without a result: exit 137' });
  await settle();
  assert.equal(testRow(db, id).attempt, 2);
  assert.equal(testRow(db, id).state, 'running');
  runs[1].resolve({ id, sha: 's1', status: 'pass', passed: 3, failed: 0, skipped: 0, failures: [], duration_s: 1 });
  await settle();
  assert.equal(JSON.parse(testRow(db, id).report).status, 'pass');
});

test('watchdog: retries exhausted → the gate fails with "runner unresponsive (3 attempts)"', async () => {
  const { db, core, host } = setup();
  const w = watchedRunner(host);
  await core.call('delegator.start', { repo: 'gitgiant/demo' });
  const { id: agent } = await core.call('spawn', { brief: 'task', vendor: 'claude', mode: 'cheapest' });
  await settle();
  const who = core.authenticate(db.prepare('SELECT token FROM agents WHERE id = ?').get(agent).token, 'ADMIN');
  await core.call('report', { text: 'done' }, who); await settle();
  const gate = db.prepare("SELECT id FROM tests WHERE agent = ? AND purpose = 'gate'").get(agent).id;
  for (let i = 0; i < 3; i++) {
    assert.equal(testRow(db, gate).state, 'running');
    w.live[gate] = { state: 'exited' };
    await core.watchTests(); await settle();
  }
  const row = testRow(db, gate);
  assert.equal(row.state, 'done');
  const report = JSON.parse(row.report);
  assert.equal(report.status, 'error');
  assert.match(report.notes, /^runner unresponsive \(3 attempts\): container exited without a result/);
  assert.equal(w.runs.length, 3);
  assert.deepEqual(w.killed, [gate, gate, gate]);
  const ev = db.prepare("SELECT kind, text FROM events WHERE kind LIKE 'gate-%'").all();
  assert.deepEqual(ev.map(e => e.kind), ['gate-failed']);
  assert.equal(db.prepare('SELECT state FROM agents WHERE id = ?').get(agent).state, 'working', 'sent back to the worker');
  const t = await core.call('test.wait', { id: gate, timeout: 1 });
  assert.equal(t.report.status, 'error');
});

test('watchdog: a hung GPU job releases the GPU queue before it is requeued', async () => {
  const g = await gpuSetup({ gpu: ['run-gpu'] });
  // Unlike `docker rm -f`, this kill never makes the old run return: only the watchdog's release frees the queue.
  g.host.killTestJob = async (id) => { g.host.gpu.killed.push(id); };
  const live = {};
  g.host.testLiveness = async (id) => live[id] || { state: 'preparing' };
  g.host.testWatchdog = () => ({ stallSec: 300, retries: 2 });
  const t = await g.core.call('test.request', { gpu: true }, g.who);
  const next = await g.core.call('test.request', { gpu: true }, g.who);
  await settle();
  assert.equal(g.state(t.id).state, 'running');
  assert.equal(g.state(next.id).state, 'queued');
  live[t.id] = { state: 'running', activity: Date.now() - 400e3 };
  await g.core.watchTests(); await settle();
  assert.deepEqual(g.host.gpu.killed, [t.id]);
  assert.deepEqual(g.host.gpu.runs.map(r => [r.job.id, r.job.attempt]), [[t.id, 1], [t.id, 2]], 'requeued first in line and rerun');
  assert.equal(g.state(next.id).state, 'queued', 'still one GPU job at a time');
  const rerun = g.host.gpu.runs[1];
  rerun.done(g.pass(rerun.job)); await settle();
  assert.equal(g.state(t.id).state, 'done');
  assert.equal(g.state(next.id).state, 'running');
});

test('slots per vendor: with claude on hl-w1 and codex on hl-w2/hl-w3, a new claude agent starts on hl-w2', async () => {
  const { core, db } = setup();
  await core.call('delegator.start', { repo: 'gitgiant/demo', max: 6 });
  const slotOf = (id) => db.prepare('SELECT slot FROM agents WHERE id = ?').get(id).slot;
  const c1 = await core.call('spawn', { brief: 'c1', vendor: 'claude', mode: 'cheapest' });
  const x1 = await core.call('spawn', { brief: 'x1', vendor: 'codex', mode: 'cheapest' });
  const x2 = await core.call('spawn', { brief: 'x2', vendor: 'codex', mode: 'cheapest' });
  await settle();
  assert.equal(slotOf(c1.id), 'hl-w1');
  assert.deepEqual([slotOf(x1.id), slotOf(x2.id)], ['hl-w1', 'hl-w2'], 'codex takes hl-w1 beside the claude worker');
  db.prepare("UPDATE agents SET slot = 'hl-w2' WHERE id = ?").run(x1.id);
  db.prepare("UPDATE agents SET slot = 'hl-w3' WHERE id = ?").run(x2.id);
  const c2 = await core.call('spawn', { brief: 'c2', vendor: 'claude', mode: 'cheapest' });
  assert.equal(c2.state, 'spawning');
  assert.equal(slotOf(c2.id), 'hl-w2');
});

test('slots per vendor: a second claude agent never shares a slot with an active claude agent', async () => {
  const { core, db } = setup();
  await core.call('delegator.start', { repo: 'gitgiant/demo', max: 6 });
  const row = (id) => db.prepare('SELECT slot, state FROM agents WHERE id = ?').get(id);
  const ids = [];
  for (let i = 0; i < 4; i++) ids.push((await core.call('spawn', { brief: `c${i}`, vendor: 'claude', mode: 'cheapest' })).id);
  await settle();
  assert.deepEqual(ids.slice(0, 3).map(id => row(id).slot), ['hl-w1', 'hl-w2', 'hl-w3']);
  assert.deepEqual({ ...row(ids[3]) }, { slot: null, state: 'queued' }, 'every slot holds a claude worker: the fourth waits');
  // A restart must not move onto another claude worker's slot either.
  db.prepare("UPDATE agents SET state = 'exited', slot = NULL WHERE id = ?").run(ids[0]);
  db.prepare("UPDATE agents SET state = 'working', slot = 'hl-w1' WHERE id = ?").run(ids[3]);
  await assert.rejects(core.call('restart', { agent: ids[0] }), /No slot free for claude/);
  await core.call('kill', { agent: ids[1] });
  await settle();
  await core.call('restart', { agent: ids[0] });
  assert.equal(row(ids[0]).slot, 'hl-w2');
  const slots = db.prepare("SELECT slot FROM agents WHERE vendor = 'claude' AND slot IS NOT NULL AND state IN ('spawning','restarting','working','blocked','done','paused')").all().map(r => r.slot);
  assert.equal(new Set(slots).size, slots.length, `claude slots overlap: ${slots}`);
});

test('maxWorkers caps live workers across every delegator; freeing one starts the next', async () => {
  const { core, db, host } = setup();
  host.maxWorkers = () => 2;
  await core.call('delegator.start', { repo: 'gitgiant/demo', max: 6 });
  await core.call('delegator.start', { repo: 'gitgiant/other', max: 6 });
  const d = db.prepare('SELECT id, repo FROM delegators').all();
  const mine = d.find(x => x.repo === 'gitgiant/demo').id;
  const theirs = d.find(x => x.repo === 'gitgiant/other').id;
  const a = await core.call('spawn', { delegator: mine, brief: 'a', vendor: 'claude', mode: 'cheapest' });
  const b = await core.call('spawn', { delegator: mine, brief: 'b', vendor: 'codex', mode: 'cheapest' });
  const c = await core.call('spawn', { delegator: theirs, brief: 'c', vendor: 'agy', mode: 'cheapest' });
  await settle();
  assert.deepEqual([a.state, b.state, c.state], ['spawning', 'spawning', 'queued'], 'slots are free for agy, but the host is at maxWorkers');
  await core.call('kill', { agent: a.id });
  await core.call('poll');
  await settle();
  assert.equal(db.prepare('SELECT state FROM agents WHERE id = ?').get(c.id).state, 'working');
});
