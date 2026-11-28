// The pane's terminal view against a fake broker and a fake `curl`: the test's hooks answer `$.process.run`
// (git, the sign-in link), `$.http.fetch` (board, usage, the parked screen, term input/keys/size) and
// `$.process.spawn` (the term stream, fed SSE events by the test) beneath the mod; a mock clock drives the polls.
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { Agent, Board } from '../types'
import { cellsOf, cellsText, clockTime } from '../hooks/term-model'
import { NOW, agent, board, iso } from './fixtures'

const TOKEN = 'tok_SECRET_123'
const A = 'claude_opus-5-5_aaaaa', B = 'codex_gpt-6-luna_bbbbb'

const PANE = {
  plugin: 'hauptling',
  surface: 'terminal',
  component: 'Pane',
  requestId: 'hauptling',
  props: { title: 'Hauptling', isFocused: true, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const

/** One fake `curl`: what it was started with, whether it still runs, and the SSE text waiting to be read. */
type Proc = { argv: readonly string[]; input: string; alive: boolean; queue: string[]; wake: (() => void) | null; done: boolean }
type Post = { path: string; body: any }
type World = { board: Board; posts: Post[]; procs: Proc[]; saved: string | null; paneOpen: boolean }

const ok = (body: unknown, status = 200) => ({ value: { status, ok: status < 300, headers: {}, text: JSON.stringify(body) } })
const ran = (stdout: string, exitCode = 0) => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
const UNTIL = iso(-10 * 60e3)

function world(on: On, b: Board): World {
  const w: World = { board: b, posts: [], procs: [], saved: null, paneOpen: true }
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.end', (_, e) => ({ sessionId: e.sessionId }))
  on('command.register', () => ({ value: { command: 'h' } }))
  on('process.run', (_, e) => {
    const argv = e.argv.join(' ')
    if (argv === 'git remote get-url origin') return ran('git@github.com:acme/app.git\n')
    if (argv === 'git rev-parse --show-toplevel') return ran('/home/me/app\n')
    if (argv === 'hauptling dashboard --print') return ran(`http://127.0.0.1:47800/?k=${TOKEN}\n`)
    return ran('', 1)
  })
  on('process.spawn', async function* (_, e, next) {
    const p: Proc = { argv: e.argv, input: e.input ?? '', alive: true, queue: [], wake: null, done: false }
    w.procs.push(p)
    const aborted = new Promise<void>(r => next.signal.addEventListener('abort', () => r(), { once: true }))
    try {
      for (;;) {
        while (p.queue.length) yield { stream: 'stdout' as const, text: p.queue.shift()! }
        if (p.done || next.signal.aborted) break
        await Promise.race([new Promise<void>(r => { p.wake = r }), aborted])
      }
      return { value: { code: 0, signal: null } }
    } finally {
      p.alive = false
    }
  })
  on('http.fetch', (_, e) => {
    const path = new URL(e.url).pathname
    if (e.init?.method === 'POST') {
      const body = JSON.parse(String(e.init.body ?? '{}'))
      w.posts.push({ path, body })
      if (path.endsWith('/input')) return ok({ input: Boolean(body.on), until: body.on ? UNTIL : null })
      if (path.endsWith('/keys')) return ok({ input: true, until: UNTIL })
      return ok({ ok: true, result: null })
    }
    if (path === '/dash/board') return ok(w.board)
    if (path === '/dash/usage') return ok({ vendors: [], prefer: 'balanced' })
    if (path.endsWith('/screen')) return ok({ text: w.saved })
    return ok({ error: 'Not found' }, 404)
  })
  on('ui.toast', () => ({ value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.panes', () => ({ value: w.paneOpen ? [{ id: 'hauptling', title: 'Hauptling', isShown: true, isFocused: true, isPlaced: true }] : [] }))
  on('ui.focus', { plugin: '*' }, () => ({ value: undefined }))
  return w
}

/** Writes one server-sent event into the newest running curl. */
function emit(w: World, event: string, data: unknown): void {
  const p = w.procs.filter(x => x.alive).at(-1)
  if (!p) throw new Error('no curl is running')
  p.queue.push(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  p.wake?.()
}

async function start($: Engine, on: On) {
  const clock = mock.clock(on, { now: NOW })
  await $.session.start({ cwd: '/home/me/app', surface: 'terminal', isInteractive: true })
  await clock.settle()
  return clock
}

function agents(): Agent[] {
  return [
    agent({ id: A, title: 'Scenes: vaporwave sky', created_at: iso(50 * 60e3) }),
    agent({ id: B, vendor: 'codex', model: 'gpt-6-luna', title: 'Fix: gate retries', created_at: iso(40 * 60e3) }),
  ]
}

type Found = { text: string; props: Record<string, unknown> }
type Query = { type?: string; key?: string; text?: string | RegExp }
type Ui = { find: (q: Query) => Promise<Found | undefined>; findAll: (q: Query) => Promise<Found[]> }

/** The screen as drawn: the Raster's rows of characters (trailing blanks cut), and its size. */
async function screenOf(ui: Ui) {
  const r = await ui.find({ type: 'Raster' })
  if (!r) return null
  const props = r.props as { columns: number; rows: number; cells: string }
  const cells = cellsOf(props.cells)
  return { columns: props.columns, rows: props.rows, lines: cellsText(cells, props.columns), cells }
}

const texts = async (ui: Ui) => (await ui.findAll({ type: 'Text' })).map(t => t.text).join('\n')
const sizes = (w: World, agentId: string) => w.posts.filter(p => p.path === `/dash/term/${agentId}/size`).map(p => p.body)
const keys = (w: World) => w.posts.filter(p => p.path.endsWith('/keys')).map(p => p.body.keys)

test('t opens the selected agent\'s terminal: curl on its stream, the lease at the pane\'s size, the first screen and later frames', async ($, on) => {
  const w = world(on, board(agents()))
  w.saved = 'parked screen\n'
  const clock = await start($, on)
  const ui = await $.ui.mount(PANE)
  await ui.press({ key: 'key:terminal' })
  await clock.settle()

  // One curl, the URL and cookie on its stdin only.
  expect(w.procs).toHaveLength(1)
  expect(w.procs[0]!.argv).toEqual(['curl', '-K', '-'])
  expect(w.procs[0]!.input).toContain(`url = "http://127.0.0.1:47800/dash/term/${A}/stream"`)
  expect(w.procs[0]!.input).toContain(`Cookie: hl_dash=${TOKEN}`)
  expect(w.procs[0]!.argv.join(' ')).not.toContain(TOKEN)

  // Until the first live frame: the screen saved at parking.
  await ui.redraw()
  expect((await screenOf(ui))?.lines[0]).toBe('parked screen')
  expect(await texts(ui)).toContain('the screen saved at parking')

  emit(w, 'viewer', { id: 'v1' })
  emit(w, 'input', { input: false, until: null })
  emit(w, 'frame', { text: '\x1b[32mhello\x1b[0m world\n\x1b[7m \x1b[27m\n' })
  await clock.settle()
  await ui.redraw()

  // The lease: the pane body's columns, its rows less the view's two.
  expect(sizes(w, A)).toEqual([{ viewer: 'v1', size: { cols: 100, rows: 38 } }])
  const s = await screenOf(ui)
  expect(s?.columns).toBe(100)
  expect(s?.rows).toBe(38)
  expect(s?.lines.slice(0, 2)).toEqual(['hello world', ''])
  expect(s?.cells[1]).toBe(0x98c379) // 'h' in green (SGR 32)
  expect(s?.cells[100 * 3 + 2]).toBe(0xd6d6d6) // the reverse-video cursor cell: its background lit
  expect(await texts(ui)).toContain('claude·vaporwave')
  expect(await texts(ui)).toContain('input off')

  // Frames that arrive together: only the newest is drawn.
  emit(w, 'frame', { text: 'second\n' })
  emit(w, 'frame', { text: 'third\n' })
  await clock.settle()
  await ui.redraw()
  expect((await screenOf(ui))?.lines[0]).toBe('third')

  // The pane resized: the lease follows, once.
  await ui.redraw({ ...PANE.props, bodyColumns: 80, scroll: { offset: 0, bodyRows: 30 } })
  await clock.settle()
  expect(sizes(w, A)).toEqual([{ viewer: 'v1', size: { cols: 100, rows: 38 } }, { viewer: 'v1', size: { cols: 80, rows: 28 } }])
  expect((await screenOf(ui))?.columns).toBe(80)
  await ui.unmount()
})

test('input: off sends no keys; i turns it on and the field\'s edits go through termKeys; the idle-off is shown', async ($, on) => {
  const w = world(on, board(agents()))
  const clock = await start($, on)
  const ui = await $.ui.mount(PANE)
  await ui.press({ key: 'key:terminal' })
  await clock.settle()
  emit(w, 'viewer', { id: 'v1' })
  emit(w, 'input', { input: false, until: null })
  emit(w, 'frame', { text: '> \n' })
  await clock.settle()
  await ui.redraw()

  // Off: no field to type into, `i` is a hotkey, and nothing reaches the worker.
  expect(await ui.find({ type: 'Input', key: 'term:keys' })).toBeUndefined()
  expect((await ui.find({ type: 'Button', key: 'term:input' }))?.props.hotkey).toBe('i')
  expect(keys(w)).toEqual([])

  await ui.press({ key: 'term:input' })
  await clock.settle()
  await ui.redraw()
  expect(w.posts.find(p => p.path === `/dash/term/${A}/input`)?.body).toEqual({ on: true })
  expect(await texts(ui)).toContain(`input ON until ${clockTime(UNTIL)}`)
  // On: the letters are the worker's, so the view's buttons have no hotkeys.
  expect((await ui.find({ type: 'Button', key: 'term:input' }))?.props.hotkey).toBeUndefined()
  expect((await ui.find({ type: 'Button', key: 'key:back' }))?.props.hotkey).toBeUndefined()

  await ui.input({ key: 'term:keys', text: 'ab', kind: 'change' })
  await ui.input({ key: 'term:keys', text: 'a', kind: 'change' })
  await ui.input({ key: 'term:keys', text: 'a1' })
  await ui.press({ key: 'term:key:C-c' })
  await clock.settle()
  expect(keys(w)).toEqual([
    [{ t: 'lit', v: 'ab' }],
    [{ t: 'key', v: 'BSpace' }],
    [{ t: 'lit', v: '1' }, { t: 'key', v: 'Enter' }],
    [{ t: 'key', v: 'C-c' }],
  ])

  // The broker's 10 idle minutes: input goes off by itself, and the view says when.
  emit(w, 'input', { input: false, until: null })
  await clock.settle()
  await ui.redraw()
  expect(await texts(ui)).toContain(`input went off at ${clockTime(NOW)}`)
  expect(await ui.find({ type: 'Input', key: 'term:keys' })).toBeUndefined()
  expect(keys(w)).toHaveLength(4)
  await ui.unmount()
})

test('back releases the lease and ends curl; the selection moving to another agent follows it and ends the old one', async ($, on) => {
  const w = world(on, board(agents()))
  const clock = await start($, on)
  const ui = await $.ui.mount(PANE)
  await ui.press({ key: 'key:terminal' })
  await clock.settle()
  emit(w, 'viewer', { id: 'v1' })
  await clock.settle()
  await ui.redraw()

  await ui.press({ key: 'key:back' })
  await clock.settle()
  expect(sizes(w, A).at(-1)).toEqual({ viewer: 'v1', size: null })
  expect(w.procs[0]!.alive).toBe(false)
  expect(await ui.find({ type: 'Raster' })).toBeUndefined()

  // Open again, then the band's ring moves to B: A's stream ends, B's starts.
  await ui.press({ key: 'key:terminal' })
  await clock.settle()
  expect(w.procs).toHaveLength(2)
  emit(w, 'viewer', { id: 'v2' })
  await clock.settle()
  await $.ui.focus({ component: 'AbovePrompt', requestId: 'band', plugin: 'hauptling', element: B, origin: { kind: 'person' } } as never)
  await clock.settle()
  expect(w.procs[1]!.alive).toBe(false)
  expect(sizes(w, A).at(-1)).toEqual({ viewer: 'v2', size: null })
  expect(w.procs).toHaveLength(3)
  expect(w.procs[2]!.input).toContain(`/dash/term/${B}/stream`)
  expect(w.procs[2]!.alive).toBe(true)
  await ui.redraw()
  expect(await texts(ui)).toContain('codex·gate')

  // Back to the table: that curl ends too.
  await ui.press({ key: 'key:back' })
  await clock.settle()
  expect(w.procs.every(p => !p.alive)).toBe(true)
  await ui.unmount()
})

test('the pane gone, the agent ending, the broker ending the stream and the session ending each end curl', async ($, on) => {
  const w = world(on, board(agents()))
  const clock = await start($, on)
  const ui = await $.ui.mount(PANE)
  const open = async () => {
    await ui.redraw()
    await ui.press({ key: 'key:terminal' })
    await clock.settle()
    emit(w, 'viewer', { id: `v${w.procs.length}` })
    emit(w, 'frame', { text: 'screen\n' })
    await clock.settle()
  }

  // The pane is no longer open (the kit raises no `ui.close`: this is the poll's backstop for it).
  await open()
  w.paneOpen = false
  await clock.advance(2000)
  expect(w.procs[0]!.alive).toBe(false)
  expect(sizes(w, A).at(-1)).toEqual({ viewer: 'v1', size: null })
  w.paneOpen = true

  // The agent ends: the next board poll takes the stream down and the view says why.
  await ui.press({ key: 'key:back' })
  await open()
  w.board = board([{ ...agents()[0]!, state: 'killed', ended: true, updated_at: iso(0) }, agents()[1]!])
  await clock.advance(2000)
  await ui.redraw()
  expect(w.procs[1]!.alive).toBe(false)
  expect(await texts(ui)).toContain('ended: the agent ended (killed)')

  // The broker ends the stream (the session exited).
  w.board = board(agents())
  await clock.advance(2000)
  await ui.press({ key: 'key:back' })
  await open()
  emit(w, 'end', { reason: 'session exited' })
  await clock.settle()
  await ui.redraw()
  expect(w.procs[2]!.alive).toBe(false)
  expect(await texts(ui)).toContain('ended: session exited')

  // The session ends.
  await ui.press({ key: 'key:back' })
  await open()
  expect(w.procs[3]!.alive).toBe(true)
  await $.session.end({ reason: 'exit', sessionId: 's1', resume: { id: 's1' } } as never)
  await clock.settle()
  expect(w.procs.every(p => !p.alive)).toBe(true)
  await ui.unmount()
})

test('off the terminal surface: the screen as coloured text lines', async ($, on) => {
  const w = world(on, board(agents()))
  const clock = await start($, on)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'key:terminal' })
  await clock.settle()
  emit(w, 'frame', { text: '\x1b[32mgreen\x1b[0m plain\n' })
  await clock.settle()
  await ui.redraw()
  expect(await ui.find({ type: 'Raster' })).toBeUndefined()
  const green = await ui.find({ type: 'Text', text: /^green$/ })
  expect(green?.props.color).toBe('#98c379')
  expect(await texts(ui)).toContain(' plain')
  await ui.press({ key: 'key:back' })
  await clock.settle()
  expect(w.procs.every(p => !p.alive)).toBe(true)
  await ui.unmount()
})
