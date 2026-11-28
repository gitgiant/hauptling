// The hauptling mod (PRD "Claude CLI mod"): Hauptling's agents above the prompt and in a side pane.
// Kept thin: each area registers its hooks and its start step from its own file, so they are built apart.
// The one `session.start` hook is here because validate allows one per event without a matcher, and follows
// `$` only into named functions: each area exports `start<Area>($, e)`, called in this order.
import type { Register } from 'claude-code'

import { registerBand } from './band'
import { registerCommands, startCommands } from './commands'
import { startLive } from './live'
import { registerPane, startPane } from './pane'
import { registerTerminal, startTerminal } from './terminal'

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await startCommands($, e).catch(() => {})
    await startPane($, e).catch(() => {})
    await startTerminal($, e).catch(() => {})
    await startLive($, e).catch(() => {})
    return started
  })
  registerBand(on)
  registerPane(on)
  registerTerminal(on)
  registerCommands(on)
}
