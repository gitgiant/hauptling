// Pure logic for the Claude CLI mod (PRD "Claude CLI mod"): no `$`, no clock, so every rule here is tested
// directly (test/board.test.ts). The band, pane, commands and toasts all derive what they show from these.
import type { Agent, Alert, Board, Delegator } from '../types'

/** Ended agents stay listed this long after their last update (PRD "Which agents"). */
export const FINISHED_MS = 30 * 60e3

/** The broker's ended states (`ENDED` in src/dashboard.mjs). */
const ENDED = ['merged', 'killed', 'closed', 'handed-off']

// ---------------------------------------------------------------- repo matching

/**
 * `owner/name` from a git remote URL (https, ssh `git@host:o/n`, `ssh://`), or a bare `owner/name`; null for a
 * local path or anything else.
 */
export function repoSlug(remote: string | null | undefined): string | null {
  const s = String(remote ?? '').trim()
  if (!s || /^[a-zA-Z]:[\\/]/.test(s) || s.startsWith('/') || s.startsWith('.') || s.startsWith('~')) return null
  const m =
    /^(?:[a-z+]+:\/\/(?:[^@/]+@)?[^/]+(?::\d+)?\/|[^@\s/]+@[^:\s/]+:)?([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i.exec(s)
  return m ? `${m[1]}/${m[2]}` : null
}

/** A local path with `\` as `/`, no trailing slash, for comparing. */
const cleanPath = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '')

/** Where this Claude session works: its git remote's `owner/name` and its checkout's top folder. */
export type Here = { slug: string | null; root: string | null }

/**
 * Whether a delegator's `repo` (an `owner/name`, a remote URL or a local path, as `hauptling delegator start`
 * stores it) is this session's repo.
 */
export function repoMatches(repo: string | null | undefined, here: Here): boolean {
  if (!repo) return false
  const slug = repoSlug(repo)
  if (slug) return here.slug != null && slug.toLowerCase() === here.slug.toLowerCase()
  return here.root != null && cleanPath(repo) === cleanPath(here.root)
}

/** The board's active delegators for this session's repo, oldest first (one band tab each). */
export function delegatorsHere(board: Board | null, here: Here): Delegator[] {
  return (board?.delegators ?? []).filter(d => repoMatches(d.repo, here))
}

// ---------------------------------------------------------------- which agents

/** Whether the band lists the agent: anything live, plus what ended in the last 30 minutes. */
export function isListed(a: Agent, now: number): boolean {
  if (!(a.ended || ENDED.includes(a.state))) return true
  const at = Date.parse(a.updated_at ?? '')
  return Number.isFinite(at) && now - at <= FINISHED_MS
}

/** A delegator's listed agents, in start order so their numbers (1–9) stay put. */
export function listed(board: Board | null, delegator: string, now: number): Agent[] {
  return (board?.agents ?? [])
    .filter(a => a.delegator === delegator && isListed(a, now))
    .sort((x, y) => (x.created_at < y.created_at ? -1 : x.created_at > y.created_at ? 1 : 0))
}

// ---------------------------------------------------------------- status circles

export type Circle = {
  glyph: string
  /** A theme key the surface colors it with. */
  color: 'success' | 'warning' | 'error' | 'inactive' | 'suggestion' | 'merged'
  dim: boolean
  blink: boolean
  /** In words, for a screen reader and the pane. */
  label: string
}

/** Whether the agent's merge gate is queued or running. */
export const inGate = (a: Agent): boolean =>
  a.test?.purpose === 'gate' && a.test.state !== 'done' && !a.test.status

/** The status circle (PRD "Status circles"). */
export function circleOf(a: Agent): Circle {
  const c = (glyph: string, color: Circle['color'], label: string, more: Partial<Circle> = {}): Circle => ({
    glyph, color, label, dim: false, blink: false, ...more,
  })
  if (a.host_state) return c('○', 'inactive', `host ${a.host_state}`, { dim: true })
  if (a.ask) return c('●!', 'error', 'asking', { blink: true })
  switch (a.state) {
    case 'blocked': return c('●!', 'error', 'blocked', { blink: true })
    case 'paused': return c('‖', 'inactive', 'paused')
    case 'queued':
    case 'waiting': return c('◌', 'inactive', a.state, { dim: true })
    case 'merged': return c('✓', 'success', 'merged')
    case 'handed-off': return c('✓', 'inactive', 'handed off', { dim: true })
    case 'killed':
    case 'closed':
    case 'failed':
    case 'exited': return c('✗', 'error', a.state)
  }
  if (inGate(a)) return c('◆', 'suggestion', 'in the gate')
  // Reported (done, parked) waits on a gate or a merge; a worker whose turn ended waits for mail: both idle.
  if (a.state === 'done' || a.state === 'parked') return c('◐', 'warning', a.state === 'done' ? 'reported' : 'parked')
  if (a.state === 'working' && a.idle) return c('◐', 'warning', 'idle')
  return c('●', 'success', a.state === 'working' ? 'running' : a.state)
}

// ---------------------------------------------------------------- short names

/** Words a title starts with that say nothing about the task. */
const STOP = new Set([
  'a', 'an', 'the', 'and', 'or', 'of', 'to', 'for', 'in', 'on', 'with', 'from', 'into', 'by', 'at', 'as', 'is',
  'add', 'adds', 'fix', 'fixes', 'make', 'use', 'new', 'update', 'support', 'implement', 'build', 'more', 'some',
  'first', 'part', 'task', 'do', 'get', 'set', 'let', 'allow', 'show', 'all', 'one', 'two', 'its', 'this', 'that',
])

/** The first distinctive word of a title, lowercased, after prefixes like `Scenes:` or `Fix:`. */
export function titleWord(title: string): string {
  let t = String(title ?? '').trim()
  // `Scenes: …`, `Fix: …`, `Claude CLI mod: …`: a short label before a colon, maybe several.
  while (/^[^:]{1,40}:\s+\S/.test(t)) t = t.replace(/^[^:]{1,40}:\s+/, '')
  const words = t.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean)
  return words.find(w => w.length >= 3 && !STOP.has(w) && !/^\d+$/.test(w)) ?? words[0] ?? 'task'
}

/** The 5-character suffix of an agent id (`claude_opus-5-5_3f2fc` → `3f2fc`). */
export const idSuffix = (id: string): string => id.slice(id.lastIndexOf('_') + 1) || id

export type Name = { name: string; initials: string }

/**
 * Short names for a list of agents (PRD "Short name"): `vendor·word`, with the ID suffix only where two clash;
 * initials (`cv`) for the collapsed band, also made unique with the suffix.
 */
export function shortNames(agents: readonly Agent[]): Map<string, Name> {
  const base = agents.map(a => {
    const word = titleWord(a.title)
    return { id: a.id, name: `${a.vendor}·${word}`, initials: `${a.vendor[0] ?? '?'}${word[0] ?? '?'}` }
  })
  const count = (key: 'name' | 'initials') => {
    const n = new Map<string, number>()
    for (const b of base) n.set(b[key], (n.get(b[key]) ?? 0) + 1)
    return n
  }
  const names = count('name'), initials = count('initials')
  return new Map(base.map(b => [b.id, {
    name: names.get(b.name)! > 1 ? `${b.name}·${idSuffix(b.id)}` : b.name,
    initials: initials.get(b.initials)! > 1 ? `${b.initials}${idSuffix(b.id).slice(0, 2)}` : b.initials,
  }]))
}

/** The model as the band shows it: without the vendor's own prefix (`claude-opus-5-5` → `opus-5-5`). */
export const shortModel = (a: Agent): string => String(a.model ?? '').replace(/^claude-/, '')

/** `42%` from `usage.context_pct`, `—` where the worker reports none. */
export function ctxText(a: Agent): string {
  const p = a.usage?.context_pct
  return typeof p === 'number' && Number.isFinite(p) ? `${Math.round(p)}%` : '—'
}

// ---------------------------------------------------------------- the band

export type Cell = {
  id: string
  /** 1–9: its hotkey; later agents have none. */
  n: number
  name: string
  initials: string
  model: string
  ctx: string
  circle: Circle
}

export type Tab = { id: string; label: string }

export type BandModel = {
  tabs: Tab[]
  /** The delegator whose agents are shown. */
  tab: string
  /** `full`: name | model | ctx | circle; `short`: circle plus initials. */
  mode: 'full' | 'short'
  cells: Cell[]
  /** Agents left out for lack of room (`+N`). */
  more: number
}

/** Terminal cells a string takes (each code point one cell: the glyphs used here are all narrow). */
export const cellWidth = (s: string): number => [...s].length

/** The separator between two agents. */
export const GAP = '  '

/** What a cell draws, in either mode, after the `1: ` the terminal draws for its hotkey. */
export const cellText = (c: Cell, mode: 'full' | 'short'): string =>
  mode === 'full' ? `${c.name} ${c.model} ${c.ctx} ${c.circle.glyph}` : `${c.circle.glyph} ${c.initials}`

/** Cells a band cell takes: its text plus its hotkey's `1: `. */
export const cellSize = (c: Cell, mode: 'full' | 'short'): number => (c.n <= 9 ? 3 : 0) + cellWidth(cellText(c, mode))

/** The tab label as drawn: the shown delegator bracketed, the others padded to the same width. */
export const tabText = (t: Tab, isShown: boolean): string => (isShown ? `[${t.label}]` : ` ${t.label} `)

/** Cells the tabs take with the gap after each; none for a single delegator (no tabs). */
export const tabsWidth = (tabs: readonly Tab[]): number =>
  tabs.length < 2 ? 0 : tabs.reduce((w, t) => w + cellWidth(tabText(t, false)) + GAP.length, 0)

/**
 * Which mode fits `columns`, and how many cells: full if every cell fits, else short, else as many short cells
 * as fit beside a `+N`.
 */
export function fit(cells: readonly Cell[], columns: number, reserved = 0): { mode: 'full' | 'short'; shown: number } {
  const total = (mode: 'full' | 'short', k: number) =>
    reserved + cells.slice(0, k).reduce((w, c, i) => w + (i ? GAP.length : 0) + cellSize(c, mode), 0)
  if (total('full', cells.length) <= columns) return { mode: 'full', shown: cells.length }
  if (total('short', cells.length) <= columns) return { mode: 'short', shown: cells.length }
  let k = cells.length
  while (k > 0 && total('short', k) + GAP.length + cellWidth(`+${cells.length - k}`) > columns) k--
  return { mode: 'short', shown: k }
}

/**
 * The band to draw: null when this session's repo has no active delegator (no band). `tab` picks the delegator
 * (the first when unset or gone).
 */
export function bandModel(board: Board | null, here: Here, opts: { now: number; columns: number; tab?: string | null }): BandModel | null {
  const ds = delegatorsHere(board, here)
  if (!ds.length) return null
  const d = ds.find(x => x.id === opts.tab) ?? ds[0]!
  const tabs = ds.map(x => ({ id: x.id, label: x.id }))
  const agents = listed(board, d.id, opts.now)
  const names = shortNames(agents)
  const cells = agents.map((a, i): Cell => ({
    id: a.id, n: i + 1, ...names.get(a.id)!, model: shortModel(a), ctx: ctxText(a), circle: circleOf(a),
  }))
  const { mode, shown } = fit(cells, opts.columns, tabsWidth(tabs))
  return { tabs: tabs.length > 1 ? tabs : [], tab: d.id, mode, cells: cells.slice(0, shown), more: cells.length - shown }
}

// ---------------------------------------------------------------- toasts

/** A small stable hash, to tell one report text from the next. */
export function hash(s: string): string {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0
  return h.toString(36)
}

const clip = (s: string, n = 120) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim()
  return t.length > n ? `${t.slice(0, n - 1)}…` : t
}

/**
 * What deserves a toast now, for these delegators' agents (PRD "Extras"): an open ask, a block, a report, a
 * failed gate. Each key stands for one event: the same key on the next board is the same event.
 */
export function alertsOf(board: Board | null, delegators: ReadonlySet<string>, now: number): Alert[] {
  const out: Alert[] = []
  const agents = (board?.agents ?? []).filter(a => delegators.has(a.delegator))
  const names = shortNames(agents.filter(a => isListed(a, now)))
  for (const a of agents) {
    const who = names.get(a.id)?.name ?? a.id
    if (a.ask) out.push({ key: `ask:${a.ask.id}`, text: `${who} asks: ${clip(a.ask.question)}` })
    else if (a.state === 'blocked') out.push({ key: `block:${a.id}`, text: `${who} is stuck: ${clip(a.headline ?? a.status ?? 'blocked')}` })
    if (a.report) out.push({ key: `report:${a.id}:${hash(a.report)}`, text: `${who} reported: ${clip(a.report)}` })
    const t = a.test
    if (t?.purpose === 'gate' && (t.status === 'fail' || t.status === 'error')) {
      const total = (t.passed ?? 0) + (t.failed ?? 0)
      out.push({ key: `gate:${t.id}`, text: `${who}: merge gate failed${total ? ` (${t.passed ?? 0}/${total})` : ''}` })
    }
  }
  return out
}

/** The alerts not seen on the last board: the toasts to show, once each. */
export const newAlerts = (seen: readonly string[], now: readonly Alert[]): Alert[] => {
  const was = new Set(seen)
  return now.filter(x => !was.has(x.key))
}

// ---------------------------------------------------------------- server-sent events

export type SseEvent = { event: string; data: string }

/**
 * Splits a text/event-stream into events, for a stream read in pieces: feed it each piece, it returns the
 * events completed so far and keeps the rest.
 */
export function sseParser(): (piece: string) => SseEvent[] {
  let buf = ''
  return piece => {
    buf += piece.replace(/\r\n?/g, '\n')
    const out: SseEvent[] = []
    let i: number
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, i)
      buf = buf.slice(i + 2)
      let event = 'message'
      const data: string[] = []
      for (const line of block.split('\n')) {
        if (!line || line.startsWith(':')) continue
        const c = line.indexOf(':')
        const field = c < 0 ? line : line.slice(0, c)
        const value = c < 0 ? '' : line.slice(c + 1).replace(/^ /, '')
        if (field === 'event') event = value
        else if (field === 'data') data.push(value)
      }
      if (data.length) out.push({ event, data: data.join('\n') })
    }
    return out
  }
}

/** The token from `hauptling dashboard --print`'s sign-in link (`…/?k=<token>`) and the link's origin. */
export function parseSignIn(text: string): { token: string; origin: string } | null {
  const m = /(https?:\/\/[^\s/?#]+)\/?\?k=([\w-]+)/.exec(String(text ?? ''))
  return m ? { origin: m[1]!, token: m[2]! } : null
}
