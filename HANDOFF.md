# Handoff — 2026-11-24

All four PRD phases, the sign-in lock, API keys, the per-vendor Usage tab and the egress-proxy race fix are on `main`. `npm test` (38) and `hauptling doctor` pass.

## Needs a real run to confirm

- "Sign in" on the Usage tab (vendor login in host tmux).
- The Terminal tab live in a browser (parts tested; headless screenshots fire before data arrives).
- A worker on an API key: Claude's TUI should show API billing; for agy, whether `GEMINI_API_KEY` or its OAuth sign-in wins is unknown.
- GPU `pause --now`, the VRAM wait and `gateGpu` on the real GPU (unit-tested only).

## Open

- Codex prices in `models.json` are `null`, so Codex cost shows "unknown".
- agy's own sign-in token rotation is unconfirmed (PRD "Open").
- macOS / Ubuntu install untested; only WSL so far.
- `hauptling broker status` fails with `Unknown call tunnel.status` (`bin/hauptling.mjs`, leftover from the dropped SSH-tunnel design); drop the tunnel part. The broker itself runs fine.
- `hauptling test request` with an empty `--sha` swallows the next flag as the sha and fails later at checkout; validate up front.
- `hauptling dashboard --print` always prints the `127.0.0.1` link; a `--host` flag would help over Tailscale.
- Merged branches to delete: `phase-1`, `phase-3`, `phase-4`, `phase-4b`, `signin-guard`, `api-keys`, `handoff-rule`, `usage-per-vendor`, `egress-race`.

## This machine now

- Slots `hl-w1..3` signed in to claude, codex and agy; no API keys set. Workers from a terrain task were running at handoff time (see the dashboard).
- Tailscale serve is on: `https://old.tailff0f31.ts.net/` → the dashboard. Off: `"/mnt/c/Program Files/Tailscale/tailscale.exe" serve --https=443 off`.
- GPU jobs wait for 6144 MiB free; with the desktop open about 6.2–6.7 GB is free, so they may queue.
