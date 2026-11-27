import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.mjs';
import { createCore } from '../src/core.mjs';
import { createDashboard } from '../src/dashboard.mjs';
import * as keyStore from '../src/keys.mjs';
import { loadModels } from '../src/models.mjs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Parking (PRD "Parking"): Docker and gh stubbed; the session copy itself is covered by sessions.test.mjs.

function fakeHost() {
  const calls = [];
  const typed = [];
  const starts = [];
  const sessions = { saved: [], restored: [], dropped: [] };
  const state = { ahead: '1', head: 'abc1234def', saved: null };
  return {
    calls, typed, starts, sessions, state,
    workRoot: '/hl/work',
    async run(slot, argv, opts = {}) {
      calls.push([slot, ...argv]);
      const g = argv[0] === 'git' ? argv.slice(3) : null;
      if (g?.[0] === 'rev-parse' && g[1] === '--abbrev-ref') return { stdout: 'main\n' };
      if (g?.[0] === 'rev-parse') return { stdout: `${state.head}\n` };
      if (g?.[0] === 'rev-list') return { stdout: `${state.ahead}\n` };
      if (argv[0] === 'cat') throw new Error('no file');
      if (argv[0] === 'sh') state.brief = opts.input;
      return { stdout: '' };
    },
    async startWorker(o) { starts.push({ ...o, unread: this.unreadAtStart?.(o.id) }); calls.push(['start', o.slot, o.id]); },
    async stopWorker(slot, id) { calls.push(['stop', slot, id]); },
    async pauseWorker(slot, id) { calls.push(['pause', slot, id]); },
    async unpauseWorker(slot, id) { calls.push(['unpause', slot, id]); },
    async tmuxType(slot, id, text) { typed.push([id, text]); },
    async tmuxAlive() { return true; },
    async tmuxCapture() { return ''; },
    async tmuxScreen(slot, id) { return `\x1b[1mscreen of ${id}\x1b[0m`; },
    saveSession(o) { sessions.saved.push(o); return state.saved ?? [`claude/projects/-work/${o.sessionId}.jsonl`]; },
    restoreSession(o) { sessions.restored.push(o); return state.saved ?? [`claude/projects/-work/x.jsonl`]; },
    dropSession(id) { sessions.dropped.push(id); },
    attachArgv: () => ['tmux', 'attach'],
    async hostGit() { return 'main'; },
  };
}

function fakeGithub() {
  const gh = {
    merged: false,
    gitAuthEnv: async () => ({}),
    prFind: async () => null,
    prCreate: async (slug) => ({ url: `https://github.com/${slug}/pull/5`, number: 5 }),
    requiredChecks: async () => [],
    prAutoMerge: async () => {},
    prMerge: async () => { gh.merged = true; },
    prView: async () => ({ state: gh.merged ? 'MERGED' : 'OPEN', headRefOid: 'abc1234def', statusCheckRollup: gh.checks || [] }),
  };
  return gh;
}

const settle = () => new Promise(r => setTimeout(r, 20));

async function setup({ slots = ['hl-w1'] } = {}) {
  const db = openDb(':memory:');
  const host = fakeHost();
  const gh = fakeGithub();
  const core = createCore({ db, host, github: gh, keys: { ...keyStore, getKey: () => null, getBudget: () => null }, models: () => loadModels(join(tmpdir(), 'none.json')),
    workerUrl: 'http://172.0.0.1:47800', runnerToken: 'RUNNER', parkDelayMs: 0 });
  host.unreadAtStart = (id) => db.prepare('SELECT COUNT(*) n FROM mail WHERE recipient = ? AND seen_at IS NULL').get(id).n;
  await core.call('slots.set', { slots });
  await core.call('delegator.start', { repo: 'gitgiant/demo' });
  const row = (id) => db.prepare('SELECT * FROM agents WHERE id = ?').get(id);
  const who = (id) => core.authenticate(row(id).token, 'ADMIN');
  const runner = core.authenticate('RUNNER', 'ADMIN');
  const claim = async () => { const j = (await core.call('test.claim', { wait: 0 }, runner)).job; return j && { ...j, agent: db.prepare('SELECT agent FROM tests WHERE id = ?').get(j.id).agent }; };
  const kinds = async () => (await core.call('wait', { timeout: 0 })).events.map(e => e.kind);
  /** Spawned, started (its session recorded), reported and idle: parked. */
  async function parked(brief = 'task') {
    const { id } = await core.call('spawn', { brief, vendor: 'claude', mode: 'cheapest' });
    await settle();
    await core.call('hook', { vendor: 'claude', event: 'SessionStart', sessionId: `sess-${id}` }, who(id));
    await core.call('report', { text: 'did it' }, who(id));
    await settle();
    await core.call('hook', { vendor: 'claude', event: 'Stop' }, who(id));
    await settle();
    return id;
  }
  return { db, host, gh, core, row, who, runner, kinds, parked, claim };
}

test('report → parked: container removed, slot free, a queued agent starts in that slot', async () => {
  const { host, core, row, who, kinds, db } = await setup();
  const { id: a } = await core.call('spawn', { brief: 'first', vendor: 'claude', mode: 'cheapest' });
  await settle();
  const { id: b, state } = await core.call('spawn', { brief: 'second', vendor: 'claude', mode: 'cheapest' });
  assert.equal(state, 'queued'); // one claude slot, taken by a
  await core.call('hook', { vendor: 'claude', event: 'SessionStart', sessionId: 'sess-a' }, who(a));
  await core.call('report', { text: 'did it' }, who(a));
  await settle();
  const before = host.calls.length;
  assert.equal(row(a).state, 'done'); // the TUI is still finishing the turn that reported
  await core.call('hook', { vendor: 'claude', event: 'Stop' }, who(a));
  await settle();

  assert.equal(row(a).state, 'parked');
  assert.ok(host.calls.some(c => c[0] === 'stop' && c[2] === a));
  assert.deepEqual(host.sessions.saved, [{ slot: 'hl-w1', vendor: 'claude', id: a, sessionId: 'sess-a' }]);
  assert.match(db.prepare("SELECT value FROM kv WHERE key = ?").get(`screen:${a}`).value, /screen of/);
  assert.equal(row(b).state, 'working');
  assert.equal(row(b).slot, 'hl-w1');
  assert.equal(row(a).dir, `/hl/work/${a}`); // the clone stays
  assert.ok(!host.calls.slice(before).some(c => c[1] === 'rm' && c.includes(row(a).dir)));
  const ev = await kinds();
  assert.ok(ev.includes('report') && ev.includes('parked'), ev.join());
  // The gate still runs for a parked agent; attach explains instead of failing on a missing container.
  assert.equal(db.prepare("SELECT COUNT(*) n FROM tests WHERE agent = ? AND purpose = 'gate'").get(a).n, 1);
  await assert.rejects(core.call('attach', { agent: a }), /is parked.*hauptling restart/);
});

test('a quiet reported worker is parked by the watchdog; one reworked first keeps its container', async () => {
  const { core, row, who, db, runner, host , claim } = await setup({ slots: ['hl-w1', 'hl-w2'] });
  const { id: a } = await core.call('spawn', { brief: 'a', vendor: 'claude', mode: 'cheapest' });
  const { id: b } = await core.call('spawn', { brief: 'b', vendor: 'claude', mode: 'cheapest' });
  await settle();
  for (const x of [a, b]) await core.call('report', { text: 'done' }, who(x));
  await settle();
  // b's gate fails before it is parked: back to working, container kept.
  const job = await claim();
  const other = job.agent === a ? b : a;
  await core.call('test.report', { id: job.id, report: { sha: job.sha, status: 'fail', passed: 0, failed: 1, skipped: 0, failures: [], duration_s: 1 } }, runner);
  await settle();
  assert.equal(row(job.agent).state, 'working');
  db.prepare('UPDATE agents SET idle = 1 WHERE id IN (?, ?)').run(a, b); // both ended their turn (the Stop-hook timer was lost, e.g. a broker restart)
  await core.watch(Date.now() + 3 * 60e3);
  assert.equal(row(other).state, 'parked');
  assert.equal(row(job.agent).state, 'working');
  assert.ok(!host.calls.some(c => c[0] === 'stop' && c[2] === job.agent));
  assert.equal(db.prepare('SELECT COUNT(*) n FROM mail WHERE recipient = ?').get(other).n, 0);
});

test('mail typed into a reported worker before it is parked keeps it running; mail during parking unparks it', async () => {
  const { core, row, who, host, db } = await setup();
  const { id: a } = await core.call('spawn', { brief: 'a', vendor: 'claude', mode: 'cheapest' });
  await settle();
  await core.call('report', { text: 'done' }, who(a));
  db.prepare('UPDATE agents SET idle = 1 WHERE id = ?').run(a);
  await core.call('reply', { agent: a, text: 'quick question' }); // typed: it is busy again
  assert.equal(host.typed.length, 1);
  await core.watch(Date.now() + 3 * 60e3);
  assert.equal(row(a).state, 'done');

  db.prepare('UPDATE agents SET idle = 1 WHERE id = ?').run(a);
  let release;
  host.stopWorker = (slot, id) => new Promise(r => { release = r; host.calls.push(['stop', slot, id]); });
  const parking = core.watch(Date.now() + 3 * 60e3);
  await settle();
  await core.call('reply', { agent: a, text: 'arrived while parking' });
  assert.equal(host.typed.length, 1); // not typed into the container being removed
  release();
  await parking;
  await settle();
  assert.equal(row(a).state, 'working'); // parked, then unparked for the mail
  assert.equal(host.starts.filter(s => s.id === a).length, 2);
  assert.equal(host.starts.at(-1).unread, 1);
});

test('gate failure → unparked at the front of the queue, session copied into the new slot, mail delivered after start', async () => {
  const { host, core, row, who, kinds, runner, parked , claim } = await setup();
  const a = await parked('first');
  const { id: b } = await core.call('spawn', { brief: 'second', vendor: 'claude', mode: 'cheapest' });
  await settle();
  assert.equal(row(b).slot, 'hl-w1'); // took a's slot
  const { id: c } = await core.call('spawn', { brief: 'third', vendor: 'claude', mode: 'cheapest' });
  assert.equal(row(c).state, 'queued');
  await kinds();

  const job = await claim();
  assert.equal(job.agent, a);
  await core.call('test.report', { id: job.id, report: { sha: job.sha, status: 'fail', passed: 0, failed: 2, skipped: 0, failures: [], duration_s: 1 } }, runner);
  await settle();
  assert.equal(row(a).state, 'queued'); // no slot free yet
  assert.equal(row(a).unpark, 'gate failed');
  assert.equal(host.typed.length, 0);

  // A second slot appears (or b finishes): a goes first, ahead of the older queued c.
  await core.call('slots.set', { slots: ['hl-w1', 'hl-w2'] });
  await core.poll();
  await settle();
  assert.equal(row(a).state, 'working');
  assert.equal(row(a).slot, 'hl-w2');
  assert.equal(row(c).state, 'queued');
  assert.deepEqual(host.sessions.restored, [{ slot: 'hl-w2', vendor: 'claude', id: a, billing: 'plan' }]);
  const start = host.starts.at(-1);
  assert.equal(start.id, a);
  assert.deepEqual(start.resumeArgv.slice(-3), ['--resume', `sess-${a}`, start.resumeArgv.at(-1)]);
  assert.match(start.resumeArgv.at(-1), /parked.*new mail/);
  assert.equal(start.unread, 1); // the mail waited for the start…
  const ctx = await core.call('hook', { vendor: 'claude', event: 'UserPromptSubmit', sessionId: `sess-${a}` }, who(a));
  assert.match(ctx.context, /Gate test job .* fail/); // …and arrives with the resumed session's first prompt
  const ev = await kinds();
  assert.ok(ev.includes('gate-failed') && ev.includes('unparked'), ev.join());
});

test('reply to a parked worker unparks it; the reply is delivered once it runs', async () => {
  const { host, core, row, who, kinds, parked, db } = await setup();
  const a = await parked();
  await kinds();
  await core.call('reply', { agent: a, text: 'also update the README' });
  await settle();
  assert.equal(row(a).state, 'working');
  assert.equal(row(a).slot, 'hl-w1');
  assert.equal(host.starts.at(-1).unread, 1);
  const ev = (await core.call('wait', { timeout: 0 })).events;
  assert.deepEqual(ev.map(e => e.kind), ['unparked']);
  assert.match(ev[0].text, /session resumed\): mail arrived/);
  const ctx = await core.call('hook', { vendor: 'claude', event: 'SessionStart', sessionId: `sess-${a}` }, who(a));
  assert.match(ctx.context, /also update the README/);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM mail WHERE recipient = ? AND seen_at IS NULL').get(a).n, 0);
  assert.equal(host.typed.length, 0);
});

test('CI failure and restart unpark a parked worker too', async () => {
  const { gh, core, row, parked, host } = await setup();
  const a = await parked();
  assert.equal(row(a).pr_number, 5);
  gh.checks = [{ name: 'lint', conclusion: 'FAILURE' }];
  await core.poll();
  await settle();
  assert.equal(row(a).state, 'working');
  assert.equal(row(a).ci_note, 'abc1234def');

  gh.checks = [];
  assert.match((await core.call('hook', { vendor: 'claude', event: 'UserPromptSubmit' }, core.authenticate(row(a).token, 'ADMIN'))).context, /CI failed on abc1234d: lint/);
  await core.call('report', { text: 'fixed CI' }, core.authenticate(row(a).token, 'ADMIN'));
  await core.call('hook', { vendor: 'claude', event: 'Stop' }, core.authenticate(row(a).token, 'ADMIN'));
  await settle();
  assert.equal(row(a).state, 'parked');
  const r = await core.call('restart', { agent: a });
  assert.equal(r.restarted, a);
  await settle();
  assert.equal(row(a).state, 'working');
  assert.match(host.starts.at(-1).resumeArgv.at(-1), /^Continue the task/); // no mail: the plain resume prompt
});

test('no saved session: the unparked worker starts fresh with the parked preamble', async () => {
  const { host, core, row, parked } = await setup();
  host.state.saved = [];
  const a = await parked();
  assert.match((await core.call('wait', { timeout: 0 })).events.find(e => e.kind === 'parked').text, /no session saved/);
  await core.call('mail.send', { from: 'user', to: a, text: 'one more thing' });
  await settle();
  assert.equal(row(a).state, 'working');
  const start = host.starts.at(-1);
  assert.equal(start.resumeArgv, undefined);
  assert.match(start.argv.at(-1), /You were parked after your report/);
  assert.match(host.state.brief, /^You were parked after your report/);
  assert.match((await core.call('wait', { timeout: 0 })).events.at(-1).text, /fresh launch: no saved session/);
});

test('merge of a parked agent cleans up its clone and saved session without a container', async () => {
  const { host, gh, core, row, runner, parked, db , claim } = await setup();
  const a = await parked();
  const stops = host.calls.filter(c => c[0] === 'stop').length;
  const job = await claim();
  await core.call('test.report', { id: job.id, report: { sha: job.sha, status: 'pass', passed: 3, failed: 0, skipped: 0, failures: [], duration_s: 1 } }, runner);
  await settle();
  assert.equal(gh.merged, true);
  assert.equal(row(a).state, 'merged');
  assert.ok(host.calls.some(c => c[1] === 'rm' && c[2] === '-rf' && c[3] === `/hl/work/${a}`));
  assert.deepEqual(host.sessions.dropped, [a]);
  assert.equal(db.prepare('SELECT value FROM kv WHERE key = ?').get(`screen:${a}`), undefined);
  assert.equal(host.starts.filter(s => s.id === a).length, 1); // never started again to merge
  assert.ok(host.calls.filter(c => c[0] === 'stop').length - stops <= 1); // at most a no-op rm of the gone container
});

test('pause holds a parked agent without Docker; unpause after a failed gate unparks it; kill drops the session', async () => {
  const { host, core, row, runner, parked , claim } = await setup();
  host.pauseWorker = async () => { throw new Error('no container to pause'); };
  host.unpauseWorker = async () => { throw new Error('no container to unpause'); };
  const a = await parked();
  await core.call('pause', { agent: a });
  assert.equal(row(a).state, 'paused');
  assert.equal(row(a).paused_state, 'parked');
  assert.equal((await core.call('test.claim', { wait: 0 }, runner)).job, null); // its gate is held
  await core.call('unpause', { agent: a });
  assert.equal(row(a).state, 'parked');

  await core.call('pause', { agent: a });
  await core.call('merge', { agent: a }).catch(() => {}); // no passing gate yet: refused, nothing changes
  assert.equal(row(a).state, 'paused');
  await core.call('unpause', { agent: a });
  const job = await claim();
  await core.call('pause', { agent: a });
  await core.call('test.report', { id: job.id, report: { sha: job.sha, status: 'fail', passed: 0, failed: 1, skipped: 0, failures: [], duration_s: 1 } }, runner);
  await settle();
  assert.equal(row(a).state, 'paused'); // the result waits for unpause
  await core.call('unpause', { agent: a });
  await settle();
  assert.equal(row(a).state, 'working');

  await core.call('kill', { agent: a });
  assert.equal(row(a).state, 'killed');
  assert.deepEqual(host.sessions.dropped, [a]);
});

// ---------- paused workers give way (PRD "Paused workers give way") ----------
/** \`n\` running agents with recorded sessions, of a delegator allowing \`max\`. */
async function running({ n = 3, max = 3, slots = ['hl-w1', 'hl-w2', 'hl-w3'], maxWorkers } = {}) {
  const s = await setup({ slots });
  if (maxWorkers) s.host.maxWorkers = () => maxWorkers;
  const { id: delegator } = await s.core.call('delegator.start', { repo: 'gitgiant/demo', max });
  const spawn = async (brief = 'task') => { const r = await s.core.call('spawn', { delegator, brief, vendor: 'claude', mode: 'cheapest' }); await settle(); return r.id; };
  const ids = [];
  for (let i = 0; i < n; i++) {
    const id = await spawn(`task ${i}`);
    await s.core.call('hook', { vendor: 'claude', event: 'SessionStart', sessionId: `sess-${id}` }, s.who(id));
    ids.push(id);
  }
  const pause = async (id) => { await s.core.call('pause', { agent: id }); await settle(); };
  const events = (id) => s.db.prepare('SELECT kind, text FROM events WHERE agent = ? ORDER BY id').all(id);
  const head = async (id) => (await createDashboard({ db: s.db, dbPath: ':memory:', core: s.core, host: s.host }).snapshot()).agents.find(a => a.id === id).headline;
  return { ...s, delegator, ids, spawn, pause, events, head };
}

test('paused queued agents count toward no limit: an unpaused one starts past them', async () => {
  const s = await running({ n: 0, max: 3, maxWorkers: 3 });
  await s.core.call('slots.set', { slots: [] }); // nothing can start yet
  const queued = [await s.spawn(), await s.spawn(), await s.spawn()];
  for (const id of queued) await s.pause(id);
  await s.core.call('slots.set', { slots: ['hl-w1'] });
  const next = await s.spawn('the one I want');
  assert.equal(s.row(next).state, 'working');
  assert.ok(queued.every(id => s.row(id).state === 'paused'));
});

test('pause and unpause with nobody waiting only freeze: no parking', async () => {
  const s = await running();
  for (const id of s.ids) await s.pause(id);
  await s.core.poll();
  await settle();
  assert.ok(s.ids.every(id => s.row(id).state === 'paused' && !s.row(id).parked));
  assert.ok(!s.host.calls.some(c => c[0] === 'stop'));
  await s.core.call('unpause', { agent: s.ids[0] });
  assert.equal(s.row(s.ids[0]).state, 'working');
  assert.deepEqual(s.events(s.ids[0]).map(e => e.kind), ['paused', 'resumed']);
});

test('the longest-paused worker gives way to a queued agent; unpaused, it is queued first and resumes its session', async () => {
  const s = await running();
  const [a, b, c] = s.ids;
  for (const id of [b, a, c]) { await s.pause(id); }
  const next = await s.spawn('needs a place');
  assert.equal(s.row(next).state, 'working');
  assert.equal(s.row(next).slot, 'hl-w2');
  assert.deepEqual([s.row(b).state, s.row(b).paused_state, s.row(b).parked], ['paused', 'working', 1]);
  assert.ok([a, c].every(id => s.row(id).state === 'paused' && !s.row(id).parked), 'only as many as needed');
  assert.deepEqual(s.host.sessions.saved, [{ slot: 'hl-w2', vendor: 'claude', id: b, sessionId: `sess-${b}` }]);
  assert.match(s.db.prepare('SELECT value FROM kv WHERE key = ?').get(`screen:${b}`).value, /screen of/);
  assert.match(s.events(b).find(e => e.kind === 'parked').text, new RegExp(`paused, slot needed by ${next}`));
  assert.equal(await s.head(b), 'Paused by you (parked, slot freed)');
  assert.equal(await s.head(a), 'Paused by you');
  await assert.rejects(s.core.call('attach', { agent: b }), /paused and parked/);

  // Unpaused while every place is taken: it parks the next paused one and goes ahead of an older queued agent.
  const waiting = await s.spawn('also queued');
  assert.equal(s.row(a).parked, 1, 'a, paused second, made room for it');
  const later = await s.spawn('queued behind');
  assert.equal(s.row(c).parked, 1);
  const last = await s.spawn('nothing left to park');
  assert.equal(s.row(last).state, 'queued');
  await s.core.call('unpause', { agent: b });
  assert.deepEqual([s.row(b).state, s.row(b).unpark], ['queued', 'unpaused']);
  assert.deepEqual((await s.core.call('queue.list', { delegator: s.delegator })).queue.map(q => q.id), [b, last]);
  await s.core.call('kill', { agent: waiting });
  await settle();
  assert.equal(s.row(b).state, 'working');
  assert.equal(s.row(b).parked, 0);
  assert.equal(s.row(last).state, 'queued');
  assert.equal(s.row(later).state, 'working');
  const start = s.host.starts.filter(o => o.id === b).at(-1);
  assert.deepEqual(start.resumeArgv.slice(-3, -1), ['--resume', `sess-${b}`]);
  assert.match(start.resumeArgv.at(-1), /paused mid-task.*working tree/);
  assert.match(s.host.state.brief, /^You were paused mid-task/);
  assert.deepEqual(s.events(b).map(e => e.kind), ['paused', 'parked', 'resumed', 'unparked']);
});

test('an already waiting agent gets the slot as soon as the worker is paused; parked ones hold no slot or maxWorkers place', async () => {
  const s = await running({ n: 1, max: 5, slots: ['hl-w1', 'hl-w2'], maxWorkers: 1 });
  const [a] = s.ids;
  const next = await s.spawn();
  assert.equal(await s.head(next), `Queued: waiting for a free worker (maxWorkers 1, busy: ${a})`);
  await s.pause(a);
  assert.equal(s.row(a).parked, 1);
  assert.equal(s.row(next).state, 'working');
  assert.deepEqual(s.core.freeSlots('claude'), ['hl-w2'], 'only the new one holds a slot');
  await s.core.call('kill', { agent: a });
  assert.equal(s.row(a).state, 'killed');
});

test('the queued headline names the blocker: the slot holders, or max_agents', async () => {
  const s = await running({ n: 1, max: 5, slots: ['hl-w1'] });
  const [a] = s.ids;
  const next = await s.spawn();
  assert.equal(await s.head(next), `Queued: waiting for a free claude slot (hl-w1 busy: ${a})`);
  s.db.prepare('UPDATE delegators SET max_agents = 1 WHERE id = ?').run(s.delegator);
  assert.equal(await s.head(next), `Queued: waiting: ${s.delegator} is at max_agents 1 (busy: ${a})`);
});

test('a paused reported worker that gives way is an ordinary parked one', async () => {
  const s = await running({ n: 1, max: 5, slots: ['hl-w1'] });
  const [a] = s.ids;
  await s.core.call('report', { text: 'did it' }, s.who(a));
  await settle();
  await s.pause(a);
  const next = await s.spawn();
  assert.deepEqual([s.row(a).state, s.row(a).paused_state, s.row(a).parked], ['paused', 'parked', 0]);
  assert.equal(s.row(next).state, 'working');
  await s.core.call('unpause', { agent: a });
  assert.equal(s.row(a).state, 'parked');
});
