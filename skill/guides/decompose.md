# From spec to TaskSet

`/helix taskset` turns a hardened spec into a TaskSet: the scope as Lane › Epic › Feature › Story › Task, the human tasks, and the dependencies between them.
The TaskSet says what to build, not when: its first revision orders nothing beyond the dependencies.
The order comes next, from `/helix milestones` ([milestones.md](milestones.md)), which the loop then follows: the earliest milestone's ready work first, the critical path within it, and two builders never in the same area.
A good decomposition keeps every builder busy on work that is ready, and never asks one to build something it cannot finish and test in one pass.

## The hierarchy

| Level | What it is | Size in a team's terms | Size in the loop's terms |
| --- | --- | --- | --- |
| Lane | One repository the loop builds. Every epic lives in exactly one lane. | — | — |
| Epic | A large strategic outcome, named for the outcome, not the code: "Social publishing", not "Publishing service". | A quarter, several sprints | 2–8 features |
| Feature | A deliverable product capability a user would recognise, built as a vertical slice: "Network connections". | 1–2 sprints | 2–6 stories |
| User story | One specific, user-centred need, small enough to demo on its own. | 1 sprint | 2–8 tasks |
| Task | One concrete technical step, closed by its acceptance tests. | 1–2 days | One builder pass (`estimate_passes` 1–3) |

- **Epics are outcomes.** Name what becomes true for people: "Social publishing", "A waitlist people can trust".
  Each epic states its `outcome` in a sentence.
- **Features are capabilities, built as vertical slices.** A feature cuts through every layer it needs (data, operations, screen) so it works end to end; "the database layer" is not a feature.
  Each may state its `capability` in a sentence.
- **Stories are needs, and they are INVEST**: Independent, Negotiable, Valuable, Estimable, Small and Testable.
  A story names the person it serves in its `need`: "As a marketer, I want to connect my company's LinkedIn Page, so that Mushy can publish to it and read its metrics."
- **Enabler stories** carry platform and infrastructure work, written from whoever benefits: the operator, the support agent, the owner, a developer using the API, or the end user it protects.
  "As a workspace owner, I want my tokens encrypted at rest, so that a database leak exposes nothing."
- **Tasks are steps**, each one pass with its acceptance tests; see [atomic-tasks.md](atomic-tasks.md).
- **Outside the sizes** is a warning, not an error: fix it, or say why in your report.
- **No days.** Nothing in a title or a key may say "Day N": the order is the milestones', and they name outcomes.

## The TaskSet

```
plan/
  taskset.yaml          Lane › Epic › Feature › Story
  milestones.yaml       the delivery order, written later by /helix milestones
  tasks/T-####.yaml     one file per task, named by its ID
  human/HT-##.yaml      one file per human task, named by its ID
  schema/               taskset, milestones, task and human schemas
```

```yaml
# taskset.yaml
version: 2
revision: 1                       # 1 for the TaskSet as first planned; each Milestones application adds one
timelines: [code, project]        # the finish dates the app shows; [project] for one
lanes:
  app:                            # the lane's key
    repo: acme-app                # the repository it builds; tasks name it in `repo`
    epics:
      social-publishing:          # keys are unique across the whole TaskSet, at each level
        title: Social publishing
        outcome: Marketers plan, approve and publish to every connected network from one queue.
        features:
          network-connections:
            title: Network connections
            capability: Connect, reconnect and disconnect each network's accounts, with their history backfilled.
            stories:
              connect-linkedin-page:
                title: Connect a LinkedIn Page
                need: As a marketer, I want to connect my company's LinkedIn Page, so that Mushy can publish to it and read its metrics.
```

Each task names its story in `story`; its feature, epic and lane follow, and the lane's `repo` must be the task's `repo`.
The YAML's order is reading order only.
Keys are lowercase words joined by hyphens; titles are 3 to 80 characters and say what the user gets.
`timelines` is the owner's choice of finish dates: Project complete is when everything is done, human tasks and their lead times included, and Code complete is when the last builder task would merge if every human task were done the moment it is needed.
With both, a wait for an account or a D-U-N-S number moves Project complete but not Code complete; leaving the field out means both.
See [atomic-tasks.md](atomic-tasks.md) for the task file and [human-tasks.md](human-tasks.md) for the human task file.
`examples/mini-taskset/` is a complete small TaskSet, with its milestones.

## Order of work

### 1. Read the spec for structure, not detail

List the repositories (§0), the epics, features and user stories the spec names, the demoable outcomes its build plan names, the module map, the requirement prefixes, and the human tasks the spec already names.
Read the hardening findings: tasks are planned on the resolutions, and cite them in notes as `Assumption SH-n`.

### 2. Lanes

One lane per repository the loop builds.
A lane has its own merge queue and releases, so work that must ship together belongs in one lane, and cross-lane dependencies are edges between tasks.
A repository the spec defers to a later phase gets no lane yet.

### 3. The walking skeleton, first

Before any feature, plan each lane's skeleton, as enabler stories ("As a developer, I want one command that checks the whole repository, so that a broken change never merges"):

- the repository, its real entry point, and its full check (typecheck, lint, unit tests) in one command;
- integration tests against the real database, and end-to-end tests that start the built product and drive it through its real entry point, with an accessibility check;
- the checks that keep work honest: an orphan check (no code unreachable from an entry point), the requirement-to-test check (every acceptance title exists as a test), a duplicate-code check, file-size limits;
- CI running the same check;
- the shared packages every feature uses: configuration, the design system, the stand-ins for external services, the seed data generator.

Without these, the first passes build disconnected modules that pass their own tests and do nothing (lesson L1 below).
Features depend on them, and `/helix milestones` puts them in the first milestone.

### 4. Epics, features and stories

Work top down, from the spec's epics (outcomes), features (capabilities) and user stories (needs).

- **One lane each.** An epic lives in one lane; a capability that spans two repositories is two features, one per lane, linked by task dependencies.
- **Capabilities, not layers, and never days.** Group by what the user gets, never by when it is built or which layer it touches.
- **Each story demoable on its own.** If a story's tasks can't be shown working without another story, merge them, or cut differently.
- **Stories for every need**, including the enablers: no task is "infrastructure" without someone it serves.
- **Every epic has a feature, every feature a story, every story a task**; the validator reports an empty one.

### 5. Tasks

Cut each story into atomic tasks with [atomic-tasks.md](atomic-tasks.md).
Inside a story, the usual order is: data model and operations, then the screen, then edge cases, then the empty, loading and error states.
Prefer vertical slices (an operation, its handler, its migration and the screen element that uses it) over one task per layer.

### 6. Human tasks

While cutting tasks, note every step only a person can do: accounts, payments, legal sign-off, review submissions, DNS, judgment calls.
Write each with [human-tasks.md](human-tasks.md).
Block a task on a human task only when it truly cannot be built and tested without it; build against the stand-ins instead.

### 7. Dependencies

- **Honest edges.** Every edge lengthens the critical path. Block only on what the task needs to be built and tested, not on what it is "related to".
- **Dependencies, not order.** Don't add an edge to say what should come first: the milestones say that. An edge is a real need.
- **Across lanes** by task ID, like any other edge: the website's pricing page waits on the app task that serves the pricing endpoint.
- **No cycles.** If two tasks need each other, the cut is wrong: merge them, or move the shared part into a third task both wait on.
- **Look at the longest chain.** If one chain is much longer than the rest, the loop will finish late with idle builders; split the long tasks on it or move work off it.

### 8. Coverage

- Every requirement in the spec is claimed by at least one task, except those deferred by name.
- Prose requirements (each screen, entity, formula or template described only in prose) get synthetic IDs in a separate list, `- { id: PBS-3, title: "...", source: "§11 The Posts screen" }`, and are claimed like any other.
- A task claims only what it delivers and tests; several tasks may share one requirement.

### 9. Validate and report

Run `node scripts/validate.mjs <plan-dir> --reqs <requirements list>` until it reports no errors, and fix or justify each warning.
Then report: counts by lane, epic, feature and story, total estimated passes, the longest dependency chain, the human tasks with the longest lead times, the size warnings you kept and why, the hardening findings you raised, and anything the owner must decide.
Once the owner imports it (`helix-loop taskset import`), plan the delivery order with `/helix milestones`.

## Planning in parallel

For a large spec, several planners can each take some sections, with a shared brief:

- **ID ranges** per planner (`T-1000` to `T-1299`, `HT-140` to `HT-149`) so files never collide.
- **Capabilities** as the contract between planners: a named piece of shared work (`cap:job-queue`) with an owner and what it provides. A planner depends on another's work only through a capability, and the owner lists the tasks that complete it; when the plans are merged, each `cap:` reference is replaced by those tasks.
- **Staging folders**, one per planner, checked with the same validator before they are merged into the TaskSet.
- **Findings, not improvisation**: a planner that needs work no capability provides records it as a missing capability instead of planning it.

## Lessons this guide is built on

From a previous loop that ran 360 passes over eight days:

- **L1 Disconnected code.** The first passes built 16 modules loaded only by their own tests, and a blank page passed the check. Hence the walking skeleton first, and "done means reachable" in every task.
- **L2 Files read every pass grew without limit.** Hence builders get one task and the spec sections it cites, never the whole plan.
- **L5 Naive completion.** Work waiting on a person looked like work left to do. Hence task state is data, and human tasks are explicit.
- **L9 Hotspot files.** A few shared files took 70 to 80 commits each and would have conflicted under parallel builders. Hence one module per route, connector and job, and areas.
- **L10 The spec grew mid-flight.** Seven drafts arrived as rework. Hence hardening before the first task.
- **L12 Tests missed visual defects.** Hence a separate look pass that files fix-first tasks.
