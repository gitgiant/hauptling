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
