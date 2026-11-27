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

test('usage windows: agy shows its two pools, own pool first and 5h before week', async () => {
  const { windowLabel, sortWindows } = await import('../web/dashboard/windows.js');
  assert.deepEqual(sortWindows([{ window: '3p-week' }, { window: 'week' }, { window: '3p-5h' }, { window: '5h' }]).map(l => windowLabel(l.window, 'agy')),
    ['Gemini 5h', 'Gemini week', 'Claude/GPT 5h', 'Claude/GPT week']);
  assert.deepEqual(sortWindows([{ window: 'week' }, { window: '5h' }]).map(l => windowLabel(l.window, 'codex')), ['5h', 'week']);
});
