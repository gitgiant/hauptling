# Hauptling for Claude Code

A Claude Code mod that shows the Hauptling delegator's agents in a one-row band above the prompt while this
repo has an active delegator: a short name, the model, context use and a status circle per agent. It talks to the
local Hauptling broker's dashboard API on 127.0.0.1:47800 and signs in with the token `hauptling dashboard --print`
prints (on Windows, through `wsl.exe` when `hauptling` is not on the Windows PATH). `hauptling setup` installs it.
Design: `PRD.md`, section "Claude CLI mod".

## Band

ctrl+x tab focuses the band; ←/→ walk the agents, 1–9 or Enter open one in the side pane, Esc goes back to the
prompt. A red circle blinks for an agent that asks or is blocked; asks, blocks, reports and failed gates also toast.

## Pane

k kill, p pause/unpause, r restart, m merge (kill, restart and merge ask y/n; the same key twice skips it),
a answer an ask, s suggest (a reply to the worker), c suggest through this Claude session, t terminal, d diff,
e events, u/v/f/l move up/down/first/last in the queue, w show all, o options (gate, auto-merge, host, model tier),
g pause or resume the GPU queue, b back.

## Terminal

t shows the selected agent's live tmux screen, sized to the pane (the worker's window follows the smallest viewer).
i turns input on: type into the field and each edit goes to the worker's input line, Enter sends Enter, and the
buttons send Esc, Tab, arrows, ⌫ and ^C. While input is on, letters go to the worker, so reach the view's buttons
with Tab or a click. The broker turns input off after 10 idle minutes; the view says when. Esc returns to the
prompt. The stream stops when you go back, close the pane, pick another agent or the agent ends.

## `/h` commands

The same from the prompt, without a focus change; `/h help` lists them. An agent is its list number, short name,
initials or ID.

- `/h status`
- `/h kill|pause|unpause|restart|merge <agent>`
- `/h reply <agent> <text>`, `/h answer <agent> <choice or text>`
- `/h move <agent> up|down|top|bottom`
- `/h gate on|off`, `/h automerge on|off`, `/h prefer cheap|balanced|best`, `/h gpu pause|resume`

## Checks

`npm run test:mod` from the repo root (validate, kit tests; the kit tests need a host where hooks modules are on).
