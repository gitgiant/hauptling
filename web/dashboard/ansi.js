// Renders tmux `capture-pane -e` output (text + SGR colour codes) as styled spans; no terminal emulator needed.
const BASE16 = ['#1e1e1e', '#e06c75', '#98c379', '#e5c07b', '#61afef', '#c678dd', '#56b6c2', '#d6d6d6',
  '#5c6370', '#ff7b86', '#b5e890', '#ffd68a', '#82c4ff', '#e09bff', '#7fdbe6', '#ffffff'];
function xterm256(n) {
  if (n < 16) return BASE16[n];
  if (n >= 232) { const g = 8 + (n - 232) * 10; return `rgb(${g},${g},${g})`; }
  const i = n - 16; const c = (v) => (v ? 55 + v * 40 : 0);
  return `rgb(${c(Math.floor(i / 36))},${c(Math.floor(i / 6) % 6)},${c(i % 6)})`;
}
export function ansiFragment(text) {
  const frag = document.createDocumentFragment();
  let st = {};
  const push = (chunk) => {
    if (!chunk) return;
    const fg = st.rev ? st.bg || '#0e0e0e' : st.fg; const bg = st.rev ? st.fg || '#d6d6d6' : st.bg;
    if (!fg && !bg && !st.b && !st.d && !st.i && !st.u) { frag.append(chunk); return; }
    const span = document.createElement('span');
    span.textContent = chunk;
    span.className = [st.b && 'b', st.d && 'd', st.i && 'i', st.u && 'u'].filter(Boolean).join(' ');
    if (fg) span.style.color = fg;
    if (bg) span.style.background = bg;
    frag.append(span);
  };
  const re = /\x1b\[([0-9;:]*)m/g;
  let last = 0; let m;
  while ((m = re.exec(text))) {
    push(text.slice(last, m.index));
    last = re.lastIndex;
    const codes = m[1] === '' ? [0] : m[1].split(/[;:]/).map(Number);
    for (let i = 0; i < codes.length; i++) {
      const c = codes[i];
      if (c === 0) st = {};
      else if (c === 1) st.b = true; else if (c === 2) st.d = true; else if (c === 3) st.i = true; else if (c === 4) st.u = true; else if (c === 7) st.rev = true;
      else if (c === 22) { st.b = false; st.d = false; } else if (c === 23) st.i = false; else if (c === 24) st.u = false; else if (c === 27) st.rev = false;
      else if (c >= 30 && c <= 37) st.fg = BASE16[c - 30]; else if (c >= 90 && c <= 97) st.fg = BASE16[c - 82];
      else if (c >= 40 && c <= 47) st.bg = BASE16[c - 40]; else if (c >= 100 && c <= 107) st.bg = BASE16[c - 92];
      else if (c === 39) st.fg = null; else if (c === 49) st.bg = null;
      else if ((c === 38 || c === 48) && codes[i + 1] === 5) { st[c === 38 ? 'fg' : 'bg'] = xterm256(codes[i + 2] ?? 0); i += 2; }
      else if ((c === 38 || c === 48) && codes[i + 1] === 2) { st[c === 38 ? 'fg' : 'bg'] = `rgb(${codes[i + 2] ?? 0},${codes[i + 3] ?? 0},${codes[i + 4] ?? 0})`; i += 4; }
    }
  }
  push(text.slice(last).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ''));
  return frag;
}

