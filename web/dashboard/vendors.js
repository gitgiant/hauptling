// Vendor badges: one table entry per vendor. Own simple marks (a letter on a coloured tile), not brand artwork.
// Colours are CSS variables (--v-<key>-bg / --v-<key>-fg in style.css); add a vendor = one entry here + two variables per theme.
// No DOM access here, so node:test can cover it (test/vendors.test.mjs).

const VENDORS = {
  claude: { label: 'Claude', glyph: 'C' },
  codex: { label: 'Codex', glyph: 'X' },
  agy: { label: 'agy', glyph: 'G' },
};

/** @param {string|null|undefined} vendor @returns {{key: string, label: string, glyph: string}} */
export function vendorBadge(vendor) {
  const v = typeof vendor === 'string' && Object.hasOwn(VENDORS, vendor) ? vendor : null;
  return v ? { key: v, ...VENDORS[v] } : { key: 'unknown', label: vendor ? `Unknown vendor (${vendor})` : 'Unknown vendor', glyph: '?' };
}
