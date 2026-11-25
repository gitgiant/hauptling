# Handoff — 2026-11-24

All four PRD phases, the sign-in lock, API keys, the per-vendor usage page and the egress-proxy race fix are on `main`. `npm test` (39 on `cli-fixes`) and `hauptling doctor` pass.

## Needs a real run to confirm

- "Sign in" on the usage page (header usage chips) (vendor login in host tmux).
- Header CPU/Mem/GPU graphs and card headlines need a broker restart to go live; headlines unseen with real agents. Dark theme seen in a screenshot.
- The Terminal tab live in a browser (parts tested; headless screenshots fire before data arrives).
- A worker on an API key: Claude's TUI should show API billing; for agy, whether `GEMINI_API_KEY` or its OAuth sign-in wins is unknown.
- GPU `pause --now`, the VRAM wait and `gateGpu` on the real GPU (unit-tested only).

## Open

- Codex prices in `models.json` are `null`, so Codex cost shows "unknown".
- agy's own sign-in token rotation is unconfirmed (PRD "Open").
- macOS / Ubuntu install untested; only WSL so far.
- Merged branches to delete: `phase-1`, `phase-3`, `phase-4`, `phase-4b`, `signin-guard`, `api-keys`, `handoff-rule`, `usage-per-vendor`, `egress-race`.

## This machine now

- Slots `hl-w1..3` signed in to claude, codex and agy; no API keys set. Workers from a terrain task were running at handoff time (see the dashboard).
- Tailscale serve is on: `https://old.tailff0f31.ts.net/` → the dashboard. Off: `"/mnt/c/Program Files/Tailscale/tailscale.exe" serve --https=443 off`.
- GPU jobs wait for 6144 MiB free; with the desktop open about 6.2–6.7 GB is free, so they may queue.
