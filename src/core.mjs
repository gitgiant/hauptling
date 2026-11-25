import { EventEmitter } from 'node:events';
import { kvDel, kvGet, kvSet, tx } from './db.mjs';
import * as mail from './mail.mjs';
import * as codegraph from './codegraph.mjs';
import { findModel, launchArgv, loadModels, nextVendor, pick } from './models.mjs';
import { canInject } from './vendors.mjs';
import { normalizeUsage, scrub, statusText } from './usage.mjs';
import { dashToken } from './dashboard.mjs';
import { MAIL_MAX, STATUS_MAX, bounded, githubSlug, hex, isFamily, now, sanitizeModel, token, wslPath } from './util.mjs';
import * as keyStore from './keys.mjs';

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
/** Paths added to every clone's .git/info/exclude: Hauptling's own files and caches tools write into the clone. */
export const CLONE_EXCLUDES = ['.hauptling/', '.pnpm-store/'];
const AGENT_CALLS = new Set(['hook', 'report', 'ask', 'mail.send', 'mail.check', 'mail.status', 'mail.peers', 'test.request', 'test.wait', 'test.get', 'whoami', 'usage.report']);
const RUNNER_CALLS = new Set(['test.claim', 'test.report', 'test.heartbeat']);

export function createCore({ db, host, github, notify = () => false, models = loadModels, keys = keyStore, workerUrl, publicUrl = workerUrl, runnerToken, log = () => {}, stallMinutes = Number(process.env.HAUPTLING_STALL_MINUTES || 10), idleMinutes = Number(process.env.HAUPTLING_IDLE_MINUTES || 15) }) {
  const bus = new EventEmitter();
  bus.setMaxListeners(0);
  const agentRow = (id) => db.prepare('SELECT * FROM agents WHERE id = ?').get(id);
  const { getKey, getBudget, periodStart, periodEnd, STOP_AT } = keys;
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
    // No id: only unambiguous with one active delegator (several sessions may run at once; PRD "Several delegators").
    const act = db.prepare('SELECT id, repo FROM delegators WHERE active = 1 ORDER BY created_at').all();
    if (!act.length) throw new Error('No active delegator; run `hauptling delegator start` (the /delegator skill does this)');
    if (act.length > 1) throw new Error(`Several delegators are active: ${act.map(d => `${d.id} (${d.repo || 'no repo'})`).join(', ')}. Pass --delegator ID; end finished ones with \`hauptling delegator end --delegator ID\`.`);
    return act[0].id;
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
- When finished: run \`hauptling report "<what you did, ≤300 chars>"\` as a command on its own (not chained with git or anything else); it commits and pushes for you.${a.codegraph ? `
- This clone has a CodeGraph index: find code with the codegraph_explore and codegraph_node tools (in a shell: \`codegraph explore "<what you look for>"\`, \`codegraph node <symbol or file>\`) before grep or reading whole files, and tell any subagent you start to use them too.` : ''}`;
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
- Write and fix your own tests. Run them with your usual commands; \`hauptling test request --selector "<tests>"\` then \`hauptling test wait <id>\` runs them on a clean checkout of your HEAD. GPU tests: add \`--gpu\` (runs the repo's hauptling.json "gpu" command on the shared GPU, one job at a time; it may queue for a while). You have no GPU yourself.${a.start_from ? `
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
    if (!vendor) {
      // Round robin, skipping vendors whose every slot is at 100% of a usage window (if all are, the spawn waits in the queue).
      const tried = [];
      for (let i = 0; i < 3 && !vendor; i++) { const v = nextVendor(db, cfg); tried.push(v); if (startable(v)) vendor = v; }
      vendor ||= tried[0];
    }
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
    return { id, vendor, model: entry.id, state: state(id), billing: agentRow(id).billing, ...(tw ? { testWriter: { id: tw.id, vendor: tw.vendor, model: tw.model, state: state(tw.id) } } : {}) };
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
        const free = slots().filter(s => !used.has(s));
        // First queued agent that can start: on the API key, or on a plan that isn't at 100% (else it waits for the reset).
        const a = free.length ? db.prepare("SELECT * FROM agents WHERE delegator = ? AND state = 'queued' ORDER BY created_at").all(d).find(q => startable(q.vendor)) : null;
        const slot = free[0];
        if (!slot || !a) return null;
        const dir = `${host.workRoot}/${a.id}`;
        const billing = billingFor(a.vendor);
        db.prepare("UPDATE agents SET state = 'spawning', slot = ?, dir = ?, billing = ?, updated_at = ? WHERE id = ?").run(slot, dir, billing, now(), a.id);
        return { ...a, slot, dir, billing, state: 'spawning' };
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

  // ---------- usage (phase 4b) ----------
  const live = (at) => !at || Date.parse(at) > Date.now();
  /**
   * The vendor's account is at 100% of some window (until it resets). One account per vendor, signed
   * in on every slot (or one API key): a reading from any slot speaks for all of them.
   */
  function exhausted(vendor) {
    return db.prepare('SELECT used_pct, resets_at FROM slot_usage WHERE vendor = ? AND used_pct >= 100').all(vendor).some(r => live(r.resets_at));
  }

  /** API spend of this vendor in the budget's current period (the reported cost of its `api` agents). */
  function apiSpend(vendor, b = getBudget(vendor)) {
    const since = periodStart(b?.resets_on || 1);
    const rows = db.prepare("SELECT usage FROM agents WHERE vendor = ? AND billing = 'api' AND usage IS NOT NULL AND created_at >= ?").all(vendor, since);
    return Math.round(rows.reduce((s, r) => s + (JSON.parse(r.usage).cost_usd || 0), 0) * 100) / 100;
  }
  /** { usd, resets_on, spent, stop_at, from, until } for a vendor with a budgeted key, else null. */
  function budgetState(vendor) {
    const b = getKey(vendor) && getBudget(vendor);
    if (!b) return null;
    return { ...b, spent: apiSpend(vendor, b), stop_at: Math.round(b.usd * STOP_AT * 100) / 100, from: periodStart(b.resets_on), until: periodEnd(b.resets_on) };
  }
  /** 'api' or 'plan' for a worker starting now: a key without budget covers every spawn; with a budget, until STOP_AT of it is spent. */
  function billingFor(vendor) {
    if (!getKey(vendor)) return 'plan';
    const b = budgetState(vendor);
    return !b || b.spent < b.stop_at ? 'api' : 'plan';
  }
  const startable = (vendor) => billingFor(vendor) === 'api' || !exhausted(vendor);
  function priceOf(a) { try { return findModel(models(), a.vendor, a.model); } catch { return null; } }

  /** Stores an agent's usage and its slot's limit windows; warns once per window at 90%. */
  function recordUsage(a, u) {
    update(a.id, { usage: JSON.stringify({ ...u, at: now() }) });
    if (a.billing === 'api') budgetWarn(a);
    if (!a.slot) return u;
    for (const l of u.limits) {
      db.prepare(`INSERT INTO slot_usage (slot, vendor, window, used_pct, resets_at, at) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT (slot, vendor, window) DO UPDATE SET used_pct = excluded.used_pct, resets_at = excluded.resets_at, at = excluded.at`).run(a.slot, a.vendor, l.window, l.used_pct, l.resets_at, now());
      if (l.used_pct < 90) continue;
      const key = `usage:warn:${a.vendor}:${l.window}:${l.resets_at || 'unknown'}`; // once per account window, whichever slot reports it
      if (kvGet(db, key)) continue;
      kvSet(db, key, now());
      const when = l.resets_at ? `resets ${new Date(l.resets_at).toLocaleString()}` : 'reset time unknown';
      const full = l.used_pct >= 100;
      const text = `${a.vendor} ${l.window} window at ${Math.round(l.used_pct)}% (${when})${full ? `; new ${a.vendor} spawns wait until then` : ''}`;
      emit(a.delegator, a.id, 'usage-high', text);
      notify({ title: `${a.vendor} usage ${Math.round(l.used_pct)}%`, body: text, choices: [], links: null, dashboard: `${publicUrl}/#usage` });
      log(`usage-high ${text}`);
    }
    return u;
  }

  /** Once per budget period, when API spend reaches STOP_AT: new spawns of that vendor go to the plan. */
  function budgetWarn(a) {
    const b = budgetState(a.vendor);
    if (!b || b.spent < b.stop_at) return;
    const key = `budget:warn:${a.vendor}:${b.from}`;
    if (kvGet(db, key)) return;
    kvSet(db, key, now());
    const text = `${a.vendor} API spend $${b.spent.toFixed(2)} of $${b.usd} this period; new ${a.vendor} workers use your plan until ${new Date(b.until).toLocaleDateString()} (running API workers finish on the API)`;
    emit(a.delegator, a.id, 'api-budget', text);
    notify({ title: `${a.vendor} API budget ${Math.round((b.spent / b.usd) * 100)}%`, body: text, choices: [], links: null, dashboard: `${publicUrl}/#usage` });
    log(`api-budget ${text}`);
  }

  /** `hauptling usage <vendor>` from a worker's status line: raw vendor JSON → stored; returns the text to show. */
  function usageReport(who, { vendor, payload }) {
    if (who.role !== 'agent') throw new Error('usage.report comes from a worker\'s status line');
    const a = agentRow(who.agent);
    if (vendor !== a.vendor) throw new Error(`usage for ${vendor} from a ${a.vendor} worker`);
    return { text: statusText(recordUsage(a, normalizeUsage(vendor, scrub(payload), priceOf(a)))) };
  }

  /** Codex has no status line hook: read its session log in the slot (throttled; poll and the dashboard call this). */
  let codexAt = 0;
  async function refreshUsage({ force = false } = {}) {
    if (!host.codexUsage || (!force && Date.now() - codexAt < 10e3)) return;
    codexAt = Date.now();
    for (const a of db.prepare("SELECT * FROM agents WHERE vendor = 'codex' AND slot IS NOT NULL AND state IN ('working','blocked','done')").all()) {
      try {
        const p = await host.codexUsage(a.slot, a.created_at);
        if (p) recordUsage(a, normalizeUsage('codex', p, priceOf(a)));
      } catch (e) { log(`codex usage ${a.id}: ${e.message} (format changed? usage shows unknown)`); }
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
    const repoCfg = await repoConfig(a);
    const cg = codegraph.enabled(repoCfg);
    let repoMcp = {};
    if (Array.isArray(repoCfg.mcp) && repoCfg.mcp.length) {
      try { repoMcp = JSON.parse((await host.run(a.slot, ['cat', `${a.dir}/.mcp.json`])).stdout); } catch { /* none: every name is missing */ }
    }
    const { config: mcp, missing } = codegraph.mcpConfig({ codegraph: cg, repoCfg, repoMcp });
    if (missing.length) emit(a.delegator, a.id, 'mcp-missing', `hauptling.json "mcp" names servers not in .mcp.json: ${missing.join(', ')}`);
    const withBase = { ...a, base, codegraph: cg };
    // Kept out of git (and so out of commitFor's `add -A`): the brief, and pnpm's store, which pnpm puts in /work
    // because the clone is a different mount from the worker's home.
    await host.run(a.slot, ['sh', '-c', `mkdir -p "$(dirname "$0")" && cat > "$0" && printf '%s\\n' ${CLONE_EXCLUDES.join(' ')} >> "$1/.git/info/exclude"`, briefPath, a.dir], { input: briefText(withBase) });
    const prompt = 'Read your brief at .hauptling/brief.md and carry it out.';
    await host.startWorker({ slot: a.slot, id: a.id, dir: a.dir, vendor: a.vendor, apiKey: a.billing === 'api', argv: launchArgv(cfg, a.vendor, entry, prompt),
      mcp, codegraphCache: cg ? codegraph.cacheDir(a.repo) : null,
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
    notify({ title: `${a.id} asks`, body: question, choices, links: { page, choice: (i) => `${page}&choice=${i}` }, dashboard: `${publicUrl}/` });
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
    const a = agent ? agentRow(agent) : null;
    const round = a && purpose === 'agent' ? db.prepare("SELECT COUNT(*) n FROM tests WHERE agent = ? AND purpose = 'agent'").get(a.id).n + 1 : 1;
    if (a && purpose === 'gate') supersedeGates(a.id, sha);
    const id = `t_${hex(4)}`;
    db.prepare(`INSERT INTO tests (id, agent, requester, repo, sha, branch, selector, gpu, artifacts, timeout_s, round, purpose, state, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?)`).run(id, a?.id ?? null, requester, repo || a.repo, sha, branch || a?.branch || null, selector, gpu ? 1 : 0, JSON.stringify(artifacts), Number(timeout_s), round, purpose, now());
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

  /** A newer report supersedes the agent's gate jobs for other shas: queued ones are cancelled, a running one is killed. Cancelled gates never reach gateResult. */
  function supersedeGates(agentId, sha) {
    const old = db.prepare("SELECT id, state FROM tests WHERE agent = ? AND purpose = 'gate' AND state IN ('queued', 'running') AND sha != ?").all(agentId, sha);
    for (const { id, state } of old) {
      const report = JSON.stringify({ id, status: 'cancelled', passed: 0, failed: 0, skipped: 0, failures: [], notes: 'superseded by a newer report' });
      db.prepare("UPDATE tests SET state = 'done', report = ?, done_at = ? WHERE id = ?").run(report, now(), id);
      kvDel(db, `gpu:need:${id}`);
      kvDel(db, `gpu:wait:${id}`);
      bus.emit(`test:${id}`);
      if (state === 'running') Promise.resolve(host.killTestJob?.(id)).catch(e => log(`kill test ${id}: ${e.message}`));
    }
  }

  const errorReport = (job, notes) => ({ id: job.id, sha: job.sha, status: 'error', passed: 0, failed: 0, skipped: 0, failures: [], duration_s: 0, notes: String(notes).slice(0, 300) });

  /**
   * Two queues, one job each at a time, each job in a fresh container: CPU jobs and GPU jobs
   * (`--gpus all`). External runners use test.claim (CPU queue only).
   */
  const pumping = { cpu: false, gpu: false };
  async function pump() { await Promise.all([pumpQueue(false), pumpQueue(true)]); }
  async function pumpQueue(gpu) {
    const q = gpu ? 'gpu' : 'cpu';
    if (pumping[q] || !host.runTestJob) return;
    pumping[q] = true;
    try {
      for (;;) {
        if (gpu && !(await gpuReady())) break;
        const { job } = await claim({ wait: 0, gpu });
        if (!job) break;
        let report;
        try {
          const env = job.url.startsWith('https://github.com/') ? await github.gitAuthEnv() : {};
          report = await host.runTestJob(job, { env });
        } catch (e) { report = errorReport(job, e.message); }
        const row = db.prepare('SELECT state, claimed_at FROM tests WHERE id = ?').get(job.id);
        if (row.state !== 'running' || row.claimed_at !== job.claimed_at) continue; // killed by `gpu pause --now` and requeued
        await testReport({ id: job.id, report }).catch(e => log(`test report ${job.id}: ${e.message}`));
      }
    } finally { pumping[q] = false; }
  }

  // ---------- GPU queue ----------
  const gpuCfg = () => ({ memMB: 6144, waitMinutes: 30, ...host.gpuConfig?.() });
  const nextGpuJob = () => db.prepare("SELECT * FROM tests WHERE state = 'queued' AND gpu = 1 ORDER BY created_at LIMIT 1").get();

  /**
   * May the next GPU job start? Not while paused. Otherwise it needs enough free VRAM (your desktop
   * shares the GPU): short → wait (rechecked each minute by poll); waiting past `waitMinutes` →
   * `error: GPU busy`. Waiting doesn't count toward the job's timeout_s (that starts in the container).
   */
  async function gpuReady(at = Date.now()) {
    if (kvGet(db, 'gpu:paused')) return false;
    for (;;) {
      const t = nextGpuJob();
      if (!t) return true;
      const need = Number(kvGet(db, `gpu:need:${t.id}`) || gpuCfg().memMB);
      const free = await host.gpuFreeMB?.().catch(() => null);
      if (free == null || free >= need) { kvDel(db, `gpu:wait:${t.id}`); return true; }
      const since = Number(kvGet(db, `gpu:wait:${t.id}`) || 0);
      if (!since) { kvSet(db, `gpu:wait:${t.id}`, at); log(`gpu busy: ${free} MiB free, ${t.id} needs ${need}`); return false; }
      if (at - since < gpuCfg().waitMinutes * 60e3) return false;
      kvDel(db, `gpu:wait:${t.id}`);
      db.prepare("UPDATE tests SET state = 'running', claimed_at = ? WHERE id = ?").run(now(), t.id);
      await testReport({ id: t.id, report: errorReport(t, `GPU busy: ${free} MiB free, needs ${need} MiB, waited ${gpuCfg().waitMinutes} min`) }).catch(e => log(`test report ${t.id}: ${e.message}`));
    }
  }

  /** `gpu pause [--now]`: hold the GPU queue. --now kills the running job and requeues it (same row: no extra round). */
  async function gpuPause({ now: hard = false } = {}) {
    kvSet(db, 'gpu:paused', 1);
    const running = db.prepare("SELECT id FROM tests WHERE state = 'running' AND gpu = 1").all();
    if (!hard) return { paused: true, running: running.map(r => r.id) };
    for (const { id } of running) {
      db.prepare("UPDATE tests SET state = 'queued', claimed_at = NULL WHERE id = ?").run(id);
      await host.killTestJob?.(id).catch(e => log(`kill test ${id}: ${e.message}`));
    }
    return { paused: true, requeued: running.map(r => r.id) };
  }
  function gpuResume() { kvDel(db, 'gpu:paused'); pump().catch(e => log(`test pump: ${e.message}`)); return { paused: false }; }
  async function gpuStatus() {
    const c = gpuCfg();
    const running = db.prepare("SELECT id, agent, purpose, claimed_at, timeout_s FROM tests WHERE state = 'running' AND gpu = 1").all();
    const queued = db.prepare("SELECT id, agent, purpose, created_at FROM tests WHERE state = 'queued' AND gpu = 1 ORDER BY created_at").all()
      .map(t => ({ ...t, waiting_since: kvGet(db, `gpu:wait:${t.id}`) ? new Date(Number(kvGet(db, `gpu:wait:${t.id}`))).toISOString() : null }));
    return { available: Boolean(await host.gpuAvailable?.()), paused: Boolean(kvGet(db, 'gpu:paused')), freeMB: await host.gpuFreeMB?.().catch(() => null) ?? null, needMB: c.memMB, running, queued };
  }

  /** Checks a GPU request before it is queued: a GPU on this host and a "gpu" command in hauptling.json. */
  async function checkGpu(cfg) {
    if (!(await host.gpuAvailable?.())) throw new Error('no GPU on this host (GPU tests disabled; see `hauptling doctor`)');
    if (cfg && !Array.isArray(cfg.gpu)) throw new Error('--gpu needs a "gpu": [argv] command in hauptling.json (same {selector} and {junit} placeholders as "test")');
  }
  function gpuRequest(args, cfg) {
    const r = requestTest({ ...args, gpu: true });
    if (cfg?.gpuMemMB) kvSet(db, `gpu:need:${r.id}`, Number(cfg.gpuMemMB));
    return r;
  }

  /** Broker start: test containers from before the restart are gone; their jobs rerun from scratch, first in line. */
  async function recover() {
    await host.removeTestContainers?.().catch(e => log(`remove test containers: ${e.message}`));
    const r = db.prepare("UPDATE tests SET state = 'queued', claimed_at = NULL WHERE state = 'running'").run();
    if (r.changes) log(`requeued ${r.changes} test job(s) after restart`);
    return { requeued: r.changes };
  }

  async function agentTestRequest(who, args) {
    const a = agentRow(who.agent);
    const cfg = args.gpu ? await repoConfig(a) : null;
    if (args.gpu) await checkGpu(cfg);
    await commitFor(a, `wip: ${a.title}`);
    const head = await pushBranch(a);
    if (args.sha && !head.startsWith(args.sha)) throw new Error(`--sha ${args.sha} is not your HEAD (${head})`);
    const req = { ...args, agent: a.id, requester: a.id, sha: head };
    return args.gpu ? gpuRequest(req, cfg) : requestTest(req);
  }

  async function claim({ wait = 25, gpu = false } = {}) {
    if (!gpu) kvSet(db, 'runner_seen', Date.now());
    const grab = () => tx(db, () => {
      const t = db.prepare("SELECT * FROM tests WHERE state = 'queued' AND gpu = ? ORDER BY created_at LIMIT 1").get(gpu ? 1 : 0);
      if (!t) return null;
      t.claimed_at = now();
      db.prepare("UPDATE tests SET state = 'running', claimed_at = ? WHERE id = ?").run(t.claimed_at, t.id);
      return t;
    });
    let t = grab();
    if (!t && wait > 0) {
      await new Promise(r => { const timer = setTimeout(r, wait * 1000); bus.once('tests', () => { clearTimeout(timer); r(); }); });
      t = grab();
    }
    if (!t) return { job: null };
    const a = t.agent ? agentRow(t.agent) : null;
    return { job: { id: t.id, url: cloneUrl(a || { repo: t.repo }), sha: t.sha, selector: t.selector, timeout_s: t.timeout_s, artifacts: JSON.parse(t.artifacts), gpu: Boolean(t.gpu), claimed_at: t.claimed_at } };
  }

  async function testReport({ id, report }) {
    const t = db.prepare('SELECT * FROM tests WHERE id = ?').get(id);
    if (!t) throw new Error(`No test ${id}`);
    if (t.state === 'done') throw new Error(`Test ${id} already reported`);
    if (report.sha !== t.sha) throw new Error(`Report is for ${report.sha}, request was ${t.sha}: rejected`);
    if (!['pass', 'fail', 'error', 'timeout'].includes(report.status)) throw new Error('Bad status');
    report = { ...report, id, notes: report.notes?.slice(0, 300), failures: (report.failures || []).slice(0, 20).map(f => ({ ...f, message: String(f.message || '').slice(0, 300), excerpt: String(f.excerpt || '').split('\n').slice(0, 20).join('\n') })) };
    db.prepare("UPDATE tests SET state = 'done', report = ?, done_at = ? WHERE id = ?").run(JSON.stringify(report), now(), id);
    kvDel(db, `gpu:need:${id}`);
    kvDel(db, `gpu:wait:${id}`);
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
    if (!t.gpu) {
      // Per-repo opt-in ("gateGpu": true): the GPU command must pass too before merging.
      const cfg = await repoConfig(a);
      if (cfg.gateGpu && Array.isArray(cfg.gpu) && await host.gpuAvailable?.()) {
        gpuRequest({ agent: a.id, requester: 'hauptling', sha: t.sha, purpose: 'gate' }, cfg);
        mail.setStatus(db, a.id, 'gate: waiting for GPU');
        emit(a.delegator, a.id, 'gate-cpu-passed', `${a.id} gate tests ${summary}; GPU gate queued`);
        return;
      }
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
          notify({ title: `${a.id} is idle without reporting`, body: `${tail ? `${tail}\n` : ''}Run: hauptling attach ${a.id}`, choices: [], links: null, dashboard: `${publicUrl}/` });
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
        notify({ title: `${a.id} may be stuck`, body: `${why}. Run: hauptling attach ${a.id}`, choices: [], links: null, dashboard: `${publicUrl}/` });
        log(`stall ${a.id}: ${why}`);
      } catch (e) { log(`watch ${a.id}: ${e.message}`); }
    }
  }

  /** Every minute: PR state for done agents (merged → free the slot; CI failure → wake the worker). */
  async function poll() {
    pump().catch(e => log(`test pump: ${e.message}`)); // also rechecks a GPU job held for VRAM
    await refreshUsage({ force: true }).catch(e => log(`usage: ${e.message}`));
    // A usage window may have reset: queued spawns that were waiting for it can start.
    for (const { id } of db.prepare("SELECT DISTINCT delegator id FROM agents WHERE state = 'queued'").all()) await startQueued(id).catch(e => log(`start ${id}: ${e.message}`));
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

  /** Marks a delegator ended, so commands without --delegator stop considering it. Refused while it has live agents. */
  function delegatorEnd({ delegator }) {
    const d = delegatorId(delegator);
    // Running or still to start; failed/exited ones need no delegator.
    const live = db.prepare(`SELECT id FROM agents WHERE delegator = ? AND state IN (${[...ACTIVE, 'queued', 'waiting'].map(x => `'${x}'`).join(',')})`).all(d).map(r => r.id);
    if (live.length) throw new Error(`${d} still has agents: ${live.join(', ')}. Wait for them, or \`hauptling kill\` them first.`);
    db.prepare('UPDATE delegators SET active = 0 WHERE id = ?').run(d);
    return { delegator: d };
  }

  function handoff({ delegator, text }) {
    const d = delegatorId(delegator);
    db.prepare('UPDATE delegators SET handoff = ?, handoff_at = ? WHERE id = ?').run(bounded(text, 8000, 'Handoff'), now(), d);
    return { delegator: d };
  }

  /** `repo`: names this session's repo may go by (path, owner/name); then only that repo's active delegator resumes. */
  function resume({ delegator, cli, repo }) {
    let d;
    if (!delegator && repo) {
      const names = [repo].flat().filter(Boolean);
      d = db.prepare(`SELECT id FROM delegators WHERE active = 1 AND repo IN (${names.map(() => '?').join(',')}) ORDER BY created_at DESC LIMIT 1`).get(...names)?.id;
      if (!d) return { delegator: null, repo: names[0] };
    } else d = delegatorId(delegator);
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
    'delegator.start': delegatorStart, 'delegator.end': delegatorEnd, 'delegator.list': () => db.prepare('SELECT * FROM delegators ORDER BY created_at DESC').all(),
    handoff, resume,
    'mail.send': ({ from, to, text }, who) => sendMail(who.role === 'agent' ? who.agent : from, to, text),
    'mail.check': ({ identity }, who) => mail.take(db, who.role === 'agent' ? who.agent : identity),
    'mail.status': ({ identity, text }, who) => mail.setStatus(db, who.role === 'agent' ? who.agent : identity, text),
    'mail.peers': ({ all }) => mail.peers(db, all),
    'mail.prune': ({ hours = 12, force = false }) => mail.prune(db, Number(hours), Date.now(), force),
    'test.request': async (a, who) => {
      if (who.role === 'agent') return agentTestRequest(who, a);
      if (!a.gpu) return requestTest({ requester: 'user', ...a });
      await checkGpu(null);
      return gpuRequest({ requester: 'user', ...a }, null);
    },
    'test.wait': testWait, 'test.get': testGet,
    'test.claim': claim, 'test.report': testReport, 'test.heartbeat': () => kvSet(db, 'runner_seen', Date.now()),
    'usage.report': (a, who) => usageReport(who, a),
    'dashboard.token': ({ rotate = false }) => ({ token: dashToken(db, { rotate }), url: publicUrl }),
    'gpu.pause': gpuPause, 'gpu.resume': gpuResume, 'gpu.status': gpuStatus,
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

  return { call, authenticate, poll, watch, startQueued, bus, askForPage, answer, pump, recover, gpuReady, refreshUsage, recordUsage, budgetState, billingFor };
}
