import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { clampRatio, parseRatio, defaultRatio, splitKey, keyRatio, collapseAfterDrag, HEADER_STEPS, stepClasses, pickStep, handleKey, STRIP_PX, SNAP_PX, STRIP_CLASS, dragSplit, keySplit, readSplit, writeSplit, hiddenAfter } from '../web/dashboard/layout.js';

test('clampRatio keeps both panes at their minimum', () => {
  assert.equal(clampRatio(0.4, 1000, 200, 300), 0.4);
  assert.equal(clampRatio(0.1, 1000, 200, 300), 0.2, 'first pane at least 200 px');
  assert.equal(clampRatio(0.9, 1000, 200, 300), 0.7, 'second pane at least 300 px');
  assert.equal(clampRatio(0.5, 400, 200, 300), 0.4, 'minimums don\'t fit: share proportionally');
  assert.equal(clampRatio(NaN, 1000, 0, 0), 0.5);
  assert.equal(clampRatio(1.5, 0, 200, 300), 1, 'no layout yet: only bound to 0..1');
});

test('parseRatio accepts only a share strictly between 0 and 1', () => {
  assert.equal(parseRatio('0.35'), 0.35);
  for (const bad of [null, '', 'abc', '0', '1', '-0.2', '2', 'NaN', 'Infinity']) assert.equal(parseRatio(bad), null, String(bad));
});

test('defaultRatio: a fraction, or a pixel width converted to a share', () => {
  assert.equal(defaultRatio(0.4, 1200), 0.4);
  assert.equal(defaultRatio({ px: 200 }, 1000), 0.2);
  assert.equal(defaultRatio({ px: 200 }, 0), 0.25);
});

test('splitKey differs per orientation', () => {
  assert.equal(splitKey('board', false), 'hl-split-board-h');
  assert.equal(splitKey('board', true), 'hl-split-board-v');
});

test('keyRatio moves the splitter with arrows, Shift, Page and Home/End', () => {
  const k = (key, shift = false, r = 0.5) => keyRatio(key, shift, r, 1000, 100, 100);
  assert.equal(k('ArrowLeft'), 0.48);
  assert.equal(k('ArrowUp'), 0.48);
  assert.equal(k('ArrowRight'), 0.52);
  assert.equal(k('ArrowDown'), 0.52);
  assert.equal(k('ArrowRight', true), 0.6);
  assert.equal(k('PageUp'), 0.4);
  assert.equal(k('Home'), 0.1);
  assert.equal(k('End'), 0.9);
  assert.equal(k('ArrowLeft', false, 0.1), 0.1, 'stops at the minimum');
  assert.equal(k('Enter'), null);
  assert.equal(k('a'), null);
});

test('collapseAfterDrag: header collapses on a long drag or a flick up', () => {
  const open = (dy, vy = 0, height = 48) => collapseAfterDrag({ collapsed: false, dy, vy, height });
  assert.equal(open(0), false, 'a click on the header does nothing');
  assert.equal(open(-10), false, 'short drag springs back');
  assert.equal(open(-24), true, 'a third of 48 px is 16; the floor is 24 px');
  assert.equal(open(-40, 0, 150), false, 'a tall header needs a third of its height');
  assert.equal(open(-50, 0, 150), true);
  assert.equal(open(-10, -0.8), true, 'flick up');
  assert.equal(open(-5, -0.8), false, 'a twitch is no flick');
  assert.equal(open(30, 1), false, 'dragging down never collapses');
});

test('collapseAfterDrag: the tab expands on a click, a drag down or a flick down', () => {
  const shut = (dy, vy = 0) => collapseAfterDrag({ collapsed: true, dy, vy, height: 48 });
  assert.equal(shut(0), false, 'click');
  assert.equal(shut(2), false, 'click with jitter');
  assert.equal(shut(30), false, 'drag down');
  assert.equal(shut(10, 0.8), false, 'flick down');
  assert.equal(shut(10), true, 'short slow drag stays collapsed');
  assert.equal(shut(-20), true, 'dragging up keeps it collapsed');
});

test('stepClasses: each header step keeps the degrades before it', () => {
  assert.deepEqual(stepClasses(0), []);
  assert.deepEqual(stepClasses(1), ['h-no-host'], 'the host name goes first');
  assert.deepEqual(stepClasses(4), ['h-no-host', 'h-no-spark', 'h-short', 'h-brief']);
  assert.deepEqual(stepClasses(HEADER_STEPS.length - 1), ['h-no-host', 'h-no-spark', 'h-short', 'h-brief', 'h-minis', 'h-icons', 'h-tight', 'h-min']);
});

test('pickStep: the least degraded step whose row fits at a given width', () => {
  const needs = [1800, 1700, 1450, 1250, 900, 760, 680, 480, 400]; // row width at each of HEADER_STEPS
  const at = (width, current = 0) => pickStep((s) => width - needs[s], current);
  assert.equal(at(3440), 0, 'ultrawide: everything');
  assert.equal(at(1920), 0, '1920: everything on one row');
  assert.equal(at(1750), 1, 'drop the host name first');
  assert.equal(at(1600), 2, 'then the sparklines');
  assert.equal(at(1366), 3, 'then shorten labels');
  assert.equal(at(1000), 4, 'then hide GPU details');
  assert.equal(at(768), 5, 'bare usage bars');
  assert.equal(at(700), 6, 'Report as an icon');
  assert.equal(at(500), 7, 'tight');
  assert.equal(at(390), 8, 'phone: the last step');
  assert.equal(at(280), 8, 'never past the last step');
});

test('pickStep: going back needs a margin, so a ticking number cannot flip the step', () => {
  const needs = [1000, 900, 800, 700];
  const at = (width, current) => pickStep((s) => width - needs[s], current);
  assert.equal(at(1005, 1), 1, 'fits by 5 px: stay degraded');
  assert.equal(at(1012, 1), 0, 'fits by the margin: go back');
  assert.equal(at(995, 0), 1, 'overflowing: degrade at once');
  assert.equal(at(1000, 0), 0, 'exact fit with no step change');
});

test('handleKey: Enter/Space toggle, Up collapses, Down expands', () => {
  assert.equal(handleKey('Enter', false), true);
  assert.equal(handleKey(' ', true), false);
  assert.equal(handleKey('ArrowUp', false), true);
  assert.equal(handleKey('Home', true), true);
  assert.equal(handleKey('ArrowDown', true), false);
  assert.equal(handleKey('End', false), false);
  assert.equal(handleKey('a', false), null);
  assert.equal(handleKey('ArrowLeft', false), null);
});

test('header markup: the title leads to the board, no nav tabs, never a second row', () => {
  const read = (f) => readFileSync(new URL(`../web/dashboard/${f}`, import.meta.url), 'utf8');
  const header = /<header[^]*?<\/header>/.exec(read('index.html'))[0];
  assert.match(header, /<h1><a id="home" href="#board" title="Board"/);
  assert.doesNotMatch(header, /<nav|role="tab/);
  const css = read('style.css');
  assert.match(css, /\.top \{[^}]*flex-wrap: nowrap/);
  assert.doesNotMatch(css, /\.top[^{]*\{[^}]*flex-wrap: wrap|h-phone|\.tabs/);
  for (const s of HEADER_STEPS.slice(1)) assert.ok(css.includes(`.top.h-${s} `) || css.includes(`.top.h-${s},`), `h-${s} has a style`);
});


test('dragSplit snaps only next to the strip and follows the pointer above it', () => {
  assert.equal(SNAP_PX, STRIP_PX + 24);
  assert.deepEqual(dragSplit(SNAP_PX - 1, 1000, 320), { strip: true });
  assert.deepEqual(dragSplit(SNAP_PX, 1000, 320), { strip: false, ratio: SNAP_PX / 1000 }, 'under the pane minimum while dragging');
  assert.deepEqual(dragSplit(180, 1000, 320), { strip: false, ratio: 0.18 });
  assert.deepEqual(dragSplit(900, 1000, 250), { strip: false, ratio: 0.75 }, 'second pane keeps its minimum');
  assert.equal(clampRatio(SNAP_PX / 1000, 1000, 180, 320), 0.18, 'released under the minimum');
});

test('keySplit: shrinking at the minimum collapses, growing from the strip restores', () => {
  const key = (k, cur) => keySplit(k, false, cur, 1000, 200, 300);
  assert.deepEqual(key('ArrowLeft', { strip: false, ratio: 0.21 }), { strip: false, ratio: 0.2 });
  for (const k of ['ArrowLeft', 'ArrowUp', 'PageUp']) assert.deepEqual(key(k, { strip: false, ratio: 0.2 }), { strip: true }, k);
  assert.deepEqual(key('Home', { strip: false, ratio: 0.5 }), { strip: true });
  for (const k of ['ArrowRight', 'ArrowDown', 'PageDown']) assert.deepEqual(key(k, { strip: true, ratio: 0.5 }), { strip: false }, k);
  assert.deepEqual(key('ArrowLeft', { strip: true, ratio: 0.5 }), { strip: true });
  assert.deepEqual(key('End', { strip: true, ratio: 0.5 }), { strip: false, ratio: 0.7 });
  assert.equal(key('a', { strip: true, ratio: 0.5 }), null);
});

test('readSplit/writeSplit: collapsing keeps the last width, per split and orientation', () => {
  const m = new Map();
  const store = { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
  assert.deepEqual(readSplit(store, 'board', false), { ratio: null, strip: false });
  writeSplit(store, 'board', false, { strip: false, ratio: 0.35 });
  writeSplit(store, 'board', false, { strip: true, ratio: 0.288 });
  assert.deepEqual(readSplit(store, 'board', false), { ratio: 0.35, strip: true });
  assert.deepEqual(readSplit(store, 'board', true), { ratio: null, strip: false });
  assert.deepEqual(readSplit(store, 'history', false), { ratio: null, strip: false });
  writeSplit(store, 'board', false, { strip: false });
  assert.deepEqual(readSplit(store, 'board', false), { ratio: 0.35, strip: false });
});

test('hiddenAfter counts the strip items past the visible end', () => {
  assert.equal(hiddenAfter([40, 80, 120, 160], 100), 2);
  assert.equal(hiddenAfter([40, 80], 80), 0);
});

test('the strip is as wide in the stylesheet as in the logic', () => {
  const css = readFileSync(new URL('../web/dashboard/style.css', import.meta.url), 'utf8');
  assert.equal(css.split(`${STRIP_PX}px 1rem minmax(0, 1fr)`).length - 1, 2, 'side by side and stacked');
});

test('no style meant for something else hits a split view in strip mode', () => {
  const read = (f) => readFileSync(new URL(`../web/dashboard/${f}`, import.meta.url), 'utf8');
  const css = read('style.css').replace(/\/\*[\s\S]*?\*\//g, '');
  const uses = css.match(new RegExp(`[^\\s,{}>+~]*\\.${STRIP_CLASS}(?![\\w-])[^\\s,{}>+~]*`, 'g')) ?? [];
  assert.ok(uses.length > 0);
  for (const sel of uses) assert.equal(sel, `.split.${STRIP_CLASS}`);
  // Nothing else puts the class on an element.
  for (const f of ['app.js', 'index.html']) assert.doesNotMatch(read(f), new RegExp(`['" ]${STRIP_CLASS}['" ]`), f);
});
