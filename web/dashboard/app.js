// Hauptling dashboard (phase 4). Vanilla ES module; all data comes from the broker's /dash routes.
import { ansiFragment } from './ansi.js';
import { vendorBadge } from './vendors.js';
import { openReport, shouldOpenReport, terminalInputFocused } from './report.js';
import { keyFor, TOUCH_KEYS } from './termkeys.js';
import { testProgress } from './progress.js';
import { updateView, afterHello } from './update.js';
import { movable, canDrop, dropSide, keyMove } from './queue.js';
import { STACKED_QUERY, HANDLE_PX, DRAG_IGNORE, STRIP_PX, clampRatio, defaultRatio, splitKey, keyRatio, dragSplit, keySplit, readSplit, writeSplit, hiddenAfter, collapseAfterDrag, HEADER_STEPS, stepClasses, pickStep, handleKey } from './layout.js';
// Text from the store is always set with textContent (h() below), never parsed as HTML.

const $ = (sel) => document.querySelector(sel);
function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'text') el.textContent = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false) el.append(kid instanceof Node ? kid : String(kid));
  return el;
}

/** replaceChildren that skips null/false and flattens arrays, like h(). */
const put = (el, ...kids) => el.replaceChildren(...kids.flat(Infinity).filter(k => k != null && k !== false));

const api = {
  async get(path) {
    const r = await fetch(path, { credentials: 'same-origin' });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(body.error || r.statusText);
    return body;
  },
  async post(path, data = {}) {
    const r = await fetch(path, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-hauptling': '1' }, body: JSON.stringify(data) });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(body.error || r.statusText);
    return body;
  },
};

function toast(msg, err = false, ms = err ? 6000 : 2500) {
  const t = h('div', { class: `toast${err ? ' err' : ''}`, role: 'status' }, msg);
  document.body.append(t);
  setTimeout(() => t.remove(), ms);
}
async function act(name, args, done) {
  try {
    const r = (await api.post(`/dash/do/${name}`, args))?.result;
    // An agent on a satellite that is offline: the hub stored it as a command (PRD "Several hosts").
    toast(r?.queued ? `Queued: will run when ${r.host} reconnects` : done);
  } catch (e) { toast(`${name}: ${e.message}`, true); }
}

const ago = (iso) => {
  if (!iso) return '';
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return `${Math.floor(s)}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  return `${Math.floor(s / 86400)}d`;
};
const clock = (iso) => new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
/** Small vendor badge for before an agent id. */
function vbadge(vendor) {
  const b = vendorBadge(vendor);
  return h('span', { class: `vbadge v-${b.key}`, role: 'img', title: b.label, 'aria-label': b.label, text: b.glyph });
}
const isLocal = (a) => a.repo.startsWith('/');

// ---------- theme: dark by default, light on request, remembered per browser ----------
function setTheme(t) {
  document.documentElement.dataset.theme = t;
  localStorage.setItem('hl-theme', t);
  const b = $('#theme');
  put(b, t === 'dark' ? '☀' : '☾', h('span', { class: 'long', text: t === 'dark' ? ' Light' : ' Dark' }));
  b.setAttribute('aria-label', `Switch to ${t === 'dark' ? 'light' : 'dark'} mode`);
  b.title = `Switch to ${t === 'dark' ? 'light' : 'dark'} mode`;
}
setTheme(localStorage.getItem('hl-theme') === 'light' ? 'light' : 'dark');
$('#usagebar').addEventListener('click', () => show(state.view === 'usage' ? 'board' : 'usage'));
const toggleTheme = () => setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
$('#theme').addEventListener('click', toggleTheme);

// ---------- header: one row while it fits, degrading step by step (layout.js HEADER_STEPS) ----------
const top = $('header.top');
let headerStep = 0;
/** Tries the steps on the live header (synchronously, so nothing paints in between) and keeps the first that fits. */
function fitHeader() {
  const apply = (s) => {
    for (const [i, name] of HEADER_STEPS.entries()) if (i) top.classList.toggle(`h-${name}`, stepClasses(s).includes(`h-${name}`));
  };
  const slack = (s) => { // its one-row width at max-content vs the window
    apply(s);
    top.classList.add('measuring');
    const w = top.offsetWidth;
    top.classList.remove('measuring');
    return document.documentElement.clientWidth - w;
  };
  headerStep = pickStep(slack, headerStep);
  apply(headerStep);
  top.dataset.step = HEADER_STEPS[headerStep];
}
let fitQueued = false;
const queueFit = () => { if (!fitQueued) { fitQueued = true; requestAnimationFrame(() => { fitQueued = false; fitHeader(); }); } };
addEventListener('resize', queueFit);
new MutationObserver(queueFit).observe(top, { childList: true, subtree: true, characterData: true }); // chips, CPU, GPU re-render
document.fonts?.ready.then(queueFit);
fitHeader();

// The ⋯ popover: the views (theme and report too, once the header hides their buttons), then GPU details (jobs, free VRAM, queue controls).
function closeMore() { $('#gpu').classList.remove('open'); $('#gpu .more-btn')?.setAttribute('aria-expanded', 'false'); }
document.addEventListener('click', (e) => {
  const g = $('#gpu');
  if (e.target.closest('#gpu .more-btn')) { const open = !g.classList.contains('open'); g.classList.toggle('open', open); e.target.closest('button').setAttribute('aria-expanded', String(open)); return; }
  // The path at dispatch time: a button that re-rendered its own section is still inside the popover.
  if (g.classList.contains('open') && !e.composedPath().some(n => n.matches?.('#gpu .pop'))) closeMore();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeMore();
});

// ---------- header handle: a horizontal splitter along its bottom edge; drag, click or keys hide and show it ----------
const handle = $('#top-handle');
let topFull = top.offsetHeight + HANDLE_PX;
let topCollapsed = localStorage.getItem('hl-top') === 'collapsed';
let topDragging = false;
/** --header-h is the header's visible height plus the handle; the layout (body padding, split view heights, handle position) follows it. */
const setHeaderH = (px) => document.documentElement.style.setProperty('--header-h', `${Math.round(px)}px`);
function applyTop() {
  top.classList.toggle('collapsed', topCollapsed);
  top.inert = topCollapsed;
  handle.setAttribute('aria-valuenow', topCollapsed ? '0' : '100');
  handle.setAttribute('aria-valuetext', topCollapsed ? 'header hidden' : 'header shown');
  handle.setAttribute('aria-label', topCollapsed ? 'Show the header' : 'Hide the header');
  handle.title = `${topCollapsed ? 'Show' : 'Hide'} the header: click, drag ${topCollapsed ? 'down' : 'up'}, or Enter`;
  setHeaderH(topCollapsed ? HANDLE_PX : topFull);
}
function setCollapsed(c) {
  topCollapsed = c;
  localStorage.setItem('hl-top', c ? 'collapsed' : 'open');
  applyTop();
}
new ResizeObserver(() => { topFull = top.offsetHeight + HANDLE_PX; if (!topDragging) applyTop(); }).observe(top);
applyTop();

let dragged = false; // the click that ends a drag must not also toggle
handle.addEventListener('click', (e) => {
  if (dragged) { dragged = false; return; }
  if (e.detail > 1) return; // a double-click toggles once, like a click
  setCollapsed(!topCollapsed);
});
handle.addEventListener('keydown', (e) => {
  const c = handleKey(e.key, topCollapsed);
  if (c == null) return;
  e.preventDefault();
  if (c !== topCollapsed) setCollapsed(c);
});

/** Vertical drag on the handle (either state) or on the open header's background: follows the pointer, then snaps. */
function dragHeader(e) {
  const el = e.currentTarget;
  if (e.button !== 0 || (el === top && (topCollapsed || e.target.closest(DRAG_IGNORE)))) return;
  if (el === handle) e.preventDefault(); // no text selection, like the pane splitters
  const from = topCollapsed, y0 = e.clientY;
  let lastY = y0, lastT = e.timeStamp, vy = 0, moved = false;
  dragged = false;
  el.setPointerCapture(e.pointerId);
  const height = topFull - HANDLE_PX;
  const offset = (dy) => Math.max(-height, Math.min(0, (from ? -height : 0) + dy));
  const move = (ev) => {
    const dy = ev.clientY - y0;
    if (!moved && Math.abs(dy) < 4) return;
    if (!moved) { moved = true; topDragging = true; top.classList.add('dragging'); handle.classList.add('dragging'); document.body.classList.add('dragging-top'); }
    const dt = ev.timeStamp - lastT;
    if (dt > 0) { vy = 0.7 * ((ev.clientY - lastY) / dt) + 0.3 * vy; lastY = ev.clientY; lastT = ev.timeStamp; }
    const off = offset(dy);
    top.style.transform = `translateY(${off}px)`;
    setHeaderH(topFull + off);
  };
  const end = (ev) => {
    el.removeEventListener('pointermove', move);
    el.removeEventListener('pointerup', end);
    el.removeEventListener('pointercancel', end);
    if (!moved) return; // a click: the handle's click listener toggles
    dragged = el === handle;
    topDragging = false;
    top.style.transform = '';
    top.classList.remove('dragging');
    handle.classList.remove('dragging');
    document.body.classList.remove('dragging-top');
    if (ev.type === 'pointercancel') { applyTop(); return; } // e.g. the browser took over a sideways scroll
    if (ev.timeStamp - lastT > 120) vy = 0; // held still before letting go: no flick
    const c = collapseAfterDrag({ collapsed: from, dy: ev.clientY - y0, vy, height });
    if (c !== topCollapsed) setCollapsed(c); else applyTop();
  };
  el.addEventListener('pointermove', move);
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
}
top.addEventListener('pointerdown', dragHeader);
handle.addEventListener('pointerdown', dragHeader);

// ---------- splitters between the panes of each split view ----------
const stacked = matchMedia(STACKED_QUERY);
/** Defaults and minimum px of [first, second] pane, side by side and stacked; `strip`: collapses to a strip. */
const SPLITS = {
  board: { def: [0.4, 0.45], min: [[288, 320], [96, 140]], strip: true },
  history: { def: [0.4, 0.45], min: [[288, 320], [96, 140]], strip: true },
  db: { def: [{ px: 208 }, 0.3], min: [[128, 320], [64, 140]] },
};
/** Wires one splitter; returns `expand()`, which restores a collapsed first pane. */
function initSplitter(sp) {
  const id = sp.dataset.split, cfg = SPLITS[id], view = sp.parentElement, first = sp.previousElementSibling;
  Object.assign(sp, { tabIndex: 0 });
  sp.setAttribute('role', 'separator');
  sp.setAttribute('aria-controls', first.id);
  sp.setAttribute('aria-valuemin', '0');
  sp.setAttribute('aria-valuemax', '100');
  sp.title = `Drag or use the arrow keys to resize; double-click to ${cfg.strip ? 'collapse or expand' : 'reset'}`;
  let ratio = 0.4, strip = false;
  const geo = () => {
    const st = stacked.matches, cs = getComputedStyle(view), r = view.getBoundingClientRect();
    const [a, b] = st ? [parseFloat(cs.paddingTop), parseFloat(cs.paddingBottom)] : [parseFloat(cs.paddingLeft), parseFloat(cs.paddingRight)];
    const total = (st ? r.height : r.width) - a - b - (st ? sp.offsetHeight : sp.offsetWidth);
    return { st, total, start: (st ? r.top : r.left) + a, min: cfg.min[st ? 1 : 0] };
  };
  /** Applies a state; `ratio` is ignored while collapsed. */
  const set = (want, save) => {
    const g = geo();
    strip = !!want.strip;
    if (!strip) ratio = clampRatio(want.ratio, g.total, ...g.min);
    view.classList.toggle('mini', strip);
    view.style.setProperty('--split', ratio.toFixed(4));
    sp.setAttribute('aria-orientation', g.st ? 'horizontal' : 'vertical');
    sp.setAttribute('aria-valuenow', String(Math.round((strip ? STRIP_PX / g.total : ratio) * 100)));
    if (save) writeSplit(localStorage, id, g.st, { strip, ratio });
  };
  const load = () => {
    const g = geo();
    if (g.total <= 0) return; // hidden view
    const s = readSplit(localStorage, id, g.st);
    ratio = clampRatio(s.ratio ?? defaultRatio(cfg.def[g.st ? 1 : 0], g.total), g.total, ...g.min);
    set({ strip: cfg.strip && s.strip, ratio }, false);
  };
  /** Collapses or restores the last stored width. */
  const collapse = (on) => { writeSplit(localStorage, id, stacked.matches, { strip: on }); load(); };
  new ResizeObserver(load).observe(view); // also fires when a hidden view is shown and when orientation flips
  sp.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    sp.setPointerCapture(e.pointerId);
    sp.classList.add('dragging');
    document.body.classList.add('resizing');
    const g = geo();
    const pos = (ev) => (g.st ? ev.clientY : ev.clientX) - g.start;
    const p0 = pos(e), grab = p0 - (strip ? STRIP_PX : ratio * g.total); // keep the handle where it was grabbed
    let moved = false;
    const move = (ev) => {
      if (!moved && Math.abs(pos(ev) - p0) < 3) return; // a click, or half of a double-click
      moved = true;
      const px = pos(ev) - grab;
      set(cfg.strip ? dragSplit(px, g.total, ...g.min) : { ratio: px / g.total }, false);
    };
    const end = () => {
      sp.removeEventListener('pointermove', move);
      sp.removeEventListener('pointerup', end);
      sp.removeEventListener('pointercancel', end);
      sp.classList.remove('dragging');
      document.body.classList.remove('resizing');
      if (!moved) return;
      set({ strip, ratio }, !strip);
      if (strip) collapse(true); // keeps the width stored before this drag
    };
    sp.addEventListener('pointermove', move);
    sp.addEventListener('pointerup', end);
    sp.addEventListener('pointercancel', end);
  });
  sp.addEventListener('keydown', (e) => {
    const g = geo();
    const next = cfg.strip
      ? keySplit(e.key, e.shiftKey, { strip, ratio }, g.total, ...g.min)
      : { ratio: keyRatio(e.key, e.shiftKey, ratio, g.total, ...g.min) };
    if (!next || next.ratio === null) return;
    e.preventDefault();
    if (next.strip) collapse(true);
    else if (next.ratio === undefined) collapse(false);
    else set(next, true);
  });
  sp.addEventListener('dblclick', () => {
    if (cfg.strip) return collapse(!strip);
    localStorage.removeItem(splitKey(id, stacked.matches));
    load();
  });
  return { expand: () => collapse(false) };
}
const splitters = Object.fromEntries([...document.querySelectorAll('.splitter[data-split]')].map(sp => [sp.dataset.split, initSplitter(sp)]));
$('#history-expand').addEventListener('click', () => { splitters.history.expand(); $('#history-q').focus(); });

// ---------- state ----------
const state = { board: null, selected: null, sub: 'terminal', view: 'board', histSelected: null, hello: null, update: null };

// ---------- views ----------
$('#home').addEventListener('click', (e) => {
  if (e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return; // open in a new tab or window
  e.preventDefault();
  show('board');
});
function show(view) {
  state.view = view;
  for (const b of document.querySelectorAll('#home, .pop button[data-view]')) markCurrent(b);
  $('#usagebar').setAttribute('aria-pressed', String(view === 'usage'));
  for (const v of ['board', 'usage', 'history', 'db']) $(`#view-${v}`).hidden = v !== view;
  if (view !== 'board') closeTerm();
  if (view === 'history') loadHistory();
  if (view === 'usage') loadUsage();
  if (view === 'db') loadTables();
  location.hash = view === 'board' ? (state.selected ? `agent=${state.selected}` : '') : view;
}

// ---------- live board ----------
function connect() {
  const es = new EventSource('/dash/stream');
  es.addEventListener('hello', (e) => {
    const hello = JSON.parse(e.data);
    const next = afterHello(state.hello, hello, state.update);
    state.hello ||= hello;
    if (next.reload) return location.reload();
    if (next.update !== state.update) { state.update = next.update; renderUpdate(); toast(`Updated to ${next.update.to}`); }
  });
  es.addEventListener('update', (e) => {
    const progress = JSON.parse(e.data);
    if (progress.error) toast(`Update: ${progress.error}`, true);
    state.update = progress;
    renderUpdate();
  });
  es.addEventListener('board', (e) => {
    state.board = JSON.parse(e.data);
    render();
    if (state.pending) { const id = state.pending; state.pending = null; select(id); }
  });
  es.addEventListener('host', (e) => { state.host = JSON.parse(e.data); renderSys(); });
  es.onopen = () => { $('#conn').className = 'conn live'; put($('#conn'), h('span', { class: 'long', text: 'live' })); $('#conn').title = 'Live updates: connected'; };
  es.onerror = () => {
    $('#conn').className = 'conn down'; put($('#conn'), h('span', { class: 'long', text: 'reconnecting…' })); $('#conn').title = 'Live updates: reconnecting…';
    // An error status (a proxy's 502 while the broker restarts) ends an EventSource for good: open another.
    if (es.readyState === 2) setTimeout(connect, 3000);
  };
}

// ---------- update (PRD "Update from the dashboard") ----------
/** The popover's update section: one element, kept across the popover's re-renders. */
const updateBox = document.createElement('div');
updateBox.className = 'update';
function renderUpdate() {
  const v = updateView(state.update);
  put(updateBox,
    h('button', { type: 'button', disabled: v.busy, onclick: checkUpdate }, 'Check for update'),
    v.text ? h('span', { class: v.error ? 'err' : '', role: 'status', text: v.text }) : null,
    v.commits.length ? h('ul', {}, v.commits.map(c => h('li', { text: c }))) : null,
    v.apply ? h('button', { type: 'button', onclick: applyUpdate }, 'Update and restart') : null);
}
async function checkUpdate() {
  state.update = { checking: true };
  renderUpdate();
  try { state.update = { report: await api.post('/dash/update/check') }; } catch (e) { state.update = { error: e.message }; }
  renderUpdate();
}
async function applyUpdate() {
  const { report } = state.update;
  if (!confirm(`Update to ${report.latest} and restart the broker? Running workers and test jobs keep going.`)) return;
  state.update = { phase: 'pulling', to: report.latest };
  renderUpdate();
  try {
    const r = await api.post('/dash/update/apply');
    if (r.upToDate) state.update = { report: { ...report, behind: 0, current: r.current } };
  } catch (e) { state.update = { error: e.message }; }
  renderUpdate();
}

function render() {
  const b = state.board;
  document.title = b.blocked ? `(${b.blocked}) Hauptling` : 'Hauptling';
  renderGpu(b.gpu, b.tests);
  renderSys();
  renderBoard(b);
  if (state.selected && renamedTo(state.selected)) select(state.selected);
  else if (state.selected) {
    const a = b.agents.find(x => x.id === state.selected);
    if (a) {
      const detail = $('#detail');
      renderDetailHead(a, detail);
      if (state.sub === 'terminal' && TERMINAL_STATES.includes(a.state) && (!state.term || state.term.ended)) renderSub(detail, a);
    }
  }
}

/** A 0–100 % history as a small line graph; null samples break the line. */
function spark(values, label) {
  const W = 60, H = 16, n = 120;
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('class', 'spark'); svg.setAttribute('width', W); svg.setAttribute('height', H); svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', label);
  const x = (i) => ((i + n - values.length) / (n - 1)) * W;
  const y = (v) => H - 1 - (Math.min(100, Math.max(0, v)) / 100) * (H - 2);
  let d = '';
  values.forEach((v, i) => { if (v == null) return; d += `${d && values[i - 1] != null ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`; });
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', d);
  svg.append(path);
  return svg;
}

function metric(name, v, values, title) {
  const mins = Math.round(((state.host?.every_s || 5) * 120) / 60);
  return h('span', { class: `metric${name ? ` m-${name.toLowerCase()}` : ''}`, title: `${title}; graph: last ${mins} min` }, name ? `${name} ` : null, h('b', { text: v == null ? '?' : `${v}%` }), spark(values, `${name} over the last ${mins} minutes`));
}

function renderSys() {
  const l = state.host;
  if (!l) return;
  put($('#sys'), l.name ? h('span', { class: 'hostname', title: `Host: ${l.name}`, text: l.name }) : null, metric('CPU', l.cpu, l.hist.cpu, 'Host CPU in use, all cores'), metric('Mem', l.mem, l.hist.mem, 'Host memory in use'));
  const g = $('#gpu .gpu-util');
  if (g) put(g, metric('', l.gpu, l.hist.gpu, 'GPU utilization'));
}

/** CPU test jobs: how many run of the limit; what runs now (agent, repo, elapsed) and how many wait go in `.more`. */
function cpuTests(q) {
  if (!q) return null;
  return h('span', { class: 'cputests', title: testsTip(q) }, 'Tests ', h('b', { text: `${q.running.length}/${q.limit}` }), h('span', { class: 'more' }, testDetails(q)));
}
const testsTip = (q) => `CPU test jobs, up to ${q.limit} at once, one per repo${[...q.running, ...(q.retrying || [])].length ? `\n${[
  ...q.running.map(r => `${r.id} ${r.purpose}${r.agent ? ` · ${r.agent}` : ''} · ${r.repo} · ${ago(r.claimed_at)}${r.retry ? ` · ${r.retry}` : ''}`),
  ...(q.retrying || []).map(r => `${r.id} ${r.purpose}${r.agent ? ` · ${r.agent}` : ''} · ${r.repo} · ${r.retry}`)].join('\n')}` : ''}`;
function testDetails(q) {
  return [q.running.map(r => h('span', { class: 'mono' }, `▶ ${r.agent || r.id} ${r.repo.split('/').pop()}${r.retry ? ` ${r.retry}` : ''} `, progressBar(r))),
    (q.retrying || []).map(r => h('span', { class: 'mono', text: `↻ ${r.agent || r.id} ${r.retry}` })),
    q.queued ? h('span', { text: `· ${q.queued} queued` }) : null];
}

/** A running job's progress: a bar (time against the typical run; sliding when there is none yet) and "1:23 / ~3:10 · 4 done". */
function progressBar(t) {
  const p = testProgress(t);
  return h('span', { class: `tprog${p.over ? ' over' : ''}`, title: p.tip },
    h('span', { class: `track${p.pct == null ? ' busy' : ''}` }, h('span', { class: 'fill', style: p.pct == null ? '' : `width:${Math.round(p.pct * 100)}%` })),
    h('span', { class: 'val', text: p.label }));
}

/** "Run now" for a queued CPU test job: starts it past the concurrency limit. */
function runNow(t) {
  if (t?.state !== 'queued' || t.gpu) return null;
  return h('button', { title: `Start ${t.id} now, past the test concurrency limit`, onclick: (e) => { e.stopPropagation(); act('test.run', { id: t.id }, `${t.id} started`); } }, 'Run now');
}

/**
 * Header GPU area: CPU tests, GPU state and load, then details (free VRAM, jobs, queue controls).
 * A ⋯ button opens a popover with the view links and the details; once the header is brief (layout.js
 * HEADER_STEPS) the inline details hide, so the popover is where they are. Without a GPU it holds the links only.
 */
function renderGpu(g, tq) {
  const el = $('#gpu');
  const cpu = cpuTests(tq);
  const open = el.classList.contains('open');
  const testSection = () => (tq ? h('div', {}, h('b', { text: `Tests ${tq.running.length}/${tq.limit}` }), testDetails(tq)) : null);
  if (!g?.available) { put(el, cpu, h('span', { text: g ? 'GPU: none' : 'GPU: ?' }), moreMenu(open, 'Views', 'Views and test job details', testSection())); return; }
  const running = g.running[0];
  const details = () => [
    h('span', { title: 'Free VRAM / what a job waits for', text: `${g.freeMB ?? '?'} MiB free` }),
    running ? h('span', { class: 'mono' }, `▶ ${running.id}${running.agent ? ` (${running.agent})` : ''} `, progressBar(running)) : null,
    g.queued.length ? h('span', { text: `${g.queued.length} queued${g.queued.some(q => q.waiting_since) ? ' · waiting for VRAM' : ''}` }) : null,
    g.paused
      ? h('button', { onclick: () => act('gpu.resume', {}, 'GPU queue resumed') }, 'Resume')
      : [h('button', { onclick: () => act('gpu.pause', {}, 'GPU queue paused; the running job finishes') }, 'Pause'),
        running ? h('button', { class: 'danger', onclick: () => confirm(`Kill ${running.id} and requeue it?`) && act('gpu.pause', { now: true }, `Paused; ${running.id} requeued`) }, 'Pause now') : null],
  ];
  const tip = [tq ? testsTip(tq) : null, `GPU ${g.paused ? 'paused' : running ? `busy: ${running.id}${running.agent ? ` (${running.agent})` : ''}` : 'idle'} · ${g.freeMB ?? '?'} MiB free${g.queued.length ? ` · ${g.queued.length} queued` : ''}`].filter(Boolean).join('\n');
  put(el, cpu,
    h('span', { title: tip }, 'GPU ', g.paused ? h('b', { text: 'paused' }) : h('b', { class: 'long', text: running ? 'busy' : 'idle' })),
    h('span', { class: 'gpu-util' }),
    h('span', { class: 'more' }, details()),
    moreMenu(open, `${tip}\n(click for views, details and queue controls)`, 'Views, GPU and test job details',
      testSection(),
      h('div', {}, h('b', { text: `GPU ${g.paused ? 'paused' : running ? 'busy' : 'idle'}` }), details())),
  );
}

/** The ⋯ button and its popover: the view links (plus theme and report at the last header step), then any detail sections. */
function moreMenu(open, title, label, ...sections) {
  const link = (view, text) => {
    const b = h('button', { type: 'button', 'data-view': view, onclick: () => { closeMore(); show(view); } }, text);
    markCurrent(b);
    return b;
  };
  const news = state.board?.update;
  const note = news ? `${news.behind} new commit${news.behind === 1 ? '' : 's'} on main` : null;
  return [h('button', { class: `more-btn${news ? ' has-update' : ''}`, type: 'button', title: note ? `${title}\n${note}` : title, 'aria-label': note ? `${label} (${note})` : label, 'aria-expanded': String(open) }, '⋯'),
    h('div', { class: 'pop', role: 'group', 'aria-label': label },
      h('div', { class: 'views' }, link('board', 'Board'), link('history', 'History'), link('db', 'Database')),
      h('div', { class: 'extra' },
        h('button', { type: 'button', onclick: () => { closeMore(); toggleTheme(); } }, 'Light / dark'),
        h('button', { type: 'button', onclick: () => { closeMore(); report(); } }, 'Report issue (F2)')),
      sections,
      updateBox)];
}
/** Marks the title (it leads to the board) or a popover view link when its view is shown. */
function markCurrent(b) {
  if ((b.dataset.view || 'board') === state.view) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
}

/** With satellites joined (the board has `hosts`): a small muted chip naming the agent's host; none otherwise. */
function hostChip(a) {
  return state.board?.hosts ? h('span', { class: 'chip host', title: a.host_state ? `host ${a.host_state}` : `runs on ${a.host}`, text: a.host }) : null;
}
/** The dot's class: grey for an agent whose host is offline or lost, never the working spinner. */
const dotState = (a) => (a.host_state ? `host-${a.host_state}` : a.state);

function card(a) {
  const meta = [
    h('span', { class: 'aid', title: `${a.vendor} · ${a.model} · ${a.branch}` }, vbadge(a.vendor), h('span', { class: 'mono', text: a.id })),
    hostChip(a),
    a.pr_url ? h('a', { href: a.pr_url, target: '_blank', rel: 'noopener', onclick: (e) => e.stopPropagation(), text: `PR #${a.pr_number}` }) : null,
    a.gate ? h('span', { text: `gate: ${a.gate}` }) : null,
    a.ci_note ? h('span', { class: 'chip fail', text: `CI failed ${a.ci_note.slice(0, 7)}` }) : null,
    testChip(a.test),
    a.ended || ['paused', 'restarting'].includes(a.state) ? null : runNow(a.test),
    usageChips(a.usage),
  ];
  const el = h('div', { class: `card ${dotState(a)}${state.selected === a.id ? ' selected' : ''}`, 'data-id': a.id, role: 'button', tabindex: '0', onclick: () => select(a.id), onkeydown: (e) => e.key === 'Enter' && select(a.id) },
    h('span', { class: `dot ${dotState(a)}`, title: a.host_state ? `host ${a.host_state}` : a.state }),
    h('span', { class: 'title', title: a.headline || a.title, text: a.headline || a.title }),
    h('span', { class: 'elapsed', title: `started ${clock(a.created_at)}`, text: ago(a.created_at) }),
    a.headline ? h('div', { class: 'prompt', title: `Prompt: ${a.title}`, text: a.title }) : null,
    h('div', { class: 'meta' }, movable(a) ? queueBadge(a, () => el) : null, meta),
  );
  if (movable(a)) dragSource(el, a);
  return el;
}

// ---------- queue order: drag a queued card onto another, or Alt+↑/↓/Home on it (PRD "Queue priority") ----------
let drag = null; // { a, el, over: { id, side } | null } while a card is being dragged; the board isn't re-rendered then
/** Marks where the dragged card would land under this point: a line on the target card. */
function dragOver(x, y) {
  const el = document.elementFromPoint(x, y)?.closest('#board .card');
  const b = el && state.board.agents.find(a => a.id === el.dataset.id);
  clearDropLine();
  const columns = Boolean(el) && el.offsetWidth * 1.5 < el.parentElement.clientWidth;
  drag.over = b && canDrop(drag.a, b) ? { id: b.id, side: dropSide({ x, y }, el.getBoundingClientRect(), columns) } : null;
  if (drag.over) el.classList.add(`drop-${drag.over.side}`, ...(columns ? ['drop-side'] : []));
  return Boolean(drag.over);
}
const clearDropLine = () => document.querySelectorAll('.drop-before, .drop-after').forEach(el => el.classList.remove('drop-before', 'drop-after', 'drop-side'));
function dragStart(el, a) {
  drag = { a, el, over: null };
  el.classList.add('dragging');
}
function dragEnd(drop) {
  if (!drag) return;
  const { a, el, over } = drag;
  drag = null;
  el.classList.remove('dragging');
  clearDropLine();
  renderBoard(state.board); // updates that arrived during the drag
  if (drop && over) moveQueued(a.id, { [over.side]: over.id });
}
async function moveQueued(id, to) {
  try { await api.post(`/dash/agents/${encodeURIComponent(id)}/move`, to); }
  catch (e) { toast(`move: ${e.message}`, true); }
}
function dragSource(el, a) {
  el.draggable = true;
  el.classList.add('movable');
  el.setAttribute('aria-keyshortcuts', 'Alt+ArrowUp Alt+ArrowDown Alt+Home');
  el.addEventListener('dragstart', (e) => {
    if (drag) { e.preventDefault(); return; } // a touch drag owns it
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', a.id); // Firefox starts no drag without data
    dragStart(el, a);
  });
  el.addEventListener('dragend', () => dragEnd(false));
  el.addEventListener('keydown', (e) => {
    const key = e.altKey && { ArrowUp: 'up', ArrowDown: 'down', Home: 'top' }[e.key];
    if (!key) return;
    e.preventDefault(); // Alt+Home is the browser's home page
    const to = keyMove(state.board.agents, a.id, key);
    if (to) moveQueued(a.id, to);
  });
}
/** "#2": the card's place in its delegator's queue, and the handle for dragging it by touch or pen. */
function queueBadge(a, card) {
  return h('span', { class: 'qpos', title: `#${a.queue} in ${a.delegator}'s queue. Drag to reorder, or Alt+↑/↓/Home on the card.`, text: `⠿ #${a.queue}`,
    onclick: (e) => e.stopPropagation(),
    onpointerdown: (e) => {
      if (e.pointerType === 'mouse' || drag) return; // the mouse uses native drag and drop
      e.preventDefault();
      const handle = e.currentTarget;
      handle.setPointerCapture(e.pointerId);
      dragStart(card(), a);
      const move = (ev) => { if (drag) dragOver(ev.clientX, ev.clientY); };
      const end = (ev) => {
        for (const [type, fn] of [['pointermove', move], ['pointerup', end], ['pointercancel', end]]) handle.removeEventListener(type, fn);
        dragEnd(ev.type === 'pointerup');
      };
      for (const [type, fn] of [['pointermove', move], ['pointerup', end], ['pointercancel', end]]) handle.addEventListener(type, fn);
    } });
}
$('#board').addEventListener('dragover', (e) => { if (drag && dragOver(e.clientX, e.clientY)) e.preventDefault(); });
$('#board').addEventListener('drop', (e) => { if (drag) { e.preventDefault(); dragEnd(true); } });

function testChip(t) {
  if (!t) return null;
  const label = `${t.gpu ? 'GPU ' : ''}${t.purpose === 'gate' ? 'gate' : 'test'}`;
  if (t.state === 'running') return h('span', { class: 'chip run', title: testProgress(t).tip }, `${label} `, progressBar(t));
  if (!t.status) return h('span', { class: 'chip run', text: `${label} ${t.state}` });
  return h('span', { class: `chip ${t.status}`, title: `${t.id} ${clock(t.at)}`, text: `${label} ${t.status} ${t.passed ?? 0}/${(t.passed ?? 0) + (t.failed ?? 0)}` });
}

/** Agent detail: the running test job's bar and its latest output line. */
function testRunning(t) {
  const p = testProgress(t);
  return h('div', { class: 'testrun' },
    h('div', {}, h('b', { text: `${t.gpu ? 'GPU ' : ''}${t.purpose === 'gate' ? 'gate' : 'test'} ${p.step || 'running'} ` }), progressBar(t)),
    p.line ? h('div', { class: 'mono tline', title: p.line, text: p.line }) : null);
}

const kfmt = (n) => (n == null ? '?' : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));
const money = (usd, estimated) => (usd == null ? '$?' : `${estimated ? '~' : ''}$${usd.toFixed(2)}`);
function usageChips(u) {
  if (!u) return null;
  return h('span', { class: 'usagechips', title: `${kfmt(u.tokens_in)} in / ${kfmt(u.tokens_out)} out tokens${u.cost_estimated ? ' · cost estimated' : ''}` },
    u.context_pct != null ? h('span', { text: `ctx ${Math.round(u.context_pct)}%` }) : null,
    h('span', { text: money(u.cost_usd, u.cost_estimated) }),
    h('span', { text: `${kfmt(u.tokens_in)}/${kfmt(u.tokens_out)} tok` }));
}

/** Board groups (delegator · repo) collapsed to status dots, remembered per browser. */
const shutGroups = new Set((() => { try { return JSON.parse(localStorage.getItem('hl-groups-shut') || '[]'); } catch { return []; } })());
function toggleGroup(key) {
  if (!shutGroups.delete(key)) shutGroups.add(key);
  localStorage.setItem('hl-groups-shut', JSON.stringify([...shutGroups]));
  renderBoard(state.board);
  [...document.querySelectorAll('#board .gtoggle')].find(b => b.closest('.group').dataset.key === key)?.focus();
}
const ORDER = { blocked: 0, exited: 1, failed: 1, working: 2, spawning: 3, waiting: 4, queued: 5, done: 6 };
/** Group-heading icon toggles for a delegator's merge gate and auto-merge: original 16 px glyphs, a slash through them when off. */
const ICONS = {
  gate: ['M8 1.5 2.8 3.4v4.2c0 3.2 2.2 5.6 5.2 6.9 3-1.3 5.2-3.7 5.2-6.9V3.4z', 'M5.6 8.1l1.7 1.7 3.2-3.4'],
  automerge: ['M3.5 2.5 8 7v6.5', 'M12.5 2.5 8 7', 'M5.8 11.5 8 13.7l2.2-2.2'],
};
function mergeToggle(d, delegator, kind) {
  const gate = kind === 'gate', on = !!delegator?.[kind];
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  for (const [k, v] of Object.entries({ viewBox: '0 0 16 16', width: 15, height: 15, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.6, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', focusable: 'false' })) svg.setAttribute(k, v);
  const path = (dd, cls) => { const p = document.createElementNS(ns, 'path'); p.setAttribute('d', dd); if (cls) p.setAttribute('class', cls); svg.append(p); };
  for (const dd of ICONS[kind]) path(dd);
  if (!on) path('M2 14 14 2', 'slash');
  const title = gate
    ? (on ? 'Merge gate on: click to merge without tests' : 'Merge gate off: click to run tests before merging')
    : (on ? 'Auto-merge on: click to stop at [ready] and merge yourself' : 'Auto-merge off: click to merge automatically');
  return h('button', { type: 'button', class: `gset${on ? ' on' : ''}`, 'aria-pressed': String(on), 'aria-label': gate ? 'Merge gate' : 'Auto-merge', title,
    onclick: () => {
      if (gate && on && !confirm(`Turn the merge gate off for ${d}? Reports will merge without a test job.`)) return;
      act('delegator.set', { delegator: d, [kind]: !on }, `${gate ? 'Gate' : 'Auto-merge'} ${on ? 'off' : 'on'} for ${d}`);
    } }, svg);
}
function renderBoard(b) {
  if (drag) return; // replacing the cards would end the drag
  const focused = document.activeElement?.matches?.('#board .card, #board .minibtn') ? document.activeElement : null;
  const [focusId, focusClass] = [focused?.dataset.id, focused?.classList.contains('card') ? 'card' : 'minibtn'];
  const miniAt = $('#board .mini-scroll');
  const [miniTop, miniLeft] = [miniAt?.scrollTop ?? 0, miniAt?.scrollLeft ?? 0];
  const active = new Map(b.delegators.map(d => [d.id, d]));
  const live = b.agents.filter(a => !a.ended && active.has(a.delegator));
  const recent = b.agents.filter(a => a.ended).sort((x, y) => (x.updated_at < y.updated_at ? 1 : -1));
  const groups = new Map();
  for (const a of live) {
    const key = `${a.delegator}|${a.repo}`; // delegator ids have no |
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(a);
  }
  const withAgents = new Set(live.map(a => a.delegator));
  for (const d of active.values()) {
    if (!withAgents.has(d.id)) groups.set(`${d.id}|${d.repo ?? ''}`, []);
  }
  const out = [];
  if (!groups.size) out.push(h('p', { class: 'empty', text: 'No active delegators. Start Claude, Codex or agy and run /delegator.' }));
  for (const [key, list] of groups) {
    const d = key.slice(0, key.indexOf('|')), repo = key.slice(key.indexOf('|') + 1);
    const idle = list.length === 0;
    const delegator = active.get(d);
    // Queued cards (paused ones too) go in queue order.
    const rank = (a) => (a.queue != null ? ORDER.queued : ORDER[a.state] ?? 9);
    list.sort((x, y) => rank(x) - rank(y) || (x.queue ?? 0) - (y.queue ?? 0) || (x.created_at < y.created_at ? -1 : 1));
    const shut = shutGroups.has(key);
    const toggleTitle = idle
      ? (shut ? 'Show delegator status' : 'Hide delegator status')
      : (shut ? 'Show the cards' : 'Hide the cards (keep the status dots)');
    out.push(h('div', { class: `group${shut ? ' shut' : ''}`, 'data-key': key },
      h('h2', {}, h('button', { class: 'gtoggle', type: 'button', 'aria-expanded': String(!shut), title: toggleTitle, onclick: () => toggleGroup(key) },
        h('span', { class: 'caret', 'aria-hidden': 'true', text: '▾' }), h('span', { class: 'mono', text: repo || 'No repo' }), ' · ', h('span', { class: 'mono', text: d }), shut && !idle ? h('span', { class: 'count', text: ` (${list.length})` }) : null),
      mergeToggle(d, delegator, 'gate'),
      mergeToggle(d, delegator, 'automerge')),
      idle
        ? (shut ? null : h('p', { class: 'empty', text: `No agents running · started ${ago(delegator.created_at)} ago${delegator.handoff_waiting ? ' · handoff waiting' : ''}` }))
        : shut
          ? h('div', { class: 'dots' }, list.map(a => h('button', { type: 'button', class: `dotbtn${state.selected === a.id ? ' selected' : ''}`, title: `${a.id} · ${a.host_state ? `host ${a.host_state}` : a.state}`, 'aria-label': `${a.id}, ${a.host_state ? `host ${a.host_state}` : a.state}`, onclick: () => select(a.id) }, h('span', { class: `dot ${dotState(a)}` }))))
          : h('div', { class: 'cards' }, list.map(card))));
  }
  if (recent.length) {
    const det = h('details', { class: 'recent', open: localStorage.getItem('hl-recent') === '1' }, h('summary', { text: `Recent, last 24 h (${recent.length})` }), h('div', { class: 'cards' }, recent.map(card)));
    det.addEventListener('toggle', () => {
      const v = det.open ? '1' : '0';
      if (localStorage.getItem('hl-recent') === v) return; // the event also fires for a re-rendered open list
      localStorage.setItem('hl-recent', v);
      renderBoard(state.board); // the strip lists the recent agents only while they are open
    });
    out.push(det);
  }
  const recentOpen = localStorage.getItem('hl-recent') === '1';
  put($('#board'), ...out, miniBoard([...groups.values(), recentOpen ? recent : []]));
  $('#board .mini-scroll').scrollTo(miniLeft, miniTop);
  miniMore();
  if (focused) $(`#board .${focusClass}[data-id="${CSS.escape(focusId)}"]`)?.focus({ preventScroll: true });
}

// ---------- board strip: the collapsed board, one icon per card (shown by CSS while .split.mini) ----------
function miniButton(a) {
  const v = vendorBadge(a.vendor), status = a.host_state ? `host ${a.host_state}` : a.state;
  const label = `${a.headline || a.title} · ${status}`, on = state.selected === a.id;
  return h('button', { type: 'button', class: `minibtn ${dotState(a)}${on ? ' selected' : ''}`, 'data-id': a.id, title: label, 'aria-label': `${v.label}: ${label}`, 'aria-current': on ? 'true' : null, onclick: () => select(a.id) },
    h('span', { class: `vbadge v-${v.key}`, 'aria-hidden': 'true', text: v.glyph }),
    h('span', { class: `dot ${dotState(a)}`, 'aria-hidden': 'true' }));
}
/** @param {object[][]} lists  agents per group, in board order */
function miniBoard(lists) {
  const scroll = h('div', { class: 'mini-scroll', onscroll: () => miniMore() },
    lists.filter(l => l.length).map(l => h('div', { class: 'mini-group' }, l.map(miniButton))));
  const more = h('button', { type: 'button', class: 'mini-more', title: 'Scroll to more agents', onclick: () => scroll.scrollBy(stacked.matches ? { left: scroll.clientWidth } : { top: scroll.clientHeight }) });
  return h('nav', { class: 'mini-list', 'aria-label': 'Agents' }, scroll, more);
}
/** Updates the strip's “+N”: the agents further down (stacked: further right). */
function miniMore() {
  const scroll = $('#board .mini-scroll');
  if (!scroll?.clientHeight) return; // not shown
  const st = stacked.matches, box = scroll.getBoundingClientRect();
  const ends = [...scroll.querySelectorAll('.minibtn')].map(b => { const r = b.getBoundingClientRect(); return st ? r.right - box.left + scroll.scrollLeft : r.bottom - box.top + scroll.scrollTop; });
  const n = hiddenAfter(ends, st ? scroll.scrollLeft + scroll.clientWidth : scroll.scrollTop + scroll.clientHeight);
  const more = $('#board .mini-more');
  more.textContent = `+${n}`;
  more.style.visibility = n ? 'visible' : 'hidden'; // keeps its room, so the count doesn't change what fits
}
new ResizeObserver(() => miniMore()).observe($('#board'));

// ---------- detail ----------
/** The id now of a renamed agent's old one (a queued agent that changed vendor), else undefined. */
const renamedTo = (id) => state.board?.agents.find(x => x.aliases?.includes(id))?.id;

function select(wanted) {
  const id = renamedTo(wanted) || wanted;
  closeTerm();
  state.selected = id;
  location.hash = `agent=${id}${state.sub !== 'terminal' ? `/${state.sub}` : ''}`;
  const a = state.board?.agents.find(x => x.id === id);
  if (!a) return;
  renderBoard(state.board);
  const el = $('#detail');
  put(el, h('div', { class: 'dhead' }), h('nav', { class: 'subtabs' }), h('div', { class: 'body' }));
  renderDetailHead(a, el);
  renderSub(el, a);
}

function renderDetailHead(a, el) {
  const head = el.querySelector('.dhead');
  if (!head) return;
  const reply = h('form', { class: 'reply', onsubmit: (e) => {
    e.preventDefault();
    const text = e.target.text.value.trim();
    if (text) act('reply', { agent: a.id, text }, a.ask ? 'Answer sent' : 'Message sent').then(() => { e.target.text.value = ''; });
  } }, h('input', { name: 'text', maxlength: '300', placeholder: a.ask ? 'Answer in your own words…' : `Message ${a.id}…`, 'aria-label': 'Reply' }), h('button', {}, a.ask ? 'Answer' : 'Send'));
  // Keep a half-typed reply across live refreshes.
  const old = head.querySelector('.reply input');
  if (old && old.value) reply.text.value = old.value;
  const hadFocus = old && document.activeElement === old;
  const dg = state.board?.delegators.find(x => x.id === a.delegator);
  const passed = a.test?.purpose === 'gate' && a.test?.status === 'pass';
  // Local repos always merge by hand; GitHub PRs only when the delegator turned auto-merge off.
  const canMerge = ['done', 'parked'].includes(a.state) && (isLocal(a) || (dg && !dg.automerge)) && (passed || a.gate === 'ci' || (dg && !dg.gate));
  put(head, 
    h('h2', { text: a.headline || a.title }),
    a.headline ? h('p', { class: 'prompt', title: 'Prompt (spawn title)', text: a.title }) : null,
    h('div', { class: 'meta' },
      h('span', { class: 'aid' }, vbadge(a.vendor), h('span', { class: 'mono', text: a.id })), hostChip(a), h('span', { text: a.host_state ? `host ${a.host_state}` : a.state }), h('span', { text: `${a.vendor} · ${a.model}${a.billing ? ` · ${a.billing === 'api' ? 'API' : 'plan'}` : ''}` }),
      h('span', { class: 'mono', text: `${a.branch} → ${a.base}` }), h('span', { class: 'mono', text: a.repo }),
      a.pr_url ? h('a', { href: a.pr_url, target: '_blank', rel: 'noopener', text: `PR #${a.pr_number}` }) : null,
      h('span', { text: `started ${clock(a.created_at)} (${ago(a.created_at)})` }),
      a.usage ? h('span', { text: `${a.usage.context_pct != null ? `context ${Math.round(a.usage.context_pct)}% · ` : ''}${money(a.usage.cost_usd, a.usage.cost_estimated)} · ${kfmt(a.usage.tokens_in)} in / ${kfmt(a.usage.tokens_out)} out` }) : null),
    a.ask ? h('div', { class: 'ask' }, h('p', { text: a.ask.question }),
      h('div', { class: 'choices' }, a.ask.choices.map((c, i) => h('button', { class: 'primary', onclick: () => act('answer', { ask: a.ask.id, choice: i }, `Answered: ${c}`) }, c)))) : null,
    a.report ? h('div', { class: 'report' }, h('b', { text: 'Report: ' }), a.report) : null,
    a.test?.state === 'running' ? testRunning(a.test) : null,
    a.spend ? h('div', { class: 'resets', title: 'Tokens, cost, usage-window points this task used, test rounds', text: `Spent: ${a.spend}` }) : null,
    a.ended ? null : reply,
    a.ended ? null : h('div', { class: 'actions' },
      canMerge ? h('button', { class: 'primary', onclick: () => act('merge', { agent: a.id }, `${a.id} merged into ${a.base}`) }, `Merge into ${a.base}`) : null,
      ['paused', 'restarting'].includes(a.state) ? null : runNow(a.test),
      a.state === 'paused'
        ? h('button', { onclick: () => act('unpause', { agent: a.id }, `${a.id} resumed`) }, 'Resume')
        : ['queued', 'working', 'blocked', 'done', 'parked'].includes(a.state)
          ? h('button', { onclick: () => act('pause', { agent: a.id }, `${a.id} paused`) }, 'Pause') : null,
      ['working', 'blocked', 'done', 'parked', 'paused', 'exited', 'failed', 'restarting'].includes(a.state) && a.slot
        ? h('button', { onclick: () => confirm(`Restart ${a.id}? Its branch and working tree will be kept.`) && act('restart', { agent: a.id }, `${a.id} restarted`) }, 'Restart') : null,
      h('button', { class: 'danger', onclick: () => confirm(`Kill ${a.id}? Its container and clone are removed.`) && act('kill', { agent: a.id }, `${a.id} killed`) }, 'Kill'),
      h('span', { class: 'mono empty', text: `hauptling attach ${a.id}` })),
    a.host_state && !a.ended ? h('p', { class: 'resets hosthint', text: `${a.host} is ${a.host_state}: kill, pause, restart, run now and replies will run when ${a.host} reconnects.` }) : null,
  );
  if (hadFocus) reply.text.focus();
}

const TERMINAL_STATES = ['spawning', 'restarting', 'paused', 'working', 'blocked', 'done'];

function renderSub(el, a) {
  const tabs = el.querySelector('.subtabs');
  closeTerm();
  const subs = [['terminal', 'Terminal'], ['diff', 'Diff'], ['events', 'Events']];
  put(tabs, ...subs.map(([k, label]) => h('button', { 'aria-selected': String(state.sub === k), onclick: () => { state.sub = k; location.hash = `agent=${a.id}${k !== 'terminal' ? `/${k}` : ''}`; renderSub(el, a); } }, label)));
  const body = el.querySelector('.body');
  put(body, h('p', { class: 'empty', text: 'Loading…' }));
  if (state.sub === 'diff') loadDiff(a.id, body);
  if (state.sub === 'events') loadEvents(a.id, body);
  if (state.sub === 'terminal') {
    // Same live states as the server's terminal (src/terminal.mjs); otherwise the stream would retry forever.
    const pausedParked = a.state === 'paused' && (a.parked || ['parked', 'unpark'].includes(a.paused_state));
    if (a.slot && TERMINAL_STATES.includes(a.state) && !pausedParked && a.paused_state !== 'queued') state.term = openTerminal(body, a.id);
    else if (a.state === 'parked' || pausedParked) loadParkedScreen(a, body);
    else put(body, h('p', { class: 'empty', text: `No live session (${a.state})` }));
  }
}

function patchView(text) {
  const pre = h('pre', { class: 'patch' });
  for (const line of text.split('\n')) {
    const cls = line.startsWith('+') && !line.startsWith('+++') ? 'add' : line.startsWith('-') && !line.startsWith('---') ? 'del' : line.startsWith('@@') ? 'hunk' : null;
    pre.append(cls ? h('span', { class: cls, text: line }) : line, '\n');
  }
  return pre;
}

/** A parked worker has no container: the screen saved when it was parked (or paused) (PRD "Parking"). */
async function loadParkedScreen(a, body) {
  const note = h('p', { class: 'empty', text: a.parked ? 'Paused and parked: its container was removed to free its slot. Resume brings it back.'
    : 'Parked: its container was removed after it reported. Mail, a failed gate or CI, or Restart bring it back.' });
  try {
    const s = await api.get(`/dash/agent/${encodeURIComponent(a.id)}/screen`);
    put(body, note, s.text ? h('pre', { class: 'term' }, ansiFragment(s.text.replace(/\s+$/, ''))) : h('p', { class: 'empty', text: 'No screen was saved.' }));
  } catch (e) { put(body, note, h('p', { class: 'empty', text: e.message })); }
}

async function loadDiff(id, body) {
  try {
    const d = await api.get(`/dash/agent/${encodeURIComponent(id)}/diff`);
    if (d.note) { put(body, h('p', { class: 'empty', text: d.note })); return; }
    put(body, 
      h('p', { class: 'empty', text: `Against ${d.base} (merge base), committed and uncommitted.` }),
      d.stat ? h('pre', { class: 'patch', text: d.stat }) : h('p', { class: 'empty', text: 'No changes yet.' }),
      d.files.map(f => h('details', { class: 'file' }, h('summary', { text: f.path }), patchView(f.patch))),
      d.untracked.length ? h('p', {}, h('b', { text: 'Untracked: ' }), h('span', { class: 'mono', text: d.untracked.join('  ') })) : null,
    );
  } catch (e) { put(body, h('p', { class: 'empty', text: e.message })); }
}

function timelineView(t) {
  return [
    h('ol', { class: 'timeline' }, t.items.map(i => h('li', {}, h('time', { datetime: i.at, text: clock(i.at) }), h('span', { class: 'kind', text: i.kind }), h('span', { text: i.text })))),
    t.brief ? h('details', {}, h('summary', { text: 'Brief' }), h('pre', { class: 'patch', text: t.brief })) : null,
  ];
}

async function loadEvents(id, body) {
  try { put(body, ...timelineView(await api.get(`/dash/agent/${encodeURIComponent(id)}/events`)).filter(Boolean)); }
  catch (e) { put(body, h('p', { class: 'empty', text: e.message })); }
}

// ---------- web terminal ----------

/**
 * Watches the terminal's size and sends it (debounced 150 ms) as character cells: the width of `pre`, and the rows
 * that fit under its max height and inside the detail pane.
 */
function fitTerminal(pre, post) {
  let id = null; let on = false; let sent; let timer = null;
  const pane = () => pre.closest('.detail');
  const measure = () => {
    if (!pre.clientWidth) return null; // hidden
    const css = getComputedStyle(pre);
    const probe = h('span', { text: 'x'.repeat(100) });
    probe.style.cssText = 'position:absolute;visibility:hidden;white-space:pre';
    pre.append(probe);
    const cellW = probe.getBoundingClientRect().width / 100;
    probe.remove();
    const cellH = parseFloat(css.lineHeight);
    const px = (...keys) => keys.reduce((n, k) => n + (parseFloat(css[k]) || 0), 0);
    const bar = (pre.previousElementSibling?.offsetHeight || 0) + (pre.parentElement?.querySelector('.termkeys')?.offsetHeight || 0);
    const tall = Math.min(parseFloat(css.maxHeight) || innerHeight * .65, pane() ? pane().clientHeight - bar - 24 : Infinity);
    const cols = Math.floor((pre.clientWidth - px('paddingLeft', 'paddingRight')) / cellW);
    const rows = Math.floor((tall - px('paddingTop', 'paddingBottom', 'borderTopWidth', 'borderBottomWidth')) / cellH);
    return Number.isFinite(cols) && Number.isFinite(rows) ? { cols, rows: Math.max(rows, 1) } : null;
  };
  const send = () => {
    timer = null;
    if (!id) return;
    const size = on ? measure() : null;
    const key = JSON.stringify(size);
    if (key === sent) return;
    sent = key;
    post(size, id).catch(() => { sent = undefined; });
  };
  const soon = () => { clearTimeout(timer); timer = setTimeout(send, 150); };
  const watch = new ResizeObserver(soon);
  watch.observe(pre);
  if (pane()) watch.observe(pane());
  addEventListener('resize', soon);
  return {
    viewer(v) { id = v; sent = undefined; if (pane()) watch.observe(pane()); },
    update(want) { on = want; soon(); },
    close() { id = null; clearTimeout(timer); watch.disconnect(); removeEventListener('resize', soon); },
  };
}

/** A live terminal for an agent or login session inside `container`. Returns { close }. */
function openTerminal(container, sid, { autoInput = false, onEnd } = {}) {
  let inputOn = false; let queue = []; let flushing = null; let ended = false;
  const box = h('input', { type: 'checkbox' });
  const note = h('span');
  const wrapBox = h('input', { type: 'checkbox' });
  const pre = h('pre', { class: 'term', tabindex: '0', 'aria-label': `Terminal ${sid}` }, 'connecting…');
  // iOS opens its keyboard only for a text field, so taps on the screen focus this (invisible) one.
  const kb = h('textarea', { class: 'term-kb', rows: '1', autocapitalize: 'off', autocomplete: 'off', autocorrect: 'off', spellcheck: 'false', 'aria-label': `Type into terminal ${sid}` });
  const keyRow = h('div', { class: 'termkeys' });
  const setInput = (st) => {
    inputOn = st.input; box.checked = st.input; box.disabled = Boolean(st.state);
    pre.classList.toggle('live', st.input);
    note.textContent = st.state === 'paused' ? 'Paused by you' : st.state === 'restarting' ? 'Restarting session…' : st.input ? `Input on until ${new Date(st.until).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} (extends while you type). Click or tap the screen, then type or paste.` : '';
  };
  wrapBox.checked = localStorage.getItem('hl-term-wrap') !== '0';
  box.addEventListener('change', async () => {
    try { setInput(await api.post(`/dash/term/${encodeURIComponent(sid)}/input`, { on: box.checked })); if (box.checked) kb.focus({ preventScroll: true }); }
    catch (e) { toast(e.message, true); box.checked = inputOn; }
  });
  put(container, h('div', { class: 'termbar' }, h('label', { class: 'switch' }, box, 'Enable input'), h('label', { class: 'switch' }, wrapBox, 'Word wrap'), note), pre, kb, keyRow);
  const flush = () => {
    flushing = null;
    if (!queue.length) return;
    const keys = queue; queue = [];
    api.post(`/dash/term/${encodeURIComponent(sid)}/keys`, { keys }).then(setInput, (e) => toast(e.message, true));
  };
  const send = (k) => {
    const prev = queue[queue.length - 1];
    if (k.t === 'lit' && prev?.t === 'lit') prev.v += k.v; else queue.push(k);
    flushing ||= setTimeout(flush, 40);
  };
  const onKey = (e) => {
    if (!inputOn) return;
    const k = keyFor(e);
    if (!k) return;
    e.preventDefault();
    send(k);
  };
  const onPaste = (e) => { if (!inputOn) return; e.preventDefault(); const t = e.clipboardData.getData('text'); if (t) send({ t: 'lit', v: t.slice(0, 4000) }); };
  // Text a phone keyboard inserts without a usable keydown (predictive text, dictation, IME): send it, clear the field.
  const onText = () => { const v = kb.value; kb.value = ''; if (v && inputOn) send({ t: 'lit', v }); };
  for (const el of [pre, kb]) { el.addEventListener('keydown', onKey); el.addEventListener('paste', onPaste); }
  kb.addEventListener('input', (e) => { if (!e.isComposing) onText(); });
  kb.addEventListener('compositionend', onText);
  pre.addEventListener('click', () => { if (inputOn && !getSelection()?.toString()) kb.focus({ preventScroll: true }); });
  for (const [label, v] of TOUCH_KEYS) {
    const b = h('button', { type: 'button', text: label, 'aria-label': `Send ${v}` });
    b.addEventListener('pointerdown', (e) => e.preventDefault()); // keep the phone keyboard up
    b.addEventListener('click', () => { if (inputOn) send({ t: 'key', v }); });
    keyRow.append(b);
  }
  const es = new EventSource(`/dash/term/${encodeURIComponent(sid)}/stream`);
  // "Word wrap" on: the worker's tmux window takes this pane's size in cells. Off (or hidden): this viewer has none.
  const fit = fitTerminal(pre, (size, viewer) => api.post(`/dash/term/${encodeURIComponent(sid)}/size`, { viewer, size }));
  const wanted = () => fit.update(wrapBox.checked);
  wrapBox.addEventListener('change', () => { localStorage.setItem('hl-term-wrap', wrapBox.checked ? '1' : '0'); wanted(); });
  es.addEventListener('viewer', (e) => { fit.viewer(JSON.parse(e.data).id); wanted(); }); // again after every reconnect
  // Scrollback (`history`, sent when lines scroll off) sits above the screen (`frame`, sent when it changes).
  const histEl = h('span', { class: 'term-history' }), screenEl = h('span');
  const paint = (el, text) => {
    const atBottom = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 20;
    if (!pre.contains(screenEl)) pre.replaceChildren(histEl, screenEl);
    el.replaceChildren(text);
    if (atBottom) pre.scrollTop = pre.scrollHeight;
  };
  es.addEventListener('history', (e) => { const t = JSON.parse(e.data).text.replace(/\s+$/, ''); paint(histEl, t ? ansiFragment(`${t}\n`) : ''); });
  es.addEventListener('frame', (e) => paint(screenEl, ansiFragment(JSON.parse(e.data).text.replace(/\s+$/, ''))));
  // A satellite agent's terminal relayed by the hub: "<host> is offline; waiting…", cleared ('') when it is back.
  es.addEventListener('note', (e) => { note.textContent = JSON.parse(e.data).text; });
  es.addEventListener('input', async (e) => {
    const st = JSON.parse(e.data);
    setInput(st);
    if (autoInput && !st.input && !ended) { autoInput = false; box.checked = true; box.dispatchEvent(new Event('change')); }
  });
  es.addEventListener('end', (e) => {
    ended = true; es.close(); fit.close();
    const d = JSON.parse(e.data);
    note.textContent = `Ended: ${d.reason}${d.signed_in === true ? ' — signed in ✓' : d.signed_in === false ? ' — still not signed in' : ''}`;
    pre.classList.remove('live'); box.disabled = true;
    onEnd?.(d);
  });
  es.onerror = () => { if (!ended) note.textContent = 'Reconnecting…'; };
  return { sid, get ended() { return ended; }, close() { ended = true; es.close(); fit.close(); clearTimeout(flushing); } };
}
function closeTerm() { state.term?.close(); state.term = null; }

// ---------- usage ----------
let usageTimer = null;
let refreshing = false;
async function refreshUsageNow() {
  if (refreshing) return;
  refreshing = true;
  setRefreshButton();
  try { await api.post('/dash/usage/refresh'); }
  catch (e) { toast(`Refresh: ${e.message}`, true); }
  finally { refreshing = false; setRefreshButton(); loadUsage(); }
}
function setRefreshButton() {
  const b = $('#usage-refresh');
  b.disabled = refreshing;
  b.classList.toggle('busy', refreshing);
  b.setAttribute('aria-busy', String(refreshing));
}
$('#usage-refresh').addEventListener('click', refreshUsageNow);
/** Under a card's meters: how old its newest reading is, and what the last Refresh could not do. */
function freshness(v) {
  const at = v.limits.map(l => l.at).filter(Boolean).sort().at(-1);
  const r = v.refresh;
  return [
    at ? h('span', { class: 'resets', title: clock(at), text: `updated ${ago(at)} ago` }) : null,
    r && r.status !== 'ok' ? h('span', { class: r.status === 'failed' ? 'refresh-note no' : 'refresh-note resets', text: r.status === 'failed' ? `✗ refresh failed: ${r.note}` : r.note }) : null,
  ];
}
function meter(l) {
  const cls = l.used_pct >= 100 ? 'full' : l.used_pct >= 90 ? 'warn' : '';
  const label = l.window === 'week' ? 'week' : l.window;
  return h('div', { class: 'acct' },
    h('div', { class: `meter ${cls}`, role: 'meter', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(l.used_pct), 'aria-label': `${label} window used` },
      h('span', { text: label }), h('span', { class: 'track' }, h('span', { class: 'fill', style: `width:${Math.min(100, l.used_pct)}%` })), h('span', { class: 'val', text: `${Math.round(l.used_pct)}%` })),
    h('span', { class: 'resets', text: l.resets_at ? `resets ${clock(l.resets_at)}` : l.used_pct === 0 ? 'not started' : 'no reset time' }));
}
async function loadUsage() {
  clearTimeout(usageTimer);
  try {
    const u = await api.get('/dash/usage');
    renderUsageBar(u);
    if (state.view !== 'usage') return;
    const prefer = h('select', { 'aria-label': 'Cheaper-model preference', onchange: (e) => act('models.prefer', { value: e.target.value }, `New workers: ${e.target.value}`) },
      [['cheap', 'cheap (tier 1)'], ['balanced', 'balanced (up to tier 2)'], ['best', 'best (any tier)']].map(([v, t]) => h('option', { value: v, selected: v === u.prefer, text: t })));
    put($('#vendors'), h('label', { class: 'prefer', title: 'Highest model tier new workers may use; the delegator can still pass --allow-tier' }, 'Model preference ', prefer), h('div', { class: 'vendors' }, u.vendors.map(v => {
      const signed = v.slots.filter(s => s.signed_in).length;
      return h('section', { class: 'vendor' },
        h('h3', { text: v.vendor }),
        v.budget ? budgetLine(v) : null,
        v.up_to ? h('div', { class: 'resets', title: `Models above it run on the slots' sign-ins. Change: hauptling key up-to ${v.vendor} <tier|model|off>`, text: `API ${upTo(v)}; above it: your plan` }) : null,
        v.out_of_credit && !v.budget ? h('div', { class: 'no', title: `Add funds, then: hauptling key set ${v.vendor} (or give it a budget: hauptling key budget ${v.vendor} USD)`, text: `✗ API key ${v.key}: credit ran out (${clock(v.out_of_credit.at)}) · new ${v.vendor} spawns ${v.up_to ? `${upTo(v)} ` : ''}are refused` })
        : v.key && !v.budget ? h('div', { class: 'ok', title: `${v.up_to ? `Billed per token for models ${upTo(v)}.` : 'Every slot uses this key; billed per token.'} hauptling key rm ${v.vendor} switches back to sign-ins.`, text: `✓ API key ${v.key}` }) : null,
        v.key && !v.budget && !v.up_to ? null
          : h('div', { class: signed === v.slots.length ? 'ok' : 'no', text: `${signed === v.slots.length ? '✓' : '✗'} signed in on ${signed}/${v.slots.length} slots${v.budget ? ' (after the API budget)' : ''}` }),
        v.limits.length ? v.limits.sort((a) => (a.window === '5h' ? -1 : 1)).map(meter) : h('p', { class: 'resets', text: 'No usage reported yet; workers report it while they run.' }),
        freshness(v),
        (v.hosts || []).map(x => h('div', { class: 'hostusage' }, h('span', { class: 'chip host', title: x.online ? 'online' : 'offline: last reading', text: x.host }),
          [...x.limits].sort((a) => (a.window === '5h' ? -1 : 1)).map(meter))),
        v.key && !v.budget && !v.up_to ? null : h('details', { class: 'slots', open: signed < v.slots.length },
          h('summary', { text: 'Slot sign-ins' }),
          v.slots.map(s => h('div', { class: 'slotrow' },
            h('span', { class: 'mono', text: s.slot }),
            s.signed_in ? h('span', { class: 'ok', text: '✓' }) : h('span', { class: 'no', text: '✗' }),
            h('button', { disabled: Boolean(s.busy), title: s.busy ? `Locked while ${s.busy} runs: refresh tokens rotate, so a second sign-in could sign it out mid-task.` : s.login, onclick: () => startLogin(s.slot, v.vendor) }, s.signed_in ? 'Sign in again' : 'Sign in'),
            s.busy ? h('span', { class: 'resets', text: `locked: ${s.busy} running` }) : null))));
    })));
    renderSpend(u.spend);
    renderHosts(u.hosts);
  } catch (e) { if (state.view === 'usage') toast(e.message, true); }
  finally { usageTimer = setTimeout(loadUsage, state.view === 'usage' ? 15e3 : 30e3); }
}
/** "up to sonnet (tier 2)" for a vendor whose API key has a ceiling. */
const upTo = (v) => `up to ${v.up_to.name} (tier ${v.up_to.tier})`;
/** Vendor card: API key with a monthly budget, used first. */
function budgetLine(v) {
  const b = v.budget, out = v.out_of_credit, over = Boolean(out) || b.spent >= b.stop_at;
  return h('div', { class: over ? 'no' : 'ok', title: `API key ${v.key}. New ${v.vendor} workers use the API while spend is under $${b.stop_at}, then the slots' sign-ins. Hauptling's own tally of its API workers' cost.` },
    `${over ? '✗' : '✓'} API first: $${b.spent.toFixed(2)} of $${b.usd} (${out ? `credit ran out ${clock(out.at)}: new spawns use the sign-ins` : `new API spawns stop at $${b.stop_at}`}) · resets ${new Date(b.until).toLocaleDateString()}`);
}

/** Header: one chip per vendor with tiny bars (5h on top, week below), an API budget chip where set, plus 30-day spend. */
function renderUsageBar(u) {
  const level = (p) => (p >= 100 ? 'full' : p >= 90 ? 'warn' : '');
  const chips = u.vendors.map(v => {
    const ls = [...v.limits].sort((a) => (a.window === '5h' ? -1 : 1));
    const tip = ls.length ? ls.map(l => `${l.window} ${Math.round(l.used_pct)}%${l.resets_at ? ` (resets ${clock(l.resets_at)})` : ''}`).join(' · ') : 'no usage reported yet';
    return h('span', { class: `uchip ${level(Math.max(0, ...ls.map(l => l.used_pct)))}`, title: `${v.vendor}${v.key ? ' (API key)' : ''}: ${tip}` },
      h('span', { class: 'vname', text: v.vendor }),
      ls.length ? h('span', { class: 'minis' }, ls.map(l => h('span', { class: `mini ${level(l.used_pct)}` }, h('span', { style: `width:${Math.min(100, l.used_pct)}%` }))))
        : h('span', { class: 'vnone', text: '–' }));
  });
  // Satellites' accounts (part 3): one chip per vendor and host, `vendor@host`.
  for (const v of u.vendors) for (const x of v.hosts || []) {
    const ls = [...x.limits].sort((a) => (a.window === '5h' ? -1 : 1));
    chips.push(h('span', { class: `uchip ${level(Math.max(0, ...ls.map(l => l.used_pct)))}`, title: `${v.vendor} on ${x.host}${x.online ? '' : ' (offline)'}: ${ls.map(l => `${l.window} ${Math.round(l.used_pct)}%`).join(' · ')}` },
      h('span', { class: 'vname', text: `${v.vendor}@${x.host}` }),
      h('span', { class: 'minis' }, ls.map(l => h('span', { class: `mini ${level(l.used_pct)}` }, h('span', { style: `width:${Math.min(100, l.used_pct)}%` }))))));
  }
  for (const v of u.vendors.filter(x => x.budget || x.out_of_credit || x.up_to)) {
    const b = v.budget;
    const cap = v.up_to ? `; the API pays ${upTo(v)}, models above it use your plan` : '';
    if (v.out_of_credit) {
      chips.push(h('span', { class: 'uchip spend full', title: `${v.vendor} API credit ran out; ${b ? `new workers use your plan until ${new Date(b.until).toLocaleDateString()}` : `new spawns are refused until hauptling key set ${v.vendor}`}${cap}` },
        h('span', { class: 'vname', text: 'API' }), `${v.vendor} out${b ? ` $${Math.round(b.spent)}/$${b.usd}` : ''}`));
      continue;
    }
    if (!b) {
      chips.push(h('span', { class: 'uchip spend', title: `${v.vendor} API key${cap}` }, h('span', { class: 'vname', text: 'API' }), `${v.vendor} ≤${v.up_to.name}`));
      continue;
    }
    chips.push(h('span', { class: `uchip spend ${b.spent >= b.usd ? 'full' : b.spent >= b.stop_at ? 'warn' : ''}`, title: `${v.vendor} API budget this month (resets ${new Date(b.until).toLocaleDateString()}); at $${b.stop_at} new workers move to your plan${cap}` },
      h('span', { class: 'vname', text: 'API' }), `$${Math.round(b.spent)}/$${b.usd}${v.up_to ? ` ≤${v.up_to.name}` : ''}`));
  }
  const t = u.spend.total;
  chips.push(h('span', { class: 'uchip spend', title: t ? `Spend, last 30 days: ${t.agents} agents · ${kfmt(t.tokens_in)} in / ${kfmt(t.tokens_out)} out tokens` : 'No spend recorded yet', text: t ? money(t.cost_usd, t.estimated > 0) : '$0' }));
  put($('#usagebar'), ...chips);
}
/** Usage page, only with satellites: each host's link, sign-ins, free slots, GPU and workers; revoke and "Add host". */
function renderHosts(hosts) {
  const panel = $('#hosts-panel');
  if (!hosts) { panel.hidden = true; return; }
  panel.hidden = false;
  const det = panel.querySelector('details');
  if (!det.dataset.wired) {
    det.dataset.wired = '1';
    det.open = localStorage.getItem('hl-hosts') !== '0';
    det.addEventListener('toggle', () => { try { localStorage.setItem('hl-hosts', det.open ? '1' : '0'); } catch {} });
  }
  const list = (o) => Object.entries(o || {}).map(([v, x]) => `${v} ${Array.isArray(x) ? x.join(', ') || '–' : x}`).join(' · ') || '–';
  put($('#hosts'),
    h('table', { class: 'grid hosts' },
      h('thead', {}, h('tr', {}, ['host', 'state', 'last seen', 'signed in', 'free slots', 'GPU', 'workers', ''].map(t => h('th', { text: t })))),
      h('tbody', {}, hosts.map(x => h('tr', {},
        h('td', { class: 'mono', text: x.name }),
        h('td', { class: x.revoked ? 'no' : x.online ? 'ok' : 'no', text: x.revoked ? 'revoked' : x.online ? 'online' : x.lost ? 'lost' : 'offline' }),
        h('td', { title: x.lastSeen ? clock(x.lastSeen) : '', text: x.lastSeen ? `${ago(x.lastSeen)} ago` : 'never' }),
        h('td', { class: 'mono', text: list(x.vendors) }),
        h('td', { class: 'mono', text: list(x.free) }),
        h('td', { text: x.gpu == null ? '?' : x.gpu ? 'yes' : 'no' }),
        h('td', { class: 'num', title: x.pendingCommands ? `${x.pendingCommands} command(s) waiting for it` : '', text: `${x.workers}/${x.maxWorkers ?? '?'}${x.pendingCommands ? ` · ${x.pendingCommands} queued` : ''}` }),
        h('td', {}, x.revoked ? null : h('button', { class: 'danger', title: x.revoke,
          onclick: () => confirm(`Revoke ${x.name}? Its key stops working at once; to come back it must join again with a new token.`) && act('satellite.revoke', { host: x.name }, `${x.name} revoked`).then(loadUsage) }, 'Revoke')))))),
    h('div', { class: 'addhost' }, h('button', { onclick: addHost }, 'Add host'), h('div', { id: 'joinline' })));
}
async function addHost() {
  try {
    const t = await api.post('/dash/hosts/token', {});
    const code = h('code', { class: 'mono', text: t.line });
    put($('#joinline'), h('p', {}, 'Run this on the new host (expires ', h('time', { datetime: t.expiresAt, text: new Date(t.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) }), ', 15 min):'),
      h('div', { class: 'joincmd' }, code, h('button', { onclick: () => navigator.clipboard.writeText(t.line).then(() => toast('Copied'), () => toast('Copy failed: select the line', true)) }, 'Copy')),
      t.hubUrl ? null : h('p', { class: 'resets', text: 'Replace <hub-url> with this hub\'s tailnet URL (the `tailscale serve` address): this page was opened on localhost.' }));
  } catch (e) { toast(e.message, true); }
}
function spendTable(title, rows) {
  if (!rows.length) return null;
  return [h('h3', { text: title, style: 'font-size:13px;margin:1rem 0 .3rem' }),
    h('table', { class: 'grid' }, h('thead', {}, h('tr', {}, h('th', { text: '' }), h('th', { class: 'num', text: 'agents' }), h('th', { class: 'num', text: 'cost' }), h('th', { class: 'num', text: 'tokens in' }), h('th', { class: 'num', text: 'tokens out' }))),
      h('tbody', {}, rows.map(r => h('tr', {}, h('td', { class: 'mono', text: r.key }), h('td', { class: 'num', text: r.agents }),
        h('td', { class: 'num', title: r.unknown ? `${r.unknown} agent(s) with unknown cost not included` : '', text: r.unknown === r.agents ? '$?' : `${money(r.cost_usd, r.estimated > 0)}${r.unknown ? ' +?' : ''}` }),
        h('td', { class: 'num', text: kfmt(r.tokens_in) }), h('td', { class: 'num', text: kfmt(r.tokens_out) })))))];
}
function renderSpend(sp) {
  if (!sp.total) { put($('#spend'), h('p', { class: 'empty', text: 'No usage recorded yet. Workers report it while they run.' })); return; }
  const t = sp.total;
  put($('#spend'),
    h('div', { class: 'figure' }, money(t.cost_usd, t.estimated > 0), ' ', h('small', { text: `${t.agents} agents · ${kfmt(t.tokens_in)} in / ${kfmt(t.tokens_out)} out tokens${t.unknown ? ` · ${t.unknown} with unknown cost` : ''}` })),
    spendTable('By vendor', sp.byVendor), spendTable('By repo', sp.byRepo), spendTable('By day', sp.byDay));
}
async function startLogin(slot, vendor) {
  try {
    const { sid } = await api.post('/dash/term/login', { slot, vendor });
    const panel = $('#login-term');
    panel.hidden = false;
    const body = h('div');
    const close = h('button', { onclick: async () => { state.loginTerm?.close(); await api.post(`/dash/term/${sid}/stop`).catch(() => {}); panel.hidden = true; loadUsage(); } }, 'Close');
    put(panel, h('div', { class: 'termbar' }, h('b', { text: `Signing ${slot} in to ${vendor}` }), h('span', { text: 'Open the link it prints, approve, and paste the code back here if asked. It closes when the CLI exits.' }), close), body);
    state.loginTerm?.close();
    state.loginTerm = openTerminal(body, sid, { autoInput: true, onEnd: (d) => { toast(d.signed_in ? `${slot} signed in to ${vendor}` : `${slot} ${vendor}: still not signed in`, !d.signed_in); loadUsage(); } });
    panel.scrollIntoView({ behavior: 'smooth' });
  } catch (e) { toast(e.message, true); }
}

// ---------- history ----------
let histTimer;
$('#history-q').addEventListener('input', () => { clearTimeout(histTimer); histTimer = setTimeout(loadHistory, 250); });
async function loadHistory() {
  try {
    const rows = await api.get(`/dash/history?q=${encodeURIComponent($('#history-q').value)}`);
    put($('#history'), ...(rows.length ? rows.map(a => {
      const el = card({ ...a, ended: true });
      el.onclick = async () => {
        const det = $('#history-detail');
        put(det, h('div', { class: 'dhead' }, h('h2', { text: a.headline || a.title }), h('p', { class: 'prompt', text: a.title }),
          h('div', { class: 'meta' }, h('span', { class: 'aid' }, vbadge(a.vendor), h('span', { class: 'mono', text: a.id })), h('span', { text: a.state }), h('span', { text: a.model }), h('span', { class: 'mono', text: a.repo }),
            a.pr_url ? h('a', { href: a.pr_url, target: '_blank', rel: 'noopener', text: `PR #${a.pr_number}` }) : null, h('span', { text: `ended ${clock(a.updated_at)}` })),
          a.report ? h('div', { class: 'report' }, h('b', { text: 'Report: ' }), a.report) : null));
        try { det.append(...timelineView(await api.get(`/dash/agent/${encodeURIComponent(a.id)}/events`)).filter(Boolean)); } catch (e) { det.append(h('p', { class: 'empty', text: e.message })); }
      };
      return el;
    }) : [h('p', { class: 'empty', text: 'No ended agents match.' })]));
  } catch (e) { toast(e.message, true); }
}

// ---------- database ----------
const dbState = { table: null, offset: 0, sort: null, dir: 'asc', filter: '' };
async function loadTables() {
  try {
    const ts = await api.get('/dash/db/tables');
    put($('#db-tables'), ...ts.map(t => h('button', { class: dbState.table === t.name ? 'on' : null, onclick: () => { Object.assign(dbState, { table: t.name, offset: 0, sort: null, filter: '' }); loadTables(); loadTable(); } }, h('span', { class: 'mono', text: t.name }), h('small', { text: t.rows }))));
  } catch (e) { toast(e.message, true); }
}

function grid(columns, rows, { sortable = false } = {}) {
  return h('table', { class: 'grid' },
    h('thead', {}, h('tr', {}, columns.map(c => h('th', { onclick: sortable ? () => { dbState.dir = dbState.sort === c && dbState.dir === 'asc' ? 'desc' : 'asc'; dbState.sort = c; dbState.offset = 0; loadTable(); } : null },
      c, sortable && dbState.sort === c ? (dbState.dir === 'asc' ? ' ▲' : ' ▼') : '')))),
    h('tbody', {}, rows.map(r => h('tr', {}, r.map(v => (v === null ? h('td', { class: 'null', text: 'null' }) : h('td', { title: String(v), text: String(v) })))))));
}

async function loadTable() {
  const s = dbState;
  if (!s.table) return;
  try {
    const q = new URLSearchParams({ name: s.table, offset: s.offset, limit: 100, dir: s.dir, filter: s.filter, ...(s.sort ? { sort: s.sort } : {}) });
    const t = await api.get(`/dash/db/table?${q}`);
    const filter = h('input', { type: 'search', placeholder: 'Filter rows', value: s.filter });
    filter.addEventListener('change', () => { s.filter = filter.value; s.offset = 0; loadTable(); });
    put($('#db-grid'), 
      h('div', { class: 'db-bar' }, h('b', { class: 'mono', text: t.name }), filter,
        h('span', { text: `${t.total ? t.offset + 1 : 0}–${Math.min(t.offset + 100, t.total)} of ${t.total}` }),
        h('button', { disabled: t.offset === 0, onclick: () => { s.offset = Math.max(0, s.offset - 100); loadTable(); } }, '‹ Prev'),
        h('button', { disabled: t.offset + 100 >= t.total, onclick: () => { s.offset += 100; loadTable(); } }, 'Next ›')),
      grid(t.columns, t.rows, { sortable: true }));
  } catch (e) { toast(e.message, true); }
}

$('#db-query').addEventListener('submit', async (e) => {
  e.preventDefault();
  const sql = e.target.sql.value.trim();
  if (!sql) return;
  try {
    const t0 = performance.now();
    const r = await api.post('/dash/db/query', { sql });
    put($('#db-grid'), 
      h('div', { class: 'db-bar' }, h('span', { text: `${r.rows.length} row${r.rows.length === 1 ? '' : 's'}${r.truncated ? ' (stopped at 1000)' : ''} in ${Math.round(performance.now() - t0)} ms` })),
      grid(r.columns, r.rows));
  } catch (err) { put($('#db-grid'), h('p', { class: 'toast err', style: 'position:static', text: err.message })); }
});
$('#db-query textarea').addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) $('#db-query').requestSubmit(); });

// ---------- start ----------
renderUpdate();
setInterval(() => { if (state.board && state.view === 'board') renderBoard(state.board); }, 30e3); // elapsed times
const hash = location.hash.slice(1);
connect();
loadUsage();
if (['usage', 'history', 'db'].includes(hash)) show(hash);
else if (hash.startsWith('agent=')) {
  const [id, sub] = decodeURIComponent(hash.slice(6)).split('/');
  state.pending = id;
  if (['terminal', 'diff', 'events'].includes(sub)) state.sub = sub;
}

// ---------- F2: report an issue ----------
let reporting = null;
function report() {
  if (reporting) return;
  const context = () => {
    const a = state.view === 'board' ? state.board?.agents.find(x => x.id === state.selected) : state.view === 'history' ? state.board?.agents.find(x => x.id === state.histSelected) : null;
    return {
      view: state.view, tab: state.view === 'board' && a ? state.sub : null,
      agent: a ? { id: a.id, vendor: a.vendor, state: a.state } : null,
      viewport: `${innerWidth}x${innerHeight}`, theme: document.documentElement.dataset.theme,
    };
  };
  reporting = openReport({ h, api, toast, context, onClose: () => { reporting = null; } });
}
document.addEventListener('keydown', (e) => {
  if (!shouldOpenReport(e, { open: Boolean(reporting), terminalInput: terminalInputFocused() })) return;
  e.preventDefault();
  report();
});
$('#report').addEventListener('click', report);
