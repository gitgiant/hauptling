# Hauptling for Claude Code

A Claude Code mod that shows the Hauptling delegator's agents in a one-row band above the prompt while this
repo has an active delegator: a short name, the model, context use and a status circle per agent. Press
ctrl+x tab to focus the band, ←/→ or 1–9 to pick an agent, Enter to open it in the side pane, Esc to go back to
the prompt. It talks to the local Hauptling broker's dashboard API on 127.0.0.1:47800 and signs in with the
token `hauptling dashboard --print` prints. Design: `PRD.md`, section "Claude CLI mod".

`/h help` lists the slash commands that do the same from the prompt (`/h status`, `/h kill cv`, `/h reply 2 <text>`, …).

In the pane (Enter on an agent): k kill, p pause, r restart, m merge (each of those three asks y/n; the same key
twice skips it), a answer an ask, s suggest (a reply to the worker), c suggest through this Claude session, d diff,
e events, u/v/f/l move in the queue, w show all, o options (gate, auto-merge, host, model tier), g pause the GPU.

Checks: `npm run test:mod` from the repo root (validate, tests).
