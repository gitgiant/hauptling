// The ⋯ menu's update section (PRD "Update from the dashboard"). Pure: app.js draws what these return.

/**
 * What to show for `u`: null (not checked), { checking }, { report } (a check's answer), { error }, or the
 * broker's progress { phase, from, to, error? }; { phase: 'done', to } after the restart.
 */
export function updateView(u) {
  const view = (text, extra = {}) => ({ text, commits: [], apply: false, busy: false, error: false, ...extra });
  if (!u) return view('');
  if (u.error) return view(u.error, { error: true });
  if (u.checking) return view('Checking…', { busy: true });
  if (u.phase === 'done') return view(`Updated to ${u.to}`);
  if (u.phase) return view(`Updating to ${u.to}: ${u.phase}…`, { busy: true });
  const r = u.report;
  if (!r.behind) return view(`Up to date (${r.current})${r.ahead ? `, ${r.ahead} ahead of main` : ''}`);
  const more = r.behind - r.commits.length;
  return view(`${r.behind} new commit${r.behind === 1 ? '' : 's'}`, { commits: more > 0 ? [...r.commits, `… and ${more} more`] : r.commits, apply: true });
}

/**
 * A stream opened and said `hello` { boot, assets }; `first` is what the first one said (null for it).
 * Reload when the page's files changed; a new broker with the same files ends a restart.
 */
export function afterHello(first, hello, update) {
  if (!first) return { reload: false, update };
  if (hello.assets !== first.assets) return { reload: true, update };
  return { reload: false, update: update?.phase === 'restarting' && hello.boot !== first.boot ? { phase: 'done', to: update.to } : update };
}
