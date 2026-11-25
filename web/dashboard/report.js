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

/** True when a live-input terminal is focused (a `pre.term.live` containing the active element). */
export const terminalInputFocused = (doc = document) => Boolean(doc.activeElement?.closest?.('pre.term.live'));

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
  const err = h('p', { class: 'rp-err', role: 'alert' });
  const send = h('button', { type: 'submit', class: 'primary' }, 'Send');
  const cancel = h('button', { type: 'button' }, 'Cancel');
  const form = h('form', { class: 'rp-box' },
    h('h2', { id: 'rp-h' }, 'Report an issue'),
    h('label', { for: 'rp-title' }, 'Title (required)'), title,
    h('label', { for: 'rp-desc' }, 'Description'), desc,
    h('label', { class: 'switch' }, incl, 'Include context (view, selected agent, size, theme, version, OS, last 20 broker log lines)'),
    h('label', { for: 'rp-preview' }, 'Exactly what will be filed (secrets and your home path removed)'), preview,
    err, h('div', { class: 'rp-actions' }, h('span', { class: 'empty' }, 'Ctrl/Cmd+Enter sends · Esc closes'), cancel, send));
  const dlg = h('div', { class: 'rp-back', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'rp-h' }, form);
  document.body.append(dlg);
  let closed = false; let seq = 0; let timer = null;
  const close = () => { if (closed) return; closed = true; clearTimeout(timer); dlg.remove(); document.removeEventListener('keydown', onKey, true); opener?.focus?.(); onClose(); };
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
      const r = await api.post('/dash/report/send', payload());
      close();
      toast(h('span', {}, 'Issue filed: ', h('a', { href: r.url, target: '_blank', rel: 'noopener noreferrer' }, r.url)), false, 15000);
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
