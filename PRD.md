# PRD: Hauptling agent delegator

Status: design agreed 2026-11-20 (grill-me interview). Nothing built yet. Living copy: https://claude.ai/artifact/YbwvdtdzM8JuvEagKG1Xh4

Hauptling delegates coding tasks to Claude, Codex and agy (Antigravity CLI) agents running in a snapshotted VM, across any repo.

## Shape

- **/delegator is a skill** (`SKILL.md` in `.agents/skills/` and `.claude/skills/`), launched in Claude, Codex or agy. The agent in that CLI is the delegator and does the thinking: split, pick models, read reports.
- **`hauptling` Node CLI** is its toolbelt for everything mechanical: spawn, mailbox, status, test jobs, GPU lease, handoff, VM control.
- **All state lives in the host store**, never in a chat. Any delegator can `hauptling resume`.
- Separate repo, used across repos. New `/delegator` offers: existing GitHub repo, create a new one, or local only.

## Topology

- **Delegator on the Windows host**, never in auto mode.
- **Workers in one shared VirtualBox Linux VM** per delegator session, each with its own worktree and Linux user. Per-task disposable VM is opt-in for risky work.
- **Max 3 concurrent agents** per delegator by default.
- **VM revert** to the golden snapshot when idle and nightly. Unpushed worktrees are lost on revert.
- Check: VirtualBox runs slower if WSL2, Docker Desktop or core isolation enable Hyper-V.

## Mailbox

- Code **moves from nullpunkt** (`scripts/mailbox.mjs`, `scripts/coagent/*`, `docs/coagent-mailbox.md`) **into hauptling**; nullpunkt depends on it.
- Store stays per machine. A **host broker** bridges host and VM over the host-only adapter and SSH.
- Add the `agy` family alongside `claude` and `codex`. Codex delivery (`codex queue`) runs inside the VM.

## Workers

- **Interactive TUI inside tmux**, so you can attach. Status comes from hooks (all three CLIs have SessionStart, PostToolUse, Stop).
- Auto mode on in the VM (default).
- **Blocked agents ask you directly**: status `blocked: <question>`, dashboard blinks, you attach or reply to its inbox. The delegator only gets the 300-char final report.
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
- Local-only mode: branches, delegator merges when tests pass.

## Usage and handoff

- At **90% of a usage window**, the delegator writes a handoff to the store; you start the next CLI and run `hauptling resume`.

## Dashboard

- **Localhost, served by the host broker**, random access token; remote access via Tailscale only.
- Per agent: status (spin working, blink blocked), attach button (web tty on localhost), log, diff, branch, PR and CI state, last test report, elapsed time, tokens, cost $, context %, model, GPU lease holder, kill and revert.
- **Vendors panel**: signed-in and auto-mode state for each vendor, usage % and reset time, sign-in button that opens the login in a VM tmux pane.
- Data: Claude statusline gives cost, context, model, 5h and 7d limits. Codex statusline and `/status` give limits; cost is estimated from `models.json`. agy usage is read from `/usage` (see below). Subscription cost is an API-equivalent estimate.

## Security

- **VM egress allowlist**: vendor APIs, GitHub, package registries.
- **Credentials on a persistent disk excluded from snapshots**, so reverts never roll back rotated refresh tokens. agy uses a headless gnome-keyring over D-Bus on that disk.
- **GitHub: fine-grained PAT per repo** (contents and PRs only), main protected.
- **Broker**: the VM reaches it only through the SSH tunnel and cannot call kill, revert or merge.
- No credentials in mail or on the dashboard.

## agy (Antigravity CLI) specifics

Sources: https://antigravity.google/docs/cli/headless/, https://antigravity.google/docs/cli/reference/, https://antigravity.google/docs/cli/commands/resume/

- **Auto mode**: `--mode auto` (also `accept-edits`, `plan`) or `--dangerously-skip-permissions`.
- **Resume**: `agy -c` (latest in workspace) or `agy --conversation <id>`.
- **No way to inject into a running TUI.** Mail reaches agy through its hooks (PostToolUse, Stop) while working, and `tmux send-keys` to wake it when idle.
- **Avoid headless `-p` for work**: google-antigravity/antigravity-cli#1411 measured 2.5–7× more quota per turn because each process starts with a cold cache.
- **Usage**: `/usage` (alias `/quota`) and `/credits`. No documented machine-readable form; `agy --output-format json --print /usage` works per a user report, untested. Reset time only appears in quota error text, so the panel may show it as unknown.
- **Auth**: tokens in the OS secure keyring, settings in `~/.gemini/antigravity-cli/` (both on the creds disk). Headless runs need one interactive sign-in first; the only alternative is `GEMINI_API_KEY`.

## Open

- Whether Claude, Codex and agy rotate refresh tokens (assumed yes).
