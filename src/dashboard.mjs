import { createHash, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, normalize } from 'node:path';
import { cpus, freemem, totalmem } from 'node:os';
import { fileURLToPath } from 'node:url';
import { kvGet, kvSet } from './db.mjs';
import { readOnlyQuery } from './dbquery.mjs';
import { createTerminals } from './terminal.mjs';
import { token as newToken } from './util.mjs';

/*
 * Dashboard (phase 4a), served by the broker:
 *   GET  /?k=<token>        swaps the dashboard token for an HttpOnly SameSite=Strict cookie
 *   GET  /, /web/*          the static page (web/dashboard)
 *   GET  /dash/stream       Server-Sent Events: a board snapshot whenever it changes
 *   GET  /dash/agent/<id>/screen|diff|events, /dash/history, /dash/db/tables, /dash/db/table
 *   POST /dash/db/query     ad-hoc read-only SQL
 *   POST /dash/do/<call>    actions (answer, reply, kill, merge, gpu.*), need `X-Hauptling: 1`
 * Only requests to 127.0.0.1 are served (containers reach the broker on docker0 through the
 * egress relay and get 403). Token and nonce values are masked in everything the explorer shows.
 */

const WEB = fileURLToPath(new URL('../web/dashboard/', import.meta.url));
const ENDED = ['merged', 'killed', 'closed', 'handed-off'];
const NO_SESSION = [...ENDED, 'failed', 'queued', 'waiting'];
/**
 * One plain sentence for the human watching the board: what the agent is doing or waiting on now.
 * `a` is a board row (agent columns plus `status`, `test` and `ask` as the snapshot builds them).
 */
export function headline(a) {
  const t = a.test;
  const pr = a.pr_number ? `PR #${a.pr_number}` : null;
  const total = (t?.passed ?? 0) + (t?.failed ?? 0);
  const score = t?.status && total ? ` (${t.passed ?? 0}/${total})` : '';
  const kind = t ? `${t.gpu ? 'GPU ' : ''}${t.purpose === 'gate' ? 'merge gate' : 'tests'}` : 'tests';
  const pending = t && !t.status ? (t.state === 'running' ? `Running ${kind}` : `Waiting to run ${kind}`) : null;
  const why = (a.status || '').replace(/^[a-z-]+:\s*/, '');
  switch (a.state) {
    case 'blocked': return a.ask ? `Needs your answer: ${a.ask.question}` : `Stuck${why ? `: ${why}` : ''}; attach or message it`;
    case 'queued': return 'Queued: waiting for a free worker slot';
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

const ACTIONS = new Set(['answer', 'reply', 'kill', 'merge', 'gpu.pause', 'gpu.resume']);
const COOKIE = 'hl_dash';
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1b[@-Z\\-_]/g;

export const stripAnsi = (s) => String(s).replace(ANSI, '').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');

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

export function createDashboard({ db, dbPath, core, host, log = () => {}, slotDir = () => { throw new Error('no slots'); }, logins = () => [] }) {
  const terms = createTerminals({ db, host, slotDir, log });
  const json = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };
  const agentRow = (id) => db.prepare('SELECT * FROM agents WHERE id = ?').get(id);
  const pub = ({ token: _t, brief: _b, ...a }) => a;

  // ---------- board snapshot ----------
  let gpuCache = { at: 0, value: null };
  async function gpu() {
    if (Date.now() - gpuCache.at > 10e3) gpuCache = { at: Date.now(), value: await core.call('gpu.status').catch(() => null) };
    return gpuCache.value;
  }

  // Host load: CPU % since the previous sample (summed over cores), memory % in use, GPU utilization %.
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
    return { cpu, mem: Math.round(100 * (1 - freemem() / totalmem())), gpu };
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

  async function snapshot() {
    const since = new Date(Date.now() - 24 * 3600e3).toISOString();
    const rows = db.prepare(`SELECT * FROM agents WHERE state NOT IN (${ENDED.map(s => `'${s}'`).join(',')}) OR updated_at >= ? ORDER BY created_at`).all(since);
    const agents = rows.map(a => {
      const t = db.prepare('SELECT id, state, gpu, purpose, report, created_at, done_at FROM tests WHERE agent = ? ORDER BY created_at DESC LIMIT 1').get(a.id);
      const r = t?.report ? JSON.parse(t.report) : null;
      const ask = db.prepare('SELECT id, question, choices, at FROM asks WHERE agent = ? AND answered_at IS NULL ORDER BY id DESC LIMIT 1').get(a.id);
      return {
        ...pub(a),
        ended: ENDED.includes(a.state),
        usage: a.usage ? JSON.parse(a.usage) : null,
        status: db.prepare('SELECT text FROM status WHERE identity = ?').get(a.id)?.text || null,
        test: t ? { id: t.id, state: t.state, gpu: Boolean(t.gpu), purpose: t.purpose, status: r?.status || null, passed: r?.passed ?? null, failed: r?.failed ?? null, at: t.done_at || t.created_at } : null,
        ask: ask ? { id: ask.id, question: ask.question, choices: JSON.parse(ask.choices), at: ask.at } : null,
      };
    }).map(a => ({ ...a, headline: headline(a) }));
    const delegators = db.prepare('SELECT id, cli, repo, active, created_at FROM delegators ORDER BY created_at').all();
    return { agents, delegators, gpu: await gpu(), blocked: agents.filter(a => a.state === 'blocked').length };
  }

  // One ticker for all open streams; it only runs while someone is watching.
  const clients = new Set();
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
    clients.add(res);
    if (last) res.write(`event: board\ndata: ${last}\n\n`);
    if (lastHost) res.write(`event: host\ndata: ${lastHost}\n\n`);
    startSampler();
    if (!timer) { timer = setInterval(tick, 2000); timer.unref?.(); tick(); }
    req.on('close', () => { clients.delete(res); if (!clients.size) { clearInterval(timer); timer = null; last = ''; } });
  }

  // ---------- agent detail ----------
  const lastScreen = new Map(); // agent id → last text captured, shown once the container is gone
  async function screen(a) {
    const gone = (note) => ({ text: lastScreen.get(a.id) || '', note, ended: true });
    if (!a.slot || NO_SESSION.includes(a.state)) return gone(`No live session (${a.state})`);
    let raw;
    try { raw = await host.tmuxCapture(a.slot, a.id, 300); } catch (e) {
      if (/No such container|is not running/i.test(e.message)) return gone('Agent has ended (its container is gone)');
      throw new Error(`capture failed: ${e.message}`);
    }
    const text = stripAnsi(raw).replace(/\s+$/, '');
    lastScreen.set(a.id, text);
    if (lastScreen.size > 50) lastScreen.delete(lastScreen.keys().next().value);
    return { text };
  }

  async function diff(a) {
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
    const busy = new Map(db.prepare("SELECT slot, id, vendor FROM agents WHERE slot IS NOT NULL AND state IN ('spawning','working','blocked','done')").all().map(r => [r.slot, r]));
    // One account per vendor (signed in on every slot, or one API key): the newest reading of each window, from any slot.
    const vendors = VENDOR_LIST.map(vendor => {
      const latest = new Map();
      for (const r of rows) if (r.vendor === vendor && !latest.has(r.window)) latest.set(r.window, { window: r.window, used_pct: r.used_pct, resets_at: r.resets_at, at: r.at, slot: r.slot });
      return {
        vendor,
        key: keyOf.get(vendor) || null,
        budget: core.budgetState?.(vendor) || null, // API first, then the plan: { usd, spent, stop_at, until, … }
        limits: [...latest.values()],
        slots: slotNames.map(slot => ({
          slot,
          signed_in: Boolean(signedIn.get(`${slot}:${vendor}`)),
          busy: busy.get(slot)?.vendor === vendor ? busy.get(slot).id : null,
          login: `hauptling login ${slot} ${vendor}`,
        })),
      };
    });
    return { vendors, spend: spend() };
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
  /** SSE: a frame whenever the screen changes (polled ~5×/s while open), the input state, and `end`. */
  function termStream(req, res, sid) {
    terms.resolve(sid);
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
    res.write('retry: 2000\n\n');
    let lastText = null; let lastInput = ''; let closed = false; let busy = false; let errors = 0;
    const send = (ev, data) => res.write(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`);
    const step = async () => {
      if (closed || busy) return;
      busy = true;
      try {
        const s = await terms.screen(sid);
        errors = 0;
        if (s.text !== lastText) { lastText = s.text; send('frame', { text: s.text }); }
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
        if (++errors >= 5) { send('end', { reason: e.message }); stop(); }
      } finally { busy = false; }
    };
    const timer = setInterval(step, 200);
    timer.unref?.();
    const stop = () => { closed = true; clearInterval(timer); res.end(); };
    req.on('close', () => { closed = true; clearInterval(timer); });
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

  async function readBody(req) {
    let raw = '';
    for await (const c of req) { raw += c; if (raw.length > 64e3) throw new Error('Body too large'); }
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
        const m = /^\/dash\/agent\/([\w.-]+)\/(screen|diff|events)$/.exec(p);
        if (m) {
          const a = agentRow(m[1]);
          if (!a) { json(res, 404, { error: `No agent ${m[1]}` }); return true; }
          json(res, 200, m[2] === 'screen' ? await screen(a) : m[2] === 'diff' ? await diff(a) : timeline(a));
          return true;
        }
      }
      if (req.method === 'POST') {
        // Custom header: a cross-site form can't set it, and fetch() from another origin would need CORS we never grant.
        if (req.headers['x-hauptling'] !== '1') { json(res, 403, { error: 'Missing X-Hauptling header' }); return true; }
        const origin = req.headers.origin;
        if (origin && new URL(origin).host !== req.headers.host) { json(res, 403, { error: 'Cross-origin request' }); return true; }
        const body = await readBody(req);
        if (p === '/dash/db/query') { json(res, 200, await query(body.sql)); return true; }
        if (p === '/dash/term/login') { json(res, 200, await terms.startLogin(body.slot, body.vendor)); return true; }
        const tp = /^\/dash\/term\/([\w.-]+)\/(input|keys|stop)$/.exec(p);
        if (tp) {
          const [, sid, what] = tp;
          const r = what === 'input' ? terms.input(sid, Boolean(body.on)) : what === 'keys' ? await terms.keys(sid, body.keys) : await terms.stopLogin(sid);
          json(res, 200, r ?? { ok: true });
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
      json(res, 400, { error: e.message });
    }
    return true;
  }

  return { handle, snapshot, hostLoad, table, query, timeline, history, usage, spend, terms };
}
