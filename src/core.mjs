import { EventEmitter } from 'node:events';
import { kvDel, kvGet, kvSet, tx } from './db.mjs';
import * as mail from './mail.mjs';
import * as codegraph from './codegraph.mjs';
import { checkTier, effortFor, findModel, launchArgv, loadModels, nextVendor, pick, preferOf, setPrefer } from './models.mjs';
import { canInject } from './vendors.mjs';
import { readFileSync } from 'node:fs';
import { normalizeUsage, scrub, spendLine, statusText, windowSnapshot, accumulate, outOfCredit, reportedCost } from './usage.mjs';
import { dashToken } from './dashboard.mjs';
import { checkKeys } from './terminal.mjs';
import { MAIL_MAX, STATUS_MAX, bounded, githubSlug, hex, isFamily, now, sanitizeModel, token, wslPath } from './util.mjs';
import * as keyStore from './keys.mjs';

/*
 * Broker logic. Everything that touches the outside world is injected, so tests can fake it:
 *   host   – where workers run (src/platform/linux.mjs)
 *   github – host gh wrapper (src/github.mjs)
 *   notify – platform notification (choices + links to the broker's answer page)
 *   publicUrl – where your browser reaches the broker (answer links)
 *   hub    – satellites joined to this broker (src/hub.mjs); optional
 *   satellite – on a satellite broker, its link to the hub (src/satellite.mjs): events, agent and test state go up
 *               through its outbox, and the hub's commands come in through `command` (PRD "Part 2")
 * `call(name, args, who)` is the whole API; who = {role: admin|agent|runner|satellite, agent?, host?}.
 */

const PAUSABLE = ['working', 'blocked', 'done'];
const ACTIVE = ['spawning', 'restarting', 'paused', ...PAUSABLE];
const TEST_ELIGIBLE = "NOT EXISTS (SELECT 1 FROM agents a WHERE a.id = q.agent AND a.state IN ('paused','restarting'))";
const START_PROMPT = 'Read your brief at .hauptling/brief.md and carry it out.';
const RESTART_PREAMBLE = 'You were restarted; continue from the current state of the branch and working tree.';
const RESUME_PROMPT = 'Continue the task from the current state of the branch and working tree.';
const ENDED = ['merged', 'killed', 'closed', 'handed-off'];
/** Paths added to every clone's .git/info/exclude: Hauptling's own files and caches tools write into the clone. */
// node_modules/: prepare installs dependencies into the clone (vendors.mjs installDeps); a repo that doesn't ignore it must not get it committed.
export const CLONE_EXCLUDES = ['.hauptling/', '.pnpm-store/', 'node_modules/'];
const AGENT_CALLS = new Set(['hook', 'report', 'ask', 'mail.send', 'mail.check', 'mail.status', 'mail.peers', 'test.request', 'test.wait', 'test.get', 'whoami', 'usage.report']);
const RUNNER_CALLS = new Set(['test.claim', 'test.report', 'test.heartbeat']);
/** What a satellite key may call on /api: nothing. It reports through /hub/state and /hub/events (ordered, exactly once). */
const SATELLITE_CALLS = new Set();
/** Agent columns a satellite mirrors to the hub (`state` events), plus its status line. */
const MIRROR_FIELDS = ['state', 'slot', 'dir', 'idle', 'sha', 'report', 'pr_url', 'pr_number', 'gate', 'base', 'usage', 'billing', 'usage_start', 'paused_state', 'start_from', 'ci_note'];
/** Test job columns mirrored to the hub (`test` events). */
const TEST_FIELDS = ['id', 'agent', 'requester', 'repo', 'sha', 'branch', 'selector', 'gpu', 'artifacts', 'timeout_s', 'round', 'purpose', 'state', 'report', 'created_at', 'claimed_at', 'done_at', 'attempt', 'retry_note'];
/** What a satellite's spawn command carries of the hub's agent row. */
const SPAWN_FIELDS = ['id', 'delegator', 'vendor', 'model', 'repo', 'base', 'branch', 'brief', 'title', 'test_writer', 'role', 'depends_on', 'start_from', 'effort', 'gpu'];
const HOST_CMDS = { pause: 'pause', unpause: 'resume', restart: 'restart', kill: 'kill', merge: 'merge' };

const HANDOFF_PCT = 85;
const WORKER_RULES = readFileSync(new URL('../prompts/worker-rules.md', import.meta.url), 'utf8').trim();

export function createCore({ db, host, github, notify = () => false, models = loadModels, savePrefer = setPrefer, keys = keyStore, workerUrl, publicUrl = workerUrl, runnerToken, hub = null, satellite = null, remoteWaitMs = 30e3, log = () => {}, stallMinutes = Number(process.env.HAUPTLING_STALL_MINUTES || 10), idleMinutes = Number(process.env.HAUPTLING_IDLE_MINUTES || 15) }) {
  const changing = new Set();
  const merging = new Set();
  const bus = new EventEmitter();
  bus.setMaxListeners(0);
  const agentRow = (id) => db.prepare('SELECT * FROM agents WHERE id = ?').get(id);
  const { getKey, getBudget, periodStart, periodEnd, STOP_AT } = keys;
  const mustAgent = (id) => { const a = agentRow(id) || agentRow(mail.resolve(db, id)); if (!a) throw new Error(`No agent ${id}`); return a; };
  const update = (id, fields) => {
    const keys = Object.keys(fields);
    db.prepare(`UPDATE agents SET ${keys.map(k => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`).run(...keys.map(k => fields[k]), now(), id);
    synced(id);
  };
  const setStatus = (id, text) => { mail.setStatus(db, id, text); synced(id); };
  /** A notification about an agent; a satellite sends it to the hub, which shows it to you. */
  const toast = (agent, n) => {
    if (!satellite) return notify(n);
    satellite.queue(agent, 'notify', JSON.stringify({ title: n.title, body: n.body }));
    return true;
  };

  // ---------- satellite: mirror to the hub (PRD "Part 2") ----------
  const mirrored = new Map(); // agent or test id → last values sent
  /** On a satellite: sends the agent's changed columns and status line to the hub as one `state` event. */
  function synced(id) {
    if (!satellite) return;
    const a = agentRow(id);
    if (!a) return;
    const cur = Object.fromEntries(MIRROR_FIELDS.map(k => [k, a[k] ?? null]));
    cur.status = db.prepare('SELECT text FROM status WHERE identity = ?').get(id)?.text ?? null;
    const last = mirrored.get(id) || {};
    const diff = Object.fromEntries(Object.entries(cur).filter(([k, v]) => last[k] !== v));
    if (!Object.keys(diff).length) return;
    mirrored.set(id, cur);
    satellite.queue(id, 'state', JSON.stringify(diff));
  }
  /** On a satellite: sends a test job row (an agent's) to the hub when it changed. Big reports lose their excerpts. */
  function testSynced(id) {
    if (!satellite) return;
    const t = db.prepare('SELECT * FROM tests WHERE id = ?').get(id);
    if (!t?.agent) return;
    const row = Object.fromEntries(TEST_FIELDS.map(k => [k, t[k] ?? null]));
    let json = JSON.stringify(row);
    if (json.length > 60e3 && row.report) {
      const r = JSON.parse(row.report);
      json = JSON.stringify({ ...row, report: JSON.stringify({ ...r, failures: (r.failures || []).slice(0, 5).map(({ excerpt: _e, ...f }) => f) }) });
    }
    if (mirrored.get(`test:${id}`) === json) return;
    mirrored.set(`test:${id}`, json);
    satellite.queue(t.agent, 'test', json);
  }
  /** Every poll on a satellite, and at start: catches test rows changed by paths that don't call testSynced. */
  function syncTests() {
    if (!satellite) return;
    const since = new Date(Date.now() - 3600e3).toISOString();
    for (const { id } of db.prepare("SELECT id FROM tests WHERE agent IS NOT NULL AND (state != 'done' OR done_at > ?)").all(since)) testSynced(id);
  }
  const slots = () => JSON.parse(kvGet(db, 'slots') || '["hl-w1","hl-w2","hl-w3"]');

  function emit(delegator, agent, kind, text, at = now()) {
    if (satellite && agent) { // the hub's delegator waits for it
      satellite.queue(agent, kind, String(text).slice(0, 600), at);
      log(`event ${kind} ${agent} (to hub): ${text}`);
      return;
    }
    db.prepare('INSERT INTO events (delegator, agent, kind, text, at) VALUES (?, ?, ?, ?, ?)').run(delegator, agent, kind, String(text).slice(0, 600), at);
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
${WORKER_RULES}

---
Hauptling worker notes (you are ${a.id}, branch ${a.branch}, base ${a.base}):
- Work only in this clone. Do not push.
${common}`;
    }
    return `${WORKER_RULES}

---

${a.brief.trim()}

---
Hauptling worker notes (you are ${a.id}, branch ${a.branch}, base ${a.base}):
- Work only in this clone. Commit your work on ${a.branch} if you can; anything left uncommitted is committed for you by \`hauptling report\` and \`hauptling test request\`. Do not push (hauptling pushes for you).
- Write and fix your own tests. Run them with your usual commands; \`hauptling test request --selector "<tests>"\` then \`hauptling test wait <id>\` runs them on a clean checkout of your HEAD. GPU tests: add \`--gpu\` (runs the repo's hauptling.json "gpu" command on the shared GPU, one job at a time; it may queue for a while). You have no GPU yourself.${a.start_from ? `
- Spec tests from a test writer are already committed on your branch (files/suites named "spec"). Make them pass; do not weaken or delete them. If one contradicts the spec, \`hauptling ask\` the user.` : ''}
${common} Keep the session open afterwards: CI failures and review notes arrive as messages.`;
  }

  async function spawn({ delegator, vendor, model, mode = 'suggest', difficulty = 'normal', repo, base, brief, title, testWriter = false, allowTier = false, effort, host: pin, gpu = false }) {
    const d = delegatorId(delegator);
    const drow = db.prepare('SELECT * FROM delegators WHERE id = ?').get(d);
    repo ||= drow.repo;
    if (!repo) throw new Error('--repo is required (GitHub owner/name or URL, or a local path)');
    const wantHost = checkHost(pin, repo);
    checkHost(wantHost ?? drow.host, repo);
    const cfg = models();
    if (vendor && !isFamily(vendor)) throw new Error(`Vendor must be claude, codex or agy, got "${vendor}"`);
    if (!vendor) {
      // Round robin, skipping vendors whose every slot is at 100% of a usage window (if all are, the spawn waits in the queue).
      const tried = [];
      for (let i = 0; i < 3 && !vendor; i++) { const v = nextVendor(db, cfg); tried.push(v); if (startable(v)) vendor = v; }
      vendor ||= tried.find(v => !refused(v)) || tried[0];
    }
    const entry = checkTier(cfg, vendor, model ? findModel(cfg, vendor, model) : pick(cfg, vendor, mode, difficulty), allowTier);
    const eff = effortFor(cfg, vendor, entry, effort);
    if (!brief?.trim()) throw new Error('Brief is empty');
    // A satellite has its own keys, so only a spawn that can't run anywhere else is refused here.
    const elsewhere = Boolean(hub) && (wantHost ?? drow.host) !== 'hub' && Boolean(githubSlug(repo)) && Boolean(db.prepare('SELECT 1 FROM hosts WHERE key_hash IS NOT NULL').get());
    const checkCredit = (v) => { if (!elsewhere && refused(v)) throw new Error(refusal(v)); };
    checkCredit(vendor);
    const id = `${vendor}_${sanitizeModel(entry.id)}_${hex(3).slice(0, 5)}`;
    title ||= (brief.match(/^#+\s*(.+)$/m)?.[1] || brief.trim().split('\n')[0]).slice(0, 72);
    const insert = (row) => {
      db.prepare(`INSERT INTO agents (id, delegator, vendor, model, repo, base, branch, brief, title, test_writer, state, token, created_at, updated_at, role, depends_on, effort, want_host, gpu)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(row.id, d, row.vendor, row.model, repo, base || '', `hl/${id}`, brief, row.title, testWriter ? 1 : 0, row.state, token(), now(), now(), row.role, row.depends_on ?? null, row.effort ?? null, wantHost, row.gpu ? 1 : 0);
      mail.addIdentity(db, row.id, row.vendor, sanitizeModel(row.model), repo);
    };
    let tw = null;
    if (testWriter) {
      // Tests first: the test writer (cheapest model unless chosen) commits spec tests on the task branch; the implementer waits.
      const twVendor = testWriter.vendor || nextVendor(db, cfg);
      checkCredit(twVendor);
      const twEntry = testWriter.model ? findModel(cfg, twVendor, testWriter.model) : pick(cfg, twVendor, 'cheapest');
      tw = { id: `${twVendor}_${sanitizeModel(twEntry.id)}_${hex(3).slice(0, 5)}`, vendor: twVendor, model: twEntry.id, effort: effortFor(cfg, twVendor, twEntry) };
    }
    insert({ id, vendor, model: entry.id, effort: eff, title, state: tw ? 'waiting' : 'queued', role: 'impl', depends_on: tw?.id, gpu });
    if (tw) insert({ ...tw, title: `Spec tests: ${title}`.slice(0, 72), state: 'queued', role: 'tests' });
    const started = await startQueued(d);
    const state = (x) => (started.includes(x) ? 'spawning' : agentRow(x).state);
    return { id, vendor, model: entry.id, effort: eff, state: state(id), billing: agentRow(id).billing, host: agentRow(id).host, ...(tw ? { testWriter: { id: tw.id, vendor: tw.vendor, model: tw.model, state: state(tw.id), host: agentRow(tw.id).host } } : {}) };
  }

  // ---------- placement (PRD "Part 2") ----------
  /** `--host`: null/'auto' → null (auto-place); 'hub' or a joined satellite; local path repos only on the hub. */
  function checkHost(name, repo) {
    if (name == null || name === '' || name === 'auto') return null;
    const h = String(name).toLowerCase();
    if (h === 'hub') return h;
    if (!db.prepare('SELECT 1 FROM hosts WHERE name = ? AND key_hash IS NOT NULL').get(h)) {
      const known = db.prepare('SELECT name FROM hosts WHERE key_hash IS NOT NULL ORDER BY name').all().map(r => r.name);
      throw new Error(`No host ${name}: use hub${known.length ? `, ${known.join(', ')}` : ''} or auto`);
    }
    if (repo && !githubSlug(repo)) throw new Error(`${repo} is a local path: local repos run on the hub only (satellites clone from GitHub)`);
    return h;
  }
  /** Agents the hub has placed on a satellite that still hold (or wait there for) a worker. */
  const liveOn = (name, vendor = null) => db.prepare(`SELECT COUNT(*) n FROM agents WHERE host = ? AND (? IS NULL OR vendor = ?) AND (${inActive} OR state = 'queued')`).get(name, vendor, vendor, ...ACTIVE).n;
  /**
   * Hosts that can start `a` now, least busy first (the hub first on a tie): its pin (`spawn --host`), else its
   * delegator's host, else every online host. Satellites: only GitHub repos; their signed-in slots, `maxWorkers`
   * and `gpu` come from their last heartbeat, minus the agents placed there that are still live.
   */
  function placements(a, drow, hubGpu) {
    const pin = a.want_host || drow.host;
    const fits = [];
    if ((!pin || pin === 'hub') && (!a.gpu || hubGpu) && freeSlots(a.vendor).length && workerCount() < maxWorkers() && startable(a.vendor)) fits.push({ name: 'hub', live: workerCount() });
    if (hub && pin !== 'hub' && githubSlug(a.repo)) {
      for (const h of db.prepare('SELECT name, capabilities FROM hosts WHERE online = 1 AND key_hash IS NOT NULL ORDER BY name').all()) {
        if (pin && pin !== h.name) continue;
        let c = {};
        try { c = JSON.parse(h.capabilities || '{}') || {}; } catch {}
        if (a.gpu && !c.gpu) continue;
        const signed = Array.isArray(c.vendors?.[a.vendor]) ? c.vendors[a.vendor].length : 0;
        const live = liveOn(h.name);
        if (signed - liveOn(h.name, a.vendor) <= 0 || live >= Math.max(1, Number(c.maxWorkers) || 6)) continue;
        fits.push({ name: h.name, live });
      }
    }
    return fits.sort((x, y) => x.live - y.live);
  }
  /** Re-runs placement for every delegator with unplaced agents (a satellite came online or freed a slot). */
  async function startAll() {
    for (const { id } of db.prepare("SELECT DISTINCT delegator id FROM agents WHERE state = 'queued' AND host = 'hub'").all()) await startQueued(id).catch(e => log(`start ${id}: ${e.message}`));
  }

  const inActive = `state IN (${ACTIVE.map(() => '?').join(',')})`;
  /**
   * Slots with no live worker of this vendor. A slot runs at most one worker per vendor: each vendor's
   * credentials sit in their own dir under the slot, and a container mounts only its vendor's dir, so a
   * claude and a codex worker on one slot never share a refresh token. `except`: an agent to ignore (restart).
   */
  function freeSlots(vendor, except = null) {
    const used = new Set(db.prepare(`SELECT slot FROM agents WHERE slot IS NOT NULL AND host = 'hub' AND vendor = ? AND id IS NOT ? AND ${inActive}`).all(vendor, except, ...ACTIVE).map(r => r.slot));
    return slots().filter(s => !used.has(s));
  }
  /** Live worker containers on this host, across every delegator. */
  const workerCount = (except = null) => db.prepare(`SELECT COUNT(*) n FROM agents WHERE slot IS NOT NULL AND host = 'hub' AND id IS NOT ? AND ${inActive}`).get(except, ...ACTIVE).n;
  /** Host-wide cap on live workers (`maxWorkers` in ~/.hauptling/config.json, default 6), so CPU and RAM aren't overrun. */
  const maxWorkers = () => Math.max(1, Number(host.maxWorkers?.() ?? 6) || 6);

  /**
   * Starts queued agents while the delegator is under its limit (agents on every host count): each goes to the
   * first host from `placements`. On the hub: a slot free for its vendor, the hub under `maxWorkers`, and on the
   * API key or on a plan that isn't at 100% (else it waits for the reset). On a satellite: a `spawn` command.
   */
  async function startQueued(d) {
    const started = [];
    const wantsGpu = db.prepare("SELECT 1 FROM agents WHERE delegator = ? AND state = 'queued' AND host = 'hub' AND gpu = 1").get(d);
    const hubGpu = wantsGpu ? Boolean(await Promise.resolve(host.gpuAvailable?.()).catch(() => false)) : false;
    for (;;) {
      const next = tx(db, () => {
        const drow = delegatorRow(d);
        const active = db.prepare(`SELECT COUNT(*) n FROM agents WHERE delegator = ? AND (${inActive} OR (state = 'queued' AND host != 'hub'))`).get(d, ...ACTIVE).n;
        if (active >= drow.max_agents) return null;
        let a, place;
        for (const q of db.prepare("SELECT * FROM agents WHERE delegator = ? AND state = 'queued' AND host = 'hub' ORDER BY created_at").all(d)) {
          [place] = placements(q, drow, hubGpu);
          if (place) { a = q; break; }
        }
        if (!a) return null;
        if (place.name !== 'hub') {
          db.prepare("UPDATE agents SET state = 'spawning', host = ?, updated_at = ? WHERE id = ?").run(place.name, now(), a.id);
          hub.command(place.name, 'spawn', { agent: Object.fromEntries(SPAWN_FIELDS.map(k => [k, a[k] ?? null])), delegator: { id: d, gate: Boolean(drow.gate), automerge: Boolean(drow.automerge) } });
          return { ...a, remote: place.name };
        }
        const slot = freeSlots(a.vendor)[0];
        const dir = `${host.workRoot}/${a.id}`;
        const billing = billingFor(a.vendor);
        db.prepare("UPDATE agents SET state = 'spawning', slot = ?, dir = ?, billing = ?, updated_at = ? WHERE id = ?").run(slot, dir, billing, now(), a.id);
        synced(a.id);
        return { ...a, slot, dir, billing, state: 'spawning' };
      });
      if (!next) return started;
      started.push(next.id);
      if (next.remote) { log(`placed ${next.id} on ${next.remote}`); continue; }
      launch(next).catch(e => {
        update(next.id, { state: 'failed', report: `spawn failed: ${e.message}`.slice(0, 600) });
        cancelAgentTests(next.id, 'failed');
        emit(next.delegator, next.id, 'failed', `${next.id} failed to start: ${e.message}`);
        startQueued(d).catch(() => {});
      });
    }
  }

  // ---------- usage (phase 4b) ----------
  /** Per-task totals line (token economy): tokens, cost, window points since launch, test rounds. */
  function spend(a) {
    const rounds = db.prepare("SELECT COUNT(*) n FROM tests WHERE agent = ? AND purpose = 'agent'").get(a.id).n;
    return spendLine({ usage: a.usage ? JSON.parse(a.usage) : null, start: a.usage_start ? JSON.parse(a.usage_start) : null, now: windowSnapshot(db, a.vendor), rounds });
  }
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
  /** { at, until } while the vendor's key counts as out of credit, else null. */
  const keyOut = (vendor) => (getKey(vendor) ? keys.getExhausted(vendor) : null);
  /** Out of credit and no budget, so no plan to fall back to: nothing of this vendor starts here. */
  const refused = (vendor) => Boolean(keyOut(vendor)) && !getBudget(vendor);
  const refusal = (vendor) => `${vendor}: the API credit ran out and the key has no budget, so there is no plan fallback. Add funds, then \`hauptling key set ${vendor}\` (or give it a budget: \`hauptling key budget ${vendor} USD\`)`;
  /**
   * 'api' or 'plan' for a worker starting now: a key without budget covers every spawn; with a budget, until
   * STOP_AT of it is spent or the credit ran out.
   */
  function billingFor(vendor) {
    if (!getKey(vendor)) return 'plan';
    const b = budgetState(vendor);
    return !b || (b.spent < b.stop_at && !keyOut(vendor)) ? 'api' : 'plan';
  }
  const startable = (vendor) => !refused(vendor) && (billingFor(vendor) === 'api' || !exhausted(vendor));
  function priceOf(a) { try { return findModel(models(), a.vendor, a.model); } catch { return null; } }

  /**
   * Token economy: active delegators running on this vendor's CLI get `[handoff-due]` once per window at 85%.
   * Assumes the delegator's CLI is signed in to the same vendor account as the slots (one account per vendor).
   */
  function handoffDue(vendor, l) {
    for (const d of db.prepare('SELECT id FROM delegators WHERE active = 1 AND cli = ?').all(vendor)) {
      const key = `handoff:due:${d.id}:${l.window}:${l.resets_at || 'unknown'}`;
      if (kvGet(db, key)) continue;
      kvSet(db, key, now());
      const when = l.resets_at ? `resets ${new Date(l.resets_at).toLocaleString()}` : 'reset time unknown';
      emit(d.id, null, 'handoff-due', `${vendor} ${l.window} window at ${Math.round(l.used_pct)}% (${when}): write the handoff now (hauptling handoff --delegator ${d.id} --file <note>) and tell the user to start the next CLI`);
    }
  }

  const hostReports = (vendor) => Boolean(db.prepare('SELECT 1 FROM host_usage WHERE vendor = ?').get(vendor));

  /** The delegator's own CLI (`hauptling usage <vendor> --host`, or the host Codex log): its windows → handoff-due. */
  function recordHostUsage(vendor, u) {
    for (const l of u.limits) {
      db.prepare(`INSERT INTO host_usage (vendor, window, used_pct, resets_at, at) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT (vendor, window) DO UPDATE SET used_pct = excluded.used_pct, resets_at = excluded.resets_at, at = excluded.at`).run(vendor, l.window, l.used_pct, l.resets_at, now());
      if (l.used_pct >= HANDOFF_PCT) handoffDue(vendor, l);
    }
    return u;
  }

  /** Stores an agent's usage and its slot's limit windows; warns once per window at 90%. */
  function recordUsage(a, payload, sessionId = null) {
    const reading = normalizeUsage(a.vendor, payload, priceOf(a), { api: a.billing === 'api' });
    const prev = agentRow(a.id).usage;
    const u = accumulate(prev ? JSON.parse(prev) : null, reading, { vendor: a.vendor, sessionId, reported: reportedCost(a.vendor, payload) });
    update(a.id, { usage: JSON.stringify({ ...u, at: now() }) });
    if (a.billing === 'api') budgetWarn(a);
    if (!a.slot) return u;
    for (const l of u.limits) {
      db.prepare(`INSERT INTO slot_usage (slot, vendor, window, used_pct, resets_at, at) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT (slot, vendor, window) DO UPDATE SET used_pct = excluded.used_pct, resets_at = excluded.resets_at, at = excluded.at`).run(a.slot, a.vendor, l.window, l.used_pct, l.resets_at, now());
      // Slot readings stand in for the delegator's own only until its host CLI reports (same-account assumption).
      if (l.used_pct >= HANDOFF_PCT && !hostReports(a.vendor)) handoffDue(a.vendor, l);
      if (l.used_pct < 90) continue;
      const key = `usage:warn:${a.vendor}:${l.window}:${l.resets_at || 'unknown'}`; // once per account window, whichever slot reports it
      if (kvGet(db, key)) continue;
      kvSet(db, key, now());
      const when = l.resets_at ? `resets ${new Date(l.resets_at).toLocaleString()}` : 'reset time unknown';
      const full = l.used_pct >= 100;
      const text = `${a.vendor} ${l.window} window at ${Math.round(l.used_pct)}% (${when})${full ? `; new ${a.vendor} spawns wait until then` : ''}`;
      emit(a.delegator, a.id, 'usage-high', text);
      toast(a.id, { title: `${a.vendor} usage ${Math.round(l.used_pct)}%`, body: text, choices: [], links: null, dashboard: `${publicUrl}/#usage` });
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
    toast(a.id, { title: `${a.vendor} API budget ${Math.round((b.spent / b.usd) * 100)}%`, body: text, choices: [], links: null, dashboard: `${publicUrl}/#usage` });
    log(`api-budget ${text}`);
  }

  /**
   * An `api` worker's screen shows the vendor's out-of-credit error: block it, tell the delegator once, and
   * mark the key (one notification) unless the worker predates it. False: nothing to act on.
   */
  function apiOut(a) {
    const key = `api-out:${a.id}`;
    const first = !kvGet(db, key);
    if (!first && !keyOut(a.vendor)) return false; // the key was reset: this is old text on the screen
    if (a.state !== 'blocked' || first) {
      update(a.id, { state: 'blocked' });
      setStatus(a.id, 'blocked: API credit ran out');
    }
    if (!first) return true;
    kvSet(db, key, now());
    if (getKey(a.vendor) && !keyOut(a.vendor) && !(a.created_at < keys.keySetAt(a.vendor))) {
      const b = getBudget(a.vendor);
      keys.markExhausted(a.vendor, b ? periodEnd(b.resets_on) : null);
      const next = b ? `new ${a.vendor} workers use your plan until ${new Date(periodEnd(b.resets_on)).toLocaleDateString()}`
        : `new ${a.vendor} spawns are refused until the key is reset`;
      toast(a.id, { title: `${a.vendor} API credit ran out`, body: `${next}. Add funds, then: hauptling key set ${a.vendor}`, choices: [], links: null, dashboard: `${publicUrl}/#usage` });
    }
    emit(a.delegator, a.id, 'api-exhausted', `${a.id}: ${a.vendor} API credit ran out. This worker can't switch billing: kill it (\`hauptling kill ${a.id}\`) and respawn the task. Its work is in the container's working tree (${a.dir}), which kill deletes: save what you need first.`);
    return true;
  }

  /** `hauptling usage <vendor>` from a worker's status line: raw vendor JSON → stored; returns the text to show. */
  function usageReport(who, { vendor, payload }) {
    if (who.role !== 'agent') throw new Error('usage.report comes from a worker\'s status line');
    const a = agentRow(who.agent);
    if (vendor !== a.vendor) throw new Error(`usage for ${vendor} from a ${a.vendor} worker`);
    return { text: statusText(recordUsage(a, scrub(payload), typeof payload?.session_id === 'string' ? payload.session_id : null)) };
  }

  /**
   * Codex has no status line hook: read its session log in the slot's codex dirs (throttled; poll and the
   * dashboard call this). Only codex workers mount those dirs and a slot holds one codex worker at a time,
   * so the newest log there since the agent started is the agent's, whatever other vendors run on the slot.
   */
  let codexAt = 0;
  async function refreshUsage({ force = false } = {}) {
    if (!host.codexUsage || (!force && Date.now() - codexAt < 10e3)) return;
    codexAt = Date.now();
    const cd = db.prepare("SELECT MIN(created_at) since FROM delegators WHERE active = 1 AND cli = 'codex'").get();
    if (cd?.since && host.hostCodexUsage) {
      try { const p = await host.hostCodexUsage(cd.since); if (p) recordHostUsage('codex', normalizeUsage('codex', p)); }
      catch (e) { log(`host codex usage: ${e.message}`); }
    }
    for (const a of db.prepare("SELECT * FROM agents WHERE vendor = 'codex' AND slot IS NOT NULL AND host = 'hub' AND state IN ('working','blocked','done')").all()) {
      try {
        const p = await host.codexUsage(a.slot, a.created_at);
        if (p) recordUsage(a, p);
      } catch (e) { log(`codex usage ${a.id}: ${e.message} (format changed? usage shows unknown)`); }
    }
  }

  async function cloneWorker(a, { restart = false } = {}) {
    await host.run(a.slot, ['rm', '-rf', a.dir]);
    await host.run(a.slot, ['mkdir', '-p', host.workRoot]);
    await host.run(a.slot, ['git', 'clone', '--quiet', cloneUrl(a), a.dir], { env: await authEnv(a) });
    let base = a.base;
    if (!base) base = await git(a, ['rev-parse', '--abbrev-ref', 'HEAD']);
    let from = `origin/${a.start_from || base}`;
    if (restart) {
      const branch = await git(a, ['branch', '--remotes', '--list', `origin/${a.branch}`]);
      if (branch) from = `origin/${a.branch}`;
    }
    await git(a, ['checkout', '--quiet', '-B', a.branch, from]);
    return { ...a, base };
  }

  async function workerOptions(a, { restart = false, newClone = !restart } = {}) {
    const cfg = models();
    const entry = findModel(cfg, a.vendor, a.model);
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
    const brief = briefText({ ...a, codegraph: cg });
    // Kept out of git (and so out of commitFor's `add -A`): the brief, and pnpm's store, which pnpm puts in /work
    // because the clone is a different mount from the worker's home.
    const exclude = `printf '%s\\n' ${CLONE_EXCLUDES.join(' ')} >> "$1/.git/info/exclude"`;
    await host.run(a.slot, ['sh', '-c', `mkdir -p "$(dirname "$0")" && cat > "$0"${newClone ? ` && ${exclude}` : ''}`, briefPath, a.dir],
      { input: restart ? `${RESTART_PREAMBLE}\n\n${brief}` : brief });
    const prompt = restart ? `${RESTART_PREAMBLE}\n${START_PROMPT}` : START_PROMPT;
    const argv = launchArgv(cfg, a.vendor, entry, prompt, a.effort);
    const args = argv.filter(arg => arg !== prompt);
    let resumeArgv;
    if (restart && a.session_id) {
      if (a.vendor === 'claude') resumeArgv = [...args, '--resume', a.session_id, RESUME_PROMPT];
      if (a.vendor === 'codex') resumeArgv = [args[0], 'resume', ...args.slice(1), a.session_id, RESUME_PROMPT];
    }
    return { slot: a.slot, id: a.id, dir: a.dir, vendor: a.vendor, apiKey: a.billing === 'api', argv, resumeArgv,
      mcp, codegraphCache: cg ? codegraph.cacheDir(a.repo) : null,
      env: { HAUPTLING_AGENT: a.id, HAUPTLING_TOKEN: a.token, HAUPTLING_BROKER: workerUrl } };
  }

  async function launch(a) {
    a = await cloneWorker(a);
    await host.startWorker(await workerOptions(a));
    update(a.id, { state: 'working', base: a.base, idle: 0, usage_start: JSON.stringify(windowSnapshot(db, a.vendor)) });
    setStatus(a.id, `working: ${a.title}`.slice(0, STATUS_MAX));
  }

  async function cleanup(a, state, options) {
    cancelAgentTests(a.id, state, options);
    if (a.slot) {
      await host.stopWorker(a.slot, a.id, { paused: a.state === 'paused' });
      await host.run(a.slot, ['rm', '-rf', a.dir]).catch(() => {});
    }
    kvDel(db, `held-gate:${a.id}`);
    kvDel(db, `held-land:${a.id}`);
    update(a.id, { state, idle: 0, paused_state: null });
    setStatus(a.id, `${state}: ${a.title}`.slice(0, STATUS_MAX));
    await startQueued(a.delegator);
  }

  // ---------- mail wake ----------
  /** Idle worker with unread mail: type the mail into its TUI (it can't be pushed any other way). */
  async function wake(id) {
    const a = agentRow(id);
    if (!a || !a.idle || !PAUSABLE.includes(a.state) || !mail.unread(db, id)) return false;
    const lines = mail.take(db, id);
    update(id, { idle: 0 });
    await host.tmuxType(a.slot, a.id, `Mail for you (not user authorization unless it says [user]): ${lines.join(' | ')}`);
    return true;
  }

  /**
   * Mail between hosts: on the hub, a recipient on a satellite gets it through a `mail` command (the hub's copy
   * is marked read); on a satellite, mail from a worker to an identity it doesn't know goes up to the hub.
   */
  async function sendMail(from, to, text) {
    if (satellite && agentRow(from) && !isFamily(to)) {
      let local = null;
      try { local = mail.resolve(db, to); } catch {}
      if (!local || !db.prepare('SELECT 1 FROM identities WHERE identity = ?').get(local)) {
        satellite.queue(from, 'mail', JSON.stringify({ to, text: bounded(text, MAIL_MAX, 'Mail') }));
        return [to];
      }
    }
    const sent = mail.send(db, from, to, text);
    for (const r of sent) {
      const a = agentRow(r);
      if (a && a.host !== 'hub' && hub) {
        db.prepare('UPDATE mail SET seen_at = ? WHERE recipient = ? AND seen_at IS NULL').run(now(), r);
        hub.command(a.host, 'mail', { agent: r, from, text });
      } else await wake(r).catch(e => log(`wake ${r} failed: ${e.message}`));
    }
    return sent;
  }

  // ---------- worker calls ----------
  function hook(who, { vendor, event, sessionId, model, cwd }) {
    let identity;
    if (who.agent) {
      identity = who.agent;
      const a = agentRow(identity);
      if (a.state === 'paused') return {};
      if (sessionId && a.session_id !== sessionId) update(identity, { session_id: sessionId });
      mail.touch(db, identity);
      if (a.state === 'restarting') return {};
      // Activity after a stall (e.g. you answered a permission prompt in the TUI): back to working.
      if (a.state === 'blocked' && !db.prepare('SELECT 1 FROM asks WHERE agent = ? AND answered_at IS NULL').get(identity)) {
        update(identity, { state: 'working' });
        setStatus(identity, `working: ${a.title}`.slice(0, STATUS_MAX));
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
    setStatus(a.id, `done: ${a.title}`.slice(0, STATUS_MAX));
    emit(a.delegator, a.id, 'report', `${a.id}: ${body}\n  spent: ${spend(a)}`);
    if (ahead) gate(a.id).catch(e => { emit(a.delegator, a.id, 'gate-error', `${a.id}: ${e.message}`); });
    else update(a.id, { gate: 'none' });
    return { sha, pushed: Boolean(ahead), branch: a.branch, committed };
  }

  /** After a report: PR + auto-merge on GitHub (test job gate when no required checks); local repos get a test job. */
  /** The target repo's hauptling.json as seen in the worker's clone ({} when absent). */
  async function repoConfig(a) {
    try { return JSON.parse((await host.run(a.slot, ['cat', `${a.dir}/hauptling.json`])).stdout); } catch { return {}; }
  }

  const delegatorRow = (id) => db.prepare('SELECT * FROM delegators WHERE id = ?').get(id);

  async function gate(id) {
    let a = agentRow(id);
    const d = delegatorRow(a.delegator);
    const slug = githubSlug(a.repo);
    if (slug && (await repoConfig(a)).pushToMain) {
      // Per-repo opt-in: no PR; a passing gate test pushes straight to the base branch.
      update(id, { gate: 'push' });
      if (!d.gate) return land(agentRow(id));
      requestTest({ agent: id, requester: 'hauptling', sha: a.sha, purpose: 'gate' });
      return;
    }
    if (slug) {
      let pr = a.pr_number ? { url: a.pr_url, number: a.pr_number } : await github.prFind(slug, a.branch);
      if (!pr) pr = await github.prCreate(slug, a.branch, a.base, a.title, `${a.report}\n\nWorker: ${a.id} (hauptling)`);
      update(id, { pr_url: pr.url, pr_number: pr.number });
      const checks = await github.requiredChecks(slug, a.base);
      if (checks.length) {
        update(id, { gate: 'ci' });
        if (d.automerge) await github.prAutoMerge(slug, pr.number);
        else emitReady(agentRow(id));
        return;
      }
    }
    a = agentRow(id);
    if (a.gate === 'push') return;
    if (!delegatorRow(a.delegator).gate) { update(id, { gate: 'off' }); return land(agentRow(id)); }
    update(id, { gate: 'tests' });
    requestTest({ agent: id, requester: 'hauptling', sha: a.sha, purpose: 'gate' });
  }

  const emitReady = (a, why = '') => emit(a.delegator, a.id, 'ready', `${a.id} ready to merge${why}${a.pr_url ? ` (${a.pr_url})` : ''}: run \`hauptling merge ${a.id}\` (or the dashboard's Merge button)`);

  /** The gate is passed or off: merge now, or stop at [ready] when the delegator turned auto-merge off. */
  async function land(a) {
    if (a.state === 'paused' || a.state === 'restarting') {
      kvSet(db, `held-land:${a.id}`, a.sha);
      return;
    }
    if (!delegatorRow(a.delegator).automerge) return emitReady(a);
    await mergeNow(a);
    if (githubSlug(a.repo)) await poll();
  }

  /** Merges a reported agent's work: push to base (pushToMain), the GitHub PR, or the local branch. Emits `merged` (PRs: poll does). */
  async function mergeNow(a) {
    if (merging.has(a.id)) throw new Error(`${a.id} already has a merge in progress`);
    merging.add(a.id);
    try { await mergeAgent(a); }
    finally { merging.delete(a.id); }
  }

  async function mergeAgent(a) {
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
    } else if (slug) {
      if (a.gate === 'ci') await github.prAutoMerge(slug, a.pr_number); // GitHub's required checks still apply
      else await github.prMerge(slug, a.pr_number); // the caller polls, which emits [merged]
    } else {
      const hostGit = (repo, args) => host.hostGit(repo, args);
      const current = await hostGit(a.repo, ['rev-parse', '--abbrev-ref', 'HEAD']);
      if (current === a.base) {
        if (await hostGit(a.repo, ['status', '--porcelain', '--untracked-files=no'])) throw new Error(`${a.base} is checked out with uncommitted changes in ${a.repo}`);
        await hostGit(a.repo, ['merge', '--no-ff', '-m', `Merge ${a.branch}: ${a.title}`, a.branch]);
      } else await hostGit(a.repo, ['fetch', '.', `${a.branch}:${a.base}`]);
      await cleanup(a, 'merged');
      emit(a.delegator, a.id, 'merged', `${a.id} merged into ${a.base}`);
    }
  }

  /** Stores a question and notifies you; the answer page is keyed by a random nonce, not a token. */
  function postAsk(a, question, choices, remoteId = null) {
    const nonce = token();
    const r = db.prepare('INSERT INTO asks (agent, question, choices, at, nonce, remote_id) VALUES (?, ?, ?, ?, ?, ?)').run(a.id, question, JSON.stringify(choices), now(), nonce, remoteId);
    const id = Number(r.lastInsertRowid);
    if (satellite) { // the hub notifies you and keeps the answer page
      satellite.queue(a.id, 'ask', JSON.stringify({ ask: id, question, choices }));
      return id;
    }
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
    setStatus(a.id, `blocked: ${q}`.slice(0, STATUS_MAX));
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
    if (a.host !== 'hub' && hub) return { answered: value, ...(await remote(a, 'answer', { agent: a.id, ask: q.remote_id, text: String(value) })) };
    if (a.state === 'blocked') update(a.id, { state: 'working' });
    if (a.state === 'paused' && a.paused_state === 'blocked') update(a.id, { paused_state: 'working' });
    setStatus(a.id, `working: ${a.title}`.slice(0, STATUS_MAX));
    await sendMail('user', a.id, `Answer to "${q.question.slice(0, 120)}": ${value}`.slice(0, MAIL_MAX));
    return { answered: value };
  }

  /** Free-text reply from you: answers the agent's open question if it has one. */
  async function reply({ agent, text }) {
    const a = mustAgent(agent);
    const open = db.prepare('SELECT id FROM asks WHERE agent = ? AND answered_at IS NULL ORDER BY id DESC LIMIT 1').get(a.id);
    if (open) return answer({ ask: open.id, text: bounded(text, 250, 'Reply') });
    if (a.host !== 'hub' && hub) return remote(a, 'reply', { agent: a.id, text });
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
    testSynced(id);
    if (a && round >= 3 && PAUSABLE.includes(a.state)) {
      const q = `${a.id} is on test round ${round}. Keep iterating?`;
      update(a.id, { state: 'blocked' });
      setStatus(a.id, `blocked: test round ${round}`);
      postAsk(a, q, ['Keep going', 'Stop and report what you have']);
    }
    bus.emit('tests');
    pump().catch(e => log(`test pump: ${e.message}`));
    return { id, round };
  }

  /**
   * Cancels test jobs: queued ones are marked done/cancelled, running ones too and their container is
   * stopped. A cancelled job never reaches testReport or gateResult (its late result is discarded).
   */
  function cancelTests(rows, notes, { resumeQueue = true } = {}) {
    for (const { id, state } of rows) {
      const report = JSON.stringify({ id, status: 'cancelled', passed: 0, failed: 0, skipped: 0, failures: [], notes });
      db.prepare("UPDATE tests SET state = 'done', report = ?, done_at = ? WHERE id = ?").run(report, now(), id);
      testSynced(id);
      kvDel(db, `gpu:need:${id}`);
      kvDel(db, `gpu:wait:${id}`);
      bus.emit(`test:${id}`);
      if (state === 'running') Promise.resolve(host.killTestJob?.(id)).catch(e => log(`kill test ${id}: ${e.message}`));
    }
    if (rows.length && resumeQueue) pump().catch(e => log(`test pump: ${e.message}`));
  }
  /** A newer report supersedes the agent's gate jobs for other shas. */
  function supersedeGates(agentId, sha) {
    cancelTests(db.prepare("SELECT id, state FROM tests WHERE agent = ? AND purpose = 'gate' AND state IN ('queued', 'running') AND sha != ?").all(agentId, sha), 'superseded by a newer report');
  }
  /** An agent that ended (killed, closed, failed, merged, handed off) gives up all its queued and running test jobs. */
  function cancelAgentTests(agentId, why, options) {
    cancelTests(db.prepare("SELECT id, state FROM tests WHERE agent = ? AND state IN ('queued', 'running')").all(agentId), `agent ${why}`, options);
  }

  const errorReport = (job, notes) => ({ id: job.id, sha: job.sha, status: 'error', passed: 0, failed: 0, skipped: 0, failures: [], duration_s: 0, notes: String(notes).slice(0, 300) });

  /**
   * Two queues, each job in a fresh container. CPU jobs: up to `testConcurrency` at once (host
   * setting, default 2), at most one per repo, FIFO otherwise. GPU jobs (`--gpus all`): one at a time.
   * External runners use test.claim (CPU queue only, same one-per-repo rule).
   */
  const concurrency = () => Math.max(1, Number(host.testConcurrency?.() ?? 2) || 2);
  const pumping = { gpu: false };
  async function pump() { pumpCpu(); await pumpGpu(); }
  function pumpCpu() {
    if (!host.runTestJob) return;
    while (db.prepare("SELECT COUNT(*) n FROM tests WHERE state = 'running' AND gpu = 0 AND host = 'hub'").get().n < concurrency()) {
      const t = grab(false);
      if (!t) break;
      runJob(jobFor(t)).catch(e => log(`test run ${t.id}: ${e.message}`));
    }
  }
  async function pumpGpu() {
    if (pumping.gpu || !host.runTestJob) return;
    pumping.gpu = true;
    try {
      for (;;) {
        if (!(await gpuReady())) break;
        const t = grab(true);
        if (!t) break;
        await runJob(jobFor(t));
      }
    } finally { pumping.gpu = false; }
  }
  /**
   * Runs a claimed job to its report; a job cancelled or requeued meanwhile (`gpu pause --now`, the
   * watchdog) has its result discarded. A report marked `lost` (container ended without a result) goes to
   * the watchdog. The watchdog can abandon the run, so a hung runner doesn't hold the GPU queue.
   */
  async function runJob(job) {
    let report;
    const run = { claimed_at: job.claimed_at };
    const abandoned = new Promise(r => { run.abandon = () => r(null); });
    localRuns.set(job.id, run);
    try {
      const env = job.url.startsWith('https://github.com/') ? await github.gitAuthEnv() : {};
      report = await Promise.race([host.runTestJob(job, { env }), abandoned]);
    } catch (e) { report = errorReport(job, e.message); }
    finally { if (localRuns.get(job.id) === run) localRuns.delete(job.id); }
    if (run.lost) { await run.lost; report = null; } // the watchdog took it: wait until it is requeued or failed
    const row = db.prepare('SELECT state, claimed_at FROM tests WHERE id = ?').get(job.id);
    if (report && row.state === 'running' && row.claimed_at === job.claimed_at) {
      if (report.lost) await runnerLost(job.id, job.claimed_at, report.lost).catch(e => log(`test watchdog ${job.id}: ${e.message}`));
      else await testReport({ id: job.id, report }).catch(e => log(`test report ${job.id}: ${e.message}`));
    }
    if (!job.gpu) pumpCpu();
  }

  // ---------- test watchdog ----------
  /** Locally running jobs: id → { claimed_at, abandon() }. Jobs claimed by external runners aren't watched. */
  const localRuns = new Map();
  const watchCfg = () => {
    const c = host.testWatchdog?.() || {};
    const n = (v, d) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : d);
    return { stallSec: Math.max(1, n(c.stallSec, 300)), retries: Math.max(0, n(c.retries, 2)) };
  };

  /**
   * Every poll: a local job whose container is gone or exited without a result, or whose log and runner
   * heartbeat haven't changed for `testStallSec`, is lost. Jobs still in checkout/image build aren't watched;
   * `timeout_s` stays the hard cap (the runner's own timeout, never retried).
   */
  async function watchTests(at = Date.now()) {
    if (!host.testLiveness) return;
    const { stallSec } = watchCfg();
    for (const [id, run] of [...localRuns]) {
      const t = db.prepare('SELECT state, claimed_at FROM tests WHERE id = ?').get(id);
      if (t?.state !== 'running' || t.claimed_at !== run.claimed_at) continue;
      const l = await host.testLiveness(id).catch(() => ({ state: 'unknown' }));
      const idle = Math.round((at - (l.activity ?? at)) / 1000);
      const why = l.state === 'gone' ? 'container gone'
        : l.state === 'exited' ? 'container exited without a result'
          : l.state === 'running' && idle > stallSec ? `no output or heartbeat for ${idle}s` : null;
      if (why) await runnerLost(id, run.claimed_at, why).catch(e => log(`test watchdog ${id}: ${e.message}`));
    }
  }

  /**
   * A job's runner is lost: remove its container, release its runner (for a GPU job, the GPU queue), then
   * requeue the same row at the front of its repo (same created_at, no extra round), or after `testRetries`
   * reruns report it failed through the usual path (test wait, gate-failed).
   */
  async function runnerLost(id, claimedAt, reason) {
    const t = db.prepare('SELECT * FROM tests WHERE id = ?').get(id);
    if (t?.state !== 'running' || t.claimed_at !== claimedAt) return;
    const max = watchCfg().retries + 1;
    // Its runJob (if still waiting) holds off until the row is requeued or failed: no late result, and the
    // GPU queue doesn't move on to another job while the container is being removed.
    const run = localRuns.get(id);
    let release = () => {};
    if (run?.claimed_at === claimedAt) { localRuns.delete(id); run.lost = new Promise(r => { release = r; }); }
    try {
      await host.killTestJob?.(id).catch(e => log(`kill test ${id}: ${e.message}`));
      run?.abandon(); // a hung runner that the kill didn't end
      if (t.attempt >= max) {
        log(`test ${id} killed: ${reason}; runner unresponsive (${t.attempt} attempts), failed`);
        await testReport({ id, report: errorReport(t, `runner unresponsive (${t.attempt} attempts): ${reason}`) });
        return;
      }
      const note = `retrying (${t.attempt + 1}/${max}): ${reason}`;
      const r = db.prepare("UPDATE tests SET state = 'queued', claimed_at = NULL, attempt = ?, retry_note = ? WHERE id = ? AND state = 'running' AND claimed_at = ?").run(t.attempt + 1, note.slice(0, 300), id, claimedAt);
      if (!r.changes) return;
      testSynced(id);
      kvDel(db, `gpu:wait:${id}`);
      log(`test ${id} killed: ${note}`);
      bus.emit('tests');
    } finally { release(); }
    pump().catch(e => log(`test pump: ${e.message}`));
  }

  /** Dashboard "Run now": starts a queued CPU job at once, past the concurrency limit and the one-per-repo rule. */
  function testRunNow({ id }) {
    const t = db.prepare('SELECT * FROM tests WHERE id = ?').get(id);
    if (!t) throw new Error(`No test ${id}`);
    if (t.host !== 'hub' && hub) return remote(agentRow(t.agent) || { host: t.host }, 'test-run', { agent: t.agent, test: id });
    if (t.state !== 'queued') throw new Error(`Test ${id} is ${t.state}, not queued`);
    if (t.agent && ['paused', 'restarting'].includes(agentRow(t.agent)?.state)) throw new Error(`Agent ${t.agent} is paused or restarting`);
    if (t.gpu) throw new Error('GPU jobs run one at a time; use the GPU queue controls');
    if (!host.runTestJob) throw new Error('No local test runner');
    t.claimed_at = now();
    db.prepare("UPDATE tests SET state = 'running', claimed_at = ? WHERE id = ? AND state = 'queued'").run(t.claimed_at, id);
    testSynced(id);
    runJob(jobFor(t)).catch(e => log(`test run ${id}: ${e.message}`));
    return { started: id };
  }

  // ---------- GPU queue ----------
  const gpuCfg = () => ({ memMB: 6144, waitMinutes: 30, ...host.gpuConfig?.() });
  const nextGpuJob = () => db.prepare(`SELECT q.* FROM tests q WHERE q.state = 'queued' AND q.gpu = 1 AND q.host = 'hub' AND ${TEST_ELIGIBLE} ORDER BY q.created_at, q.rowid LIMIT 1`).get();

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
      if (kvGet(db, 'gpu:paused')) return false;
      if (nextGpuJob()?.id !== t.id) continue;
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
    const running = db.prepare("SELECT id FROM tests WHERE state = 'running' AND gpu = 1 AND host = 'hub'").all();
    if (!hard) return { paused: true, running: running.map(r => r.id) };
    for (const { id } of running) {
      db.prepare("UPDATE tests SET state = 'queued', claimed_at = NULL WHERE id = ?").run(id);
      testSynced(id);
      await host.killTestJob?.(id).catch(e => log(`kill test ${id}: ${e.message}`));
    }
    return { paused: true, requeued: running.map(r => r.id) };
  }
  function gpuResume() { kvDel(db, 'gpu:paused'); pump().catch(e => log(`test pump: ${e.message}`)); return { paused: false }; }
  async function gpuStatus() {
    const c = gpuCfg();
    const running = db.prepare("SELECT id, agent, purpose, claimed_at, timeout_s FROM tests WHERE state = 'running' AND gpu = 1 AND host = 'hub'").all();
    const queued = db.prepare("SELECT id, agent, purpose, created_at FROM tests WHERE state = 'queued' AND gpu = 1 AND host = 'hub' ORDER BY created_at").all()
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

  /** Broker start: cancel ended agents’ jobs and requeue the remaining interrupted jobs first in line. */
  async function recover() {
    await host.removeTestContainers?.().catch(e => log(`remove test containers: ${e.message}`));
    const ended = [...ENDED, 'failed', 'exited'];
    const agents = db.prepare(`SELECT DISTINCT a.id, a.state FROM agents a JOIN tests t ON t.agent = a.id
      WHERE a.host = 'hub' AND a.state IN (${ended.map(() => '?').join(',')}) AND t.state IN ('queued', 'running')`).all(...ended);
    for (const a of agents) cancelAgentTests(a.id, a.state, { resumeQueue: false });
    const r = db.prepare("UPDATE tests SET state = 'queued', claimed_at = NULL WHERE state = 'running' AND host = 'hub'").run();
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

  /** Claims the oldest queued job of a queue (CPU: skipping repos that already have a CPU job running). */
  const grab = (gpu) => tx(db, () => {
    const t = gpu
      ? nextGpuJob()
      : db.prepare(`SELECT q.* FROM tests q WHERE q.state = 'queued' AND q.gpu = 0 AND q.host = 'hub' AND ${TEST_ELIGIBLE} AND NOT EXISTS (SELECT 1 FROM tests r WHERE r.state = 'running' AND r.gpu = 0 AND r.host = 'hub' AND r.repo = q.repo) ORDER BY q.created_at, q.rowid LIMIT 1`).get();
    if (!t) return null;
    t.claimed_at = now();
    db.prepare("UPDATE tests SET state = 'running', claimed_at = ? WHERE id = ?").run(t.claimed_at, t.id);
    testSynced(t.id);
    return t;
  });
  function jobFor(t) {
    const a = t.agent ? agentRow(t.agent) : null;
    return { id: t.id, url: cloneUrl(a || { repo: t.repo }), sha: t.sha, selector: t.selector, timeout_s: t.timeout_s, artifacts: JSON.parse(t.artifacts), gpu: Boolean(t.gpu), claimed_at: t.claimed_at, attempt: t.attempt || 1 };
  }

  async function claim({ wait = 25, gpu = false } = {}) {
    if (!gpu) kvSet(db, 'runner_seen', Date.now());
    let t = grab(gpu);
    if (!t && wait > 0) {
      await new Promise(r => { const timer = setTimeout(r, wait * 1000); bus.once('tests', () => { clearTimeout(timer); r(); }); });
      t = grab(gpu);
    }
    return { job: t ? jobFor(t) : null };
  }

  async function testReport({ id, report }) {
    const t = db.prepare('SELECT * FROM tests WHERE id = ?').get(id);
    if (!t) throw new Error(`No test ${id}`);
    if (t.state === 'done') throw new Error(`Test ${id} already reported`);
    if (report.sha !== t.sha) throw new Error(`Report is for ${report.sha}, request was ${t.sha}: rejected`);
    if (!['pass', 'fail', 'error', 'timeout'].includes(report.status)) throw new Error('Bad status');
    report = { ...report, id, notes: report.notes?.slice(0, 300), failures: (report.failures || []).slice(0, 20).map(f => ({ ...f, message: String(f.message || '').slice(0, 300), excerpt: String(f.excerpt || '').split('\n').slice(0, 20).join('\n') })) };
    db.prepare("UPDATE tests SET state = 'done', report = ?, done_at = ? WHERE id = ?").run(JSON.stringify(report), now(), id);
    testSynced(id);
    kvDel(db, `gpu:need:${id}`);
    kvDel(db, `gpu:wait:${id}`);
    bus.emit(`test:${id}`);
    if (t.purpose === 'gate' && t.agent) await gateResult(agentRow(t.agent), t, report);
    return { ok: true };
  }

  async function gateResult(a, t, r) {
    if (a.sha !== t.sha || ENDED.includes(a.state)) return;
    if (['paused', 'restarting'].includes(a.state)) {
      kvSet(db, `held-gate:${a.id}`, t.id);
      return;
    }
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
      const gpu = cfg.gateGpu && Array.isArray(cfg.gpu) && await host.gpuAvailable?.();
      const current = agentRow(a.id);
      if (current.state !== a.state || current.sha !== t.sha) return gateResult(current, t, r);
      if (gpu) {
        gpuRequest({ agent: a.id, requester: 'hauptling', sha: t.sha, purpose: 'gate' }, cfg);
        setStatus(a.id, 'gate: waiting for GPU');
        emit(a.delegator, a.id, 'gate-cpu-passed', `${a.id} gate tests ${summary}; GPU gate queued`);
        return;
      }
    }
    if (!delegatorRow(a.delegator).automerge) return emitReady(a, ' (gate tests passed)');
    if (a.gate === 'push') return mergeNow(a);
    if (githubSlug(a.repo)) {
      await mergeNow(a);
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
    const offline = new Set(db.prepare('SELECT name FROM hosts WHERE online = 0').all().map(h => h.name));
    return rows.map(({ token: _t, brief: _b, ...r }) => ({ ...r, status: db.prepare('SELECT text FROM status WHERE identity = ?').get(r.id)?.text || null, ...(offline.has(r.host) ? { host_offline: true } : {}) }));
  }

  async function lifecycle(agent, change) {
    const a = mustAgent(agent);
    if (changing.has(a.id) || merging.has(a.id)) throw new Error(`${a.id} already has a lifecycle action in progress`);
    changing.add(a.id);
    try { return await change(a); }
    finally { changing.delete(a.id); }
  }

  function refreshAgent(a, state, idle = a.idle) {
    update(a.id, { state, idle, paused_state: null });
    mail.touch(db, a.id);
    setStatus(a.id, `${state}: ${a.title}`.slice(0, STATUS_MAX));
  }

  async function releaseHeldWork(id) {
    const key = `held-gate:${id}`;
    const gateId = kvGet(db, key);
    if (gateId) {
      kvDel(db, key);
      const t = testGet({ id: gateId });
      await gateResult(agentRow(id), t, t.report).catch(e => log(`held gate ${id}: ${e.message}`));
    }
    const landKey = `held-land:${id}`;
    const sha = kvGet(db, landKey);
    if (sha) {
      kvDel(db, landKey);
      const a = agentRow(id);
      if (a.sha === sha && !ENDED.includes(a.state)) await land(a).catch(e => log(`held merge ${id}: ${e.message}`));
    }
    bus.emit('tests');
    pump().catch(e => log(`test pump: ${e.message}`));
  }

  const pause = ({ agent }) => lifecycle(agent, async a => {
    if (a.state === 'paused') return { paused: a.id };
    if (!a.slot || !PAUSABLE.includes(a.state)) throw new Error(`${a.id} is ${a.state}; no worker to pause`);
    update(a.id, { state: 'paused', paused_state: a.state });
    try { await host.pauseWorker(a.slot, a.id); }
    catch (e) {
      update(a.id, { state: a.state, paused_state: null });
      await releaseHeldWork(a.id);
      throw e;
    }
    emit(a.delegator, a.id, 'paused', `${a.id} paused`);
    return { paused: a.id };
  });

  const unpause = ({ agent }) => lifecycle(agent, async a => {
    if (a.state !== 'paused') throw new Error(`${a.id} is ${a.state}; only paused workers can resume`);
    await host.unpauseWorker(a.slot, a.id);
    update(a.id, { state: agentRow(a.id).paused_state, paused_state: null });
    mail.touch(db, a.id);
    await releaseHeldWork(a.id);
    await wake(a.id).catch(e => log(`wake ${a.id}: ${e.message}`));
    emit(a.delegator, a.id, 'resumed', `${a.id} resumed`);
    return { resumed: a.id };
  });

  const restart = ({ agent }) => lifecycle(agent, async a => {
    if (![...PAUSABLE, 'paused', 'exited', 'failed', 'restarting'].includes(a.state) || !a.dir) throw new Error(`${a.id} is ${a.state}; no worker to restart`);
    const free = freeSlots(a.vendor, a.id);
    const slot = a.slot && free.includes(a.slot) ? a.slot : free[0];
    if (!slot) throw new Error(`No slot free for ${a.vendor}`);
    if (!ACTIVE.includes(a.state) && workerCount(a.id) >= maxWorkers()) throw new Error(`maxWorkers (${maxWorkers()}) workers are running; free one first`);
    update(a.id, { state: 'restarting', slot, idle: 0 });
    let newClone = false;
    let attempted = false;
    try {
      // Work normally lives in a host bind mount, which survives container removal.
      try { await git(a, ['rev-parse', '--is-inside-work-tree']); }
      catch (e) {
        const exists = await host.run(a.slot, ['test', '-e', a.dir]).then(() => true, () => false);
        if (exists) throw e;
        a = await cloneWorker(a, { restart: true });
        newClone = true;
      }
      const options = await workerOptions({ ...a, slot }, { restart: true, newClone });
      if (a.slot !== slot) options.resumeArgv = undefined; // vendor sessions are stored in the original slot
      update(a.id, { session_id: null });
      attempted = true;
      const reused = a.slot === slot && await host.restartWorker(options);
      if (!reused) await host.startWorker(options);
    } catch (e) {
      if (!attempted) {
        update(a.id, { state: a.state, slot: a.slot, idle: a.idle, session_id: a.session_id });
        if (a.state !== 'paused') await releaseHeldWork(a.id);
      } else {
        refreshAgent(a, 'exited', 0);
        if (!agentRow(a.id).session_id) update(a.id, { session_id: a.session_id });
      }
      throw e;
    }
    update(a.id, { base: a.base });
    refreshAgent(a, 'working', 0);
    emit(a.delegator, a.id, 'restarted', `${a.id} restarted`);
    await releaseHeldWork(a.id);
    return { restarted: a.id };
  });

  const kill = ({ agent }) => lifecycle(agent, async a => {
    await cleanup(a, 'killed');
    const waiting = db.prepare("SELECT id FROM agents WHERE depends_on = ? AND state = 'waiting'").get(a.id);
    emit(a.delegator, a.id, 'killed', `${a.id} killed${waiting ? `; ${waiting.id} still waits for spec tests (kill it too, or spawn a new test writer)` : ''}`);
    return { killed: a.id };
  });

  /** Manual merge, for when auto-merge is off (or local repos): needs a passing gate test unless the gate is off or GitHub's own checks gate it. */
  async function merge({ agent }) {
    const a = mustAgent(agent);
    if (a.state !== 'done') throw new Error(`${a.id} is ${a.state}; merge works after it reports`);
    if (githubSlug(a.repo) && !a.pr_number && a.gate !== 'push') throw new Error(`${a.id} has no PR yet`);
    if (delegatorRow(a.delegator).gate && a.gate !== 'ci') {
      const t = db.prepare("SELECT report FROM tests WHERE agent = ? AND purpose = 'gate' AND sha = ? AND state = 'done'").get(a.id, a.sha);
      if (!t || JSON.parse(t.report).status !== 'pass') throw new Error('No passing gate test job for the reported sha');
    }
    await mergeNow(a);
    if (githubSlug(a.repo)) await poll();
    return { merged: a.id };
  }

  /**
   * Every minute: a worker whose TUI exited is marked `exited`; one with no hook activity for
   * `stallMinutes` while not idle is probably stuck on its vendor's own permission prompt, so you
   * are notified once (attach to answer it).
   */
  const PROMPT = /(Run this command\?|Allow this|Do you want to|Requesting permission|\(y\/n\)|Approve|Press enter to continue)/i;
  async function watch(at = Date.now()) {
    for (const a of db.prepare("SELECT a.*, i.seen_at FROM agents a JOIN identities i ON i.identity = a.id WHERE a.state IN ('working','blocked') AND a.slot IS NOT NULL AND a.host = 'hub'").all()) {
      const unchanged = () => {
        const current = agentRow(a.id);
        const seen = db.prepare('SELECT seen_at FROM identities WHERE identity = ?').get(a.id)?.seen_at;
        return !changing.has(a.id) && current.state === a.state && current.updated_at === a.updated_at && seen === a.seen_at;
      };
      try {
        if (!unchanged()) continue;
        const alive = await host.tmuxAlive(a.slot, a.id);
        if (!unchanged()) continue;
        if (!alive) {
          const tail = (await host.tmuxCapture?.(a.slot, a.id, 8).catch(() => '') || '').trim().split('\n').slice(-3).join(' | ');
          if (!unchanged()) continue;
          update(a.id, { state: 'exited', idle: 0 });
          setStatus(a.id, `exited: ${a.title}`.slice(0, STATUS_MAX));
          emit(a.delegator, a.id, 'exited', `${a.id} TUI exited${tail ? `: ${tail}` : ''}. \`hauptling attach ${a.id}\` to look, \`hauptling kill ${a.id}\` to free its slot.`);
          await startQueued(a.delegator);
          continue;
        }
        if (a.billing === 'api') {
          const screen = await host.tmuxCapture?.(a.slot, a.id, 25).catch(() => '') || '';
          if (!unchanged()) continue;
          if (outOfCredit(a.vendor, screen) && apiOut(a)) continue;
        }
        if (a.state === 'working' && a.idle) {
          // Ended its turn without `hauptling report` (e.g. asked a question in plain text).
          if (at - Date.parse(a.seen_at) < idleMinutes * 60e3) continue;
          if (kvGet(db, `stall:${a.id}`) === a.seen_at) continue; // already notified this idle period
          const screen = await host.tmuxCapture?.(a.slot, a.id, 25).catch(() => '') || '';
          if (!unchanged()) continue;
          kvSet(db, `stall:${a.id}`, a.seen_at);
          const tail = screen.split('\n').map(l => l.trim()).filter(Boolean).slice(-3).join(' | ');
          update(a.id, { state: 'blocked' });
          setStatus(a.id, 'blocked: idle without report');
          toast(a.id, { title: `${a.id} is idle without reporting`, body: `${tail ? `${tail}\n` : ''}Run: hauptling attach ${a.id}`, choices: [], links: null, dashboard: `${publicUrl}/` });
          log(`idle ${a.id}`);
          continue;
        }
        if (a.state !== 'working' || a.idle || at - Date.parse(a.seen_at) < stallMinutes * 60e3) continue;
        if (kvGet(db, `stall:${a.id}`) === a.seen_at) continue; // already reported this stall
        const screen = await host.tmuxCapture?.(a.slot, a.id, 25).catch(() => '') || '';
        if (!unchanged()) continue;
        kvSet(db, `stall:${a.id}`, a.seen_at);
        const prompt = PROMPT.test(screen);
        const why = prompt ? `waiting on a ${a.vendor} permission prompt` : `no activity for ${stallMinutes} min`;
        update(a.id, { state: 'blocked' });
        setStatus(a.id, `blocked: ${why}`.slice(0, STATUS_MAX));
        toast(a.id, { title: `${a.id} may be stuck`, body: `${why}. Run: hauptling attach ${a.id}`, choices: [], links: null, dashboard: `${publicUrl}/` });
        log(`stall ${a.id}: ${why}`);
      } catch (e) { log(`watch ${a.id}: ${e.message}`); }
    }
  }

  /** Every minute: PR state for done agents (merged → free the slot; CI failure → wake the worker). */
  async function poll() {
    await refreshUsage({ force: true }).catch(e => log(`usage: ${e.message}`));
    // A usage window may have reset: queued spawns that were waiting for it can start.
    for (const { id } of db.prepare("SELECT DISTINCT delegator id FROM agents WHERE state = 'queued' AND host = 'hub'").all()) await startQueued(id).catch(e => log(`start ${id}: ${e.message}`));
    await watch();
    await watchTests().catch(e => log(`test watchdog: ${e.message}`));
    syncTests();
    for (const a of db.prepare("SELECT * FROM agents WHERE state IN ('done','working') AND pr_number IS NOT NULL AND host = 'hub'").all()) {
      try {
        const slug = githubSlug(a.repo);
        const pr = await github.prView(slug, a.pr_number);
        if (changing.has(a.id) || agentRow(a.id).state !== a.state) continue;
        if (pr.state === 'MERGED' || pr.state === 'CLOSED') {
          const state = pr.state.toLowerCase();
          await lifecycle(a.id, async current => {
            await cleanup(current, state, { resumeQueue: false });
            const message = state === 'merged' ? `merged: ${a.pr_url}` : 'PR closed without merge';
            emit(a.delegator, a.id, state, `${a.id} ${message}`);
          });
          continue;
        }
        const failed = (pr.statusCheckRollup || []).filter(c => ['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED'].includes(c.conclusion || c.state));
        if (failed.length && a.ci_note !== pr.headRefOid) {
          update(a.id, { ci_note: pr.headRefOid, state: 'working' });
          await sendMail('hauptling', a.id, `CI failed on ${pr.headRefOid.slice(0, 8)}: ${failed.map(c => c.name || c.context).join(', ')}. Reproduce it in your clone, fix, commit, then report again.`.slice(0, MAIL_MAX));
        }
      } catch (e) { log(`poll ${a.id}: ${e.message}`); }
    }
    pump().catch(e => log(`test pump: ${e.message}`)); // also rechecks a GPU job held for VRAM
  }

  // ---------- delegator lifecycle ----------
  /** `host`: bind its agents to a host (`hub` or a satellite); unset or `auto` places each agent automatically. */
  function delegatorStart({ cli, repo, max = 3, gate = true, automerge = true, host: bind }) {
    const h = checkHost(bind, repo);
    const id = `d_${hex(3)}`;
    db.prepare('INSERT INTO delegators (id, cli, repo, max_agents, gate, automerge, created_at, host) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(id, cli || null, repo || null, Number(max), gate ? 1 : 0, automerge ? 1 : 0, now(), h);
    return { id, ...(h ? { host: h } : {}) };
  }

  /**
   * Changes a delegator's merge settings. Turning the gate off lands its reported agents whose gate job is
   * still queued or running (the job is cancelled); turning it on affects later reports only.
   */
  async function delegatorSet({ delegator, gate, automerge, host: bind }) {
    const d = delegatorId(delegator);
    if (bind != null) db.prepare('UPDATE delegators SET host = ? WHERE id = ?').run(checkHost(bind, delegatorRow(d).repo), d);
    if (gate != null) db.prepare('UPDATE delegators SET gate = ? WHERE id = ?').run(gate ? 1 : 0, d);
    if (automerge != null) db.prepare('UPDATE delegators SET automerge = ? WHERE id = ?').run(automerge ? 1 : 0, d);
    if (gate === false) {
      const waiting = db.prepare("SELECT DISTINCT a.id FROM agents a JOIN tests t ON t.agent = a.id WHERE a.delegator = ? AND a.host = 'hub' AND a.state = 'done' AND t.purpose = 'gate' AND t.state IN ('queued', 'running') AND t.sha = a.sha").all(d);
      for (const { id } of waiting) {
        cancelTests(db.prepare("SELECT id, state FROM tests WHERE agent = ? AND purpose = 'gate' AND state IN ('queued', 'running')").all(id), 'merge gate turned off');
        update(id, { gate: 'off' });
        await land(agentRow(id)).catch(e => emit(d, id, 'gate-error', `${id}: ${e.message}`));
      }
    }
    const row = delegatorRow(d);
    if (hub && (gate != null || automerge != null)) {
      // Satellites running its agents keep their own copy of the merge settings.
      for (const { host: h } of db.prepare(`SELECT DISTINCT host FROM agents WHERE delegator = ? AND host != 'hub' AND (${inActive} OR state = 'queued')`).all(d, ...ACTIVE)) {
        hub.command(h, 'delegator', { delegator: { id: d, gate: Boolean(row.gate), automerge: Boolean(row.automerge) } });
      }
    }
    if (bind != null) placeSoon();
    return { delegator: d, gate: Boolean(row.gate), automerge: Boolean(row.automerge), ...(row.host ? { host: row.host } : {}) };
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


  // ---------- hub ↔ satellite (PRD "Part 2") ----------
  /** Runs `fn` after the current transaction (hub events are applied inside one; mail and placement open their own). */
  const later = (what, fn) => Promise.resolve().then(fn).catch(e => log(`${what}: ${e.message}`));
  const placeSoon = () => later('placement', startAll);

  /**
   * On the hub: an action on an agent that runs on a satellite becomes a command. Open link: waits up to
   * `remoteWaitMs` for the satellite's answer. Offline: stored and delivered when it reconnects.
   */
  async function remote(a, type, body = { agent: a.id }) {
    const { id, sent } = hub.command(a.host, type, body);
    if (!sent) return { queued: true, host: a.host, command: id, note: `host offline: ${a.host} gets it when it reconnects` };
    const r = await hub.result(id, remoteWaitMs);
    if (!r) return { sent: true, host: a.host, command: id, note: `sent to ${a.host}; no answer yet` };
    if (!r.ok) throw new Error(`${a.host}: ${r.error}`);
    return r.result;
  }

  /** pause, unpause, restart, kill, merge: run here, or on the agent's satellite. */
  const onItsHost = (name, local) => async (args, who) => {
    const a = args?.agent ? mustAgent(args.agent) : null;
    if (!a || a.host === 'hub' || !hub) return local(args, who);
    const r = await remote(a, HOST_CMDS[name], { agent: a.id });
    if (name === 'kill' && r?.queued && !ENDED.includes(agentRow(a.id).state)) {
      // Frees the delegator's place now; the satellite stops the worker when it is back.
      update(a.id, { state: 'killed', idle: 0, paused_state: null });
      mail.setStatus(db, a.id, `killed: ${a.title}`.slice(0, STATUS_MAX));
      emit(a.delegator, a.id, 'killed', `${a.id} killed (${a.host} is offline; its worker stops when it reconnects)`);
      placeSoon();
    }
    return r;
  };

  /**
   * On the hub: one event from satellite `name` for its agent `a` (already checked to run there), inside the
   * events transaction. Mirror kinds update the hub's rows; the rest are delegator events, as if local.
   * Its `state` never revives an agent the hub already ended (killed while its host was offline).
   */
  function receive(name, a, kind, text, at) {
    const json = () => { try { return JSON.parse(text); } catch { throw new Error(`bad ${kind} payload`); } };
    if (kind === 'state') {
      const { status, ...fields } = json();
      if (ENDED.includes(a.state)) delete fields.state;
      const cols = Object.keys(fields).filter(k => MIRROR_FIELDS.includes(k));
      if (cols.length) db.prepare(`UPDATE agents SET ${cols.map(k => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`).run(...cols.map(k => fields[k] ?? null), now(), a.id);
      if (typeof status === 'string' && status) mail.setStatus(db, a.id, status.slice(0, STATUS_MAX));
      if ('state' in fields && !ACTIVE.includes(fields.state)) placeSoon(); // a place freed up
      bus.emit('agents');
      return;
    }
    if (kind === 'test') {
      const t = json();
      if (typeof t.id !== 'string' || !/^t_[0-9a-f]{4,16}$/.test(t.id)) throw new Error('bad test id');
      const mine = db.prepare('SELECT host FROM tests WHERE id = ?').get(t.id);
      if (mine && mine.host !== name) throw new Error(`test ${t.id} belongs to ${mine.host}`);
      const cols = TEST_FIELDS.filter(k => k !== 'id' && k in t);
      const row = { ...t, agent: a.id };
      db.prepare(`INSERT INTO tests (id, host, ${cols.join(', ')}) VALUES (?, ?, ${cols.map(() => '?').join(', ')})
        ON CONFLICT (id) DO UPDATE SET ${cols.map(k => `${k} = excluded.${k}`).join(', ')}`).run(t.id, name, ...cols.map(k => row[k] ?? null));
      if (t.state === 'done') bus.emit(`test:${t.id}`);
      return;
    }
    if (kind === 'ask') {
      const q = json();
      postAsk(a, bounded(q.question, MAIL_MAX, 'Question'), (Array.isArray(q.choices) ? q.choices : []).map(c => bounded(String(c), 80, 'Choice')), Number(q.ask) || null);
      return;
    }
    if (kind === 'notify') {
      const n = json();
      notify({ title: `${String(n.title).slice(0, 120)} (${name})`, body: String(n.body ?? '').slice(0, 600), choices: [], links: null, dashboard: `${publicUrl}/` });
      return;
    }
    if (kind === 'mail') {
      const m = json();
      later(`mail from ${a.id}`, () => sendMail(a.id, String(m.to), String(m.text)));
      return;
    }
    emit(a.delegator, a.id, kind, text, at);
    if (kind === 'tests-ready') {
      // The spec tests are on GitHub: the implementer can start on any host.
      const impl = db.prepare("SELECT id FROM agents WHERE depends_on = ? AND state = 'waiting'").get(a.id);
      if (impl) { const tw = agentRow(a.id); update(impl.id, { state: 'queued', start_from: tw.branch, base: tw.base }); placeSoon(); }
    }
  }

  /** On the hub: a command's answer. A spawn the satellite refused fails the agent here. */
  function commandDone(name, c, r) {
    if (c.type !== 'spawn' || r?.ok) return;
    const a = agentRow(c.agent?.id);
    if (!a || a.host !== name || a.state !== 'spawning') return;
    update(a.id, { state: 'failed', report: `spawn on ${name} failed: ${r?.error}`.slice(0, 600) });
    emit(a.delegator, a.id, 'failed', `${a.id} failed to start on ${name}: ${r?.error}`);
    placeSoon();
  }

  /** On a satellite: a command from the hub, through the usual local code paths. */
  async function command(c) {
    const agent = typeof c.agent === 'string' ? c.agent : null;
    switch (c.type) {
      case 'spawn': return accept(c);
      case 'kill': return kill({ agent });
      case 'pause': return pause({ agent });
      case 'resume': return unpause({ agent });
      case 'restart': return restart({ agent });
      case 'merge': return merge({ agent });
      case 'reply': return reply({ agent, text: c.text });
      case 'answer': return answer({ ask: c.ask, text: c.text });
      case 'mail': return { sent: await sendMail(c.from, agent, c.text) };
      case 'test-run': return testRunNow({ id: c.test });
      case 'delegator': copyDelegator(c.delegator); return delegatorSet({ delegator: c.delegator.id, gate: c.delegator.gate, automerge: c.delegator.automerge });
      default: throw new Error(`Unknown command ${c.type}`);
    }
  }
  /** The satellite's copy of a hub delegator: inactive (no local CLI uses it), no limit of its own (the hub counts). */
  function copyDelegator(d) {
    db.prepare(`INSERT INTO delegators (id, max_agents, active, created_at, gate, automerge) VALUES (?, 1000, 0, ?, ?, ?)
      ON CONFLICT (id) DO UPDATE SET gate = excluded.gate, automerge = excluded.automerge`).run(d.id, now(), d.gate ? 1 : 0, d.automerge ? 1 : 0);
  }
  /** `spawn` on a satellite: the hub's agent row, with this host's own worker token; started like a local spawn. */
  async function accept({ agent: x, delegator: d }) {
    if (!x?.id || !d?.id) throw new Error('spawn: agent and delegator required');
    if (!githubSlug(x.repo)) throw new Error(`${x.repo} is a local path: local repos run on the hub only`);
    if (!isFamily(x.vendor)) throw new Error(`bad vendor ${x.vendor}`);
    if (!agentRow(x.id)) {
      if (refused(x.vendor)) throw new Error(refusal(x.vendor));
      copyDelegator(d);
      db.prepare(`INSERT INTO agents (id, delegator, vendor, model, repo, base, branch, brief, title, test_writer, state, token, created_at, updated_at, role, depends_on, start_from, effort, gpu)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?)`).run(x.id, d.id, x.vendor, x.model, x.repo, x.base || '', x.branch, x.brief, x.title, x.test_writer ? 1 : 0,
        token(), now(), now(), x.role || 'impl', x.depends_on ?? null, x.start_from ?? null, x.effort ?? null, x.gpu ? 1 : 0);
      mail.addIdentity(db, x.id, x.vendor, sanitizeModel(x.model), x.repo);
      synced(x.id);
    }
    await startQueued(d.id);
    return { state: agentRow(x.id).state };
  }

  const handlers = {
    whoami: (a, who) => who,
    hook: (a, who) => hook(who, a),
    report: (a, who) => report(who, a),
    ask: (a, who) => ask(who, a),
    answer, reply, spawn, wait, agents, poll,
    pause: onItsHost('pause', pause), unpause: onItsHost('unpause', unpause), restart: onItsHost('restart', restart), kill: onItsHost('kill', kill), merge: onItsHost('merge', merge),
    'agent.get': ({ agent }) => { const { token: _t, ...r } = mustAgent(agent); return r; },
    'attach': ({ agent }) => {
      const a = mustAgent(agent);
      if (a.host !== 'hub') {
        if (!hub) throw new Error(`${a.id} runs on ${a.host}: run \`hauptling attach ${a.id}\` on that host`);
        return { remote: a.host, online: hub.linked(a.host) }; // the CLI relays it: term.screen / term.keys
      }
      return { argv: host.attachArgv(a.slot, a.id) };
    },
    // `hauptling attach` on the hub for an agent on a satellite (PRD "Part 3"): its screen and keys over the link.
    'term.screen': ({ agent, since = null }) => { const a = onSatellite(agent); return hub.rpc(a.host, 'term.screen', { agent: a.id, since }); },
    'term.keys': ({ agent, keys }) => { const a = onSatellite(agent); return hub.rpc(a.host, 'term.keys', { agent: a.id, keys: checkKeys(keys) }); },
    'delegator.start': delegatorStart, 'delegator.end': delegatorEnd, 'delegator.set': delegatorSet, 'delegator.list': () => db.prepare('SELECT * FROM delegators ORDER BY created_at DESC').all(),
    handoff, resume,
    'mail.send': ({ from, to, text }, who) => sendMail(who.role === 'agent' ? who.agent : from, to, text),
    'mail.check': ({ identity }, who) => mail.take(db, who.role === 'agent' ? who.agent : identity),
    'mail.status': ({ identity, text }, who) => setStatus(who.role === 'agent' ? who.agent : identity, text),
    'mail.peers': ({ all }) => mail.peers(db, all),
    'mail.prune': ({ hours = 12, force = false }) => mail.prune(db, Number(hours), Date.now(), force),
    'test.request': async (a, who) => {
      if (who.role === 'agent') return agentTestRequest(who, a);
      if (!a.gpu) return requestTest({ requester: 'user', ...a });
      await checkGpu(null);
      return gpuRequest({ requester: 'user', ...a }, null);
    },
    'test.wait': testWait, 'test.get': testGet, 'test.run': testRunNow,
    'test.claim': claim, 'test.report': testReport, 'test.heartbeat': () => kvSet(db, 'runner_seen', Date.now()),
    'usage.report': (a, who) => usageReport(who, a),
    'usage.host': ({ vendor, payload }) => {
      if (!isFamily(vendor)) throw new Error(`Vendor must be claude, codex or agy, got "${vendor}"`);
      return { text: statusText(recordHostUsage(vendor, normalizeUsage(vendor, scrub(payload)))) };
    },
    'dashboard.token': ({ rotate = false }) => ({ token: dashToken(db, { rotate }), url: publicUrl }),
    'gpu.pause': gpuPause, 'gpu.resume': gpuResume, 'gpu.status': gpuStatus,
    'models.prefer': ({ value }) => (value ? savePrefer(value) : preferOf(models())),
    'slots.get': () => slots(),
    'slots.set': ({ slots: s }) => { kvSet(db, 'slots', JSON.stringify(s)); return s; },
    'hub.token': () => mustHub().issueToken(),
    'satellite.list': () => mustHub().list(),
    'satellite.revoke': (a) => mustHub().revoke(a),
  };
  const mustHub = () => { if (!hub) throw new Error('This broker has no hub'); return hub; };
  const onSatellite = (id) => {
    const a = mustAgent(id);
    if (a.host === 'hub' || !hub) throw new Error(`${a.id} runs on this host: \`hauptling attach ${a.id}\` uses tmux directly`);
    return a;
  };

  async function call(name, args = {}, who = { role: 'admin' }) {
    if (who.role === 'satellite' && !SATELLITE_CALLS.has(name)) throw new Error(`${name} is not allowed for satellite ${who.host}`);
    const fn = handlers[name];
    if (!fn) throw new Error(`Unknown call ${name}`);
    if (who.role === 'agent' && !AGENT_CALLS.has(name)) throw new Error(`${name} is not allowed for workers`);
    if (who.role === 'runner' && !RUNNER_CALLS.has(name)) throw new Error(`${name} is not allowed for the test runner`);
    if (who.role === 'agent' && ['report', 'ask', 'test.request'].includes(name)) {
      return lifecycle(who.agent, a => {
        if (!PAUSABLE.includes(a.state)) throw new Error(`Agent is ${a.state}`);
        return fn(args, who);
      });
    }
    return fn(args, who);
  }

  /** Token → caller. `hostHeader`: X-Hauptling-Host, which a satellite key must match. */
  function authenticate(tok, adminToken, hostHeader) {
    if (tok && tok === adminToken) return { role: 'admin' };
    if (tok && tok === runnerToken) return { role: 'runner' };
    const a = tok && db.prepare('SELECT id, state FROM agents WHERE token = ?').get(tok);
    if (a && !ENDED.includes(a.state)) return { role: 'agent', agent: a.id };
    return hub?.authenticate(tok, hostHeader) || null;
  }

  hub?.bind({ receive, onState: placeSoon, onResult: commandDone });
  if (satellite) syncTests();

  return { call, authenticate, emit, keyOut, command, startAll, syncTests, freeSlots, spend, poll, watch, watchTests, startQueued, bus, askForPage, answer, pump, recover, gpuReady, refreshUsage, recordUsage, budgetState, billingFor };
}
