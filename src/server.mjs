import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { writeFileSync, appendFileSync, mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { brokerFile, readBrokerFile } from './brokerfile.mjs';
import { openDb } from './db.mjs';
import { createCore } from './core.mjs';
import { createDashboard } from './dashboard.mjs';
import { createHub } from './hub.mjs';
import { createSatellite, readSatellite } from './satellite.mjs';
import { platform } from './platform/index.mjs';
import { config as dockerConfig, dockerHost, gpuAvailable, vendorRoot, signinSlot, signOutSlot, WORKER_BROKER_URL } from './docker.mjs';
import { logins } from './setup.mjs';
import { createUpdater } from './update.mjs';
import { signingIn, stopSignin } from './terminal.mjs';
import { networkInterfaces } from 'node:os';
import * as github from './github.mjs';
import { BROKER_PORT, VENDORS, home, token } from './util.mjs';

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

/**
 * The broker's HTTP handler: /health, the hub's /hub/* (satellites), answer pages, the dashboard, then /api/<call>.
 * Exported so tests can serve a hub on a spare port.
 */
export function brokerHandler({ core, hub, dash, adminToken, log = () => {}, recovery = Promise.resolve() }) {
  return async (req, res) => {
    const send = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    try {
      const url = new URL(req.url, 'http://x');
      if (url.pathname === '/health') return send(200, { ok: true, pid: process.pid });
      if (hub && await hub.handle(req, res, url)) return;
      await recovery;
      if (/^\/ask\/\d+$/.test(url.pathname)) return await answerPage(core, req, res, url);
      if (await dash.handle(req, res, url)) return;
      const who = core.authenticate((req.headers.authorization || '').replace(/^Bearer /, ''), adminToken, req.headers['x-hauptling-host']);
      if (!who) return send(401, { error: 'Bad or expired token' });
      const m = /^\/api\/([\w.-]+)$/.exec(url.pathname);
      if (who.role === 'satellite') log(`hub ${who.host} ${req.method} ${url.pathname}`);
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
}

/** A satellite's newest usage reading per vendor and window, for the hub's Usage page (part 3). */
export const usageReadings = (db) => {
  const seen = new Set();
  return db.prepare('SELECT vendor, window, used_pct, resets_at, at FROM slot_usage ORDER BY at DESC').all()
    .filter(r => !seen.has(`${r.vendor}:${r.window}`) && seen.add(`${r.vendor}:${r.window}`)).slice(0, 30);
};

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
  const signedIn = (slots, vendor) => logins(slots, [vendor]).filter(l => l.ok).map(l => l.slot);
  const docker = dockerHost({ log });
  // A sign-in session left open after it signed in is closed, so it doesn't hold the sign-in for good.
  const host = { ...docker, hostGit, signingIn: (slot, vendor) => signingIn(slot, vendor, { writtenAt: docker.signinStamp(slot, vendor) }), signedIn, signOut: signOutSlot, stopSignin };
  const base = `http://127.0.0.1:${port}`;
  const hub = createHub({ db, log, emit: (...a) => core.emit(...a) });
  // Satellite mode (PRD "Several hosts"): `hauptling satellite join` left a key, so dial the hub, run the agents it
  // places here and send their events up. The link starts once recovery is done.
  const joined = readSatellite();
  let satellite = null;
  if (joined) {
    const gpu = await gpuAvailable().catch(() => false);
    const capabilities = async () => {
      const vendors = {};
      for (const l of logins(await core.call('slots.get'), VENDORS)) if (l.ok || l.covered) (vendors[l.vendor] ||= []).push(l.slot);
      const free = Object.fromEntries(Object.entries(vendors).map(([v, signed]) => [v, core.freeSlots(v).filter(s => signed.includes(s)).length]));
      return { vendors, free, gpu, maxWorkers: dockerConfig().maxWorkers, usage: usageReadings(db) };
    };
    // rpc: the hub's dashboard asking for one of this host's agents' terminal, diff or timeline (PRD "Part 3").
    satellite = createSatellite({ db, config: joined, capabilities, onCommand: (c) => core.command(c), onRpc: (op, args) => dash.remote(op, args), log });
  }
  const core = createCore({ db, host, github, notify: plat.notify, workerUrl: WORKER_BROKER_URL, publicUrl: base, runnerToken, hub, satellite, log });
  const updater = createUpdater({ log, announce: (from, to) => core.call('update.announce', { from, to }) });
  // The dashboard's host features (Hosts panel, relayed terminal/diff) are the hub's; a joined satellite has none.
  const dash = createDashboard({ db, dbPath, core, host, hub: joined ? null : hub, updater, log, slotDir: vendorRoot, signinSlot, logins, report: { gh: github.gh, logPath, config: dockerConfig, secrets: () => [adminToken, runnerToken] } });

  const recovery = core.recover();
  recovery.then(() => dash.terms.restoreSizes()).catch(e => log(`terminal sizes: ${e.message}`)); // nobody is watching yet
  const handler = brokerHandler({ core, hub, dash, adminToken, log, recovery });
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
  await recovery;
  setInterval(() => core.poll().catch(e => log(`poll: ${e.message}`)), 60e3).unref();
  setInterval(() => { try { hub.tick(); } catch (e) { log(`hub tick: ${e.message}`); } }, 30e3).unref();
  core.pump().catch(e => log(`test pump: ${e.message}`));
  // Is main ahead? Quietly, for the dot on the dashboard's ⋯ button (PRD "Update from the dashboard").
  const lookForUpdate = () => updater.check().catch(e => log(`update check: ${e.message}`));
  setTimeout(lookForUpdate, 30e3).unref();
  setInterval(lookForUpdate, 6 * 3600e3).unref();
  if (satellite) {
    satellite.start();
    log(`satellite mode: dialling ${joined.hub} as ${joined.host}`);
  }
  return { core, servers, db, hub, satellite };
}
