import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clampRatio, parseRatio, defaultRatio, splitKey, keyRatio, collapseAfterDrag } from '../web/dashboard/layout.js';

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
  assert.equal(open(-40, 0, 150), false, 'a tall (wrapped) header needs a third of its height');
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
