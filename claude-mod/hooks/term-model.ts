// The terminal view's pure rules (PRD "Terminal"): tmux `capture-pane -e` text (characters and SGR colour codes,
// as web/dashboard/ansi.js reads it) to coloured runs and to a `Raster`'s cells, the pane's size to the lease, the
// field's edits to tmux keys, and the input line's words. No `$` here: terminal.tsx calls these.
import type { TermKey } from './client'

/** A colour as `0x00RRGGBB`, or null for the terminal's default. */
export type Color = number | null
/** A stretch of one line drawn in one style, reverse video already applied. */
export type Run = { text: string; fg: Color; bg: Color }

/** The dashboard's 16 base colours (web/dashboard/ansi.js), so the pane and the browser agree. */
const BASE16 = [0x1e1e1e, 0xe06c75, 0x98c379, 0xe5c07b, 0x61afef, 0xc678dd, 0x56b6c2, 0xd6d6d6,
  0x5c6370, 0xff7b86, 0xb5e890, 0xffd68a, 0x82c4ff, 0xe09bff, 0x7fdbe6, 0xffffff]
/** Reverse video over the default colours: the dashboard's dark screen. */
const REV_FG = 0x0e0e0e
const REV_BG = 0xd6d6d6
/** Dim text with the default foreground. */
const DIM_FG = 0x808080

function xterm256(n: number): number {
  if (n < 16) return BASE16[n] ?? 0
  if (n >= 232) { const g = 8 + (n - 232) * 10; return (g << 16) | (g << 8) | g }
  const i = n - 16
  const c = (v: number) => (v ? 55 + v * 40 : 0)
  return (c(Math.floor(i / 36)) << 16) | (c(Math.floor(i / 6) % 6) << 8) | c(i % 6)
}

const rgb = (r = 0, g = 0, b = 0) => ((r & 255) << 16) | ((g & 255) << 8) | (b & 255)
const halve = (c: number) => ((c >> 1) & 0x7f7f7f)

type Style = { fg: Color; bg: Color; dim: boolean; rev: boolean }

function applySgr(st: Style, params: string): void {
  const codes = params === '' ? [0] : params.split(/[;:]/).map(Number)
  for (let i = 0; i < codes.length; i++) {
    const c = codes[i]!
    if (c === 0) { st.fg = null; st.bg = null; st.dim = false; st.rev = false }
    else if (c === 2) st.dim = true
    else if (c === 22) st.dim = false
    else if (c === 7) st.rev = true
    else if (c === 27) st.rev = false
    else if (c >= 30 && c <= 37) st.fg = BASE16[c - 30]!
    else if (c >= 90 && c <= 97) st.fg = BASE16[c - 82]!
    else if (c >= 40 && c <= 47) st.bg = BASE16[c - 40]!
    else if (c >= 100 && c <= 107) st.bg = BASE16[c - 92]!
    else if (c === 39) st.fg = null
    else if (c === 49) st.bg = null
    else if ((c === 38 || c === 48) && codes[i + 1] === 5) { const v = xterm256(codes[i + 2] ?? 0); if (c === 38) st.fg = v; else st.bg = v; i += 2 }
    else if ((c === 38 || c === 48) && codes[i + 1] === 2) { const v = rgb(codes[i + 2], codes[i + 3], codes[i + 4]); if (c === 38) st.fg = v; else st.bg = v; i += 4 }
  }
}

/** The colours a style draws with: reverse video swaps them (the TUIs draw their cursor so), dim halves the text. */
function colors(st: Style): { fg: Color; bg: Color } {
  let fg = st.dim ? (st.fg === null ? DIM_FG : halve(st.fg)) : st.fg
  let bg = st.bg
  if (st.rev) [fg, bg] = [bg ?? REV_FG, fg ?? REV_BG]
  return { fg, bg }
}

// eslint-disable-next-line no-control-regex
const ESCAPES = /\x1b\[([0-9;:?]*)([A-Za-z])|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Za-z0-9]|\x1b[=>78]/g

/**
 * A screen as lines of runs. SGR codes set the style; any other escape (cursor moves, OSC 8 links, charset
 * switches) is dropped. Trailing blank lines are kept: the screen's height is the window's.
 */
export function screenLines(text: string): Run[][] {
  const st: Style = { fg: null, bg: null, dim: false, rev: false }
  const lines: Run[][] = [[]]
  const push = (chunk: string) => {
    const parts = chunk.replace(/\r/g, '').split('\n')
    parts.forEach((part, i) => {
      if (i > 0) lines.push([])
      if (!part) return
      const line = lines[lines.length - 1]!
      const { fg, bg } = colors(st)
      const last = line[line.length - 1]
      if (last && last.fg === fg && last.bg === bg) last.text += part
      else line.push({ text: part, fg, bg })
    })
  }
  let at = 0
  for (const m of String(text ?? '').matchAll(ESCAPES)) {
    push(String(text).slice(at, m.index))
    at = m.index! + m[0].length
    if (m[2] === 'm') applySgr(st, m[1] ?? '')
  }
  push(String(text ?? '').slice(at))
  if (lines.length > 1 && lines[lines.length - 1]!.length === 0 && String(text).endsWith('\n')) lines.pop()
  return lines
}

// ---------------------------------------------------------------- cells

/** `0x01000000`: the terminal's own default colour in a Raster cell. */
export const DEFAULT_COLOR = 0x01000000
/** Drawn for a character a Raster cell cannot hold (outside the ranges below). */
const MISSING = 0x3f // '?'

/** Characters that take no cell: combining marks, zero-width joiners and spaces, variation selectors. */
function isZeroWidth(cp: number): boolean {
  return (cp >= 0x300 && cp <= 0x36f) || (cp >= 0x200b && cp <= 0x200f) || (cp >= 0xfe00 && cp <= 0xfe0f) ||
    (cp >= 0x20d0 && cp <= 0x20ff) || cp === 0x2060 || cp === 0xfeff
}

/** Characters a terminal draws two cells wide: East Asian wide and fullwidth, and emoji. */
function isWide(cp: number): boolean {
  return (cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) || (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe30 && cp <= 0xfe4f) || (cp >= 0xff00 && cp <= 0xff60) || (cp >= 0xffe0 && cp <= 0xffe6) ||
    cp >= 0x1f300 || [0x231a, 0x231b, 0x23e9, 0x23ea, 0x23eb, 0x23ec, 0x23f0, 0x23f3, 0x25fd, 0x25fe, 0x2614, 0x2615, 0x267f, 0x2693,
    0x26a1, 0x26aa, 0x26ab, 0x26bd, 0x26be, 0x26c4, 0x26c5, 0x26ce, 0x26d4, 0x26ea, 0x26f2, 0x26f3, 0x26f5, 0x26fa, 0x26fd, 0x2705,
    0x270a, 0x270b, 0x2728, 0x274c, 0x274e, 0x2753, 0x2754, 0x2755, 0x2757, 0x2795, 0x2796, 0x2797, 0x27b0, 0x27bf, 0x2b1b, 0x2b1c,
    0x2b50, 0x2b55].includes(cp) || (cp >= 0x2648 && cp <= 0x2653)
}

/**
 * Whether a Raster cell takes the character: printable, one cell wide, in the BMP. Kept to ranges a TUI draws
 * (Latin, Greek, Cyrillic, punctuation, arrows, maths, technical, box drawing, blocks, shapes, symbols, dingbats,
 * braille), since one cell the engine refuses refuses the whole pane.
 */
function isCellable(cp: number): boolean {
  return (cp >= 0x20 && cp <= 0x7e) || (cp >= 0xa0 && cp <= 0x24f && cp !== 0xad) || (cp >= 0x370 && cp <= 0x4ff) ||
    (cp >= 0x2010 && cp <= 0x2027) || (cp >= 0x2030 && cp <= 0x205e) || (cp >= 0x2070 && cp <= 0x20cf) ||
    (cp >= 0x2100 && cp <= 0x27bf) || (cp >= 0x2800 && cp <= 0x28ff) || (cp >= 0x2900 && cp <= 0x2bff)
}

/**
 * A Raster's cells for a screen, `columns` by `rows`: each a `[codePoint, fg, bg]` triplet of u32, row-major,
 * as RasterProps packs them. Lines and columns past the box are cut, the rest blank. A wide character takes two
 * cells (`?` and a blank, so the columns after it stay where tmux put them); one no cell can hold is `?`.
 */
export function screenCells(lines: Run[][], columns: number, rows: number): Uint32Array {
  const cells = new Uint32Array(columns * rows * 3)
  for (let i = 0; i < columns * rows; i++) { cells[i * 3] = 0x20; cells[i * 3 + 1] = DEFAULT_COLOR; cells[i * 3 + 2] = DEFAULT_COLOR }
  lines.slice(0, rows).forEach((line, y) => {
    let x = 0
    const put = (cp: number, fg: Color, bg: Color) => {
      if (x >= columns) return
      const i = (y * columns + x) * 3
      cells[i] = cp
      cells[i + 1] = fg ?? DEFAULT_COLOR
      cells[i + 2] = bg ?? DEFAULT_COLOR
      x++
    }
    for (const run of line) {
      for (const ch of run.text) {
        const cp = ch.codePointAt(0)!
        if (isZeroWidth(cp)) continue
        if (cp === 0x09) { do put(0x20, run.fg, run.bg); while (x % 8 && x < columns); continue }
        if (isWide(cp)) { put(MISSING, run.fg, run.bg); put(0x20, run.fg, run.bg); continue }
        put(cp < 0x20 || !isCellable(cp) ? MISSING : cp, run.fg, run.bg)
      }
    }
  })
  return cells
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/** Standard padded base64 of the cells' little-endian bytes, as a Raster's `cells` take them. */
export function cellsBase64(cells: Uint32Array): string {
  const bytes = new Uint8Array(cells.length * 4)
  cells.forEach((w, i) => { bytes[i * 4] = w & 255; bytes[i * 4 + 1] = (w >>> 8) & 255; bytes[i * 4 + 2] = (w >>> 16) & 255; bytes[i * 4 + 3] = w >>> 24 })
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0)
    out += B64[n >> 18]! + B64[(n >> 12) & 63]! + (i + 1 < bytes.length ? B64[(n >> 6) & 63]! : '=') + (i + 2 < bytes.length ? B64[n & 63]! : '=')
  }
  return out
}

/** The cells a Raster's `cells` hold, back from base64 (tests read a drawn screen with it). */
export function cellsOf(base64: string): Uint32Array {
  const clean = base64.replace(/=+$/, '')
  const bytes = new Uint8Array(Math.floor(clean.length * 3 / 4))
  let n = 0, bits = 0, j = 0
  for (const ch of clean) {
    n = (n << 6) | B64.indexOf(ch); bits += 6
    if (bits >= 8) { bits -= 8; bytes[j++] = (n >> bits) & 255 }
  }
  const words = new Uint32Array(Math.floor(bytes.length / 4))
  for (let i = 0; i < words.length; i++) words[i] = (bytes[i * 4]! | (bytes[i * 4 + 1]! << 8) | (bytes[i * 4 + 2]! << 16) | (bytes[i * 4 + 3]! << 24)) >>> 0
  return words
}

/** The rows of characters in cells laid out `columns` wide, trailing blanks cut. */
export function cellsText(cells: Uint32Array, columns: number): string[] {
  const out: string[] = []
  for (let y = 0; y * columns * 3 < cells.length; y++) {
    let line = ''
    for (let x = 0; x < columns; x++) line += String.fromCodePoint(cells[(y * columns + x) * 3] ?? 0x20)
    out.push(line.replace(/\s+$/, ''))
  }
  return out
}

// ---------------------------------------------------------------- size

/** Rows the view draws above the screen: the title and keys line, and the input line. */
export const TERM_CHROME_ROWS = 2
/** A Raster's bounds (RasterProps). */
const RASTER_MAX = { columns: 512, rows: 256 }

/**
 * The screen's box in the pane, which is also the size lease sent to the broker: the pane body's columns, its
 * rows less the view's own two. The broker clamps a lease to 40–400 × 10–150; the Raster stays the pane's.
 */
export function termBox(bodyColumns: number | undefined, bodyRows: number | undefined): { cols: number; rows: number } {
  const cols = Math.max(1, Math.min(RASTER_MAX.columns, Math.floor(bodyColumns || 80)))
  const rows = Math.max(1, Math.min(RASTER_MAX.rows, Math.floor(bodyRows || 24) - TERM_CHROME_ROWS))
  return { cols, rows }
}

// ---------------------------------------------------------------- keys

/** The named keys the view's buttons send (tmux names, as web/dashboard/termkeys.js's touch row). */
export const TERM_KEYS: readonly { label: string; key: string }[] = [
  { label: 'Esc', key: 'Escape' }, { label: 'Tab', key: 'Tab' }, { label: '↑', key: 'Up' }, { label: '↓', key: 'Down' },
  { label: '←', key: 'Left' }, { label: '→', key: 'Right' }, { label: '⌫', key: 'BSpace' }, { label: '^C', key: 'C-c' },
]

/**
 * The keys that turn what the worker was sent (`before`) into the field's text (`after`): a Backspace per
 * character past their common start, then the rest as literal text. The field mirrors the worker's input line.
 */
export function fieldKeys(before: string, after: string): TermKey[] {
  const a = [...before], b = [...after]
  let same = 0
  while (same < a.length && same < b.length && a[same] === b[same]) same++
  const keys: TermKey[] = []
  for (let i = same; i < a.length; i++) keys.push({ t: 'key', v: 'BSpace' })
  const rest = b.slice(same).join('')
  if (rest) keys.push({ t: 'lit', v: rest })
  return keys
}

// ---------------------------------------------------------------- words

/** `14:05`, in the engine's local time. */
export function clockTime(at: string | number): string {
  const d = new Date(at)
  return Number.isNaN(d.getTime()) ? '' : `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** The input state as the view's line says it. */
export function inputLine(t: { input: boolean; until: string | null; offAt: string | null; state: string | null }): string {
  if (t.state === 'paused') return 'input off: the agent is paused'
  if (t.state === 'restarting') return 'input off: the agent is restarting'
  if (t.input) return `input ON${t.until ? ` until ${clockTime(t.until)}` : ''} (10 idle minutes turn it off)`
  if (t.offAt) return `input went off at ${clockTime(t.offAt)} (10 idle minutes)`
  return 'input off'
}
