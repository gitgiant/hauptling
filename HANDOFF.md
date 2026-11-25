# Handoff — 2026-11-25

All four PRD phases, the sign-in lock, API keys, per-vendor usage and the egress-proxy race fix are on `main`. Branch `codegraph` (on top of `usage-header`, neither merged): header usage chips replace the Usage tab; CodeGraph in workers (PRD "CodeGraph in workers"). `npm test` (44) passes. Worker image rebuilt with CodeGraph.

## Needs a real run to confirm

- Broker not restarted since `cli-fixes`: header CPU/Mem/GPU graphs, card headlines, usage chips and the CodeGraph launch path go live after `hauptling broker stop` (a test job was running, so it was left up).
- CodeGraph with a real task: whether agents (and their subagents) actually use it; first-index time on a large repo (nullpunkt). The container path itself is verified (index 3 s / 1 s from cache on this repo, no MCP prompt, repo `.mcp.json` ignored).
- "Sign in" on the usage page (vendor login in host tmux).
- The Terminal tab live in a browser (parts tested; headless screenshots fire before data arrives).
- A worker on an API key: Claude's TUI should show API billing; for agy, whether `GEMINI_API_KEY` or its OAuth sign-in wins is unknown.
- API budget (branch `api-budget`, on `codegraph`; PRD "API keys"): claude key has a $100/month budget set. Unit-tested only; needs a broker restart, then a real spawn should say `, api`, and the header an "API $x/$100" chip. Whether Claude's reported `total_cost_usd` matches the console bill is unchecked.
- Superseded gate kill (`killTestJob` on a running gate) and the dashboard's dead-container screen answer: unit-tested only; code is baked into nothing (broker-side) but needs `hauptling broker stop` to go live.
- GPU `pause --now`, the VRAM wait and `gateGpu` on the real GPU (unit-tested only).

## Open

- nullpunkt: commit `b9a0f6e8` (drops the coagent mailbox for `hauptling mail`) sits in `nullpunkt/.worktrees/claude_opus-5-5_d72c0`, unpushed. Before `node scripts/worktree.mjs sync claude_opus-5-5_d72c0`, discard the main checkout's local edits to `.mcp.json` and `.codex/hooks.json` (the commit replaces both). Sync restarts the user's game.
- Codex/agy: can either exclude a repo's own MCP servers? (CodeGraph reaches them via the CLI only.)
- Codex prices in `models.json` are `null`, so Codex cost shows "unknown".
- agy's own sign-in token rotation is unconfirmed (PRD "Open").
- macOS / Ubuntu install untested; only WSL so far.
- Merged branches to delete: `phase-1`, `phase-3`, `phase-4`, `phase-4b`, `signin-guard`, `api-keys`, `handoff-rule`, `usage-per-vendor`, `egress-race`, `cli-fixes`.

## This machine now

- Slots `hl-w1..3` signed in to claude, codex and agy; no API keys set.
- Host has `codegraph` (npm, telemetry on unless `CODEGRAPH_TELEMETRY=0`), `uv` and `graphify` (`~/.local/bin`); this repo is indexed (`.codegraph-wsl/`, git hooks resync it).
- Tailscale serve is on: `https://old.tailff0f31.ts.net/` → the dashboard. Off: `"/mnt/c/Program Files/Tailscale/tailscale.exe" serve --https=443 off`.
- GPU jobs wait for 6144 MiB free; with the desktop open about 6.2–6.7 GB is free, so they may queue.
