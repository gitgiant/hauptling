// The side pane's drawings, one function per view (PRD "Pane keys", "Suggest", "Extras"). No `$` here: pane.tsx
// reads the state, builds `PaneModel` and hands in the handlers (`PaneActs`), each of which calls its own named
// function with `$`. Every control is a plain Button with a hotkey, so the terminal draws `k: kill`.
import type { Elements } from 'claude-code'

import type { Agent, Delegator, PaneDetail, PanePending, PaneStatus, PaneView } from '../types'
import { AGENT_KEYS, KEYS, TIERS, diffTone, prText, replyLimit } from './pane-model'
import type { Header, PaneKey, Row } from './pane-model'

/** The element table the views draw with (the same names on every surface that draws a pane). */
export type Els = Pick<Elements['terminal'], 'Box' | 'Text' | 'Button' | 'Input' | 'Select' | 'Link'>

export type PaneModel = {
  d: Delegator
  header: Header
  rows: Row[]
  sel: Agent | null
  selName: string
  view: PaneView
  pending: PanePending | null
  status: PaneStatus | null
  detail: PaneDetail | null
  showAll: boolean
  hosts: string[]
  host: string | null
  prefer: string | null
  draft: string | null
}

export type PaneActs = {
  press: (k: PaneKey) => Promise<void>
  select: (agent: string) => Promise<void>
  choose: (choice: number) => Promise<void>
  reply: (text: string) => Promise<void>
  claude: (text: string) => Promise<void>
  host: (host: string) => Promise<void>
  tier: (tier: string) => Promise<void>
}

const VERB = { kill: 'Kill', restart: 'Restart', merge: 'Merge' } as const

/** A key's Button: `k: kill` on the terminal; its address is `key:<name>`. */
function keyButton(els: Els, acts: PaneActs, k: PaneKey, label: string = KEYS[k].label) {
  const { Button } = els
  return <Button key={`key:${k}`} plain hotkey={KEYS[k].hotkey} label={label} onPress={() => acts.press(k)} />
}

function headerView(els: Els, acts: PaneActs, m: PaneModel) {
  const { Box, Text } = els
  const top = m.header
  return (
    <Box flexDirection="column">
      <Text bold wrap="truncate-end">{top.title}</Text>
      <Text dimColor wrap="truncate-end">{top.merge} · {top.tests}</Text>
      <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
        <Text dimColor>{top.gpu}</Text>
        {top.gpuKey && keyButton(els, acts, 'gpu', `${top.gpuKey} GPU`)}
      </Box>
      <Text dimColor wrap="truncate-end">{top.usage.join(' · ')}</Text>
    </Box>
  )
}

function statusView(els: Els, s: PaneStatus | null) {
  const { Text } = els
  if (!s) return null
  return s.isError ? <Text color="error">{s.text}</Text> : <Text dimColor>{s.text}</Text>
}

function rowView(els: Els, acts: PaneActs, r: Row) {
  const { Button, Text } = els
  return (
    <Button key={`row:${r.id}`} plain label={r.name} {...(r.n <= 9 ? { hotkey: String(r.n) } : {})} onPress={() => acts.select(r.id)}>
      {r.n > 9 ? '   ' : null}
      <Text color={r.circle.color} dimColor={r.circle.dim}>{r.circle.glyph.padEnd(2)}</Text>
      <Text inverse={r.isSelected}>{r.name}</Text>
      <Text dimColor> {r.rest}</Text>
    </Button>
  )
}

function selectedView(els: Els, m: PaneModel, a: Agent) {
  const { Box, Text, Link } = els
  return (
    <Box flexDirection="column">
      <Text bold wrap="truncate-end">{m.selName} <Text dimColor>{a.id}</Text></Text>
      <Text wrap="truncate-end">{a.title}</Text>
      {a.status ? <Text dimColor wrap="truncate-end">{a.status}</Text> : null}
      {a.ask ? <Text color="error">asks: {a.ask.question}</Text> : null}
      {a.pr_url ? (
        <Box flexDirection="row">
          <Text dimColor>PR </Text>
          <Link href={a.pr_url} label={prText(a) || a.pr_url} />
        </Box>
      ) : null}
    </Box>
  )
}

/** The table: header, a row per agent, the selected agent, its keys, a y/n question, the status line. */
export function tableView(els: Els, acts: PaneActs, m: PaneModel) {
  const { Box, Text } = els
  const a = m.sel
  const p = m.pending
  return (
    <Box flexDirection="column" rowGap={1}>
      {headerView(els, acts, m)}
      <Box flexDirection="column">
        {m.rows.length === 0 ? <Text dimColor>No agents.</Text> : m.rows.map(r => rowView(els, acts, r))}
      </Box>
      {a ? selectedView(els, m, a) : null}
      {a ? (
        <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
          {AGENT_KEYS.map(k => keyButton(els, acts, k, k === 'pause' && a.state === 'paused' ? 'unpause' : KEYS[k].label))}
        </Box>
      ) : null}
      {p ? (
        <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
          <Text color="warning">{VERB[p.action]} {p.name}?</Text>
          {keyButton(els, acts, 'yes')}
          {keyButton(els, acts, 'no')}
          <Text dimColor>({KEYS[p.action].hotkey} again: yes)</Text>
        </Box>
      ) : null}
      <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
        {keyButton(els, acts, 'all', m.showAll ? 'recent only' : 'show all')}
        {keyButton(els, acts, 'options', 'options')}
      </Box>
      {statusView(els, m.status)}
    </Box>
  )
}

/** The diff or events of the selected agent, a line each; the pane's own scroll (arrows) moves through it. */
export function detailView(els: Els, acts: PaneActs, m: PaneModel) {
  const { Box, Text } = els
  const kind = m.view === 'diff' ? 'diff' : 'events'
  const d = m.detail && m.sel && m.detail.agent === m.sel.id && m.detail.kind === kind ? m.detail : null
  return (
    <Box flexDirection="column">
      <Text bold wrap="truncate-end">{kind === 'diff' ? 'Diff' : 'Events'} · {m.selName}</Text>
      <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
        {keyButton(els, acts, 'diff')}
        {keyButton(els, acts, 'events')}
        {keyButton(els, acts, 'back')}
      </Box>
      {statusView(els, m.status)}
      {d?.note ? <Text dimColor>{d.note}</Text> : null}
      {!d ? <Text dimColor>loading…</Text> : null}
      {(d?.lines ?? []).map(line => {
        const tone = kind === 'diff' ? diffTone(line) : null
        return tone ? <Text color={tone}>{line || ' '}</Text> : <Text>{line || ' '}</Text>
      })}
    </Box>
  )
}

/**
 * An open ask: its question and a Button per choice (1–9). A typed answer is `s`, in the suggest view: a field
 * beside digit hotkeys could pick a choice while typing.
 */
export function answerView(els: Els, acts: PaneActs, m: PaneModel) {
  const { Box, Text, Button } = els
  const a = m.sel
  if (!a?.ask) {
    return (
      <Box flexDirection="column">
        <Text dimColor>{a ? `${m.selName} has no open question.` : 'No agent selected.'}</Text>
        {keyButton(els, acts, 'back')}
      </Box>
    )
  }
  return (
    <Box flexDirection="column" rowGap={1}>
      <Text bold>{m.selName} asks:</Text>
      <Text>{a.ask.question}</Text>
      <Box flexDirection="column">
        {a.ask.choices.map((c, i) => (
          <Button key={`choice:${i}`} plain label={c} {...(i < 9 ? { hotkey: String(i + 1) } : {})} onPress={() => acts.choose(i)} />
        ))}
      </Box>
      <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
        {keyButton(els, acts, 'suggest', 'type an answer')}
        {keyButton(els, acts, 'back')}
      </Box>
      {statusView(els, m.status)}
    </Box>
  )
}

/** `s` (reply to the worker) or `c` (hand it to this Claude session): one field, Enter sends. */
export function suggestView(els: Els, acts: PaneActs, m: PaneModel) {
  const { Box, Text, Button, Input } = els
  const a = m.sel
  const viaClaude = m.view === 'claude'
  if (!a) return <Text dimColor>No agent selected.</Text>
  return (
    <Box flexDirection="column" rowGap={1}>
      <Text bold>{viaClaude ? `Suggest to ${m.selName} through this Claude session` : a.ask ? `Answer ${m.selName}: ${a.ask.question}` : `Reply to ${m.selName}`}</Text>
      <Text dimColor>
        {viaClaude
          ? 'Enter hands it to Claude as a prompt ("suggest to …"); Claude adds context and replies itself.'
          : `Sent as mail: at most ${replyLimit(a)} characters (the broker's limit). Enter sends.`}
      </Text>
      <Input key={viaClaude ? 'claude' : 'suggest'} autoFocus submitLabel="send"
        placeholder={viaClaude ? 'what to suggest' : `at most ${replyLimit(a)} characters`}
        {...(m.draft != null && !viaClaude ? { value: m.draft } : {})}
        onSubmit={text => (viaClaude ? acts.claude(text) : acts.reply(text))} />
      <Button key="key:back" label="cancel" onPress={() => acts.press('back')} />
      {statusView(els, m.status)}
    </Box>
  )
}

/** The delegator's settings (gate, auto-merge, host) and the model tier preference. */
export function optionsView(els: Els, acts: PaneActs, m: PaneModel) {
  const { Box, Text, Select } = els
  return (
    <Box flexDirection="column" rowGap={1}>
      <Text bold>Options · {m.d.id}</Text>
      <Box flexDirection="column">
        {keyButton(els, acts, 'gate', `merge gate: ${m.d.gate ? 'on (turn off)' : 'off (turn on)'}`)}
        {keyButton(els, acts, 'automerge', `auto-merge: ${m.d.automerge ? 'on (turn off)' : 'off (turn on)'}`)}
      </Box>
      <Select key="host" label="host for new agents: " options={m.hosts.map(name => ({ value: name }))}
        {...(m.host ? { value: m.host } : {})} onSelect={v => acts.host(v)} />
      <Select key="tier" label="model tier for new workers: " options={TIERS.map(t => ({ value: t }))}
        {...(m.prefer ? { value: m.prefer } : {})} onSelect={v => acts.tier(v)} />
      {keyButton(els, acts, 'back')}
      {statusView(els, m.status)}
    </Box>
  )
}
