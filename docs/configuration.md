# Configuration

A project's configuration is `.helix/config.yaml`.
`helix-loop init` writes it; `helix-loop config` reads and changes it with checks, and the app's Settings edits it as change sets.
Every change is checked as the loop loads the file, keeps its comments, and is committed.
The loop reads it when it starts; restart the loop for a change to take effect.

## project

```yaml
project:
  name: Acme Notes        # the product, as the app, Helix and the documents call it
  owner: Sam              # who steers the loop and does its human tasks
  timezone: America/Chicago
```

## repos

The repositories the loop builds, one lane each, cloned in `.helix/repos/<name>`.

```yaml
repos:
  acme-app: { gate: pnpm run gate, prepare: "pnpm install --frozen-lockfile --prefer-offline" }
```

- **gate:** the repository's full check: typecheck, lint, every test. A pass merges into `main` only when it passes, and only the work it saw is merged.
- **prepare:** run in a fresh worktree before the agent starts, outside its sandbox, so installs are ready.

## agents

```yaml
agents:
  claude:
    enabled: true
    slots: 1                 # passes at once
    weekly_target: 0.85      # the share of the subscription's week to have used by its reset: leave some for yourself
    command: claude
    models:                  # per role: build (most tasks), design (art and animation), plan and review (Helix)
      build: { model: claude-opus-5-5, effort: high }
    allow: ["Bash(FLAGS=all-on pnpm:*)"]   # more commands a Claude Code pass may run (a variable in front needs one)
  codex: { ... }
```

## limits

| Key | What it limits |
| --- | --- |
| `pass_timeout_minutes`, `gate_timeout_minutes` | how long a pass, and its gate, may take |
| `concurrent_gates` | gates running at once, across passes (they are heavy) |
| `prompt_budget_bytes` | a pass's prompt; a task citing too much of the spec fails validation |
| `agents_md_budget_bytes` | a repository's `AGENTS.md`, read on every pass |
| `max_attempts`, `max_conflicts` | failures, and merge conflicts, before a task goes to a person |
| `daily_budget_usd` | notional list-price spend per agent per day: a cap on a runaway |

## Paths an agent may not change

- `forbidden_paths`: refused at the gate (`.env` files, keys, agent settings); `forbidden_exceptions` lets some through (`.env.example`).
- `restricted_paths`: changed only by tasks in a given area, such as CI workflows by the `ci` area.

## Merging

- `push`: push `main` to its origin after each merge.
- `union_merge_paths`: files many tasks append to, merged keeping both sides.
- `relock`: lockfiles a rebase regenerates when they are all that conflicts, and how.
- `json_merge`: manifests merged key by key when they conflict, and how to format them after.

## release

```yaml
release:
  every_merged_tasks: 150          # a release tag per repo every N merged tasks, and when a stage closes
  review_paths: [".github/**", "infra/**"]   # a release changing these waits for `helix-loop release approve`
  hold_until: { acme-website: HT-25 }        # a repo's releases wait for a human task
```

## Helix, pilot mode and feedback

```yaml
helix:
  monitor: { enabled: false, level: light, agent: claude, daily_budget_usd: 5 }
pilot: { mode: active, active_level: prudent, auto_level: intrepid, record: true }
feedback: { ... }      # where each kind of builder report goes; Settings › Builder feedback edits it
```

See [concepts](concepts.md#helix) for what the monitor does at each level, and what pilot mode lets Helix decide.

## The rest

- `app.port`: the app's port on 127.0.0.1 (47320).
- `e2e_runner`: browser tests for sandboxed agents, run outside the sandbox on the loop's behalf.
- `agent_network`: the hosts a sandboxed Claude Code pass may reach, and the folders outside its worktree it may write.
- `notify.macos`: a macOS notification when the loop needs you or stops.
- `metrics_every_passes`: a new version of the metrics page every N passes.
- `env_prefix`: the prefix of the variables the loop sets for a repository's scripts (`<PREFIX>_GATE_ID`, `<PREFIX>_E2E_CLIENT`); `HELIX_` names are always set too.
- `git_author`: who the loop's own commits and release tags are by.
