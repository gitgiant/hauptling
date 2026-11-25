# Handoff — 2026-11-24

State of Hauptling after the session that finished phases 3, 4a and 4b. Read `PRD.md` for the design (every decision is recorded there under **Phases**); this file is what the PRD doesn't say: what's verified, what isn't, and what tripped us up.

## Where things stand

All four PRD phases are built and on `main` (`a84b0bd`), plus two follow-ups:

| Piece | Status |
|---|---|
| 1. Local-first toolbelt | done (earlier session) |
| 2. Workers in Docker containers | done (earlier session) |
| 3. GPU test jobs | done, **verified on the real RTX 2070 SUPER** |
| 4a. Dashboard (board, detail, actions, SQLite explorer) | done, verified live + headless-Edge screenshots |
| 4b. Usage, web terminal, Usage tab | done; parts verified live (see below) |
| Sign-in lock while a worker runs | done |
| API keys instead of per-slot sign-ins | done; no real key tried |

Tests: `npm test` — 35 pass (about 30 s; the SQLite-timeout test waits 2 s). `hauptling doctor` is all good on this machine.

## Verified vs. not

Verified live on this machine:
- GPU job through the broker in a `--gpus all` container (`t_4f2921c3`).
- Dashboard routes, sign-in cookie, `docker0` → 403, Tailscale access, actions with an Origin header through the proxy.
- Codex usage reader on a real `hl-w1` rollout log; `hauptling usage claude` against a broker (status text, stored usage, `usage-high` event, email dropped).
- Web terminal against a fake worker container (frames with colour, input off → refused, on → reaches the program); host-tmux login session with a stand-in program; ANSI renderer on a real captured frame.
- `codex login --with-api-key` writes `{auth_mode: "apikey", OPENAI_API_KEY}` (what `prepare` checks).

**Not yet seen working for real** (each needs a real worker run, which costs tokens):
- A real worker reporting usage through its status line. Only workers started after phase 4b have it.
- A real "Sign in" click on the Usage tab (runs the vendor's login in host tmux).
- The Terminal tab rendering live in a real browser (its parts are tested; headless screenshots fire before data arrives).
- A worker on an API key. For Claude, check the TUI header shows API billing. For agy, which of `GEMINI_API_KEY` and its OAuth sign-in wins is unknown.
- `pause --now`, the VRAM wait and `gateGpu` on the real GPU (unit-tested only).

## Open items

- **Codex prices** in `models.json` are `null` → Codex cost shows "unknown". Fill `usd_in`/`usd_out`.
- **agy's own sign-in token rotation** is unconfirmed (Claude and Codex rotate; see PRD "Open").
- **macOS / Ubuntu turnkey install** is a goal only (PRD "Turnkey deployment"); only WSL is tested.
- **CLI gap:** `hauptling test request` from your own terminal accepts an empty `--sha` (it then swallows the next flag as the sha, e.g. `--gpu`) and fails later at checkout. Pre-existing; validate up front.
- `hauptling dashboard --print` always prints the `127.0.0.1` link; for Tailscale you swap the host by hand. A `--host` flag would help.
- Old feature branches (`phase-1`, `phase-3`, `phase-4`, `phase-4b`, `signin-guard`, `api-keys`) are all merged into `main` and can be deleted locally and on GitHub.

## This machine

- WSL2 Ubuntu (systemd off), Docker Engine with the NVIDIA runtime, RTX 2070 SUPER 8 GB (≈6.2–6.7 GB free with the desktop open; GPU jobs wait for 6144 MiB by default).
- Slots `hl-w1..3`, each signed in to claude, codex and agy (9 sign-ins). No API keys set.
- Broker on `127.0.0.1:47800`. Dashboard: `hauptling dashboard`. **Tailscale serve is on** (Windows `tailscale.exe`): `https://old.tailff0f31.ts.net/` → the dashboard. Turn off with `"/mnt/c/Program Files/Tailscale/tailscale.exe" serve --https=443 off`.
- The worker image bakes in a copy of hauptling: after changing code that runs inside workers (`vendors.mjs` prepare, `runner.mjs`, the CLI), run `hauptling image` and restart the broker (`hauptling broker stop`; the next command restarts it).

## Gotchas learned

- **Docker on WSL won't (re)start from a shell** with a high open-files soft limit: `/etc/init.d/docker` runs `ulimit -Hn 524288` and aborts. `setup-host.sh` lowers the soft limit first; by hand: `(ulimit -Sn 1024; sudo service docker start)`.
- `sudo` needs a real terminal: `! hauptling setup` inside Claude Code fails at the password; run it in a WSL terminal.
- `node:sqlite` can't interrupt a query, and a worker thread stuck in SQLite can't be terminated: the dashboard's ad-hoc SQL runs in a child process that gets SIGKILLed.
- `pkill -f "<pattern>"` inside a bash command matches its own shell; kill by PID instead.
- Headless Edge (`msedge.exe --headless --screenshot`) works for screenshots from WSL; `--virtual-time-budget` hangs on pages with SSE; screenshots fire at load, so live data may not be there yet. Use a fresh `--user-data-dir` if a previous run hung.
- git here is old: no `git init -b`.
- Host tmux is 3.0a; the web terminal's login sessions use a private socket (`tmux -L hauptling`).

## Conventions

- Plain ESM `.mjs`, JSDoc, `node:test`, no build, no npm dependencies. The dashboard is vanilla JS (`web/dashboard/`).
- Work on a branch, fast-forward `main` when the user says "merge to main".
- Commits end with the `Co-Authored-By` and `Claude-Session` trailers the session gives.
- The user prefers design interviews **one question at a time** with a recommendation, answers tersely ("a", "b + c"), and records decisions in `PRD.md` before building.
