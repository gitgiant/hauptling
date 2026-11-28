// A fake board, shaped as `snapshot()` in src/dashboard.mjs answers it.
import type { Agent, Board, Delegator } from '../types'

export const NOW = Date.parse('2026-11-28T12:00:00Z')
export const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString()

let seq = 0
export function agent(over: Partial<Agent> & { title: string }): Agent {
  seq++
  return {
    id: `claude_opus-5-5_${String(seq).padStart(5, 'a')}`,
    delegator: 'd_111111',
    vendor: 'claude',
    model: 'opus-5-5',
    repo: 'acme/app',
    state: 'working',
    idle: 0,
    created_at: iso(3600e3 - seq * 1000),
    updated_at: iso(60e3),
    ended: false,
    queue: null,
    usage: { context_pct: 42 },
    test: null,
    ask: null,
    report: null,
    pr_url: null,
    pr_number: null,
    status: null,
    headline: null,
    ...over,
  }
}

export function delegator(over: Partial<Delegator> = {}): Delegator {
  return { id: 'd_111111', repo: 'acme/app', cli: 'claude', gate: true, automerge: true, created_at: iso(7200e3), handoff_waiting: false, ...over }
}

export const board = (agents: Agent[], delegators: Delegator[] = [delegator()]): Board => ({ agents, delegators })
