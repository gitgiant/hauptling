#!/usr/bin/env node
import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { githubSlug, home, parseArgs } from '../src/util.mjs';
import { spawnSync } from 'node:child_process';

const USAGE = `hauptling — delegate coding tasks to Claude, Codex and agy workers

Delegator (host): pass --delegator ID on spawn, wait, status, handoff and resume
  (optional when only one delegator is active; required when several are)
  delegator start [--repo R] [--cli claude|codex|agy] [--max 3] [--no-gate] [--no-automerge] [--host H]   new delegator session
  delegator set [--delegator ID] [--gate on|off] [--automerge on|off] [--host H|auto]   gate off: reports merge with no test job
                                           (cancels a queued gate and merges); automerge off: stop at [ready]
                                           --host: run its agents on H (hub = this machine, or a satellite); auto: place each
  delegator end [--delegator ID]           mark it ended (refused while it has agents)
  delegator list                           all delegators
  resume [--repo R | --delegator ID] [--cli C]  state + handoff for a new CLI (--repo: only that repo's delegator)
  handoff <text|--file F>                  store a handoff note
  spawn --brief FILE [--vendor V] [--model M | --mode cheapest|rule] [--difficulty easy|normal|hard]
        [--repo R] [--base B] [--title T] [--allow-tier] [--effort low|medium|high|…] [--test-writer [--test-writer-vendor V] [--test-writer-model M]]
        [--host H] [--gpu]   --host: run it on H (overrides the delegator's); --gpu: only on a host with a GPU
  wait [--timeout 270] [--until-event]     block until the next event (max 280 s; run again on timeout); --until-event never times out
  status [AGENT] [--all]                   agents of the current delegator (or just AGENT)
  models                                   models.json table (suggest mode reasons over this)
  models prefer [cheap|balanced|best]      show or set the highest tier workers may use (spawn --allow-tier overrides)
  pause AGENT | unpause AGENT | restart AGENT   (a queued agent too: it is skipped until unpaused)
  queue [--delegator ID]                   queued agents in the order they start
  queue move AGENT --before OTHER | --after OTHER | --top | --bottom
  attach AGENT | reply AGENT <text> | kill AGENT | merge AGENT   (merge: local repos, or when automerge is off)
  test request --sha S [--selector X] [--gpu] [--timeout S] | test wait ID | test get ID | test report ID FILE
  dashboard [--print] [--host H] [--new-token]  open the dashboard (--print: show the sign-in link; --host: link via H, e.g. your Tailscale name)
  usage refresh                            read every vendor's current 5h/week usage now (no model tokens; once per 30 s)
  gpu status | gpu pause [--now] | gpu resume   hold the GPU test queue (--now kills and requeues the running job)
  runner [--gpu] [--once] [--dir D] | runner token   run test jobs on this machine, no container (GPU: set "gpuRunner": "host"
                                           in config.json; on another OS, e.g. Windows, set HAUPTLING_BROKER and HAUPTLING_TOKEN=<runner token>)
Worker (inside a slot; HAUPTLING_AGENT is set):
  report <≤300 chars>                      finish: hauptling pushes, opens the PR, gates the merge
  ask <question> --choice A [--choice B…]  ask the user (notification + answer page); end your turn after
  test request [--selector X] [--gpu] [--timeout S]   then: test wait ID (--gpu runs hauptling.json "gpu")
Mailbox (any session):
  mail send <you> <to|family> <text> | mail check <you> | mail status <you> <text>
  mail peers [--all] | mail need <you> <to> <path> [why] | mail give <you> <to> <path> | mail prune [hours] [--force]
Setup:
  setup [--slots 3] [--vendors claude,codex,agy] [--no-host] [--no-login]
                                           everything: skill, Docker, worker image, egress proxy, broker, sign-ins, doctor
  doctor                                   check tools, Docker, image, egress, broker and sign-ins
  image                                    build the worker image if hauptling changed
  update [--check]                         update this checkout to origin/main, rebuild the image if needed, restart
                                           the broker (--check: only report)
  key set VENDOR | key rm VENDOR | key list   API key instead of slot sign-ins (one key for all slots; billed per token)
  key budget VENDOR USD|off [--resets-on DAY] API first up to USD a month (new API spawns stop at 90%), then slot sign-ins
  key up-to VENDOR TIER|MODEL|off          the key pays only for models up to this tier (also --up-to on set/budget); above it: plan
  login SLOT VENDOR [--force]              sign one slot in to claude|codex|agy (refused while a worker of that vendor runs on the slot)
  signins [VENDOR|all [N]]                 sign-ins per vendor (default 1: one sign-in serves every slot); N sets it, up to the number of slots
  logout SLOT|all VENDOR                   sign a slot (or every slot) out of a vendor, to sign in with another account
  init [DIR]                               write the detected hauptling.json
  broker start|stop|restart|status|run
  hub token                                one-time join token for a satellite (15 min)
  satellite join HUB_URL TOKEN [--name H]  make this host a satellite of the hub (then \`broker restart\`)
  satellite list | satellite revoke HOST   on the hub: joined satellites; cut one off
  satellite status                         on a satellite: which hub it is joined to
Internal: hook VENDOR EVENT, prepare VENDOR DIR, usage VENDOR (status line), egress, test-exec`;

const out = (v) => console.log(typeof v === 'string' ? v : JSON.stringify(v, null, 2));
const [cmd, ...rest] = process.argv.slice(2);

async function main() {
  const { call } = await import('../src/client.mjs');
  const args = parseArgs(rest, { repeat: ['choice', 'artifacts'], bool: ['test-writer', 'allow-tier', 'until-event', 'host', 'all', 'gpu', 'force', 'no-host', 'no-login', 'now', 'print', 'new-token', 'no-gate', 'no-automerge', 'once', 'top', 'bottom', 'check'] });
  const text = () => args._.join(' ');
  /** The agent id to use for what was typed; says so when it is the old id of a renamed agent. */
  const target = async (agent) => {
    const r = await call('agent.resolve', { agent });
    if (r.renamed) console.error(`note: ${agent} was renamed to ${r.id}`);
    return r.id;
  };
  switch (cmd) {
    case undefined: case 'help': case '--help': case '-h': return out(USAGE);

    // ----- broker -----
    case 'broker': {
      const sub = args._[0];
      if (sub === 'run') { const { runBroker } = await import('../src/server.mjs'); await runBroker(); return new Promise(() => {}); }
      if (sub === 'restart') {
        const { restartBroker } = await import('../src/broker-control.mjs');
        return out(await restartBroker());
      }
      const { ensureBroker } = await import('../src/client.mjs');
      const { readBrokerFile } = await import('../src/brokerfile.mjs');
      if (sub === 'start') { const i = await ensureBroker(); return out(`broker ${i.pid} on 127.0.0.1:${i.port}`); }
      const info = readBrokerFile();
      const up = info && await fetch(`http://127.0.0.1:${info.port}/health`).then(r => r.ok, () => false);
      if (sub === 'status') return out(up ? `running: pid ${info.pid}, port ${info.port}` : 'not running');
      if (sub === 'stop') {
        if (!up) return out('not running');
        await fetch(`http://127.0.0.1:${info.port}/api/shutdown`, { method: 'POST', headers: { authorization: `Bearer ${info.adminToken}` } });
        return out('stopped');
      }
      throw new Error('broker start|stop|restart|status|run');
    }

    // ----- delegator -----
    // ----- several hosts (PRD "Several hosts") -----
    case 'hub': {
      if (args._[0] !== 'token') throw new Error('hub token');
      const r = await call('hub.token');
      return out(`${r.token}\nOne use, expires ${r.expiresAt}. On the other host run:\n  hauptling satellite join <hub-url> ${r.token}\n<hub-url>: this broker's tailnet address, e.g. its \`tailscale serve\` https://<name>.<tailnet>.ts.net`);
    }
    case 'satellite': {
      const sub = args._[0];
      if (sub === 'join') {
        const { joinHub } = await import('../src/satellite.mjs');
        const r = await joinHub(args._[1], args._[2], args.name ? { name: args.name } : {});
        return out(`Joined ${r.hub} as ${r.host}; key saved in ~/.hauptling/satellite.json. Run \`hauptling broker restart\` to connect.`);
      }
      if (sub === 'status') {
        const { readSatellite } = await import('../src/satellite.mjs');
        const s = readSatellite();
        return out(s ? `satellite ${s.host} of ${s.hub} (joined ${s.joinedAt}); the link's state is in ~/.hauptling/broker.log` : 'Not a satellite (this host is a hub).');
      }
      if (sub === 'revoke') { const r = await call('satellite.revoke', { host: args._[1] }); return out(`${r.host}: key revoked; it can join again with a new \`hauptling hub token\`.`); }
      if (sub === 'list' || !sub) {
        const hosts = await call('satellite.list');
        if (!hosts.length) return out('No satellites. `hauptling hub token` starts a join.');
        return out(hosts.map(h => {
          const c = h.capabilities || {};
          const vendors = Object.entries(c.vendors || {}).map(([v, s]) => `${v} ${c.free?.[v] ?? '?'}/${s.length} free`).join(', ') || 'no sign-ins';
          const state = h.revoked ? 'revoked' : h.online ? 'online' : `offline${h.offlineSince ? ` since ${h.offlineSince}` : ''}`;
          return `${h.name.padEnd(16)} ${state.padEnd(10)} ${vendors}${c.gpu ? ', GPU' : ''}; ${h.agents} agents; last seen ${h.lastSeen || 'never'}`;
        }).join('\n'));
      }
      throw new Error('satellite join|list|revoke|status');
    }
    case 'delegator': {
      if (args._[0] === 'end') { const r = await call('delegator.end', { delegator: args.delegator }); return out(`Delegator ${r.delegator} ended.`); }
      if (args._[0] === 'set') {
        const onoff = (k) => { if (args[k] == null) return undefined; if (!['on', 'off'].includes(args[k])) throw new Error(`--${k} takes on or off`); return args[k] === 'on'; };
        const r = await call('delegator.set', { delegator: args.delegator, gate: onoff('gate'), automerge: onoff('automerge'), host: args.host });
        return out(`Delegator ${r.delegator}: gate ${r.gate ? 'on' : 'off'}, automerge ${r.automerge ? 'on' : 'off'}, host ${r.host || 'auto'}.`);
      }
      if (args._[0] !== 'start') { const list = await call('delegator.list'); return out(list.map(d => `${d.id} ${d.active ? 'active' : 'ended'} ${d.cli || ''} ${d.repo || ''} max ${d.max_agents}${d.host ? ` host ${d.host}` : ''}`).join('\n') || 'none'); }
      const r = await call('delegator.start', { repo: args.repo && normalizeRepo(args.repo), cli: args.cli, max: args.max ? Number(args.max) : 3, gate: !args['no-gate'], automerge: !args['no-automerge'], host: args.host });
      return out(`Delegator ${r.id} started${r.host ? ` on ${r.host}` : ''}. Pass --delegator ${r.id} on every spawn, wait, status, handoff and resume.`);
    }
    case 'resume': {
      const names = args.repo ? repoNames(args.repo) : null;
      const r = await call('resume', { delegator: args.delegator, cli: args.cli, repo: names });
      const d = r.delegator;
      // Suggest the GitHub owner/name when there is one, so workers get PRs.
      if (!d) return out(`No active delegator for ${r.repo}. Start one: hauptling delegator start --repo ${names.at(-1)} --cli <claude|codex|agy>`);
      out(`Delegator ${d.id} (${d.repo || 'no default repo'}, max ${d.max_agents} agents), ${r.pendingEvents} unread events.`);
      out(d.handoff ? `Handoff (${d.handoff_at}):\n${d.handoff}` : 'No handoff note.');
      return out(board(r.agents));
    }
    case 'handoff': {
      const t = args.file ? readFileSync(args.file, 'utf8') : text();
      const r = await call('handoff', { delegator: args.delegator, text: t });
      return out(`Handoff stored for ${r.delegator}. Start the next CLI and run \`hauptling resume\`.`);
    }
    case 'spawn': {
      if (!args.brief) throw new Error('--brief FILE is required');
      const r = await call('spawn', {
        delegator: args.delegator, vendor: args.vendor, model: args.model, mode: args.mode, difficulty: args.difficulty,
        repo: args.repo && normalizeRepo(args.repo), base: args.base, title: args.title, allowTier: args.allowTier, effort: args.effort,
        testWriter: args.testWriter || args.testWriterModel ? { vendor: args.testWriterVendor, model: args.testWriterModel } : false,
        brief: readFileSync(args.brief, 'utf8'), host: args.host, gpu: Boolean(args.gpu),
      });
      out(`${r.id} (${r.vendor} ${r.model}${r.effort ? `, effort ${r.effort}` : ''}${bill(r)}) ${r.state}${r.host && r.host !== 'hub' ? ` on ${r.host}` : ''}`);
      if (r.testWriter) out(`${r.testWriter.id} (${r.testWriter.vendor} ${r.testWriter.model}${bill(r.testWriter)}) ${r.testWriter.state} — writes spec tests first`);
      for (const note of new Set([r.warning, r.testWriter?.warning, r.waiting, r.testWriter?.waiting].filter(Boolean))) out(note);
      return;
    }
    case 'wait': {
      // --until-event: for delegators whose CLI runs it in the background and wakes on exit (Claude Code); no empty turns.
      let r;
      do r = await call('wait', { delegator: args.delegator, timeout: Math.min(Number(args.timeout || 270), 280) });
      while (args.untilEvent && !r.events.length);
      return out(r.events.length ? r.events.map(e => `[${e.kind}] ${e.text}`).join('\n') : 'No events yet (timed out). Run `hauptling wait` again.');
    }
    case 'status': {
      const one = args._[0] && await target(args._[0]);
      const agents = (await call('agents', { delegator: args.delegator, all: args.all || Boolean(one) })).filter(a => !one || a.id === one);
      const satellites = await call('satellite.list').catch(() => []);
      return out(board(agents, { hosts: satellites.length > 0 }));
    }
    case 'models': {
      if (args._[0] === 'prefer') return out(`prefer: ${await call('models.prefer', { value: args._[1] })}`);
      const { loadModels, table } = await import('../src/models.mjs'); return out(table(loadModels()));
    }
    case 'attach': {
      const agent = await target(args._[0]);
      const r = await call('attach', { agent });
      if (r.remote) {
        // An agent on a satellite: the hub relays its screen and keys over the link (PRD "Part 3").
        out(`Attaching to ${agent} on ${r.remote} through the hub (detach: Ctrl-])…${r.online ? '' : ` ${r.remote} is offline right now.`}`);
        const { attachRemote } = await import('../src/terminal.mjs');
        return out(`Detached: ${await attachRemote({ call, agent: agent, host: r.remote })}`);
      }
      const { argv } = r;
      out(`Attaching to ${agent} (detach: Ctrl-b d)…`);
      const { spawnSync } = await import('node:child_process');
      spawnSync(argv[0], argv.slice(1), { stdio: 'inherit' });
      return;
    }
    case 'reply': { const [agent, ...t] = args._; return out(await call('reply', { agent: await target(agent), text: t.join(' ') })); }
    case 'pause': case 'unpause': case 'restart': case 'kill': case 'merge': return out(await call(cmd, { agent: await target(args._[0]) }));

    case 'queue': {
      let r;
      if (args._[0] === 'move') {
        const other = async (x) => (x ? target(x) : undefined);
        r = await call('queue.move', { agent: await target(args._[1]), before: await other(args.before), after: await other(args.after), top: args.top, bottom: args.bottom });
      } else if (args._.length) throw new Error('queue [--delegator ID] | queue move AGENT --before OTHER|--after OTHER|--top|--bottom');
      else r = await call('queue.list', { delegator: args.delegator });
      return out(r.queue.map(q => `#${q.position} ${q.id}${q.paused ? ' (paused)' : ''}${q.unparking ? ' (unparking)' : ''}  ${q.title}`).join('\n') || `Nothing queued for ${r.delegator}.`);
    }

    // ----- worker -----
    case 'usage': {
      if (args._[0] === 'refresh') {
        const { vendors } = await call('usage.refresh');
        const { noReset, windowLabel } = await import('../src/usage.mjs');
        return out(vendors.map(v => `${v.vendor.padEnd(7)}${v.status === 'ok' ? `${v.limits.map(l => `${windowLabel(l.window, v.vendor)} ${Math.round(l.used_pct)}%${l.resets_at ? ` (resets ${new Date(l.resets_at).toLocaleString()})` : ` (${noReset(l.used_pct)})`}`).join(' · ')}  [${v.slot}]` : `${v.status}: ${v.note}`}`).join('\n'));
      }
      // A worker's status line command: forward the vendor's JSON, print a short line. Never blocks the TUI for long.
      let raw = '';
      for await (const c of process.stdin) raw += c;
      try {
        const { scrub } = await import('../src/usage.mjs');
        // --host: the delegator's own CLI (installed by setup); the user's previous status line, if any, is what shows.
        const r = await Promise.race([call(args.host ? 'usage.host' : 'usage.report', { vendor: args._[0], payload: scrub(JSON.parse(raw || '{}')) }), new Promise((_, no) => setTimeout(() => no(new Error('timeout')), 3000))]).catch(() => null);
        if (args.host) { const { chained } = await import('../src/hoststatus.mjs'); const c = chained(args._[0], raw); if (c != null) return out(c); }
        return out(r?.text || 'hauptling');
      } catch { return out('hauptling'); }
    }
    case 'report': {
      const r = await call('report', { text: text() });
      if (r.note) return out(r.note);
      return out(r.pushed ? `Reported.${r.committed ? ' Committed your leftover changes.' : ''} Pushed ${r.branch} at ${r.sha.slice(0, 8)}; hauptling opens the PR and gates the merge. Stay available for follow-up messages.` : 'Reported (no commits ahead of base, nothing pushed).');
    }
    case 'ask': {
      if (!args.choice?.length) throw new Error('Give at least one --choice (the user can still answer freely via Other…)');
      return out((await call('ask', { question: text(), choices: args.choice })).note);
    }
    case 'test': {
      const [sub, id, file] = args._;
      if (sub === 'request') {
        if (!/^[0-9a-f]{4,40}$/i.test(args.sha || '')) throw new Error(`test request needs --sha <commit> (got ${JSON.stringify(args.sha ?? '')})`);
        const r = await call('test.request', { sha: args.sha, selector: args.selector || '', gpu: Boolean(args.gpu), artifacts: args.artifacts || [], timeout_s: Number(args.timeout || 1800), repo: args.repo && normalizeRepo(args.repo) });
        return out(`${r.id} (round ${r.round})`);
      }
      if (sub === 'wait') return out(fmtTest(await call('test.wait', { id, timeout: Math.min(Number(args.timeout || 270), 280) })));
      if (sub === 'get') return out(fmtTest(await call('test.get', { id })));
      if (sub === 'report') return out(await call('test.report', { id, report: JSON.parse(readFileSync(file, 'utf8')) }));
      throw new Error('test request|wait|get|report');
    }
    case 'dashboard': {
      const { token: t, url } = await call('dashboard.token', { rotate: Boolean(args.newToken) });
      const base = args.host ? (/^https?:\/\//.test(args.host) ? args.host : `https://${args.host}`).replace(/\/+$/, '') : url;
      const link = `${base}/?k=${t}`;
      if (args.newToken) console.error('New dashboard token: browsers signed in with the old one must open this link again.');
      if (args.print) return out(link);
      const { platform } = await import('../src/platform/index.mjs');
      (await platform()).openUrl(link);
      return out(`Opening ${base}/ (sign-in link: hauptling dashboard --print)`);
    }
    case 'gpu': {
      const sub = args._[0];
      if (sub === 'pause') { const r = await call('gpu.pause', { now: Boolean(args.now) }); return out(r.requeued ? `GPU queue paused; killed and requeued ${r.requeued.join(', ') || 'nothing'}` : `GPU queue paused${r.running.length ? `; ${r.running.join(', ')} still running (finishes first; --now kills and requeues it)` : ''}`); }
      if (sub === 'resume') { await call('gpu.resume'); return out('GPU queue resumed'); }
      if (sub === 'status' || !sub) {
        const g = await call('gpu.status');
        const lines = [`GPU: ${g.available ? 'available' : 'none/disabled'}${g.paused ? ', PAUSED' : ''}; free ${g.freeMB ?? '?'} MiB (jobs need ${g.needMB} MiB)`];
        for (const t of g.running) lines.push(`running ${t.id} ${t.purpose} ${t.agent || ''} since ${t.claimed_at} (timeout ${t.timeout_s}s)`);
        for (const t of g.queued) lines.push(`queued  ${t.id} ${t.purpose} ${t.agent || ''}${t.waiting_since ? ` (waiting for VRAM since ${t.waiting_since})` : ''}`);
        return out(lines.join('\n'));
      }
      throw new Error('gpu pause [--now]|resume|status');
    }

    // ----- mailbox -----
    case 'mail': {
      const [sub, a, b, ...m] = args._;
      const sent = (r) => out(r.length ? `Sent to ${r.join(', ')}` : 'No other recipient (you were the only match).');
      if (sub === 'send') return sent(await call('mail.send', { from: a, to: b, text: m.join(' ') }));
      if (sub === 'need' || sub === 'give') {
        const [path, ...why] = m;
        if (!b || !path) throw new Error(`mail ${sub} <you> <to> <path>${sub === 'need' ? ' [reason]' : ''}`);
        const t = `${sub.toUpperCase()} ${path}${sub === 'need' && why.length ? `: ${why.join(' ')}` : ''}`;
        return sent(await call('mail.send', { from: a, to: b, text: t }));
      }
      if (sub === 'check') { const lines = await call('mail.check', { identity: a }); if (lines.length) out(lines.join('\n')); return; }
      if (sub === 'status') return void await call('mail.status', { identity: a, text: [b, ...m].filter(Boolean).join(' ') });
      if (sub === 'peers') { const lines = await call('mail.peers', { all: args.all }); return out(lines.length ? lines.join('\n') : 'No one has a status (mail peers --all lists every identity).'); }
      if (sub === 'prune') { const r = await call('mail.prune', { hours: a ?? 12, force: args.force }); return out(r.length ? `Removed ${r.length}: ${r.join(', ')}` : 'Nothing to prune.'); }
      throw new Error('mail send|check|status|peers|need|give|prune');
    }

    // ----- internal / setup -----
    case 'hook': return hook(args._[0], args._[1], call);
    case 'prepare': { const { prepare, installDeps } = await import('../src/vendors.mjs'); prepare(args._[0], args._[1]); installDeps(args._[1]); return; }
    case 'egress': { const { runEgress, keepServing } = await import('../src/egress.mjs'); keepServing(); runEgress({ allow: args.allow, log: args.log, relay: args.relay }); return new Promise(() => {}); }
    case 'runner': {
      if (args._[0] === 'token') {
        const { readBrokerFile } = await import('../src/brokerfile.mjs');
        const info = readBrokerFile();
        if (!info?.runnerToken) throw new Error('No broker file with a runner token here; run this on the broker host');
        return out(info.runnerToken);
      }
      const { runnerLoop } = await import('../src/host-runner.mjs');
      const { home } = await import('../src/util.mjs');
      const { join } = await import('node:path');
      const report = await runnerLoop({ call, gpu: Boolean(args.gpu), once: Boolean(args.once), root: resolve(args.dir || join(home(), 'runner')), log: (s) => console.log(`${new Date().toISOString()} ${s}`) });
      if (args.once && report && report.status !== 'pass') process.exitCode = 1;
      return;
    }
    case 'test-exec': {
      // Inside a test container: /work is the checkout, /artifacts receives log, artifacts and report.json.
      const { execTests } = await import('../src/runner.mjs');
      const report = await execTests('/work', { selector: args.selector || '', timeout_s: Number(args.timeout || 1800), artifacts: JSON.parse(args.artifacts || '[]'), gpu: Boolean(args.gpu) }, '/artifacts');
      writeFileSync('/artifacts/report.json', JSON.stringify(report));
      return;
    }
    case 'image': {
      const { ensureBaseImage } = await import('../src/docker.mjs');
      return out(await ensureBaseImage({ log: out, stdio: ['ignore', 'inherit', 'inherit'] }));
    }
    case 'update': {
      if (process.env.HAUPTLING_AGENT) throw new Error('update runs on the host, not in a worker');
      const { createUpdater, runCli } = await import('../src/update.mjs');
      const { appendFileSync, mkdirSync } = await import('node:fs');
      const show = { stdio: 'inherit' };
      const updater = createUpdater({
        log: (m) => { mkdirSync(home(), { recursive: true }); appendFileSync(join(home(), 'broker.log'), `${new Date().toISOString()} ${m}\n`); },
        announce: (from, to) => call('update.announce', { from, to }),
        build: () => runCli(['image'], show),
        restart: () => runCli(['broker', 'restart'], show),
      });
      if (args.check) return out(await updater.check());
      const { run, ...r } = await updater.start();
      if (!run) return out(`Up to date (${r.current})`);
      out(`${r.from} → ${r.to}\n${r.commits.map(c => `  ${c}`).join('\n')}`);
      updater.onChange((s) => { if (!s.error) out(`${s.phase}…`); });
      await run();
      const end = updater.status();
      if (end.error) throw new Error(end.error);
      return out(`Updated to ${r.to}`);
    }
    case 'init': {
      const { detect } = await import('../src/detect.mjs');
      const dir = resolve(args._[0] || '.');
      const path = resolve(dir, 'hauptling.json');
      if (existsSync(path)) throw new Error(`${path} exists`);
      const { source: _s, ...cfg } = detect(dir);
      writeFileSync(path, JSON.stringify(cfg, null, 2) + '\n');
      return out(`Wrote ${path}`);
    }
    case 'setup': {
      const { setup } = await import('../src/setup.mjs');
      const good = await setup({ slots: Number(args.slots || 3), vendors: args.vendors ? args.vendors.split(',') : undefined, host: !args.noHost, login: !args.noLogin });
      if (!good) process.exitCode = 1;
      return;
    }
    case 'doctor': { const { doctor } = await import('../src/setup.mjs'); if (!await doctor({ vendors: args.vendors ? args.vendors.split(',') : undefined })) process.exitCode = 1; return; }
    case 'key': {
      const keys = await import('../src/keys.mjs');
      const { ceilingTier, loadModels, tierName } = await import('../src/models.mjs');
      const [sub, vendor] = args._;
      const upTo = (v) => { const t = keys.getUpTo(v); return t ? ` up to ${tierName(loadModels(), v, t)} (tier ${t})` : ''; };
      const mode = (v, h, b = keys.getBudget(v)) => (!h ? 'slot sign-ins (subscription)'
        : b ? `API key ${h}${upTo(v)} first, up to $${b.usd} a month (new API spawns stop at $${Math.round(b.usd * keys.STOP_AT * 100) / 100}; resets on day ${b.resets_on}), then slot sign-ins`
        : keys.getUpTo(v) ? `API key ${h}${upTo(v)} (billed per token; models above it use the slot sign-ins)`
        : `API key ${h} (all slots, billed per token)`);
      // --up-to: resolved before anything is stored, so an unknown name changes nothing. undefined = not given.
      const ceiling = (value) => {
        if (value == null) return undefined;
        if (value === true || value === '') throw new Error('--up-to needs a tier (1–3), a model name, or off');
        return ceilingTier(loadModels(), vendor, value);
      };
      /** A key for every slot with a ceiling still sends the models above it to the plan: those slots need a sign-in. */
      const signInWarning = async () => {
        if (!keys.getUpTo(vendor) || keys.getBudget(vendor)) return '';
        const { logins } = await import('../src/setup.mjs');
        let names = [];
        try { names = readdirSync(join(home(), 'slots')).sort(); } catch {}
        if (!names.length) names = ['hl-w1', 'hl-w2', 'hl-w3'];
        const missing = logins(names, [vendor]).filter(l => !l.ok);
        return missing.length ? `\nwarning: models above the ceiling use your plan, but ${missing.map(l => l.slot).join(', ')} ${missing.length > 1 ? 'are' : 'is'} not signed in to ${vendor}: ${missing.map(l => `\`hauptling login ${l.slot} ${vendor}\``).join(', ')}` : '';
      };
      if (sub === 'list' || !sub) return out(Object.entries(keys.keyHints()).map(([v, h]) => `${v.padEnd(7)} ${mode(v, h)}`).join('\n'));
      if (sub === 'budget') {
        if (!keys.getKey(vendor)) throw new Error(`${vendor}: no API key; first: hauptling key set ${vendor}`);
        const amount = args._[2] ?? args.budget;
        if (amount == null) throw new Error('key budget VENDOR USD [--resets-on DAY] [--up-to TIER|MODEL|off] | key budget VENDOR off');
        const tier = ceiling(args.upTo);
        keys.setBudget(vendor, amount === 'off' ? null : amount, args.resetsOn ?? 1);
        if (tier !== undefined) keys.setUpTo(vendor, tier);
        return out(`${vendor}: ${mode(vendor, keys.keyHints()[vendor])}.\nApplies to new workers; spend so far shows on the dashboard's usage page.${await signInWarning()}`);
      }
      if (sub === 'up-to') {
        if (!keys.getKey(vendor)) throw new Error(`${vendor}: no API key; first: hauptling key set ${vendor}`);
        const tier = ceiling(args._[2]);
        if (tier === undefined) throw new Error('key up-to VENDOR TIER|MODEL|off');
        keys.setUpTo(vendor, tier);
        return out(`${vendor}: ${mode(vendor, keys.keyHints()[vendor])}.\nApplies to new workers.${await signInWarning()}`);
      }
      if (sub === 'rm') { const r = keys.removeKey(vendor); return out(r.removed ? `${vendor}: key removed; new workers use the slots' sign-ins again.` : `${vendor}: no key was set.`); }
      if (sub === 'set') {
        const tier = ceiling(args.upTo);
        // Read the key from stdin (pipe) or a hidden prompt; never from argv, so it stays out of shell history.
        const key = process.stdin.isTTY ? await hiddenPrompt(`${keys.KEY_ENV[vendor] || 'API key'} for ${vendor}: `) : (await (async () => { let s = ''; for await (const c of process.stdin) s += c; return s; })());
        const r = keys.setKey(vendor, key);
        if (tier !== undefined) keys.setUpTo(vendor, tier);
        const stored = `${vendor}: API key ${r.hint} stored (~/.hauptling/keys/${vendor}, mode 600).`;
        if (args.budget != null) keys.setBudget(vendor, args.budget, args.resetsOn ?? 1);
        if (args.budget != null) return out(`${stored}\n${mode(vendor, r.hint)}. Keep the slots signed in for the fallback.\nKey for every spawn instead: hauptling key budget ${vendor} off`);
        if (keys.getBudget(vendor)) return out(`${stored}\n${mode(vendor, r.hint)}.`);
        if (keys.getUpTo(vendor)) return out(`${stored}\nNew ${vendor} workers${upTo(vendor).replace(' up to', ' on models up to')} use it and are billed per token by the API; models above it use your subscription, so keep the slots signed in. Running workers are unchanged.\nSwitch back: hauptling key rm ${vendor}${await signInWarning()}`);
        return out(`${stored}\nNew ${vendor} workers on every slot now use it and are billed per token by the API, not your subscription. Running workers are unchanged.\nAPI first, then your plan: hauptling key budget ${vendor} USD [--resets-on DAY]\nSwitch back: hauptling key rm ${vendor}`);
      }
      throw new Error('key set VENDOR [--budget USD [--resets-on DAY]] [--up-to TIER|MODEL] (reads the key from stdin or a hidden prompt) | key budget VENDOR USD|off [--resets-on DAY] [--up-to …] | key up-to VENDOR TIER|MODEL|off | key rm VENDOR | key list');
    }
    case 'login': { const { login } = await import('../src/setup.mjs'); return login(args._[0], args._[1], { force: Boolean(args.force) }); }
    case 'signins': {
      const [which = 'all', n] = args._;
      const { VENDORS } = await import('../src/util.mjs');
      for (const vendor of which === 'all' ? VENDORS : [which]) {
        const r = await call('signin.count', { vendor, ...(n == null ? {} : { n: Number(n) }) });
        out(`${vendor.padEnd(7)}${r.signins} sign-in${r.signins === 1 ? '' : 's'} for ${r.slots} slots (${r.signin_slots.join(', ')})`);
      }
      return;
    }
    case 'logout': {
      const [slot, vendor] = args._;
      if (!slot || !vendor) throw new Error('logout <hl-wN|all> <claude|codex|agy>');
      const names = slot === 'all' ? (await call('signin.count', { vendor })).signin_slots : [slot];
      for (const s of names) {
        const r = await call('signin.out', { slot: s, vendor }).catch(e => ({ error: e.message }));
        out(r.error ? `${s} ${vendor}: not signed out (${r.error})` : `${s} ${vendor}: ${r.was_signed_in ? 'signed out' : 'was not signed in'}. Sign in: hauptling login ${s} ${vendor}`);
      }
      return;
    }
    default: throw new Error(`Unknown command ${cmd}\n\n${USAGE}`);
  }
}

/** ", api" | ", plan" | ", plan (above API ceiling)" for a spawned agent; nothing while its billing is open. */
function bill(r) {
  return r.billing ? `, ${r.billing}${r.aboveCeiling ? ' (above API ceiling)' : ''}` : '';
}

function normalizeRepo(r) {
  if (/^[\w.-]+\/[\w.-]+$/.test(r) && !existsSync(r)) return r;
  if (/^(https?:|git@)/.test(r)) return r;
  return resolve(r);
}

/** Every name a repo may be stored under: as given (normalized), plus the GitHub owner/name of a local clone's origin. */
function repoNames(r) {
  const names = [normalizeRepo(r)];
  if (existsSync(names[0])) {
    const url = spawnSync('git', ['-C', names[0], 'remote', 'get-url', 'origin'], { encoding: 'utf8' }).stdout?.trim();
    const slug = url && githubSlug(url);
    if (slug) names.push(slug);
  }
  return names;
}

/** `hosts`: show where each agent runs (any satellite joined), and "host offline" for those whose host is. */
function board(agents, { hosts = false } = {}) {
  if (!agents.length) return 'No agents.';
  return agents.map(a => {
    const age = Math.round((Date.now() - Date.parse(a.created_at)) / 60e3);
    const where = hosts ? ` ${(a.host || 'hub').padEnd(10)}${a.host_offline ? ' (host offline)' : ''}` : '';
    return `${a.id.padEnd(34)} ${a.state.padEnd(8)}${where} ${a.slot || '-'}  ${age}m  ${a.pr_url || a.branch}${a.gate ? ` gate:${a.gate}` : ''}\n    ${a.headroom || a.status || a.title}${a.report ? `\n    report: ${a.report}` : ''}`;
  }).join('\n');
}

function fmtTest(t) {
  if (!t.report) return `${t.id}: ${t.state}${t.note ? ` — ${t.note}` : ''}`;
  const r = t.report;
  const lines = [`${t.id} ${r.status} on ${r.sha.slice(0, 8)}: ${r.passed} passed, ${r.failed} failed, ${r.skipped} skipped in ${Math.round(r.duration_s)}s (round ${t.round})`];
  for (const f of r.failures || []) lines.push(`- ${f.test_id}${f.loc ? ` (${f.loc})` : ''}: ${f.message}${f.excerpt ? `\n${f.excerpt.split('\n').map(l => `    ${l}`).join('\n')}` : ''}`);
  if (r.notes) lines.push(`notes: ${r.notes}`);
  lines.push(`log: ${r.log_path}`);
  return lines.join('\n');
}

/** Hook entry: never breaks the agent. Errors go to stderr; exit code stays 0. */
async function hook(vendor, event, call) {
  try {
    const { hookInput, hookOutput } = await import('../src/vendors.mjs');
    const raw = JSON.parse(readFileSync(0, 'utf8') || '{}');
    event ||= raw.hook_event_name;
    const input = hookInput(vendor, raw);
    if (input.subagent) return;
    const r = await call('hook', { vendor, event, ...input });
    const o = hookOutput(vendor, event, r || {});
    if (o) out(JSON.stringify(o));
    else if (vendor === 'agy' && event === 'PostToolUse') out('{}');
  } catch (e) {
    console.error(`hauptling hook: ${e.message}`);
  }
}

main().catch((e) => { console.error(`hauptling: ${e.message}`); process.exitCode = 1; });

/** Reads a line from the terminal without echoing it. */
function hiddenPrompt(question) {
  return new Promise((resolve, reject) => {
    process.stderr.write(question);
    const stdin = process.stdin;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let value = '';
    const onData = (ch) => {
      for (const c of ch) {
        if (c === '\r' || c === '\n') { done(); return resolve(value); }
        if (c === '\u0003') { done(); return reject(new Error('cancelled')); }
        if (c === '\u007f' || c === '\b') value = value.slice(0, -1); else value += c;
      }
    };
    const done = () => { stdin.setRawMode(false); stdin.pause(); stdin.off('data', onData); process.stderr.write('\n'); };
    stdin.on('data', onData);
  });
}
