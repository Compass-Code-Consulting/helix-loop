# Concepts

Helix Loop builds a product from a spec with headless coding agents (Claude Code and Codex), in parallel, while you steer.
This page explains the moving parts and the words the app and the CLI use for them.

## The spec and the TaskSet

- **Helix Spec:** the product's technical and design specification, with numbered requirements (`PB-14`).
  Builders read only the sections their task cites, never the whole spec.
- **Helix TaskSet:** the plan the loop runs, written from the spec with the Helix skill.
  It is organised **Lane › Epic › Task**:
  - a **lane** is a repository the loop builds;
  - an **epic** is one capability in one lane ("Connect LinkedIn pages and profiles"), usually 3 to 15 tasks;
  - a **task** is one change a builder can make and test in one pass, with acceptance tests named for its requirements.
- **Human tasks** (`HT-##`) are the steps only a person can do: accounts, payments, legal sign-off, DNS, reviews.
  Builder tasks that truly need one wait on it; the rest are built against stand-ins.
- **Stages** are optional milestones ("Day 1: Foundation"). Each task names its stage, and work in a later stage waits until every earlier stage is settled.
  A stage is a milestone, not a level of the hierarchy: one epic can span several stages.
  Leave stages out, and the loop schedules by dependencies alone.

## The loop

- A **pass** is one builder working one task in its own git worktree, from a prompt the loop writes: the task, the spec sections it cites, its notes.
- The **gate** is the repository's own full check (`pnpm run gate`, say): typecheck, lint and every test.
  A pass merges into `main` only when the gate passes, and only work the gate saw is merged.
- The loop runs passes in parallel, up to each agent's slots, never two in the same **area** (module) at once, the critical path first.
- It paces each agent so its weekly subscription lasts the week, and it drops to one agent, or waits, when an agent hits its limit.
- A task that keeps failing goes to **needs you**; one you set aside is **parked**.
  Neither runs again until it is handed back.
- When the same test fails passes of two different tasks, the loop files a **fix first** task for it, ranked ahead of everything else.

## Two finish dates

- **Project complete:** when everything is done: the last builder task merged and the last human task done, each human task taking its lead time after the human tasks it waits on.
- **Code complete:** when the last builder task would merge if every human task were done the moment it is needed.
  A real-world wait (a D-U-N-S number, an app-store account) moves project complete, not code complete.

The TaskSet chooses: `timelines: [code, project]` shows both, `timelines: [project]` shows project complete alone.

## What waits on you, and fixes

Home lists what waits on you, grouped by shared cause and sorted by how much work each group holds up.
A group of failures with one cause is an **incident**: the same failing test, the same missing secret, the same requirement in question.

A **fix** is a set of plan changes for an incident, applied as one commit and undoable for 24 hours.
A fix can only do what the plan can express:

| A fix can | A fix can't |
| --- | --- |
| hand a task back (ready again), with a note for the next builder | change product code: only builders write code, through tasks |
| park a task | change an existing task's title, acceptance tests, repo, estimate or priority |
| add a note to a task (every builder reads its task's notes) | create a human task, delete a task, or revert merged work |
| create a new task, such as a fix-first task | change the spec (an answer becomes a numbered clarification instead) |
| add or remove a dependency | change loop settings (you change those in Settings or with `helix-loop config`) |
| pause new passes | skip ("quarantine") a failing test in the gate |

To reshape a task, a fix parks it and creates the tasks that replace it.

**Why tests can't be quarantined.** The gate is each repository's own script; the loop runs it and reads pass or fail.
Skipping one test would need either the repository's gate to read a skip list the loop writes (a product change, built by a task), or the loop to read every failing test from the gate's output and pass a gate whose only failures are quarantined (which hides any real regression that test would have caught).
Meanwhile the loop files a fix-first task for a test that fails two tasks, so the test is repaired rather than skipped.

## Pilot mode

Pilot mode says how much the loop and Helix decide without you.

- **Active pilot** (you're at the desk), at Cautious, Prudent or Intrepid: Helix brings you the requests the level reserves for you.
- **Auto-pilot** (you're away), at Intrepid or YOLO: Helix resolves what it can; at Intrepid, high-risk items park their task until you're back.

Some decisions always wait for you, whatever the level: releases, changes to reviewed paths, human tasks, secrets, the config and Helix's prompts.
Rate a request Helix brings you (▲ keep asking, ▼ decide these yourself) and the rating becomes a rule.

## Helix

Helix is the app's assistant, with two roles.

- **Assistant:** answers your questions and comments about the loop, and makes the plan changes you ask for, through the app's checked tools.
- **Monitor:** watches the loop while it runs: it groups failures into incidents, proposes a fix for each, applies fixes and answers builders' questions when the pilot mode lets it, and copies what a finished human task produced (an ID or a URL, never a secret) into the notes of the tasks waiting on it.

The monitor is optional: without it the loop runs as before, and the app still groups failures; you decide each fix yourself, and on Auto-pilot nothing is resolved while you're away.
Every monitor turn spends the agent subscription your builders use, so it is off until you turn it on, and it has a level:

| Level | Runs | Model | Default daily cap |
| --- | --- | --- | --- |
| Light (the default) | only when something needs judgment: a failure that repeats, a builder's report of a problem, a human task marked done | Sonnet, low effort (Codex: its build model) | $5 |
| Standard | Light's triggers, plus a check every 30 minutes and a one-line read of each running pass | Sonnet, medium effort (Codex: its build model) | $15 |
| Thorough | every pass that ends, and a check every 15 minutes | the agent's planning model, high effort | $30 |

Settings › Helix shows what each level would have spent at the last 24 hours' pace; `helix-loop monitor` shows the same and sets it from the CLI.

## Releases

The loop tags a release of a repository when a stage closes, holds it until a named human task is done when the config says so, and holds any release that changes a reviewed path (CI workflows, infrastructure) until you've read its diff and approved it.
