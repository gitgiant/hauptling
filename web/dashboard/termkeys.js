// Web terminal keys: browser key events to tmux send-keys items ({ t: 'key', v: name } | { t: 'lit', v: text }).

export const NAMED = { Enter: 'Enter', Backspace: 'BSpace', Escape: 'Escape', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
  Home: 'Home', End: 'End', PageUp: 'PPage', PageDown: 'NPage', Delete: 'DC', Insert: 'IC' };

/** The send-keys item for a keydown, or null to leave it to the browser (or to the `input` event on a phone). */
export function keyFor(e) {
  if (e.metaKey || e.isComposing) return null;
  if (e.ctrlKey && /^[a-z]$/i.test(e.key)) return { t: 'key', v: `C-${e.key.toLowerCase()}` };
  if (e.key === 'Tab') return { t: 'key', v: e.shiftKey ? 'BTab' : 'Tab' };
  if (NAMED[e.key]) return { t: 'key', v: NAMED[e.key] };
  if (e.key.length === 1 && !e.ctrlKey && !e.altKey) return { t: 'lit', v: e.key };
  return null;
}

/** On-screen keys for touch devices, whose soft keyboards have no Esc, Tab, arrows or Ctrl. */
export const TOUCH_KEYS = [['Esc', 'Escape'], ['Tab', 'Tab'], ['↑', 'Up'], ['↓', 'Down'], ['←', 'Left'], ['→', 'Right'], ['⏎', 'Enter'], ['^C', 'C-c']];
