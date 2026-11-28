import { describe, expect, test } from 'claude-code/testing'

import {
  alertsOf, bandModel, cellSize, circleOf, ctxText, fit, isListed, listed, newAlerts, parseSignIn, repoMatches,
  repoSlug, shortNames, sseParser, titleWord,
} from '../hooks/board'
import { NOW, agent, board, delegator, iso } from './fixtures'

const HERE = { slug: 'acme/app', root: '/home/me/app' }

describe('short names', () => {
  test('the first distinctive word of the title, after a prefix', async () => {
    expect(titleWord('Scenes: vaporwave sky')).toBe('vaporwave')
    expect(titleWord('Fix: the broken gate')).toBe('broken')
    expect(titleWord('Claude CLI mod: foundation and agent band')).toBe('foundation')
    expect(titleWord('Add a retry to the uploader')).toBe('retry')
    expect(titleWord('UI')).toBe('ui')
  })

  test('vendor·word, the ID suffix only on a clash, initials', async () => {
    const a = agent({ id: 'claude_opus-5-5_aaaaa', title: 'Scenes: vaporwave sky' })
    const b = agent({ id: 'codex_gpt-6_bbbbb', vendor: 'codex', title: 'Fix: vaporwave colors' })
    const c = agent({ id: 'claude_opus-5-5_ccccc', title: 'Vaporwave fog' })
    const names = shortNames([a, b])
    // Names differ by vendor; the initials clash (cv, cv) and take the suffix's first two characters.
    expect(names.get(a.id)).toEqual({ name: 'claude·vaporwave', initials: 'cvaa' })
    expect(names.get(b.id)).toEqual({ name: 'codex·vaporwave', initials: 'cvbb' })
    expect(shortNames([a])).toEqual(new Map([[a.id, { name: 'claude·vaporwave', initials: 'cv' }]]))
    const clash = shortNames([a, c])
    expect(clash.get(a.id)?.name).toBe('claude·vaporwave·aaaaa')
    expect(clash.get(c.id)?.name).toBe('claude·vaporwave·ccccc')
    expect(clash.get(c.id)?.initials).toBe('cvcc')
  })
})

describe('which agents', () => {
  test('live ones, and ended ones for 30 minutes', async () => {
    for (const state of ['queued', 'working', 'blocked', 'paused', 'done', 'parked', 'failed'])
      expect(isListed(agent({ title: 'x', state }), NOW)).toBe(true)
    expect(isListed(agent({ title: 'x', state: 'merged', ended: true, updated_at: iso(29 * 60e3) }), NOW)).toBe(true)
    expect(isListed(agent({ title: 'x', state: 'killed', ended: true, updated_at: iso(31 * 60e3) }), NOW)).toBe(false)
  })

  test('only the delegator’s, in start order', async () => {
    const late = agent({ title: 'late', created_at: iso(10e3) })
    const early = agent({ title: 'early', created_at: iso(20e3) })
    const other = agent({ title: 'other', delegator: 'd_222222' })
    expect(listed(board([late, early, other]), 'd_111111', NOW).map(a => a.title)).toEqual(['early', 'late'])
  })
})

describe('status circles', () => {
  const glyph = (over: Parameters<typeof agent>[0]) => circleOf(agent(over)).glyph
  test('state to circle', async () => {
    expect(glyph({ title: 'x' })).toBe('●')
    expect(glyph({ title: 'x', idle: 1 })).toBe('◐')
    expect(glyph({ title: 'x', state: 'done' })).toBe('◐')
    expect(glyph({ title: 'x', state: 'paused' })).toBe('‖')
    expect(glyph({ title: 'x', state: 'queued' })).toBe('◌')
    expect(glyph({ title: 'x', state: 'merged' })).toBe('✓')
    expect(glyph({ title: 'x', state: 'killed' })).toBe('✗')
    expect(glyph({ title: 'x', state: 'failed' })).toBe('✗')
    const gate = { id: 't1', state: 'running', gpu: false, purpose: 'gate', status: null, passed: null, failed: null, at: iso(0), position: null, retry: null }
    expect(glyph({ title: 'x', state: 'done', test: gate })).toBe('◆')
  })

  test('blocked and asking blink red', async () => {
    const blocked = circleOf(agent({ title: 'x', state: 'blocked' }))
    expect(blocked).toEqual(expect.objectContaining({ glyph: '●!', color: 'error', blink: true }))
    const asking = circleOf(agent({ title: 'x', state: 'blocked', ask: { id: 3, question: 'Which?', choices: ['A'], at: iso(0) } }))
    expect(asking.blink).toBe(true)
  })

  test('ctx % or a dash', async () => {
    expect(ctxText(agent({ title: 'x', usage: { context_pct: 41.6 } }))).toBe('42%')
    expect(ctxText(agent({ title: 'x', usage: null }))).toBe('—')
  })
})

describe('repo matching', () => {
  test('owner/name from https and ssh remotes', async () => {
    expect(repoSlug('https://github.com/acme/app.git')).toBe('acme/app')
    expect(repoSlug('https://github.com/acme/app')).toBe('acme/app')
    expect(repoSlug('git@github.com:acme/app.git')).toBe('acme/app')
    expect(repoSlug('ssh://git@github.com/acme/app.git')).toBe('acme/app')
    expect(repoSlug('https://user@github.com/acme/my.app/')).toBe('acme/my.app')
    expect(repoSlug('acme/app')).toBe('acme/app')
    expect(repoSlug('/home/me/app')).toBe(null)
    expect(repoSlug('C:\\src\\app')).toBe(null)
    expect(repoSlug('')).toBe(null)
  })

  test('a delegator’s repo against this session', async () => {
    expect(repoMatches('acme/app', HERE)).toBe(true)
    expect(repoMatches('Acme/App', HERE)).toBe(true)
    expect(repoMatches('https://github.com/acme/app.git', HERE)).toBe(true)
    expect(repoMatches('acme/other', HERE)).toBe(false)
    expect(repoMatches('/home/me/app/', HERE)).toBe(true)
    expect(repoMatches('/home/me/elsewhere', HERE)).toBe(false)
    expect(repoMatches(null, HERE)).toBe(false)
    expect(repoMatches('acme/app', { slug: null, root: null })).toBe(false)
  })
})

describe('collapse to fit', () => {
  const agents = [agent({ title: 'Scenes: vaporwave sky' }), agent({ title: 'Fix: gate', vendor: 'codex', model: 'gpt-6-luna' })]
  const model = (columns: number) => bandModel(board(agents), HERE, { now: NOW, columns })!

  test('full while every cell fits, else circle plus initials, else +N', async () => {
    const wide = model(200)
    expect(wide.mode).toBe('full')
    const need = wide.cells.reduce((w, c, i) => w + (i ? 2 : 0) + cellSize(c, 'full'), 0)
    expect(model(need).mode).toBe('full')
    expect(model(need - 1).mode).toBe('short')
    const tiny = model(11) // `1: ● cv` (7), the gap (2), `+1` (2)
    expect(tiny.mode).toBe('short')
    expect(tiny.cells.length).toBe(1)
    expect(tiny.more).toBe(1)
    expect(model(10).cells.length).toBe(0)
    expect(fit([], 0)).toEqual({ mode: 'full', shown: 0 })
  })

  test('no delegator for this repo: no band; several: one tab each', async () => {
    expect(bandModel(board(agents, [delegator({ repo: 'acme/other' })]), HERE, { now: NOW, columns: 200 })).toBe(null)
    const two = bandModel(board(agents, [delegator(), delegator({ id: 'd_222222' })]), HERE, { now: NOW, columns: 200, tab: 'd_222222' })!
    expect(two.tabs.map(t => t.id)).toEqual(['d_111111', 'd_222222'])
    expect(two.tab).toBe('d_222222')
    expect(two.cells).toEqual([])
  })
})

describe('toasts', () => {
  test('an ask, a block, a report and a failed gate, each once', async () => {
    const ask = agent({ title: 'Scenes: vaporwave', state: 'blocked', ask: { id: 7, question: 'Which palette?', choices: [], at: iso(0) } })
    const stuck = agent({ title: 'Fix: gate', state: 'blocked', headline: 'Stuck: permission prompt' })
    const done = agent({ title: 'Docs: readme', state: 'done', report: 'Rewrote the README' })
    const failed = agent({
      title: 'Speed: cache', state: 'done',
      test: { id: 't9', state: 'done', gpu: false, purpose: 'gate', status: 'fail', passed: 3, failed: 1, at: iso(0), position: null, retry: null },
    })
    const now = alertsOf(board([ask, stuck, done, failed]), new Set(['d_111111']), NOW)
    expect(now.map(a => a.text)).toEqual([
      'claude·vaporwave asks: Which palette?',
      'claude·gate is stuck: Stuck: permission prompt',
      'claude·readme reported: Rewrote the README',
      'claude·cache: merge gate failed (3/4)',
    ])
    expect(newAlerts(now.map(a => a.key), now)).toEqual([])
    expect(newAlerts([], now).length).toBe(4)
    expect(alertsOf(board([ask]), new Set(['d_other']), NOW)).toEqual([])
  })
})

describe('wire formats', () => {
  test('server-sent events split across pieces', async () => {
    const parse = sseParser()
    expect(parse('retry: 2000\n\nevent: viewer\ndata: {"id"')).toEqual([])
    expect(parse(':"v1"}\n\n: ping\n\nevent: frame\r\ndata: a\r\ndata: b\r\n\r\n')).toEqual([
      { event: 'viewer', data: '{"id":"v1"}' },
      { event: 'frame', data: 'a\nb' },
    ])
  })

  test('the sign-in link', async () => {
    expect(parseSignIn('http://127.0.0.1:47800/?k=abc123_-x\n')).toEqual({ origin: 'http://127.0.0.1:47800', token: 'abc123_-x' })
    expect(parseSignIn('Error: broker not running')).toBe(null)
  })
})
