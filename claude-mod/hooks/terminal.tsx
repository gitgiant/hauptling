// The worker's live terminal in the pane (PRD "Terminal"): `t` on an agent shows its tmux screen from the broker's
// term stream (`curl` through `$.process.spawn`, client.ts), the parked screen (`/dash/agent/<id>/screen`) until the
// first live frame. The worker's window takes the screen's box as this viewer's size lease, the same lease as the
// web terminal's. `i` turns input on (the engine binds no chord in a pane: hotkeys are one letter); a field then
// mirrors the worker's input line key by key, Enter sends Enter, and buttons send Esc, Tab, arrows, ⌫ and ^C.
//
// Only the newest frame is drawn: frames that come while one is being written are dropped, never queued. The
// stream stops and the lease is released when the view closes, the pane closes, the agent changes or ends, and
// when the session ends. Rules are term-model.ts; the pane (pane.tsx) opens, closes and draws this view.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, On, RenderInput, SessionStartInput } from 'claude-code'

import type { Board, TermView } from '../types'
import { screen as fetchScreen, termInput, termKeys, termSize, termStream } from './client'
import type { StreamHandle, TermInput, TermKey } from './client'
import { errorText } from './pane-model'
import { TERM_KEYS, cellsBase64, fieldKeys, inputLine, screenCells, screenLines, termBox } from './term-model'

// This file's `$.state` atoms (contract: types/index.d.ts). The scan reads an atom only from a const of the
// file that uses it, so each file declares its own: keep the initial value and shape tag the same everywhere.
const termState = atom({ plugin: 'hauptling', key: 'term' } as const, null, { shape: 'term-1' })

type $ = EngineInterface

/** The pane's id (pane.tsx's `PANE`; not imported, as pane.tsx imports this file). */
const PANE_ID = 'hauptling'
/** The input field's key: `$.ui.focus` puts the ring on it when input turns on. */
export const TERM_FIELD = 'term:keys'
/** The screen's Raster key. */
export const TERM_SCREEN = 'term:screen'

/** The open stream: which agent, its curl, this viewer's id and the lease last sent. */
type Live = { gen: number; agent: string; handle: StreamHandle | null; viewer: string | null; sent: string | null; wantInput: boolean }

let live: Live | null = null
let gens = 0
/** The screen's box, from the pane's last drawing. */
let box = termBox(undefined, undefined)
/** The newest frame not yet written to state, and whether a write is running (drop, don't queue). */
let pendingFrame: { gen: number; agent: string; text: string } | null = null
let writing = false
/** Keys go out one batch at a time, in the order typed. */
let sending: Promise<void> = Promise.resolve()

/** At session start: no terminal is open (a reload leaves none running: its curl died with the old module). */
export async function startTerminal($: $, _e: SessionStartInput): Promise<void> {
  live = null
  await update($, termState, () => null)
}

async function patch($: $, agent: string, fields: Partial<TermView>): Promise<void> {
  await update($, termState, v => (v && v.agent === agent ? { ...v, ...fields } : v))
}

// ---------------------------------------------------------------- open and close

/** Shows `agent`'s terminal: the stream starts, the parked screen fills in until the first live frame. */
export async function openTerminal($: $, agent: string, name: string): Promise<void> {
  await stopStream($)
  const gen = ++gens
  live = { gen, agent, handle: null, viewer: null, sent: null, wantInput: false }
  await update($, termState, () => ({
    agent, name, frame: null, saved: false, input: false, until: null, state: null, offAt: null, typed: '', note: null, ended: null,
  }))
  // The stream starts on the clock, not inside the press that opened it: a press settles, a stream runs on.
  $.clock.after(0, () => runStream($, gen))
  void firstScreen($, gen, agent)
}

/** Closes the view: the stream stops, the lease is released, nothing is drawn. */
export async function closeTerminal($: $): Promise<void> {
  await stopStream($)
  await update($, termState, () => null)
}

/** The pane's selection moved while the terminal shows: it follows to the new agent. */
export async function followAgent($: $, agent: string, name: string): Promise<void> {
  const t = await read($, termState)
  if (t && t.agent !== agent) await openTerminal($, agent, name)
}

/** The agent the terminal shows, or null. */
export async function terminalAgent($: $): Promise<string | null> {
  return (await read($, termState))?.agent ?? null
}

/** Ends the stream (curl killed) and releases this viewer's lease; the view keeps its last screen. */
async function stopStream($: $): Promise<void> {
  const l = live
  live = null
  if (!l) return
  const release = l.viewer ? termSize($, l.agent, l.viewer, null).catch(() => {}) : null
  l.handle?.close()
  await release
}

/** The stream ended on its own or the agent ended: stop it, say why, keep the last screen. */
async function endStream($: $, l: Live, reason: string): Promise<void> {
  if (live !== l) return
  await stopStream($)
  await patch($, l.agent, { ended: reason, input: false })
}

/**
 * After each board poll (live.ts): an agent that ended takes its terminal down, and so does a pane no longer
 * open (the `ui.close` hook's backstop: an unload or a close no hook heard).
 */
export async function terminalBoard($: $, b: Board): Promise<void> {
  const l = live
  if (!l) return
  const a = b.agents.find(x => x.id === l.agent)
  if (!a || a.ended) { await endStream($, l, a ? `the agent ended (${a.state})` : 'the agent left the board'); return }
  let open = true
  try { open = (await $.ui.panes()).some(p => p.id === PANE_ID) } catch { /* no pane list here: keep it */ }
  if (!open && live === l) await closeTerminal($)
}

async function firstScreen($: $, gen: number, agent: string): Promise<void> {
  try {
    const s = await fetchScreen($, agent)
    if (live?.gen !== gen || !s?.text) return
    await update($, termState, v => (v && v.agent === agent && v.frame === null ? { ...v, frame: s.text, saved: true } : v))
  } catch { /* no saved screen: the stream's first frame comes anyway */ }
}

async function runStream($: $, gen: number): Promise<void> {
  const l = live
  if (!l || l.gen !== gen) return
  let handle: StreamHandle
  try {
    handle = await termStream($, l.agent)
  } catch (err) {
    await endStream($, l, `no terminal: ${errorText(err)}`)
    return
  }
  if (live !== l) { handle.close(); return }
  l.handle = handle
  let reason = 'the terminal stream ended'
  try {
    for await (const ev of handle.events) {
      if (live !== l) break
      let data: any = {}
      try { data = JSON.parse(ev.data) } catch { /* not JSON */ }
      if (ev.event === 'viewer') { l.viewer = String(data?.id ?? ''); l.sent = null; void sendSize($, l) }
      else if (ev.event === 'frame') showFrame($, gen, l.agent, String(data?.text ?? ''))
      else if (ev.event === 'input') await inputChanged($, l, data as TermInput)
      else if (ev.event === 'note') await patch($, l.agent, { note: data?.text ? String(data.text) : null })
      else if (ev.event === 'end') { reason = String(data?.reason || reason); break }
    }
  } catch (err) {
    reason = `the terminal stream failed: ${errorText(err)}`
  }
  await endStream($, l, reason)
}

/** Keeps the newest frame only: one write at a time, and whatever came meanwhile replaces what waits. */
function showFrame($: $, gen: number, agent: string, text: string): void {
  pendingFrame = { gen, agent, text }
  if (!writing) void writeFrames($)
}

async function writeFrames($: $): Promise<void> {
  writing = true
  try {
    while (pendingFrame) {
      const f = pendingFrame
      pendingFrame = null
      if (live?.gen === f.gen) await patch($, f.agent, { frame: f.text, saved: false })
    }
  } finally {
    writing = false
  }
}

// ---------------------------------------------------------------- size

/** The pane drew at this size (pane.tsx, every drawing): the screen's box, sent as the lease when it changed. */
export function paneSized($: $, bodyColumns: number | undefined, bodyRows: number | undefined): void {
  box = termBox(bodyColumns, bodyRows)
  if (live) void sendSize($, live)
}

async function sendSize($: $, l: Live): Promise<void> {
  if (!l.viewer || live !== l) return
  const size = { ...box }
  const key = `${size.cols}x${size.rows}`
  if (l.sent === key) return
  l.sent = key
  try {
    await termSize($, l.agent, l.viewer, size)
  } catch {
    if (l.sent === key) l.sent = null // tried again at the next drawing
  }
}

// ---------------------------------------------------------------- input

async function inputChanged($: $, l: Live, st: TermInput): Promise<void> {
  const on = Boolean(st?.input)
  // Off while this viewer had it on, and not by its own `i`: the broker's idle-off (or another viewer).
  const wentOff = l.wantInput && !on
  l.wantInput = on
  const fields: Partial<TermView> = { input: on, until: st?.until ?? null, state: st?.state ?? null }
  if (on) fields.offAt = null
  if (wentOff) { fields.offAt = new Date(await $.clock.now()).toISOString(); fields.typed = '' }
  await patch($, l.agent, fields)
}

/** `i`: input on or off for the shown agent. */
export async function toggleInput($: $): Promise<void> {
  const t = await read($, termState)
  const l = live
  if (!t || !l || l.agent !== t.agent) return
  const on = !t.input
  l.wantInput = on
  try {
    const r = await termInput($, t.agent, on)
    l.wantInput = r.input
    await patch($, t.agent, { input: r.input, until: r.until, state: r.state ?? null, offAt: null, typed: '', note: on && !r.input ? 'input stays off' : null })
    if (r.input) void $.ui.focus({ requestId: PANE_ID, key: TERM_FIELD }).catch(() => {})
  } catch (err) {
    l.wantInput = t.input
    await patch($, t.agent, { note: `input ${on ? 'on' : 'off'} failed: ${errorText(err)}` })
  }
}

/** The field changed (`submit`: Enter): the worker's input line is brought to match, then Enter on submit. */
export async function typeInto($: $, value: string, submit: boolean): Promise<void> {
  const t = await read($, termState)
  if (!t?.input || !live || live.agent !== t.agent) return // input off: nothing is sent
  const keys = fieldKeys(t.typed, value)
  if (submit) keys.push({ t: 'key', v: 'Enter' })
  await patch($, t.agent, { typed: submit ? '' : value })
  if (keys.length) await sendKeys($, t.agent, keys)
}

/** A key button (Esc, Tab, arrows, ⌫, ^C). The field starts over: the worker's line is no longer what it sent. */
export async function pressTermKey($: $, key: string): Promise<void> {
  const t = await read($, termState)
  if (!t?.input || !live || live.agent !== t.agent) return
  await patch($, t.agent, { typed: key === 'BSpace' ? [...t.typed].slice(0, -1).join('') : '' })
  await sendKeys($, t.agent, [{ t: 'key', v: key }])
}

function sendKeys($: $, agent: string, keys: TermKey[]): Promise<void> {
  const next = sending.then(() => postKeys($, agent, keys))
  sending = next.catch(() => {})
  return next
}

async function postKeys($: $, agent: string, keys: TermKey[]): Promise<void> {
  try {
    const r = await termKeys($, agent, keys)
    await patch($, agent, { until: r.until, input: r.input, state: r.state ?? null })
  } catch (err) {
    await patch($, agent, { note: `keys not sent: ${errorText(err)}` })
  }
}

// ---------------------------------------------------------------- drawing

/** The terminal view, drawn into the pane by pane.tsx's render hook; `back` is the pane's `b`. */
export async function renderTerminal($: $, e: RenderInput<'Pane'>, back: () => Promise<void>) {
  const els = $.ui.resolve(e) as any
  const { Box, Text, Button, Input } = els
  paneSized($, e.props.bodyColumns, e.props.scroll?.bodyRows)
  const t = await read($, termState)
  if (!t) {
    return (
      <Box flexDirection="column">
        <Text dimColor>No terminal open.</Text>
        <Button key="key:back" plain hotkey="b" label="back" onPress={back} />
      </Box>
    )
  }
  const on = t.input && !t.ended
  // While input is on, letters belong to the worker: the view's own buttons then have no hotkeys.
  const hk = (k: string) => (on ? {} : { hotkey: k })
  const lines = screenLines(t.frame ?? '')
  const { cols, rows } = box
  const Raster = e.surface === 'terminal' ? els.Raster : null
  const hex = (c: number | null) => (c === null ? undefined : `#${c.toString(16).padStart(6, '0')}`)
  const state = t.ended ? `ended: ${t.ended}` : inputLine(t)
  const hint = t.note ?? (t.ended ? 'b: back' : t.saved ? 'the screen saved at parking; waiting for the live one' : t.frame === null ? 'connecting…' : 'i: type into the worker · Esc: back to the prompt')
  return (
    <Box flexDirection="column">
      <Box flexDirection="row" columnGap={2}>
        <Text bold wrap="truncate-end">{t.name}</Text>
        <Text color={t.ended ? 'error' : on ? 'warning' : undefined} dimColor={!on && !t.ended} wrap="truncate-end">{state}</Text>
        {!t.ended && <Button key="term:input" plain {...hk('i')} label={on ? 'input off' : 'input on'} onPress={() => toggleInput($)} />}
        <Button key="key:back" plain {...hk('b')} label="back" onPress={back} />
      </Box>
      {on ? (
        <Box flexDirection="row" columnGap={1}>
          <Input key={TERM_FIELD} label="keys " value={t.typed} submitLabel="Enter" placeholder="typed keys go to the worker"
            onInput={(v: string) => typeInto($, v, false)} onSubmit={(v: string) => typeInto($, v, true)} />
          {TERM_KEYS.map(k => <Button key={`term:key:${k.key}`} plain label={k.label} onPress={() => pressTermKey($, k.key)} />)}
        </Box>
      ) : (
        <Text dimColor wrap="truncate-end">{hint}</Text>
      )}
      {Raster ? (
        <Raster key={TERM_SCREEN} columns={cols} rows={rows} cells={cellsBase64(screenCells(lines, cols, rows))} />
      ) : (
        <Box flexDirection="column">
          {lines.slice(0, rows).map(line => (
            <Text wrap="truncate-end">{line.length ? line.map(r => <Text color={hex(r.fg)} backgroundColor={hex(r.bg)}>{r.text}</Text>) : ' '}</Text>
          ))}
        </Box>
      )}
    </Box>
  )
}

// ---------------------------------------------------------------- hooks

export function registerTerminal(on: On): void {
  // The pane closes (its close mark, ctrl+x x, `$.ui.close`): the stream stops with it.
  on('ui.close', async ($, e, next) => {
    const r = await next(e)
    if (e.id === PANE_ID) await closeTerminal($)
    return r
  }).catch(($, e, next) => next(e))
  // The session ends (exit, /clear, resume): no curl outlives it.
  on('session.end', async ($, e, next) => {
    await stopStream($).catch(() => {})
    return next(e)
  }).catch(($, e, next) => next(e))
}
