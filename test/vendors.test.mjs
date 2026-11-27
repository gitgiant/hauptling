import { test } from 'node:test';
import assert from 'node:assert/strict';
import { vendorBadge } from '../web/dashboard/vendors.js';

test('vendorBadge maps the known vendors', () => {
  assert.deepEqual(vendorBadge('claude'), { key: 'claude', label: 'Claude', glyph: 'C' });
  assert.equal(vendorBadge('codex').glyph, 'X');
  assert.equal(vendorBadge('agy').glyph, 'G');
});

test('vendorBadge falls back to a neutral "?" badge', () => {
  for (const v of [undefined, null, '', 'gemini', '__proto__', 'toString']) {
    const b = vendorBadge(v);
    assert.equal(b.key, 'unknown');
    assert.equal(b.glyph, '?');
  }
  assert.match(vendorBadge('gemini').label, /gemini/);
});

test('usage windows: agy shows its two pools, own pool first and 5h before week', async () => {
  const { windowLabel, sortWindows } = await import('../web/dashboard/windows.js');
  assert.deepEqual(sortWindows([{ window: '3p-week' }, { window: 'week' }, { window: '3p-5h' }, { window: '5h' }]).map(l => windowLabel(l.window, 'agy')),
    ['Gemini 5h', 'Gemini week', 'Claude/GPT 5h', 'Claude/GPT week']);
  assert.deepEqual(sortWindows([{ window: 'week' }, { window: '5h' }]).map(l => windowLabel(l.window, 'codex')), ['5h', 'week']);
});

test('host info: gauges, facts and per-repo cost rows', async () => {
  const { gauges, facts, repoRows, secs } = await import('../web/dashboard/hostinfo.js');
  const info = { name: 'box', platform: 'linux 6.1', ips: ['10.0.0.5'], uptime_s: 4000, cores: 12, load: [1.5, 2, 3], cpu: 42,
    mem: { pct: 91, usedMB: 7200, totalMB: 7904, availMB: 704 }, swap: { totalMB: 2048, usedMB: 1024 },
    gpu: { name: 'RTX', util: 5, memUsedMB: 6144, memTotalMB: 8192, tempC: 60 }, disks: [{ mount: '/', what: 'system', usedPct: 80, usedMB: 80000, totalMB: 100000 }],
    broker: { pid: 7, uptime_s: 95, node: '22.1.0', version: 'abc1234 2026-11-27', image: 'hauptling-worker:x' },
    workers: { running: 2, max: 6, slots: 3, queued: 1 }, tests: { running: 1, queued: 0 }, scale: { scaling: true }, store: { dbMB: 3, logMB: 0.5 },
    repos: [{ repo: 'o/r', cpu: { secs: 95, memMB: 608, cores: 1.8, measured: true, runs: 3 }, gpu: null, impl: { n: 4, secs: 4000, tokens: 150000, cost: 1.5 }, start: { cloning: 4, 'starting container': 12 } }] };
  assert.deepEqual(gauges(info).map(g => [g.label, g.text, g.level]), [['CPU', '42%', ''], ['Memory', '91%', 'full'], ['Swap', '50%', ''], ['GPU', '5%', ''], ['GPU memory', '75%', 'warn'], ['Disk /', '80%', 'warn']]);
  assert.deepEqual(facts(info)[1], ['IP', '10.0.0.5']);
  assert.match(facts(info)[2][1], /host 1h 7m · broker 1m 35s \(pid 7\)/);
  assert.deepEqual(repoRows(info), [['o/r', '1m 35s · 608 MB · 1.8 cores (3 runs)', '–', '1h 7m · 150k tok · $1.50 (4 tasks)', 'cloning 4s · starting container 12s']]);
  assert.equal(secs(null), '–');
});
