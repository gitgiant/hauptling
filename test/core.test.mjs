import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.mjs';
import { createCore } from '../src/core.mjs';
import * as keyStore from '../src/keys.mjs';
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

test('broker restart: running jobs are requeued and leftover test containers removed', async () => {
  const { db, core, host } = setup();
  let removed = 0;
  host.removeTestContainers = async () => { removed++; };
  const { id } = await core.call('test.request', { sha: 'abc', repo: 'gitgiant/demo' });
  const runner = core.authenticate('RUN', 'ADMIN');
  await core.call('test.claim', { wait: 0 }, runner);
  assert.equal(db.prepare('SELECT state FROM tests WHERE id = ?').get(id).state, 'running');
  assert.deepEqual(await core.recover(), { requeued: 1 });
  assert.equal(removed, 1);
  assert.equal(db.prepare('SELECT state FROM tests WHERE id = ?').get(id).state, 'queued');
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

test('clones exclude the brief and pnpm\'s store from git, so `hauptling report` never commits them', async () => {
  const { host, core } = setup();
  await core.call('delegator.start', { repo: 'gitgiant/demo' });
  await core.call('spawn', { brief: 'task', vendor: 'claude', mode: 'cheapest' });
  await settle();
  const sh = host.calls.find(c => c[1] === 'sh' && String(c[3]).includes('info/exclude'));
  assert.match(sh[3], /printf '%s\\n' \.hauptling\/ \.pnpm-store\/ >> "\$1\/\.git\/info\/exclude"/);
});
