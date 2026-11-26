# Handoff — 2026-11-26

## Needs a real run to confirm

- Agent lifecycle controls passed stubbed tests. A Docker host is still needed to verify freeze/unfreeze, vendor session resume and container recreation from the existing clone, and to rebuild the worker image and restart the broker. External-merge cancellation was tested with a fake host. The live broker still needs to run the updated code. Test jobs surviving a broker restart and `[merge-failed]` (PRD "Merge gate"): tested with fake Docker/`gh` only. Needs `hauptling broker restart`; then restart again during a real test job (CPU and GPU) and check it is adopted and reported once.
- Broker not restarted since `cli-fixes`: header CPU/Mem/GPU graphs, card headlines, usage chips and the CodeGraph launch path go live after `hauptling broker stop` (a test job was running, so it was left up).
- CodeGraph with a real task: whether agents (and their subagents) actually use it; first-index time on a large repo (nullpunkt). The container path itself is verified (index 3 s / 1 s from cache on this repo, no MCP prompt, repo `.mcp.json` ignored).
- Token economy changed worker code (`src/vendors.mjs` turns Claude plugins off in the slot): run `hauptling image`, then `hauptling broker stop`.
- Claude workers start with `--effort <tier default>` and Codex with `-c model_reasoning_effort="…"`; confirm both TUIs accept them. Codex's `-c mcp_servers={}` actually drops servers from the slot's `config.toml` (may merge instead of replace). Claude workers with plugins off still get CodeGraph from `managed-mcp.json` (the token-economy branch's `--strict-mcp-config` was dropped in the merge).
- Re-run `hauptling setup` to install the host status lines (`hauptling usage <vendor> --host`, chaining your old one); check the host Claude status line still shows your old output and `host_usage` fills.
- A Claude delegator running `hauptling wait --delegator <id> --until-event` in the background wakes on events. The `spent:` line on a real `[report]` (window deltas need status-line readings at launch and at report).
- Usage tab "Model preference" select writes `prefer` to `~/.hauptling/models.json`. "Sign in" on the Usage tab (vendor login in host tmux).
- The Terminal tab live in a browser (parts tested; headless screenshots fire before data arrives).
- A worker on an API key: Claude's TUI should show API billing; for agy, whether `GEMINI_API_KEY` or its OAuth sign-in wins is unknown.
- API budget (branch `api-budget`, on `codegraph`; PRD "API keys"): claude key has a $100/month budget set. Unit-tested only; needs a broker restart, then a real spawn should say `, api`, and the header an "API $x/$100" chip. Whether Claude's reported `total_cost_usd` matches the console bill is unchecked.
- API spend across sessions and out-of-credit detection (PRD "API keys"): unit-tested only. Needs `hauptling broker restart`; unchecked on a real TUI: the screen match for "Credit balance too low", whether `--resume` restores Claude's session cost (if it does under a new `session_id`, spend double-counts).
- Superseded gate kill (`killTestJob` on a running gate): unit-tested only; code is baked into nothing (broker-side) but needs `hauptling broker stop` to go live. Per-delegator `gate`/`automerge` (PRD "Merge gate"): unit-tested only; needs `hauptling broker stop` (broker-side) to go live. Dashboard buttons unseen in a browser. Local repos with auto-merge on still stop at `[gate-passed]` (manual `hauptling merge`), as before.
- GPU `pause --now`, the VRAM wait and `gateGpu` on the real GPU (unit-tested only).
- Test watchdog (PRD "Watchdog"): core logic unit-tested with docker and clock stubbed; the real `testLiveness` probe (`docker inspect`, heartbeat mtime) is unrun. Needs `hauptling image` (runner heartbeat) and `hauptling broker stop`.
- Slots per vendor (PRD "Security"): a slot runs one worker per vendor, containers mount only their vendor's dir, `maxWorkers` (default 6) caps the host. Unit-tested only. Needs `hauptling image` and `hauptling broker restart`; check a codex worker's container has no `.vendor/claude`.
- Several hosts parts 1–2 (PRD "Several hosts", "Part 2"): link, placement, commands and the hub mirror are tested with two brokers in one process (Docker and `gh` stubbed) only. Needs `hauptling image` (the CLI gained `--host`/`--gpu`) and `hauptling broker restart`, then a real join from a second host through the `tailscale serve` URL: SSE through the proxy, a real spawn → PR → merge on the satellite with its own `gh`, and a satellite stall notification reaching this machine. Several hosts part 3 (PRD "Part 3"): host chips, offline/lost headlines, Hosts panel (Add host, Revoke), terminal/diff/events relayed over the link, `hauptling attach` relay, per-host usage chips. Tested with two in-process brokers only; the browser UI is unseen (no headless browser in the worker: `node scripts/dash-preview.mjs --hosts --shots DIR --only usage-1366x768`). Needs `hauptling broker restart` on the hub and every satellite; check that "Add host" through `tailscale serve` shows the https URL (`X-Forwarded-Host`/`Host`), and that the relayed terminal feels responsive (250 ms polls).
- Parking (PRD "Parking", branch `hl/claude_opus-5-5_985e5`): stubbed tests only. Needs `hauptling broker restart`. Unchecked on real TUIs: that a Claude/Codex session copied into another slot resumes (`--resume` / `codex resume`), that mail arrives via SessionStart/first prompt after resume, the 3 s park delay vs. the TUI's last transcript write, and the saved screen in the Terminal tab.

## Open

- Placement's `startable` only knows the hub's own accounts; satellites' usage readings are shown on the Usage page but not used for placement.
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
