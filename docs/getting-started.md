# Getting started

This walks through a project from nothing to a running loop: Spec, then TaskSet, then Milestones, then the loop.
The [concepts](concepts.md) explain the words used here.

## 1. Install

You need Node 26 or later, git, and at least one of Claude Code and Codex, signed in with its subscription (`claude` then `/login`; `codex login`).
The loop refuses to run an agent on an API key: subscriptions are what make a long build affordable.

```sh
./scripts/install.sh      # from a checkout of Helix Loop
helix-loop doctor         # checks Node, git and the agents
```

## 2. Start a project

In your product's folder (a git repository of its own, holding the plan; the product's code lives in the repositories the loop builds):

```sh
helix-loop init
```

It asks for:

- the product's name, who steers the loop and does its human tasks, and the time zone dates are written in;
- the repositories to build, one lane each: a git URL or path to clone, or nothing to start one empty, and the command that fully checks it (typecheck, lint, every test) before anything merges;
- the agents to use;
- a spec to start from, if you have one;
- whether to install the Helix skill, globally or for this project.

Everything lands in `.helix/` ([project layout](project-layout.md)).
Commit it: the config, the spec, the TaskSet and its milestones are the project's source; the loop's runs, the cloned repositories and the passes' worktrees are ignored.

## 3. Write the spec

In Claude Code or Codex, in the project folder, with the Helix skill installed:

```
/helix spec       write the spec with you, section by section
/helix harden     find what a builder would have to guess, and settle it with you
```

The spec goes in `.helix/spec/`.
Index it, so each task's prompt carries only the sections it cites:

```sh
helix-loop spec index
```

## 4. Scope it: the TaskSet

```
/helix taskset    break the spec into Lane › Epic › Feature › Story › Task, and the human tasks
/helix validate   check it as the loop will
```

The skill asks whether you want two finish dates (code complete and project complete) or one.
Bring the TaskSet in:

```sh
helix-loop taskset import <the folder the skill wrote> --apply
helix-loop taskset        # lanes, epics and features, and how far each has got
```

`helix-loop validate` now reports one error: there are no milestones yet.

## 5. Order it: the Milestones

```
/helix milestones   propose the delivery order, from a walking skeleton to breadth, and apply it once you agree
```

The skill reads the TaskSet's dependencies, proposes milestones you can demo, and resolves every dependency that points to a later milestone, by pulling it forward or by building against a placeholder that a later task wires in.
It shows you the list to confirm, then applies it as the TaskSet's next revision; the first is kept in `.helix/plan/history/`.

```sh
helix-loop milestones check <folder>   # what the skill runs: every forward dependency, with its two resolutions
helix-loop milestones apply <folder>   # what it runs once you agree
helix-loop milestones                  # each milestone, its progress and its projected date
helix-loop validate                    # clean: the loop can run
```

## 6. Watch it, then run it

```sh
helix-loop run --dry-run      # the loop on a copy of the plan, with fake agents: see it work first
helix-loop app --open         # the control room
helix-loop run                # the real thing, in the foreground
```

While it runs, `helix-loop status` shows where it is, `helix-loop inbox` what waits on you, and `helix-loop watch` follows the passes in the terminal.
`helix-loop stop` stops it gracefully; `helix-loop pause` holds new passes without stopping.

## 7. Steer

What only you can do comes up as human tasks: accounts, payments, reviews, DNS.
`helix-loop human` lists them by when each must start; `helix-loop human done <id>` marks one done.
When a milestone is reached, the loop releases each lane it touched, and Home asks you to review its demo.
When builders fail with a shared cause, it shows as an incident with a proposed fix: `helix-loop incidents`, then `helix-loop fix accept <key>`.
Every plan change the app or the CLI makes is one commit, undoable for a day with `helix-loop undo`.
