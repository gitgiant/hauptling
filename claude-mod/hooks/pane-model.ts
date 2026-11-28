// Pure logic of the side pane (PRD "Claude CLI mod": "Pane keys", "Confirmation", "Suggest", "Extras"): no `$`,
// no clock, so each rule is tested directly. pane.tsx draws what these return and sends what they decide.
import type { Agent, Board, Delegator, PaneDetail, PanePending, PaneUsage } from '../types'
import type { MoveTo } from './client'
import { circleOf, ctxText, delegatorsHere, inGate, listed, shortModel, shortNames } from './board'
import type { Circle, Here } from './board'

// ---------------------------------------------------------------- keys

/**
 * What a pane key does. Button hotkeys are one digit or lowercase letter (Shift+s is s, and the arrows scroll the
 * pane), so the PRD's `S` is `c` and shift+↑/↓/top/bottom are u/v/f/l.
 */
export type PaneKey =
  | 'kill' | 'pause' | 'restart' | 'merge' | 'answer' | 'suggest' | 'claude' | 'terminal' | 'diff' | 'events'
  | 'up' | 'down' | 'top' | 'bottom' | 'yes' | 'no' | 'all' | 'options' | 'back' | 'gpu' | 'gate' | 'automerge'

/** Each key's hotkey and its label in the pane. */
export const KEYS: Record<PaneKey, { hotkey: string; label: string }> = {
  kill: { hotkey: 'k', label: 'kill' },
  pause: { hotkey: 'p', label: 'pause' },
  restart: { hotkey: 'r', label: 'restart' },
  merge: { hotkey: 'm', label: 'merge' },
  answer: { hotkey: 'a', label: 'answer' },
  suggest: { hotkey: 's', label: 'suggest' },
  claude: { hotkey: 'c', label: 'via Claude' },
  terminal: { hotkey: 't', label: 'terminal' },
  diff: { hotkey: 'd', label: 'diff' },
  events: { hotkey: 'e', label: 'events' },
  up: { hotkey: 'u', label: 'up' },
  down: { hotkey: 'v', label: 'down' },
  top: { hotkey: 'f', label: 'first' },
  bottom: { hotkey: 'l', label: 'last' },
  yes: { hotkey: 'y', label: 'yes' },
  no: { hotkey: 'n', label: 'no' },
  all: { hotkey: 'w', label: 'show all' },
  options: { hotkey: 'o', label: 'options' },
  back: { hotkey: 'b', label: 'back' },
  gpu: { hotkey: 'g', label: 'GPU' },
  gate: { hotkey: 'g', label: 'gate' },
  automerge: { hotkey: 'u', label: 'auto-merge' },
}

/** The keys of the table view's control row, in the order drawn. */
export const AGENT_KEYS: readonly PaneKey[] = [
  'kill', 'pause', 'restart', 'merge', 'answer', 'suggest', 'claude', 'terminal', 'diff', 'events', 'up', 'down', 'top', 'bottom',
]

/** Actions that ask y/n first (PRD "Confirmation"). */
export const CONFIRMED = ['kill', 'restart', 'merge'] as const
export type Confirmed = (typeof CONFIRMED)[number]
export const isConfirmed = (k: PaneKey): k is Confirmed => (CONFIRMED as readonly string[]).includes(k)

/**
 * A press of a confirmed action: `ask` puts the question up; `run` acts, when the same key is pressed again for
 * the same agent while its question is up (the double press skips the question).
 */
export function confirmStep(pending: PanePending | null, action: Confirmed, agent: string): 'ask' | 'run' {
  return pending && pending.action === action && pending.agent === agent ? 'run' : 'ask'
}

// ---------------------------------------------------------------- which agents, which one

/** The delegator the pane shows: the band's tab, else the first of this repo's. */
export function shownDelegator(board: Board | null, here: Here | null, tab: string | null): Delegator | null {
  const ds = here ? delegatorsHere(board, here) : []
  return ds.find(d => d.id === tab) ?? ds[0] ?? null
}

/** The pane's rows: what the band lists, or with "show all" every agent of the delegator the board holds. */
export function paneAgents(board: Board | null, delegator: string, now: number, showAll: boolean): Agent[] {
  if (!showAll) return listed(board, delegator, now)
  return (board?.agents ?? [])
    .filter(a => a.delegator === delegator)
    .sort((x, y) => (x.created_at < y.created_at ? -1 : x.created_at > y.created_at ? 1 : 0))
}

/** The selected agent: the one opened (Enter on the band, the band's focus, a row), else the first row. */
export const selectedOf = (agents: readonly Agent[], opened: string | null): Agent | null =>
  agents.find(a => a.id === opened) ?? agents[0] ?? null

// ---------------------------------------------------------------- rows

/** Age from a timestamp: `now`, `12m`, `3h`, `2d`. */
export function ageText(at: string, now: number): string {
  const t = Date.parse(at)
  if (!Number.isFinite(t)) return '—'
  const m = Math.floor(Math.max(0, now - t) / 60e3)
  if (m < 1) return 'now'
  if (m < 60) return `${m}m`
  if (m < 48 * 60) return `${Math.floor(m / 60)}h`
  return `${Math.floor(m / 1440)}d`
}

/** What a state reads as in the pane: the broker's headline, else the circle's label. */
export const stateText = (a: Agent, c: Circle = circleOf(a)): string => a.headline || c.label

/** `#12` for an agent's PR, or empty. */
export const prText = (a: Agent): string => (a.pr_number ? `#${a.pr_number}` : a.pr_url ? 'PR' : '')

export type Row = {
  id: string
  /** 1–9: its hotkey; later rows have none. */
  n: number
  circle: Circle
  name: string
  /** Model, ctx %, state, PR and age, after the name. */
  rest: string
  isSelected: boolean
}

/** The table: one row per agent, the band's columns plus state text, PR and age. */
export function rowsOf(agents: readonly Agent[], selected: string | null, now: number): Row[] {
  const names = shortNames(agents)
  return agents.map((a, i) => {
    const circle = circleOf(a)
    const rest = [shortModel(a), ctxText(a), stateText(a, circle), prText(a), ageText(a.created_at, now)].filter(Boolean).join(' · ')
    return { id: a.id, n: i + 1, circle, name: names.get(a.id)?.name ?? a.id, rest, isSelected: a.id === selected }
  })
}

// ---------------------------------------------------------------- header line

/** `5h`, `wk`; agy's Claude/GPT pool as `c/g 5h`. */
export function windowShort(window: string): string {
  const w = String(window)
  const pool = w.startsWith('3p-') ? 'c/g ' : ''
  const bare = pool ? w.slice(3) : w
  return pool + (/^(7d|week|weekly|wk)$/i.test(bare) ? 'wk' : bare)
}

/** One vendor's windows: own pool first, 5h before the week (as the dashboard's `sortWindows`). */
export function usageText(v: PaneUsage['vendors'][number]): string {
  const rank = (w: string) => (w.startsWith('3p-') ? 2 : 0) + (w.endsWith('5h') ? 0 : 1)
  const ls = [...v.limits].sort((a, b) => rank(a.window) - rank(b.window))
  return ls.length ? `${v.vendor} ${ls.map(l => `${windowShort(l.window)} ${Math.round(l.used_pct)}%`).join(' ')}` : `${v.vendor} —`
}

type Tests = { running?: unknown[]; queued?: number; limit?: number; auto?: boolean }
type Gpu = { available?: boolean; paused?: boolean; running?: { id: string }[]; queued?: unknown[] }

export type Header = {
  /** `d_111111 · acme/app`. */
  title: string
  /** `gate on (1 in the gate) · auto-merge off`. */
  merge: string
  /** `tests 1/3 · 2 queued`. */
  tests: string
  /** `GPU idle · 1 queued`, `GPU paused`, `GPU none`. */
  gpu: string
  /** Whether the GPU queue can be paused or resumed (a GPU is there): what `g` does. */
  gpuKey: 'pause' | 'resume' | null
  /** One entry per vendor: `claude 5h 42% wk 71%`. */
  usage: string[]
}

/** The pane's header line (PRD "Extras"): the gate and test queue, the GPU, each vendor's usage. */
export function headerOf(board: Board | null, d: Delegator, usage: PaneUsage | null): Header {
  const inTheGate = (board?.agents ?? []).filter(a => a.delegator === d.id && inGate(a)).length
  const t = (board?.tests ?? null) as Tests | null
  const running = Array.isArray(t?.running) ? t!.running.length : 0
  const queued = Number(t?.queued ?? 0)
  const tests = !t ? 'tests ?' : `${t.auto ? `tests ${running} running` : `tests ${running}/${t.limit ?? '?'}`}${queued ? ` · ${queued} queued` : ''}`
  const g = (board?.gpu ?? null) as Gpu | null
  const gq = Array.isArray(g?.queued) ? g!.queued.length : 0
  const gpu = !g ? 'GPU ?' : !g.available ? 'GPU none'
    : `GPU ${g.paused ? 'paused' : g.running?.length ? `busy ${g.running[0]!.id}` : 'idle'}${gq ? ` · ${gq} queued` : ''}`
  return {
    title: `${d.id} · ${d.repo ?? 'no repo'}`,
    merge: `gate ${d.gate ? 'on' : 'off'}${inTheGate ? ` (${inTheGate} in the gate)` : ''} · auto-merge ${d.automerge ? 'on' : 'off'}`,
    tests,
    gpu,
    gpuKey: g?.available ? (g.paused ? 'resume' : 'pause') : null,
    usage: usage ? usage.vendors.map(usageText) : ['usage …'],
  }
}

/** The parts of `/dash/usage` the header and the tier select read. */
export function usageOf(u: unknown): PaneUsage {
  const o = (u ?? {}) as { vendors?: unknown; prefer?: unknown }
  const vendors = (Array.isArray(o.vendors) ? o.vendors : []).flatMap((v: any) =>
    typeof v?.vendor === 'string'
      ? [{ vendor: v.vendor, limits: (Array.isArray(v.limits) ? v.limits : []).filter((l: any) => typeof l?.used_pct === 'number' && typeof l?.window === 'string').map((l: any) => ({ window: l.window, used_pct: l.used_pct })) }]
      : [])
  return { vendors, prefer: typeof o.prefer === 'string' ? o.prefer : null }
}

/** The model tiers `models.prefer` takes (src/models.mjs `PREFER`). */
export const TIERS = ['cheap', 'balanced', 'best'] as const

/** Where a delegator's new agents may run: `auto`, the hub, or a satellite the board lists. */
export function hostChoices(board: Board | null): string[] {
  const hosts = ((board as { hosts?: { name: string }[] } | null)?.hosts ?? []).map(h => h.name).filter(n => n && n !== 'hub')
  return ['auto', 'hub', ...hosts]
}

// ---------------------------------------------------------------- queue moves

/**
 * Where a queue key moves the agent among its delegator's queued agents, or why it can't (`error`). Up and down
 * swap with the neighbour (`before`/`after` it), top and bottom go to the ends.
 */
export function moveOf(board: Board | null, a: Agent, key: 'up' | 'down' | 'top' | 'bottom'): { to: MoveTo } | { error: string } {
  if (a.queue == null) return { error: 'not in the queue' }
  const q = (board?.agents ?? []).filter(x => x.delegator === a.delegator && x.queue != null).sort((x, y) => x.queue! - y.queue!)
  const i = q.findIndex(x => x.id === a.id)
  const first = i <= 0, last = i >= q.length - 1
  if ((key === 'up' || key === 'top') && first) return { error: 'already first in the queue' }
  if ((key === 'down' || key === 'bottom') && last) return { error: 'already last in the queue' }
  if (key === 'up') return { to: { before: q[i - 1]!.id } }
  if (key === 'down') return { to: { after: q[i + 1]!.id } }
  return { to: key === 'top' ? { top: true } : { bottom: true } }
}

// ---------------------------------------------------------------- suggest

/** The broker's mail limit (MAIL_MAX in src/util.mjs); a reply to an open ask answers it, at most 250. */
export const MAIL_MAX = 300
export const ANSWER_MAX = 250

/** The most a reply to this agent may hold. */
export const replyLimit = (a: Agent): number => (a.ask ? ANSWER_MAX : MAIL_MAX)

/** Why a reply can't be sent as typed, or null. */
export function replyError(text: string, limit: number): string | null {
  const t = text.trim()
  if (!t) return 'nothing to send'
  if (t.length > limit) return `too long: ${t.length} characters, the broker takes at most ${limit}; shorten it`
  return null
}

/** The prompt `c` hands this Claude session: the delegator adds context and replies itself. */
export const claudePrompt = (name: string, id: string, text: string): string => `suggest to ${name} (${id}): ${text.trim()}`

// ---------------------------------------------------------------- diff and events

/** The most lines a diff or event view draws (the tree's own bound is 20,000 nodes and 100,000 characters). */
export const DETAIL_LINES = 1500
const LINE_MAX = 300

const clipLines = (lines: string[]): string[] => {
  const out = lines.slice(0, DETAIL_LINES).map(l => (l.length > LINE_MAX ? `${l.slice(0, LINE_MAX - 1)}…` : l))
  if (lines.length > DETAIL_LINES) out.push(`… ${lines.length - DETAIL_LINES} more lines (the dashboard shows all)`)
  return out
}

type DiffIn = { base?: string; stat?: string; files?: { path: string; patch: string }[]; untracked?: string[]; note?: string }
type EventsIn = { items?: { at: string; kind: string; text: string; host?: string }[]; note?: string }

/** The diff view: the stat, then each file's patch, then untracked files. */
export function diffDetail(agent: string, d: DiffIn): PaneDetail {
  const lines: string[] = []
  if (d.base) lines.push(`against ${d.base}`)
  if (d.stat) lines.push(...d.stat.replace(/\n+$/, '').split('\n'))
  for (const f of d.files ?? []) lines.push('', ...String(f.patch ?? '').replace(/\n+$/, '').split('\n'))
  if (d.untracked?.length) lines.push('', 'untracked:', ...d.untracked.map(u => `  ${u}`))
  if (!lines.length) lines.push('no changes')
  return { agent, kind: 'diff', lines: clipLines(lines), note: d.note ?? null }
}

/** `11-28 12:03` from an ISO time (UTC, as the broker stores it). */
export const shortTime = (at: string): string => String(at ?? '').slice(5, 16).replace('T', ' ')

/** The events view: newest first, as the broker answers. */
export function eventsDetail(agent: string, t: EventsIn): PaneDetail {
  const lines = (t.items ?? []).map(i => `${shortTime(i.at)} ${i.kind.padEnd(8)} ${String(i.text ?? '').replace(/\s+/g, ' ')}`)
  return { agent, kind: 'events', lines: clipLines(lines.length ? lines : ['no events']), note: t.note ?? null }
}

/** How a diff line is coloured: added, removed, a hunk or file header, or plain. */
export function diffTone(line: string): 'success' | 'error' | 'suggestion' | null {
  if (/^(\+\+\+|---) /.test(line) || line.startsWith('diff --git')) return null
  if (line.startsWith('+')) return 'success'
  if (line.startsWith('-')) return 'error'
  if (line.startsWith('@@')) return 'suggestion'
  return null
}

/** The text of a thrown error, never more than one line. */
export const errorText = (err: unknown): string =>
  String((err as { message?: unknown })?.message ?? err ?? 'failed').split('\n')[0]!.slice(0, 200)
