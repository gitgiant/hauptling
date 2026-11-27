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
  ];
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
