// The side pane against a fake board and a fake broker: the test's hooks answer `$.process.run` (git, the
// sign-in link), `$.http.fetch` (board, usage, diff, events, actions, queue moves), `$.ui.open`/`panes` and
// `$.prompt.submit` beneath the mod; a mock clock drives the polls.
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { Agent, Board } from '../types'
import { NOW, agent, board, delegator, iso } from './fixtures'

const TOKEN = 'tok_SECRET_123'

const PANE = {
  plugin: 'hauptling',
  surface: 'terminal',
  component: 'Pane',
  requestId: 'hauptling',
  props: { title: 'Hauptling', isFocused: true, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const

const USAGE = {
  vendors: [
    { vendor: 'claude', key: null, limits: [{ window: '7d', used_pct: 71.2, resets_at: iso(-3e6), at: iso(0) }, { window: '5h', used_pct: 42, resets_at: iso(-5e5), at: iso(0) }] },
    { vendor: 'codex', key: null, limits: [] },
  ],
  prefer: 'balanced',
}

const DIFF = {
  base: 'main',
  stat: ' src/a.mjs | 2 +-\n 1 file changed',
  files: [{ path: 'src/a.mjs', patch: 'diff --git a/src/a.mjs b/src/a.mjs\n@@ -1 +1 @@\n-old line\n+new line\n' }],
  untracked: ['notes.txt'],
}

const EVENTS = { items: [{ at: '2026-11-28T11:58:00Z', kind: 'report', text: 'Gate retries back off' }, { at: '2026-11-28T11:00:00Z', kind: 'spawned', text: 'started on hl-w1' }] }

type Post = { path: string; body: any }
type World = { board: Board; posts: Post[]; prompts: string[]; fail: Record<string, string>; gets: string[] }

const ok = (body: unknown, status = 200) => ({ value: { status, ok: status < 300, headers: {}, text: JSON.stringify(body) } })
const ran = (stdout: string, exitCode = 0) => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })

/** The engine and broker beneath the mod. `w.fail[call]`: that action answers 400 with the message. */
function world(on: On, b: Board): World {
  const w: World = { board: b, posts: [], prompts: [], fail: {}, gets: [] }
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: { command: 'h' } }))
  on('process.run', (_, e) => {
    const argv = e.argv.join(' ')
    if (argv === 'git remote get-url origin') return ran('git@github.com:acme/app.git\n')
    if (argv === 'git rev-parse --show-toplevel') return ran('/home/me/app\n')
    if (argv === 'hauptling dashboard --print') return ran(`http://127.0.0.1:47800/?k=${TOKEN}\n`)
    return ran('', 1)
  })
  on('http.fetch', (_, e) => {
    const path = new URL(e.url).pathname
    if (e.init?.method === 'POST') {
      w.posts.push({ path, body: JSON.parse(String(e.init.body ?? '{}')) })
      const call = /^\/dash\/do\/(.+)$/.exec(path)?.[1]
      if (call && w.fail[call]) return ok({ error: w.fail[call] }, 400)
      return ok({ ok: true, result: null })
    }
    w.gets.push(path)
    if (path === '/dash/board') return ok(w.board)
    if (path === '/dash/usage') return ok(USAGE)
    if (path.endsWith('/diff')) return ok(DIFF)
    if (path.endsWith('/events')) return ok(EVENTS)
    return ok({ error: 'Not found' }, 404)
  })
  on('ui.toast', () => ({ value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.panes', () => ({ value: [{ id: 'hauptling', title: 'Hauptling', isShown: true, isFocused: true, isPlaced: true }] }))
  on('prompt.submit', (_, e) => { w.prompts.push(e.text); return { text: e.text } })
  return w
}

async function start($: Engine, on: On) {
  const clock = mock.clock(on, { now: NOW })
  await $.session.start({ cwd: '/home/me/app', surface: 'terminal', isInteractive: true })
  await clock.settle()
  return clock
}

const texts = async (ui: { findAll: (q: { type: string }) => Promise<{ text: string }[]> }) =>
  (await ui.findAll({ type: 'Text' })).map(t => t.text).join('\n')

const A = 'claude_opus-5-5_aaaaa', B = 'codex_gpt-6-luna_bbbbb', C = 'claude_opus-5-5_ccccc', D = 'claude_opus-5-5_ddddd'

/** Three listed agents (one with a PR, two queued) and one merged an hour ago (listed only with "show all"). */
function agents(): Agent[] {
  return [
    agent({ id: A, title: 'Scenes: vaporwave sky', created_at: iso(50 * 60e3), pr_url: 'https://github.com/acme/app/pull/12', pr_number: 12, headline: 'Working: sky shader' }),
    agent({ id: B, vendor: 'codex', model: 'gpt-6-luna', title: 'Fix: gate retries', created_at: iso(40 * 60e3), state: 'queued', queue: 1, usage: null }),
    agent({ id: C, title: 'Docs: readme', created_at: iso(30 * 60e3), state: 'queued', queue: 2 }),
    agent({ id: D, title: 'Old: cleanup', created_at: iso(3 * 3600e3), state: 'merged', ended: true, updated_at: iso(3600e3) }),
  ]
}

function fullBoard(as: Agent[] = agents()): Board {
  return {
    ...board(as),
    tests: { running: [{ id: 't1' }], queued: 2, retrying: [], limit: 3, auto: false },
    gpu: { available: true, paused: false, freeMB: 6000, running: [], queued: [{ id: 'g2' }] },
    hosts: [{ name: 'hub', online: true, lost: false }, { name: 'box2', online: true, lost: false }],
  } as Board
}

const selected = async (ui: { findAll: (q: { type: string }) => Promise<{ text: string; props: Record<string, unknown> }[]> }) =>
  (await ui.findAll({ type: 'Text' })).find(t => t.props.inverse)?.text

test('table: a row per listed agent, the header line, selection by row and "show all"', async ($, on) => {
  const w = world(on, fullBoard())
  const clock = await start($, on)
  await clock.advance(30e3) // the pane is open: the usage is read
  const ui = await $.ui.mount(PANE)
  const rows = (await ui.findAll({ type: 'Button' })).filter(r => String(r.key).startsWith('row:'))
  expect(rows.map(r => r.key)).toEqual([`row:${A}`, `row:${B}`, `row:${C}`])
  expect((await ui.find({ type: 'Button', key: `row:${B}` }))?.props.hotkey).toBe('2')
  const shown = await texts(ui)
  expect(shown).toContain('d_111111 · acme/app')
  expect(shown).toContain('gate on · auto-merge on · tests 1/3 · 2 queued')
  expect(shown).toContain('GPU idle · 1 queued')
  expect(shown).toContain('claude 5h 42% wk 71% · codex —')
  expect(shown).toContain('opus-5-5 · 42% · Working: sky shader · #12 · 50m')
  expect(shown).toContain('gpt-6-luna · — · queued')
  expect(shown).not.toContain('claude·cleanup')
  expect(shown).not.toContain(TOKEN)
  expect(w.gets).toContain('/dash/usage')
  // Nothing opened yet: the first row is selected, its PR linked.
  expect(await selected(ui)).toBe('claude·vaporwave')
  expect((await ui.find({ type: 'Link' }))?.props.href).toBe('https://github.com/acme/app/pull/12')
  await ui.press({ key: `row:${C}` })
  expect(await selected(ui)).toBe('claude·readme')
  await ui.press({ key: 'key:all' })
  expect(await texts(ui)).toContain('claude·cleanup')
  await ui.unmount()
})

test('each key sends its call', async ($, on) => {
  const w = world(on, fullBoard())
  await start($, on)
  const ui = await $.ui.mount(PANE)
  await ui.press({ key: 'key:pause' })
  expect(w.posts.at(-1)).toEqual({ path: '/dash/do/pause', body: { agent: A } })
  expect(await texts(ui)).toContain('claude·vaporwave paused')
  // Queue moves on the second queued agent: up is before the first, top is the top.
  await ui.press({ key: `row:${C}` })
  await ui.press({ key: 'key:up' })
  expect(w.posts.at(-1)).toEqual({ path: `/dash/agents/${C}/move`, body: { before: B } })
  await ui.press({ key: 'key:top' })
  expect(w.posts.at(-1)).toEqual({ path: `/dash/agents/${C}/move`, body: { top: true } })
  const before = w.posts.length
  await ui.press({ key: 'key:down' }) // already last: refused here, nothing sent
  expect(w.posts).toHaveLength(before)
  expect(await texts(ui)).toContain('claude·readme: already last in the queue')
  await ui.press({ key: `row:${B}` })
  await ui.press({ key: 'key:bottom' })
  expect(w.posts.at(-1)).toEqual({ path: `/dash/agents/${B}/move`, body: { bottom: true } })
  // The GPU queue from the header.
  await ui.press({ key: 'key:gpu' })
  expect(w.posts.at(-1)).toEqual({ path: '/dash/do/gpu.pause', body: {} })
  // The terminal is the next task: it says so and sends nothing.
  const n = w.posts.length
  await ui.press({ key: 'key:terminal' })
  expect(w.posts).toHaveLength(n)
  expect(await texts(ui)).toContain('terminal: not built yet')
  // Options: gate, auto-merge, host, model tier.
  await ui.press({ key: 'key:options' })
  await ui.press({ key: 'key:gate' })
  expect(w.posts.at(-1)).toEqual({ path: '/dash/do/delegator.set', body: { delegator: 'd_111111', gate: false } })
  await ui.press({ key: 'key:automerge' })
  expect(w.posts.at(-1)).toEqual({ path: '/dash/do/delegator.set', body: { delegator: 'd_111111', automerge: false } })
  await ui.select({ key: 'host', value: 'box2' })
  expect(w.posts.at(-1)).toEqual({ path: '/dash/do/delegator.set', body: { delegator: 'd_111111', host: 'box2' } })
  await ui.select({ key: 'tier', value: 'cheap' })
  expect(w.posts.at(-1)).toEqual({ path: '/dash/do/models.prefer', body: { value: 'cheap' } })
  await ui.press({ key: 'key:back' })
  expect(await ui.find({ type: 'Button', key: 'key:kill' })).toBeDefined()
  await ui.unmount()
})

test('a paused agent: p unpauses', async ($, on) => {
  const w = world(on, fullBoard([agent({ id: A, title: 'Scenes: vaporwave sky', state: 'paused' })]))
  await start($, on)
  const ui = await $.ui.mount(PANE)
  expect((await ui.find({ type: 'Button', key: 'key:pause' }))?.props.label).toBe('unpause')
  await ui.press({ key: 'key:pause' })
  expect(w.posts.at(-1)).toEqual({ path: '/dash/do/unpause', body: { agent: A } })
  await ui.unmount()
})

test('kill, restart and merge ask y/n; the same key twice skips the question', async ($, on) => {
  const w = world(on, fullBoard())
  await start($, on)
  const ui = await $.ui.mount(PANE)
  await ui.press({ key: 'key:kill' })
  expect(w.posts).toEqual([])
  expect(await texts(ui)).toContain('Kill claude·vaporwave?')
  await ui.press({ key: 'key:no' })
  expect(w.posts).toEqual([])
  expect(await ui.find({ type: 'Button', key: 'key:yes' })).toBeUndefined()
  await ui.press({ key: 'key:kill' })
  await ui.press({ key: 'key:yes' })
  expect(w.posts).toEqual([{ path: '/dash/do/kill', body: { agent: A } }])
  await ui.press({ key: 'key:restart' })
  await ui.press({ key: 'key:restart' })
  expect(w.posts.at(-1)).toEqual({ path: '/dash/do/restart', body: { agent: A } })
  // Another key takes the question down: merge then diff asks again.
  await ui.press({ key: 'key:merge' })
  await ui.press({ key: 'key:pause' })
  await ui.press({ key: 'key:merge' })
  expect(w.posts.filter(p => p.path === '/dash/do/merge')).toEqual([])
  await ui.press({ key: 'key:merge' })
  expect(w.posts.at(-1)).toEqual({ path: '/dash/do/merge', body: { agent: A } })
  await ui.unmount()
})

test('an open ask: a and s show its choices and answer it; s there types an answer', async ($, on) => {
  const asking = agent({ id: A, title: 'Scenes: vaporwave sky', state: 'blocked', ask: { id: 5, question: 'Which palette?', choices: ['Pink', 'Teal'], at: iso(0) } })
  const w = world(on, fullBoard([asking]))
  await start($, on)
  const ui = await $.ui.mount(PANE)
  await ui.press({ key: 'key:suggest' })
  expect(await texts(ui)).toContain('Which palette?')
  expect((await ui.find({ type: 'Button', key: 'choice:1' }))?.props.hotkey).toBe('2')
  await ui.press({ key: 'choice:1' })
  expect(w.posts).toEqual([{ path: '/dash/do/answer', body: { ask: 5, choice: 1 } }])
  expect(await texts(ui)).toContain('answered claude·vaporwave: Teal')
  // A typed answer goes as a reply (the broker answers the open ask with it).
  await ui.press({ key: 'key:answer' })
  await ui.press({ key: 'key:suggest' })
  expect(await texts(ui)).toContain('at most 250 characters')
  await ui.input({ key: 'suggest', text: 'Pink, but softer' })
  expect(w.posts.at(-1)).toEqual({ path: '/dash/do/reply', body: { agent: A, text: 'Pink, but softer' } })
  await ui.unmount()
})

test('a with no open ask says so', async ($, on) => {
  const w = world(on, fullBoard())
  await start($, on)
  const ui = await $.ui.mount(PANE)
  await ui.press({ key: 'key:answer' })
  expect(w.posts).toEqual([])
  expect((await ui.find({ type: 'Text', text: /no open question/ }))?.props.color).toBe('error')
  await ui.unmount()
})

test('s sends a reply; one past the mail limit is refused and kept', async ($, on) => {
  const w = world(on, fullBoard())
  await start($, on)
  const ui = await $.ui.mount(PANE)
  await ui.press({ key: 'key:suggest' })
  expect(await texts(ui)).toContain('at most 300 characters')
  const long = 'x'.repeat(301)
  await ui.input({ key: 'suggest', text: long })
  expect(w.posts).toEqual([])
  expect(await texts(ui)).toContain('too long: 301 characters, the broker takes at most 300')
  expect((await ui.find({ type: 'Input', key: 'suggest' }))?.props.value).toBe(long)
  await ui.input({ key: 'suggest', text: '  try the cache first  ' })
  expect(w.posts).toEqual([{ path: '/dash/do/reply', body: { agent: A, text: 'try the cache first' } }])
  expect(await texts(ui)).toContain('sent to claude·vaporwave')
  expect(await ui.find({ type: 'Input' })).toBeUndefined() // back to the table
  await ui.unmount()
})

test('c hands the suggestion to this Claude session as a prompt', async ($, on) => {
  const w = world(on, fullBoard())
  await start($, on)
  const ui = await $.ui.mount(PANE)
  await ui.press({ key: 'key:claude' })
  await ui.input({ key: 'claude', text: 'look at the shader cache' })
  expect(w.prompts).toEqual([`suggest to claude·vaporwave (${A}): look at the shader cache`])
  expect(w.posts).toEqual([])
  await ui.unmount()
})

test('d and e draw the diff and the events', async ($, on) => {
  const w = world(on, fullBoard())
  await start($, on)
  const ui = await $.ui.mount(PANE)
  await ui.press({ key: 'key:diff' })
  expect(w.gets).toContain(`/dash/agent/${A}/diff`)
  const added = await ui.find({ type: 'Text', text: '+new line' })
  expect(added?.props.color).toBe('success')
  expect((await ui.find({ type: 'Text', text: '-old line' }))?.props.color).toBe('error')
  expect(await texts(ui)).toContain('untracked:')
  await ui.press({ key: 'key:events' })
  expect(w.gets).toContain(`/dash/agent/${A}/events`)
  const shown = await texts(ui)
  expect(shown).toContain('11-28 11:58 report   Gate retries back off')
  expect(shown).toContain('spawned')
  await ui.press({ key: 'key:events' }) // the same key again: back to the table
  expect(await ui.find({ type: 'Button', key: `row:${A}` })).toBeDefined()
  await ui.unmount()
})

test('an action the broker refuses: the error in the status line', async ($, on) => {
  const w = world(on, fullBoard())
  w.fail.pause = 'Agent is not running'
  await start($, on)
  const ui = await $.ui.mount(PANE)
  await ui.press({ key: 'key:pause' })
  const line = await ui.find({ type: 'Text', text: /failed/ })
  expect(line?.text).toBe('Pausing claude·vaporwave failed: Agent is not running')
  expect(line?.props.color).toBe('error')
  await ui.unmount()
})

test('the band opens the pane on its agent, and the pane draws that one selected', async ($, on) => {
  world(on, fullBoard())
  await start($, on)
  const band = await $.ui.mount({
    plugin: 'hauptling', surface: 'terminal', component: 'AbovePrompt',
    props: { hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 10, bodyColumns: 200, scroll: { offset: 0, bodyRows: 10 }, view: {} },
  })
  await band.press({ key: B })
  await band.unmount()
  const ui = await $.ui.mount(PANE)
  expect(await selected(ui)).toBe('codex·gate')
  await ui.unmount()
})
