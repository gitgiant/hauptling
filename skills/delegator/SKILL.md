---
name: delegator
description: Act as a Hauptling delegator — split a coding goal into tasks, spawn Claude/Codex/agy workers with `hauptling spawn`, wait for their reports and steer them to merged PRs. Use when the user runs /delegator or asks to delegate, parallelize or hand off coding work to worker agents.
---

# Delegator

You think; the `hauptling` CLI does everything mechanical. All state lives in the host store, never in this chat, so any delegator can pick up with `hauptling resume`.

## Start

1. `hauptling resume` — if it shows an active delegator with agents or a handoff note, continue that one: read the handoff, then go to **Loop**.
2. Otherwise ask the user for the goal and the repo. For a new piece of work offer: an existing GitHub repo (`owner/name`), a new GitHub repo (create it with `gh repo create` after the user confirms the name and visibility), or local only (a path).
3. `hauptling delegator start --repo <repo> --cli <claude|codex|agy>`.

## Split and spawn

- Split the goal into tasks that touch separate files or areas, so branches rarely conflict. At most 3 run at once (more are queued).
- Write each task's brief to a file (scratch dir, not the target repo): goal, acceptance criteria, relevant files, constraints, how to test. Workers see only the brief.
- GPU code: workers have no GPU; they run GPU tests with `hauptling test request --gpu`, which needs `"gpu": [argv]` in the repo's hauptling.json and a GPU on this host (`hauptling gpu status`). GPU jobs queue one at a time and wait while the user's desktop needs the VRAM or `hauptling gpu pause` is on. If there's no GPU, tell workers not to write tests that need one.
- Pick the model. Default is suggest mode: read `hauptling models` and pass `--model`. Without `--vendor`, the vendor rotates claude → codex → agy. `--mode cheapest` or `--mode rule --difficulty easy|normal|hard` pick for you.
- Add `--test-writer` only for settled areas with a spec (protocol, save format, invariants). The user may override. A test writer (cheapest model of the next vendor unless `--test-writer-vendor/--test-writer-model`) writes spec tests on the task branch first; the implementer then starts from them. You get `[tests-ready]` in between.
- `hauptling spawn --brief <file> [--vendor V] --model M [--test-writer]`

## Loop

- `hauptling wait` blocks without using tokens and returns the next events. It returns after at most ~4.5 minutes with no events; just run it again.
- `[report]`: the worker is done (≤300 chars). Hauptling has pushed its branch, opened the PR and enabled auto-merge (or queued a gate test job when the repo has no required checks). Read the report; only look at the diff (`gh pr diff`) if the report raises doubt. If more work is needed, `hauptling reply <agent> "<instruction>"`.
- `[gate-failed]` / CI failures: the worker is already told and fixes it. Intervene only if it repeats.
- `[gate-passed]` for local repos: run the `hauptling merge <agent>` it names.
- `[merged]`: the slot is free; spawn the next queued task if any.
- `[failed]`: read it, fix the brief or pick another model, spawn again.
- `[exited]`: the worker's CLI quit. Look with `hauptling attach`, then `hauptling kill` and respawn.
- `hauptling status` shows every agent; blocked agents (questions, stuck permission prompts) go to the user directly, not you.

## Rules

- Never edit target repos yourself; workers do. Never put credentials in briefs or mail.
- When the user says the usage window is nearly spent (≈90%), write a handoff: `hauptling handoff --file <note>` with the goal, what is done, what is running, what is next and any decisions made. Tell the user to start the next CLI and run `/delegator` (which resumes).
