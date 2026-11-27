// Queue reordering on the board (PRD "Queue priority"): which cards can trade places, and what to ask the broker.

/** Can this board row be moved? (`queue`: its position in the delegator's queue on the hub, else null.) */
export const movable = (a) => a.queue != null && !a.ended;
/** May `a` be dropped next to `b`? Same delegator; unparking agents form a group of their own at the front. */
export const canDrop = (a, b) => a.id !== b.id && movable(a) && movable(b) && a.delegator === b.delegator && Boolean(a.unpark) === Boolean(b.unpark);
/** A pointer over a card's box drops before it (upper half; left half when cards sit side by side) or after it. */
export const dropSide = ({ x, y }, { left, top, width, height }, columns = false) => ((columns ? x < left + width / 2 : y < top + height / 2) ? 'before' : 'after');

/** The move body for a key ('up', 'down', 'top') on agent `id`, or null when it is already there. */
export function keyMove(agents, id, key) {
  const me = agents.find(a => a.id === id);
  if (!me || !movable(me)) return null;
  const group = agents.filter(a => a.id === id || canDrop(me, a)).sort((x, y) => x.queue - y.queue);
  const at = group.findIndex(a => a.id === id);
  if (key === 'top') return at > 0 ? { top: true } : null;
  const other = group[at + (key === 'up' ? -1 : 1)];
  return other ? { [key === 'up' ? 'before' : 'after']: other.id } : null;
}
