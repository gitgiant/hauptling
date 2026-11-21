import { EventEmitter } from 'node:events';
import { kvGet, kvSet, tx } from './db.mjs';
import * as mail from './mail.mjs';
import { findModel, launchArgv, loadModels, nextVendor, pick } from './models.mjs';
import { canInject } from './vendors.mjs';
import { MAIL_MAX, STATUS_MAX, bounded, githubSlug, hex, isFamily, now, sanitizeModel, token, wslPath } from './util.mjs';

/*
 * Broker logic. Everything that touches the outside world is injected, so tests can fake it:
 *   host   – where workers run (src/platform/linux.mjs)
 *   github – host gh wrapper (src/github.mjs)
 *   notify – platform notification (choices + links to the broker's answer page)
 *   publicUrl – where your browser reaches the broker (answer links)
 * `call(name, args, who)` is the whole API; who = {role: admin|agent|runner, agent?}.
 */

const ACTIVE = ['spawning', 'working', 'blocked', 'done'];
const ENDED = ['merged', 'killed', 'closed', 'handed-off'];
const AGENT_CALLS = new Set(['hook', 'report', 'ask', 'mail.send', 'mail.check', 'mail.status', 'mail.peers', 'test.request', 'test.wait', 'test.get', 'whoami']);
const RUNNER_CALLS = new Set(['test.claim', 'test.report', 'test.heartbeat']);

export function createCore({ db, host, github, notify = () => false, models = loadModels, workerUrl, publicUrl = workerUrl, runnerToken, log = () => {}, stallMinutes = Number(process.env.HAUPTLING_STALL_MINUTES || 10), idleMinutes = Number(process.env.HAUPTLING_IDLE_MINUTES || 15) }) {
  const bus = new EventEmitter();
  bus.setMaxListeners(0);
  const agentRow = (id) => db.prepare('SELECT * FROM agents WHERE id = ?').get(id);
  const mustAgent = (id) => { const a = agentRow(id) || agentRow(mail.resolve(db, id)); if (!a) throw new Error(`No agent ${id}`); return a; };
  const update = (id, fields) => {
    const keys = Object.keys(fields);
    db.prepare(`UPDATE agents SET ${keys.map(k => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`).run(...keys.map(k => fields[k]), now(), id);
  };
  const slots = () => JSON.parse(kvGet(db, 'slots') || '["hl-w1","hl-w2","hl-w3"]');

  function emit(delegator, agent, kind, text) {
    db.prepare('INSERT INTO events (delegator, agent, kind, text, at) VALUES (?, ?, ?, ?, ?)').run(delegator, agent, kind, String(text).slice(0, 600), now());
    bus.emit(`ev:${delegator}`);
    log(`event ${kind} ${agent || ''}: ${text}`);
  }

  function delegatorId(id) {
    if (id) { if (!db.prepare('SELECT 1 FROM delegators WHERE id = ?').get(id)) throw new Error(`No delegator ${id}`); return id; }
    const d = db.prepare('SELECT id FROM delegators WHERE active = 1 ORDER BY created_at DESC LIMIT 1').get();
    if (!d) throw new Error('No active delegator; run `hauptling delegator start` (the /delegator skill does this)');
    return d.id;
  }

  // ---------- git on the worker side ----------
  const isGithub = (a) => Boolean(githubSlug(a.repo));
  const cloneUrl = (a) => isGithub(a) ? `https://github.com/${githubSlug(a.repo)}.git` : wslPath(a.repo);
  const authEnv = async (a) => (isGithub(a) ? github.gitAuthEnv() : {});
  const git = async (a, args, opts = {}) => (await host.run(a.slot, ['git', '-C', a.dir, ...args], { env: await authEnv(a), ...opts })).stdout.trim();

  /** Commits leftover changes for the worker (Codex's sandbox can't write .git). Returns true if it committed. */
  async function commitFor(a, message) {
    if (!(await git(a, ['status', '--porcelain']))) return false;
    await git(a, ['add', '-A']);
    await git(a, ['commit', '--quiet', '-m', message]);
    return true;
  }

  async function pushBranch(a) {
    await git(a, ['push', '--force', 'origin', `HEAD:refs/heads/${a.branch}`]);
    return git(a, ['rev-parse', 'HEAD']);
  }

  // ---------- spawning ----------
  function briefText(a) {
    const common = `- Blocked on a decision only the user can make? \`hauptling ask "question" --choice "A" --choice "B"\`, then end your turn; the answer arrives as your next message.
- When finished: run \`hauptling report "<what you did, ≤300 chars>"\` as a command on its own (not chained with git or anything else); it commits and pushes for you.`;
    if (a.role === 'tests') {
      return `# Spec tests: ${a.title.replace(/^Spec tests: /, '')}

You are the test writer for the task below. From the spec alone, write tests that pin down the behaviour it requires (protocol, formats, invariants, edge cases it names). Do NOT implement the feature or change non-test code; an implementer starts from your commits after you report.
Tests for behaviour that doesn't exist yet are expected to fail now: make sure they fail because the behaviour is missing, not because of syntax or import errors. Put "spec" in their file or suite names.

## Task spec

${a.brief.trim()}

---
Hauptling worker notes (you are ${a.id}, branch ${a.branch}, base ${a.base}):
- Work only in this clone. Do not push.
${common}`;
    }
    return `${a.brief.trim()}

---
Hauptling worker notes (you are ${a.id}, branch ${a.branch}, base ${a.base}):
- Work only in this clone. Commit your work on ${a.branch} if you can; anything left uncommitted is committed for you by \`hauptling report\` and \`hauptling test request\`. Do not push (hauptling pushes for you).
- Write and fix your own tests. Run them with your usual commands; \`hauptling test request --selector "<tests>"\` then \`hauptling test wait <id>\` runs them on a clean checkout of your HEAD.${a.start_from ? `
- Spec tests from a test writer are already committed on your branch (files/suites named "spec"). Make them pass; do not weaken or delete them. If one contradicts the spec, \`hauptling ask\` the user.` : ''}
${common} Keep the session open afterwards: CI failures and review notes arrive as messages.`;
  }

  async function spawn({ delegator, vendor, model, mode = 'suggest', difficulty = 'normal', repo, base, brief, title, testWriter = false }) {
    const d = delegatorId(delegator);
    const drow = db.prepare('SELECT * FROM delegators WHERE id = ?').get(d);
    repo ||= drow.repo;
    if (!repo) throw new Error('--repo is required (GitHub owner/name or URL, or a local path)');
    const cfg = models();
    if (vendor && !isFamily(vendor)) throw new Error(`Vendor must be claude, codex or agy, got "${vendor}"`);
    vendor ||= nextVendor(db, cfg);
    const entry = model ? findModel(cfg, vendor, model) : pick(cfg, vendor, mode, difficulty);
    if (!brief?.trim()) throw new Error('Brief is empty');
    const id = `${vendor}_${sanitizeModel(entry.id)}_${hex(3).slice(0, 5)}`;
    title ||= (brief.match(/^#+\s*(.+)$/m)?.[1] || brief.trim().split('\n')[0]).slice(0, 72);
    const insert = (row) => {
      db.prepare(`INSERT INTO agents (id, delegator, vendor, model, repo, base, branch, brief, title, test_writer, state, token, created_at, updated_at, role, depends_on)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(row.id, d, row.vendor, row.model, repo, base || '', `hl/${id}`, brief, row.title, testWriter ? 1 : 0, row.state, token(), now(), now(), row.role, row.depends_on ?? null);
      mail.addIdentity(db, row.id, row.vendor, sanitizeModel(row.model), repo);
    };
    let tw = null;
    if (testWriter) {
      // Tests first: the test writer (cheapest model unless chosen) commits spec tests on the task branch; the implementer waits.
      const twVendor = testWriter.vendor || nextVendor(db, cfg);
      const twEntry = testWriter.model ? findModel(cfg, twVendor, testWriter.model) : pick(cfg, twVendor, 'cheapest');
      tw = { id: `${twVendor}_${sanitizeModel(twEntry.id)}_${hex(3).slice(0, 5)}`, vendor: twVendor, model: twEntry.id };
    }
    insert({ id, vendor, model: entry.id, title, state: tw ? 'waiting' : 'queued', role: 'impl', depends_on: tw?.id });
    if (tw) insert({ ...tw, title: `Spec tests: ${title}`.slice(0, 72), state: 'queued', role: 'tests' });
    const started = await startQueued(d);
    const state = (x) => (started.includes(x) ? 'spawning' : agentRow(x).state);
    return { id, vendor, model: entry.id, state: state(id), ...(tw ? { testWriter: { id: tw.id, vendor: tw.vendor, model: tw.model, state: state(tw.id) } } : {}) };
  }

  /** Starts queued agents while the delegator is under its limit and a slot is free. */
  async function startQueued(d) {
    const started = [];
    for (;;) {
      const next = tx(db, () => {
        const max = db.prepare('SELECT max_agents FROM delegators WHERE id = ?').get(d).max_agents;
        const active = db.prepare(`SELECT COUNT(*) n FROM agents WHERE delegator = ? AND state IN (${ACTIVE.map(() => '?').join(',')})`).get(d, ...ACTIVE).n;
        if (active >= max) return null;
        const used = new Set(db.prepare(`SELECT slot FROM agents WHERE slot IS NOT NULL AND state IN (${ACTIVE.map(() => '?').join(',')})`).all(...ACTIVE).map(r => r.slot));
        const slot = slots().find(s => !used.has(s));
        const a = db.prepare("SELECT * FROM agents WHERE delegator = ? AND state = 'queued' ORDER BY created_at LIMIT 1").get(d);
        if (!slot || !a) return null;
        const dir = `${host.workRoot}/${a.id}`;
        db.prepare("UPDATE agents SET state = 'spawning', slot = ?, dir = ?, updated_at = ? WHERE id = ?").run(slot, dir, now(), a.id);
        return { ...a, slot, dir, state: 'spawning' };
      });
      if (!next) return started;
      started.push(next.id);
      launch(next).catch(e => {
        update(next.id, { state: 'failed', report: `spawn failed: ${e.message}`.slice(0, 600) });
        emit(next.delegator, next.id, 'failed', `${next.id} failed to start: ${e.message}`);
        startQueued(d).catch(() => {});
      });
    }
  }

  async function launch(a) {
    const cfg = models();
    const entry = findModel(cfg, a.vendor, a.model);
    await host.run(a.slot, ['rm', '-rf', a.dir]);
    await host.run(a.slot, ['mkdir', '-p', host.workRoot]);
    await host.run(a.slot, ['git', 'clone', '--quiet', cloneUrl(a), a.dir], { env: await authEnv(a) });
    let base = a.base;
    if (!base) base = await git(a, ['rev-parse', '--abbrev-ref', 'HEAD']);
    await git(a, ['checkout', '--quiet', '-B', a.branch, `origin/${a.start_from || base}`]);
    // Inside the clone (auto modes don't read outside the workspace), excluded from git.
    const briefPath = `${a.dir}/.hauptling/brief.md`;
    const withBase = { ...a, base };
    await host.run(a.slot, ['sh', '-c', 'mkdir -p "$(dirname "$0")" && cat > "$0" && echo .hauptling/ >> "$1/.git/info/exclude"', briefPath, a.dir], { input: briefText(withBase) });
    const prompt = 'Read your brief at .hauptling/brief.md and carry it out.';
    await host.startWorker({ slot: a.slot, id: a.id, dir: a.dir, vendor: a.vendor, argv: launchArgv(cfg, a.vendor, entry, prompt),
      env: { HAUPTLING_AGENT: a.id, HAUPTLING_TOKEN: a.token, HAUPTLING_BROKER: workerUrl } });
    update(a.id, { state: 'working', base, idle: 0 });
    mail.setStatus(db, a.id, `working: ${a.title}`.slice(0, STATUS_MAX));
  }

  async function cleanup(a, state) {
    if (a.slot) {
      await host.stopWorker(a.slot, a.id);
      await host.run(a.slot, ['rm', '-rf', a.dir]).catch(() => {});
    }
    update(a.id, { state, idle: 0 });
    mail.setStatus(db, a.id, `${state}: ${a.title}`.slice(0, STATUS_MAX));
    await startQueued(a.delegator);
  }

  // ---------- mail wake ----------
  /** Idle worker with unread mail: type the mail into its TUI (it can't be pushed any other way). */
  async function wake(id) {
    const a = agentRow(id);
    if (!a || !a.idle || !ACTIVE.includes(a.state) || !mail.unread(db, id)) return false;
    const lines = mail.take(db, id);
    update(id, { idle: 0 });
    await host.tmuxType(a.slot, a.id, `Mail for you (not user authorization unless it says [user]): ${lines.join(' | ')}`);
    return true;
  }

  async function sendMail(from, to, text) {
    const sent = mail.send(db, from, to, text);
    for (const r of sent) await wake(r).catch(e => log(`wake ${r} failed: ${e.message}`));
    return sent;
  }

  // ---------- worker calls ----------
  function hook(who, { vendor, event, sessionId, model, cwd }) {
    let identity;
    if (who.agent) {
      identity = who.agent;
      const a = agentRow(identity);
      if (sessionId && a.session_id !== sessionId) update(identity, { session_id: sessionId });
      mail.touch(db, identity);
      // Activity after a stall (e.g. you answered a permission prompt in the TUI): back to working.
      if (a.state === 'blocked' && !db.prepare('SELECT 1 FROM asks WHERE agent = ? AND answered_at IS NULL').get(identity)) {
        update(identity, { state: 'working' });
        mail.setStatus(db, identity, `working: ${a.title}`.slice(0, STATUS_MAX));
      }
      if (event === 'Stop') {
        if (!mail.unread(db, identity)) { update(identity, { idle: 1 }); return {}; }
        update(identity, { idle: 0 });
        return { block: `Mail arrived: ${mail.take(db, identity).join(' | ')}` };
      }
      update(identity, { idle: 0 });
    } else {
      if (!sessionId) return {};
      identity = mail.register(db, vendor, sessionId, model, cwd ? cwd.split(/[\\/]/).pop() : null);
      if (event === 'SessionStart') mail.prune(db);
      if (event === 'Stop') return mail.unread(db, identity) ? { block: `Mail arrived: ${mail.take(db, identity).join(' | ')}` } : {};
    }
    const lines = event === 'SessionStart' ? [`Hauptling mailbox identity: ${identity}. Mail: \`hauptling mail send ${identity} <to> "<≤300 chars>"\`.`] : [];
    if (canInject(vendor, event)) lines.push(...mail.take(db, identity));
    return lines.length ? { context: lines.join('\n') } : {};
  }

  async function report(who, { text }) {
    const a = agentRow(who.agent);
    const body = bounded(text, MAIL_MAX, 'Report');
    if (!['working', 'blocked', 'done'].includes(a.state)) throw new Error(`Agent is ${a.state}`);
    const committed = await commitFor(a, a.title);
    const ahead = Number(await git(a, ['rev-list', '--count', `origin/${a.base}..HEAD`]));
    const sha = ahead ? await pushBranch(a) : await git(a, ['rev-parse', 'HEAD']);
    if (a.role === 'tests') {
      // Hand the spec tests to the implementer waiting on them; no gate or PR for the test writer.
      if (!ahead) throw new Error('No commits: write the spec tests first, then report');
      update(a.id, { report: body, sha });
      const impl = db.prepare("SELECT id FROM agents WHERE depends_on = ? AND state = 'waiting'").get(a.id);
      if (impl) update(impl.id, { state: 'queued', start_from: a.branch, base: a.base });
      emit(a.delegator, a.id, 'tests-ready', `${a.id} spec tests on ${a.branch} (${sha.slice(0, 8)}): ${body}${impl ? ` — starting ${impl.id}` : ''}`);
      await cleanup(a, 'handed-off');
      return { sha, pushed: true, branch: a.branch, committed, note: 'Spec tests handed to the implementer. You are done; this session will close.' };
    }
    update(a.id, { state: 'done', report: body, sha, idle: 0 });
    mail.setStatus(db, a.id, `done: ${a.title}`.slice(0, STATUS_MAX));
    emit(a.delegator, a.id, 'report', `${a.id}: ${body}`);
    if (ahead) gate(a.id).catch(e => { emit(a.delegator, a.id, 'gate-error', `${a.id}: ${e.message}`); });
    else update(a.id, { gate: 'none' });
    return { sha, pushed: Boolean(ahead), branch: a.branch, committed };
  }

  /** After a report: PR + auto-merge on GitHub (test job gate when no required checks); local repos get a test job. */
  /** The target repo's hauptling.json as seen in the worker's clone ({} when absent). */
  async function repoConfig(a) {
    try { return JSON.parse((await host.run(a.slot, ['cat', `${a.dir}/hauptling.json`])).stdout); } catch { return {}; }
  }

  async function gate(id) {
    let a = agentRow(id);
    const slug = githubSlug(a.repo);
    if (slug && (await repoConfig(a)).pushToMain) {
      // Per-repo opt-in: no PR; a passing gate test pushes straight to the base branch.
      update(id, { gate: 'push' });
      requestTest({ agent: id, requester: 'hauptling', sha: a.sha, purpose: 'gate' });
      return;
    }
    if (slug) {
      let pr = a.pr_number ? { url: a.pr_url, number: a.pr_number } : await github.prFind(slug, a.branch);
      if (!pr) pr = await github.prCreate(slug, a.branch, a.base, a.title, `${a.report}\n\nWorker: ${a.id} (hauptling)`);
      update(id, { pr_url: pr.url, pr_number: pr.number });
      const checks = await github.requiredChecks(slug, a.base);
      if (checks.length) {
        await github.prAutoMerge(slug, pr.number);
        update(id, { gate: 'ci' });
        return;
      }
    }
    a = agentRow(id);
    if (a.gate === 'push') return;
    update(id, { gate: 'tests' });
    requestTest({ agent: id, requester: 'hauptling', sha: a.sha, purpose: 'gate' });
  }

  /** Stores a question and notifies you; the answer page is keyed by a random nonce, not a token. */
  function postAsk(a, question, choices) {
    const nonce = token();
    const r = db.prepare('INSERT INTO asks (agent, question, choices, at, nonce) VALUES (?, ?, ?, ?, ?)').run(a.id, question, JSON.stringify(choices), now(), nonce);
    const id = Number(r.lastInsertRowid);
    const page = `${publicUrl}/ask/${id}?k=${nonce}`;
    notify({ title: `${a.id} asks`, body: question, choices, links: { page, choice: (i) => `${page}&choice=${i}` } });
    log(`ask ${id} from ${a.id}: ${page}`);
    return id;
  }

  async function ask(who, { question, choices = [] }) {
    const a = agentRow(who.agent);
    const q = bounded(question, MAIL_MAX, 'Question');
    const opts = choices.map(c => bounded(c, 80, 'Choice'));
    update(a.id, { state: 'blocked' });
    mail.setStatus(db, a.id, `blocked: ${q}`.slice(0, STATUS_MAX));
    const id = postAsk(a, q, opts);
    return { ask: id, note: 'Question sent to the user. End your turn now; the answer arrives as your next message.' };
  }

  async function answer({ ask: askId, choice, text }) {
    const q = db.prepare('SELECT * FROM asks WHERE id = ?').get(Number(askId));
    if (!q) throw new Error(`No question ${askId}`);
    if (q.answered_at) return { already: q.answer };
    const value = text ?? JSON.parse(q.choices)[Number(choice)];
    if (value == null) throw new Error('No such choice');
    db.prepare('UPDATE asks SET answer = ?, answered_at = ? WHERE id = ?').run(String(value), now(), q.id);
    const a = agentRow(q.agent);
    if (a.state === 'blocked') update(a.id, { state: 'working' });
    mail.setStatus(db, a.id, `working: ${a.title}`.slice(0, STATUS_MAX));
    await sendMail('user', a.id, `Answer to "${q.question.slice(0, 120)}": ${value}`.slice(0, MAIL_MAX));
    return { answered: value };
  }

  /** Free-text reply from you: answers the agent's open question if it has one. */
  async function reply({ agent, text }) {
    const a = mustAgent(agent);
    const open = db.prepare('SELECT id FROM asks WHERE agent = ? AND answered_at IS NULL ORDER BY id DESC LIMIT 1').get(a.id);
    if (open) return answer({ ask: open.id, text: bounded(text, 250, 'Reply') });
    return { sent: await sendMail('user', a.id, text) };
  }

  // ---------- tests ----------
  function requestTest({ agent, requester, sha, branch, selector = '', gpu = false, artifacts = [], timeout_s = 1800, purpose = 'agent', repo }) {
    if (gpu) throw new Error('GPU test jobs arrive in phase 3 (host GPU runner)');
    const a = agent ? agentRow(agent) : null;
    const round = a && purpose === 'agent' ? db.prepare("SELECT COUNT(*) n FROM tests WHERE agent = ? AND purpose = 'agent'").get(a.id).n + 1 : 1;
    const id = `t_${hex(4)}`;
    db.prepare(`INSERT INTO tests (id, agent, requester, repo, sha, branch, selector, gpu, artifacts, timeout_s, round, purpose, state, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, 'queued', ?)`).run(id, a?.id ?? null, requester, repo || a.repo, sha, branch || a?.branch || null, selector, JSON.stringify(artifacts), Number(timeout_s), round, purpose, now());
    if (a && round >= 4) {
      const q = `${a.id} is on test round ${round}. Keep iterating?`;
      update(a.id, { state: 'blocked' });
      mail.setStatus(db, a.id, `blocked: test round ${round}`);
      postAsk(a, q, ['Keep going', 'Stop and report what you have']);
    }
    bus.emit('tests');
    pump().catch(e => log(`test pump: ${e.message}`));
    return { id, round };
  }

  /** Runs queued (non-GPU) test jobs one at a time, each in a fresh container. External runners (GPU, phase 3) use test.claim. */
  let pumping = false;
  async function pump() {
    if (pumping || !host.runTestJob) return;
    pumping = true;
    try {
      for (;;) {
        const { job } = await claim({ wait: 0 });
        if (!job) break;
        let report;
        try {
          const env = job.url.startsWith('https://github.com/') ? await github.gitAuthEnv() : {};
          report = await host.runTestJob(job, { env });
        } catch (e) {
          report = { id: job.id, sha: job.sha, status: 'error', passed: 0, failed: 0, skipped: 0, failures: [], duration_s: 0, notes: e.message.slice(0, 300) };
        }
        await testReport({ id: job.id, report }).catch(e => log(`test report ${job.id}: ${e.message}`));
      }
    } finally { pumping = false; }
  }

  async function agentTestRequest(who, args) {
    const a = agentRow(who.agent);
    await commitFor(a, `wip: ${a.title}`);
    const head = await pushBranch(a);
    if (args.sha && !head.startsWith(args.sha)) throw new Error(`--sha ${args.sha} is not your HEAD (${head})`);
    return requestTest({ ...args, agent: a.id, requester: a.id, sha: head });
  }

  async function claim({ wait = 25 } = {}) {
    kvSet(db, 'runner_seen', Date.now());
    const grab = () => tx(db, () => {
      const t = db.prepare("SELECT * FROM tests WHERE state = 'queued' AND gpu = 0 ORDER BY created_at LIMIT 1").get();
      if (!t) return null;
      db.prepare("UPDATE tests SET state = 'running', claimed_at = ? WHERE id = ?").run(now(), t.id);
      return t;
    });
    let t = grab();
    if (!t && wait > 0) {
      await new Promise(r => { const timer = setTimeout(r, wait * 1000); bus.once('tests', () => { clearTimeout(timer); r(); }); });
      t = grab();
    }
    if (!t) return { job: null };
    const a = t.agent ? agentRow(t.agent) : null;
    return { job: { id: t.id, url: cloneUrl(a || { repo: t.repo }), sha: t.sha, selector: t.selector, timeout_s: t.timeout_s, artifacts: JSON.parse(t.artifacts) } };
  }

  async function testReport({ id, report }) {
    const t = db.prepare('SELECT * FROM tests WHERE id = ?').get(id);
    if (!t) throw new Error(`No test ${id}`);
    if (t.state === 'done') throw new Error(`Test ${id} already reported`);
    if (report.sha !== t.sha) throw new Error(`Report is for ${report.sha}, request was ${t.sha}: rejected`);
    if (!['pass', 'fail', 'error', 'timeout'].includes(report.status)) throw new Error('Bad status');
    report = { ...report, id, notes: report.notes?.slice(0, 300), failures: (report.failures || []).slice(0, 20).map(f => ({ ...f, message: String(f.message || '').slice(0, 300), excerpt: String(f.excerpt || '').split('\n').slice(0, 20).join('\n') })) };
    db.prepare("UPDATE tests SET state = 'done', report = ?, done_at = ? WHERE id = ?").run(JSON.stringify(report), now(), id);
    bus.emit(`test:${id}`);
    if (t.purpose === 'gate' && t.agent) await gateResult(agentRow(t.agent), t, report);
    return { ok: true };
  }

  async function gateResult(a, t, r) {
    if (a.sha !== t.sha) return; // superseded by a newer report
    const summary = `${r.status}: ${r.passed} passed, ${r.failed} failed${r.failures?.length ? ` — ${r.failures.slice(0, 2).map(f => f.test_id).join('; ')}` : ''}`;
    if (r.status !== 'pass') {
      update(a.id, { state: 'working' });
      emit(a.delegator, a.id, 'gate-failed', `${a.id} gate tests ${summary}`);
      await sendMail('hauptling', a.id, `Gate test job ${t.id} on ${t.sha.slice(0, 8)} ${summary}. \`hauptling test get ${t.id}\` for details. Fix, commit, then report again.`.slice(0, MAIL_MAX));
      return;
    }
    const slug = githubSlug(a.repo);
    if (a.gate === 'push') {
      try {
        await git(a, ['fetch', '--quiet', 'origin', a.base]);
        await git(a, ['rebase', '--quiet', `origin/${a.base}`]);
        await git(a, ['push', 'origin', `HEAD:refs/heads/${a.base}`]);
        await git(a, ['push', '--quiet', 'origin', '--delete', a.branch]).catch(() => {});
      } catch (e) {
        await git(a, ['rebase', '--abort']).catch(() => {});
        update(a.id, { state: 'working' });
        emit(a.delegator, a.id, 'gate-failed', `${a.id} tests passed but pushing to ${a.base} failed: ${e.message.slice(0, 200)}`);
        await sendMail('hauptling', a.id, `Tests passed, but your branch no longer applies on ${a.base}. Rebase onto origin/${a.base}, fix conflicts, commit, report again.`);
        return;
      }
      await cleanup(a, 'merged');
      emit(a.delegator, a.id, 'merged', `${a.id} pushed to ${a.base} (pushToMain)`);
      return;
    }
    if (slug) {
      await github.prMerge(slug, a.pr_number);
      emit(a.delegator, a.id, 'gate-passed', `${a.id} gate tests passed; PR ${a.pr_url} merged`);
      await poll();
    } else emit(a.delegator, a.id, 'gate-passed', `${a.id} tests passed; run \`hauptling merge ${a.id}\` to merge ${a.branch} into ${a.base}`);
  }

  function testGet({ id }) {
    const t = db.prepare('SELECT * FROM tests WHERE id = ?').get(id);
    if (!t) throw new Error(`No test ${id}`);
    return { ...t, artifacts: JSON.parse(t.artifacts), report: t.report ? JSON.parse(t.report) : null };
  }

  async function testWait({ id, timeout = 540 }) {
    const done = () => db.prepare('SELECT state FROM tests WHERE id = ?').get(id)?.state === 'done';
    if (!db.prepare('SELECT 1 FROM tests WHERE id = ?').get(id)) throw new Error(`No test ${id}`);
    if (!done()) await new Promise(r => { const timer = setTimeout(r, timeout * 1000); bus.once(`test:${id}`, () => { clearTimeout(timer); r(); }); });
    return done() ? testGet({ id }) : { id, state: 'pending', note: 'Still running; wait again.' };
  }

  // ---------- delegator ----------
  async function wait({ delegator, timeout = 540 }) {
    const d = delegatorId(delegator);
    const take = () => tx(db, () => {
      const rows = db.prepare('SELECT * FROM events WHERE delegator = ? AND consumed_at IS NULL ORDER BY id LIMIT 20').all(d);
      for (const r of rows) db.prepare('UPDATE events SET consumed_at = ? WHERE id = ?').run(now(), r.id);
      return rows;
    });
    let rows = take();
    if (!rows.length) {
      await new Promise(r => { const timer = setTimeout(r, timeout * 1000); bus.once(`ev:${d}`, () => { clearTimeout(timer); r(); }); });
      rows = take();
    }
    return { events: rows.map(r => ({ kind: r.kind, agent: r.agent, text: r.text, at: r.at })) };
  }

  function agents({ delegator, all = false }) {
    const rows = delegator || !all
      ? db.prepare(`SELECT * FROM agents WHERE delegator = ? ${all ? '' : `AND state NOT IN (${ENDED.map(x => `'${x}'`).join(',')})`} ORDER BY created_at`).all(delegatorId(delegator))
      : db.prepare('SELECT * FROM agents ORDER BY created_at').all();
    return rows.map(({ token: _t, brief: _b, ...r }) => ({ ...r, status: db.prepare('SELECT text FROM status WHERE identity = ?').get(r.id)?.text || null }));
  }

  async function kill({ agent }) {
    const a = mustAgent(agent);
    await cleanup(a, 'killed');
    const waiting = db.prepare("SELECT id FROM agents WHERE depends_on = ? AND state = 'waiting'").get(a.id);
    emit(a.delegator, a.id, 'killed', `${a.id} killed${waiting ? `; ${waiting.id} still waits for spec tests (kill it too, or spawn a new test writer)` : ''}`);
    return { killed: a.id };
  }

  /** Local-only repos: merge the agent's branch into base in the host checkout. */
  async function merge({ agent }, hostGit) {
    const a = mustAgent(agent);
    if (githubSlug(a.repo)) throw new Error('GitHub repos merge through their PR');
    const t = db.prepare("SELECT report FROM tests WHERE agent = ? AND purpose = 'gate' AND sha = ? AND state = 'done'").get(a.id, a.sha);
    if (!t || JSON.parse(t.report).status !== 'pass') throw new Error('No passing gate test job for the reported sha');
    const current = await hostGit(a.repo, ['rev-parse', '--abbrev-ref', 'HEAD']);
    if (current === a.base) {
      if (await hostGit(a.repo, ['status', '--porcelain', '--untracked-files=no'])) throw new Error(`${a.base} is checked out with uncommitted changes in ${a.repo}`);
      await hostGit(a.repo, ['merge', '--no-ff', '-m', `Merge ${a.branch}: ${a.title}`, a.branch]);
    } else await hostGit(a.repo, ['fetch', '.', `${a.branch}:${a.base}`]);
    await cleanup(a, 'merged');
    emit(a.delegator, a.id, 'merged', `${a.id} merged into ${a.base}`);
    return { merged: a.id };
  }

  /**
   * Every minute: a worker whose TUI exited is marked `exited`; one with no hook activity for
   * `stallMinutes` while not idle is probably stuck on its vendor's own permission prompt, so you
   * are notified once (attach to answer it).
   */
  const PROMPT = /(Run this command\?|Allow this|Do you want to|Requesting permission|\(y\/n\)|Approve|Press enter to continue)/i;
  async function watch(at = Date.now()) {
    for (const a of db.prepare("SELECT a.*, i.seen_at FROM agents a JOIN identities i ON i.identity = a.id WHERE a.state IN ('working','blocked') AND a.slot IS NOT NULL").all()) {
      try {
        if (!(await host.tmuxAlive(a.slot, a.id))) {
          const tail = (await host.tmuxCapture?.(a.slot, a.id, 8).catch(() => '') || '').trim().split('\n').slice(-3).join(' | ');
          update(a.id, { state: 'exited', idle: 0 });
          mail.setStatus(db, a.id, `exited: ${a.title}`.slice(0, STATUS_MAX));
          emit(a.delegator, a.id, 'exited', `${a.id} TUI exited${tail ? `: ${tail}` : ''}. \`hauptling attach ${a.id}\` to look, \`hauptling kill ${a.id}\` to free its slot.`);
          await startQueued(a.delegator);
          continue;
        }
        if (a.state === 'working' && a.idle) {
          // Ended its turn without `hauptling report` (e.g. asked a question in plain text).
          if (at - Date.parse(a.seen_at) < idleMinutes * 60e3) continue;
          if (kvGet(db, `stall:${a.id}`) === a.seen_at) continue; // already notified this idle period
          kvSet(db, `stall:${a.id}`, a.seen_at);
          const screen = await host.tmuxCapture?.(a.slot, a.id, 25).catch(() => '') || '';
          const tail = screen.split('\n').map(l => l.trim()).filter(Boolean).slice(-3).join(' | ');
          update(a.id, { state: 'blocked' });
          mail.setStatus(db, a.id, 'blocked: idle without report');
          notify({ title: `${a.id} is idle without reporting`, body: `${tail ? `${tail}\n` : ''}Run: hauptling attach ${a.id}`, choices: [], links: null });
          log(`idle ${a.id}`);
          continue;
        }
        if (a.state !== 'working' || a.idle || at - Date.parse(a.seen_at) < stallMinutes * 60e3) continue;
        if (kvGet(db, `stall:${a.id}`) === a.seen_at) continue; // already reported this stall
        kvSet(db, `stall:${a.id}`, a.seen_at);
        const screen = await host.tmuxCapture?.(a.slot, a.id, 25).catch(() => '') || '';
        const prompt = PROMPT.test(screen);
        const why = prompt ? `waiting on a ${a.vendor} permission prompt` : `no activity for ${stallMinutes} min`;
        update(a.id, { state: 'blocked' });
        mail.setStatus(db, a.id, `blocked: ${why}`.slice(0, STATUS_MAX));
        notify({ title: `${a.id} may be stuck`, body: `${why}. Run: hauptling attach ${a.id}`, choices: [], links: null });
        log(`stall ${a.id}: ${why}`);
      } catch (e) { log(`watch ${a.id}: ${e.message}`); }
    }
  }

  /** Every minute: PR state for done agents (merged → free the slot; CI failure → wake the worker). */
  async function poll() {
    await watch();
    for (const a of db.prepare("SELECT * FROM agents WHERE state IN ('done','working') AND pr_number IS NOT NULL").all()) {
      try {
        const slug = githubSlug(a.repo);
        const pr = await github.prView(slug, a.pr_number);
        if (pr.state === 'MERGED') { await cleanup(a, 'merged'); emit(a.delegator, a.id, 'merged', `${a.id} merged: ${a.pr_url}`); continue; }
        if (pr.state === 'CLOSED') { await cleanup(a, 'closed'); emit(a.delegator, a.id, 'closed', `${a.id} PR closed without merge`); continue; }
        const failed = (pr.statusCheckRollup || []).filter(c => ['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED'].includes(c.conclusion || c.state));
        if (failed.length && a.ci_note !== pr.headRefOid) {
          update(a.id, { ci_note: pr.headRefOid, state: 'working' });
          await sendMail('hauptling', a.id, `CI failed on ${pr.headRefOid.slice(0, 8)}: ${failed.map(c => c.name || c.context).join(', ')}. Reproduce it in your clone, fix, commit, then report again.`.slice(0, MAIL_MAX));
        }
      } catch (e) { log(`poll ${a.id}: ${e.message}`); }
    }
  }

  // ---------- delegator lifecycle ----------
  function delegatorStart({ cli, repo, max = 3 }) {
    const id = `d_${hex(3)}`;
    db.prepare('INSERT INTO delegators (id, cli, repo, max_agents, created_at) VALUES (?, ?, ?, ?, ?)').run(id, cli || null, repo || null, Number(max), now());
    return { id };
  }

  function handoff({ delegator, text }) {
    const d = delegatorId(delegator);
    db.prepare('UPDATE delegators SET handoff = ?, handoff_at = ? WHERE id = ?').run(bounded(text, 8000, 'Handoff'), now(), d);
    return { delegator: d };
  }

  function resume({ delegator, cli }) {
    const d = delegatorId(delegator);
    if (cli) db.prepare('UPDATE delegators SET cli = ? WHERE id = ?').run(cli, d);
    const row = db.prepare('SELECT * FROM delegators WHERE id = ?').get(d);
    const pending = db.prepare('SELECT COUNT(*) n FROM events WHERE delegator = ? AND consumed_at IS NULL').get(d).n;
    return { delegator: row, agents: agents({ delegator: d }), pendingEvents: pending };
  }

  /** The answer page's view of a question, if the nonce matches. */
  function askForPage(id, nonce) {
    const q = db.prepare('SELECT * FROM asks WHERE id = ?').get(Number(id));
    if (!q || !q.nonce || q.nonce !== nonce) return null;
    return { id: q.id, agent: q.agent, question: q.question, choices: JSON.parse(q.choices), answer: q.answer };
  }

  const handlers = {
    whoami: (a, who) => who,
    hook: (a, who) => hook(who, a),
    report: (a, who) => report(who, a),
    ask: (a, who) => ask(who, a),
    answer, reply, spawn, wait, agents, kill, merge: (a) => merge(a, (repo, args) => host.hostGit(repo, args)), poll,
    'agent.get': ({ agent }) => { const { token: _t, ...r } = mustAgent(agent); return r; },
    'attach': ({ agent }) => { const a = mustAgent(agent); return { argv: host.attachArgv(a.slot, a.id) }; },
    'delegator.start': delegatorStart, 'delegator.list': () => db.prepare('SELECT * FROM delegators ORDER BY created_at DESC').all(),
    handoff, resume,
    'mail.send': ({ from, to, text }, who) => sendMail(who.role === 'agent' ? who.agent : from, to, text),
    'mail.check': ({ identity }, who) => mail.take(db, who.role === 'agent' ? who.agent : identity),
    'mail.status': ({ identity, text }, who) => mail.setStatus(db, who.role === 'agent' ? who.agent : identity, text),
    'mail.peers': ({ all }) => mail.peers(db, all),
    'mail.prune': ({ hours = 12, force = false }) => mail.prune(db, Number(hours), Date.now(), force),
    'test.request': (a, who) => (who.role === 'agent' ? agentTestRequest(who, a) : requestTest({ requester: 'user', ...a })),
    'test.wait': testWait, 'test.get': testGet,
    'test.claim': claim, 'test.report': testReport, 'test.heartbeat': () => kvSet(db, 'runner_seen', Date.now()),
    'slots.get': () => slots(),
    'slots.set': ({ slots: s }) => { kvSet(db, 'slots', JSON.stringify(s)); return s; },
  };

  async function call(name, args = {}, who = { role: 'admin' }) {
    const fn = handlers[name];
    if (!fn) throw new Error(`Unknown call ${name}`);
    if (who.role === 'agent' && !AGENT_CALLS.has(name)) throw new Error(`${name} is not allowed for workers`);
    if (who.role === 'runner' && !RUNNER_CALLS.has(name)) throw new Error(`${name} is not allowed for the test runner`);
    return fn(args, who);
  }

  /** Token → caller. */
  function authenticate(tok, adminToken) {
    if (tok && tok === adminToken) return { role: 'admin' };
    if (tok && tok === runnerToken) return { role: 'runner' };
    const a = tok && db.prepare('SELECT id, state FROM agents WHERE token = ?').get(tok);
    if (a && !ENDED.includes(a.state)) return { role: 'agent', agent: a.id };
    return null;
  }

  return { call, authenticate, poll, watch, startQueued, bus, askForPage, answer, pump };
}
