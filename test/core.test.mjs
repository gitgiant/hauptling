import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.mjs';
import { createCore } from '../src/core.mjs';
import { loadModels } from '../src/models.mjs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/** Fake worker host: records commands, answers git queries from a tiny model. */
function fakeHost() {
  const calls = [];
  const typed = [];
  const state = { dirty: '', ahead: '1', head: 'abc1234def' };
  return {
    calls, typed, state,
    async run(user, argv) {
      calls.push([user, ...argv]);
      const g = argv[0] === 'git' ? argv.slice(3) : null;
      if (g?.[0] === 'rev-parse' && g[1] === '--abbrev-ref') return { stdout: 'main\n' };
      if (g?.[0] === 'rev-parse') return { stdout: `${state.head}\n` };
      if (g?.[0] === 'status') return { stdout: state.dirty };
      if (g?.[0] === 'rev-list') return { stdout: `${state.ahead}\n` };
      if (argv[0] === 'cat' && argv[1].endsWith('hauptling.json')) { if (!state.config) throw new Error('no file'); return { stdout: JSON.stringify(state.config) }; }
      return { stdout: '' };
    },
    workRoot: '/hl/work',
    async startWorker({ slot, id, dir, argv, env }) { calls.push(['tmux', slot, id, dir, argv, env]); },
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
  const core = createCore({ db, host, github: gh, notify: t => toasts.push(t), models: () => loadModels(join(tmpdir(), 'none.json')), workerUrl: 'http://172.0.0.1:47800', runnerToken: 'RUN' });
  return { db, host, core, gh, toasts };
}

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
  assert.deepEqual(tmux[4].slice(0, 3), ['claude', '--model', 'claude-haiku-5-5']);
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

test('required checks → auto-merge; queue beyond 3; ask → toast → answer; round 4 blocks', async () => {
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

  for (let i = 1; i <= 4; i++) await core.call('test.request', { selector: 'x' }, who);
  assert.equal(db.prepare('SELECT state FROM agents WHERE id = ?').get(ids[0]).state, 'blocked');
  assert.match(toasts.at(-1).body, /round 4/);

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
