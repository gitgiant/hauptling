// Pure layout logic for the dashboard: split sizes, the header's degrade steps and its collapse handle.
// No DOM access here, so node:test can cover it (test/layout.test.mjs).

/** Media query under which split views stack (list above, detail below). */
export const STACKED_QUERY = '(max-width: 800px), (orientation: portrait)';

/** Thickness of the header handle (a horizontal splitter; same as the 1rem pane splitter), px. */
export const HANDLE_PX = 16;

/**
 * Clamps the first pane's share of a split so both panes keep their minimum size.
 * @param {number} ratio  wanted share of the first pane, 0..1
 * @param {number} total  px available to both panes (splitter excluded)
 * @param {number} minA   minimum px of the first pane
 * @param {number} minB   minimum px of the second pane
 * @returns {number} the clamped share; when both minimums don't fit, they share the room proportionally
 */
export function clampRatio(ratio, total, minA, minB) {
  if (!(total > 0)) return Number.isFinite(ratio) ? Math.min(1, Math.max(0, ratio)) : 0.5;
  if (minA + minB >= total) return minA / (minA + minB || 1);
  const r = Number.isFinite(ratio) ? ratio : 0.5;
  return Math.min(1 - minB / total, Math.max(minA / total, r));
}

/**
 * A stored split value: a finite share strictly between 0 and 1, else null.
 * @param {string|null} raw  what localStorage returned
 */
export function parseRatio(raw) {
  if (raw == null || raw === '') return null;
  const r = Number(raw);
  return Number.isFinite(r) && r > 0 && r < 1 ? r : null;
}

/**
 * The default share of a split: a fraction, or `{ px }` for a pane with a natural width.
 * @param {number|{px:number}} def
 * @param {number} total
 */
export function defaultRatio(def, total) {
  if (typeof def === 'number') return def;
  return total > 0 ? def.px / total : 0.25;
}

/** localStorage key of a split's size, per orientation. */
export const splitKey = (id, stacked) => `hl-split-${id}-${stacked ? 'v' : 'h'}`;

/**
 * The share after a key press on a splitter, or null if the key doesn't move it.
 * Left/Up shrink the first pane, Right/Down grow it; Shift moves 5x; Home/End go to the limits.
 * @param {string} key  KeyboardEvent.key
 * @param {boolean} shift
 * @param {number} ratio  current share
 * @param {number} total  px available to both panes
 * @param {number} minA
 * @param {number} minB
 */
export function keyRatio(key, shift, ratio, total, minA, minB) {
  const step = (shift ? 0.1 : 0.02);
  let r;
  if (key === 'ArrowLeft' || key === 'ArrowUp') r = ratio - step;
  else if (key === 'ArrowRight' || key === 'ArrowDown') r = ratio + step;
  else if (key === 'PageUp') r = ratio - 0.1;
  else if (key === 'PageDown') r = ratio + 0.1;
  else if (key === 'Home') r = 0;
  else if (key === 'End') r = 1;
  else return null;
  return clampRatio(r, total, minA, minB);
}

/**
 * Whether a vertical drag on the header (or on its handle) ends collapsed.
 * Collapses when dragged up past a third of the header's height (at least 24 px) or flicked up;
 * expands when dragged down past 24 px, flicked down, or merely clicked.
 * @param {{collapsed:boolean, dy:number, vy:number, height:number}} g
 *   collapsed: state when the drag started; dy: px moved (negative = up);
 *   vy: px/ms over the last moments (negative = up); height: the header's full height
 * @returns {boolean} collapsed after the gesture
 */
export function collapseAfterDrag({ collapsed, dy, vy, height }) {
  const FLICK = 0.5; // px/ms
  if (!collapsed) {
    const far = -dy >= Math.max(24, height / 3);
    const flick = vy <= -FLICK && dy <= -8;
    return far || flick;
  }
  const click = Math.abs(dy) < 4;
  const far = dy >= 24;
  const flick = vy >= FLICK && dy >= 8;
  return !(click || far || flick);
}

/** Whether a pointerdown target should start a header drag (not on interactive children). */
export const DRAG_IGNORE = 'button, a, input, textarea, select, label, [role=tab], [contenteditable]';

/**
 * How the one-row header degrades as the window narrows, one step at a time; each step keeps the ones before it:
 * no host name; no sparklines; short labels (live and theme as icons); GPU and test details only in the ⋯ popover;
 * usage chips as bare bars; Report as an icon; tight spacing without Mem, spend and the test count;
 * last (`min`), theme and Report move into the popover and the usage chips are clipped to the room left.
 * The title, CPU and GPU numbers and the ⋯ button stay at every step.
 */
export const HEADER_STEPS = ['full', 'no-host', 'no-spark', 'short', 'brief', 'minis', 'icons', 'tight', 'min'];

/** The header's classes for a step: every degrade up to and including it (`h-no-spark`, `h-short`, …). */
export function stepClasses(step) {
  return HEADER_STEPS.slice(1, step + 1).map(s => `h-${s}`);
}

/**
 * The least degraded step whose row fits, else the last (it shrinks to the window).
 * Going back to a less degraded step than the current one needs `margin` px to spare, so a
 * number ticking from 9% to 10% can't make the header flip between two steps.
 * @param {(step:number) => number} slack  px left over on the row at a step (negative: it overflows)
 * @param {number} current  the step in use now
 * @param {number} [margin]
 * @returns {number}
 */
export function pickStep(slack, current, margin = 12) {
  const last = HEADER_STEPS.length - 1;
  for (let s = 0; s < last; s++) if (slack(s) >= (s < current ? margin : 0)) return s;
  return last;
}

/**
 * The header's collapsed state after a key press on its handle, or null if the key doesn't act.
 * Enter/Space toggle; Up/PageUp/Home collapse; Down/PageDown/End expand.
 * @param {string} key  KeyboardEvent.key
 * @param {boolean} collapsed
 */
export function handleKey(key, collapsed) {
  if (key === 'Enter' || key === ' ') return !collapsed;
  if (key === 'ArrowUp' || key === 'PageUp' || key === 'Home') return true;
  if (key === 'ArrowDown' || key === 'PageDown' || key === 'End') return false;
  return null;
}
