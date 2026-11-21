# PRD: Hauptling agent delegator

Status: design agreed 2026-11-20 (grill-me interview). Phase 1 decisions settled 2026-11-20 (second interview, see Phases); phase 1 in progress. Living copy: https://claude.ai/artifact/YbwvdtdzM8JuvEagKG1Xh4

Hauptling delegates coding tasks to Claude, Codex and agy (Antigravity CLI) agents running in disposable containers, across any repo.

## Shape

- **/delegator is a skill** (`SKILL.md` installed user-level in `~/.agents/skills/` and `~/.claude/skills/` by `hauptling setup`), launched in Claude, Codex or agy. The agent in that CLI is the delegator and does the thinking: split, pick models, read reports.
- **`hauptling` Node CLI** is its toolbelt for everything mechanical: spawn, mailbox, status, test jobs, GPU lease, handoff, containers.
- **All state lives in the host store** (SQLite at `~/.hauptling/hauptling.db`, owned only by the host broker), never in a chat. Any delegator can `hauptling resume`.
- Separate repo, used across repos. New `/delegator` offers: existing GitHub repo, create a new one, or local only.

## Topology

- **Everything runs on one Linux host**: Ubuntu, or WSL on Windows (Windows is treated exactly like an Ubuntu host). Delegator CLI there, never in auto mode.
- **Workers run in Docker containers**: a fresh container per task from the golden image, removed when the task ends (phase 2; phase 1 used local Linux users).
- **Max 3 concurrent agents** per delegator by default.
- No revert step: every task starts from the image. The task's clone lives on the host (`~/.hauptling/work/<agent>`) until cleanup.

## Mailbox

- Code **moves from nullpunkt** (`scripts/mailbox.mjs`, `scripts/coagent/*`, `docs/coagent-mailbox.md`) **into hauptling**; nullpunkt depends on it.
- Store stays per machine. The **host broker** serves the CLI on 127.0.0.1 and containers through the egress proxy's relay.
- Add the `agy` family alongside `claude` and `codex`. One machine-wide mailbox; repo is a status field.
- **One wake path for all vendors**: hooks deliver mail while an agent works; `tmux send-keys` wakes it when idle. The Claude MCP dev channel and `codex queue` are dropped.
- nullpunkt drops `scripts/mailbox.mjs` and `scripts/coagent/`; its docs call `hauptling mail` directly.

## Workers

- **Interactive TUI inside tmux** in the container, so you can attach (`docker exec -it … tmux attach`). Status comes from hooks (all three CLIs have SessionStart, PostToolUse, Stop).
- Auto mode on in the container (default).
- **Blocked agents ask you directly**: `hauptling ask "q" --choice A --choice B` sets status `blocked: <question>` and notifies you (a Windows toast on WSL, `notify-send` elsewhere) with up to 4 choice buttons plus "Other…". Buttons open the broker's local answer page (nonce-keyed, has a free-text box). The dashboard blinks; `hauptling reply` and `hauptling attach` also work. The delegator only gets the 300-char final report.
- **No tester agent.** The implementer writes and fixes its own tests; deterministic test jobs run them. Opt-in `--test-writer` per task adds a spec-based test writer for settled areas (protocol, save format, invariants).
- Delegator decides whether a task gets `--test-writer`; you can override.

## Models

- Editable **`models.json`** per vendor: cheapest and rule-of-thumb modes read it directly; suggest mode (default) reasons over it.
- **Round robin rotates the vendor** (claude, codex, agy, claude...); the mode picks that vendor's model.

## Tests and GPU

- `hauptling test request --sha --selector [--gpu] [--artifacts] [--timeout]` returns `req_id`.
- `hauptling test wait <req_id>` blocks at zero tokens.
- `hauptling test report <req_id> report.json`.
- Request: `{id, from, sha, branch, selector, gpu, artifacts[], timeout_s, round}`.
- Report: `{id, sha, status: pass|fail|error|timeout, passed, failed, skipped, duration_s, failures:[{test_id, loc, message ≤300, excerpt ≤20 lines}], artifacts, log_path, notes ≤300}`.
- Reports for a different sha are rejected. Round 4 sets the agent to `blocked`.
- **GPU tests run on a deterministic host runner, no LLM.** It checks out the sha in a host worktree, runs the repo's declared GPU command, and holds a lease lock released in `finally`.

## Git

- **Default: own branch, PR, auto-merge when checks pass.** Push to main is a per-repo opt-in.
- Workers never touch GitHub: on `hauptling report` the host broker pushes the branch, opens the PR with your host `gh` login and enables auto-merge. Repos without required checks get a hauptling test job as the gate; the broker merges on pass.
- Local-only mode: branches, delegator merges when tests pass.

## Usage and handoff

- At **90% of a usage window**, you tell the delegator to hand off (manual for now); it runs `hauptling handoff`, you start the next CLI and run `hauptling resume`.

## Dashboard

- **Localhost, served by the host broker**, random access token; remote access via Tailscale only.
- Per agent: status (spin working, blink blocked), attach button (web tty on localhost), log, diff, branch, PR and CI state, last test report, elapsed time, tokens, cost $, context %, model, GPU lease holder, kill.
- **Vendors panel**: signed-in and auto-mode state for each vendor, usage % and reset time, sign-in button that opens the login in a slot container.
- Data: Claude statusline gives cost, context, model, 5h and 7d limits. Codex statusline and `/status` give limits; cost is estimated from `models.json`. agy usage is read from `/usage` (see below). Subscription cost is an API-equivalent estimate.

## Security

- **Container egress allowlist**: containers sit on an internal Docker network with no route out; a hauptling egress proxy (domain allowlist in `~/.hauptling/egress-allow.txt`, blocked hosts logged) is the only exit: vendor APIs and sign-in, GitHub, package registries.
- **Credentials in a per-slot directory** (`~/.hauptling/slots/<slot>/`: Claude, Codex and agy config dirs) mounted into each fresh container, so containers stay signed in and fresh images never roll back rotated refresh tokens. One container per slot at a time.
- **GitHub**: host `gh` login does pushes, PRs and merges; workers hold no GitHub credentials. Main protected.
- **Broker**: containers reach it only through the egress proxy's relay, with per-agent tokens that cannot call kill, merge or spawn.
- No credentials in mail or on the dashboard.

## agy (Antigravity CLI) specifics

Sources: https://antigravity.google/docs/cli/headless/, https://antigravity.google/docs/cli/reference/, https://antigravity.google/docs/cli/commands/resume/

- **Auto mode**: `--mode auto` (also `accept-edits`, `plan`) or `--dangerously-skip-permissions`.
- **Resume**: `agy -c` (latest in workspace) or `agy --conversation <id>`.
- **No way to inject into a running TUI.** Mail reaches agy through its hooks (PostToolUse, Stop) while working, and `tmux send-keys` to wake it when idle.
- **Avoid headless `-p` for work**: google-antigravity/antigravity-cli#1411 measured 2.5–7× more quota per turn because each process starts with a cold cache.
- **Usage**: `/usage` (alias `/quota`) and `/credits`. No documented machine-readable form; `agy --output-format json --print /usage` works per a user report, untested. Reset time only appears in quota error text, so the panel may show it as unknown.
- **Auth**: tokens in the OS secure keyring, settings in `~/.gemini/antigravity-cli/` (both on the creds disk). Headless runs need one interactive sign-in first; the only alternative is `GEMINI_API_KEY`.

## Phases

1. **Local first**: CLI, store, broker, mailbox, spawn/status/wait/report/ask, PR flow, non-GPU test jobs, models, skill. Workers in WSL.
2. Containers: golden image, per-repo image, egress proxy, per-slot credentials.
3. GPU runner and lease.
4. Dashboard (includes a SQLite DB explorer).

Phases 2–4 get their own grill at phase start.

### Phase 2 decisions (2026-11-21)

- **Isolation: Docker containers, not VirtualBox.** Hyper-V is on here (VirtualBox would run slowly), RAM is 16 GB, and containers run natively on Ubuntu/WSL (Docker Desktop or colima on macOS later).
- **Runtime**: Docker Engine installed by setup; started at WSL boot via `/etc/wsl.conf` (no systemd needed), `systemctl` on Ubuntu hosts. You join the `docker` group.
- **Lifecycle**: fresh container per task (`--init`, `sleep infinity`, tmux inside), removed at cleanup. Limits default to 2.5 GB RAM and 3 CPUs (`~/.hauptling/config.json`).
- **Image**: `hauptling-worker` (Ubuntu 24.04, Node 22 + pnpm, git, tmux, python3, build-essential, the three vendor CLIs, hauptling), tagged by content hash. A repo may add `hauptling.Dockerfile` (`FROM hauptling-worker`), built and cached by hash. Test jobs run in the same image.
- **Workdir**: the broker clones each task on the host into `~/.hauptling/work/<agent>` and bind-mounts it at `/work`; commits, pushes and PRs stay host-side. Containers run as your uid.
- **Slots**: a slot is a credentials directory plus the concurrency limit; the phase 1 host users (`hl-w1…`, `hl-test`) and sudoers rule are removed, their sign-ins migrated.
- **Network**: internal Docker network `hauptling-int`; the `hauptling-egress` container is the only exit (HTTPS CONNECT + plain HTTP, allowlist) and relays the broker port to the host.

### Phase 1 decisions

- **Code**: plain ESM `.mjs`, JSDoc, `node:test`, no build. Install: clone, then `install.sh` (Linux) or `install.cmd` (Windows, hands over to `install.sh` in WSL).
- **Broker**: sole owner of the SQLite store, auto-spawned detached by any `hauptling` command (`hauptling broker start|stop|status`), listening on 127.0.0.1. Workers' `hauptling` is an HTTP client with per-agent tokens. The broker acts as worker users through a sudoers rule limited to them. (An earlier design ran the broker on Windows with an SSH tunnel into WSL; dropped as brittle.)
- **Slots**: one Linux user per slot (`hl-w1`…), 3 per delegator by default (`hauptling setup --slots N`), plus `hl-test` for test jobs. Each slot signs in to each vendor once (`hauptling login <slot> <vendor>`). Hooks are user-level in each slot; target repos are never modified.
- **Spawn**: `hauptling spawn --brief brief.md [--vendor] [--model] [--repo] [--base] [--test-writer]` clones into the slot's home, makes the branch, starts the TUI in tmux and sends "Read your brief: <path>". The worker ends with `hauptling report "<≤300 chars>"`.
- **Delegator**: `hauptling wait` blocks (zero tokens) and returns the next event (report, blocked, test result, merged, failure).
- **After done**: the worker stays idle until its PR merges (CI failures wake it), then its tmux session, clone and slot are freed.
- **Tests**: `hauptling.json` in a target repo is optional; commands are auto-detected (`hauptling init` writes the detected config). Commands are argv arrays; results come from JUnit XML. Jobs run as `hl-test`.
- **models.json**: shipped default in the repo, `~/.hauptling/models.json` overrides; round-robin state in SQLite.
- **Test writer** (`--test-writer`): tests first. A test writer (cheapest model of the next vendor by default) writes spec tests from the brief alone on the task branch and reports (`[tests-ready]`); the implementer then starts from those commits and must not weaken them.
- **Stuck workers**: once a minute the broker checks each worker. A dead TUI → `exited` (event to the delegator). No hook activity for 10 min while not idle → `blocked` and one notification (says so when a vendor permission prompt is on screen); activity resumes → `working`.
- **pushToMain** (`hauptling.json`, GitHub repos): no PR; after the gate test passes the broker rebases onto base and pushes.
- **Vendor autonomy**: Claude `--permission-mode auto`; Codex `--sandbox danger-full-access --ask-for-approval never` inside the container (phase 2: the container is the sandbox, bubblewrap can't run in Docker; phase 1 used `workspace-write` + network). `report`/`test request` commit leftover changes for any worker; agy `--mode auto` with only `command(hauptling)` pre-approved. Workers run `hauptling report` as a command on its own.
- **Paths**: clones live on the Linux filesystem; hauptling on PATH links to the checkout; containers get their own copy baked into the image (`hauptling image` rebuilds when it changes). Local-only repos merge via `hauptling merge` after the test job passes.

## Turnkey deployment (goal)

After phase 1–4 work, standing up Hauptling on a **new host is one command**: clone, run the installer, sign in when asked, `doctor` passes. Hosts may be **Windows, Ubuntu or macOS**; only Windows is available for testing now.

Hosts are Linux; Windows runs everything in WSL. Platform-specific code sits behind `src/platform/` (one adapter, `linux`):

| Seam | Linux / WSL (done) | macOS (planned) |
|---|---|---|
| Installer | `install.sh` (`install.cmd` on Windows → WSL) | `install.sh` with Homebrew |
| Worker host | Docker Engine containers | Docker Desktop or colima |
| Notifications | Windows toast via interop on WSL, `notify-send` otherwise; both link to the answer page | `osascript` + answer page |

macOS stays untested until a Mac is available.

## Open

- Whether Claude, Codex and agy rotate refresh tokens (assumed yes).
