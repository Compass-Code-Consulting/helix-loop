# From spec to TaskSet

`/helix taskset` turns a hardened spec into a TaskSet: lanes and epics, atomic tasks, human tasks, and the dependencies between them.
The loop then schedules from that graph: the critical path first, two builders never in the same area, and, when the plan has stages, a stage opening only when the earlier ones are done.
A good decomposition keeps every builder busy on work that is ready, and never asks one to build something it cannot finish and test in one pass.

## The TaskSet

```
plan/
  taskset.yaml          lanes and their epics, in order
  tasks/T-####.yaml     one file per task, named by its ID
  human/HT-##.yaml      one file per human task, named by its ID
  schema/               taskset, task and human schemas
```

```yaml
# taskset.yaml
version: 1
stages:                     # optional milestones, in order; leave out for no stage gating
  - { key: day0, title: "Day 0: Skeleton" }
  - { key: day1, title: "Day 1: Foundation" }
timelines: [code, project]  # the finish dates the app shows; [project] for one
lanes:
  web-app:                  # the lane's key
    repo: web-app           # the repository it builds; tasks name it in `repo`
    epics:
      sign-in:              # the epic's key; tasks name it in `epic`
        title: Sign-in with passkeys and email codes
```

The hierarchy is Lane › Epic › Task.
Each task carries `repo` (its lane) and `epic` (its epic's key in that lane), and, when the plan has stages, `stage`.
Stages are milestones a task belongs to, not a level of the hierarchy: an epic may have tasks in several stages.
`timelines` is the owner's choice of finish dates: Project complete is when everything is done, human tasks and their lead times included, and Code complete is when the last builder task would merge if every human task were done the moment it is needed.
With both, a wait for an account or a D-U-N-S number moves Project complete but not Code complete; leaving the field out means both.
See [atomic-tasks.md](atomic-tasks.md) for the task file and [human-tasks.md](human-tasks.md) for the human task file.
`examples/mini-taskset/` is a complete small TaskSet.

## Order of work

### 1. Read the spec for structure, not detail

List the repositories (§0), the milestones the build plan names, if any, and what each one gates, the module map, the requirement prefixes, and the human tasks the spec already names.
Read the hardening findings: tasks are planned on the resolutions, and cite them in notes as `Assumption SH-n`.

### 2. Lanes

One lane per repository the loop builds.
A lane has its own merge queue and releases, so work that must ship together belongs in one lane, and cross-lane dependencies are edges between tasks.
A repository the spec defers to a later phase gets no lane yet.

### 3. The walking skeleton, first

Before any feature, plan each lane's skeleton:

- the repository, its real entry point, and its full check (typecheck, lint, unit tests) in one command;
- integration tests against the real database, and end-to-end tests that start the built product and drive it through its real entry point, with an accessibility check;
- the checks that keep work honest: an orphan check (no code unreachable from an entry point), the requirement-to-test check (every acceptance title exists as a test), a duplicate-code check, file-size limits;
- CI running the same check;
- the shared packages every feature uses: configuration, the design system, the stand-ins for external services, the seed data generator.

Without these, the first day builds disconnected modules that pass their own tests and do nothing (lesson L1 below).
They go first (in the first stage, when there are stages), and features depend on them.

### 4. Epics

An epic is one capability inside one lane: "Sign-in with passkeys and email codes", "Waitlist form and confirmation page".
It is the unit the loop's map folds to, and the unit a person reads progress in.

- **One capability, one lane.** A feature that spans two lanes is two epics, linked by task dependencies.
- **Capabilities, not days.** Group by what the user gets, never by when it is built: an epic's tasks may fall in several stages, and each task carries its own `stage`.
- **Three to fifteen tasks** is the usual size. Fewer, and it is probably part of a neighbour; more, and it is probably two capabilities.
- **Keys** are lowercase words joined by hyphens (`sign-in`, `waitlist-page`); titles say what the user gets, in plain words.
- **Declared in build order** within each lane in `taskset.yaml`: by the earliest stage an epic reaches, then by what it waits on.

### Stages (optional)

Stages are milestones: "Day 0: the skeleton", "Beta: ready for the first users".
Declare them in order under `stages` when the spec's build plan has gates worth holding work behind; a task in a later stage waits until every earlier stage is settled.
Leave them out when it doesn't: the loop then schedules by dependencies alone.

### 5. Tasks

Cut each epic into atomic tasks with [atomic-tasks.md](atomic-tasks.md).
Inside an epic, the usual order is: data model and operations, then the screen, then edge cases, then the empty, loading and error states.
Prefer vertical slices (an operation, its handler, its migration and the screen element that uses it) over one task per layer.

### 6. Human tasks

While cutting tasks, note every step only a person can do: accounts, payments, legal sign-off, review submissions, DNS, judgment calls.
Write each with [human-tasks.md](human-tasks.md).
Block a task on a human task only when it truly cannot be built and tested without it; build against the stand-ins instead.

### 7. Dependencies

- **Honest edges.** Every edge lengthens the critical path. Block only on what the task needs to be built and tested, not on what it is "related to".
- **Same stage or earlier.** With stages, a task may wait only on work in its own stage or an earlier one; otherwise its stage can never close.
- **Across lanes** by task ID, like any other edge: the website's pricing page waits on the app task that serves the pricing endpoint.
- **No cycles.** If two tasks need each other, the cut is wrong: merge them, or move the shared part into a third task both wait on.
- **Look at the longest chain.** If one chain is much longer than the rest, the loop will finish late with idle builders; split the long tasks on it or move work off it.

### 8. Coverage

- Every requirement in the spec is claimed by at least one task, except those deferred by name.
- Prose requirements (each screen, entity, formula or template described only in prose) get synthetic IDs in a separate list, `- { id: PBS-3, title: "...", source: "§11 The Posts screen" }`, and are claimed like any other.
- A task claims only what it delivers and tests; several tasks may share one requirement.

### 9. Validate and report

Run `node scripts/validate.mjs <plan-dir> --reqs <requirements list>` until it reports no errors, and fix or justify each warning.
Then report: tasks by lane and epic (and by stage, when there are stages), total estimated passes, the longest dependency chain, the human tasks with the longest lead times, the hardening findings you raised, and anything the owner must decide.

## Planning in parallel

For a large spec, several planners can each take some sections, with a shared brief:

- **ID ranges** per planner (`T-1000` to `T-1299`, `HT-140` to `HT-149`) so files never collide.
- **Capabilities** as the contract between planners: a named piece of shared work (`cap:job-queue`) with an owner, a stage, and what it provides. A planner depends on another's work only through a capability, and the owner lists the tasks that complete it; when the plans are merged, each `cap:` reference is replaced by those tasks.
- **Staging folders**, one per planner, checked with the same validator before they are merged into the TaskSet.
- **Findings, not improvisation**: a planner that needs work no capability provides records it as a missing capability instead of planning it.

## Lessons this guide is built on

From a previous loop that ran 360 passes over eight days:

- **L1 Disconnected code.** The first day built 16 modules loaded only by their own tests, and a blank page passed the check. Hence the walking skeleton first, and "done means reachable" in every task.
- **L2 Files read every pass grew without limit.** Hence builders get one task and the spec sections it cites, never the whole plan.
- **L5 Naive completion.** Work waiting on a person looked like work left to do. Hence task state is data, and human tasks are explicit.
- **L9 Hotspot files.** A few shared files took 70 to 80 commits each and would have conflicted under parallel builders. Hence one module per route, connector and job, and areas.
- **L10 The spec grew mid-flight.** Seven drafts arrived as rework. Hence hardening before the first task.
- **L12 Tests missed visual defects.** Hence a separate look pass that files fix-first tasks.
