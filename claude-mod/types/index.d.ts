// The `$.state` contract of the hauptling mod, and the board shapes it holds: the fields of `snapshot()` in
// src/dashboard.mjs that the mod reads (an agent row carries more; extra fields pass through untouched).

/** The latest test job of an agent (`test` on a board agent). */
export type AgentTest = {
  id: string
  state: string
  gpu: boolean
  purpose: string
  /** `pass`, `fail`, `error`, … once reported; null while queued or running. */
  status: string | null
  passed: number | null
  failed: number | null
  at: string
  position: number | null
  retry: string | null
}

/** An open ask (`hauptling ask`). */
export type AgentAsk = { id: number; question: string; choices: string[]; at: string }

/** One worker on the board. */
export type Agent = {
  id: string
  delegator: string
  vendor: string
  model: string
  title: string
  repo: string
  state: string
  /** 1 while a working agent's turn has ended with no mail waiting. */
  idle: number
  created_at: string
  updated_at: string
  ended: boolean
  /** Place in its delegator's queue, 1 first; null when not queued. */
  queue: number | null
  usage: { context_pct?: number | null; model?: string | null } | null
  test: AgentTest | null
  ask: AgentAsk | null
  report: string | null
  pr_url: string | null
  pr_number: number | null
  status: string | null
  headline: string | null
  host?: string | null
  /** `offline` or `lost` while the agent's satellite is. */
  host_state?: string
  paused_state?: string | null
  billing?: string | null
}

/** An active delegator session. */
export type Delegator = {
  id: string
  repo: string | null
  cli: string | null
  gate: boolean
  automerge: boolean
  created_at: string
  handoff_waiting: boolean
}

/** A `/dash/board` snapshot, the parts the mod reads. */
export type Board = {
  agents: Agent[]
  delegators: Delegator[]
  tests?: unknown
  gpu?: unknown
  blocked?: number
}

/** One toast-worthy event: an ask, a block, a report, a failed gate. */
export type Alert = { key: string; text: string }

/** How the broker answered the last poll. */
export type Link = 'unknown' | 'up' | 'down'

declare module 'claude-code' {
  interface PluginState {
    hauptling: {
      /** The last board polled from the broker; null before the first. */
      board: Shaped<Board | null>
      /** Whether the broker answered the last poll. */
      link: Link
      /** This session's repo: its git remote's `owner/name` and its checkout's top folder. */
      here: { slug: string | null; root: string | null } | null
      /** The delegator tab the band shows (several delegators for one repo). */
      tab: string | null
      /** The agent under the band's focus ring. */
      focused: string | null
      /** The agent the pane shows. */
      opened: string | null
      /** Alert keys seen on the last board, and whether the first board has been seen (it toasts nothing). */
      alerts: Shaped<{ keys: string[]; primed: boolean }>
      /** Blink phase of the red circle: true while lit, as it starts. */
      blink: boolean
    }
  }
}
