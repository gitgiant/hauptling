// The pure logic of the `/h` commands: parsing, naming an agent, answers, queue moves, the status table.
import { describe, expect, test } from 'claude-code/testing'

import { shortNames } from '../hooks/board'
import { ANSWER_MAX, REPLY_MAX, answerBody, parseCommand, queueMove, resolveAgent, statusText, tooLong } from '../hooks/command-parse'
import { agent, delegator } from './fixtures'

const three = () => [
  agent({ id: 'claude_opus-5-5_aaaaa', title: 'Scenes: vaporwave sky' }),
  agent({ id: 'codex_gpt-6-luna_bbbbb', vendor: 'codex', model: 'gpt-6-luna', title: 'Fix: gate retries' }),
  agent({ id: 'claude_opus-5-5_ccccc', title: 'Add vaporwave music' }),
]

describe('parseCommand', () => {
  test('nothing opens the pane; help and status', () => {
    expect(parseCommand('  ')).toEqual({ kind: 'open' })
    expect(parseCommand('help')).toEqual({ kind: 'help' })
    expect(parseCommand('status')).toEqual({ kind: 'status' })
  })

  test('agent verbs take exactly one agent', () => {
    for (const verb of ['kill', 'pause', 'unpause', 'restart', 'merge'] as const) {
      expect(parseCommand(`${verb} cv`)).toEqual({ kind: 'agent', verb, who: 'cv' })
      expect(parseCommand(verb).kind).toBe('error')
      expect(parseCommand(`${verb} claude vaporwave`).kind).toBe('error')
    }
    expect(parseCommand('KILL 2')).toEqual({ kind: 'agent', verb: 'kill', who: '2' })
  })

  test('reply and answer keep the text as typed', () => {
    expect(parseCommand('reply cv  use  teal,\nnot pink ')).toEqual({ kind: 'reply', who: 'cv', text: 'use  teal,\nnot pink' })
    expect(parseCommand('answer 1 Pink')).toEqual({ kind: 'answer', who: '1', text: 'Pink' })
    expect(parseCommand('reply cv').kind).toBe('error')
    expect(parseCommand('answer').kind).toBe('error')
  })

  test('move, settings, prefer, gpu', () => {
    expect(parseCommand('move cv TOP')).toEqual({ kind: 'move', who: 'cv', to: 'top' })
    expect(parseCommand('gate off')).toEqual({ kind: 'setting', setting: 'gate', on: false })
    expect(parseCommand('automerge on')).toEqual({ kind: 'setting', setting: 'automerge', on: true })
    expect(parseCommand('prefer best')).toEqual({ kind: 'prefer', value: 'best' })
    expect(parseCommand('gpu resume')).toEqual({ kind: 'gpu', verb: 'resume' })
    for (const bad of ['move cv', 'move cv left', 'gate', 'gate maybe', 'prefer fast', 'gpu', 'gpu pause now', 'help me']) {
      expect(parseCommand(bad).kind).toBe('error')
    }
  })

  test('an unknown command points at help', () => {
    expect(parseCommand('nuke cv')).toEqual({ kind: 'error', message: 'Unknown command “nuke”. /h help lists them.' })
  })
})

describe('resolveAgent', () => {
  const agents = three()
  const names = shortNames(agents)
  const id = (who: string) => {
    const r = resolveAgent(agents, names, who)
    return 'agent' in r ? r.agent.id : r.error
  }

  test('number, ID, short name, word and initials', () => {
    expect(id('2')).toBe('codex_gpt-6-luna_bbbbb')
    expect(id('claude_opus-5-5_ccccc')).toBe('claude_opus-5-5_ccccc')
    expect(id('codex·gate')).toBe('codex_gpt-6-luna_bbbbb')
    expect(id('GATE')).toBe('codex_gpt-6-luna_bbbbb')
    expect(id('cg')).toBe('codex_gpt-6-luna_bbbbb')
  })

  test('a clash is told apart by the shown name, the initials or the suffix', () => {
    expect(id('claude·vaporwave·ccccc')).toBe('claude_opus-5-5_ccccc')
    expect(id('cvaa')).toBe('claude_opus-5-5_aaaaa')
    expect(id('ccccc')).toBe('claude_opus-5-5_ccccc')
  })

  test('ambiguous: the candidates', () => {
    for (const who of ['vaporwave', 'claude·vaporwave', 'cv']) {
      expect(id(who)).toBe(`“${who}” matches 2 agents: 1 claude·vaporwave·aaaaa, 3 claude·vaporwave·ccccc`)
    }
  })

  test('unknown: the agents listed', () => {
    const all = '1 claude·vaporwave·aaaaa, 2 codex·gate, 3 claude·vaporwave·ccccc'
    for (const who of ['zebra', '0', '4']) expect(id(who)).toBe(`No agent “${who}”. Agents: ${all}`)
    expect(resolveAgent([], new Map(), 'cv')).toEqual({ error: 'No agent “cv”: none are listed.' })
  })
})

test('an answer is a choice by words or number, else free text', () => {
  const ask = { id: 5, choices: ['Pink', 'Teal'] }
  expect(answerBody(ask, 'teal')).toEqual({ ask: 5, choice: 1 })
  expect(answerBody(ask, '1')).toEqual({ ask: 5, choice: 0 })
  expect(answerBody(ask, '3')).toEqual({ ask: 5, text: '3' })
  expect(answerBody({ id: 6, choices: ['2', '1'] }, '1')).toEqual({ ask: 6, choice: 1 })
  expect(answerBody({ id: 7, choices: [] }, ' both ')).toEqual({ ask: 7, text: 'both' })
})

test('an over-long message is refused', () => {
  expect(tooLong('x'.repeat(REPLY_MAX), REPLY_MAX)).toBeNull()
  expect(tooLong('x'.repeat(REPLY_MAX + 1), REPLY_MAX)).toBe('Too long: 301 characters, the limit is 300. Nothing was sent.')
  expect(tooLong('x'.repeat(ANSWER_MAX + 1), ANSWER_MAX)).toContain('limit is 250')
})

test('queue moves trade places within the agent’s group', () => {
  const q = (id: string, queue: number, more = {}) => agent({ id, title: id, state: 'queued', queue, ...more })
  const all = [q('u', 1, { unpark: 'unpause' }), q('a', 2), q('b', 3), q('c', 4), q('x', 1, { delegator: 'd_222222' })]
  const [u, a, b, c] = all
  expect(queueMove(all, b!, 'up')).toEqual({ before: 'a' })
  expect(queueMove(all, b!, 'down')).toEqual({ after: 'c' })
  expect(queueMove(all, b!, 'top')).toEqual({ top: true })
  expect(queueMove(all, b!, 'bottom')).toEqual({ bottom: true })
  expect(queueMove(all, a!, 'up')).toBeNull()
  expect(queueMove(all, a!, 'top')).toBeNull()
  expect(queueMove(all, c!, 'down')).toBeNull()
  expect(queueMove(all, c!, 'bottom')).toBeNull()
  expect(queueMove(all, u!, 'down')).toBeNull()
})

test('status: a row per agent, an open question under its agent', () => {
  const agents = three()
  agents[1] = { ...agents[1]!, state: 'queued', queue: 1, usage: null }
  agents[2] = { ...agents[2]!, state: 'blocked', ask: { id: 5, question: 'Which\npalette?', choices: ['Pink', 'Teal'], at: '' } }
  expect(statusText(delegator({ automerge: false }), agents, shortNames(agents)).split('\n')).toEqual([
    'd_111111 · acme/app · gate on · automerge off',
    '1  ●   claude·vaporwave·aaaaa  opus-5-5    42%  running',
    '2  ◌   codex·gate              gpt-6-luna  —    queued #1',
    '3  ●!  claude·vaporwave·ccccc  opus-5-5    42%  asking',
    '    asks: Which palette?  1) Pink  2) Teal',
  ])
  expect(statusText(delegator(), [], new Map())).toContain('No agents.')
})
