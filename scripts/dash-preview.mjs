#!/usr/bin/env node
// Serves web/dashboard with fake data, for looking at layout changes without a broker.
//   node scripts/dash-preview.mjs                 → http://127.0.0.1:8411/ (Ctrl-C to stop)
//   node scripts/dash-preview.mjs --shots DIR     → screenshots of every view at several sizes, then exits.
// Screenshots use headless Edge or Chromium: $BROWSER, else msedge.exe (WSL) or chromium on PATH.
// The fake event stream sends its data and closes (retry: 1 h), so --virtual-time-budget doesn't hang.
import { createServer } from 'node:http';
import { readFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, normalize, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const WEB = fileURLToPath(new URL('../web/dashboard/', import.meta.url));
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
const ago = (min) => new Date(Date.now() - min * 60e3).toISOString();
const STATES = ['working', 'blocked', 'working', 'done', 'waiting', 'working', 'queued', 'exited'];
const TITLES = ['Dashboard: resizable panes, hideable header, any aspect ratio', 'Fix the egress proxy race when two workers start at once',
  'GPU queue: pause --now requeues the running job', 'Per-vendor usage chips in the header', 'Port the mailbox to hauptling mail',
  'CodeGraph index cache across clones', 'Retry flaky CI on the GPU runner once', 'API budget: stop new API spawns at the limit'];

function agent(i, delegator, repo) {
  const st = STATES[i % STATES.length];
  return {
    id: `claude_opus-5-5_${(0xe9583 + i * 7919).toString(16).slice(0, 5)}`, vendor: i % 3 ? 'claude' : 'codex', model: i % 3 ? 'claude-opus-5-5' : 'gpt-5.5-codex',
    state: st, ended: false, title: TITLES[i % TITLES.length], headline: i % 2 ? `Step ${i}: ${TITLES[(i + 3) % TITLES.length].toLowerCase()}` : null,
    repo, delegator, branch: `hl/agent_${i}`, base: 'main', slot: `hl-w${(i % 3) + 1}`, created_at: ago(5 + i * 17), updated_at: ago(i),
    pr_url: i % 2 ? `https://github.com/example/${repo.split('/').pop()}/pull/${40 + i}` : null, pr_number: 40 + i,
    test: i % 4 === 0 ? { id: `t${i}`, status: i % 8 ? 'pass' : 'fail', passed: 54, failed: i % 8 ? 0 : 2, purpose: 'gate', at: ago(3) } : null,
    usage: { context_pct: 20 + i * 9, cost_usd: 0.4 + i * 1.3, tokens_in: 120e3 * (i + 1), tokens_out: 9e3 * (i + 1) },
    ask: st === 'blocked' ? { id: 1, question: 'Store the split per orientation or once for both?', choices: ['Per orientation', 'Once'] } : null,
    report: st === 'done' ? 'Splitters, hideable header and stacked layout; 54 tests pass.' : null,
  };
}
const agents = [
  ...[0, 1, 2, 3, 4].map(i => agent(i, 'claude_opus-5-5_d72c0', '/home/me/hauptling')),
  ...[5, 6, 7].map(i => agent(i, 'codex_gpt-5_a11b2', 'example/nullpunkt')),
  ...[8, 9].map(i => ({ ...agent(i, 'claude_opus-5-5_d72c0', '/home/me/hauptling'), state: 'merged', ended: true })),
];
const wave = (n, f) => Array.from({ length: n }, (_, i) => Math.round(f(i)));
const board = { agents, delegators: [], blocked: 1, gpu: { available: true, paused: false, freeMB: 6210, running: [{ id: 'g12', agent: agents[0].id }], queued: [{ id: 'g13', waiting_since: ago(1) }] } };
const host = { cpu: 37, mem: 61, gpu: 88, every_s: 5, hist: { cpu: wave(120, i => 30 + 20 * Math.sin(i / 9)), mem: wave(120, i => 55 + i / 20), gpu: wave(120, i => (i % 40 < 25 ? 90 : 5)) } };
const vendor = (v, l5, lw, extra = {}) => ({ vendor: v, key: null, limits: [{ window: '5h', used_pct: l5, resets_at: ago(-90) }, { window: '7d', used_pct: lw, resets_at: ago(-3000) }],
  slots: ['hl-w1', 'hl-w2', 'hl-w3'].map((s, i) => ({ slot: s, signed_in: i < 3, busy: i === 0 ? agents[0].id : null, login: `${v} login` })), ...extra });
const row = (key, n) => ({ key, agents: n, cost_usd: n * 2.37, unknown: 0, estimated: 0, tokens_in: n * 310e3, tokens_out: n * 21e3 });
const usage = {
  vendors: [vendor('claude', 42, 71, { key: 'sk-…a1', budget: { usd: 100, spent: 38.2, stop_at: 95, until: ago(-20 * 1440) } }), vendor('codex', 93, 40), vendor('agy', 12, 8)],
  spend: { total: row('total', 31), byVendor: [row('claude', 22), row('codex', 9)], byRepo: [row('/home/me/hauptling', 25), row('example/nullpunkt', 6)], byDay: [0, 1, 2, 3].map(d => row(ago(d * 1440).slice(0, 10), 8 - d)) },
};
const tables = ['agents', 'events', 'tests', 'gpu_jobs', 'mail', 'usage', 'keys'].map((name, i) => ({ name, rows: (i + 1) * 37 }));
const screen = { text: Array.from({ length: 40 }, (_, i) => `✓ step ${i}: ${TITLES[i % TITLES.length]}`).join('\n') };

const json = (res, body) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://x'), p = url.pathname;
  if (p === '/' || p.startsWith('/web/')) {
    const f = normalize(join(WEB, p === '/' ? 'index.html' : p.slice(5)));
    if (!f.startsWith(WEB) || !existsSync(f)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': TYPES[f.slice(f.lastIndexOf('.'))] || 'application/octet-stream' });
    return res.end(readFileSync(f));
  }
  if (p === '/dash/stream') {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    return res.end(`retry: 3600000\n\nevent: board\ndata: ${JSON.stringify(board)}\n\nevent: host\ndata: ${JSON.stringify(host)}\n\n`);
  }
  if (p === '/dash/board') return json(res, board);
  if (p === '/dash/usage') return json(res, usage);
  if (p === '/dash/history') return json(res, agents.map(a => ({ ...a, state: 'merged', report: 'Merged after review.' })));
  if (p === '/dash/db/tables') return json(res, tables);
  if (p === '/dash/db/table') return json(res, { name: url.searchParams.get('name'), offset: 0, total: 3, columns: ['id', 'state', 'repo', 'title'], rows: agents.slice(0, 3).map(a => [a.id, a.state, a.repo, a.title]) });
  const m = /^\/dash\/agent\/[\w.-]+\/(screen|diff|events)$/.exec(p);
  if (m) return json(res, m[1] === 'screen' ? screen : m[1] === 'diff' ? { stat: '', patch: '' } : { events: [] });
  res.writeHead(404, { 'content-type': 'application/json' }); res.end('{"error":"not in the preview"}');
});

const args = process.argv.slice(2);
const shots = args.includes('--shots') ? resolve(args[args.indexOf('--shots') + 1] || 'shots') : null;
const port = shots ? 0 : Number(process.env.PORT || 8411);
server.listen(port, '127.0.0.1', async () => {
  const base = `http://127.0.0.1:${server.address().port}/`;
  if (!shots) { console.log(`Dashboard preview on ${base}`); return; }
  const edge = '/mnt/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
  const browser = process.env.BROWSER || (existsSync(edge) ? edge : 'chromium');
  const win = browser.endsWith('.exe'); // Windows Edge from WSL: paths must be Windows paths
  const winPath = (f) => (win ? execFileSync('wslpath', ['-w', f]).toString().trim() : f);
  mkdirSync(shots, { recursive: true });
  const sizes = [[390, 844], [768, 1024], [1366, 768], [1920, 1080], [3440, 1440]];
  const views = { board: `#agent=${agents[1].id}`, history: '#history', db: '#db', usage: '#usage' };
  for (const [w, h] of sizes) {
    for (const [name, hash] of Object.entries(views)) {
      const profile = mkdtempSync(join(win ? shots : tmpdir(), '.profile-'));
      const out = join(shots, `${name}-${w}x${h}.png`);
      try {
        await promisify(execFile)(browser, ['--headless', '--disable-gpu', '--hide-scrollbars', `--user-data-dir=${winPath(profile)}`, `--window-size=${w},${h}`,
          '--virtual-time-budget=3000', `--screenshot=${winPath(out)}`, base + hash], { timeout: 60e3 });
        console.log(out);
      } catch (e) { console.error(`${name} ${w}x${h}: ${e.message}`); }
      finally { rmSync(profile, { recursive: true, force: true }); }
    }
  }
  server.close();
});
