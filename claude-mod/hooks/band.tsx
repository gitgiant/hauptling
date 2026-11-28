// The band above the prompt (PRD "Placement", "Columns", "Navigation"): one row, one Button per agent of this
// repo's delegator, a tab per delegator when there are several. Hidden while no delegator matches or the broker
// does not answer.
//
// Focus is the engine's: ctrl+x tab (or a click) focuses the band, ←/→ walk its Buttons, Enter presses the
// focused one (opens the agent in the pane), 1–9 press one directly, Esc returns to the prompt.
import { atom, read, update } from 'claude-code'
import type { On } from 'claude-code'

import { bandModel } from './board'
import type { BandModel } from './board'
import { tabText } from './board'
import { openAgent } from './pane'

// This file's `$.state` atoms (contract: types/index.d.ts). The scan reads an atom only from a const of the
// file that uses it, so each file declares its own: keep the initial value and shape tag the same everywhere.
const boardState = atom({ plugin: 'hauptling', key: 'board' } as const, null, { shape: 'board-1' })
const linkState = atom({ plugin: 'hauptling', key: 'link' } as const, 'unknown')
const hereState = atom({ plugin: 'hauptling', key: 'here' } as const, null)
const tabState = atom({ plugin: 'hauptling', key: 'tab' } as const, null)
const focusedState = atom({ plugin: 'hauptling', key: 'focused' } as const, null)
const blinkState = atom({ plugin: 'hauptling', key: 'blink' } as const, true)

/** The `key` of an agent's Button is its id; tabs are `tab:<delegator>`. */
const TAB = 'tab:'

export function registerBand(on: On): void {
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    if ((await read($, linkState)) !== 'up') return next(e)
    const here = await read($, hereState)
    if (!here) return next(e)
    const m: BandModel | null = bandModel(await read($, boardState), here, {
      now: await $.clock.now(), columns: e.props.bodyColumns, tab: await read($, tabState),
    })
    if (!m) return next(e)
    // Only a band with a blinking circle subscribes to the blink phase.
    const isLit = m.cells.some(c => c.circle.blink) ? await read($, blinkState) : true
    const { Box, Button, Text } = $.ui.resolve(e)

    return (
      <Box flexDirection="row" columnGap={2}>
        {m.tabs.map(t => (
          <Button key={`${TAB}${t.id}`} label={t.label} plain onPress={() => update($, tabState, () => t.id)}>
            <Text bold={t.id === m.tab} dimColor={t.id !== m.tab}>{tabText(t, t.id === m.tab)}</Text>
          </Button>
        ))}
        {m.cells.map(c => {
          const off = c.circle.blink && !isLit
          const glyph = (
            <Text color={off ? 'inactive' : c.circle.color} dimColor={c.circle.dim || off}>{c.circle.glyph}</Text>
          )
          return (
            <Button key={c.id} label={c.name} plain {...(c.n <= 9 ? { hotkey: String(c.n) } : {})} onPress={() => openAgent($, c.id)}>
              {m.mode === 'full'
                ? [<Text>{c.name} </Text>, <Text dimColor>{c.model} {c.ctx} </Text>, glyph]
                : [glyph, <Text> {c.initials}</Text>]}
            </Button>
          )
        })}
        {m.more > 0 && <Text dimColor>+{m.more}</Text>}
      </Box>
    )
  })

  // The agent under the band's focus ring: what `/h` and the pane treat as "selected".
  on('ui.focus', { component: 'AbovePrompt' }, async ($, e, next) => {
    const r = await next(e)
    if (!r.deny && e.element && !e.element.startsWith(TAB)) await update($, focusedState, () => e.element ?? null)
    return r
  }).catch(($, e, next) => next(e))
}
