// Signing in (client.ts) against a fake `$.process` and `$.session.info`: on Windows, where `hauptling` lives in
// WSL and is not on the Windows PATH, the link comes through `wsl.exe`, plain first, then a login shell.
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { NOW, agent, board } from './fixtures'

const TOKEN = 'tok_SECRET_123'
const LINK = `http://127.0.0.1:47800/?k=${TOKEN}\n`
const SIGN_IN = 'hauptling dashboard --print'
const WSL = 'wsl.exe hauptling dashboard --print'
const WSL_LOGIN = 'wsl.exe bash -lc hauptling dashboard --print'

type Answer = { exitCode: number; stdout: string } | 'missing'
type World = { runs: string[]; cookies: string[]; status: number[] }

const ran = (stdout: string, exitCode = 0): Answer => ({ exitCode, stdout })

/** `answers[argv]`: what that command prints and exits with, or `missing` (it cannot start). */
function world(on: On, platform: string, answers: Record<string, Answer>): World {
  const w: World = { runs: [], cookies: [], status: [] }
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: { command: 'h' } }))
  on('session.info', () => ({ value: { platform } }) as never)
  on('process.run', (_, e) => {
    const argv = e.argv.join(' ')
    if (argv === 'git remote get-url origin') return { value: { exitCode: 0, stdout: 'git@github.com:acme/app.git\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    if (argv === 'git rev-parse --show-toplevel') return { value: { exitCode: 0, stdout: '/home/me/app\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    w.runs.push(argv)
    const a = answers[argv] ?? 'missing'
    if (a === 'missing') return { deny: 'not found' }
    return { value: { exitCode: a.exitCode, stdout: a.stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('http.fetch', (_, e) => {
    w.cookies.push(String(e.init?.headers?.cookie ?? ''))
    const status = w.status.shift() ?? 200
    return { value: { status, ok: status < 300, headers: {}, text: JSON.stringify(status < 300 ? board([agent({ title: 'Scenes: sky' })]) : { error: 'Unauthorized' }) } }
  })
  on('ui.toast', () => ({ value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.panes', () => ({ value: [] }))
  return w
}

async function start($: Engine, on: On) {
  const clock = mock.clock(on, { now: NOW })
  await $.session.start({ cwd: '/home/me/app', surface: 'terminal', isInteractive: true })
  await clock.settle()
  return clock
}

test('Windows: hauptling not on PATH, wsl.exe\'s plain form not either: the login shell\'s form signs in', async ($, on) => {
  const w = world(on, 'windows', { [WSL]: ran('/bin/bash: line 1: hauptling: command not found\n', 127), [WSL_LOGIN]: ran(LINK) })
  const clock = await start($, on)
  expect(w.runs).toEqual([SIGN_IN, WSL, WSL_LOGIN])
  expect(w.cookies[0]).toBe(`hl_dash=${TOKEN}`)
  // A 401 (the token rotated): signed in again with the form that worked, first.
  w.status.push(401)
  await clock.advance(2000)
  expect(w.runs).toEqual([SIGN_IN, WSL, WSL_LOGIN, WSL_LOGIN])
  expect(w.cookies.slice(-2)).toEqual([`hl_dash=${TOKEN}`, `hl_dash=${TOKEN}`])
})

test('Windows: the plain wsl.exe form prints the link: the login shell is not tried', async ($, on) => {
  const w = world(on, 'windows', { [WSL]: ran(LINK) })
  await start($, on)
  expect(w.runs).toEqual([SIGN_IN, WSL])
  expect(w.cookies[0]).toBe(`hl_dash=${TOKEN}`)
})

test('Windows with hauptling on PATH: no wsl.exe', async ($, on) => {
  const w = world(on, 'windows', { [SIGN_IN]: ran(LINK) })
  await start($, on)
  expect(w.runs).toEqual([SIGN_IN])
  expect(w.cookies[0]).toBe(`hl_dash=${TOKEN}`)
})

test('Linux without hauptling: no wsl.exe, no request', async ($, on) => {
  const w = world(on, 'linux', {})
  await start($, on)
  expect(w.runs).toEqual([SIGN_IN])
  expect(w.cookies).toEqual([])
})
