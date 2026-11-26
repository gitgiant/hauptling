import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keyFor, TOUCH_KEYS } from '../web/dashboard/termkeys.js';
import { terminalInputFocused } from '../web/dashboard/report.js';

test('keyFor: named keys, ctrl, tab, printable; leaves meta, composition and unknown keys to the browser', () => {
  assert.deepEqual(keyFor({ key: 'Enter' }), { t: 'key', v: 'Enter' });
  assert.deepEqual(keyFor({ key: 'ArrowDown' }), { t: 'key', v: 'Down' });
  assert.deepEqual(keyFor({ key: 'c', ctrlKey: true }), { t: 'key', v: 'C-c' });
  assert.deepEqual(keyFor({ key: 'Tab', shiftKey: true }), { t: 'key', v: 'BTab' });
  assert.deepEqual(keyFor({ key: '1' }), { t: 'lit', v: '1' });
  assert.equal(keyFor({ key: 'v', metaKey: true }), null);
  assert.equal(keyFor({ key: 'a', isComposing: true }), null, 'IME text arrives through the input event');
  assert.equal(keyFor({ key: 'Unidentified' }), null, 'iOS soft keys without a name go through the input event');
});

test('touch keys are all valid tmux key names', () => {
  for (const [, v] of TOUCH_KEYS) assert.match(v, /^(Escape|Tab|Up|Down|Left|Right|Enter|C-[a-z])$/);
});

test('terminalInputFocused: the live terminal or its phone keyboard field', () => {
  const el = (sel, prev) => ({ closest: (q) => (q === 'pre.term.live' && sel === 'pre' ? {} : null), matches: (q) => q === (sel === 'kb' ? '.term-kb' : 'pre.term.live') && sel !== 'pre-off', previousElementSibling: prev });
  const livePre = { matches: (q) => q === 'pre.term.live' };
  const deadPre = { matches: () => false };
  assert.equal(terminalInputFocused({ activeElement: el('pre') }), true);
  assert.equal(terminalInputFocused({ activeElement: el('kb', livePre) }), true);
  assert.equal(terminalInputFocused({ activeElement: el('kb', deadPre) }), false);
  assert.equal(terminalInputFocused({ activeElement: null }), false);
});
