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

test('host info debug: WSL memory, egress, waiting test jobs, containers, Docker disk and the broker log', async () => {
  const { debugFacts, containerRows, dockerDisk, logLines, facts } = await import('../web/dashboard/hostinfo.js');
  const now = Date.parse('2026-11-27T12:00:00Z');
  const info = {
    wsl: { vmMB: 7905, configuredMB: 10240, winTotalMB: 16308, winFreeMB: 4715 },
    egress: { running: true, restarts: 2, startedAt: '2026-11-27T11:00:00Z', errors: 1, lastError: 'api.x.com ECONNRESET', blocked: [{ host: 'a.com', n: 3, last: '2026-11-27T11:58:00Z' }] },
    waits: [{ queue: 'cpu', id: 't1', repo: 'o/r', agent: 'claude_x', waited_s: 95, queued: 3, reason: 'short on RAM: needs 2560 MiB, 300 MiB to spare' }, { queue: 'gpu', id: 't2', repo: 'o/r', agent: null, waited_s: 5, queued: 1, reason: 'the GPU queue is paused' }],
    containers: [{ name: 'hl-a', kind: 'worker', id: 'a', state: 'running', cores: 1.4, memMB: 1280, limitMB: 2560, pids: 40 }, { name: 'hl-b', kind: 'worker', id: 'b', state: 'paused', cores: null, memMB: null }],
    dockerDisk: [{ type: 'Images', count: 39, active: 1, sizeMB: 4283, reclaimMB: 4282 }, { type: 'Build Cache', count: 129, active: 0, sizeMB: 268, reclaimMB: 268 }],
    log: ['2026-11-27T11:00:00Z broker 7 listening', '2026-11-27T11:00:01Z test run t1: docker run: connection refused', '2026-11-27T11:00:02Z event report a: 0 failed tests'],
  };
  assert.deepEqual(debugFacts(info, now), [
    ['WSL memory', 'VM has 7.7 GB · .wslconfig says 10.0 GB: not applied until `wsl --shutdown` · Windows 15.9 GB, 4.6 GB free'],
    ['Egress proxy', 'running, up 1h 0m · 2 restarts · 1 tunnel error in the last hour (last: api.x.com ECONNRESET)'],
    ['Blocked hosts', 'a.com ×3 (2m 0s ago)'],
    ['Next test job', 't1 · o/r · claude_x · waited 1m 35s · 2 more behind it · short on RAM: needs 2560 MiB, 300 MiB to spare'],
    ['Next GPU job', 't2 · o/r · waited 5s · the GPU queue is paused'],
  ]);
  assert.match(debugFacts({ wsl: { vmMB: 9900, configuredMB: 10240, winTotalMB: 16308, winFreeMB: 1 } }, now)[0][1], /· \.wslconfig 10\.0 GB ·/, 'applied: the VM reports a little under its limit');
  assert.match(debugFacts({ wsl: { vmMB: 7905, configuredMB: null, winTotalMB: 16308, winFreeMB: 1 } }, now)[0][1], /no memory= in \.wslconfig/);
  assert.match(debugFacts({ egress: { running: false, restarts: 0, errors: 0, blocked: [] } }, now)[0][1], /^NOT running · 0 restarts · 0 tunnel errors/);
  assert.match(debugFacts({ egress: { running: false, missing: true, errors: 0, blocked: [] } }, now)[0][1], /^no container/);
  assert.deepEqual(debugFacts({}), [], 'probes that failed leave their rows out');
  assert.deepEqual(containerRows(info), [['hl-a', 'worker a', '1.40 cores', '1.3 GB of 2.5 GB (50%)'], ['hl-b', 'worker b (paused)', '?', '?']]);
  const disk = dockerDisk(info);
  assert.deepEqual(disk.rows[0], ['Images', '39 (1 in use)', '4.2 GB', '4.2 GB']);
  assert.match(disk.hint, /^`docker image prune -a` frees up to 4\.2 GB/);
  assert.equal(dockerDisk({ dockerDisk: [{ type: 'Images', count: 1, active: 1, sizeMB: 900, reclaimMB: 0 }] }).hint, '');
  assert.deepEqual(logLines(info).map(l => l.bad), [false, true, false], 'the time stamp and "0 failed" are not errors');
});
