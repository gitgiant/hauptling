// `/h` run against a fake broker: the call each command sends and the line it answers.
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { Board } from '../types'
import { NOW, agent, board, delegator, iso } from './fixtures'

const TOKEN = 'tok_SECRET_123'
const ORIGIN = 'http://127.0.0.1:47800'
const A = 'claude_opus-5-5_aaaaa'
const B = 'codex_gpt-6-luna_bbbbb'

type Post = { path: string; body: unknown }
type World = {
  board: Board | null
  posts: Post[]
  opened: string[]
  /** What the broker answers a POST with. */
  answer: { status: number; body: unknown }
}

/** The engine and broker beneath the mod. `w.board` null: the broker does not answer. */
function world(on: On, b: Board | null): World {
  const w: World = { board: b, posts: [], opened: [], answer: { status: 200, body: { ok: true, result: null } } }
  const ran = (exitCode: number, stdout: string) => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: { command: 'h' } }))
  on('process.run', (_, e) => {
    const argv = e.argv.join(' ')
    if (argv === 'git remote get-url origin') return ran(0, 'git@github.com:acme/app.git\n')
    if (argv === 'git rev-parse --show-toplevel') return ran(0, '/home/me/app\n')
    if (argv === 'hauptling dashboard --print') return ran(0, `${ORIGIN}/?k=${TOKEN}\n`)
    return ran(1, '')
  })
  on('http.fetch', (_, e) => {
    if (!w.board) return { deny: 'connection refused' }
    const path = e.url.slice(ORIGIN.length)
    if (e.init?.method !== 'POST') return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(w.board) } }
    expect(e.init.headers?.['x-hauptling']).toBe('1')
    expect(e.init.headers?.cookie).toBe(`hl_dash=${TOKEN}`)
    w.posts.push({ path, body: JSON.parse(String(e.init.body)) })
    const { status, body } = w.answer
    return { value: { status, ok: status < 300, headers: {}, text: JSON.stringify(body) } }
  })
  on('ui.toast', () => ({ value: undefined }))
  on('ui.open', (_, e) => { w.opened.push(e.id); return { value: { isPlaced: true } } })
  return w
}

async function start($: Engine, on: On) {
  const clock = mock.clock(on, { now: NOW })
  await $.session.start({ cwd: '/home/me/app', surface: 'terminal', isInteractive: true })
  await clock.settle()
  return clock
}

/** `/h <args>` as the person types it. */
const h = async ($: Engine, args: string) =>
  (await $.command.run({ command: 'h', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } })).text

const two = () => [
  agent({ id: A, title: 'Scenes: vaporwave sky' }),
  agent({ id: B, vendor: 'codex', model: 'gpt-6-luna', title: 'Fix: gate retries' }),
]

test('/h alone opens the pane; help lists the commands; neither calls the broker', async ($, on) => {
  const w = world(on, board(two()))
  await start($, on)
  expect(await h($, '')).toBe('Opened the Hauptling pane.')
  expect(w.opened).toEqual(['hauptling'])
  const help = await h($, 'help')
  expect(help).toContain('/h kill|restart|merge <agent>')
  expect(help).toContain('typing the command is the confirmation')
  expect(w.posts).toEqual([])
})

test('kill, pause, unpause, restart and merge act at once', async ($, on) => {
  const w = world(on, board(two()))
  await start($, on)
  expect(await h($, 'kill cv')).toBe('Killed claude·vaporwave.')
  expect(await h($, 'pause 2')).toBe('Paused codex·gate.')
  expect(await h($, 'unpause gate')).toBe('Resumed codex·gate.')
  expect(await h($, 'restart claude·vaporwave')).toBe('Restarted claude·vaporwave.')
  expect(await h($, 'merge cg')).toBe('Merged codex·gate.')
  expect(w.posts).toEqual([
    { path: '/dash/do/kill', body: { agent: A } },
    { path: '/dash/do/pause', body: { agent: B } },
    { path: '/dash/do/unpause', body: { agent: B } },
    { path: '/dash/do/restart', body: { agent: A } },
    { path: '/dash/do/merge', body: { agent: B } },
  ])
})

test('an unknown or ambiguous agent: the candidates, and nothing is done', async ($, on) => {
  const w = world(on, board([...two(), agent({ id: 'claude_opus-5-5_ccccc', title: 'Add vaporwave music' })]))
  await start($, on)
  expect(await h($, 'kill zebra')).toContain('No agent “zebra”. Agents: 1 claude·vaporwave·aaaaa')
  expect(await h($, 'kill vaporwave')).toContain('matches 2 agents')
  expect(w.posts).toEqual([])
})

test('reply sends the text; over 300 characters is refused', async ($, on) => {
  const w = world(on, board(two()))
  await start($, on)
  expect(await h($, `reply cv ${'x'.repeat(301)}`)).toBe('Too long: 301 characters, the limit is 300. Nothing was sent.')
  expect(w.posts).toEqual([])
  expect(await h($, 'reply cv use teal')).toBe('Sent to claude·vaporwave.')
  expect(w.posts).toEqual([{ path: '/dash/do/reply', body: { agent: A, text: 'use teal' } }])
})

test('answer picks a choice or sends text; no open question says so', async ($, on) => {
  const [a, b] = two()
  const asking = { ...a!, state: 'blocked', ask: { id: 5, question: 'Which palette?', choices: ['Pink', 'Teal'], at: iso(0) } }
  const w = world(on, board([asking, b!]))
  await start($, on)
  expect(await h($, 'answer cv 2')).toBe('Answered claude·vaporwave: Teal')
  expect(await h($, 'answer cv both of them')).toBe('Answered claude·vaporwave: both of them')
  expect(await h($, `answer cv ${'x'.repeat(251)}`)).toContain('limit is 250')
  expect(await h($, `reply cv ${'x'.repeat(251)}`)).toContain('limit is 250')
  expect(await h($, 'answer cg yes')).toBe('codex·gate has no open question. /h reply sends a message.')
  expect(w.posts).toEqual([
    { path: '/dash/do/answer', body: { ask: 5, choice: 1 } },
    { path: '/dash/do/answer', body: { ask: 5, text: 'both of them' } },
  ])
})

test('move reorders the queue through the move route', async ($, on) => {
  const [a, b] = two()
  const w = world(on, board([{ ...a!, state: 'queued', queue: 1 }, { ...b!, state: 'queued', queue: 2 }]))
  await start($, on)
  expect(await h($, 'move cg up')).toBe('Moved codex·gate up.')
  expect(await h($, 'move cv bottom')).toBe('Moved claude·vaporwave to the bottom.')
  expect(await h($, 'move cv up')).toBe('claude·vaporwave is already first in the queue.')
  expect(w.posts).toEqual([
    { path: `/dash/agents/${B}/move`, body: { before: A } },
    { path: `/dash/agents/${A}/move`, body: { bottom: true } },
  ])
})

test('move: a running agent is not queued', async ($, on) => {
  const w = world(on, board(two()))
  await start($, on)
  expect(await h($, 'move cv top')).toBe('claude·vaporwave is working; only queued agents can be moved.')
  expect(w.posts).toEqual([])
})

test('gate, automerge, prefer and gpu', async ($, on) => {
  const w = world(on, board(two()))
  await start($, on)
  expect(await h($, 'gate off')).toBe('Merge gate off for d_111111.')
  expect(await h($, 'automerge on')).toBe('Auto-merge on for d_111111.')
  expect(await h($, 'prefer cheap')).toBe('New workers: cheap.')
  expect(await h($, 'gpu pause')).toBe('GPU queue paused; a running job finishes.')
  expect(await h($, 'gpu resume')).toBe('GPU queue resumed.')
  expect(w.posts).toEqual([
    { path: '/dash/do/delegator.set', body: { delegator: 'd_111111', gate: false } },
    { path: '/dash/do/delegator.set', body: { delegator: 'd_111111', automerge: true } },
    { path: '/dash/do/models.prefer', body: { value: 'cheap' } },
    { path: '/dash/do/gpu.pause', body: {} },
    { path: '/dash/do/gpu.resume', body: {} },
  ])
})

test('status answers the table', async ($, on) => {
  world(on, board(two()))
  await start($, on)
  const text = await h($, 'status')
  expect(text).toContain('d_111111 · acme/app · gate on · automerge on')
  expect(text).toContain('claude·vaporwave')
  expect(text).toContain('codex·gate')
})

test('commands act on the delegator tab the band shows', async ($, on) => {
  const b = board(
    [...two(), agent({ id: 'claude_opus-5-5_ddddd', delegator: 'd_222222', title: 'Docs: readme' })],
    [delegator(), delegator({ id: 'd_222222', created_at: iso(100e3) })],
  )
  const w = world(on, b)
  await start($, on)
  const ui = await $.ui.mount({
    plugin: 'hauptling', surface: 'terminal', component: 'AbovePrompt',
    props: { hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 10, bodyColumns: 200, scroll: { offset: 0, bodyRows: 10 }, view: {} },
  })
  await ui.press({ key: 'tab:d_222222' })
  expect(await h($, 'kill 1')).toBe('Killed claude·readme.')
  expect(await h($, 'gate off')).toBe('Merge gate off for d_222222.')
  await ui.unmount()
  expect(w.posts[0]).toEqual({ path: '/dash/do/kill', body: { agent: 'claude_opus-5-5_ddddd' } })
})

test('the answer is the broker’s error, or what it did instead', async ($, on) => {
  const w = world(on, board(two()))
  await start($, on)
  w.answer = { status: 400, body: { error: 'claude_opus-5-5_aaaaa is working; merge works after it reports' } }
  expect(await h($, 'merge cv')).toBe('claude_opus-5-5_aaaaa is working; merge works after it reports')
  w.answer = { status: 200, body: { ok: true, result: { queued: true, host: 'laptop' } } }
  expect(await h($, 'kill cv')).toBe('Queued: will run when laptop reconnects.')
  w.board = null
  const down = await h($, 'status')
  expect(down).toBe('The broker does not answer')
  expect(down).not.toContain(TOKEN)
})

test('no delegator for this repo', async ($, on) => {
  const w = world(on, board(two(), [delegator({ repo: 'acme/other' })]))
  await start($, on)
  expect(await h($, 'kill cv')).toBe('No active delegator for this repo.')
  expect(w.posts).toEqual([])
})
