// Host info panel (PRD "Host info"): pure formatting of `/dash/hostinfo`, so node:test can cover it.

const pct = (v) => (v == null ? '?' : `${Math.round(v)}%`);
const gb = (mb) => (mb == null ? '?' : mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`);
/** 95 → "1m 35s", 4000 → "1h 7m", null → "–". */
export const secs = (s) => (s == null ? '–' : s < 60 ? `${Math.round(s)}s` : s < 3600 ? `${Math.floor(s / 60)}m ${Math.round(s % 60)}s` : `${Math.floor(s / 3600)}h ${Math.round((s % 3600) / 60)}m`);
const level = (v) => (v == null ? '' : v >= 90 ? 'full' : v >= 75 ? 'warn' : '');

/** The gauges at the top: [{ label, pct, level, detail }]. */
export function gauges(i) {
  const out = [
    { label: 'CPU', pct: i.cpu, detail: `${i.cores} cores · load ${i.load.map(n => n.toFixed(1)).join(' ')}` },
    { label: 'Memory', pct: i.mem.pct, detail: `${gb(i.mem.usedMB)} of ${gb(i.mem.totalMB)} · ${gb(i.mem.availMB)} available` },
  ];
  if (i.swap?.totalMB) out.push({ label: 'Swap', pct: (100 * i.swap.usedMB) / i.swap.totalMB, detail: `${gb(i.swap.usedMB)} of ${gb(i.swap.totalMB)}` });
  if (i.gpu) {
    out.push({ label: 'GPU', pct: i.gpu.util, detail: `${i.gpu.name}${i.gpu.tempC == null ? '' : ` · ${i.gpu.tempC} °C`}` });
    out.push({ label: 'GPU memory', pct: i.gpu.memTotalMB ? (100 * i.gpu.memUsedMB) / i.gpu.memTotalMB : null, detail: `${gb(i.gpu.memUsedMB)} of ${gb(i.gpu.memTotalMB)}` });
  }
  for (const d of i.disks || []) out.push({ label: `Disk ${d.mount}`, pct: d.usedPct, detail: `${gb(d.usedMB)} of ${gb(d.totalMB)} · ${d.what}` });
  return out.map(g => ({ ...g, level: level(g.pct), text: pct(g.pct) }));
}

/** Plain facts under the gauges: [[label, value]]. */
export function facts(i) {
  const b = i.broker || {};
  return [
    ['Host', `${i.name} · ${i.platform}`],
    ['IP', (i.ips || []).join(', ') || '–'],
    ['Up', `host ${secs(i.uptime_s)} · broker ${secs(b.uptime_s)} (pid ${b.pid ?? '?'})`],
    ['Hauptling', `${b.version || 'unknown version'} · node ${b.node || '?'} · image ${b.image || 'not built'}`],
    ['Workers', `${i.workers.running} running of ${i.workers.max} · ${i.workers.queued} queued · ${i.workers.slots} slots`],
    ['Test jobs', `${i.tests.running} running · ${i.tests.queued} queued · ${i.scale?.scaling ? 'start when they fit' : 'fixed limits'}`],
    ['Store', `${gb(i.store?.dbMB)} database · ${gb(i.store?.logMB)} broker log`],
    ...debugFacts(i),
  ];
}

/** "3m ago" from an ISO time. */
const ago = (iso, now) => (Number.isFinite(Date.parse(iso)) ? `${secs(Math.max(0, (now - Date.parse(iso)) / 1000))} ago` : '?');

/** Debug fact rows (PRD "Host info: debug"): WSL memory, the egress proxy, and why each queue's next test job waits. */
export function debugFacts(i, now = Date.now()) {
  const out = [];
  const w = i.wsl;
  if (w) {
    // The VM reports a little less than its limit; a real difference means the setting hasn't been applied.
    const pending = w.configuredMB && Math.abs(w.configuredMB - w.vmMB) > w.configuredMB * 0.08;
    const limit = !w.configuredMB ? 'no memory= in .wslconfig (default: half of Windows\' memory)' : pending ? `.wslconfig says ${gb(w.configuredMB)}: not applied until \`wsl --shutdown\`` : `.wslconfig ${gb(w.configuredMB)}`;
    out.push(['WSL memory', `VM has ${gb(w.vmMB)} · ${limit} · Windows ${gb(w.winTotalMB)}, ${gb(w.winFreeMB)} free`]);
  }
  const e = i.egress;
  if (e) {
    const state = e.missing ? 'no container (starts with the next worker)' : e.running ? `running, up ${ago(e.startedAt, now).replace(' ago', '')}` : 'NOT running';
    out.push(['Egress proxy', `${state}${e.missing ? '' : ` · ${e.restarts} restart${e.restarts === 1 ? '' : 's'}`} · ${e.errors} tunnel error${e.errors === 1 ? '' : 's'} in the last hour${e.lastError ? ` (last: ${e.lastError})` : ''}`]);
    if (e.blocked?.length) out.push(['Blocked hosts', e.blocked.map(b => `${b.host} ×${b.n} (${ago(b.last, now)})`).join(' · ')]);
  }
  for (const t of i.waits || []) {
    out.push([t.queue === 'gpu' ? 'Next GPU job' : 'Next test job', `${t.id} · ${t.repo}${t.agent ? ` · ${t.agent}` : ''} · waited ${secs(t.waited_s)}${t.queued > 1 ? ` · ${t.queued - 1} more behind it` : ''} · ${t.reason}`]);
  }
  return out;
}

/** Running containers, heaviest first: [name, kind, cores, memory]. */
export function containerRows(i) {
  return (i.containers || []).map(c => [
    c.name,
    `${c.kind}${c.id ? ` ${c.id}` : ''}${c.state && c.state !== 'running' ? ` (${c.state})` : ''}`,
    c.cores == null ? '?' : `${c.cores.toFixed(2)} cores`,
    c.memMB == null ? '?' : `${gb(c.memMB)}${c.limitMB ? ` of ${gb(c.limitMB)} (${Math.round((100 * c.memMB) / c.limitMB)}%)` : ''}`,
  ]);
}

/** Docker's disk use: rows [type, count, size, reclaimable] and a prune hint once over 2 GB can be freed. */
export function dockerDisk(i) {
  const d = i.dockerDisk || [];
  const rows = d.map(r => [r.type, `${r.count} (${r.active} in use)`, gb(r.sizeMB), gb(r.reclaimMB)]);
  const free = (type) => d.find(r => r.type === type)?.reclaimMB || 0;
  const hints = [];
  if (free('Build Cache') > 2048) hints.push(`\`docker builder prune\` frees ${gb(free('Build Cache'))} of build cache (the next image build is slower)`);
  if (free('Images') > 2048) hints.push(`\`docker image prune -a\` frees up to ${gb(free('Images'))} of images no container uses (repo images are rebuilt on the next spawn)`);
  return { rows, hint: hints.join('; ') };
}

/** Broker log lines with the ones that read as errors marked ("0 failed" does not): [{ text, bad }]. */
export function logLines(i) {
  const words = /\b(error|failed|fatal|uncaught|exception|refused|denied)\b|: (cannot|could not|unable) /i, errno = /\bE[A-Z]{4,}\b/;
  return (i.log || []).map((text) => {
    const said = text.replace(/^\S+ /, '').replace(/\b0 (failed|errors?)\b/gi, '');
    return { text, bad: words.test(said) || errno.test(said) };
  });
}

/** Per-repo cost rows: [repo, tests, GPU tests, implementation, start]. "–" where nothing was measured. */
export function repoRows(i) {
  const test = (t) => (t ? `${secs(t.secs)} · ${gb(t.memMB)} · ${t.cores} cores${t.vramMB ? ` · ${gb(t.vramMB)} VRAM` : ''}${t.measured ? ` (${t.runs} runs)` : ' (assumed)'}` : '–');
  const k = (n) => (n == null ? '?' : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));
  return (i.repos || []).map(r => [
    r.repo,
    test(r.cpu),
    test(r.gpu),
    r.impl ? `${secs(r.impl.secs)} · ${k(r.impl.tokens)} tok${r.impl.cost == null ? '' : ` · $${r.impl.cost.toFixed(2)}`} (${r.impl.n} tasks)` : '–',
    r.start ? Object.entries(r.start).map(([step, s]) => `${step} ${secs(s)}`).join(' · ') : '–',
  ]);
}
