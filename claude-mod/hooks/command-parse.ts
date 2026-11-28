// Pure logic for the `/h` slash commands (PRD "Slash commands"): no `$`, so parsing, naming an agent, queue
// moves and the answer texts are tested directly. commands.ts runs what `parseCommand` returns.
import type { Agent } from '../types'
import { cellWidth, circleOf, ctxText, idSuffix, shortModel, titleWord } from './board'
import type { Name } from './board'

/** The longest message the broker mails (`MAIL_MAX` in src/util.mjs). */
export const REPLY_MAX = 300
/** The longest typed answer to an open ask (the broker's `reply` bound for one). */
export const ANSWER_MAX = 250

export const HELP = [
  '/h                          open the Hauptling pane',
  '/h status                   the agents as a table',
  '/h kill|restart|merge <agent>   acts at once: typing the command is the confirmation',
  '/h pause|unpause <agent>',
  `/h reply <agent> <text>     send a message (up to ${REPLY_MAX} characters)`,
  '/h answer <agent> <choice or text>   answer its open question (choice number or words)',
  '/h move <agent> up|down|top|bottom   reorder the queue',
  '/h gate on|off              this delegator’s merge gate',
  '/h automerge on|off         this delegator’s auto-merge',
  '/h prefer cheap|balanced|best   highest model tier for new workers',
  '/h gpu pause|resume         the GPU test queue',
  '<agent>: its list number, initials (cv), word (vaporwave) or short name (claude·vaporwave)',
].join('\n')

export type AgentVerb = 'kill' | 'pause' | 'unpause' | 'restart' | 'merge'
export type MoveDirection = 'up' | 'down' | 'top' | 'bottom'
export type Prefer = 'cheap' | 'balanced' | 'best'

export type Command =
  | { kind: 'open' }
  | { kind: 'help' }
  | { kind: 'status' }
  | { kind: 'agent'; verb: AgentVerb; who: string }
  | { kind: 'reply'; who: string; text: string }
  | { kind: 'answer'; who: string; text: string }
  | { kind: 'move'; who: string; to: MoveDirection }
  | { kind: 'setting'; setting: 'gate' | 'automerge'; on: boolean }
  | { kind: 'prefer'; value: Prefer }
  | { kind: 'gpu'; verb: 'pause' | 'resume' }
  /** What to answer instead of doing anything. */
  | { kind: 'error'; message: string }

const AGENT_VERBS: readonly string[] = ['kill', 'pause', 'unpause', 'restart', 'merge']

/** What was typed after `/h`. Anything extra or missing is an error: nothing is guessed. */
export function parseCommand(args: string): Command {
  const line = String(args ?? '').trim()
  if (!line) return { kind: 'open' }
  const [head = '', ...words] = line.split(/\s+/)
  const verb = head.toLowerCase()
  const usage = (s: string): Command => ({ kind: 'error', message: `Usage: /h ${s}` })
  const only = words.length === 1 ? words[0]!.toLowerCase() : ''

  if (verb === 'help') return words.length ? usage('help') : { kind: 'help' }
  if (verb === 'status') return words.length ? usage('status') : { kind: 'status' }
  if (AGENT_VERBS.includes(verb)) {
    return words.length === 1 ? { kind: 'agent', verb: verb as AgentVerb, who: words[0]! } : usage(`${verb} <agent>`)
  }
  if (verb === 'reply' || verb === 'answer') {
    // The text is everything after the agent, spacing and line breaks kept.
    const m = /^\S+\s+(\S+)\s+([\s\S]+)$/.exec(line)
    return m ? { kind: verb, who: m[1]!, text: m[2]! } : usage(`${verb} <agent> <${verb === 'reply' ? 'text' : 'choice or text'}>`)
  }
  if (verb === 'move') {
    const to = words[1]?.toLowerCase()
    return words.length === 2 && (to === 'up' || to === 'down' || to === 'top' || to === 'bottom')
      ? { kind: 'move', who: words[0]!, to }
      : usage('move <agent> up|down|top|bottom')
  }
  if (verb === 'gate' || verb === 'automerge') {
    return only === 'on' || only === 'off' ? { kind: 'setting', setting: verb, on: only === 'on' } : usage(`${verb} on|off`)
  }
  if (verb === 'prefer') {
    return only === 'cheap' || only === 'balanced' || only === 'best' ? { kind: 'prefer', value: only } : usage('prefer cheap|balanced|best')
  }
  if (verb === 'gpu') return only === 'pause' || only === 'resume' ? { kind: 'gpu', verb: only } : usage('gpu pause|resume')
  return { kind: 'error', message: `Unknown command “${head}”. /h help lists them.` }
}

/**
 * The agent `who` names among the listed ones (the band's order and names): its list number, ID, short name,
 * word, `vendor·word` or initials. An ambiguous or unknown name gives the message to answer, with candidates.
 */
export function resolveAgent(agents: readonly Agent[], names: ReadonlyMap<string, Name>, who: string): { agent: Agent } | { error: string } {
  const w = who.toLowerCase()
  const label = (a: Agent) => `${agents.indexOf(a) + 1} ${names.get(a.id)?.name ?? a.id}`
  const unknown = () => ({
    error: agents.length ? `No agent “${who}”. Agents: ${agents.map(label).join(', ')}` : `No agent “${who}”: none are listed.`,
  })
  if (/^\d+$/.test(w)) {
    const a = agents[Number(w) - 1]
    return a ? { agent: a } : unknown()
  }
  // A name as shown is unique; the shorter forms may fit several.
  const shown = agents.filter(a => {
    const n = names.get(a.id)
    return a.id.toLowerCase() === w || n?.name.toLowerCase() === w || n?.initials.toLowerCase() === w
  })
  const found = shown.length ? shown : agents.filter(a => {
    const word = titleWord(a.title)
    const initials = `${a.vendor[0] ?? '?'}${word[0] ?? '?'}`
    return [word, `${a.vendor}·${word}`, initials, idSuffix(a.id)].some(x => x.toLowerCase() === w)
  })
  if (found.length === 1) return { agent: found[0]! }
  if (!found.length) return unknown()
  return { error: `“${who}” matches ${found.length} agents: ${found.map(label).join(', ')}` }
}

/** The `answer` body for what was typed: a choice by its words or its number (1 first), else free text. */
export function answerBody(ask: { id: number; choices: string[] }, text: string): { ask: number; choice: number } | { ask: number; text: string } {
  const t = text.trim()
  let i = ask.choices.findIndex(c => c.trim().toLowerCase() === t.toLowerCase())
  if (i < 0 && /^\d+$/.test(t) && Number(t) >= 1 && Number(t) <= ask.choices.length) i = Number(t) - 1
  return i >= 0 ? { ask: ask.id, choice: i } : { ask: ask.id, text: t }
}

/** Why a message can't be sent as it is, or null. */
export function tooLong(text: string, max: number): string | null {
  const n = text.trim().length
  return n > max ? `Too long: ${n} characters, the limit is ${max}. Nothing was sent.` : null
}

/**
 * The broker move for a direction, as the dashboard's keys do it (`keyMove` in web/dashboard/queue.js): up and
 * down trade places within the agent's group (unparking agents form their own). Null when it is already there.
 * `agent` must be queued.
 */
export function queueMove(agents: readonly Agent[], agent: Agent, to: MoveDirection): { before: string } | { after: string } | { top: true } | { bottom: true } | null {
  const group = agents
    .filter(a => a.queue != null && !a.ended && a.delegator === agent.delegator && Boolean(a.unpark) === Boolean(agent.unpark))
    .sort((x, y) => x.queue! - y.queue!)
  const at = group.findIndex(a => a.id === agent.id)
  if (to === 'top') return at === 0 ? null : { top: true }
  if (to === 'bottom') return at === group.length - 1 ? null : { bottom: true }
  const other = group[at + (to === 'up' ? -1 : 1)]
  if (!other) return null
  return to === 'up' ? { before: other.id } : { after: other.id }
}

/** `/h status`: a heading, then a row per agent in the band's order, an open question under its agent. */
export function statusText(d: { id: string; repo: string | null; gate: boolean; automerge: boolean }, agents: readonly Agent[], names: ReadonlyMap<string, Name>): string {
  const head = `${d.id} · ${d.repo} · gate ${d.gate ? 'on' : 'off'} · automerge ${d.automerge ? 'on' : 'off'}`
  if (!agents.length) return `${head}\nNo agents.`
  const rows = agents.map((a, i) => {
    const c = circleOf(a)
    return [String(i + 1), c.glyph, names.get(a.id)?.name ?? a.id, shortModel(a), ctxText(a), a.queue != null && !a.ended ? `${c.label} #${a.queue}` : c.label]
  })
  const widths = rows[0]!.map((_, col) => Math.max(...rows.map(r => cellWidth(r[col]!))))
  const lines = rows.flatMap((r, i) => {
    const line = r.map((v, col) => v + ' '.repeat(widths[col]! - cellWidth(v))).join('  ').trimEnd()
    const ask = agents[i]!.ask
    if (!ask) return [line]
    const choices = ask.choices.map((c, n) => `${n + 1}) ${c}`).join('  ')
    return [line, `    asks: ${ask.question.replace(/\s+/g, ' ')}${choices ? `  ${choices}` : ''}`]
  })
  return [head, ...lines].join('\n')
}
