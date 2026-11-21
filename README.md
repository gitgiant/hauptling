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
2. Workers (asks for sudo once): git, tmux, gh, vendor CLIs, hauptling on PATH, users `hl-w1…` and `hl-test`, a sudoers rule letting you act as them.
3. Broker restart.
4. Sign-in: asks, slot by slot, for every vendor without credentials.
5. `hauptling doctor`.

Options: `--slots N`, `--vendors claude,codex`, `--no-login`, `--no-workers`. Also `gh auth login` once for GitHub repos.

Then start Claude, Codex or agy in that Linux shell and run `/delegator`.

## Pieces

- `bin/hauptling.mjs` — CLI (`hauptling help`).
- `src/server.mjs`, `src/core.mjs` — broker: sole owner of `~/.hauptling/hauptling.db`, HTTP on 127.0.0.1, per-agent tokens, answer page for questions.
- `src/platform/` — host seam; `linux.mjs` runs workers as local users via sudo + tmux and sends notifications. Phase 2 adds the VM.
- `src/mail.mjs` — machine-wide mailbox (ported from nullpunkt).
- `src/vendors.mjs` — user-level hooks and trust for each vendor, hook I/O formats.
- `src/runner.mjs`, `src/detect.mjs`, `src/junit.mjs` — deterministic test jobs as `hl-test`.
- `src/github.mjs` — PRs and merges via the host `gh` login.
- `models.json` — shipped defaults; override in `~/.hauptling/models.json`.

Tests: `npm test`.
