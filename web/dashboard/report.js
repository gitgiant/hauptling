// "Report an issue" (F2): the key rule, focus trap and dialog. Text is set with textContent only.

/**
 * Should this keydown open the report dialog? F2 alone, not while the dialog is open, and not while
 * the web terminal has input on and holds focus (F2 then belongs to the program in the terminal).
 * @param {{ key: string, ctrlKey?: boolean, metaKey?: boolean, altKey?: boolean, shiftKey?: boolean }} e
 * @param {{ open?: boolean, terminalInput?: boolean }} ctx
 */
export function shouldOpenReport(e, { open = false, terminalInput = false } = {}) {
  return e.key === 'F2' && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && !open && !terminalInput;
}

/** Where Tab should go inside a dialog: the element to focus, or null to let the browser move on. */
export function trapTarget(focusables, active, shift) {
  if (!focusables.length) return null;
  const first = focusables[0]; const last = focusables[focusables.length - 1];
  if (!focusables.includes(active)) return first;
  if (shift && active === first) return last;
  if (!shift && active === last) return first;
  return null;
}

/** True when a live-input terminal is focused: a `pre.term.live` containing the active element, or its keyboard field. */
export const terminalInputFocused = (doc = document) => {
  const a = doc.activeElement;
  return Boolean(a?.closest?.('pre.term.live') || (a?.matches?.('.term-kb') && a.previousElementSibling?.matches?.('pre.term.live')));
};

export const SHOT_MAX_W = 1920;
export const SHOT_MAX_BYTES = 5 * 1024 * 1024;

/** Draws `src` (image/video/bitmap, w×h) into a canvas at most 1920 px wide; resolves a PNG data URL. */
export function toPng(src, w, h) {
  const k = Math.min(1, SHOT_MAX_W / w);
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w * k)); c.height = Math.max(1, Math.round(h * k));
  c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
  const url = c.toDataURL('image/png');
  if (url.length * 3 / 4 > SHOT_MAX_BYTES) throw new Error('Screenshot is over 5 MB even downscaled');
  return url;
}

/** A PNG/JPEG Blob → PNG data URL (downscaled). */
export async function blobToPng(blob) {
  if (!/^image\/(png|jpeg)$/.test(blob.type)) throw new Error('Only PNG or JPEG images');
  const bmp = await createImageBitmap(blob);
  try { return toPng(bmp, bmp.width, bmp.height); } finally { bmp.close?.(); }
}

/** One frame of the current tab via screen capture; the stream is stopped right away. */
export async function captureTab() {
  const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, preferCurrentTab: true });
  try {
    const v = document.createElement('video');
    v.srcObject = stream; v.muted = true;
    await v.play();
    await new Promise(r => requestAnimationFrame(() => r()));
    return toPng(v, v.videoWidth, v.videoHeight);
  } finally { stream.getTracks().forEach(t => t.stop()); }
}

/**
 * Opens the dialog. `h`/`api`/`toast`: the dashboard's helpers. `context()` → what the browser knows.
 * Returns { close }.
 */
export function openReport({ h, api, toast, context, onClose = () => {} }) {
  const opener = document.activeElement;
  const title = h('input', { type: 'text', id: 'rp-title', required: true, maxlength: '256', autocomplete: 'off' });
  const desc = h('textarea', { id: 'rp-desc', rows: '6', placeholder: 'What happened? What did you expect?' });
  const incl = h('input', { type: 'checkbox', checked: true });
  const preview = h('pre', { class: 'rp-preview', id: 'rp-preview', tabindex: '0', 'aria-label': 'Exact issue body that will be sent (read-only)' });
  let shot = null; // PNG data URL
  const thumb = h('img', { class: 'rp-thumb', alt: 'Screenshot to attach' });
  const remove = h('button', { type: 'button' }, 'Remove');
  const shotBox = h('div', { class: 'rp-shot', hidden: true }, thumb, remove);
  const addShot = h('button', { type: 'button' }, 'Add screenshot');
  const pick = h('input', { type: 'file', accept: 'image/png,image/jpeg', hidden: true });
  const warn = h('p', { class: 'rp-warn', hidden: true, role: 'note' }, 'This image will be public on GitHub. It is not scrubbed: check it for anything private.');
  const setShot = (url) => { shot = url; thumb.src = url || ''; shotBox.hidden = warn.hidden = !url; addShot.textContent = url ? 'Replace screenshot' : 'Add screenshot'; };
  const err = h('p', { class: 'rp-err', role: 'alert' });
  const send = h('button', { type: 'submit', class: 'primary' }, 'Send');
  const cancel = h('button', { type: 'button' }, 'Cancel');
  const form = h('form', { class: 'rp-box' },
    h('h2', { id: 'rp-h' }, 'Report an issue'),
    h('label', { for: 'rp-title' }, 'Title (required)'), title,
    h('label', { for: 'rp-desc' }, 'Description'), desc,
    h('label', { class: 'switch' }, incl, 'Include context (view, selected agent, size, theme, version, OS, last 20 broker log lines)'),
    h('label', { for: 'rp-preview' }, 'Exactly what will be filed (secrets and your home path removed)'), preview,
    h('div', { class: 'rp-shotbar' }, addShot, h('span', { class: 'empty' }, 'or paste (Ctrl+V) or drop a PNG/JPEG here; off unless you add one'), pick), warn, shotBox,
    err, h('div', { class: 'rp-actions' }, h('span', { class: 'empty' }, 'Ctrl/Cmd+Enter sends · Esc closes'), cancel, send));
  const dlg = h('div', { class: 'rp-back', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'rp-h' }, form);
  document.body.append(dlg);
  let closed = false; let seq = 0; let timer = null;
  const close = () => { if (closed) return; closed = true; clearTimeout(timer); dlg.remove(); document.removeEventListener('keydown', onKey, true); opener?.focus?.(); onClose(); };
  const take = async (get) => {
    err.textContent = '';
    try { setShot(await get()); } catch (e) { err.textContent = `Screenshot: ${e.message}`; }
  };
  addShot.addEventListener('click', async () => {
    dlg.style.visibility = 'hidden'; // keep the dialog out of the picture
    await new Promise(r => setTimeout(r, 150));
    await take(captureTab);
    dlg.style.visibility = '';
    addShot.focus();
  });
  pick.addEventListener('change', () => { const f = pick.files[0]; pick.value = ''; if (f) take(() => blobToPng(f)); });
  remove.addEventListener('click', () => { setShot(null); addShot.focus(); });
  dlg.addEventListener('paste', (e) => { const f = [...(e.clipboardData?.files || [])].find(x => x.type.startsWith('image/')); if (f) { e.preventDefault(); take(() => blobToPng(f)); } });
  dlg.addEventListener('dragover', (e) => e.preventDefault());
  dlg.addEventListener('drop', (e) => { e.preventDefault(); const f = e.dataTransfer?.files?.[0]; if (f) take(() => blobToPng(f)); });
  const payload = () => ({ title: title.value, description: desc.value, include: incl.checked, client: context() });
  const refresh = async () => {
    const mine = ++seq;
    try { const r = await api.post('/dash/report/preview', payload()); if (mine === seq) { preview.textContent = `Repo: ${r.repo}\nTitle: ${r.title}\n\n${r.body}`; } }
    catch (e) { if (mine === seq) preview.textContent = e.message; }
  };
  const later = () => { clearTimeout(timer); timer = setTimeout(refresh, 250); };
  for (const el of [title, desc, incl]) el.addEventListener(el === incl ? 'change' : 'input', later);
  const submit = async () => {
    if (!title.value.trim()) { err.textContent = 'Title is required.'; title.focus(); return; }
    err.textContent = ''; send.disabled = true;
    try {
      const r = await api.post('/dash/report/send', { ...payload(), screenshot: shot });
      close();
      toast(h('span', {}, 'Issue filed: ', h('a', { href: r.url, target: '_blank', rel: 'noopener noreferrer' }, r.url), r.note ? ` (${r.note})` : ''), Boolean(r.note), 15000);
    } catch (e) { err.textContent = `Not sent: ${e.message}`; send.disabled = false; } // keep the dialog and its content
  };
  const onKey = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
    else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); submit(); }
    else if (e.key === 'Tab') {
      const t = trapTarget([...dlg.querySelectorAll('input, textarea, button, pre[tabindex], a[href]')].filter(x => !x.disabled), document.activeElement, e.shiftKey);
      if (t) { e.preventDefault(); t.focus(); }
    }
  };
  document.addEventListener('keydown', onKey, true);
  form.addEventListener('submit', (e) => { e.preventDefault(); submit(); });
  cancel.addEventListener('click', close);
  dlg.addEventListener('mousedown', (e) => { if (e.target === dlg) close(); });
  title.focus();
  refresh();
  return { close };
}
