// Usage windows as the Usage page shows them. agy's plan has two quota pools: Gemini models ('5h', 'week') and
// Claude and GPT models, stored as '3p-5h' and '3p-week' (src/usage.mjs "Quota pools").
// No DOM access here, so node:test can cover it (test/vendors.test.mjs).

const THIRD_PARTY = '3p-';
const pooled = (window) => String(window).startsWith(THIRD_PARTY);

/** "5h"; for agy "Gemini 5h" or "Claude/GPT 5h". @param {string} window @param {string} [vendor] */
export function windowLabel(window, vendor) {
  if (pooled(window)) return `Claude/GPT ${String(window).slice(THIRD_PARTY.length)}`;
  return vendor === 'agy' ? `Gemini ${window}` : String(window);
}

/** A copy in display order: the vendor's own pool first, and 5h before week within a pool. */
export function sortWindows(limits) {
  const rank = (l) => (pooled(l.window) ? 2 : 0) + (String(l.window).endsWith('5h') ? 0 : 1);
  return [...limits].sort((a, b) => rank(a) - rank(b));
}
