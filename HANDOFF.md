# Handoff — 2026-11-25

## Needs a real run to confirm

- Test recovery and external-merge cancellation were tested with a fake host. The live broker still needs to run the updated code.

- Broker not restarted since `cli-fixes`: header CPU/Mem/GPU graphs, card headlines, usage chips and the CodeGraph launch path go live after `hauptling broker stop` (a test job was running, so it was left up).
- CodeGraph with a real task: whether agents (and their subagents) actually use it; first-index time on a large repo (nullpunkt). The container path itself is verified (index 3 s / 1 s from cache on this repo, no MCP prompt, repo `.mcp.json` ignored).
- Token economy changed worker code (`src/vendors.mjs` turns Claude plugins off in the slot): run `hauptling image`, then `hauptling broker stop`.
- Claude workers start with `--effort <tier default>` and Codex with `-c model_reasoning_effort="…"`; confirm both TUIs accept them. Codex's `-c mcp_servers={}` actually drops servers from the slot's `config.toml` (may merge instead of replace).
- Claude workers with plugins off still get CodeGraph from `managed-mcp.json` (the token-economy branch's `--strict-mcp-config` was dropped in the merge).
- Re-run `hauptling setup` to install the host status lines (`hauptling usage <vendor> --host`, chaining your old one); check the host Claude status line still shows your old output and `host_usage` fills.
- A Claude delegator running `hauptling wait --delegator <id> --until-event` in the background wakes on events.
- The `spent:` line on a real `[report]` (window deltas need status-line readings at launch and at report).
- Usage tab "Model preference" select writes `prefer` to `~/.hauptling/models.json`.
- "Sign in" on the Usage tab (vendor login in host tmux).
- The Terminal tab live in a browser (parts tested; headless screenshots fire before data arrives).
- A worker on an API key: Claude's TUI should show API billing; for agy, whether `GEMINI_API_KEY` or its OAuth sign-in wins is unknown.
- API budget (branch `api-budget`, on `codegraph`; PRD "API keys"): claude key has a $100/month budget set. Unit-tested only; needs a broker restart, then a real spawn should say `, api`, and the header an "API $x/$100" chip. Whether Claude's reported `total_cost_usd` matches the console bill is unchecked.
- Superseded gate kill (`killTestJob` on a running gate): unit-tested only; code is baked into nothing (broker-side) but needs `hauptling broker stop` to go live.
- Per-delegator `gate`/`automerge` (PRD "Merge gate"): unit-tested only; needs `hauptling broker stop` (broker-side) to go live. Dashboard buttons unseen in a browser. Local repos with auto-merge on still stop at `[gate-passed]` (manual `hauptling merge`), as before.
- GPU `pause --now`, the VRAM wait and `gateGpu` on the real GPU (unit-tested only).

## Open

- nullpunkt: commit `b9a0f6e8` (drops the coagent mailbox for `hauptling mail`) sits in `nullpunkt/.worktrees/claude_opus-5-5_d72c0`, unpushed. Before `node scripts/worktree.mjs sync claude_opus-5-5_d72c0`, discard the main checkout's local edits to `.mcp.json` and `.codex/hooks.json` (the commit replaces both). Sync restarts the user's game.
- Codex/agy: can either exclude a repo's own MCP servers? (CodeGraph reaches them via the CLI only.) agy's bare config (MCP off) is unknown.
- Token economy stage 3 (headroom routing at 80%): not started.
- Codex prices in `models.json` are `null`, so Codex cost shows "unknown".
- agy's own sign-in token rotation is unconfirmed (PRD "Open").
- macOS / Ubuntu install untested; only WSL so far.
- Merged branches to delete: `phase-1`, `phase-3`, `phase-4`, `phase-4b`, `signin-guard`, `api-keys`, `handoff-rule`, `usage-per-vendor`, `egress-race`, `cli-fixes`.

## This machine now

- Slots `hl-w1..3` signed in to claude, codex and agy; no API keys set.
- Host has `codegraph` (npm, telemetry on unless `CODEGRAPH_TELEMETRY=0`), `uv` and `graphify` (`~/.local/bin`); this repo is indexed (`.codegraph-wsl/`, git hooks resync it).
- Tailscale serve is on: `https://old.tailff0f31.ts.net/` → the dashboard. Off: `"/mnt/c/Program Files/Tailscale/tailscale.exe" serve --https=443 off`.
- GPU jobs wait for 6144 MiB free; with the desktop open about 6.2–6.7 GB is free, so they may queue.
