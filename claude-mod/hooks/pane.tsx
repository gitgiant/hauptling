// The side pane (PRD "Placement", "Pane keys"). STUB: it shows the plain agent table of this repo's delegator,
// the opened agent marked. The pane task replaces the drawing and adds the controls; `PANE` and `openAgent`
// are what the band and the commands call, so keep them.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, On, SessionStartInput } from 'claude-code'

import { circleOf, ctxText, delegatorsHere, listed, shortModel, shortNames } from './board'

// This file's `$.state` atoms (contract: types/index.d.ts). The scan reads an atom only from a const of the
// file that uses it, so each file declares its own: keep the initial value and shape tag the same everywhere.
const boardState = atom({ plugin: 'hauptling', key: 'board' } as const, null, { shape: 'board-1' })
const linkState = atom({ plugin: 'hauptling', key: 'link' } as const, 'unknown')
const hereState = atom({ plugin: 'hauptling', key: 'here' } as const, null)
const tabState = atom({ plugin: 'hauptling', key: 'tab' } as const, null)
const openedState = atom({ plugin: 'hauptling', key: 'opened' } as const, null)

/** The pane's id. */
export const PANE = 'hauptling'

/** Opens the pane on one agent (Enter or a digit on the band, `/h`). */
export async function openAgent($: EngineInterface, agent: string | null): Promise<void> {
  if (agent) await update($, openedState, () => agent)
  await $.ui.open({ id: PANE, title: 'Hauptling', focus: true })
}

/** At session start: nothing yet (the pane opens on demand). */
export async function startPane(_$: EngineInterface, _e: SessionStartInput): Promise<void> {}

export function registerPane(on: On): void {
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const [b, here, tab, opened, link] = await Promise.all([
      read($, boardState), read($, hereState), read($, tabState), read($, openedState), read($, linkState),
    ])
    const ds = here ? delegatorsHere(b, here) : []
    const d = ds.find(x => x.id === tab) ?? ds[0]
    if (link !== 'up') return <Text dimColor>The Hauptling broker does not answer.</Text>
    if (!d) return <Text dimColor>No active delegator for this repo.</Text>
    const agents = listed(b, d.id, await $.clock.now())
    const names = shortNames(agents)

    return (
      <Box flexDirection="column">
        <Text bold>{d.id} · {d.repo}</Text>
        {agents.length === 0 && <Text dimColor>No agents.</Text>}
        {agents.map((a, i) => {
          const c = circleOf(a)
          return (
            <Text inverse={a.id === opened}>
              {String(i + 1).padStart(2)} <Text color={c.color}>{c.glyph.padEnd(2)}</Text> {names.get(a.id)?.name} · {shortModel(a)} · {ctxText(a)} · {c.label} · {a.id}
            </Text>
          )
        })}
      </Box>
    )
  })
}
