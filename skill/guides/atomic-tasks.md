# Atomic tasks

A task is one pass of one builder: a fresh session with no memory, in a fresh worktree of one repository, that ends in one commit the gate checks and the loop merges.
The builder sees only the task's YAML, the spec text it cites, the repository's agent instructions (`AGENTS.md` or `CLAUDE.md`) and the code.
So a task must stand on its own: a precise title, exact acceptance tests, the right citations, and notes for anything the spec leaves open.

## The four tests of an atomic task

1. **One pass.** A builder can finish it, wired in and tested, in one session well under the pass timeout (roughly 15 to 45 minutes of work against a 60-minute timeout).
2. **One gate.** It ends in one coherent change that passes the repository's full check on its own. Nothing is left half-built for a later task to finish.
3. **One area.** It changes one module, so another builder can work beside it without conflicts.
4. **Proven.** Each requirement it claims has an acceptance test that a test in the repository must carry, word for word.

## The file

From `examples/mini-taskset/`, with an illustrative `repo` (the loop's task schema lists the repositories it accepts):

```yaml
id: T-0002
repo: web-app
stage: day1
area: core/waitlist
epic: waitlist-core
title: A new sign-up gets a confirmation email whose one-click link confirms it
reqs: [WL-2]
spec: ["§4 Waitlist", "§4 Requirements"]
acceptance:
  - "integration: [WL-2] joining sends one confirmation email with a single-use link that expires after 48 hours"
  - "e2e: [WL-2] opening the confirmation link marks the sign-up confirmed and redirects to the confirmation page"
  - "e2e: [WL-2] an expired or used link shows the plain-words reason and a way to send a new link"
blocked_by: [T-0001]
estimate_passes: 1
status: ready
claimed_by: null
attempts: []
notes: |
  Send through the Mailer interface; tests read the captured outbox of its local stand-in, never a real provider.
```

| Field | Rule |
| --- | --- |
| `id` | `T-` and four digits, unique, and the file is named `T-####.yaml`. |
| `repo` | The lane: a repository `taskset.yaml` declares. |
| `stage` | A stage from the build plan. The task's blockers are in this stage or earlier. |
| `area` | The module the task owns while it runs (below). |
| `epic` | The epic's key in its lane. |
| `title` | What will be true when the task is done, in plain words, 8 to 160 characters. "Posts screen lists the queue grouped by day with state badges", not "Implement posts list". |
| `reqs` | The requirement IDs it delivers: spec IDs or synthetic IDs. |
| `spec` | Citation keys of the narrowest sections the builder needs: `§11 Composer`, not `§11`. A claimed requirement's own text is injected without being cited. |
| `acceptance` | One line per test (below). |
| `blocked_by` | Task and human task IDs it waits on (below). |
| `estimate_passes` | 0.5, 1, 1.5 or 2 (below). |
| `status`, `claimed_by`, `attempts` | `ready`, `null` and `[]` on every new task; the loop owns them after that. |
| `notes` | What the builder needs beyond the spec (below). Plain text, at most about 1,500 characters. |
| `priority` | Leave it out, except `fix_first` for a bug the loop or a person found (below). |

Leave out the fields the loop writes (`summary`, `attempts` entries) and any loop-specific pins (`agent`, `role`) unless the loop's own conventions call for them.

## Sizing

- `estimate_passes: 1` is the norm: one session of 15 to 45 minutes that ends in a single coherent change.
- `0.5` for a small, sharp change.
- `1.5` or `2` only when splitting would leave something half-built. The validator warns on anything above 1; justify it in the notes.
- Anything bigger than 2 is two tasks, and above 3 the schema refuses it.

Split by behaviour, never by layer.
A task that adds an operation, its handler, its migration and the button that calls it is one vertical slice; "add the table" then "add the handler" then "add the button" is three tasks that each deliver nothing reachable.

**Done means reachable.**
Every task delivers behaviour a person, an agent or another service can reach through the real entry point, and proves it through that entry point.
Never plan "build it now, wire it in later": the task that builds a thing connects it.

**No trivia.**
A task that only adds a constant, a type or a config key belongs to the task that needs it.

## Acceptance tests

Each line is `<kind>: [<IDs>] <title>`, matching `^(e2e|unit|integration): \[ID(, ID)*\] .{8,}$`.
The builder must write a test whose title contains the text after the kind exactly, tag included, and the gate refuses the merge if it can't find it.

| Kind | What it does |
| --- | --- |
| `e2e` | Starts the built product through its real entry points and drives it over HTTP or in a real browser. Every screen task has at least one, and it runs the accessibility check on every screen it opens. |
| `integration` | Runs the product's own modules against real infrastructure (the real database, with its security rules on), but not through HTTP. |
| `unit` | Pure functions: formulas, parsers, pickers, with fixtures that pin their output. |

- **Specific and observable.** "[PB-14] window pick replays exactly from its stored seed" is right; "posting windows work" is not (an example from the Mushy spec, where posts go out at a seeded random moment in a window).
- **Tags are a subset of the task's `reqs`.** A line may carry several: `[PB-2, PB-3]`.
- **Cover the edge cases the spec states**: limits, errors, empty states, roles that may not.
- **Two to five lines** is typical. One line is fine for a small fix; more than six suggests two tasks.
- **Unique across the TaskSet.** Two tasks with the same title text would be satisfied by one test.

## Areas

`area` is a lock: two tasks in the same area never run at the same time.
Choose it so independent work runs in parallel and dependent work in one module runs in order.

- Lowercase, slash-separated, from the spec's module map: `web/posts`, `api/rate-limits`, `connectors/x`, `workers/publish`, `website/pricing`.
- **One area per screen route, per operation group, per connector, per worker job, per infrastructure module.**
- Tasks in one feature usually share an area, so they run in order and never conflict.
- Tasks in different features should not share one, or they serialise for no reason.
- Changes to shared, sensitive paths (CI workflows, infrastructure, the gate itself) get their own area, such as `ci`; the loop may refuse such paths from any other area.

## Dependencies

- `blocked_by` lists task IDs (`T-0130`) and human task IDs (`HT-16`), in any lane.
- **Only real needs.** A blocker is something without which the task cannot be built or tested. "Related to" is not a dependency.
- **Same stage or earlier**, never a later stage.
- **Human tasks rarely block build tasks.** Build and test against the stand-ins; only the contract test or the deploy needs the real account.
- A shared skeleton capability (the end-to-end harness, the design system package) is a blocker of the first tasks that use it, not of every task.

## Notes

Notes carry what the spec leaves to judgment and you have decided:

- the design reference to build from, for example `Build from design-reference/screenshots/04-posts.png`;
- the hardening finding the task relies on: `Assumption SH-14: ...`;
- the existing module or capability to build on, so the builder extends rather than duplicates;
- edge cases the spec implies but doesn't spell out;
- what keeps the task from colliding with its neighbours: "Comment ingestion is T-1421's; this task only deletes."

Notes never restate the spec, never repeat what the repository's agent instructions already say, and never hold a rule a script could check (that belongs in the gate).

## Fix-first tasks

A bug found by the loop, a reviewer or a person becomes a task with `priority: fix_first`, which jumps the queue.

- **Reproduce first.** The notes say how to see the failure from a clean checkout, step by step, and what the correct behaviour is.
- **The acceptance test is the reproduction**, so the bug cannot come back.
- Cite the requirement the bug breaks; if none covers it, that is a spec gap to raise too.

An example from the Mushy loop, where the loop found the bug itself:

```yaml
priority: fix_first
acceptance:
  - "unit: [BLD-1, BLD-10] pnpm run generate builds the design system's dist from its current source"
notes: |-
  Found by the loop. On a fresh clone of main, `pnpm typecheck` fails with TS2307 "Cannot find module '@acme/design-system'": the package's exports point at dist/, and nothing in install or the gate builds it.
  Reproduce: git clone <repo> <dir> && cd <dir> && pnpm install --frozen-lockfile && pnpm typecheck
  Fix: give the package a generate script that builds it, so a fresh checkout passes the gate with no other build step.
```

## When a task can't be done

The builder ends its pass with `BLOCKED:` and what it needs, and the loop hands the task to a person.
Plan so that this is rare: a task that contradicts the spec, depends on something missing or is too big for one pass is a planning bug.

## Good and bad

| Bad | Why | Good |
| --- | --- | --- |
| "Build the user table" | A layer, not a behaviour; nothing reachable | "A visitor joins the waitlist with an email address and gets a pending sign-up" |
| `e2e: [WL-1] waitlist works` | Not specific; any test passes it | `e2e: [WL-1] POST /api/v1/public/waitlist answers 202 for a valid address and 400 for an invalid one` |
| `estimate_passes: 3` | Three sessions of work in one pass will time out | Three tasks of one pass each, in order, sharing an area |
| `area: web` | Locks every screen at once | `area: web/admin-waitlist` |
| `blocked_by: [HT-1]` on the feature | The feature can be built against the stand-in | Only the contract test waits on HT-1 |
| Notes that paste the spec | The spec is already injected; the prompt grows | Notes with the design reference and the assumption |

## Checklist

- The title says what is true when it's done.
- It fits one pass, and its estimate says so.
- Every claimed requirement has an acceptance line, and every line's tags are in `reqs`.
- At least one test goes through the real entry point; screen tasks have an e2e test with the accessibility check.
- Its area lets unrelated work run beside it.
- Every blocker is real, and none is in a later stage.
- Its spec citations are the narrowest that give the builder what it needs.
- Its notes hold decisions, not rules and not the spec.
