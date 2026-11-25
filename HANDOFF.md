# Handoff — 2026-11-24

All four PRD phases, the sign-in lock, API keys and the per-vendor Usage tab are on `main`. `npm test` (35) and `hauptling doctor` pass.

## Bug to fix first

- **Egress proxy race:** `ensureNetwork` (`src/docker.mjs`) recreates `hauptling-egress` whenever the worker image tag changed. Two spawns at once both recreate it, and the second `docker run` fails with `Conflict … "/hauptling-egress" is already in use` (seen: `codex_gpt-6.2-sol_2dce4`). Recreating it also cuts the network of workers already running. Fix: serialize `ensureNetwork`, and defer replacing a working proxy while workers run.

## Needs a real run to confirm

- "Sign in" on the Usage tab (vendor login in host tmux).
- The Terminal tab live in a browser (parts tested; headless screenshots fire before data arrives).
- A worker on an API key: Claude's TUI should show API billing; for agy, whether `GEMINI_API_KEY` or its OAuth sign-in wins is unknown.
- GPU `pause --now`, the VRAM wait and `gateGpu` on the real GPU (unit-tested only).

## Open

- Codex prices in `models.json` are `null`, so Codex cost shows "unknown".
- agy's own sign-in token rotation is unconfirmed (PRD "Open").
- macOS / Ubuntu install untested; only WSL so far.
- `hauptling test request` with an empty `--sha` swallows the next flag as the sha and fails later at checkout; validate up front.
- `hauptling dashboard --print` always prints the `127.0.0.1` link; a `--host` flag would help over Tailscale.
- Merged branches to delete: `phase-1`, `phase-3`, `phase-4`, `phase-4b`, `signin-guard`, `api-keys`, `handoff-rule`, `usage-per-vendor`.

## This machine now

- Slots `hl-w1..3` signed in to claude, codex and agy; no API keys set. Workers from a terrain task were running at handoff time (see the dashboard).
- Tailscale serve is on: `https://old.tailff0f31.ts.net/` → the dashboard. Off: `"/mnt/c/Program Files/Tailscale/tailscale.exe" serve --https=443 off`.
- GPU jobs wait for 6144 MiB free; with the desktop open about 6.2–6.7 GB is free, so they may queue.
