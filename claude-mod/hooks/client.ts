// The broker client (PRD "Claude CLI mod", "Connection"): the dashboard API on 127.0.0.1:47800, signed in with
// the dashboard token as the `hl_dash` cookie. The token is read once, from `hauptling dashboard --print`, and
// kept in this module only: it is never logged, shown, or put in `$.state`. One small function per call.
//
// `$.http.fetch` resolves once the whole body is read, so it cannot hold `/dash/stream` open: the board is
// polled from `/dash/board` instead (live.ts). Streams (the terminal's `/dash/term/<id>/stream`) go through
// `curl` with its config on stdin, so the token stays off the command line: see `stream`.
import type { EngineInterface } from 'claude-code'

import type { Board } from '../types'
import { parseSignIn, sseParser } from './board'
import type { SseEvent } from './board'

type $ = EngineInterface

/** Where the broker serves the dashboard (PRD "Connection"). */
export const DEFAULT_ORIGIN = 'http://127.0.0.1:47800'
/** The command that prints the sign-in link. `hauptling setup` may install a mod that names another. */
export const SIGN_IN_ARGV = ['hauptling', 'dashboard', '--print'] as const

/** A broker answer that was not 2xx, or no answer. The message never holds the token. */
export class BrokerError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

let session: { token: string; origin: string } | null = null

/** Forgets the token (a 401: it was rotated with `hauptling dashboard --new-token`). */
export const signOut = () => { session = null }

async function signIn($: $): Promise<{ token: string; origin: string }> {
  if (session) return session
  let out
  try {
    out = await $.process.run(SIGN_IN_ARGV, { timeoutMs: 15e3 })
  } catch {
    throw new BrokerError(0, 'hauptling is not installed here')
  }
  const link = out.exitCode === 0 ? parseSignIn(out.stdout) : null
  if (!link) throw new BrokerError(0, 'The broker is not running (hauptling dashboard --print failed)')
  // Only a loopback origin: a `--host` link would send the cookie elsewhere.
  const origin = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(link.origin) ? link.origin : DEFAULT_ORIGIN
  session = { token: link.token, origin }
  return session
}

async function request<T>($: $, method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const s = await signIn($)
    const headers: Record<string, string> = { cookie: `hl_dash=${s.token}` }
    if (method === 'POST') Object.assign(headers, { 'content-type': 'application/json', 'x-hauptling': '1' })
    let r
    try {
      r = await $.http.fetch(`${s.origin}${path}`, { method, headers, ...(method === 'POST' ? { body: JSON.stringify(body ?? {}) } : {}) })
    } catch {
      throw new BrokerError(0, 'The broker does not answer')
    }
    if (r.status === 401 && attempt === 0) { signOut(); continue }
    let json: any = null
    try { json = r.text ? JSON.parse(r.text) : null } catch { /* not JSON */ }
    if (!r.ok) throw new BrokerError(r.status, String(json?.error ?? `HTTP ${r.status}`))
    return json as T
  }
}

const id = (s: string) => encodeURIComponent(s)

// ---------------------------------------------------------------- board

/** The board snapshot (`snapshot()` in src/dashboard.mjs). */
export function board($: $) {
  return request<Board>($, 'GET', '/dash/board')
}

// ---------------------------------------------------------------- actions

/** `/dash/do/<call>`: the broker's `ACTIONS` (src/dashboard.mjs). */
export type ActionCall =
  | 'answer' | 'reply' | 'pause' | 'unpause' | 'restart' | 'kill' | 'merge' | 'delegator.set'
  | 'gpu.pause' | 'gpu.resume' | 'test.run' | 'models.prefer' | 'satellite.revoke'

/**
 * Runs an action as the dashboard does: `act($, 'kill', { agent })`, `act($, 'reply', { agent, text })`,
 * `act($, 'answer', { ask, choice })`, `act($, 'delegator.set', { delegator, gate })`.
 */
export function act($: $, call: ActionCall, body: Record<string, unknown>) {
  return request<{ ok: true; result: unknown }>($, 'POST', `/dash/do/${call}`, body)
}

/** Where a queue move puts the agent: before or after another queued one, or at the top or bottom. */
export type MoveTo = { before: string } | { after: string } | { top: true } | { bottom: true }

/** Reorders the delegator's queue (`/dash/agents/<id>/move`). */
export function move($: $, agent: string, to: MoveTo) {
  return request<{ ok: true; result: unknown }>($, 'POST', `/dash/agents/${id(agent)}/move`, to)
}

// ---------------------------------------------------------------- agent detail

export type Diff = { base?: string; stat: string; files: { path: string; patch: string }[]; untracked?: string[]; note?: string }
export type Timeline = { items: { at: string; kind: string; text: string; host?: string }[]; note?: string }

/** The agent's changes against its base branch. */
export function diff($: $, agent: string) {
  return request<Diff>($, 'GET', `/dash/agent/${id(agent)}/diff`)
}
/** The agent's events, mail and asks, newest first. */
export function events($: $, agent: string) {
  return request<Timeline>($, 'GET', `/dash/agent/${id(agent)}/events`)
}
/** The screen saved when the agent was parked, or null. */
export function screen($: $, agent: string) {
  return request<{ text: string | null }>($, 'GET', `/dash/agent/${id(agent)}/screen`)
}

// ---------------------------------------------------------------- terminal

/** A key for `term/<id>/keys`: literal text, or a named key (`Enter`, `Escape`, `C-c`, … as the broker allows). */
export type TermKey = { t: 'lit'; v: string } | { t: 'key'; v: string }
export type TermInput = { input: boolean; until: string | null; state?: string }

/** Turns keyboard input to the worker's terminal on or off (the broker turns it off after 10 idle minutes). */
export function termInput($: $, agent: string, on: boolean) {
  return request<TermInput>($, 'POST', `/dash/term/${id(agent)}/input`, { on })
}
/** Types keys into the worker's terminal; input must be on. */
export function termKeys($: $, agent: string, keys: TermKey[]) {
  return request<TermInput>($, 'POST', `/dash/term/${id(agent)}/keys`, { keys })
}
/** This viewer's size lease on the worker's tmux window (`viewer` from the stream's `viewer` event), or null. */
export function termSize($: $, agent: string, viewer: string, size: { cols: number; rows: number } | null) {
  return request<{ ok: true }>($, 'POST', `/dash/term/${id(agent)}/size`, { viewer, size })
}

/**
 * The worker's terminal as server-sent events: `viewer` ({ id }), `frame` and `history` ({ text }), `note`,
 * `end`. Ends when the loop is left, `signal` aborts, or the broker closes it.
 */
export function termStream($: $, agent: string, signal?: AbortSignal) {
  return stream($, `/dash/term/${id(agent)}/stream`, signal)
}

/**
 * Any server-sent-event route, read through `curl -K -` (the URL and cookie on its stdin, never on the
 * command line). Rejects when curl is missing or the broker refuses.
 */
export async function* stream($: $, path: string, signal?: AbortSignal): AsyncGenerator<SseEvent> {
  const s = await signIn($)
  const config = [`url = "${s.origin}${path}"`, `header = "Cookie: hl_dash=${s.token}"`, 'no-buffer', 'silent', 'show-error', 'fail', ''].join('\n')
  const child = $.process.spawn({ argv: ['curl', '-K', '-'], input: config })
  const parse = sseParser()
  for await (const piece of child) {
    if (signal?.aborted) return
    if (piece.stream === 'stdout') yield* parse(piece.text)
  }
}
