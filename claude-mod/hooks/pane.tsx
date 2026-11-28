// The side pane (PRD "Placement", "Pane keys", "Confirmation", "Suggest", "Extras"): the shown delegator's agents
// with the band's columns plus state, PR and age; the selected agent's controls; diff, events, asks, suggest; the
// delegator's options; a header line with the gate, the test queue, the GPU and each vendor's usage.
//
// Keys are Button hotkeys (one digit or lowercase letter, pressed while the pane holds the keyboard): k p r m a s
// t d e as the PRD names them; `S` is `c` (Shift+s is s) and the queue moves are u/v/f/l (the arrows scroll the
// pane). Kill, restart and merge ask y/n; the same key twice skips the question. Handlers re-read the state they
// act on, never a value captured while drawing. Drawing is views.tsx, rules are pane-model.ts.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, On, SessionStartInput } from 'claude-code'

import type { PanePending, PaneView } from '../types'
import { act, diff as fetchDiff, events as fetchEvents, move, usage as fetchUsage } from './client'
import { poll } from './live'
import {
  KEYS, claudePrompt, diffDetail, errorText, eventsDetail, headerOf, hostChoices, isConfirmed, confirmStep, moveOf,
  paneAgents, replyError, replyLimit, rowsOf, selectedOf, shownDelegator, usageOf,
} from './pane-model'
import type { PaneKey } from './pane-model'
import { shortNames } from './board'
import { closeTerminal, followAgent, openTerminal, renderTerminal, terminalAgent } from './terminal'
import { answerView, detailView, optionsView, suggestView, tableView } from './views'
import type { Els, PaneActs, PaneModel } from './views'

// This file's `$.state` atoms (contract: types/index.d.ts). The scan reads an atom only from a const of the
// file that uses it, so each file declares its own: keep the initial value and shape tag the same everywhere.
const boardState = atom({ plugin: 'hauptling', key: 'board' } as const, null, { shape: 'board-1' })
const linkState = atom({ plugin: 'hauptling', key: 'link' } as const, 'unknown')
const hereState = atom({ plugin: 'hauptling', key: 'here' } as const, null)
const tabState = atom({ plugin: 'hauptling', key: 'tab' } as const, null)
const openedState = atom({ plugin: 'hauptling', key: 'opened' } as const, null)
const viewState = atom({ plugin: 'hauptling', key: 'paneView' } as const, 'table')
const showAllState = atom({ plugin: 'hauptling', key: 'paneShowAll' } as const, false)
const pendingState = atom({ plugin: 'hauptling', key: 'panePending' } as const, null)
const statusState = atom({ plugin: 'hauptling', key: 'paneStatus' } as const, null)
const detailState = atom({ plugin: 'hauptling', key: 'paneDetail' } as const, null, { shape: 'detail-1' })
const usageState = atom({ plugin: 'hauptling', key: 'paneUsage' } as const, null, { shape: 'usage-1' })
const hostState = atom({ plugin: 'hauptling', key: 'paneHost' } as const, null)
const draftState = atom({ plugin: 'hauptling', key: 'paneDraft' } as const, null)

type $ = EngineInterface

/** The pane's id. */
export const PANE = 'hauptling'
/** How often the header's usage is read while the pane is open (the dashboard reads it every 30 s too). */
export const USAGE_MS = 30e3

/** Opens the pane on one agent (Enter or a digit on the band, `/h`): the table, no question up. */
export async function openAgent($: $, agent: string | null): Promise<void> {
  if (agent) await update($, openedState, () => agent)
  if (await terminalAgent($)) await closeTerminal($)
  await update($, viewState, () => 'table' as const)
  await update($, pendingState, () => null)
  await $.ui.open({ id: PANE, title: 'Hauptling', focus: true })
  void loadUsage($)
}

/** At session start: read the usage while the pane is open. */
export async function startPane($: $, _e: SessionStartInput): Promise<void> {
  $.clock.every(USAGE_MS, () => usageTick($))
}

async function usageTick($: $): Promise<void> {
  try {
    if ((await $.ui.panes()).some(p => p.id === PANE)) await loadUsage($)
  } catch { /* no pane list here: nothing to refresh */ }
}

/** The header's usage, from `/dash/usage`; quiet on failure (the header keeps the last reading). */
export async function loadUsage($: $): Promise<void> {
  try {
    const u = usageOf(await fetchUsage($))
    await update($, usageState, () => u)
  } catch { /* the broker is down: the band says so */ }
}

// ---------------------------------------------------------------- what the keys act on

/** The shown delegator, its rows and the selected agent, read fresh from state. */
async function scene($: $) {
  const [b, here, tab, opened, showAll] = await Promise.all([
    read($, boardState), read($, hereState), read($, tabState), read($, openedState), read($, showAllState),
  ])
  const d = shownDelegator(b, here, tab)
  if (!d) return null
  const agents = paneAgents(b, d.id, await $.clock.now(), showAll)
  const a = selectedOf(agents, opened)
  const name = a ? shortNames(agents).get(a.id)?.name ?? a.id : ''
  return { b, d, a, name }
}

async function say($: $, text: string, isError = false): Promise<void> {
  await update($, statusState, () => ({ text, isError }))
}

/** Every view change goes through here: leaving the terminal stops its stream and releases its lease. */
async function setView($: $, v: PaneView): Promise<void> {
  if (v !== 'terminal' && (await terminalAgent($))) await closeTerminal($)
  await update($, viewState, () => v)
}

/** Runs one broker call: `…` while it runs, then `done` or the error, and a fresh board. */
async function run($: $, doing: string, call: () => Promise<unknown>, done: string): Promise<boolean> {
  await say($, `${doing}…`)
  try {
    await call()
  } catch (err) {
    await say($, `${doing} failed: ${errorText(err)}`, true)
    return false
  }
  await say($, done)
  void poll($)
  return true
}

/** Kill, restart or merge, once confirmed. */
async function confirmed($: $, p: PanePending): Promise<void> {
  await update($, pendingState, () => null)
  const verb = { kill: 'Killing', restart: 'Restarting', merge: 'Merging' }[p.action]
  const done = { kill: 'killed', restart: 'restarted', merge: 'merged' }[p.action]
  await run($, `${verb} ${p.name}`, () => act($, p.action, { agent: p.agent }), `${p.name} ${done}`)
}

/** What a pane key does (PRD "Pane keys"). */
export async function pressKey($: $, key: PaneKey): Promise<void> {
  const s = await scene($)
  if (!s) return
  const { b, d, a, name } = s
  const pending = await read($, pendingState)
  // Any key but the question's own answers takes the question down.
  if (key !== 'yes' && !isConfirmed(key)) await update($, pendingState, () => null)

  switch (key) {
    case 'yes': if (pending) await confirmed($, pending); return
    case 'no': if (pending) await say($, `${KEYS[pending.action].label} cancelled`); return
    case 'back': await update($, draftState, () => null); await setView($, 'table'); return
    case 'all': await update($, showAllState, on => !on); return
    case 'options': await setView($, 'options'); return
    case 'gpu': {
      const g = headerOf(b, d, null).gpuKey
      if (!g) { await say($, 'no GPU on this host', true); return }
      await run($, g === 'pause' ? 'Pausing the GPU queue' : 'Resuming the GPU queue', () => act($, g === 'pause' ? 'gpu.pause' : 'gpu.resume', {}),
        g === 'pause' ? 'GPU queue paused; the running job finishes' : 'GPU queue resumed')
      return
    }
    case 'gate':
      await run($, `Turning the merge gate ${d.gate ? 'off' : 'on'}`, () => act($, 'delegator.set', { delegator: d.id, gate: !d.gate }), `merge gate ${d.gate ? 'off' : 'on'} for ${d.id}`)
      return
    case 'automerge':
      await run($, `Turning auto-merge ${d.automerge ? 'off' : 'on'}`, () => act($, 'delegator.set', { delegator: d.id, automerge: !d.automerge }), `auto-merge ${d.automerge ? 'off' : 'on'} for ${d.id}`)
      return
  }

  if (!a) { await say($, 'no agent selected', true); return }
  switch (key) {
    case 'kill':
    case 'restart':
    case 'merge': {
      const p = { action: key, agent: a.id, name }
      if (confirmStep(pending, key, a.id) === 'run') { await confirmed($, p); return }
      await update($, pendingState, () => p)
      await update($, statusState, () => null)
      return
    }
    case 'pause': {
      const un = a.state === 'paused'
      await run($, `${un ? 'Unpausing' : 'Pausing'} ${name}`, () => act($, un ? 'unpause' : 'pause', { agent: a.id }), `${name} ${un ? 'unpaused' : 'paused'}`)
      return
    }
    case 'answer':
      if (!a.ask) { await say($, `${name} has no open question`, true); return }
      await setView($, 'answer')
      return
    case 'suggest':
      // An open ask: the same key shows its choices; pressed there, it types an answer (sent as a reply).
      await setView($, a.ask && (await read($, viewState)) !== 'answer' ? 'answer' : 'suggest')
      return
    case 'claude': await setView($, 'claude'); return
    case 'terminal':
      await update($, statusState, () => null)
      await openTerminal($, a.id, name)
      await setView($, 'terminal')
      return
    case 'diff':
    case 'events': await showDetail($, key, a.id); return
    case 'up':
    case 'down':
    case 'top':
    case 'bottom': {
      const m = moveOf(b, a, key)
      if ('error' in m) { await say($, `${name}: ${m.error}`, true); return }
      await run($, `Moving ${name}`, () => move($, a.id, m.to), `${name} moved ${key === 'top' ? 'to the top' : key === 'bottom' ? 'to the bottom' : key}`)
      return
    }
  }
}

/** `d` or `e`: the view, filled once the broker answers; the same key again goes back to the table. */
async function showDetail($: $, kind: 'diff' | 'events', agent: string): Promise<void> {
  if ((await read($, viewState)) === kind) { await setView($, 'table'); return }
  await update($, detailState, () => null)
  await update($, statusState, () => null)
  await setView($, kind)
  try {
    const detail = kind === 'diff' ? diffDetail(agent, await fetchDiff($, agent)) : eventsDetail(agent, await fetchEvents($, agent))
    await update($, detailState, () => detail)
  } catch (err) {
    await say($, `${kind} failed: ${errorText(err)}`, true)
    await setView($, 'table')
  }
}

/** A row's Button, or the band's focus ring: the agent the pane acts on. */
async function selectAgent($: $, agent: string): Promise<void> {
  await update($, openedState, () => agent)
  // The terminal follows the selection: the old stream stops, the new agent's starts.
  if ((await read($, viewState)) !== 'terminal') return
  const s = await scene($)
  if (s?.a?.id === agent) await followAgent($, agent, s.name)
}

/** Picks one of an open ask's choices. */
async function answerChoice($: $, choice: number): Promise<void> {
  const s = await scene($)
  const ask = s?.a?.ask
  if (!s?.a || !ask) { await say($, 'no open question', true); return }
  const label = ask.choices[choice] ?? String(choice)
  if (await run($, `Answering ${s.name}`, () => act($, 'answer', { ask: ask.id, choice }), `answered ${s.name}: ${label}`)) await setView($, 'table')
}

/** `s`: sends typed text to the worker (`reply`; with an open ask it answers it). Too long: refused, kept. */
async function sendReply($: $, text: string): Promise<void> {
  const s = await scene($)
  if (!s?.a) { await say($, 'no agent selected', true); return }
  const bad = replyError(text, replyLimit(s.a))
  if (bad) {
    await update($, draftState, () => text)
    await say($, bad, true)
    return
  }
  const a = s.a
  if (await run($, `Sending to ${s.name}`, () => act($, 'reply', { agent: a.id, text: text.trim() }), a.ask ? `answered ${s.name}` : `sent to ${s.name}`)) {
    await update($, draftState, () => null)
    await setView($, 'table')
  }
}

/** `c`: hands the text to this Claude session as the person's prompt; the delegator replies itself. */
async function sendClaude($: $, text: string): Promise<void> {
  const s = await scene($)
  if (!s?.a) { await say($, 'no agent selected', true); return }
  if (!text.trim()) { await say($, 'nothing to suggest', true); return }
  const prompt = claudePrompt(s.name, s.a.id, text)
  if (await run($, 'Handing it to Claude', () => $.prompt.submit({ text: prompt, asUser: true }), 'handed to Claude as a prompt')) await setView($, 'table')
}

async function setHost($: $, host: string): Promise<void> {
  const s = await scene($)
  if (!s) return
  if (await run($, `Setting the host to ${host}`, () => act($, 'delegator.set', { delegator: s.d.id, host }), `new agents of ${s.d.id} run on ${host}`)) {
    await update($, hostState, () => host)
  }
}

async function setTier($: $, tier: string): Promise<void> {
  if (await run($, `Setting the model tier to ${tier}`, () => act($, 'models.prefer', { value: tier }), `new workers: ${tier}`)) await loadUsage($)
}

// ---------------------------------------------------------------- hooks

export function registerPane(on: On): void {
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const els = $.ui.resolve(e) as unknown as Els
    const { Text } = els
    const [b, here, tab, opened, link, view, showAll, pending, status, usage] = await Promise.all([
      read($, boardState), read($, hereState), read($, tabState), read($, openedState), read($, linkState),
      read($, viewState), read($, showAllState), read($, pendingState), read($, statusState), read($, usageState),
    ])
    if (link !== 'up') return <Text dimColor>The Hauptling broker does not answer.</Text>
    const d = shownDelegator(b, here, tab)
    if (!d) return <Text dimColor>No active delegator for this repo.</Text>
    const now = await $.clock.now()
    const agents = paneAgents(b, d.id, now, showAll)
    const sel = selectedOf(agents, opened)
    const rows = rowsOf(agents, sel?.id ?? null, now)
    const needs = (v: PaneView[]) => v.includes(view)
    const m: PaneModel = {
      d, header: headerOf(b, d, usage), rows, sel, selName: rows.find(r => r.id === sel?.id)?.name ?? '',
      view, pending, status, showAll,
      detail: needs(['diff', 'events']) ? await read($, detailState) : null,
      hosts: hostChoices(b),
      host: needs(['options']) ? await read($, hostState) : null,
      prefer: usage?.prefer ?? null,
      draft: needs(['suggest']) ? await read($, draftState) : null,
    }
    const acts: PaneActs = {
      press: k => pressKey($, k),
      select: id => selectAgent($, id),
      choose: i => answerChoice($, i),
      reply: t => sendReply($, t),
      claude: t => sendClaude($, t),
      host: name => setHost($, name),
      tier: t => setTier($, t),
    }
    switch (view) {
      case 'terminal': return renderTerminal($, e, () => pressKey($, 'back'))
      case 'diff':
      case 'events': return detailView(els, acts, m)
      case 'answer': return answerView(els, acts, m)
      case 'suggest':
      case 'claude': return suggestView(els, acts, m)
      case 'options': return optionsView(els, acts, m)
      default: return tableView(els, acts, m)
    }
  })

  // The selection follows the band's focus ring (PRD "Placement"), and the pane's own ring over its rows.
  on('ui.focus', { component: 'AbovePrompt' }, async ($, e, next) => {
    const r = await next(e)
    if (!r.deny && e.element && !e.element.startsWith('tab:')) await selectAgent($, e.element)
    return r
  }).catch(($, e, next) => next(e))
  on('ui.focus', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    const r = await next(e)
    if (!r.deny && e.element?.startsWith('row:')) await selectAgent($, e.element.slice('row:'.length))
    return r
  }).catch(($, e, next) => next(e))
}
