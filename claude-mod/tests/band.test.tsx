// The band drawn against a fake broker: the test's hooks answer `$.process.run` (git, `hauptling dashboard
// --print`) and `$.http.fetch` (/dash/board) beneath the mod, and a mock clock drives the 2 s poll.
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { Board } from '../types'
import { NOW, agent, board, delegator, iso } from './fixtures'

const TOKEN = 'tok_SECRET_123'

const band = (bodyColumns: number) => ({
  plugin: 'hauptling',
  surface: 'terminal',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 10, bodyColumns,
    scroll: { offset: 0, bodyRows: 10 }, view: {},
  },
} as const)

type World = { board: Board | null; remote: string; fetched: { url: string; headers: Record<string, string> }[]; toasts: string[]; opened: string[] }

/** The engine and broker beneath the mod. `w.board` null: the broker does not answer. */
function world(on: On, b: Board | null, remote = 'git@github.com:acme/app.git'): World {
  const w: World = { board: b, remote, fetched: [], toasts: [], opened: [] }
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: { command: 'h' } }))
  on('process.run', (_, e) => {
    const argv = e.argv.join(' ')
    if (argv === 'git remote get-url origin') return { value: { exitCode: 0, stdout: `${w.remote}\n`, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    if (argv === 'git rev-parse --show-toplevel') return { value: { exitCode: 0, stdout: '/home/me/app\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    if (argv === 'hauptling dashboard --print') return { value: { exitCode: 0, stdout: `http://127.0.0.1:47800/?k=${TOKEN}\n`, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    return { value: { exitCode: 1, stdout: '', stderr: 'unknown', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('http.fetch', (_, e) => {
    w.fetched.push({ url: e.url, headers: { ...(e.init?.headers ?? {}) } })
    if (!w.board) return { deny: 'connection refused' }
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(w.board) } }
  })
  on('ui.toast', (_, e) => { w.toasts.push(e.text); return { value: undefined } })
  on('ui.open', (_, e) => { w.opened.push(e.id); return { value: { isPlaced: true } } })
  return w
}

async function start($: Engine, on: On) {
  const clock = mock.clock(on, { now: NOW })
  await $.session.start({ cwd: '/home/me/app', surface: 'terminal', isInteractive: true })
  await clock.settle()
  return clock
}

const texts = async (ui: { findAll: (q: { type: string }) => Promise<{ text: string }[]> }) =>
  (await ui.findAll({ type: 'Text' })).map(t => t.text).join('')

const two = () => [
  agent({ id: 'claude_opus-5-5_aaaaa', title: 'Scenes: vaporwave sky', usage: { context_pct: 42 } }),
  agent({ id: 'codex_gpt-6-luna_bbbbb', vendor: 'codex', model: 'gpt-6-luna', title: 'Fix: gate retries', usage: null }),
]

test('wide: name, model, ctx % and circle per agent; signed in with the cookie', async ($, on) => {
  const w = world(on, board(two()))
  await start($, on)
  const ui = await $.ui.mount(band(200))
  expect(await ui.findAll({ type: 'Button' })).toHaveLength(2)
  expect((await ui.find({ type: 'Button', key: 'claude_opus-5-5_aaaaa' }))?.props.hotkey).toBe('1')
  const shown = await texts(ui)
  expect(shown).toContain('claude·vaporwave opus-5-5 42% ●')
  expect(shown).toContain('codex·gate gpt-6-luna — ●')
  expect(w.fetched[0]).toEqual({ url: 'http://127.0.0.1:47800/dash/board', headers: { cookie: `hl_dash=${TOKEN}` } })
  // The token goes in the cookie and nowhere else: not drawn, not toasted.
  expect(shown).not.toContain(TOKEN)
  expect(w.toasts.join(' ')).not.toContain(TOKEN)
  await ui.unmount()
})

test('narrow: collapses to circle plus initials', async ($, on) => {
  world(on, board(two()))
  await start($, on)
  const ui = await $.ui.mount(band(20))
  const shown = await texts(ui)
  expect(shown).toContain('● cv')
  expect(shown).toContain('● cg')
  expect(shown).not.toContain('vaporwave')
  await ui.unmount()
})

test('no delegator for this repo: no band', async ($, on) => {
  world(on, board(two(), [delegator({ repo: 'acme/other' })]))
  await start($, on)
  const ui = await $.ui.mount(band(200))
  expect(await ui.find({ type: 'Button' })).toBeUndefined()
  await ui.unmount()
})

test('broker down: no band, and it shows once the broker answers', async ($, on) => {
  const w = world(on, null)
  const clock = await start($, on)
  const ui = await $.ui.mount(band(200))
  expect(await ui.find({ type: 'Button' })).toBeUndefined()
  w.board = board(two())
  await clock.advance(30e3)
  expect(await ui.findAll({ type: 'Button' })).toHaveLength(2)
  await ui.unmount()
})

test('a blocked agent: red circle that blinks', async ($, on) => {
  world(on, board([agent({ id: 'claude_opus-5-5_ccccc', title: 'Fix: flaky test', state: 'blocked' })]))
  const clock = await start($, on)
  const ui = await $.ui.mount(band(200))
  const circle = async () => (await ui.findAll({ type: 'Text' })).find(t => t.text === '●!')
  expect((await circle())?.props.color).toBe('error')
  const before = (await circle())?.props.color
  await clock.advance(600)
  expect((await circle())?.props.color).not.toBe(before)
  await ui.unmount()
})

test('Enter or a digit opens the agent in the pane', async ($, on) => {
  const w = world(on, board(two()))
  await start($, on)
  const ui = await $.ui.mount(band(200))
  await ui.press({ key: 'codex_gpt-6-luna_bbbbb' })
  expect(w.opened).toEqual(['hauptling'])
  await ui.unmount()
  const pane = await $.ui.mount({
    plugin: 'hauptling', surface: 'terminal', component: 'Pane', requestId: 'hauptling',
    props: { title: 'Hauptling', isFocused: true, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 20 }, view: {} },
  })
  const row = (await pane.findAll({ type: 'Text' })).find(t => t.props.inverse)
  expect(row?.text).toContain('codex·gate')
  await pane.unmount()
})

test('several delegators for the repo: a tab each', async ($, on) => {
  const b = board(
    [...two(), agent({ id: 'claude_opus-5-5_ddddd', delegator: 'd_222222', title: 'Docs: readme' })],
    [delegator(), delegator({ id: 'd_222222', created_at: iso(100e3) })],
  )
  world(on, b)
  await start($, on)
  const ui = await $.ui.mount(band(200))
  expect(await texts(ui)).toContain('[d_111111]')
  await ui.press({ key: 'tab:d_222222' })
  expect(await texts(ui)).toContain('claude·readme')
  await ui.unmount()
})

test('toasts: an ask, a block, a report and a failed gate, each once', async ($, on) => {
  const quiet = two()
  const w = world(on, board(quiet))
  const clock = await start($, on)
  expect(w.toasts).toEqual([]) // the first board primes, it toasts nothing
  const [a, b] = quiet
  w.board = board([
    { ...a!, state: 'blocked', ask: { id: 5, question: 'Which palette?', choices: ['Pink', 'Teal'], at: iso(0) } },
    { ...b!, state: 'done', report: 'Gate retries now back off',
      test: { id: 't1', state: 'done', gpu: false, purpose: 'gate', status: 'fail', passed: 9, failed: 1, at: iso(0), position: null, retry: null } },
  ])
  await clock.advance(2000)
  expect(w.toasts).toEqual([
    'claude·vaporwave asks: Which palette?',
    'codex·gate reported: Gate retries now back off',
    'codex·gate: merge gate failed (9/10)',
  ])
  await clock.advance(2000)
  expect(w.toasts).toHaveLength(3)
})
