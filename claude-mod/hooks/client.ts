// The broker client (PRD "Claude CLI mod", "Connection"): the dashboard API on 127.0.0.1:47800, signed in with
// the dashboard token as the `hl_dash` cookie. The token is read once, from `hauptling dashboard --print` (on
// Windows, where hauptling lives in WSL, through `wsl.exe` when it does not start), and kept in this module only: it is never
// logged, shown, or put in `$.state`. One small function per call.
//
// `$.http.fetch` resolves once the whole body is read, so it cannot hold `/dash/stream` open: the board is
// polled from `/dash/board` instead (live.ts). Streams (the terminal's `/dash/term/<id>/stream`) go through
// `curl` with its config on stdin, so the token stays off the command line: see `openStream`.
import type { EngineInterface } from 'claude-code'

import type { Board } from '../types'
import { parseSignIn, sseParser } from './board'
import type { SseEvent } from './board'

type $ = EngineInterface

/** Where the broker serves the dashboard (PRD "Connection"). */
export const DEFAULT_ORIGIN = 'http://127.0.0.1:47800'
/** The command that prints the sign-in link. `hauptling setup` may install a mod that names another. */
export const SIGN_IN_ARGV = ['hauptling', 'dashboard', '--print'] as const
/**
 * On Windows `hauptling` lives in WSL, off the Windows PATH: these are tried in order when it does not start
 * there. The login shell's form reads the profile, where an npm or `~/.local/bin` PATH is set.
 */
export const WSL_SIGN_IN_ARGVS = [
  ['wsl.exe', ...SIGN_IN_ARGV],
  ['wsl.exe', 'bash', '-lc', SIGN_IN_ARGV.join(' ')],
] as const

/** A broker answer that was not 2xx, or no answer. The message never holds the token. */
export class BrokerError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

let session: { token: string; origin: string } | null = null
/** The sign-in command that worked, tried first next time (a 401 signs in again). */
let signInArgv: readonly string[] | null = null

/** Forgets the token (a 401: it was rotated with `hauptling dashboard --new-token`). */
export const signOut = () => { session = null }

type SignInTry = { argv: readonly string[]; started: boolean; exitCode: number | null; stdout: string }

async function trySignIn($: $, argv: readonly string[]): Promise<SignInTry> {
  try {
    const out = await $.process.run(argv, { timeoutMs: 15e3 })
    return { argv, started: true, exitCode: out.exitCode, stdout: out.stdout }
  } catch {
    return { argv, started: false, exitCode: null, stdout: '' }
  }
}

/** What to try after `hauptling` did not start: on Windows, WSL's forms; elsewhere nothing. */
async function fallbackArgvs($: $, first: SignInTry): Promise<readonly (readonly string[])[]> {
  if (first.started) return []
  let platform: string | undefined
  try { platform = (await $.session.info()).platform } catch { /* unknown: no fallback */ }
  return platform === 'windows' ? WSL_SIGN_IN_ARGVS : []
}

async function signIn($: $): Promise<{ token: string; origin: string }> {
  if (session) return session
  const tries: SignInTry[] = [await trySignIn($, signInArgv ?? SIGN_IN_ARGV)]
  let link = tries[0]!.exitCode === 0 ? parseSignIn(tries[0]!.stdout) : null
  // The form that worked last failed: start over from `hauptling` (the broker may be down, or PATH changed).
  if (!link && signInArgv && signInArgv !== SIGN_IN_ARGV) { signInArgv = null; return signIn($) }
  // `hauptling` did not start: on Windows, through WSL. `wsl.exe` starts even where its shell lacks the command
  // (it then exits 1 or 127), so each form is tried until one prints the link.
  if (!link) {
    for (const argv of await fallbackArgvs($, tries[0]!)) {
      const t = await trySignIn($, argv)
      tries.push(t)
      link = t.exitCode === 0 ? parseSignIn(t.stdout) : null
      if (link) break
    }
  }
  if (!link) {
    const viaWsl = tries.slice(1)
    if (tries[0]!.started) throw new BrokerError(0, 'The broker is not running (hauptling dashboard --print failed)')
    if (!viaWsl.some(t => t.started)) throw new BrokerError(0, 'hauptling is not installed here')
    throw new BrokerError(0, 'The broker is not running, or hauptling is not on the WSL PATH (wsl.exe hauptling dashboard --print failed)')
  }
  signInArgv = tries[tries.length - 1]!.argv
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

/** An open event stream: its events, and `close`, which ends the `curl` behind it at once. */
export type StreamHandle = { events: AsyncGenerator<SseEvent>; close: () => void }

/**
 * The worker's terminal as server-sent events: `viewer` ({ id }), `frame` and `history` ({ text }), `input`
 * ({ input, until, state? }), `note` ({ text }), `end` ({ reason }). Ends with `close`, or when the broker ends it.
 */
export function termStream($: $, agent: string) {
  return openStream($, `/dash/term/${id(agent)}/stream`)
}

/**
 * Any server-sent-event route, read through `curl -K -` (the URL and cookie on its stdin, never on the command
 * line). Rejects when signing in fails; `events` rejects its first pull when curl cannot start. `close` calls
 * `return()` on the spawn's stream, which kills the child even while the loop waits on a quiet screen.
 */
export async function openStream($: $, path: string): Promise<StreamHandle> {
  const s = await signIn($)
  const config = [`url = "${s.origin}${path}"`, `header = "Cookie: hl_dash=${s.token}"`, 'no-buffer', 'silent', 'show-error', 'fail', ''].join('\n')
  const child = $.process.spawn({ argv: ['curl', '-K', '-'], input: config })
  let closed = false
  const parse = sseParser()
  async function* events(): AsyncGenerator<SseEvent> {
    try {
      for await (const piece of child) {
        if (closed) return
        if (piece.stream === 'stdout') yield* parse(piece.text)
      }
    } finally {
      closed = true
    }
  }
  const close = () => {
    if (closed) return
    closed = true
    child.return(undefined as never).catch(() => {})
  }
  return { events: events(), close }
}

// ---------------------------------------------------------------- usage (the pane header)

/** Each vendor's usage windows, spend and the model tier preference (`usage()` in src/dashboard.mjs). */
export function usage($: $) {
  return request<unknown>($, 'GET', '/dash/usage')
}
