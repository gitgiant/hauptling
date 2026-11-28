// The `/h` slash commands (PRD "Slash commands"): what the pane's keys do, from the prompt. Each reads a fresh
// board, names agents as the band lists them (the shown delegator tab), calls the dashboard's route and answers
// one short line: what was done, or the broker's error. The parsing and texts are in command-parse.ts.
import { atom, read } from 'claude-code'
import type { EngineInterface, On, SessionStartInput } from 'claude-code'

import type { Agent, Board } from '../types'
import { delegatorsHere, listed, shortNames } from './board'
import { act, board as fetchBoard, move } from './client'
import type { ActionCall } from './client'
import { ANSWER_MAX, HELP, REPLY_MAX, answerBody, parseCommand, queueMove, resolveAgent, statusText, tooLong } from './command-parse'
import type { Command } from './command-parse'
import { findHere } from './live'
import { openAgent } from './pane'

// This file's `$.state` atoms (contract: types/index.d.ts). The scan reads an atom only from a const of the
// file that uses it, so each file declares its own: keep the initial value and shape tag the same everywhere.
const hereState = atom({ plugin: 'hauptling', key: 'here' } as const, null)
const tabState = atom({ plugin: 'hauptling', key: 'tab' } as const, null)

type $ = EngineInterface

const DONE = { kill: 'Killed', pause: 'Paused', unpause: 'Resumed', restart: 'Restarted', merge: 'Merged' } as const

/** Runs an action: `done`, or what the broker says it did instead (a satellite's command, an answered ask). */
async function run($: $, call: ActionCall, body: Record<string, unknown>, done: string): Promise<string> {
  const r = (await act($, call, body)).result as { queued?: boolean; sent?: unknown; host?: string; note?: string; already?: string } | null
  // An agent on a satellite: stored while it is offline, or sent with no answer yet (PRD "Several hosts").
  if (r?.queued) return `Queued: will run when ${r.host} reconnects.`
  if (r?.sent === true && r.note) return `${r.note}.`
  if (r?.already != null) return `Already answered: ${r.already}`
  return done
}

/** The delegator the band shows and its listed agents, or the line that says why there is none. */
async function shown($: $) {
  const board: Board = await fetchBoard($)
  const here = (await read($, hereState)) ?? (await findHere($))
  const ds = delegatorsHere(board, here)
  const tab = await read($, tabState)
  const delegator = ds.find(d => d.id === tab) ?? ds[0]
  if (!delegator) return 'No active delegator for this repo.'
  const agents = listed(board, delegator.id, await $.clock.now())
  return { board, delegator, agents, names: shortNames(agents) }
}

async function answerCommand($: $, c: Command): Promise<string> {
  switch (c.kind) {
    case 'error': return c.message
    case 'help': return HELP
    case 'open':
      await openAgent($, null)
      return 'Opened the Hauptling pane.'
    case 'prefer':
      return run($, 'models.prefer', { value: c.value }, `New workers: ${c.value}.`)
    case 'gpu':
      return run($, `gpu.${c.verb}`, {}, c.verb === 'pause' ? 'GPU queue paused; a running job finishes.' : 'GPU queue resumed.')
  }

  const s = await shown($)
  if (typeof s === 'string') return s
  if (c.kind === 'status') return statusText(s.delegator, s.agents, s.names)
  if (c.kind === 'setting') {
    const what = c.setting === 'gate' ? 'Merge gate' : 'Auto-merge'
    return run($, 'delegator.set', { delegator: s.delegator.id, [c.setting]: c.on }, `${what} ${c.on ? 'on' : 'off'} for ${s.delegator.id}.`)
  }

  const found = resolveAgent(s.agents, s.names, c.who)
  if ('error' in found) return found.error
  const a: Agent = found.agent
  const name = s.names.get(a.id)?.name ?? a.id
  switch (c.kind) {
    case 'agent':
      return run($, c.verb, { agent: a.id }, `${DONE[c.verb]} ${name}.`)
    case 'reply': {
      // With a question open, the broker takes the message as its answer, which has the shorter limit.
      const long = tooLong(c.text, a.ask ? ANSWER_MAX : REPLY_MAX)
      if (long) return long
      return run($, 'reply', { agent: a.id, text: c.text.trim() }, a.ask ? `Answered ${name}.` : `Sent to ${name}.`)
    }
    case 'answer': {
      if (!a.ask) return `${name} has no open question. /h reply sends a message.`
      const body = answerBody(a.ask, c.text)
      const long = 'text' in body ? tooLong(body.text, ANSWER_MAX) : null
      if (long) return long
      const value = 'choice' in body ? a.ask.choices[body.choice] : body.text
      return run($, 'answer', body, `Answered ${name}: ${value}`)
    }
    case 'move': {
      if (a.queue == null || a.ended) return `${name} is ${a.state}; only queued agents can be moved.`
      const to = queueMove(s.board.agents, a, c.to)
      if (!to) return `${name} is already ${c.to === 'up' || c.to === 'top' ? 'first' : 'last'} in the queue.`
      await move($, a.id, to)
      return `Moved ${name} ${c.to === 'up' || c.to === 'down' ? c.to : `to the ${c.to}`}.`
    }
  }
}

/** The line `/h <args>` answers. A broker error is the answer, never a failed command. */
export async function runCommand($: $, args: string): Promise<string> {
  try {
    return await answerCommand($, parseCommand(args))
  } catch (e) {
    return e instanceof Error ? e.message : String(e)
  }
}

/** At session start: register `/h`. It runs while a turn is in flight too. */
export async function startCommands($: EngineInterface, _e: SessionStartInput): Promise<void> {
  await $.command.register({
    name: 'h',
    description: 'Hauptling: drive this repo’s agents (kill, pause, reply, …)',
    argumentHint: '[help | status | kill <agent> | …]',
    immediate: true,
  })
}

export function registerCommands(on: On): void {
  on('command.run', { command: 'h' }, async ($, e) => ({ text: await runCommand($, e.args) }))
}
