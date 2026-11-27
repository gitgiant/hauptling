import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { STRIP_DOTS, repoInitials, byDelegator, delegatorTitle, stripGroup } from '../web/dashboard/strip.js';

const h = (tag, attrs = {}, ...kids) => ({ tag, ...attrs, kids: kids.flat().filter(k => k != null && k !== false) });
const agent = (id, state, extra = {}) => ({ id, state, title: `task ${id}`, ...extra });

test('repoInitials', () => {
  for (const [repo, want] of [['example/nullpunkt', 'NP'], ['gitgiant/hauptling', 'HL'], ['/home/me/hauptling/', 'HL'],
    ['me/my-app.git', 'MA'], ['me/fooBar', 'FB'], ['example/docs', 'DO'], ['x', 'X'], ['', '?'], [null, '?']]) assert.equal(repoInitials(repo), want, String(repo));
});

test('byDelegator: one entry per delegator, in the order of the board groups', () => {
  const a = agent('a', 'blocked'), b = agent('b', 'working'), c = agent('c', 'done');
  const out = byDelegator(new Map([['d1|o/one', [a]], ['d2|o/two', [b]], ['d1|o/three', [c]], ['d3|', []]]));
  assert.deepEqual(out.map(d => [d.id, d.key, d.repos, d.agents.length]), [['d1', 'd1|o/one', ['o/one', 'o/three'], 2], ['d2', 'd2|o/two', ['o/two'], 1], ['d3', 'd3|', [], 0]]);
});

test('delegatorTitle: repo, id, CLI and counts per state', () => {
  const agents = [agent('a', 'working'), agent('b', 'working'), agent('c', 'restarting'), agent('d', 'working', { host_state: 'lost' })];
  assert.equal(delegatorTitle({ id: 'd1', repos: ['o/one'], agents }, 'codex'), 'o/one · d1 · Codex · 2 working, 1 starting, 1 host lost');
  assert.equal(delegatorTitle({ id: 'd1', repos: [], agents: [] }, null), 'No repo · d1 · Unknown CLI · no agents');
});

test('stripGroup: an icon and a dot per agent; clicks show the group or select the agent', () => {
  const calls = [];
  const d = { id: 'd1', key: 'd1|o/nullpunkt', repos: ['o/nullpunkt'], agents: [agent('a', 'blocked'), agent('b', 'spawning'), agent('c', 'parked', { host_state: 'offline' })] };
  const [icon, grid] = stripGroup(h, d, { cli: 'claude', selected: 'b', onGroup: (k) => calls.push(k), onAgent: (id) => calls.push(id) }).kids;
  assert.deepEqual([icon.tag, icon.class, icon.kids], ['button', 'mini-icon ring-claude', ['NP']]);
  assert.deepEqual(grid.kids.map(b => [b.tag, b.class, b.kids[0].class]), [['button', 'mini-dot', 'dot blocked'], ['button', 'mini-dot selected', 'dot starting'], ['button', 'mini-dot', 'dot host-offline']]);
  assert.equal(grid.kids[1].title, 'b · task b · starting');
  icon.onclick(); grid.kids[0].onclick();
  assert.deepEqual(calls, ['d1|o/nullpunkt', 'a']);
});

test('stripGroup caps the dots and counts the rest; no grid without agents', () => {
  const d = (n) => ({ id: 'd', key: 'd|r', repos: ['r'], agents: Array.from({ length: n }, (_, i) => agent(`a${i}`, 'queued')) });
  const grid = (n) => stripGroup(h, d(n), {}).kids[1];
  assert.equal(grid(0), undefined);
  assert.equal(grid(STRIP_DOTS).kids.length, STRIP_DOTS);
  const over = grid(STRIP_DOTS + 5).kids;
  assert.equal(over.length, STRIP_DOTS + 1);
  assert.deepEqual(over.at(-1).kids, ['+5']);
});

test('strip styles: three dots a row, four rows upright and three lying down; the blinking stops on request', () => {
  const css = readFileSync(new URL('../web/dashboard/style.css', import.meta.url), 'utf8');
  assert.match(css, /\.mini-dots \{[^}]*grid-template-columns: repeat\(3, 12px\)/);
  assert.match(css, /\.mini-dots \{ grid-template-columns: none; grid-template-rows: repeat\(3, 12px\); grid-auto-flow: column/);
  assert.match(css, /prefers-reduced-motion: reduce\)[^\n]*\.mini-dot \.dot[^\n]*animation: none/);
});
