// Start progress (PRD "Start progress"): a spinner with the step a starting agent is at and the seconds spent in it.
// `h` (app.js) is passed in and nothing else touches the DOM, so node:test can cover it (test/wheel.test.mjs).

/** Is `a` starting (spawn, restart or unpark) on a host we can hear from? */
export const starting = (a) => ['spawning', 'restarting'].includes(a.state) && !a.host_state;

export function elapsed(since, now = Date.now()) {
  const t = Date.parse(since);
  return Number.isFinite(t) ? `${Math.max(0, Math.floor((now - t) / 1000))} s` : '';
}

export const spinner = (h) => h('span', { class: 'spinner', 'aria-hidden': 'true' });

const label = (a, now) => [a.step || 'starting', elapsed(a.step_at, now)].filter(Boolean).join(' · ');

/** The wheel for a starting agent, else null. */
export function wheel(h, a, { centred = false, now = Date.now() } = {}) {
  if (!starting(a)) return null;
  return h('div', { class: `wheel${centred ? ' centred' : ''}` }, spinner(h),
    h('span', { class: 'wtext', 'data-step': a.step || 'starting', 'data-since': a.step_at || '', text: label(a, now) }));
}

/** Where a start failed and why, for an agent it left failed or exited; else null. */
export function startFailure(h, a) {
  if (!a.step_error || !['failed', 'exited'].includes(a.state)) return null;
  return h('div', { class: 'startfail', text: `✕ failed while ${a.step || 'starting'}: ${a.step_error}` });
}

/** Advances the seconds of every wheel under `root`. */
export function tickWheels(root, now = Date.now()) {
  for (const el of root.querySelectorAll('.wheel .wtext')) el.textContent = label({ step: el.dataset.step, step_at: el.dataset.since }, now);
}
