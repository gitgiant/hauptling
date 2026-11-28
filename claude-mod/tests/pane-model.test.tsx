import { describe, expect, test } from 'claude-code/testing'

import type { Board } from '../types'
import {
  ageText, claudePrompt, confirmStep, diffDetail, diffTone, eventsDetail, headerOf, hostChoices, moveOf, paneAgents,
  replyError, replyLimit, rowsOf, selectedOf, usageOf, usageText, windowShort,
} from '../hooks/pane-model'
import { NOW, agent, board, delegator, iso } from './fixtures'

describe('rows and selection', () => {
  test('the listed agents, or all with "show all"; the opened one, else the first', async () => {
    const live = agent({ id: 'claude_x_aaaaa', title: 'Sky', created_at: iso(10e3) })
    const old = agent({ id: 'claude_x_bbbbb', title: 'Fog', created_at: iso(5e6), state: 'merged', ended: true, updated_at: iso(3600e3) })
    const b = board([live, old])
    expect(paneAgents(b, 'd_111111', NOW, false).map(a => a.id)).toEqual([live.id])
    expect(paneAgents(b, 'd_111111', NOW, true).map(a => a.id)).toEqual([old.id, live.id])
    expect(selectedOf([live, old], old.id)?.id).toBe(old.id)
    expect(selectedOf([live, old], 'gone')?.id).toBe(live.id)
    expect(selectedOf([], null)).toBeNull()
  })

  test('a row: model, ctx, state text, PR and age after the name', async () => {
    const a = agent({ id: 'claude_x_aaaaa', title: 'Sky', created_at: iso(3 * 3600e3), pr_number: 7, pr_url: 'u', state: 'paused' })
    const [r] = rowsOf([a], a.id, NOW)
    expect(r).toMatchObject({ n: 1, name: 'claude·sky', rest: 'opus-5-5 · 42% · paused · #7 · 3h', isSelected: true })
    expect(r?.circle.glyph).toBe('‖')
  })

  test('ages', async () => {
    expect(ageText(iso(10e3), NOW)).toBe('now')
    expect(ageText(iso(12 * 60e3), NOW)).toBe('12m')
    expect(ageText(iso(5 * 3600e3), NOW)).toBe('5h')
    expect(ageText(iso(3 * 86400e3), NOW)).toBe('3d')
    expect(ageText('nonsense', NOW)).toBe('—')
  })
})

describe('confirmation', () => {
  test('the first press asks; the same key for the same agent runs', async () => {
    expect(confirmStep(null, 'kill', 'a')).toBe('ask')
    expect(confirmStep({ action: 'kill', agent: 'a', name: 'x' }, 'kill', 'a')).toBe('run')
    expect(confirmStep({ action: 'kill', agent: 'a', name: 'x' }, 'merge', 'a')).toBe('ask')
    expect(confirmStep({ action: 'kill', agent: 'a', name: 'x' }, 'kill', 'b')).toBe('ask')
  })
})

describe('queue moves', () => {
  const q1 = agent({ id: 'q1', title: 'One', state: 'queued', queue: 1 })
  const q2 = agent({ id: 'q2', title: 'Two', state: 'queued', queue: 2 })
  const q3 = agent({ id: 'q3', title: 'Three', state: 'queued', queue: 3 })
  const run = agent({ id: 'r', title: 'Running' })
  const b = board([q3, run, q1, q2])
  test('up and down swap with the neighbour, top and bottom go to the ends', async () => {
    expect(moveOf(b, q2, 'up')).toEqual({ to: { before: 'q1' } })
    expect(moveOf(b, q2, 'down')).toEqual({ to: { after: 'q3' } })
    expect(moveOf(b, q2, 'top')).toEqual({ to: { top: true } })
    expect(moveOf(b, q2, 'bottom')).toEqual({ to: { bottom: true } })
  })
  test('what can not move says why', async () => {
    expect(moveOf(b, q1, 'up')).toEqual({ error: 'already first in the queue' })
    expect(moveOf(b, q3, 'bottom')).toEqual({ error: 'already last in the queue' })
    expect(moveOf(b, run, 'up')).toEqual({ error: 'not in the queue' })
  })
})

describe('header line', () => {
  const d = delegator({ gate: false, automerge: true })
  test('tests, GPU, merge settings and usage', async () => {
    const inGate = agent({ id: 'g', title: 'Gated', state: 'done', test: { id: 't', state: 'running', gpu: false, purpose: 'gate', status: null, passed: null, failed: null, at: iso(0), position: null, retry: null } })
    const b = { ...board([inGate], [d]), tests: { running: [], queued: 0, limit: 3, auto: true }, gpu: { available: true, paused: true, running: [], queued: [] } } as Board
    const top = headerOf(b, d, { vendors: [{ vendor: 'agy', limits: [{ window: '3p-5h', used_pct: 9.6 }, { window: 'week', used_pct: 3 }, { window: '5h', used_pct: 50 }] }], prefer: 'best' })
    expect(top.merge).toBe('gate off (1 in the gate) · auto-merge on')
    expect(top.tests).toBe('tests 0 running')
    expect(top.gpu).toBe('GPU paused')
    expect(top.gpuKey).toBe('resume')
    expect(top.usage).toEqual(['agy 5h 50% wk 3% c/g 5h 10%'])
  })
  test('no GPU, no tests on the board, no usage yet', async () => {
    const b = { ...board([], [d]), gpu: { available: false } } as Board
    const top = headerOf(b, d, null)
    expect([top.tests, top.gpu, top.gpuKey, top.usage]).toEqual(['tests ?', 'GPU none', null, ['usage …']])
    expect(headerOf(board([], [d]), d, null).gpu).toBe('GPU ?')
  })
  test('usage windows and the usage answer, defensively', async () => {
    expect(windowShort('7d')).toBe('wk')
    expect(windowShort('3p-week')).toBe('c/g wk')
    expect(usageText({ vendor: 'codex', limits: [] })).toBe('codex —')
    expect(usageOf(null)).toEqual({ vendors: [], prefer: null })
    expect(usageOf({ vendors: [{ vendor: 'x', limits: [{ window: '5h', used_pct: 'a' }] }, 3], prefer: 'cheap' })).toEqual({ vendors: [{ vendor: 'x', limits: [] }], prefer: 'cheap' })
  })
  test('hosts: auto, the hub, then satellites', async () => {
    expect(hostChoices({ ...board([]), hosts: [{ name: 'hub' }, { name: 'box2' }] } as Board)).toEqual(['auto', 'hub', 'box2'])
    expect(hostChoices(null)).toEqual(['auto', 'hub'])
  })
})

describe('suggest', () => {
  test('the broker mail limit, 250 while an ask is open', async () => {
    const a = agent({ title: 'Sky' })
    expect(replyLimit(a)).toBe(300)
    expect(replyLimit({ ...a, ask: { id: 1, question: 'q', choices: [], at: iso(0) } })).toBe(250)
    expect(replyError('  ', 300)).toBe('nothing to send')
    expect(replyError('x'.repeat(300), 300)).toBeNull()
    expect(replyError('x'.repeat(301), 300)).toBe('too long: 301 characters, the broker takes at most 300; shorten it')
    expect(claudePrompt('claude·sky', 'claude_x_aaaaa', ' look here ')).toBe('suggest to claude·sky (claude_x_aaaaa): look here')
  })
})

describe('diff and events', () => {
  test('diff lines, coloured by kind, clipped', async () => {
    const d = diffDetail('a', { stat: ' a | 1 +', files: [{ path: 'a', patch: '--- a/a\n+++ b/a\n@@ -1 +1 @@\n-x\n+y\n' }] })
    expect(d.lines).toEqual([' a | 1 +', '', '--- a/a', '+++ b/a', '@@ -1 +1 @@', '-x', '+y'])
    expect(d.lines.map(diffTone)).toEqual([null, null, null, null, 'suggestion', 'error', 'success'])
    const big = diffDetail('a', { files: [{ path: 'a', patch: Array.from({ length: 2000 }, (_, i) => `+${i}`).join('\n') }] })
    expect(big.lines).toHaveLength(1501)
    expect(big.lines.at(-1)).toBe('… 501 more lines (the dashboard shows all)')
    expect(diffDetail('a', {}).lines).toEqual(['no changes'])
  })
  test('events, newest first as the broker sends them', async () => {
    expect(eventsDetail('a', { items: [{ at: '2026-11-28T09:05:00Z', kind: 'mail', text: 'hi\nthere' }] }).lines).toEqual(['11-28 09:05 mail     hi there'])
    expect(eventsDetail('a', { items: [], note: 'on box2' })).toEqual({ agent: 'a', kind: 'events', lines: ['no events'], note: 'on box2' })
  })
})
