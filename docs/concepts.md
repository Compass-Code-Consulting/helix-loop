# Concepts

Helix Loop builds a product from a spec with headless coding agents (Claude Code and Codex), in parallel, while you steer.
This page explains the moving parts and the words the app and the CLI use for them.

## The spec, the TaskSet and the milestones

A project has three artifacts, written in this order with the Helix skill.

1. **Helix Spec:** the product's technical and design specification, with numbered requirements (`PB-14`).
   Builders read only the sections their task cites, never the whole spec.
2. **Helix TaskSet:** the scope the loop builds, as **Lane › Epic › Feature › Story › Task**.
   Its first revision says nothing about order beyond the dependencies.
3. **Helix Milestones:** the order the work is delivered in, as named, demoable outcomes.
   Planned after the TaskSet, reading its dependencies; the loop runs only a plan that has them.

### The hierarchy

| Level | What it is | Usual size |
| --- | --- | --- |
| Lane | One repository the loop builds. Every epic lives in exactly one lane. | — |
| Epic | A large outcome, named for what becomes true for people: "Social publishing". | 2–8 features |
| Feature | A capability a user would recognise, built as a vertical slice: "Network connections". | 2–6 stories |
| User story | One user-centred need, small enough to demo on its own: "As a marketer, I want to connect my company's LinkedIn Page, so that Mushy can publish to it". | 2–8 tasks |
| Task | One change a builder can make and test in one pass, with acceptance tests named for its requirements. | one pass |

Each task names its story; its feature, epic and lane follow.
Platform work is an **enabler story**, written from whoever benefits: the operator, the owner, a developer, the end user it protects.
Nothing in a title or a key says "Day N": the order is the milestones', and they name outcomes.

**Human tasks** (`HT-##`) are the steps only a person can do: accounts, payments, legal sign-off, DNS, reviews.
They stay outside the hierarchy and the milestones, ordered by when each must start.
Builder tasks that truly need one wait on it; the rest are built against stand-ins.

### Milestones

A milestone is an outcome the owner can see: "The app builds, deploys and signs a person in", with a demo, the thing to try when it is reached.
It names features, stories and tasks; a task belongs to the milestone that names it most specifically, by its id, then its story, then its feature, and every task belongs to exactly one.

- **A priority, not a gate.** The loop takes ready work in the earliest milestone not yet reached first, and later work when nothing earlier is ready, so no builder waits for a slow milestone.
- **Nothing waits on a later milestone.** Where the order wants a task before something it needs, the dependency is pulled forward, or the task is built against a **placeholder** (`placeholder_for`), a stand-in its acceptance describes, and a **wiring task** (`wires`) in a later milestone replaces it with the real thing.
- **Reached** when every task in it is done: the loop tags a release of each lane it touched and asks you on Home to review its demo.
  It doesn't pause.
  Once reached, it stays reached: a fix filed into it later is follow-up work, not a new reaching.
  Milestones whose work is all done when they are applied count as reached already, with no release and nothing to review.
- **Projected**: the app and `helix-loop milestones` date each one, at the slots the loop has now.

### Revisions

Applying milestones, or importing a new TaskSet over one, writes the TaskSet's next **revision**.
The revision it replaces is kept whole in `.helix/plan/history/r<N>/`, never edited again, and `.helix/plan/history/index.yaml` records each revision: when, who, why and what it added.
`helix-loop taskset history` lists them.

## The loop

- A **pass** is one builder working one task in its own git worktree, from a prompt the loop writes: the task, the spec sections it cites, its notes.
- The **gate** is the repository's own full check (`pnpm run gate`, say): typecheck, lint and every test.
  A pass merges into `main` only when the gate passes, and only work the gate saw is merged.
- The loop runs passes in parallel, up to each agent's slots, never two in the same **area** (module) at once: fix-first work first, then the earliest milestone's, then the critical path.
- It paces each agent so its weekly subscription lasts the week, and it drops to one agent, or waits, when an agent hits its limit.
- A task that keeps failing goes to **needs you**; one you set aside is **parked**.
  Neither runs again until it is handed back.
- When the same test fails passes of two different tasks, the loop files a **fix first** task for it, ranked ahead of everything else.

## Scoped gates

A gate that runs every test on every pass grows with the product: each task adds tests, so each pass costs more than the last, and the more tests a pass must clear, the likelier one fails for reasons the change had nothing to do with.
A repository with `scoped` set ([configuration](configuration.md#repos)) tests each change instead, and checks the whole on `main`:

- **Each pass's gate tests what its change can affect.**
  The loop tells the repository's gate where the change started, in `HELIX_GATE_BASE` (its merge base with `main`, after a rebase the new `main`), and the gate picks the tests: those that import the changed code, those that exercise it, and the task's own.
  Which tests those are is the repository's to know; without the variable, its gate runs everything.
  A fix-first task runs everything anyway: it is often filed for a test its change may not reach.
- **The whole suite runs on `main`,** every `full_run_every` merges, in one of the gates' slots, and before each release the loop tags, in the repository's merge queue so `main` can't move under it: a release carries only what the whole suite passed on.
- **A failure there goes back to its cause.**
  Its failing tests run again at the same commit: if they pass, the test is flaky.
  If they fail again, they run at the merges since the last run that passed, halving the range each time, which finds the merge that broke them and so its task.
  Either way the loop files a fix-first task, once per failing test, and tells you; releases wait until a run passes, and the fix's merge starts one.

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

The loop tags a release of a repository every so many merged tasks and when a milestone that touched it is reached, holds it until a named human task is done when the config says so, and holds any release that changes a reviewed path (CI workflows, infrastructure) until you've read its diff and approved it.
With [scoped gates](#scoped-gates), it tags only a commit the whole suite passed on, and holds the release while `main` fails it.
