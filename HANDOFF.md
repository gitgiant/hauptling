# Handoff — 2026-11-25

Token economy stages 1–2 are on branch `claude/beautiful-dirac-t0hx3x` (not yet on `main`); PRD "Token economy decisions" has all three stages. `npm test` (42) passes; nothing run on the real host yet.

## Needs a real run to confirm

- Claude workers start with `--effort <tier default>` and Codex with `-c model_reasoning_effort="…"`; confirm both TUIs accept them.
- A Claude delegator running `hauptling wait --until-event` in the background wakes on events.
- Stage 1 changed `src/vendors.mjs` (Claude plugins turned off in the slot): run `hauptling image`, then `hauptling broker stop`.
- Claude worker starts with `--strict-mcp-config` and no MCP servers; Codex with `-c mcp_servers={}` actually drops servers from the slot's `config.toml` (may merge instead of replace).
- The `spent:` line on a real `[report]` (window deltas need status-line readings at launch and at report).
- Usage tab "Model preference" select writes `prefer` to `~/.hauptling/models.json`.
- "Sign in" on the Usage tab (vendor login in host tmux).
- The Terminal tab live in a browser (parts tested; headless screenshots fire before data arrives).
- A worker on an API key: Claude's TUI should show API billing; for agy, whether `GEMINI_API_KEY` or its OAuth sign-in wins is unknown.
- GPU `pause --now`, the VRAM wait and `gateGpu` on the real GPU (unit-tested only).

## Open

- Token economy stage 3 (headroom routing at 80%): not started. agy's bare config (MCP off) is unknown. `[handoff-due]` assumes the host CLI uses the same vendor account as the slots.
- Codex prices in `models.json` are `null`, so Codex cost shows "unknown".
- agy's own sign-in token rotation is unconfirmed (PRD "Open").
- macOS / Ubuntu install untested; only WSL so far.
- `hauptling broker status` fails with `Unknown call tunnel.status` (`bin/hauptling.mjs`, leftover from the dropped SSH-tunnel design); drop the tunnel part. The broker itself runs fine.
- `hauptling test request` with an empty `--sha` swallows the next flag as the sha and fails later at checkout; validate up front.
- `hauptling dashboard --print` always prints the `127.0.0.1` link; a `--host` flag would help over Tailscale.
- Merged branches to delete: `phase-1`, `phase-3`, `phase-4`, `phase-4b`, `signin-guard`, `api-keys`, `handoff-rule`, `usage-per-vendor`, `egress-race`.

## This machine now

- Slots `hl-w1..3` signed in to claude, codex and agy; no API keys set.
- Tailscale serve is on: `https://old.tailff0f31.ts.net/` → the dashboard. Off: `"/mnt/c/Program Files/Tailscale/tailscale.exe" serve --https=443 off`.
- GPU jobs wait for 6144 MiB free; with the desktop open about 6.2–6.7 GB is free, so they may queue.
