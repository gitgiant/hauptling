# PRD: Hauptling agent delegator

Status: design agreed 2026-11-20 (grill-me interview). Phases 1 and 2 done (decisions under Phases); phase 3 (GPU runner and lease) built and verified on the RTX 2070 SUPER 2026-11-24; phase 4a (dashboard) built 2026-11-24; 4b (usage, web terminal, vendors panel) built 2026-11-24. Token economy stages 1–2 built 2026-11-25 (stage 3 open). Model prices recorded 2026-11-25 from official standard API rates: OpenAI https://developers.openai.com/api/docs/pricing and https://developers.openai.com/api/docs/models/gpt-6-luna; Anthropic https://platform.claude.com/docs/en/about-claude/pricing; Google https://aistudio.google.com/docs/pricing. OpenAI cached-input rates are separate; Anthropic cached-input rates are separate and Haiku 5.5 costs more for prompts over 100k tokens; Google cached-input and storage rates are separate. Gemini 3.8 Flash rises from $0.75/$3.75 to $1.50/$7.50 per million input/output tokens on 2027-01-01; both Gemini 4 Neon models are $3/$15 per million tokens. Living copy: https://claude.ai/artifact/YbwvdtdzM8JuvEagKG1Xh4

Hauptling delegates coding tasks to Claude, Codex and agy (Antigravity CLI) agents running in disposable containers, across any repo.

## Shape

- **/delegator is a skill** (`SKILL.md` installed user-level in `~/.agents/skills/` and `~/.claude/skills/` by `hauptling setup`), launched in Claude, Codex or agy. The agent in that CLI is the delegator and does the thinking: split, pick models, read reports.
- **`hauptling` Node CLI** is its toolbelt for everything mechanical: spawn, mailbox, status, test jobs, GPU lease, handoff, containers.
- **All state lives in the host store** (SQLite at `~/.hauptling/hauptling.db`, owned only by the host broker), never in a chat. Any delegator can `hauptling resume`.
- **Several delegators at once** (2026-11-25): each session passes `--delegator <id>` on every delegator command (`spawn`, `wait`, `status`, `handoff`, `resume`); CLI env doesn't survive between an agent's shell calls, so it is a flag. Without the flag a command uses the one active delegator, and is refused when several are active (the error lists them). `hauptling delegator end [--delegator ID]` marks one ended (refused while it has live agents); the skill ends its delegator when the goal is done. `resume` without an id, with several active, lists them so the session picks by repo or asks the user.
- **A new session resumes only its own repo** (2026-11-25): `/delegator` first settles the repo (the one the user names, else the current directory's git repo, confirmed with the user), then runs `hauptling resume --repo <repo>`. That continues the active delegator for that repo (a local path also matches the GitHub `owner/name` of its `origin`), or reports none so the session starts a new one. It never picks up another repo's delegator.
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

- **Interactive TUI inside tmux** in the container, so you can attach (`docker exec -it … tmux attach`). Status comes from hooks (all three CLIs have SessionStart, PostToolUse, Stop). **Workers run only Hauptling's hooks** (2026-11-25): the image bakes them in as managed config, Claude `/etc/claude-code/managed-settings.json` with `allowManagedHooksOnly` (status line too) and Codex `/etc/codex/hooks.json` plus `allow_managed_hooks_only` in `/etc/codex/requirements.toml`, so a repo's own `.claude`/`.codex` hooks (its own mailbox, host paths) never run in a worker. Codex no longer gets `--dangerously-bypass-hook-trust`: managed hooks need no trust review. The repo's permissions, CLAUDE.md/AGENTS.md and skills still apply.
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
- Reports for a different sha are rejected. Round 3 sets the agent to `blocked` (was 4; token economy, 2026-11-25).
- **GPU tests run deterministically, no LLM**, in a fresh `--gpus all` test container, one at a time on their own queue (phase 3; an earlier design used a host worktree).

### Merge gate / test jobs (2026-11-25)

- **CPU jobs run in parallel**: up to `testConcurrency` at once (host `config.json`, default 2), at most one per repo, FIFO otherwise (a repo whose job is running is skipped, not blocking the line). External runners (`test.claim`) follow the same one-per-repo rule. GPU jobs keep their single queue.
- **An agent that ends gives up its tests**: kill, PR closed, failed, merged or handed off cancels all its queued and running test jobs (gate and agent requests, CPU and GPU). Running ones get their `hauptling-test-<id>` container stopped. Same path as a newer report superseding older gates: the job is marked done with status `cancelled`, never reaches the gate logic, emits no gate event; a late result is discarded. PR polling cancels outstanding jobs when it detects an external merge. At startup, queued and running jobs of killed, merged, failed, closed, handed-off or exited agents are cancelled before remaining running jobs are requeued.
- **Dashboard**: the header's GPU area shows CPU tests (running/limit, each running job's agent, repo and elapsed time, number queued). A queued job's headline gives its place in its queue ("Merge gate queued, 2nd in line"); "Running merge gate" once it runs.
- **Run now**: a queued CPU job shows a "Run now" button (card and detail); it starts the job at once, past the concurrency limit and the one-per-repo rule. POST-only dashboard action (`test.run`, like kill), admin only, queued jobs only. Not for GPU jobs: those share one GPU and use the GPU queue controls.

## Git

- **Default: own branch, PR, auto-merge when checks pass.** Push to main is a per-repo opt-in.
- Workers never touch GitHub: on `hauptling report` the host broker pushes the branch, opens the PR with your host `gh` login and enables auto-merge. Repos without required checks get a hauptling test job as the gate; the broker merges on pass.
- Local-only mode: branches, delegator merges when tests pass.

## Usage and handoff

- At **85% of the delegator's own vendor window** `wait` returns `[handoff-due]` (token economy stage 2; you can still ask earlier); it runs `hauptling handoff`, you start the next CLI and run `hauptling resume`.

## Dashboard

- **Localhost, served by the host broker**, random access token; remote access via Tailscale only.
- Per agent: status (spin working, blink blocked), attach button (web tty on localhost), log, diff, branch, PR and CI state, last test report, elapsed time, tokens, cost $, context %, model, GPU lease holder, kill.
- **Vendors panel**: signed-in and auto-mode state for each vendor, usage % and reset time, sign-in button that opens the login in a slot container.
- Data: Claude statusline gives cost, context, model, 5h and 7d limits. Codex statusline and `/status` give limits; cost is estimated from `models.json`. agy usage is read from `/usage` (see below). Subscription cost is an API-equivalent estimate.

### Dashboard layout (2026-11-25)

- **Split views** (Board | Detail, History | detail, DB tables | main) fill the viewport below the header (`100dvh - --header-h`); each pane scrolls on its own. A splitter between the panes drags with pointer events (mouse, touch, pen); it is focusable, `role="separator"` with `aria-valuenow` (first pane, %), and arrow keys move it (Shift: bigger steps, Home/End: limits). Each pane keeps a minimum size. The size is a fraction of the view, kept in `localStorage` per view and orientation; double-click resets it.
- **Stacked when portrait or narrow** (`max-width: 800px` or portrait): list above, detail below, and the splitter resizes heights.
- **Hideable header**: a horizontal splitter along the header's bottom edge (looks and behaves like the pane splitters: 1rem band, grip, accent on hover/focus, `role="separator"`) hides and shows it: drag up past about a third of its height or flick up to collapse, drag down or flick down to restore; click, double-click or Enter/Space toggle; Up/Down collapse/expand. Collapsed, the bar stays at the top edge. The open header can also be dragged up by its background (not on buttons, links or inputs). Collapsed state is in `localStorage`. `--header-h` (header + bar, from a ResizeObserver) is what the layout uses. No slide animation under `prefers-reduced-motion`.
- **Compact header**: one row whenever it fits; as width shrinks it degrades in steps, measured on the live header rather than by breakpoints: drop sparklines, then shorten labels ("GPU busy 88%" → "GPU 88%", live/theme as icons), then hide GPU and test-job details behind a ⋯ popover (tooltip too); when even that overflows (phones), two rows: title, tabs, live dot and theme, then one sideways-scrolling strip of usage chips, CPU, Mem and GPU. Returning to a fuller step needs 12 px to spare, so ticking numbers can't make it flip.
- **Ultrawide**: board cards flow into columns (min 24rem each) instead of stretching; long text in the detail is capped at 110ch; the Usage view is capped at 110rem and centred.
- **Vendor badges**: a small own-design badge (coloured tile, letter C / X / G; grey "?" if unknown) sits before every agent id on Board cards, the detail title meta and History; table in `web/dashboard/vendors.js`, colours are CSS variables per theme.
- **Collapsible Board groups**: each delegator group heading (delegator · repo) is a toggle (`aria-expanded`, a large caret). Collapsed, the group shows only its agents' status dots (tooltip = id and state; click selects). Remembered per group in `localStorage` (`hl-groups-shut`).
- Pure logic (clamping, keyboard steps, collapse threshold, header degrade step, handle keys) lives in `web/dashboard/layout.js`, unit-tested with `node:test`.

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

### Phase 4 decisions (2026-11-24)

- **Split**: 4a is a live board over data the broker already has. 4b (own grill) adds usage collection (tokens, cost, context %, 5h/7d limits), the web terminal and the vendors panel with sign-in.
- **Build**: one static HTML file plus vanilla JS modules served by the broker on its port; live updates over Server-Sent Events. No framework, no build, no dependencies.
- **Auth**: a dashboard token separate from the admin API token. `hauptling dashboard` opens `/?k=<token>`; the broker swaps it for an `HttpOnly; SameSite=Strict` cookie and redirects. Requests arriving on `docker0` are refused; actions are POST only with a custom header. `--new-token` rotates it. Remote access via `tailscale serve`.
- **Actions**: answer a blocked question inline, reply, kill (with confirm), merge local-only repos, `gpu pause | pause --now | resume`. No spawning (that's the delegator's job).
- **Agent detail**: terminal tab first (the web terminal; the read-only Screen mirror was dropped 2026-11-25 as redundant with it); diff tab (`base...HEAD` plus uncommitted, stat + per file); events tab (events, mail, asks, test jobs).
- **SQLite explorer**: browse with paging, sort and filter, plus ad-hoc `SELECT` on a read-only connection (1000 rows, 2 s). `token` and `nonce` values are masked wherever they appear, so aliases don't leak them.
- **Board**: agents of active delegators grouped by delegator and repo; active delegators with no agents on the Board get a collapsible group after groups with agents, showing when the delegator started and whether a handoff note is waiting. Ending a delegator removes its groups from the Board. The board snapshot and SSE event include each active delegator’s id, repo, CLI, creation time and handoff flag. Blocked agents sort first and blink, and their count appears in the tab title. The dashboard also has a collapsible "recent" section (24 h), a searchable history tab and a GPU queue panel. Host CPU % and memory % sit beside the GPU panel in the header, from Node's `os` (on WSL that is the WSL VM, where the containers run), with GPU utilization (`nvidia-smi`) in the GPU panel; each has a small line graph of the last 10 min. The broker samples every 5 s from the first dashboard visit on and pushes a `host` SSE event, so the board doesn't re-render. Rows show the agent id (it already names vendor and model; branch is `hl/<id>`, both on hover and in the detail pane), PR/CI, last test report, elapsed time. Each row leads with a **headline** for the human watching: a plain sentence the broker derives from state, open ask, latest test, gate and PR ("Needs your answer: …", "Running merge gate", "PR #12 open, waiting for CI", "Ready to merge into main"), no model tokens; the spawn title (usually the first line of the prompt) sits beneath it, muted. The detail pane shows the same headline under its title.
- **Notifications**: the answer page stays the one-click path; it and notifications gain an "Open dashboard" link. `hauptling dashboard [--print]` opens or prints the URL; `doctor` checks it's served.
- **Layout**: board on the left, agent detail on the right; stacks on a phone.
- **Theme**: dark by default; a header toggle switches to light, remembered per browser (`localStorage`).

### Phase 4b decisions (2026-11-24)

- **Web terminal**: watch-only by default; a per-agent "Enable input" switch turns itself off after 10 min without typing.
- **Transport, no pty**: while someone watches, the broker polls `tmux capture-pane -e` ~5×/s and sends changed frames over SSE; the page renders the colour codes as HTML. Input goes through `tmux send-keys`. No new dependencies; ~200 ms lag.
- **Usage collection** (no model tokens: local files and commands only): Claude and agy get the slot's status line set to `hauptling usage <vendor>`, which forwards the JSON to the broker (agy quota arrives as *remaining* and is converted to *used*; its `email` field is dropped). Codex: the broker reads the last `token_count` event of the newest `sessions/**/rollout-*.jsonl` in the slot (format not stable upstream; a change shows `unknown` plus a log line). Cost comes from the vendor where reported, else from `models.json` prices, else `unknown`.
- **Limits** (5h and weekly belong to the vendor's account; one account per vendor, signed in on every slot, so a reading from any slot speaks for all — revised 2026-11-24): at 90% one notification plus a `usage-high` event to the delegator (vendor, window, reset time), once per window. At 100% new spawns of that vendor wait until the reset and round robin skips it. Running workers are left alone.
- **Vendors panel**: one card per vendor account: 5h/weekly used % and reset time (newest reading from any slot), sign-in state per slot. "Sign in" runs the login in host tmux with the slot's credentials dir (like `hauptling login`: OAuth callbacks reach the host, not containers), shown in the web terminal with input on; the panel rechecks when the CLI exits. `hauptling login …` stays as the fallback hint. **No Usage tab** (2026-11-25): the header carries one small chip per vendor (name plus tiny 5h and week bars, amber at 90%, red at 100%) and the 30-day spend, polled every 30 s; clicking it opens the usage page (vendor cards, spend tables) and clicking again returns to the board.
- **History**: latest usage per agent and per slot × vendor. An ended agent keeps its final tokens and cost; a Spend view totals per day, vendor and repo (API-equivalent estimates). No time series.
- **Agent rows** gain tokens, cost and context %; agent detail gains a Terminal tab.

### Phase 3 decisions (2026-11-24)

- **Where**: GPU jobs run in a fresh test container with `--gpus all`, same image (base or per-repo) and egress rules as CPU tests. Setup installs the NVIDIA Container Toolkit. (Replaces the host-worktree design: repo code is untrusted.)
- **Lease**: only GPU test jobs hold the GPU; workers reach it only through `hauptling test request --gpu`. No interactive worker lease.
- **Queues**: a GPU queue runs beside the CPU queue (one job each at a time). GPU jobs default to 6 GB RAM and 4 CPUs (`~/.hauptling/config.json`).
- **Command**: `hauptling.json` must declare `"gpu": [argv]` (same `{selector}`/`{junit}` placeholders as `"test"`); without it `--gpu` is rejected. No fallback to the test command, no auto-detection.
- **CUDA**: nothing added to `hauptling-worker`. Repos rely on wheels that bundle CUDA (PyTorch, JAX) or add it in `hauptling.Dockerfile`. `doctor` runs `nvidia-smi` in a throwaway `--gpus` container.
- **Shared desktop GPU**: before starting, the broker checks free VRAM (`nvidia-smi`) against 6 GB or the repo's `"gpuMemMB"`; if short it rechecks each minute and after 30 min reports `error: GPU busy`. `hauptling gpu pause|resume|status` holds the queue by hand. Waiting time doesn't count toward `timeout_s`.
- **Pause**: `gpu pause` lets the running job finish; `gpu pause --now` kills it and requeues it at the front without using a test round.
- **Broker restart** (both queues): on startup, leftover test containers are removed and `running` jobs are requeued at the front and rerun from scratch.
- **No GPU host**: setup detects `nvidia-smi`; without it the toolkit is skipped, `doctor` says "GPU: none (GPU tests disabled)" and `--gpu` fails fast with "no GPU on this host". `"gpu": false` in config disables it on a GPU host.
- **Merge gate**: CPU only by default. `"gateGpu": true` in `hauptling.json` adds the GPU command to the gate; while it waits the agent status shows `gate: waiting for GPU`.
- **Superseded gates** (2026-11-25): queuing a gate for an agent cancels its older gate jobs (other sha): `queued` ones are marked done with status `cancelled`; a `running` one is also killed via `killTestJob`, as `gpu pause --now` does. A cancelled gate never reaches `gateResult`, so it emits no `gate-passed`/`gate-failed` and merges nothing; only the gate for the agent's current sha can merge (`gateResult` still ignores a sha that isn't the agent's head).
- **Dead container** (dashboard): the `/screen` answer this covered went with the Screen tab (2026-11-25). The Terminal tab shows "No live session" for non-live states instead of opening a stream, and a stream whose captures keep failing (container gone) sends `end` after 5 errors.
- **Per-delegator merge settings** (2026-11-25): `delegators.gate` (default 1) and `delegators.automerge` (default 1); `hauptling delegator start --no-gate --no-automerge`, `hauptling delegator set --gate on|off --automerge on|off`, and "Gate on/off" / "Auto-merge on/off" buttons in the dashboard's group heading (POST-only `delegator.set`; a muted "no gate" / "manual merge" tag when off). **Gate off**: `report` queues no hauptling test job; GitHub repos merge the PR at once (with required checks: auto-merge as before, GitHub's rules apply; pushToMain: pushes), local repos merge as `hauptling merge` does; no `gate-*` events, `[merged]` as usual. Turning the gate off cancels the delegator's reported agents' queued/running gate jobs (same cancel path as superseding) and merges them; turning it on affects later reports only. **Auto-merge off**: after the gate (or the report, gate off) the broker does not merge; it emits `[ready]` and waits for `hauptling merge AGENT` or the dashboard's Merge button (`merge` now also works for GitHub PRs: needs a passing gate test unless the gate is off or GitHub's required checks gate it). Auto-merge on keeps today's behaviour, including local repos' `[gate-passed]` + manual `hauptling merge`.
- **Timeout**: GPU jobs keep the 1800 s default `timeout_s`.

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

## CodeGraph in workers (2026-11-25)

[CodeGraph](https://github.com/colbymchenry/codegraph) (local code graph, MCP tools `codegraph_explore`, `codegraph_node`) in every worker.

- **One index per repo, built by the broker**: a cache on the host (`~/.hauptling/codegraph/<repo>/`), built in full the first time a repo gets a worker, `codegraph sync`ed before each spawn. The index stores repo-relative paths and per-file content hashes, so a copy works in any clone: the broker copies it into the worker's clone at spawn and the worker's prepare runs `codegraph sync` (incremental; ~1 s measured on this repo). Not the delegator's job (mechanical), and never the user's checkout (`.codegraph-wsl/` there is the user's own).
- **On by default**; `"codegraph": false` in `hauptling.json` skips it for a repo (e.g. one too large to index).
- **Image**: the CLI is installed in the worker image with telemetry off (`CODEGRAPH_TELEMETRY=0`, and `--no-telemetry` on the server; it is on by default upstream). The cache is synced by the worker's own CLI before the agent starts and saved back from the clone, so the index format always matches the image and the host needs no install. Clones are on the container's Linux filesystem, so the server's live watcher keeps the index fresh while the worker edits.
- **Use**: MCP server instructions reach only the top-level session; a worker's own subagents (Explore etc.) don't get them and fall back to grep. So the instructions appended to every brief gain one line when CodeGraph is on: use `codegraph_explore`/`codegraph_node` to find code, and tell any subagent you start to use them too. Works for every vendor.
- **Repo MCP servers**: workers load only Hauptling's MCP servers (CodeGraph) by default, like hooks: a repo's `.mcp.json` usually points at host paths, and in a fresh clone it prompts for approval. `"mcp": ["name", …]` in `hauptling.json` allowlists repo servers known to work in a container.
- **Wiring, Claude**: `/etc/claude-code/managed-mcp.json`, which takes exclusive control: Claude loads only the servers it lists and ignores the repo's `.mcp.json` (no prompt; `claude mcp add` and `--mcp-config` are refused). The broker writes it per agent at spawn (CodeGraph, plus the repo servers named in `"mcp"`, their definitions copied from the repo's `.mcp.json`) and mounts it read-only into the agent's container, which is created per agent. Not baked into the image, since it differs per repo. Verified in a worker container (2026-11-25): no approval prompt, `claude mcp list` shows only CodeGraph (Connected), a repo `.mcp.json` server is ignored.
- **Codex and agy**: use the CLI (`codegraph explore`, `codegraph node` print what the MCP tools return), named in the brief line. No MCP wiring for them yet; whether either can exclude a repo's own MCP servers is still to check.
### Token economy decisions (2026-11-25)

Goal: subscription usage windows last longer. Workers first, then the delegator; hauptling's own mechanisms only (no conventions imposed on target repos). Measure alongside the first fixes.

- **Stage 1** (measurement + cheap fixes):
  - **Per-task totals**: at launch the agent stores its vendor's window readings (`usage_start`); its final tokens are already kept. The `[report]` event and the dashboard's agent detail add one line: tokens in/out, cost, how many points each window rose during the task (a window that reset mid-task shows no delta), test rounds used.
  - **Worker preamble**: `prompts/worker-rules.md`, put in front of every brief by the broker: read files in ranges, search before reading, keep command output short (`| tail`, `-q`), run only the tests touched, reports stay ≤300 chars.
  - **Bare worker CLI**: workers load no user MCP servers or plugins, only hauptling's hooks. Claude: the per-agent `managed-mcp.json` (see "CodeGraph in workers"; it already admits only Hauptling's servers, so the branch's `--strict-mcp-config` was dropped in the 2026-11-25 merge, as it could shut CodeGraph out) and every `enabledPlugins` entry set false in the slot's settings; hooks and status line stay managed in the image (see Workers). Codex: `-c mcp_servers={}` in its launch template. agy: unknown, open.
  - **Test-round cap**: round 3 (not 4) blocks the worker with a question to the user.
  - **Cheaper-model preference**: `"prefer": "cheap" | "balanced" | "best"` in `~/.hauptling/models.json` (shipped default `best`, i.e. no change) caps the tier spawn may use at 1, 2 or 3. A model above the cap is refused unless the spawn passes `--allow-tier`; `--mode rule` clamps to the cap; `cheapest` and test writers are unaffected. Set with `hauptling models prefer <value>` or the Usage tab's toggle; `hauptling models` prints it first so suggest mode reasons with it.
- **Stage 2**:
  - **Effort per tier**: `models.json` `effort` per tier (1 low, 2 medium, 3 high), passed through each vendor's `effortArgs` (Claude `--effort`, Codex `-c model_reasoning_effort="…"`; agy has none: its model ids carry it, and `--effort` for agy is refused). Precedence: `spawn --effort`, the model entry's `effort`, the tier default. Test writers get their model's default.
  - **Events-only wait (Claude delegators only)**: `hauptling wait --until-event` loops broker waits inside the CLI process until an event arrives; the skill runs it as a background command and Claude Code wakes on its exit; no empty-timeout turns. Codex and agy keep the ~4.5 min loop.
  - **Auto handoff**: at 85% of a window of the vendor the delegator's CLI runs on (`delegators.cli`), active delegators get one `[handoff-due]` event per window; the delegator writes the note. Readings come from the delegator's own CLI: `hauptling setup` points the host's Claude and agy status lines at `hauptling usage <vendor> --host` (the previous status-line command is kept in `~/.hauptling/statusline-prev.json` and chained, so its output still shows); a Codex delegator's windows come from the host's `~/.codex` session log. Host readings live in `host_usage`, apart from the slots' (the host may use another account) and don't affect routing. Until the host has reported for a vendor, slot readings of that vendor stand in (same-account assumption).
- **Stage 3**: **headroom-aware round robin**: skip vendors at ≥80% of any window (a reading whose `resets_at` has passed counts as free). All vendors ≥80%: new spawns stay queued with one notification; running workers continue.

## API keys (optional)

- `hauptling key set <vendor>` (key from stdin or a hidden prompt, never argv) stores one key in `~/.hauptling/keys/<vendor>` (600). It switches that vendor to API billing for **every** slot: keys don't rotate, so one key serves all slots and no per-slot sign-in is needed. `hauptling key rm <vendor>` switches back to the slots' sign-ins. Running workers keep what they started with.
- Claude: `ANTHROPIC_API_KEY`, pre-approved in the slot's `.claude.json` (`customApiKeyResponses`), onboarding marked done. Codex: `OPENAI_API_KEY` stored by `codex login --with-api-key` in a separate `CODEX_HOME` (`<slot>/codex-key`) so the slot's ChatGPT sign-in stays intact. agy: `GEMINI_API_KEY` (untested here which wins when an OAuth sign-in is also present).
- The usage page and `doctor` show "API key …abcd" for that vendor instead of per-slot sign-ins.
- **Monthly API budget (API first, then the plan)** (2026-11-25): `hauptling key budget <vendor> <usd> [--resets-on DAY]` (or `key set <vendor> --budget <usd>`) gives the key a monthly budget, e.g. free API credits. The key then no longer covers every slot: each spawn takes the API while this period's API spend is under **90%** of the budget, else the slots' sign-ins (which must stay signed in). Running API workers finish on the API; the 10% margin covers them, so spend rarely passes the budget. A worker can't switch billing mid-session, so they are never restarted. `key budget <vendor> off` returns to key-for-every-slot; `key rm` drops key and budget.
- Each agent records its billing (`api` or `plan`) at start. Period spend = sum of the reported cost of this vendor's `api` agents created since the last reset day (default the 1st, local time). Hauptling's own tally: an ordinary API key can't read the credit balance, and spend outside Hauptling isn't counted. An API spawn ignores the plan's 5h/week limits; a plan spawn waits for them as before.
- At 90% one notification and an `api-budget` event to the delegator, once per period. The header shows an "API $63/$100" chip, the vendor card the same plus the reset date; spawn output and agent rows say `api` or `plan`.

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

- Refresh token rotation (a refresh returns a new refresh token and invalidates the old one, so a second copy of a credential file gets silently signed out):
  - **Claude: yes** (reported 2026-11-24, not yet observed on a slot). Refreshes on a 401 and proactively up to 5 min before expiry; reusing an old refresh token fails with `invalid_grant`.
  - **Codex: yes** (reported 2026-11-24, not yet observed on a slot). Refreshing `auth.json` spends the old refresh token; a process or copy still holding it fails and needs a new sign-in. Restoring an old `auth.json` (backup, re-copy) has the same effect.
  - **agy: own Google sign-in unknown** (assumed yes). Its MCP OAuth tokens (`mcp_oauth_tokens.json`) do rotate, and concurrent agy processes sharing them collide: one rotates, the other reuses the old token, gets `invalid_grant`, and the file is cleared (reported 2026-11-24, from an Antigravity CLI issue).
  - Design consequences either way: each slot signs in on its own; credentials are never copied between slots; the slot dir is mounted, not copied, into containers so a refresh writes back to the one real file; one worker per slot at a time. Not yet guarded: a "Sign in again" on a slot whose worker is running (two processes refreshing one file).
