// The worker's live terminal in the pane (PRD "Terminal"). STUB: not built yet. The terminal task fills this in
// with `client.termStream` / `termKeys` / `termInput` / `termSize`; the pane draws what it exports.
import type { EngineInterface, On, SessionStartInput } from 'claude-code'

/** At session start: nothing yet. */
export async function startTerminal(_$: EngineInterface, _e: SessionStartInput): Promise<void> {}

export function registerTerminal(_on: On): void {
  // Nothing yet.
}
