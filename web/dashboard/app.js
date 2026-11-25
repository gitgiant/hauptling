// Hauptling dashboard (phase 4). Vanilla ES module; all data comes from the broker's /dash routes.
import { ansiFragment } from './ansi.js';
import { vendorBadge } from './vendors.js';
import { STACKED_QUERY, STRIP_PX, DRAG_IGNORE, clampRatio, parseRatio, defaultRatio, splitKey, keyRatio, collapseAfterDrag } from './layout.js';
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
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid instanceof Node ? kid : String(kid));
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

function toast(msg, err = false) {
  const t = h('div', { class: `toast${err ? ' err' : ''}`, role: 'status', text: msg });
  document.body.append(t);
  setTimeout(() => t.remove(), err ? 6000 : 2500);
}
async function act(name, args, done) {
  try { await api.post(`/dash/do/${name}`, args); toast(done); }
  catch (e) { toast(`${name}: ${e.message}`, true); }
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
  b.textContent = t === 'dark' ? '☀ Light' : '☾ Dark';
  b.title = `Switch to ${t === 'dark' ? 'light' : 'dark'} mode`;
}
setTheme(localStorage.getItem('hl-theme') === 'light' ? 'light' : 'dark');
$('#usagebar').addEventListener('click', () => show(state.view === 'usage' ? 'board' : 'usage'));
$('#theme').addEventListener('click', () => setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'));

// ---------- header: drag it up (or press ⌃) to hide it; a tab at the top brings it back ----------
const top = $('header.top');
const topTab = $('#top-tab');
let topFull = top.offsetHeight;
let topCollapsed = localStorage.getItem('hl-top') === 'collapsed';
let topDragging = false;
document.documentElement.style.setProperty('--strip', `${STRIP_PX}px`);
/** --header-h is the header's visible height; the layout (body padding, split view heights) follows it. */
const setHeaderH = (px) => document.documentElement.style.setProperty('--header-h', `${Math.round(px)}px`);
function applyTop() {
  top.classList.toggle('collapsed', topCollapsed);
  topTab.hidden = !topCollapsed;
  setHeaderH(topCollapsed ? STRIP_PX : topFull);
}
function setCollapsed(c) {
  const hadFocus = top.contains(document.activeElement) || topTab === document.activeElement;
  topCollapsed = c;
  localStorage.setItem('hl-top', c ? 'collapsed' : 'open');
  applyTop();
  if (hadFocus) (c ? topTab : $('#hide-top')).focus();
}
new ResizeObserver(() => { topFull = top.offsetHeight; if (!topDragging) applyTop(); }).observe(top); // it wraps on narrow screens
applyTop();
$('#hide-top').addEventListener('click', () => setCollapsed(true));
// Pointer clicks on the tab are handled by the drag below; this is for Enter/Space.
topTab.addEventListener('click', (e) => { if (e.detail === 0) setCollapsed(false); });

/** Vertical drag on the header (to hide it) or on the collapsed tab (to show it). */
function dragHeader(e) {
  const el = e.currentTarget;
  if (e.button !== 0 || (el === top && (topCollapsed || e.target.closest(DRAG_IGNORE)))) return;
  const from = topCollapsed, y0 = e.clientY;
  let lastY = y0, lastT = e.timeStamp, vy = 0, moved = false;
  el.setPointerCapture(e.pointerId);
  const offset = (dy) => Math.max(-topFull, Math.min(0, (from ? -topFull : 0) + dy));
  const move = (ev) => {
    const dy = ev.clientY - y0;
    if (!moved && Math.abs(dy) < 4) return;
    if (!moved) { moved = true; topDragging = true; top.classList.add('dragging'); document.body.classList.add('dragging-top'); }
    const dt = ev.timeStamp - lastT;
    if (dt > 0) { vy = 0.7 * ((ev.clientY - lastY) / dt) + 0.3 * vy; lastY = ev.clientY; lastT = ev.timeStamp; }
    const off = offset(dy);
    top.style.transform = `translateY(${off}px)`;
    setHeaderH(Math.max(STRIP_PX, topFull + off));
  };
  const end = (ev) => {
    el.removeEventListener('pointermove', move);
    el.removeEventListener('pointerup', end);
    el.removeEventListener('pointercancel', end);
    topDragging = false;
    top.style.transform = '';
    top.classList.remove('dragging');
    document.body.classList.remove('dragging-top');
    if (ev.type === 'pointercancel') { applyTop(); return; } // e.g. the browser took over a sideways scroll
    if (ev.timeStamp - lastT > 120) vy = 0; // held still before letting go: no flick
    const c = collapseAfterDrag({ collapsed: from, dy: ev.clientY - y0, vy, height: topFull });
    if (c !== topCollapsed) setCollapsed(c); else applyTop();
  };
  el.addEventListener('pointermove', move);
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
}
top.addEventListener('pointerdown', dragHeader);
topTab.addEventListener('pointerdown', dragHeader);

// ---------- splitters between the panes of each split view ----------
const stacked = matchMedia(STACKED_QUERY);
/** Defaults and minimum px of [first, second] pane, side by side and stacked. */
const SPLITS = {
  board: { def: [0.4, 0.45], min: [[288, 320], [96, 140]] },
  history: { def: [0.4, 0.45], min: [[288, 320], [96, 140]] },
  db: { def: [{ px: 208 }, 0.3], min: [[128, 320], [64, 140]] },
};
function initSplitter(sp) {
  const id = sp.dataset.split, cfg = SPLITS[id], view = sp.parentElement, first = sp.previousElementSibling;
  Object.assign(sp, { tabIndex: 0 });
  sp.setAttribute('role', 'separator');
  sp.setAttribute('aria-controls', first.id);
  sp.setAttribute('aria-valuemin', '0');
  sp.setAttribute('aria-valuemax', '100');
  sp.title = 'Drag or use the arrow keys to resize; double-click to reset';
  let ratio = 0.4;
  const geo = () => {
    const st = stacked.matches, cs = getComputedStyle(view), r = view.getBoundingClientRect();
    const [a, b] = st ? [parseFloat(cs.paddingTop), parseFloat(cs.paddingBottom)] : [parseFloat(cs.paddingLeft), parseFloat(cs.paddingRight)];
    const total = (st ? r.height : r.width) - a - b - (st ? sp.offsetHeight : sp.offsetWidth);
    return { st, total, start: (st ? r.top : r.left) + a, min: cfg.min[st ? 1 : 0] };
  };
  const set = (want, save) => {
    const g = geo();
    ratio = clampRatio(want, g.total, ...g.min);
    view.style.setProperty('--split', ratio.toFixed(4));
    sp.setAttribute('aria-orientation', g.st ? 'horizontal' : 'vertical');
    sp.setAttribute('aria-valuenow', String(Math.round(ratio * 100)));
    if (save) localStorage.setItem(splitKey(id, g.st), ratio.toFixed(4));
  };
  const load = () => {
    const g = geo();
    if (g.total <= 0) return; // hidden view
    set(parseRatio(localStorage.getItem(splitKey(id, g.st))) ?? defaultRatio(cfg.def[g.st ? 1 : 0], g.total), false);
  };
  new ResizeObserver(load).observe(view); // also fires when a hidden view is shown and when orientation flips
  sp.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    sp.setPointerCapture(e.pointerId);
    sp.classList.add('dragging');
    document.body.classList.add('resizing');
    const g = geo();
    const pos = (ev) => (g.st ? ev.clientY : ev.clientX) - g.start;
    const grab = pos(e) - ratio * g.total; // keep the handle where it was grabbed
    const move = (ev) => set((pos(ev) - grab) / g.total, false);
    const end = () => {
      sp.removeEventListener('pointermove', move);
      sp.removeEventListener('pointerup', end);
      sp.removeEventListener('pointercancel', end);
      sp.classList.remove('dragging');
      document.body.classList.remove('resizing');
      set(ratio, true);
    };
    sp.addEventListener('pointermove', move);
    sp.addEventListener('pointerup', end);
    sp.addEventListener('pointercancel', end);
  });
  sp.addEventListener('keydown', (e) => {
    const g = geo();
    const r = keyRatio(e.key, e.shiftKey, ratio, g.total, ...g.min);
    if (r == null) return;
    e.preventDefault();
    set(r, true);
  });
  sp.addEventListener('dblclick', () => { localStorage.removeItem(splitKey(id, stacked.matches)); load(); });
}
for (const sp of document.querySelectorAll('.splitter')) initSplitter(sp);

// ---------- state ----------
const state = { board: null, selected: null, sub: 'screen', view: 'board', screenTimer: null, histSelected: null };

// ---------- tabs ----------
for (const b of document.querySelectorAll('.tabs button')) {
  b.addEventListener('click', () => show(b.dataset.view));
}
function show(view) {
  state.view = view;
  for (const b of document.querySelectorAll('.tabs button')) b.setAttribute('aria-selected', String(b.dataset.view === view));
  $('#usagebar').setAttribute('aria-pressed', String(view === 'usage'));
  for (const v of ['board', 'usage', 'history', 'db']) $(`#view-${v}`).hidden = v !== view;
  if (view !== 'board') closeTerm();
  if (view === 'history') loadHistory();
  if (view === 'usage') loadUsage();
  if (view === 'db') loadTables();
  location.hash = view === 'board' ? (state.selected ? `agent=${state.selected}` : '') : view;
  syncScreenTimer();
}

// ---------- live board ----------
function connect() {
  const es = new EventSource('/dash/stream');
  es.addEventListener('board', (e) => {
    state.board = JSON.parse(e.data);
    render();
    if (state.pending) { const id = state.pending; state.pending = null; select(id); }
  });
  es.addEventListener('host', (e) => { state.host = JSON.parse(e.data); renderSys(); });
  es.onopen = () => { $('#conn').className = 'conn live'; $('#conn').textContent = 'live'; };
  es.onerror = () => { $('#conn').className = 'conn down'; $('#conn').textContent = 'reconnecting…'; };
}

function render() {
  const b = state.board;
  document.title = b.blocked ? `(${b.blocked}) Hauptling` : 'Hauptling';
  renderGpu(b.gpu, b.tests);
  renderSys();
  renderBoard(b);
  if (state.selected) {
    const a = b.agents.find(x => x.id === state.selected);
    if (a) renderDetailHead(a, $('#detail'));
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
  return h('span', { class: 'metric', title: `${title}; graph: last ${mins} min` }, name ? `${name} ` : null, h('b', { text: v == null ? '?' : `${v}%` }), spark(values, `${name} over the last ${mins} minutes`));
}

function renderSys() {
  const l = state.host;
  if (!l) return;
  put($('#sys'), metric('CPU', l.cpu, l.hist.cpu, 'Host CPU in use, all cores'), metric('Mem', l.mem, l.hist.mem, 'Host memory in use'));
  const g = $('#gpu .gpu-util');
  if (g) put(g, metric('', l.gpu, l.hist.gpu, 'GPU utilization'));
}

/** CPU test jobs: what runs now (agent, repo, elapsed) and how many wait. */
function cpuTests(q) {
  if (!q) return null;
  const tip = q.running.map(r => `${r.id} ${r.purpose}${r.agent ? ` · ${r.agent}` : ''} · ${r.repo} · ${ago(r.claimed_at)}`).join('\n');
  return h('span', { class: 'cputests', title: `CPU test jobs, up to ${q.limit} at once, one per repo${tip ? `\n${tip}` : ''}` },
    'Tests ', h('b', { text: `${q.running.length}/${q.limit}` }),
    q.running.map(r => h('span', { class: 'mono', text: `▶ ${r.agent || r.id} ${r.repo.split('/').pop()} ${ago(r.claimed_at)}` })),
    q.queued ? h('span', { text: `· ${q.queued} queued` }) : null);
}

/** "Run now" for a queued CPU test job: starts it past the concurrency limit. */
function runNow(t) {
  if (t?.state !== 'queued' || t.gpu) return null;
  return h('button', { title: `Start ${t.id} now, past the test concurrency limit`, onclick: (e) => { e.stopPropagation(); act('test.run', { id: t.id }, `${t.id} started`); } }, 'Run now');
}

function renderGpu(g, tq) {
  const el = $('#gpu');
  const cpu = cpuTests(tq);
  if (!g) { put(el, cpu, h('span', { text: 'GPU: ?' })); return; }
  if (!g.available) { put(el, cpu, h('span', { text: 'GPU: none' })); return; }
  const running = g.running[0];
  put(el, cpu,

    h('span', {}, 'GPU ', h('b', { text: g.paused ? 'paused' : running ? 'busy' : 'idle' })),
    h('span', { class: 'gpu-util' }),
    h('span', { title: 'Free VRAM / what a job waits for', text: `${g.freeMB ?? '?'} MiB free` }),
    running ? h('span', { class: 'mono', text: `▶ ${running.id}${running.agent ? ` (${running.agent})` : ''}` }) : null,
    g.queued.length ? h('span', { text: `${g.queued.length} queued${g.queued.some(q => q.waiting_since) ? ' · waiting for VRAM' : ''}` }) : null,
    g.paused
      ? h('button', { onclick: () => act('gpu.resume', {}, 'GPU queue resumed') }, 'Resume')
      : [h('button', { onclick: () => act('gpu.pause', {}, 'GPU queue paused; the running job finishes') }, 'Pause'),
        running ? h('button', { class: 'danger', onclick: () => confirm(`Kill ${running.id} and requeue it?`) && act('gpu.pause', { now: true }, `Paused; ${running.id} requeued`) }, 'Pause now') : null],
  );
}

function card(a) {
  const meta = [
    h('span', { class: 'aid', title: `${a.vendor} · ${a.model} · ${a.branch}` }, vbadge(a.vendor), h('span', { class: 'mono', text: a.id })),
    a.pr_url ? h('a', { href: a.pr_url, target: '_blank', rel: 'noopener', onclick: (e) => e.stopPropagation(), text: `PR #${a.pr_number}` }) : null,
    a.gate ? h('span', { text: `gate: ${a.gate}` }) : null,
    a.ci_note ? h('span', { class: 'chip fail', text: `CI failed ${a.ci_note.slice(0, 7)}` }) : null,
    testChip(a.test),
    a.ended ? null : runNow(a.test),
    usageChips(a.usage),
  ];
  const el = h('div', { class: `card ${a.state}${state.selected === a.id ? ' selected' : ''}`, role: 'button', tabindex: '0', onclick: () => select(a.id), onkeydown: (e) => e.key === 'Enter' && select(a.id) },
    h('span', { class: `dot ${a.state}`, title: a.state }),
    h('span', { class: 'title', title: a.headline || a.title, text: a.headline || a.title }),
    h('span', { class: 'elapsed', title: `started ${clock(a.created_at)}`, text: ago(a.created_at) }),
    a.headline ? h('div', { class: 'prompt', title: `Prompt: ${a.title}`, text: a.title }) : null,
    h('div', { class: 'meta' }, meta),
  );
  return el;
}

function testChip(t) {
  if (!t) return null;
  const label = `${t.gpu ? 'GPU ' : ''}${t.purpose === 'gate' ? 'gate' : 'test'}`;
  if (!t.status) return h('span', { class: 'chip run', text: `${label} ${t.state}` });
  return h('span', { class: `chip ${t.status}`, title: `${t.id} ${clock(t.at)}`, text: `${label} ${t.status} ${t.passed ?? 0}/${(t.passed ?? 0) + (t.failed ?? 0)}` });
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
function renderBoard(b) {
  const live = b.agents.filter(a => !a.ended);
  const recent = b.agents.filter(a => a.ended).sort((x, y) => (x.updated_at < y.updated_at ? 1 : -1));
  const groups = new Map();
  for (const a of live) {
    const key = `${a.delegator}|${a.repo}`; // delegator ids have no |
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(a);
  }
  const out = [];
  if (!live.length) out.push(h('p', { class: 'empty', text: 'No active agents. Start Claude, Codex or agy and run /delegator.' }));
  for (const [key, list] of groups) {
    const d = key.slice(0, key.indexOf('|')), repo = key.slice(key.indexOf('|') + 1);
    list.sort((x, y) => (ORDER[x.state] ?? 9) - (ORDER[y.state] ?? 9) || (x.created_at < y.created_at ? -1 : 1));
    const shut = shutGroups.has(key);
    out.push(h('div', { class: `group${shut ? ' shut' : ''}`, 'data-key': key },
      h('h2', {}, h('button', { class: 'gtoggle', type: 'button', 'aria-expanded': String(!shut), title: shut ? 'Show the cards' : 'Hide the cards (keep the status dots)', onclick: () => toggleGroup(key) },
        h('span', { class: 'caret', 'aria-hidden': 'true', text: '▾' }), h('span', { class: 'mono', text: repo }), ' · ', h('span', { class: 'mono', text: d }), shut ? h('span', { class: 'count', text: ` (${list.length})` }) : null)),
      shut
        ? h('div', { class: 'dots' }, list.map(a => h('button', { type: 'button', class: `dotbtn${state.selected === a.id ? ' selected' : ''}`, title: `${a.id} · ${a.state}`, 'aria-label': `${a.id}, ${a.state}`, onclick: () => select(a.id) }, h('span', { class: `dot ${a.state}` }))))
        : h('div', { class: 'cards' }, list.map(card))));
  }
  if (recent.length) {
    const det = h('details', { class: 'recent', open: localStorage.getItem('hl-recent') === '1' }, h('summary', { text: `Recent, last 24 h (${recent.length})` }), h('div', { class: 'cards' }, recent.map(card)));
    det.addEventListener('toggle', () => localStorage.setItem('hl-recent', det.open ? '1' : '0'));
    out.push(det);
  }
  put($('#board'), ...out);
}

// ---------- detail ----------
function select(id) {
  closeTerm();
  state.selected = id;
  location.hash = `agent=${id}${state.sub !== 'screen' ? `/${state.sub}` : ''}`;
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
  const canMerge = isLocal(a) && a.state === 'done' && a.test?.purpose === 'gate' && a.test?.status === 'pass';
  put(head, 
    h('h2', { text: a.headline || a.title }),
    a.headline ? h('p', { class: 'prompt', title: 'Prompt (spawn title)', text: a.title }) : null,
    h('div', { class: 'meta' },
      h('span', { class: 'aid' }, vbadge(a.vendor), h('span', { class: 'mono', text: a.id })), h('span', { text: a.state }), h('span', { text: `${a.vendor} · ${a.model}${a.billing ? ` · ${a.billing === 'api' ? 'API' : 'plan'}` : ''}` }),
      h('span', { class: 'mono', text: `${a.branch} → ${a.base}` }), h('span', { class: 'mono', text: a.repo }),
      a.pr_url ? h('a', { href: a.pr_url, target: '_blank', rel: 'noopener', text: `PR #${a.pr_number}` }) : null,
      h('span', { text: `started ${clock(a.created_at)} (${ago(a.created_at)})` }),
      a.usage ? h('span', { text: `${a.usage.context_pct != null ? `context ${Math.round(a.usage.context_pct)}% · ` : ''}${money(a.usage.cost_usd, a.usage.cost_estimated)} · ${kfmt(a.usage.tokens_in)} in / ${kfmt(a.usage.tokens_out)} out` }) : null),
    a.ask ? h('div', { class: 'ask' }, h('p', { text: a.ask.question }),
      h('div', { class: 'choices' }, a.ask.choices.map((c, i) => h('button', { class: 'primary', onclick: () => act('answer', { ask: a.ask.id, choice: i }, `Answered: ${c}`) }, c)))) : null,
    a.report ? h('div', { class: 'report' }, h('b', { text: 'Report: ' }), a.report) : null,
    a.ended ? null : reply,
    a.ended ? null : h('div', { class: 'actions' },
      canMerge ? h('button', { class: 'primary', onclick: () => act('merge', { agent: a.id }, `${a.id} merged into ${a.base}`) }, `Merge into ${a.base}`) : null,
      runNow(a.test),
      h('button', { class: 'danger', onclick: () => confirm(`Kill ${a.id}? Its container and clone are removed.`) && act('kill', { agent: a.id }, `${a.id} killed`) }, 'Kill'),
      h('span', { class: 'mono empty', text: `hauptling attach ${a.id}` })),
  );
  if (hadFocus) reply.text.focus();
}

function renderSub(el, a) {
  const tabs = el.querySelector('.subtabs');
  closeTerm();
  const subs = [['screen', 'Screen'], ['terminal', 'Terminal'], ['diff', 'Diff'], ['events', 'Events']];
  put(tabs, ...subs.map(([k, label]) => h('button', { 'aria-selected': String(state.sub === k), onclick: () => { state.sub = k; location.hash = `agent=${a.id}${k !== 'screen' ? `/${k}` : ''}`; renderSub(el, a); } }, label)));
  const body = el.querySelector('.body');
  put(body, h('p', { class: 'empty', text: 'Loading…' }));
  if (state.sub === 'screen') loadScreen(a.id, body);
  if (state.sub === 'diff') loadDiff(a.id, body);
  if (state.sub === 'events') loadEvents(a.id, body);
  if (state.sub === 'terminal') state.term = openTerminal(body, a.id);
  syncScreenTimer();
}

async function loadScreen(id, body) {
  try {
    const s = await api.get(`/dash/agent/${encodeURIComponent(id)}/screen`);
    if (state.selected !== id || state.sub !== 'screen') return;
    const pre = body.querySelector('pre.screen');
    const atBottom = !pre || pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 20;
    if (s.ended) clearInterval(state.screenTimer); // container gone: stop polling
    if (s.note) { put(body, s.text ? h('pre', { class: 'screen' }, s.text) : null, h('p', { class: 'empty', text: s.note })); return; }
    const next = pre || h('pre', { class: 'screen' });
    next.textContent = s.text || '(empty screen)';
    if (!pre) put(body, next, h('p', { class: 'empty', text: 'Read-only mirror, refreshed every 2 s. Live terminal: hauptling attach (web terminal comes in 4b).' }));
    if (atBottom) next.scrollTop = next.scrollHeight;
  } catch (e) { put(body, h('p', { class: 'empty', text: e.message })); }
}

function syncScreenTimer() {
  clearInterval(state.screenTimer);
  state.screenTimer = null;
  if (state.view === 'board' && state.selected && state.sub === 'screen') {
    state.screenTimer = setInterval(() => { if (!document.hidden) loadScreen(state.selected, $('#detail .body')); }, 2000);
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
const NAMED = { Enter: 'Enter', Backspace: 'BSpace', Escape: 'Escape', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
  Home: 'Home', End: 'End', PageUp: 'PPage', PageDown: 'NPage', Delete: 'DC', Insert: 'IC' };

/** A live terminal for an agent or login session inside `container`. Returns { close }. */
function openTerminal(container, sid, { autoInput = false, onEnd } = {}) {
  let inputOn = false; let queue = []; let flushing = null; let ended = false;
  const box = h('input', { type: 'checkbox' });
  const note = h('span');
  const wrapBox = h('input', { type: 'checkbox' });
  const pre = h('pre', { class: 'term', tabindex: '0', 'aria-label': `Terminal ${sid}` }, 'connecting…');
  const setInput = (st) => {
    inputOn = st.input; box.checked = st.input;
    pre.classList.toggle('live', st.input);
    note.textContent = st.input ? `Input on until ${new Date(st.until).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} (extends while you type). Click the screen, then type or paste.` : '';
  };
  const setWrap = (on) => { wrapBox.checked = on; pre.classList.toggle('nowrap', !on); };
  setWrap(localStorage.getItem('hl-term-wrap') !== '0');
  wrapBox.addEventListener('change', () => { localStorage.setItem('hl-term-wrap', wrapBox.checked ? '1' : '0'); setWrap(wrapBox.checked); });
  box.addEventListener('change', async () => {
    try { setInput(await api.post(`/dash/term/${encodeURIComponent(sid)}/input`, { on: box.checked })); if (box.checked) pre.focus(); }
    catch (e) { toast(e.message, true); box.checked = inputOn; }
  });
  put(container, h('div', { class: 'termbar' }, h('label', { class: 'switch' }, box, 'Enable input'), h('label', { class: 'switch' }, wrapBox, 'Word wrap'), note), pre);
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
  pre.addEventListener('keydown', (e) => {
    if (!inputOn || e.metaKey) return;
    let k = null;
    if (e.ctrlKey && /^[a-z]$/i.test(e.key)) k = { t: 'key', v: `C-${e.key.toLowerCase()}` };
    else if (e.key === 'Tab') k = { t: 'key', v: e.shiftKey ? 'BTab' : 'Tab' };
    else if (NAMED[e.key]) k = { t: 'key', v: NAMED[e.key] };
    else if (e.key.length === 1 && !e.ctrlKey && !e.altKey) k = { t: 'lit', v: e.key };
    if (!k) return;
    e.preventDefault();
    send(k);
  });
  pre.addEventListener('paste', (e) => { if (!inputOn) return; e.preventDefault(); const t = e.clipboardData.getData('text'); if (t) send({ t: 'lit', v: t.slice(0, 4000) }); });
  const es = new EventSource(`/dash/term/${encodeURIComponent(sid)}/stream`);
  es.addEventListener('frame', (e) => {
    const atBottom = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 20;
    pre.replaceChildren(ansiFragment(JSON.parse(e.data).text.replace(/\s+$/, '')));
    if (atBottom) pre.scrollTop = pre.scrollHeight;
  });
  es.addEventListener('input', async (e) => {
    const st = JSON.parse(e.data);
    setInput(st);
    if (autoInput && !st.input && !ended) { autoInput = false; box.checked = true; box.dispatchEvent(new Event('change')); }
  });
  es.addEventListener('end', (e) => {
    ended = true; es.close();
    const d = JSON.parse(e.data);
    note.textContent = `Ended: ${d.reason}${d.signed_in === true ? ' — signed in ✓' : d.signed_in === false ? ' — still not signed in' : ''}`;
    pre.classList.remove('live'); box.disabled = true;
    onEnd?.(d);
  });
  es.onerror = () => { if (!ended) note.textContent = 'Reconnecting…'; };
  return { sid, close() { ended = true; es.close(); clearTimeout(flushing); } };
}
function closeTerm() { state.term?.close(); state.term = null; }

// ---------- usage ----------
let usageTimer = null;
function meter(l) {
  const cls = l.used_pct >= 100 ? 'full' : l.used_pct >= 90 ? 'warn' : '';
  const label = l.window === 'week' ? 'week' : l.window;
  return h('div', { class: 'acct' },
    h('div', { class: `meter ${cls}`, role: 'meter', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(l.used_pct), 'aria-label': `${label} window used` },
      h('span', { text: label }), h('span', { class: 'track' }, h('span', { class: 'fill', style: `width:${Math.min(100, l.used_pct)}%` })), h('span', { class: 'val', text: `${Math.round(l.used_pct)}%` })),
    h('span', { class: 'resets', text: l.resets_at ? `resets ${clock(l.resets_at)}` : 'reset time unknown' }));
}
async function loadUsage() {
  clearTimeout(usageTimer);
  try {
    const u = await api.get('/dash/usage');
    renderUsageBar(u);
    if (state.view !== 'usage') return;
    put($('#vendors'), h('div', { class: 'vendors' }, u.vendors.map(v => {
      const signed = v.slots.filter(s => s.signed_in).length;
      return h('section', { class: 'vendor' },
        h('h3', { text: v.vendor }),
        v.budget ? budgetLine(v) : null,
        v.key && !v.budget ? h('div', { class: 'ok', title: `Every slot uses this key; billed per token. hauptling key rm ${v.vendor} switches back to sign-ins.`, text: `✓ API key ${v.key}` })
          : h('div', { class: signed === v.slots.length ? 'ok' : 'no', text: `${signed === v.slots.length ? '✓' : '✗'} signed in on ${signed}/${v.slots.length} slots${v.budget ? ' (after the API budget)' : ''}` }),
        v.limits.length ? v.limits.sort((a) => (a.window === '5h' ? -1 : 1)).map(meter) : h('p', { class: 'resets', text: 'No usage reported yet; workers report it while they run.' }),
        v.key && !v.budget ? null : h('details', { class: 'slots', open: signed < v.slots.length },
          h('summary', { text: 'Slot sign-ins' }),
          v.slots.map(s => h('div', { class: 'slotrow' },
            h('span', { class: 'mono', text: s.slot }),
            s.signed_in ? h('span', { class: 'ok', text: '✓' }) : h('span', { class: 'no', text: '✗' }),
            h('button', { disabled: Boolean(s.busy), title: s.busy ? `Locked while ${s.busy} runs: refresh tokens rotate, so a second sign-in could sign it out mid-task.` : s.login, onclick: () => startLogin(s.slot, v.vendor) }, s.signed_in ? 'Sign in again' : 'Sign in'),
            s.busy ? h('span', { class: 'resets', text: `locked: ${s.busy} running` }) : null))));
    })));
    renderSpend(u.spend);
  } catch (e) { if (state.view === 'usage') toast(e.message, true); }
  finally { usageTimer = setTimeout(loadUsage, state.view === 'usage' ? 15e3 : 30e3); }
}
/** Vendor card: API key with a monthly budget, used first. */
function budgetLine(v) {
  const b = v.budget, over = b.spent >= b.stop_at;
  return h('div', { class: over ? 'no' : 'ok', title: `API key ${v.key}. New ${v.vendor} workers use the API while spend is under $${b.stop_at}, then the slots' sign-ins. Hauptling's own tally of its API workers' reported cost.` },
    `${over ? '✗' : '✓'} API first: $${b.spent.toFixed(2)} of $${b.usd} (new API spawns stop at $${b.stop_at}) · resets ${new Date(b.until).toLocaleDateString()}`);
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
  for (const v of u.vendors.filter(x => x.budget)) {
    const b = v.budget;
    chips.push(h('span', { class: `uchip spend ${b.spent >= b.usd ? 'full' : b.spent >= b.stop_at ? 'warn' : ''}`, title: `${v.vendor} API budget this month (resets ${new Date(b.until).toLocaleDateString()}); at $${b.stop_at} new workers move to your plan` },
      h('span', { class: 'vname', text: 'API' }), `$${Math.round(b.spent)}/$${b.usd}`));
  }
  const t = u.spend.total;
  chips.push(h('span', { class: 'uchip spend', title: t ? `Spend, last 30 days: ${t.agents} agents · ${kfmt(t.tokens_in)} in / ${kfmt(t.tokens_out)} out tokens` : 'No spend recorded yet', text: t ? money(t.cost_usd, t.estimated > 0) : '$0' }));
  put($('#usagebar'), ...chips);
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
setInterval(() => { if (state.board && state.view === 'board') renderBoard(state.board); }, 30e3); // elapsed times
const hash = location.hash.slice(1);
connect();
loadUsage();
if (['usage', 'history', 'db'].includes(hash)) show(hash);
else if (hash.startsWith('agent=')) {
  const [id, sub] = decodeURIComponent(hash.slice(6)).split('/');
  state.pending = id;
  if (['screen', 'terminal', 'diff', 'events'].includes(sub)) state.sub = sub;
}
