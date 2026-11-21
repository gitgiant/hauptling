#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from '../src/util.mjs';

const USAGE = `hauptling — delegate coding tasks to Claude, Codex and agy workers

Delegator (host):
  delegator start [--repo R] [--cli claude|codex|agy] [--max 3]   new delegator session
  resume [--delegator ID] [--cli C]        state + handoff for a new CLI
  handoff <text|--file F>                  store a handoff note
  spawn --brief FILE [--vendor V] [--model M | --mode cheapest|rule] [--difficulty easy|normal|hard]
        [--repo R] [--base B] [--title T] [--test-writer [--test-writer-vendor V] [--test-writer-model M]]
  wait [--timeout 270]                     block until the next event (max 280 s; run again on timeout)
  status [--all]                           agents of the current delegator
  models                                   models.json table (suggest mode reasons over this)
  attach AGENT | reply AGENT <text> | kill AGENT | merge AGENT
  test request --sha S [--selector X] [--timeout S] | test wait ID | test get ID | test report ID FILE
Worker (inside a slot; HAUPTLING_AGENT is set):
  report <≤300 chars>                      finish: hauptling pushes, opens the PR, gates the merge
  ask <question> --choice A [--choice B…]  ask the user (notification + answer page); end your turn after
  test request [--selector X] [--timeout S]   then: test wait ID
Mailbox (any session):
  mail send <you> <to|family> <text> | mail check <you> | mail status <you> <text>
  mail peers [--all] | mail need <you> <to> <path> [why] | mail give <you> <to> <path> | mail prune [hours] [--force]
Setup:
  setup [--slots 3] [--vendors claude,codex,agy] [--no-host] [--no-login]
                                           everything: skill, Docker, worker image, egress proxy, broker, sign-ins, doctor
  doctor                                   check tools, Docker, image, egress, broker and sign-ins
  image                                    build the worker image if hauptling changed
  login SLOT VENDOR                        sign one slot in to claude|codex|agy
  init [DIR]                               write the detected hauptling.json
  broker start|stop|status|run
Internal: hook VENDOR EVENT, prepare VENDOR DIR, egress, test-exec`;

const out = (v) => console.log(typeof v === 'string' ? v : JSON.stringify(v, null, 2));
const [cmd, ...rest] = process.argv.slice(2);

async function main() {
  const { call } = await import('../src/client.mjs');
  const args = parseArgs(rest, { repeat: ['choice', 'artifacts'], bool: ['test-writer', 'all', 'gpu', 'force', 'no-host', 'no-login'] });
  const text = () => args._.join(' ');
  switch (cmd) {
    case undefined: case 'help': case '--help': case '-h': return out(USAGE);

    // ----- broker -----
    case 'broker': {
      const sub = args._[0];
      if (sub === 'run') { const { runBroker } = await import('../src/server.mjs'); await runBroker(); return new Promise(() => {}); }
      const { ensureBroker } = await import('../src/client.mjs');
      const { readBrokerFile } = await import('../src/brokerfile.mjs');
      if (sub === 'start') { const i = await ensureBroker(); return out(`broker ${i.pid} on 127.0.0.1:${i.port}`); }
      const info = readBrokerFile();
      const up = info && await fetch(`http://127.0.0.1:${info.port}/health`).then(r => r.ok, () => false);
      if (sub === 'status') return out(up ? `running: pid ${info.pid}, port ${info.port}, tunnel: ${(await call('tunnel.status')).state}` : 'not running');
      if (sub === 'stop') {
        if (!up) return out('not running');
        await fetch(`http://127.0.0.1:${info.port}/api/shutdown`, { method: 'POST', headers: { authorization: `Bearer ${info.adminToken}` } });
        return out('stopped');
      }
      throw new Error('broker start|stop|status|run');
    }

    // ----- delegator -----
    case 'delegator': {
      if (args._[0] !== 'start') { const list = await call('delegator.list'); return out(list.map(d => `${d.id} ${d.active ? 'active' : 'ended'} ${d.cli || ''} ${d.repo || ''} max ${d.max_agents}`).join('\n') || 'none'); }
      const r = await call('delegator.start', { repo: args.repo && normalizeRepo(args.repo), cli: args.cli, max: args.max ? Number(args.max) : 3 });
      return out(`Delegator ${r.id} started.`);
    }
    case 'resume': {
      const r = await call('resume', { delegator: args.delegator, cli: args.cli });
      const d = r.delegator;
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
        repo: args.repo && normalizeRepo(args.repo), base: args.base, title: args.title,
        testWriter: args.testWriter || args.testWriterModel ? { vendor: args.testWriterVendor, model: args.testWriterModel } : false,
        brief: readFileSync(args.brief, 'utf8'),
      });
      out(`${r.id} (${r.vendor} ${r.model}) ${r.state}`);
      if (r.testWriter) out(`${r.testWriter.id} (${r.testWriter.vendor} ${r.testWriter.model}) ${r.testWriter.state} — writes spec tests first`);
      return;
    }
    case 'wait': {
      const r = await call('wait', { delegator: args.delegator, timeout: Math.min(Number(args.timeout || 270), 280) });
      return out(r.events.length ? r.events.map(e => `[${e.kind}] ${e.text}`).join('\n') : 'No events yet (timed out). Run `hauptling wait` again.');
    }
    case 'status': return out(board(await call('agents', { delegator: args.delegator, all: args.all })));
    case 'models': { const { loadModels, table } = await import('../src/models.mjs'); return out(table(loadModels())); }
    case 'attach': {
      const { argv } = await call('attach', { agent: args._[0] });
      out(`Attaching to ${args._[0]} (detach: Ctrl-b d)…`);
      const { spawnSync } = await import('node:child_process');
      spawnSync(argv[0], argv.slice(1), { stdio: 'inherit' });
      return;
    }
    case 'reply': { const [agent, ...t] = args._; return out(await call('reply', { agent, text: t.join(' ') })); }
    case 'kill': return out(await call('kill', { agent: args._[0] }));
    case 'merge': return out(await call('merge', { agent: args._[0] }));

    // ----- worker -----
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
        const r = await call('test.request', { sha: args.sha, selector: args.selector || '', gpu: Boolean(args.gpu), artifacts: args.artifacts || [], timeout_s: Number(args.timeout || 1800), repo: args.repo && normalizeRepo(args.repo) });
        return out(`${r.id} (round ${r.round})`);
      }
      if (sub === 'wait') return out(fmtTest(await call('test.wait', { id, timeout: Math.min(Number(args.timeout || 270), 280) })));
      if (sub === 'get') return out(fmtTest(await call('test.get', { id })));
      if (sub === 'report') return out(await call('test.report', { id, report: JSON.parse(readFileSync(file, 'utf8')) }));
      throw new Error('test request|wait|get|report');
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
    case 'prepare': { const { prepare } = await import('../src/vendors.mjs'); prepare(args._[0], args._[1]); return; }
    case 'egress': { const { runEgress } = await import('../src/egress.mjs'); runEgress({ allow: args.allow, log: args.log, relay: args.relay }); return new Promise(() => {}); }
    case 'test-exec': {
      // Inside a test container: /work is the checkout, /artifacts receives log, artifacts and report.json.
      const { execTests } = await import('../src/runner.mjs');
      const report = await execTests('/work', { selector: args.selector || '', timeout_s: Number(args.timeout || 1800), artifacts: JSON.parse(args.artifacts || '[]') }, '/artifacts');
      writeFileSync('/artifacts/report.json', JSON.stringify(report));
      return;
    }
    case 'image': {
      const { ensureBaseImage } = await import('../src/docker.mjs');
      return out(await ensureBaseImage({ log: out, stdio: ['ignore', 'inherit', 'inherit'] }));
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
    case 'login': { const { login } = await import('../src/setup.mjs'); return login(args._[0], args._[1]); }
    default: throw new Error(`Unknown command ${cmd}\n\n${USAGE}`);
  }
}

function normalizeRepo(r) {
  if (/^[\w.-]+\/[\w.-]+$/.test(r) && !existsSync(r)) return r;
  if (/^(https?:|git@)/.test(r)) return r;
  return resolve(r);
}

function board(agents) {
  if (!agents.length) return 'No agents.';
  return agents.map(a => {
    const age = Math.round((Date.now() - Date.parse(a.created_at)) / 60e3);
    return `${a.id.padEnd(34)} ${a.state.padEnd(8)} ${a.slot || '-'}  ${age}m  ${a.pr_url || a.branch}${a.gate ? ` gate:${a.gate}` : ''}\n    ${a.status || a.title}${a.report ? `\n    report: ${a.report}` : ''}`;
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
