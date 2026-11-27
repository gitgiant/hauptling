import { createHash, timingSafeEqual, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, normalize } from 'node:path';
import { cpus, freemem, hostname, totalmem } from 'node:os';
import { fileURLToPath } from 'node:url';
import { kvGet, kvSet, QUEUE_ORDER, IN_QUEUE, HELD, isHeld } from './db.mjs';
import { readOnlyQuery } from './dbquery.mjs';
import { createTerminals, HISTORY_MAX, SCREEN_MAX } from './terminal.mjs';
import { token as newToken } from './util.mjs';
import { buildBody, checkImage, brokerFacts, fileIssue, issueRepo, originUrl, scrubText } from './report.mjs';

/*
 * Dashboard (phase 4a), served by the broker:
 *   GET  /?k=<token>        swaps the dashboard token for an HttpOnly SameSite=Strict cookie
 *   GET  /, /web/*          the static page (web/dashboard)
 *   GET  /dash/stream       Server-Sent Events: a board snapshot whenever it changes
 *   GET  /dash/agent/<id>/diff|events, /dash/history, /dash/db/tables, /dash/db/table
 *   POST /dash/db/query     ad-hoc read-only SQL
 *   POST /dash/do/<call>    actions (answer, reply, pause, unpause, restart, kill, merge, gpu.*), need `X-Hauptling: 1`
 *   POST /dash/agents/<id>/move   reorder the queue: {before|after: id} or {top|bottom: true}, need `X-Hauptling: 1`
 *   POST /dash/report/preview|send   F2 "Report an issue": the scrubbed body, and filing it with `gh issue create`
 *   POST /dash/update/check|apply   is origin/main ahead; update to it and restart (PRD "Update from the dashboard")
 *   POST /dash/hosts/token  a satellite join token and the `hauptling satellite join` line (part 3, hub only)
 * With satellites (PRD "Part 3") the board carries host chips and offline states, the Usage page a Hosts panel,
 * and a satellite agent's terminal, diff and timeline come from its host over the link (`hub.rpc`); on a
 * satellite, `remote(op, args)` answers those requests.
 * Only requests to 127.0.0.1 are served (containers reach the broker on docker0 through the
 * egress relay and get 403). Token and nonce values are masked in everything the explorer shows.
 */

const WEB = fileURLToPath(new URL('../web/dashboard/', import.meta.url));
const ENDED = ['merged', 'killed', 'closed', 'handed-off'];
const NO_SESSION = [...ENDED, 'failed', 'queued', 'waiting'];
/** States in which an agent still has (or waits for) a worker on its host, so that host going offline matters. */
const HOST_LIVE = ['queued', 'waiting', 'spawning', 'restarting', 'paused', 'working', 'blocked', 'done', 'parked'];
const WORKER_LIVE = ['spawning', 'restarting', 'paused', 'working', 'blocked', 'done'];
/** A terminal relayed from a satellite ends after this many bytes; reopening starts a new one. */
export const RELAY_MAX = 32 << 20;
/** A diff a satellite sends is cut to fit in its reply. */
const DIFF_MAX = 3 << 20;
/**
 * One plain sentence for the human watching the board: what the agent is doing or waiting on now.
 * `a` is a board row (agent columns plus `status`, `test` and `ask` as the snapshot builds them).
 */
const cap = (s) => s[0].toUpperCase() + s.slice(1);
const ordinal = (n) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] || 'th'}`;
/** "retrying (2/3)" for an unfinished test job rerun by the watchdog (from its retry_note), else null. */
export const retryLabel = (t) => (t && t.state !== 'done' && t.attempt > 1 ? (String(t.retry_note || '').match(/^retrying \(\d+\/\d+\)/)?.[0] || `retrying (${t.attempt})`) : null);
export function headline(a) {
  const t = a.test;
  const pr = a.pr_number ? `PR #${a.pr_number}` : null;
  const total = (t?.passed ?? 0) + (t?.failed ?? 0);
  const score = t?.status && total ? ` (${t.passed ?? 0}/${total})` : '';
  const kind = t ? `${t.gpu ? 'GPU ' : ''}${t.purpose === 'gate' ? 'merge gate' : 'tests'}` : 'tests';
  const pending = t && !t.status ? (t.state === 'running' ? `Running ${kind}${t.retry ? `, ${t.retry}` : ''}` : t.retry ? `${cap(kind)} ${t.retry}${t.position ? `, ${ordinal(t.position)} in line` : ''}` : t.position ? `${cap(kind)} queued, ${ordinal(t.position)} in line` : `Waiting to run ${kind}`) : null;
  const why = (a.status || '').replace(/^[a-z-]+:\s*/, '');
  if (a.host_state === 'lost') return `Host lost: ${a.host} (offline over 24 h)`;
  if (a.host_state === 'offline') return `Host offline: ${a.host}`;
  if (a.state === 'parked') return `${headline({ ...a, state: 'done' })} (parked)`;
  switch (a.state) {
    case 'paused': return isHeld(a) && a.paused_state !== 'queued' ? 'Paused by you (parked, slot freed)' : 'Paused by you';
    case 'restarting': return 'Restarting its session';
    case 'blocked': return a.ask ? `Needs your answer: ${a.ask.question}` : `Stuck${why ? `: ${why}` : ''}; attach or message it`;
    case 'queued': {
      if (a.headroom) return cap(a.headroom);
      if (a.unpark) return `Unparking (${a.unpark}): ${a.blocker || `waiting for a free ${a.vendor} slot`}`;
      return `Queued: ${a.blocker || 'waiting for a free worker slot'}`;
    }
    case 'waiting': return `Waiting for its spec tests${a.depends_on ? ` from ${a.depends_on}` : ''}`;
    case 'spawning': return 'Starting its container';
    case 'working':
      if (a.status === 'gate: waiting for GPU') return 'Merge gate waiting for the GPU';
      if (pending) return pending;
      if (a.ci_note) return `Fixing a CI failure on ${pr || 'its PR'}`;
      if (t?.status && t.status !== 'pass') return `Working; last ${kind} ${t.status}${score}`;
      return a.role === 'tests' ? 'Writing the spec tests' : t?.status === 'pass' ? `Working; last ${kind} passed${score}` : 'Working on it';
    case 'done':
      if (a.status === 'gate: waiting for GPU') return 'Merge gate waiting for the GPU';
      if (a.gate === 'ci') return `${pr} open, waiting for CI to merge`;
      if (a.gate === 'tests' || a.gate === 'push') {
        if (pending) return pending;
        if (t?.purpose === 'gate' && t.status === 'pass') return a.gate === 'push' ? `Gate passed, pushing to ${a.base}` : pr ? `Gate passed, merging ${pr}` : `Ready to merge into ${a.base}`;
        if (t?.purpose === 'gate') return `Merge gate ${t.status}${score}; the delegator decides`;
      }
      if (a.gate === 'off') return pr ? `Gate off: ${pr} merging or ready to merge` : `Gate off: ready to merge into ${a.base}`;
      return pr ? `Done: ${pr} waiting for review` : 'Done: report sent to the delegator';
    case 'merged': return `Merged into ${a.base || 'base'}`;
    case 'closed': return `${pr || 'PR'} closed without merging`;
    case 'killed': return 'Killed';
    case 'handed-off': return 'Spec tests handed to the implementer';
    case 'exited':
      if (t?.purpose === 'gate' && t.status) return `Session exited; merge gate ${t.status === 'pass' ? 'passed' : t.status}${score}`;
      return a.report ? 'Session exited after reporting' : 'Session exited without reporting';
    case 'failed': return a.report ? `Failed: ${a.report}`.slice(0, 120) : 'Failed';
    default: return a.state;
  }
}

const ACTIONS = new Set(['answer', 'reply', 'pause', 'unpause', 'restart', 'kill', 'merge', 'delegator.set', 'gpu.pause', 'gpu.resume', 'test.run', 'models.prefer', 'satellite.revoke']);
const COOKIE = 'hl_dash';
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

/** The dashboard token (created on first use); `rotate` replaces it, logging every browser out. */
export function dashToken(db, { rotate = false } = {}) {
  let t = kvGet(db, 'dash:token');
  if (!t || rotate) { t = newToken(); kvSet(db, 'dash:token', t); }
  return t;
}

const same = (a, b) => {
  const x = createHash('sha256').update(String(a)).digest();
  const y = createHash('sha256').update(String(b)).digest();
  return timingSafeEqual(x, y);
};
const cookieOf = (req) => Object.fromEntries((req.headers.cookie || '').split(';').map(c => c.trim().split('=')).filter(p => p.length === 2))[COOKIE];
/** A hash of the page's files: a page that reconnects to a broker serving others reloads itself. */
const assetHash = () => readdirSync(WEB).sort().reduce((h, f) => h.update(f).update(readFileSync(join(WEB, f))), createHash('sha1')).digest('hex');

const isLoopback = (req) => ['127.0.0.1', '::ffff:127.0.0.1', '::1'].includes(req.socket.localAddress);

/** Replaces token/nonce values (and strings containing them) with •••. */
export function masker(db) {
  const secrets = [
    ...db.prepare('SELECT token FROM agents').all().map(r => r.token),
    ...db.prepare('SELECT nonce FROM asks WHERE nonce IS NOT NULL').all().map(r => r.nonce),
    kvGet(db, 'dash:token'),
  ].filter(s => s && s.length >= 8);
  return (v) => {
    if (typeof v !== 'string') return v;
    let out = v;
    for (const s of secrets) if (out.includes(s)) out = out.replaceAll(s, '•••');
    return out;
  };
}

/**
 * The `hauptling satellite join` line for "Add host": the hub URL is the address the browser used (the
 * `tailscale serve` name) unless that is loopback, which a satellite can't reach; then a placeholder.
 */
export function joinLine(headers, tok) {
  const name = String(headers['x-forwarded-host'] || headers.host || '').split(',')[0].trim();
  const bare = name.replace(/:\d+$/, '');
  const ok = /^[a-z0-9.-]+(:\d{1,5})?$/i.test(name) && !/^(localhost|127\.\d+\.\d+\.\d+|0\.0\.0\.0)$/i.test(bare);
  const proto = String(headers['x-forwarded-proto'] || '').split(',')[0].trim() || (bare.endsWith('.ts.net') ? 'https' : 'http');
  const hubUrl = ok ? `${proto === 'https' ? 'https' : 'http'}://${name}` : null;
  return { hubUrl, line: `hauptling satellite join ${hubUrl || '<hub-url>'} ${tok}` };
}

/** `hub`: on the hub, its satellites (src/hub.mjs), for the Hosts panel and the relayed terminal, diff and timeline. */
export function createDashboard({ db, dbPath, core, host, hub = null, updater = null, log = () => {}, slotDir = () => { throw new Error('no slots'); }, signinSlot = (slot) => slot, logins = () => [], report = {} }) {
  const terms = createTerminals({ db, host, slotDir, signinSlot, log, rpc: hub ? (name, op, args) => hub.rpc(name, op, args) : null, hold: core.holdSignin });
  const satellites = () => db.prepare('SELECT name, online, lost_at FROM hosts ORDER BY name').all();
  const offline = (e) => /is offline/.test(e.message);
  const json = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };
  const agentRow = (id) => db.prepare('SELECT * FROM agents WHERE id = ?').get(id);
  /** Scrubbed title and body for "Report an issue"; preview and send both come through here, so the preview is exactly what is sent. */
  async function reportBody(b) {
    const secrets = [...(report.secrets?.() || []), ...db.prepare('SELECT token FROM agents').all().map(r => r.token),
      ...db.prepare('SELECT nonce FROM asks WHERE nonce IS NOT NULL').all().map(r => r.nonce), kvGet(db, 'dash:token')];
    const include = b.include !== false;
    const facts = include ? await (report.facts || brokerFacts)(report.logPath) : {};
    const clean = (t) => scrubText(t, secrets);
    const client = b.client && typeof b.client === 'object' ? b.client : {};
    const repo = issueRepo(report.config?.(), await (report.origin || originUrl)());
    return {
      repo,
      title: clean(String(b.title || '').slice(0, 256)),
      body: clean(buildBody({ description: String(b.description || '').slice(0, 20000), include, client, facts })),
    };
  }
  const pub = ({ token: _t, brief: _b, ...a }) => a;

  // ---------- board snapshot ----------
  let gpuCache = { at: 0, value: null };
  async function gpu() {
    if (Date.now() - gpuCache.at > 10e3) gpuCache = { at: Date.now(), value: await core.call('gpu.status').catch(() => null) };
    return gpuCache.value;
  }

  // Host name and load: CPU % since the previous sample (summed over cores), memory % in use, GPU utilization %.
  // Sampled every 5 s from the first dashboard visit on; the last 10 min feed the header's graphs.
  const cpuTimes = () => cpus().reduce((t, c) => { const v = c.times; t.idle += v.idle; t.all += v.user + v.nice + v.sys + v.idle + v.irq; return t; }, { idle: 0, all: 0 });
  let cpuPrev = cpuTimes();
  const HIST = 120;
  const hist = { cpu: [], mem: [], gpu: [] };
  async function hostLoad() {
    const now = cpuTimes();
    const all = now.all - cpuPrev.all;
    const cpu = all > 0 ? Math.round(100 * (1 - (now.idle - cpuPrev.idle) / all)) : null;
    cpuPrev = now;
    const gpu = await host.gpuUtil?.().catch(() => null) ?? null;
    return { name: hostname(), cpu, mem: Math.round(100 * (1 - freemem() / totalmem())), gpu };
  }
  let sampler = null;
  let lastHost = '';
  async function sample() {
    const l = await hostLoad();
    for (const k of Object.keys(hist)) { hist[k].push(l[k]); if (hist[k].length > HIST) hist[k].shift(); }
    lastHost = JSON.stringify({ ...l, every_s: 5, hist });
    for (const res of clients) res.write(`event: host\ndata: ${lastHost}\n\n`);
  }
  function startSampler() {
    if (sampler) return;
    sampler = setInterval(() => sample().catch(e => log(`host sample: ${e.message}`)), 5000);
    sampler.unref?.();
    sample().catch(() => {});
  }

  /** Typical run time in seconds for a repo's CPU or GPU jobs with this selector: the median of the last 5 finished, or null. */
  function expectedSecs(repo, gpu, selector) {
    const d = db.prepare("SELECT report FROM tests WHERE repo = ? AND gpu = ? AND COALESCE(selector, '') = ? AND state = 'done' AND report IS NOT NULL ORDER BY done_at DESC LIMIT 5").all(repo, gpu ? 1 : 0, selector || '')
      .map(r => { try { const j = JSON.parse(r.report); return ['pass', 'fail'].includes(j.status) ? Number(j.duration_s) : NaN; } catch { return NaN; } })
      .filter(n => n > 0).sort((a, b) => a - b);
    return d.length ? Math.round(d[Math.floor(d.length / 2)]) : null;
  }
  /** Live fields for a running job: progress (step, latest line, results so far) and the typical run time. */
  const live = (t) => ({ claimed_at: t.claimed_at, progress: core.testProgress?.(t.id, t.claimed_at) ?? null, expect_s: expectedSecs(t.repo, t.gpu, t.selector) });

  /** CPU test queue for the header: running jobs and queued ids in line order (GPU jobs are in gpu.status). */
  function testQueue() {
    const running = db.prepare("SELECT t.id, t.agent, t.repo, t.selector, t.purpose, t.claimed_at, t.attempt, t.retry_note FROM tests t WHERE state = 'running' AND gpu = 0 ORDER BY claimed_at").all()
      .map(({ attempt, retry_note, ...r }) => ({ ...r, ...live({ ...r, gpu: 0 }), retry: retryLabel({ state: 'running', attempt, retry_note }) }));
    const queuedRows = db.prepare("SELECT id, agent, repo, purpose, attempt, retry_note FROM tests WHERE state = 'queued' AND gpu = 0 ORDER BY created_at, rowid").all();
    const retrying = queuedRows.filter(r => r.attempt > 1).map(({ attempt, retry_note, ...r }) => ({ ...r, retry: retryLabel({ state: 'queued', attempt, retry_note }) }));
    return { running, queued: queuedRows.length, retrying, limit: core.testScale?.().cpuLimit ?? Math.max(1, Number(host.testConcurrency?.() ?? 3) || 3), auto: Boolean(core.testScale?.().scaling), line: queuedRows.map(r => r.id) };
  }

  async function snapshot() {
    const tq = testQueue();
    const gpuLine = db.prepare("SELECT id FROM tests WHERE state = 'queued' AND gpu = 1 ORDER BY created_at, rowid").all().map(r => r.id);
    const since = new Date(Date.now() - 24 * 3600e3).toISOString();
    const rows = db.prepare(`SELECT * FROM agents WHERE state NOT IN (${ENDED.map(s => `'${s}'`).join(',')}) OR updated_at >= ? ORDER BY created_at`).all(since);
    // With satellites: agents on a host that is offline (or lost) say so instead of their last state.
    const sats = satellites();
    const down = new Map(sats.filter(h => !h.online).map(h => [h.name, h.lost_at ? 'lost' : 'offline']));
    // Place in the delegator's queue (hub only: satellites' queues aren't reordered).
    const places = new Map(), counts = new Map();
    for (const q of db.prepare(`SELECT id, delegator FROM agents WHERE host = 'hub' AND ${IN_QUEUE} ORDER BY ${QUEUE_ORDER}`).all()) {
      counts.set(q.delegator, (counts.get(q.delegator) || 0) + 1);
      places.set(q.id, counts.get(q.delegator));
    }
    const agents = rows.map(a => {
      const t = db.prepare('SELECT id, state, gpu, purpose, repo, selector, report, created_at, claimed_at, done_at, attempt, retry_note FROM tests WHERE agent = ? ORDER BY created_at DESC LIMIT 1').get(a.id);
      const r = t?.report ? JSON.parse(t.report) : null;
      const ask = db.prepare('SELECT id, question, choices, at FROM asks WHERE agent = ? AND answered_at IS NULL ORDER BY id DESC LIMIT 1').get(a.id);
      return {
        ...pub(a),
        queue: places.get(a.id) ?? null,
        aliases: db.prepare('SELECT old FROM aliases WHERE new = ?').all(a.id).map(r => r.old),
        ended: ENDED.includes(a.state),
        usage: a.usage ? JSON.parse(a.usage) : null,
        spend: a.usage_start != null && core.spend ? core.spend(a) : null,
        headroom: core.headroomNote?.(a) ?? null,
        blocker: core.blockerNote?.(a) ?? null,
        status: db.prepare('SELECT text FROM status WHERE identity = ?').get(a.id)?.text || null,
        test: t ? { id: t.id, state: t.state, gpu: Boolean(t.gpu), purpose: t.purpose, status: r?.status || null, passed: r?.passed ?? null, failed: r?.failed ?? null, at: t.done_at || t.created_at,
          position: t.state === 'queued' ? ((t.gpu ? gpuLine : tq.line).indexOf(t.id) + 1 || null) : null, retry: retryLabel(t),
          ...(t.state === 'running' ? live(t) : {}) } : null,
        ask: ask ? { id: ask.id, question: ask.question, choices: JSON.parse(ask.choices), at: ask.at } : null,
        ...(down.has(a.host) && HOST_LIVE.includes(a.state) ? { host_state: down.get(a.host) } : {}),
      };
    }).map(a => ({ ...a, headline: headline(a) }));
    const delegators = db.prepare(`
      SELECT id, repo, cli, gate, automerge, created_at, handoff IS NOT NULL AS handoff_waiting
      FROM delegators WHERE active = 1 ORDER BY created_at
    `).all().map(d => ({ ...d, gate: Boolean(d.gate), automerge: Boolean(d.automerge), handoff_waiting: Boolean(d.handoff_waiting) }));
    const { line: _l, ...tests } = tq;
    const g = await gpu();
    // GPU status is cached for 10 s; the running job's progress is read fresh.
    const gpuNow = g?.running ? { ...g, running: g.running.map(r => { const t = db.prepare('SELECT repo, selector FROM tests WHERE id = ?').get(r.id); return { ...r, ...live({ ...r, repo: t?.repo, selector: t?.selector, gpu: 1 }) }; }) } : g;
    const update = updater?.available();
    return { agents, delegators, gpu: gpuNow, tests, blocked: agents.filter(a => a.state === 'blocked').length,
      ...(update ? { update } : {}),
      ...(sats.length ? { hosts: [{ name: 'hub', online: true, lost: false }, ...sats.map(h => ({ name: h.name, online: Boolean(h.online), lost: Boolean(h.lost_at) }))] } : {}) };
  }

  // One ticker for all open streams; it only runs while someone is watching.
  const clients = new Set();
  // This broker process and the page it serves, told to every new stream.
  const hello = JSON.stringify({ boot: randomUUID(), assets: assetHash() });
  updater?.onChange((s) => { for (const res of clients) res.write(`event: update\ndata: ${JSON.stringify(s)}\n\n`); });
  let last = '';
  let timer = null;
  async function tick() {
    try {
      const body = JSON.stringify(await snapshot());
      if (body !== last) { last = body; for (const res of clients) res.write(`event: board\ndata: ${body}\n\n`); }
      else for (const res of clients) res.write(': ping\n\n');
    } catch (e) { log(`dashboard tick: ${e.message}`); }
  }
  function stream(req, res) {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
    res.write('retry: 3000\n\n');
    res.write(`event: hello\ndata: ${hello}\n\n`);
    clients.add(res);
    const progress = updater?.status();
    if (progress) res.write(`event: update\ndata: ${JSON.stringify(progress)}\n\n`);
    if (last) res.write(`event: board\ndata: ${last}\n\n`);
    if (lastHost) res.write(`event: host\ndata: ${lastHost}\n\n`);
    startSampler();
    if (!timer) { timer = setInterval(tick, 2000); timer.unref?.(); tick(); }
    req.on('close', () => { clients.delete(res); if (!clients.size) { clearInterval(timer); timer = null; last = ''; } });
  }

  // ---------- agent detail ----------
  async function diff(a) {
    if (a.host && a.host !== 'hub') {
      if (!hub) return { stat: '', files: [], note: `Runs on ${a.host}; its clone is there` };
      if (NO_SESSION.includes(a.state)) return { stat: '', files: [], note: `No clone (${a.state})` };
      try { return await hub.rpc(a.host, 'diff', { agent: a.id }); }
      catch (e) { return { stat: '', files: [], note: offline(e) ? `${a.host} is offline; the diff is on that host` : e.message }; }
    }
    if (!a.dir || !a.slot || NO_SESSION.includes(a.state)) return { stat: '', files: [], note: `No clone (${a.state})` };
    const g = async (args) => (await host.run(a.slot, ['git', '-C', a.dir, ...args], { timeout: 30e3 })).stdout;
    const base = await g(['merge-base', `origin/${a.base}`, 'HEAD']).then(s => s.trim(), () => `origin/${a.base}`);
    // base → working tree: committed and uncommitted changes together (untracked files listed separately).
    const [stat, patch, untracked] = await Promise.all([
      g(['diff', '--stat=120', base]), g(['diff', '--no-color', '--no-ext-diff', base]), g(['ls-files', '--others', '--exclude-standard']),
    ]);
    const files = [];
    for (const chunk of patch.split(/^(?=diff --git )/m).filter(Boolean)) {
      const m = /^diff --git a\/(.+?) b\/(.+)$/m.exec(chunk);
      files.push({ path: m ? m[2] : '?', patch: chunk.length > 200e3 ? `${chunk.slice(0, 200e3)}\n… (truncated)` : chunk });
      if (files.length >= 200) break;
    }
    return { base: base.slice(0, 12), stat, files, untracked: untracked.split('\n').filter(Boolean).slice(0, 100) };
  }

  function timeline(a) {
    const mask = masker(db);
    const items = [
      ...db.prepare('SELECT kind, text, at FROM events WHERE agent = ?').all(a.id).map(e => ({ at: e.at, kind: `event:${e.kind}`, text: e.text })),
      ...db.prepare('SELECT sender, recipient, text, at FROM mail WHERE recipient = ? OR sender = ?').all(a.id, a.id).map(m => ({ at: m.at, kind: 'mail', text: `${m.sender} → ${m.recipient}: ${m.text}` })),
      ...db.prepare('SELECT question, answer, at, answered_at FROM asks WHERE agent = ?').all(a.id).flatMap(q => [
        { at: q.at, kind: 'ask', text: q.question },
        ...(q.answered_at ? [{ at: q.answered_at, kind: 'answer', text: q.answer }] : []),
      ]),
      ...db.prepare('SELECT id, gpu, purpose, state, report, created_at FROM tests WHERE agent = ?').all(a.id).map(t => {
        const r = t.report ? JSON.parse(t.report) : null;
        return { at: t.created_at, kind: t.gpu ? 'test:gpu' : 'test', text: `${t.id} ${t.purpose} ${r ? `${r.status}: ${r.passed} passed, ${r.failed} failed${r.notes ? ` — ${r.notes}` : ''}` : t.state}`, test: t.id };
      }),
    ].map(i => ({ ...i, text: mask(i.text) }));
    return { items: items.sort((x, y) => (x.at < y.at ? 1 : -1)).slice(0, 500), report: a.report, brief: a.brief };
  }

  /** The Events pane: for a satellite agent, the hub's timeline plus the mail its host holds (not twice). */
  async function events(a) {
    const t = timeline(a);
    if (!a.host || a.host === 'hub' || !hub) return t;
    let theirs;
    try { theirs = (await hub.rpc(a.host, 'timeline', { agent: a.id }))?.items || []; }
    catch (e) { return { ...t, note: offline(e) ? `${a.host} is offline: mail kept on that host is not shown` : e.message }; }
    const mask = masker(db);
    const known = new Set(t.items.map(i => `${i.kind}\n${i.text}`));
    const more = theirs.filter(i => i && typeof i.text === 'string' && !known.has(`${i.kind}\n${mask(i.text)}`))
      .map(i => ({ at: String(i.at), kind: String(i.kind).slice(0, 20), text: mask(i.text.slice(0, 4000)), host: a.host }));
    return { ...t, items: [...t.items, ...more].sort((x, y) => (x.at < y.at ? 1 : -1)).slice(0, 500) };
  }

  /**
   * On a satellite: the hub's `rpc`s for one of this host's agents (terminal, diff, timeline). Never a login
   * session or another sid: only agent rows this broker has.
   */
  async function remote(op, { agent, since = null, sinceHistory = null, keys, size = null } = {}) {
    const a = typeof agent === 'string' && agentRow(agent);
    if (!a) throw new Error(`No agent ${agent} on this host`);
    if (op === 'term.screen') {
      const s = await terms.screen(a.id);
      const sha = (t) => createHash('sha1').update(t).digest('hex');
      const history = typeof s.history === 'string' ? s.history.slice(-HISTORY_MAX) : null;
      const historyHash = history === null ? null : sha(history);
      const hist = history !== null && historyHash !== sinceHistory ? { history, historyHash } : {};
      if (s.text == null) return { text: null, alive: s.alive, ...hist };
      const text = s.text.slice(0, SCREEN_MAX);
      const hash = sha(text);
      return hash === since ? { same: true, alive: s.alive, ...hist } : { text, hash, alive: s.alive, ...hist };
    }
    if (op === 'term.keys') return terms.relayKeys(a.id, keys);
    if (op === 'term.resize') return terms.relayResize(a.id, size);
    if (op === 'diff') {
      const d = await diff(a);
      let size = (d.stat?.length || 0) + 1000;
      const files = [];
      for (const f of d.files || []) { size += f.patch.length + f.path.length + 50; if (size > DIFF_MAX) break; files.push(f); }
      return files.length < (d.files?.length || 0) ? { ...d, files, truncated: `${d.files.length - files.length} more files not shown (too big to relay)` } : d;
    }
    if (op === 'timeline') return { items: timeline(a).items.filter(i => i.kind === 'mail') };
    throw new Error(`Unknown rpc ${op}`);
  }

  function history(q = '') {
    const like = `%${q}%`;
    return db.prepare(`SELECT * FROM agents WHERE state IN (${ENDED.map(s => `'${s}'`).join(',')})
      AND (id LIKE ? OR title LIKE ? OR repo LIKE ? OR branch LIKE ? OR IFNULL(report, '') LIKE ?) ORDER BY updated_at DESC LIMIT 200`).all(like, like, like, like, like).map(a => ({ ...pub(a), headline: headline(a) }));
  }

  // ---------- usage: vendors panel + spend ----------
  const VENDOR_LIST = ['claude', 'codex', 'agy'];
  async function usage() {
    await core.refreshUsage?.().catch(() => {});
    const slotNames = await core.call('slots.get');
    const all = logins(slotNames, VENDOR_LIST);
    const signedIn = new Map(all.map(l => [`${l.slot}:${l.vendor}`, l.ok]));
    const keyOf = new Map(all.filter(l => l.key).map(l => [l.vendor, l.key]));
    const rows = db.prepare('SELECT * FROM slot_usage ORDER BY at DESC').all();
    // A slot runs one worker per vendor: key by both, or a codex worker would hide the claude one on the same slot.
    const busy = new Map(db.prepare(`SELECT slot, id, vendor FROM agents WHERE slot IS NOT NULL AND host = 'hub' AND state IN ('spawning','restarting','paused','working','blocked','done') AND NOT ${HELD}`).all().map(r => [`${r.slot}:${r.vendor}`, r.id]));
    // One account per vendor (signed in on every slot, or one API key): the newest reading of each window, from any slot.
    const vendors = VENDOR_LIST.map(vendor => {
      const latest = new Map();
      for (const r of rows) if (r.vendor === vendor && !latest.has(r.window)) latest.set(r.window, { window: r.window, used_pct: r.used_pct, resets_at: r.resets_at, at: r.at, slot: r.slot });
      return {
        vendor,
        key: keyOf.get(vendor) || null,
        budget: core.budgetState?.(vendor) || null, // API first, then the plan: { usd, spent, stop_at, until, … }
        up_to: core.ceiling?.(vendor) || null, // the key pays for models up to this tier: { tier, name }
        out_of_credit: core.keyOut?.(vendor) || null, // the API refused the key: { at, until }
        limits: [...latest.values()],
        refresh: core.lastRefresh?.(vendor) || null, // the Refresh button's last result: { status, note, at }
        // One row per sign-in (PRD "Shared sign-ins"): the slot that holds it, busy while any slot using it runs a worker.
        signins: { count: Math.min(host.signins?.(vendor) ?? slotNames.length, slotNames.length), max: slotNames.length, adjustable: Boolean(host.setSignins) },
        slots: [...new Set(slotNames.map(s => signinSlot(s, vendor)))].map(slot => ({
          slot,
          serves: slotNames.filter(s => signinSlot(s, vendor) === slot),
          signed_in: Boolean(signedIn.get(`${slot}:${vendor}`)),
          busy: slotNames.filter(s => signinSlot(s, vendor) === slot).map(s => busy.get(`${s}:${vendor}`)).find(Boolean) || null,
          login: `hauptling login ${slot} ${vendor}`,
        })),
      };
    });
    // With satellites: their readings under each vendor (labelled by host), and the Hosts panel.
    const sats = hub && satellites().length ? hub.list() : [];
    if (sats.length) {
      for (const v of vendors) {
        v.hosts = sats.map(h => ({ host: h.name, online: h.online, limits: (Array.isArray(h.capabilities?.usage) ? h.capabilities.usage : [])
          .filter(l => l?.vendor === v.vendor && typeof l.used_pct === 'number').map(({ window, used_pct, resets_at, at }) => ({ window, used_pct, resets_at, at })) }))
          .filter(x => x.limits.length);
      }
    }
    return { vendors, spend: spend(), prefer: await core.call('models.prefer'), ...(sats.length ? { hosts: hostsPanel(sats) } : {}) };
  }

  /** The Hosts panel: each satellite's link state, sign-ins, free slots, GPU and live workers against its cap. */
  function hostsPanel(sats) {
    const live = db.prepare(`SELECT COUNT(*) n FROM agents WHERE host = ? AND slot IS NOT NULL AND state IN (${WORKER_LIVE.map(() => '?').join(',')}) AND NOT ${HELD}`);
    return sats.map(h => {
      const c = h.capabilities || {};
      return {
        name: h.name, online: h.online, revoked: h.revoked, lost: h.lost, lastSeen: h.lastSeen, offlineSince: h.offlineSince, joinedAt: h.joinedAt,
        vendors: c.vendors && typeof c.vendors === 'object' ? c.vendors : {}, free: c.free && typeof c.free === 'object' ? c.free : {},
        gpu: c.gpu ?? null, maxWorkers: c.maxWorkers ?? null, workers: live.get(h.name, ...WORKER_LIVE).n, pendingCommands: h.pendingCommands,
        revoke: `hauptling satellite revoke ${h.name}`,
      };
    });
  }

  /** Totals of agents' (final) usage per day, vendor and repo; API-equivalent where vendors don't report cost. */
  function spend(days = 30) {
    const since = new Date(Date.now() - days * 86400e3).toISOString();
    const rows = db.prepare('SELECT id, vendor, repo, created_at, usage FROM agents WHERE usage IS NOT NULL AND created_at >= ?').all(since);
    const add = (map, key, u) => {
      const t = map.get(key) || { key, agents: 0, cost_usd: 0, unknown: 0, estimated: 0, tokens_in: 0, tokens_out: 0 };
      t.agents++;
      if (u.cost_usd == null) t.unknown++; else { t.cost_usd += u.cost_usd; if (u.cost_estimated) t.estimated++; }
      t.tokens_in += u.tokens_in || 0;
      t.tokens_out += u.tokens_out || 0;
      map.set(key, t);
    };
    const byDay = new Map(); const byVendor = new Map(); const byRepo = new Map(); const total = new Map();
    for (const r of rows) {
      const u = JSON.parse(r.usage);
      add(byDay, r.created_at.slice(0, 10), u); add(byVendor, r.vendor, u); add(byRepo, r.repo, u); add(total, 'all', u);
    }
    const list = (m) => [...m.values()].map(t => ({ ...t, cost_usd: Math.round(t.cost_usd * 100) / 100 }));
    return { days, total: list(total)[0] || null, byDay: list(byDay).sort((a, b) => (a.key < b.key ? 1 : -1)), byVendor: list(byVendor), byRepo: list(byRepo).sort((a, b) => b.cost_usd - a.cost_usd) };
  }

  // ---------- web terminal ----------
  /**
   * SSE: this stream's `viewer` id (for `size`), a frame whenever the screen changes (polled ~5×/s while open), the
   * input state, and `end`.
   *
   * A satellite agent's screen comes over the link (`term.screen` with the last hash, so an unchanged screen costs
   * a few bytes), one request at a time, at most RELAY_MAX bytes per stream; polling stops when the browser closes.
   */
  function termStream(req, res, sid) {
    const first = terms.resolve(sid);
    const remote = first.kind === 'remote';
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
    res.write('retry: 2000\n\n');
    let lastText = null; let lastHash = null; let lastHistory = null; let lastHistoryHash = null; let lastInput = ''; let closed = false; let busy = false; let errors = 0; let relayed = 0; let away = false;
    const send = (ev, data) => res.write(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`);
    const viewer = randomUUID();
    terms.join(sid, viewer);
    send('viewer', { id: viewer });
    const step = async () => {
      if (closed) return;
      terms.sync(sid);
      if (busy) return;
      if (remote && res.writableLength > 1 << 20) return; // the browser is behind: skip, the next frame replaces this one
      busy = true;
      try {
        const s = await terms.screen(sid, lastHash, lastHistoryHash);
        if (closed) return;
        errors = 0;
        if (away) { away = false; send('note', { text: '' }); }
        if (s.text !== null && s.text !== lastText) {
          lastText = s.text; lastHash = s.hash ?? null;
          send('frame', { text: s.text });
          if (remote && (relayed += Buffer.byteLength(s.text)) > RELAY_MAX) { send('end', { reason: `relay limit reached (${RELAY_MAX >> 20} MB); reopen the terminal` }); stop(); return; }
        }
        if (typeof s.history === 'string' && s.history !== lastHistory) {
          lastHistory = s.history; lastHistoryHash = s.historyHash ?? null;
          send('history', { text: s.history });
          if (remote) relayed += Buffer.byteLength(s.history);
        }
        const inp = JSON.stringify(terms.inputState(sid));
        if (inp !== lastInput) { lastInput = inp; send('input', JSON.parse(inp)); }
        if (!s.alive) {
          if (sid.startsWith('login-')) {
            await terms.stopLogin(sid);
            const m = /^login-(.+)-(claude|codex|agy)$/.exec(sid);
            send('end', { reason: 'sign-in finished', signed_in: Boolean(logins([m[1]], [m[2]])[0]?.ok) });
          } else send('end', { reason: 'session exited' });
          stop();
        }
      } catch (e) {
        if (closed) return;
        if (remote && offline(e)) { if (!away) { away = true; send('note', { text: `${first.host} is offline; waiting for it to reconnect` }); } return; }
        if (++errors >= 5) { send('end', { reason: e.message }); stop(); }
      } finally { busy = false; }
    };
    const timer = setInterval(step, remote ? 250 : 200);
    timer.unref?.();
    const quit = () => { closed = true; clearInterval(timer); terms.leave(sid, viewer); };
    const stop = () => { quit(); res.end(); };
    req.on('close', quit);
    step();
  }

  // ---------- SQLite explorer ----------
  const tables = () => db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()
    .map(t => ({ name: t.name, rows: db.prepare(`SELECT COUNT(*) n FROM "${t.name}"`).get().n, columns: db.prepare(`PRAGMA table_info("${t.name}")`).all().map(c => c.name) }));

  function table({ name, offset = 0, limit = 100, sort, dir = 'asc', filter = '' }) {
    const t = tables().find(x => x.name === name);
    if (!t) throw new Error(`No table ${name}`);
    const where = filter ? `WHERE ${t.columns.map(c => `CAST("${c}" AS TEXT) LIKE ?`).join(' OR ')}` : '';
    const args = filter ? t.columns.map(() => `%${filter}%`) : [];
    const order = t.columns.includes(sort) ? `ORDER BY "${sort}" ${dir === 'desc' ? 'DESC' : 'ASC'}` : 'ORDER BY rowid';
    const n = Math.min(Math.max(Number(limit) || 100, 1), 500);
    const total = db.prepare(`SELECT COUNT(*) n FROM "${name}" ${where}`).get(...args).n;
    const mask = masker(db);
    const rows = db.prepare(`SELECT * FROM "${name}" ${where} ${order} LIMIT ? OFFSET ?`).all(...args, n, Math.max(Number(offset) || 0, 0));
    return { name, columns: t.columns, total, offset: Number(offset) || 0, rows: rows.map(r => t.columns.map(c => mask(r[c]))) };
  }

  async function query(sql) {
    const r = await readOnlyQuery(dbPath, String(sql || ''));
    const mask = masker(db);
    return { ...r, rows: r.rows.map(row => row.map(v => (typeof v === 'bigint' ? String(v) : mask(v)))) };
  }

  // ---------- HTTP ----------
  function serveFile(res, rel) {
    const p = normalize(join(WEB, rel));
    if (!p.startsWith(WEB) || !existsSync(p)) return json(res, 404, { error: 'Not found' });
    res.writeHead(200, { 'content-type': TYPES[p.slice(p.lastIndexOf('.'))] || 'application/octet-stream', 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff' });
    res.end(readFileSync(p));
  }

  const SIGN_IN = `<!doctype html><meta charset="utf-8"><title>Hauptling</title><style>body{font:16px system-ui;max-width:36rem;margin:4rem auto;padding:0 1rem}</style>
<h1>Hauptling dashboard</h1><p>Not signed in. Run <code>hauptling dashboard</code> in a terminal on this machine: it opens this page with a sign-in link.</p>`;

  async function readBody(req, max = 64e3) {
    let raw = '';
    for await (const c of req) { raw += c; if (raw.length > max) throw new Error('Body too large'); }
    return raw ? JSON.parse(raw) : {};
  }

  /** Handles dashboard routes; returns false for anything else. */
  async function handle(req, res, url) {
    const p = url.pathname;
    if (!(p === '/' || p.startsWith('/web/') || p.startsWith('/dash/'))) return false;
    if (!isLoopback(req)) { json(res, 403, { error: 'The dashboard is only served on 127.0.0.1' }); return true; }
    const tok = dashToken(db);
    if (p === '/' && url.searchParams.get('k')) {
      if (!same(url.searchParams.get('k'), tok)) { res.writeHead(401, { 'content-type': 'text/html; charset=utf-8' }); res.end(SIGN_IN.replace('Not signed in.', 'That sign-in link is old or wrong.')); return true; }
      res.writeHead(302, { location: '/', 'set-cookie': `${COOKIE}=${tok}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000`, 'cache-control': 'no-store' });
      res.end();
      return true;
    }
    const c = cookieOf(req);
    if (!c || !same(c, tok)) {
      if (p === '/') { res.writeHead(401, { 'content-type': 'text/html; charset=utf-8' }); res.end(SIGN_IN); }
      else json(res, 401, { error: 'Not signed in: run `hauptling dashboard`' });
      return true;
    }
    try {
      if (req.method === 'GET') {
        if (p === '/') { serveFile(res, 'index.html'); return true; }
        if (p.startsWith('/web/')) { serveFile(res, p.slice(5)); return true; }
        if (p === '/dash/stream') { stream(req, res); return true; }
        if (p === '/dash/board') { json(res, 200, await snapshot()); return true; }
        if (p === '/dash/history') { json(res, 200, history(url.searchParams.get('q') || '')); return true; }
        if (p === '/dash/usage') { json(res, 200, await usage()); return true; }
        const ts = /^\/dash\/term\/([\w.-]+)\/stream$/.exec(p);
        if (ts) { try { termStream(req, res, ts[1]); } catch (e) { json(res, 404, { error: e.message }); } return true; }
        if (p === '/dash/db/tables') { json(res, 200, tables()); return true; }
        if (p === '/dash/db/table') { json(res, 200, table(Object.fromEntries(url.searchParams))); return true; }
        const m = /^\/dash\/agent\/([\w.-]+)\/(diff|events|screen)$/.exec(p);
        if (m) {
          const a = agentRow(m[1]);
          if (!a) { json(res, 404, { error: `No agent ${m[1]}` }); return true; }
          // screen: the last screen saved when a worker was parked (PRD "Parking").
          json(res, 200, m[2] === 'diff' ? await diff(a) : m[2] === 'events' ? await events(a) : { text: kvGet(db, `screen:${a.id}`) ?? null });
          return true;
        }
      }
      if (req.method === 'POST') {
        // Custom header: a cross-site form can't set it, and fetch() from another origin would need CORS we never grant.
        if (req.headers['x-hauptling'] !== '1') { json(res, 403, { error: 'Missing X-Hauptling header' }); return true; }
        const origin = req.headers.origin;
        if (origin && new URL(origin).host !== req.headers.host) { json(res, 403, { error: 'Cross-origin request' }); return true; }
        const body = await readBody(req, p === '/dash/report/send' ? 8e6 : 64e3);
        if (p === '/dash/db/query') { json(res, 200, await query(body.sql)); return true; }
        if (p === '/dash/usage/refresh') {
          const r = await core.call('usage.refresh');
          tick();
          json(res, 200, r);
          return true;
        }
        if (updater && p === '/dash/update/check') { json(res, 200, await updater.check()); tick(); return true; }
        if (updater && p === '/dash/update/apply') {
          const { run, ...r } = await updater.start();
          json(res, run ? 202 : 200, r);
          run?.(); // after the response: it ends with this broker restarting
          return true;
        }
        if (p === '/dash/signins') { json(res, 200, await core.call('signin.count', { vendor: body.vendor, n: body.n })); return true; }
        if (p === '/dash/signout') { json(res, 200, await core.call('signin.out', { slot: body.slot, vendor: body.vendor })); return true; }
        if (p === '/dash/term/login') { json(res, 200, await terms.startLogin(body.slot, body.vendor)); return true; }
        if (p === '/dash/hosts/token') {
          if (!hub) throw new Error('This broker is a satellite: add hosts on the hub');
          const t = await core.call('hub.token');
          json(res, 200, { ...t, ...joinLine(req.headers, t.token) });
          return true;
        }
        const tp = /^\/dash\/term\/([\w.-]+)\/(input|keys|size|stop)$/.exec(p);
        if (tp) {
          const [, sid, what] = tp;
          const r = what === 'input' ? terms.input(sid, Boolean(body.on)) : what === 'keys' ? await terms.keys(sid, body.keys) : what === 'size' ? void terms.resize(sid, String(body.viewer), body.size ?? null) : await terms.stopLogin(sid);
          json(res, 200, r ?? { ok: true });
          return true;
        }
        if (p === '/dash/report/preview' || p === '/dash/report/send') {
          const b = await reportBody(body);
          if (p.endsWith('preview')) { json(res, 200, b); return true; }
          if (!String(body.title || '').trim()) throw new Error('Title is required');
          if (body.screenshot) checkImage(body.screenshot); // reject a bad image before anything is filed
          const r = await fileIssue({ gh: report.gh, repo: b.repo, title: b.title, body: b.body, screenshot: body.screenshot });
          json(res, 200, typeof r === 'string' ? { ok: true, url: r } : { ok: true, ...r });
          return true;
        }
        const mv = /^\/dash\/agents\/([\w.-]+)\/move$/.exec(p);
        if (mv) {
          const { before, after, top, bottom } = body;
          const result = await core.call('queue.move', { agent: mv[1], before, after, top, bottom });
          tick();
          json(res, 200, { ok: true, result });
          return true;
        }
        const m = /^\/dash\/do\/([\w.]+)$/.exec(p);
        if (m && ACTIONS.has(m[1])) {
          const result = await core.call(m[1], body);
          gpuCache.at = 0;
          tick();
          json(res, 200, { ok: true, result: result ?? null });
          return true;
        }
      }
      json(res, 404, { error: 'Not found' });
    } catch (e) {
      log(`dashboard ${p}: ${e.message}`);
      json(res, e.status || 400, { error: e.message });
    }
    return true;
  }

  return { handle, snapshot, hostLoad, table, query, timeline, events, history, usage, spend, terms, remote };
}
