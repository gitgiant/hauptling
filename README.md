# hauptling

Delegates coding tasks to Claude, Codex and agy (Antigravity CLI) workers. Design: [PRD.md](PRD.md). Phase 1 (local first, workers in WSL) is implemented.

## Install

Runs on a Linux host: Ubuntu, or WSL on Windows (Windows is just an Ubuntu host here).

```sh
git clone https://github.com/gitgiant/hauptling && cd hauptling
./install.sh          # Windows: install.cmd, which runs install.sh inside WSL
```

`install.sh` installs Node 22 if needed and runs `hauptling setup`, which does everything and is safe to rerun:

1. `/delegator` skill for Claude, Codex and agy; your git identity (copied from Windows git on WSL if missing).
2. Host (asks for sudo once): git, gh, Docker Engine (started at WSL boot / by systemd), hauptling on PATH.
3. Worker image `hauptling-worker` (first build takes a few minutes), internal network `hauptling-int`, egress proxy `hauptling-egress`.
4. Broker restart.
5. Sign-in: asks, slot by slot, for every vendor without credentials (stored in `~/.hauptling/slots/<slot>/`, kept across containers).
6. `hauptling doctor`.

Options: `--slots N`, `--vendors claude,codex`, `--no-login`, `--no-host`. Also `gh auth login` once for GitHub repos.

Workers run in a fresh container per task. Extra toolchains for a repo: add `hauptling.Dockerfile` at its root:

```dockerfile
ARG BASE=hauptling-worker
FROM ${BASE}
USER root
RUN apt-get update && apt-get install -y --no-install-recommends cargo
```

Containers reach only hosts in `~/.hauptling/egress/allow.txt` (blocked attempts: `~/.hauptling/egress/egress.log`). After updating hauptling, restart the broker (`hauptling broker restart`) and rebuild the image (`hauptling image`, also done by setup).

Then start Claude, Codex or agy in that Linux shell and run `/delegator`.

## Pieces

- `bin/hauptling.mjs` — CLI (`hauptling help`).
- `src/server.mjs`, `src/core.mjs` — broker: sole owner of `~/.hauptling/hauptling.db`, HTTP on 127.0.0.1, per-agent tokens, answer page for questions.
- `src/hub.mjs`, `src/satellite.mjs` — several hosts (PRD "Several hosts"): the hub's `/hub/*` endpoints for satellites, and a satellite broker's outbound link (`hauptling hub token`, `hauptling satellite join|list|revoke`).
- `src/docker.mjs` — worker containers: image build, per-slot credentials, internal network, tmux inside, test-job containers.
- `src/egress.mjs` — egress proxy (allowlist) and broker relay, run in the `hauptling-egress` container.
- `src/platform/` — host seam (notifications).
- `src/mail.mjs` — machine-wide mailbox (ported from nullpunkt).
- `src/vendors.mjs` — user-level hooks and trust for each vendor, hook I/O formats.
- `src/dashboard.mjs`, `src/dbquery.mjs`, `web/dashboard/` — the dashboard (`hauptling dashboard`): live board over SSE, agent terminal/diff/events, actions, Usage tab (accounts, sign-in, spend), read-only SQLite explorer. Served by the broker on 127.0.0.1 only.
- `src/terminal.mjs` — web terminal sessions without a pty: `tmux capture-pane -e` frames, `send-keys` input (off by default, 10 min idle timeout); vendor sign-ins run in host tmux.
- `src/keys.mjs` — optional API keys (`hauptling key set|rm|list`): one key per vendor for every slot instead of per-slot sign-ins; billed per token.
- `src/usage.mjs` — usage normalizers: Claude/agy status line (`hauptling usage <vendor>`), Codex session logs.
- `src/runner.mjs`, `src/detect.mjs`, `src/junit.mjs` — deterministic test jobs (inside a test container; GPU jobs get `--gpus all`, see `hauptling gpu status|pause|resume`).
- `src/github.mjs` — PRs and merges via the host `gh` login.
- `models.json` — shipped defaults; override in `~/.hauptling/models.json`.

Tests: `npm test`.
