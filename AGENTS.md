# Hauptling — notes for agents

Design and every decision: `PRD.md`. Current state and open items: `HANDOFF.md` — read it at session start.

## Conventions

- Plain ESM `.mjs`, JSDoc, `node:test` (`npm test`), no build step, no npm dependencies. The dashboard is vanilla JS in `web/dashboard/`.
- Record decisions in `PRD.md` before building. Design interviews: one question per message, lettered options and a recommendation.
- Work on a branch; fast-forward `main` when the user says "merge to main".
- Code that runs inside workers (`vendors.mjs` prepare, `runner.mjs`, the CLI) is baked into the worker image: after changing it, run `hauptling image`, then `hauptling broker stop` (the next command restarts the broker).

## Gotchas on this host (WSL2)

- Docker won't (re)start from a shell whose open-files soft limit is above 524288: `(ulimit -Sn 1024; sudo service docker start)`.
- `sudo` needs a real terminal: run `hauptling setup` in a WSL terminal, not through Claude Code's `!`.
- Kill processes by PID; `pkill -f` inside a bash command matches its own shell.
- Screenshots: headless Edge (`msedge.exe --headless --screenshot`, fresh `--user-data-dir`). It fires at page load, before SSE data arrives; `--virtual-time-budget` hangs on SSE pages.
- git is old: no `git init -b`.

## HANDOFF.md

A snapshot of what the next session needs and can't find elsewhere: current state, unverified work, open items. At the end of a session, rewrite it rather than append to it:

- Under 40 lines, dated at the top.
- Every line is live: drop what's done, verified or fixed, and anything that lives elsewhere (decisions → `PRD.md`, history → `git log`, lasting conventions and gotchas → this file).

Done when every line is still true today and appears nowhere else.
