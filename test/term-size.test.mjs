import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTerminals, clampSize, RESIZE_GAP_MS, RESIZE_REFRESH_MS, RESIZE_LEASE_MS } from '../src/terminal.mjs';
import { dockerHost } from '../src/docker.mjs';

/** One local agent, a clock and timers moved by hand, and a real docker host over a stubbed `docker`. */
function setup({ host: hostName = 'hub', rpc = null } = {}) {
  const row = { id: 'a1', slot: 'hl-w1', host: hostName, state: 'working' };
  const db = { prepare: () => ({ get: (id) => (id === row.id ? row : undefined), all: () => [row] }) };
  const runs = [];
  const host = dockerHost({ docker: async (args) => { runs.push(args); return { stdout: '' }; } });
  let t = 1000; let timers = [];
  const later = (fn, ms) => { const x = { fn, at: t + ms }; timers.push(x); return () => { timers = timers.filter(y => y !== x); }; };
  const terms = createTerminals({ db, host, rpc, slotDir: () => '/x', now: () => t, later });
  async function pass(ms) {
    t += ms;
    for (const x of timers.filter(y => y.at <= t)) { timers = timers.filter(y => y !== x); await x.fn(); }
  }
  /** What each docker call did: 'CxR' (unless a client is attached), or 'restore'. */
  const did = () => runs.map(a => {
    const s = a.at(-1);
    return s.startsWith('if ') ? s.match(/-x (\d+) -y (\d+)/).slice(1).join('x') : 'restore';
  });
  return { row, terms, runs, did, pass };
}

test('a resize message runs tmux resize-window with clamped values; a real attached client wins', async () => {
  const s = setup();
  s.terms.join('a1', 'v1');
  await s.terms.resize('a1', 'v1', { cols: 12, rows: 9999.5 });
  assert.equal(s.runs.length, 1);
  assert.deepEqual([s.runs[0][0], ...s.runs[0].slice(2, 4)], ['exec', 'sh', '-c']);
  assert.match(s.runs[0][1], /a1/);
  assert.equal(s.runs[0].at(-1), 'if [ -n "$(tmux list-clients -t main)" ]; then tmux set-option -u -w -t main: window-size; else tmux resize-window -t main: -x 40 -y 150; fi');
  assert.deepEqual(clampSize({ cols: 5000, rows: 1 }), { cols: 400, rows: 10 });
  assert.throws(() => s.terms.resize('a1', 'v1', { cols: '80; rm -rf /', rows: 20 }), /numbers/);
});

test('the smallest cols and rows among viewers win; closing the last restores the default', async () => {
  const s = setup();
  s.terms.join('a1', 'v1'); s.terms.join('a1', 'v2');
  await s.terms.resize('a1', 'v1', { cols: 100, rows: 30 });
  await s.pass(RESIZE_GAP_MS);
  await s.terms.resize('a1', 'v2', { cols: 140, rows: 20 });
  assert.deepEqual(s.did(), ['100x30', '100x20']);
  await s.pass(RESIZE_GAP_MS);
  await s.terms.leave('a1', 'v1');
  await s.pass(RESIZE_GAP_MS);
  await s.terms.leave('a1', 'v2');
  assert.deepEqual(s.did(), ['100x30', '100x20', '140x20', 'restore']);
  assert.match(s.runs.at(-1).at(-1), /\|\| tmux resize-window -t main: -x 220 -y 50; tmux set-option -u -w -t main: window-size$/);
  await s.terms.resize('a1', 'v2', { cols: 90, rows: 20 }); // a closed viewer no longer counts
  await s.pass(RESIZE_REFRESH_MS);
  await s.terms.sync('a1');
  assert.equal(s.runs.length, 4);
});

test('a viewer with no size (wrap off) leaves the minimum; with none left the default returns', async () => {
  const s = setup();
  s.terms.join('a1', 'v1');
  await s.terms.sync('a1');
  assert.equal(s.runs.length, 0, 'watching without a size touches nothing');
  await s.terms.resize('a1', 'v1', { cols: 80, rows: 20 });
  await s.pass(RESIZE_GAP_MS);
  await s.terms.resize('a1', 'v1', null);
  assert.deepEqual(s.did(), ['80x20', 'restore']);
});

test('rate limit: one resize per gap, the latest size last; unchanged sizes only refresh', async () => {
  const s = setup();
  s.terms.join('a1', 'v1');
  for (const cols of [80, 90, 100]) await s.terms.resize('a1', 'v1', { cols, rows: 20 });
  assert.deepEqual(s.did(), ['80x20']);
  await s.pass(RESIZE_GAP_MS - 1);
  assert.equal(s.runs.length, 1);
  await s.pass(1);
  assert.deepEqual(s.did(), ['80x20', '100x20']);
  await s.pass(RESIZE_REFRESH_MS - 1);
  await s.terms.sync('a1');
  assert.equal(s.runs.length, 2);
  await s.pass(1);
  await s.terms.sync('a1');
  assert.deepEqual(s.did(), ['80x20', '100x20', '100x20']);
});

test('a paused agent is not resized and raises nothing; a restore waits until it is live', async () => {
  const s = setup();
  s.terms.join('a1', 'v1');
  await s.terms.resize('a1', 'v1', { cols: 80, rows: 20 });
  s.row.state = 'paused';
  await s.pass(RESIZE_GAP_MS);
  await s.terms.resize('a1', 'v1', { cols: 70, rows: 20 });
  await s.terms.leave('a1', 'v1');
  await s.pass(RESIZE_REFRESH_MS);
  assert.equal(s.runs.length, 1);
  s.row.state = 'working';
  await s.pass(RESIZE_REFRESH_MS);
  assert.deepEqual(s.did(), ['80x20', 'restore']);
});

test('satellite side: a relayed size is undone when the hub stops refreshing it; broker start restores', async () => {
  const s = setup();
  await s.terms.relayResize('a1', { cols: 1, rows: 25 });
  await s.pass(RESIZE_LEASE_MS - 1);
  await s.terms.relayResize('a1', { cols: 1, rows: 25 });
  await s.pass(RESIZE_LEASE_MS - 1);
  assert.deepEqual(s.did(), ['40x25', '40x25']);
  await s.pass(1);
  assert.deepEqual(s.did(), ['40x25', '40x25', 'restore']);
  await s.terms.restoreSizes();
  assert.equal(s.did().at(-1), 'restore');
  assert.equal(s.runs.length, 4);
});

test('hub side: a satellite agent is sized with term.resize over the link', async () => {
  const sent = [];
  const s = setup({ host: 'sat1', rpc: async (...a) => { sent.push(a); return { ok: true }; } });
  s.terms.join('a1', 'v1');
  await s.terms.resize('a1', 'v1', { cols: 80, rows: 20 });
  await s.pass(RESIZE_GAP_MS);
  await s.terms.leave('a1', 'v1');
  assert.deepEqual(sent, [['sat1', 'term.resize', { agent: 'a1', size: { cols: 80, rows: 20 } }], ['sat1', 'term.resize', { agent: 'a1', size: null }]]);
  assert.equal(s.runs.length, 0);
});
