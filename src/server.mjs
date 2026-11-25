import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { writeFileSync, appendFileSync, mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { brokerFile, readBrokerFile } from './brokerfile.mjs';
import { openDb } from './db.mjs';
import { createCore } from './core.mjs';
import { createDashboard } from './dashboard.mjs';
import { platform } from './platform/index.mjs';
import { dockerHost, slotDir, WORKER_BROKER_URL } from './docker.mjs';
import { logins } from './setup.mjs';
import { networkInterfaces } from 'node:os';
import * as github from './github.mjs';
import { BROKER_PORT, home, token } from './util.mjs';

const hostGit = (repo, args) => new Promise((resolve, reject) => {
  execFile('git', ['-C', repo, ...args], { timeout: 120e3 }, (err, stdout, stderr) => {
    if (err) reject(new Error(`git ${args[0]}: ${(stderr || err.message).trim()}`)); else resolve(stdout.trim());
  });
});

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const page = (title, body) => `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${esc(title)}</title>
<style>body{font:16px system-ui,sans-serif;max-width:40rem;margin:3rem auto;padding:0 1rem;color:#222}button{font:inherit;padding:.5rem 1rem;margin:.25rem .5rem .25rem 0;cursor:pointer}
textarea{width:100%;font:inherit;min-height:5rem}.agent{color:#666;font-size:.9rem}footer{margin-top:3rem;font-size:.9rem}</style>${body}<footer><a href="/">Open dashboard</a></footer>`;

/** The answer page: choices as buttons plus a free-text reply. Guarded by the ask's nonce. */
async function answerPage(core, req, res, url) {
  const id = url.pathname.split('/')[2];
  let params = url.searchParams;
  if (req.method === 'POST') {
    let raw = '';
    for await (const c of req) { raw += c; if (raw.length > 8192) break; }
    params = new URLSearchParams(raw);
  }
  const nonce = params.get('k') || url.searchParams.get('k');
  const q = core.askForPage(id, nonce);
  const html = (code, body) => { res.writeHead(code, { 'content-type': 'text/html; charset=utf-8' }); res.end(body); };
  if (!q) return html(404, page('Not found', '<p>No such question (or the link is wrong).</p>'));
  if (q.answer) return html(200, page('Answered', `<p class="agent">${esc(q.agent)}</p><h2>${esc(q.question)}</h2><p>Answered: <b>${esc(q.answer)}</b></p>`));
  const choice = params.get('choice');
  const text = params.get('text')?.trim();
  if (choice !== null || text) {
    const r = await core.answer({ ask: q.id, ...(text ? { text: text.slice(0, 250) } : { choice: Number(choice) }) });
    return html(200, page('Answered', `<p class="agent">${esc(q.agent)}</p><h2>${esc(q.question)}</h2><p>Sent: <b>${esc(r.answered ?? r.already)}</b>. You can close this tab.</p>`));
  }
  const k = esc(nonce);
  const buttons = q.choices.map((c, i) => `<button name="choice" value="${i}">${esc(c)}</button>`).join('');
  return html(200, page(q.question, `<p class="agent">${esc(q.agent)} asks</p><h2>${esc(q.question)}</h2>
<form method="post"><input type="hidden" name="k" value="${k}">${buttons}</form>
<form method="post"><input type="hidden" name="k" value="${k}"><p><textarea name="text" maxlength="250" placeholder="Or answer in your own words"></textarea></p><button>Send</button></form>`));
}

/** Runs the broker in this process (normally started detached by `ensureBroker`). */
export async function runBroker({ port = BROKER_PORT } = {}) {
  mkdirSync(home(), { recursive: true, mode: 0o700 });
  const prev = readBrokerFile() || {};
  const adminToken = prev.adminToken || token();
  const runnerToken = prev.runnerToken || token();
  const logPath = join(home(), 'broker.log');
  const log = (m) => appendFileSync(logPath, `${new Date().toISOString()} ${m}\n`);
  const dbPath = join(home(), 'hauptling.db');
  const db = openDb(dbPath);
  const plat = await platform();
  const host = { ...dockerHost({ log }), hostGit };
  const base = `http://127.0.0.1:${port}`;
  const core = createCore({ db, host, github, notify: plat.notify, workerUrl: WORKER_BROKER_URL, publicUrl: base, runnerToken, log });
  const dash = createDashboard({ db, dbPath, core, host, log, slotDir, logins });

  const handler = async (req, res) => {
    const send = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    try {
      const url = new URL(req.url, 'http://x');
      if (url.pathname === '/health') return send(200, { ok: true, pid: process.pid });
      if (/^\/ask\/\d+$/.test(url.pathname)) return await answerPage(core, req, res, url);
      if (await dash.handle(req, res, url)) return;
      const who = core.authenticate((req.headers.authorization || '').replace(/^Bearer /, ''), adminToken);
      if (!who) return send(401, { error: 'Bad or expired token' });
      const m = /^\/api\/([\w.-]+)$/.exec(url.pathname);
      if (req.method !== 'POST' || !m) return send(404, { error: 'Not found' });
      let raw = '';
      for await (const chunk of req) { raw += chunk; if (raw.length > 1 << 20) throw new Error('Body too large'); }
      if (m[1] === 'shutdown' && who.role === 'admin') { send(200, { ok: true }); setTimeout(() => process.exit(0), 50); return; }
      const result = await core.call(m[1], raw ? JSON.parse(raw) : {}, who);
      send(200, { ok: true, result: result ?? null });
    } catch (e) {
      log(`error ${req.url}: ${e.message}`);
      send(400, { error: e.message });
    }
  };
  // 127.0.0.1 for you; the docker0 bridge address for the egress proxy's relay (containers never reach it directly).
  const docker0 = networkInterfaces().docker0?.find(a => a.family === 'IPv4')?.address;
  const servers = [];
  for (const addr of ['127.0.0.1', ...(docker0 ? [docker0] : [])]) {
    const server = createServer(handler);
    server.requestTimeout = 0;
    server.headersTimeout = 30e3;
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, addr, resolve); });
    servers.push(server);
  }
  writeFileSync(brokerFile(), JSON.stringify({ port, pid: process.pid, adminToken, runnerToken, startedAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
  chmodSync(brokerFile(), 0o600);
  log(`broker ${process.pid} listening on 127.0.0.1${docker0 ? ` and ${docker0}` : ''}:${port}`);
  setInterval(() => core.poll().catch(e => log(`poll: ${e.message}`)), 60e3).unref();
  await core.recover();
  core.pump().catch(e => log(`test pump: ${e.message}`));
  return { core, servers, db };
}
