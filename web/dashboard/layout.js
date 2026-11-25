// Pure layout logic for the dashboard: split sizes and the header collapse gesture.
// No DOM access here, so node:test can cover it (test/layout.test.mjs).

/** Media query under which split views stack (list above, detail below). */
export const STACKED_QUERY = '(max-width: 800px), (orientation: portrait)';

/** Height of the strip left at the top when the header is collapsed, px. */
export const STRIP_PX = 6;

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
 * Whether a vertical drag on the header (or on its collapsed tab) ends collapsed.
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
