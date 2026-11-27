// The Board strip (PRD "Collapse to a strip"): one icon per active delegator, below it a status dot per agent.
// `h` (app.js) is passed in and nothing else touches the DOM, so node:test can cover it (test/strip.test.mjs).
import { vendorBadge } from './vendors.js';
import { starting } from './wheel.js';

/** Dots shown per delegator (4 rows of 3; the stacked strip: 3 rows of 4); the rest count into “+N”. */
export const STRIP_DOTS = 12;

/** The dot's class: grey for an agent whose host is offline or lost, never the working spinner. */
export const dotState = (a) => (a.host_state ? `host-${a.host_state}` : a.state);

const status = (a) => (a.host_state ? `host ${a.host_state}` : starting(a) ? 'starting' : a.state);

/**
 * Two letters for a repo: the first letters of its name's first two words, else (one word) its first letter and
 * the consonant opening its last syllable (nullpunkt: NP, hauptling: HL), else its first two letters.
 * @param {string|null|undefined} repo  `owner/name` or a local path
 */
export function repoInitials(repo) {
  const name = String(repo ?? '').replace(/\/+$/, '').split('/').pop().replace(/\.git$/, '');
  const words = name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  if (!words.length) return '?';
  if (words.length > 1) return (words[0][0] + words[1][0]).toUpperCase();
  const w = words[0], onset = /.([^aeiouy\d])[aeiouy]+[^aeiouy]*$/i.exec(w);
  return (onset ? w[0] + onset[1] : w.slice(0, 2)).toUpperCase();
}

/**
 * The Board's groups (delegator · repo, in board order) merged into one entry per delegator.
 * @param {Map<string, object[]>} groups  `delegator|repo` → its live agents, sorted
 * @returns {{id: string, key: string, repos: string[], agents: object[]}[]}  `key`: the delegator's first group
 */
export function byDelegator(groups) {
  const out = new Map();
  for (const [key, list] of groups) {
    const id = key.slice(0, key.indexOf('|')), repo = key.slice(key.indexOf('|') + 1);
    if (!out.has(id)) out.set(id, { id, key, repos: [], agents: [] });
    const d = out.get(id);
    if (repo) d.repos.push(repo);
    d.agents.push(...list);
  }
  return [...out.values()];
}

/** Tooltip of a delegator's icon: repo, id, CLI and agents per state. */
export function delegatorTitle(d, cli) {
  const counts = new Map();
  for (const a of d.agents) counts.set(status(a), (counts.get(status(a)) ?? 0) + 1);
  return [d.repos.join(', ') || 'No repo', d.id, cli ? vendorBadge(cli).label : 'Unknown CLI',
    [...counts].map(([s, n]) => `${n} ${s}`).join(', ') || 'no agents'].join(' · ');
}

/**
 * One delegator in the strip. `onGroup(key)` shows its group on the Board, `onAgent(id)` selects an agent.
 * @param {Function} h
 * @param {ReturnType<typeof byDelegator>[number]} d
 */
export function stripGroup(h, d, { cli, selected, onGroup, onAgent }) {
  const title = delegatorTitle(d, cli), hidden = d.agents.length - STRIP_DOTS;
  const dot = (a) => {
    const label = `${a.id} · ${a.title} · ${status(a)}`, on = selected === a.id;
    return h('button', { type: 'button', class: `mini-dot${on ? ' selected' : ''}`, 'data-id': a.id, title: label, 'aria-label': label, 'aria-current': on ? 'true' : null, onclick: () => onAgent(a.id) },
      h('span', { class: `dot ${starting(a) ? 'starting' : dotState(a)}`, 'aria-hidden': 'true' }));
  };
  return h('div', { class: 'mini-group' },
    h('button', { type: 'button', class: `mini-icon ring-${vendorBadge(cli).key}`, 'data-id': d.id, title, 'aria-label': title, onclick: () => onGroup(d.key) }, repoInitials(d.repos[0])),
    d.agents.length ? h('div', { class: 'mini-dots' }, d.agents.slice(0, STRIP_DOTS).map(dot),
      hidden > 0 ? h('button', { type: 'button', class: 'mini-over', 'data-id': d.id, title: `${hidden} more agents on the Board`, onclick: () => onGroup(d.key) }, `+${hidden}`) : null) : null);
}
