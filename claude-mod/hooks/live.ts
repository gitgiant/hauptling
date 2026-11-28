// Live data: finds this session's repo, polls the broker's board every 2 s into `$.state`, toasts new asks,
// blocks, reports and failed gates once each, and drives the red circle's blink. Everything that draws reads
// the atoms this fills (state.ts); nothing here draws.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, SessionStartInput } from 'claude-code'

import { alertsOf, bandModel, delegatorsHere, newAlerts, repoSlug } from './board'
import type { Here } from './board'
import { board as fetchBoard } from './client'

// This file's `$.state` atoms (contract: types/index.d.ts). The scan reads an atom only from a const of the
// file that uses it, so each file declares its own: keep the initial value and shape tag the same everywhere.
const boardState = atom({ plugin: 'hauptling', key: 'board' } as const, null, { shape: 'board-1' })
const linkState = atom({ plugin: 'hauptling', key: 'link' } as const, 'unknown')
const hereState = atom({ plugin: 'hauptling', key: 'here' } as const, null)
const tabState = atom({ plugin: 'hauptling', key: 'tab' } as const, null)
const alertsState = atom({ plugin: 'hauptling', key: 'alerts' } as const, { keys: [], primed: false }, { shape: 'alerts-1' })
const blinkState = atom({ plugin: 'hauptling', key: 'blink' } as const, false)

type $ = EngineInterface

/** How often the board is polled while the broker answers (the broker's own SSE tick is 2 s too). */
export const POLL_MS = 2000
/** The longest wait between tries while the broker does not answer. */
export const RETRY_MAX_MS = 30e3
/** The red circle's blink period, each half. */
export const BLINK_MS = 600

/** This session's repo, from git: the origin remote (or the first remote) and the checkout's top folder. */
export async function findHere($: $, cwd?: string): Promise<Here> {
  const git = async (...args: string[]) => {
    try {
      const r = await $.process.run(['git', ...args], { ...(cwd ? { cwd } : {}), timeoutMs: 5e3 })
      return r.exitCode === 0 ? r.stdout.trim() : ''
    } catch {
      return ''
    }
  }
  let remote = await git('remote', 'get-url', 'origin')
  if (!remote) {
    const first = (await git('remote')).split('\n')[0]
    if (first) remote = await git('remote', 'get-url', first)
  }
  return { slug: repoSlug(remote), root: (await git('rev-parse', '--show-toplevel')) || null }
}
let failures = 0
let retryAt = 0
let polling = false

/** One poll: the board into state, toasts for what is new. Quiet on failure (the band hides). */
export async function poll($: $): Promise<void> {
  if (polling) return
  const now = await $.clock.now()
  if (now < retryAt) return
  polling = true
  try {
    const b = await fetchBoard($)
    failures = 0
    retryAt = 0
    await update($, boardState, () => b)
    await update($, linkState, () => 'up' as const)
    const here = await read($, hereState)
    const mine = new Set(delegatorsHere(b, here ?? { slug: null, root: null }).map(d => d.id))
    const current = alertsOf(b, mine, now)
    const seen = await read($, alertsState)
    if (seen.primed) for (const a of newAlerts(seen.keys, current)) $.ui.toast(a.text)
    await update($, alertsState, () => ({ keys: current.map(a => a.key), primed: true }))
  } catch {
    failures++
    retryAt = now + Math.min(RETRY_MAX_MS, POLL_MS * 2 ** Math.min(failures - 1, 4))
    await update($, linkState, () => 'down' as const)
  } finally {
    polling = false
  }
}

/** Toggles the blink phase while a blinking circle is on the band; leaves state alone otherwise. */
async function blinkTick($: $): Promise<void> {
  const [b, here, tab] = await Promise.all([read($, boardState), read($, hereState), read($, tabState)])
  const m = here && bandModel(b, here, { now: await $.clock.now(), columns: 1e4, tab })
  if (m?.cells.some(c => c.circle.blink)) await update($, blinkState, on => !on)
}

/** At session start: find this session's repo, then poll the board and blink while the session lasts. */
export async function startLive($: $, e: SessionStartInput): Promise<void> {
  failures = 0
  retryAt = 0
  await update($, hereState, () => null)
  const here = await findHere($, e.cwd)
  await update($, hereState, () => here)
  void poll($)
  $.clock.every(POLL_MS, () => poll($))
  $.clock.every(BLINK_MS, () => blinkTick($))
}
