# Helix Milestones: the order the TaskSet is delivered in

`/helix milestones` runs after the TaskSet is imported.
The TaskSet says what to build, as Lane › Epic › Feature › Story › Task, and its first revision says nothing about order beyond the dependencies.
Helix Milestones say in what order the owner will see it work: a list of named, demoable outcomes, each a set of features, stories and tasks.

The loop treats them as a priority, not a gate.
It takes ready work in the earliest milestone not yet reached, and takes later work when nothing earlier is ready, so no builder idles behind a slow milestone.
When a milestone's last task merges, the loop tags a release of every lane it touched and asks the owner, on Home, to review its demo.

## The file

```yaml
# milestones.yaml
version: 1
taskset_revision: 1                 # the TaskSet revision this was planned against
milestones:                         # in delivery order
  - key: walking-skeleton
    title: The app builds, deploys and signs a person in
    demo: Sign up with an email code, land in an empty workspace, sign out.
    features: [app-shell, sign-in]  # every story of these features…
    stories: [connect-linkedin-page] # …plus these stories, taken from a feature placed later…
    tasks: [T-0412]                 # …plus these tasks (usually wiring tasks), taken from a story placed elsewhere
```

- **Key** in lowercase words joined by hyphens; **title** is the outcome as people will see it, 3 to 80 characters.
- **Demo** is what the owner can see or do when it is reached, in one or two sentences: the review the loop will ask for.
- **Membership resolves most specific first**: a task named by id belongs there; otherwise the milestone that names its story; otherwise the one that names its feature.
  Every task must end up in exactly one milestone, and naming the same feature, story or task in two milestones is an error.
- **Human tasks** stay out of milestones: they are ordered by when each must start.
- Nothing may say "Day N", in a title or a key: a milestone is an outcome, never a date.

## The one rule: nothing waits on a later milestone

No task may be `blocked_by` a task in a later milestone.
Where the order you want disagrees with a dependency, resolve it one of two ways.

**Pull it forward.**
Name the dependency (or its story) in the same milestone or an earlier one, with whatever it waits on in turn.
Do this when the dependency is small, risky, or needed for the demo to be real.

**Build against a placeholder.**
The waiting task is built first, against a stand-in, and a follow-up task wires the real thing in later:

- The waiting task names the dependency in `placeholder_for: [T-…]` and drops it from `blocked_by`.
- Rewrite its description and acceptance to say exactly what the placeholder does and how the missing dependency is handled: an empty state, a stub returning fixed data behind the real interface, or a clear "not available yet" error.
  The acceptance proves the placeholder, never the real dependency.
- Write one **wiring task** with `wires: [the waiting task]`, `blocked_by` the waiting task and every task in its `placeholder_for`, in the dependency's milestone or later (name it by id in that milestone's `tasks`).
  Its acceptance proves the real path end to end, and that the placeholder is gone.
- The wiring task belongs to the waiting task's story; give it an area in the same module, so the two never run at once.

Prefer a placeholder when the dependency is large, belongs with later breadth, or would drag a long chain forward; prefer pulling forward when the stand-in would be most of the work.

An example from `examples/mini-taskset/`, where the form's "sending too fast" state comes before the rate limit:

```yaml
# T-0007, in the first milestone
title: The waitlist form tells a visitor plainly when they are sending too fast or the app is down, before the limit exists
acceptance:
  - "e2e: [WL-6] a 429 from the stand-in endpoint shows Try again in a minute and disables the button until then"
blocked_by: [T-0006]
placeholder_for: [T-0003]

# T-0010, in the second milestone, with T-0003
title: The waitlist form shows Try again in a minute when the app's real limit refuses a join
blocked_by: [T-0007, T-0003]
wires: [T-0007]
```

## The workflow

### 1. Read the TaskSet and its dependencies

```sh
helix-loop taskset --json        # Lane › Epic › Feature › Story, each story's tasks and the stories it waits on
helix-loop validate              # the TaskSet is clean before you order it
```

Note the walking skeleton, the riskiest work (new external services, the hardest algorithm, anything the owner is unsure of), the user-facing paths, and the long dependency chains.

### 2. Propose the milestones

Order them in three phases, riskiest work early within each:

1. **A walking skeleton**: every lane builds, deploys and is reachable through its real entry point; a person can sign in and see an empty product.
2. **The thinnest end-to-end path a user values**: one real job done, start to finish, through the real entry points.
   Prefer showing a semi-working UI as soon as its core backend exists: a screen over a finished backend, with placeholders where the rest isn't built yet, is an early milestone worth having.
3. **Breadth**: the remaining features, each milestone a coherent outcome someone can demo.

Size them so each is days of loop work, not weeks: five to fifteen milestones for a large product, three to five for a small one.
Give each a demo the owner can actually perform.

### 3. Check it, and resolve every forward dependency

Write the proposal into a folder (`milestones.yaml`, plus `tasks/` with any task you change or add), then:

```sh
helix-loop milestones check <folder>
```

It lists every task without exactly one milestone, and every dependency that points forward, each with its two resolutions.
For each forward dependency, decide: pull it forward or build against a placeholder, as above.
For a placeholder, put the rewritten waiting task and the new wiring task in the folder's `tasks/`, with the next free task ids.
Repeat until the check is clean; `node scripts/validate.mjs` runs the same checks on a whole TaskSet without the loop.

### 4. Confirm with the owner

Before applying, show the owner the milestone list: number, title, demo, how many tasks, and each placeholder you introduced, in a table.
Recommend the order with its reasons (risk first, a usable path early), and ask them to confirm or reorder.
Apply nothing they haven't confirmed.

### 5. Apply

```sh
helix-loop milestones apply <folder> --why "Delivery order agreed with the owner"
```

It checks the proposal again, keeps the current TaskSet as it stands in `.helix/plan/history/r<N>/`, writes revision N+1 with the milestones, placeholders and wiring tasks, and records it in `.helix/plan/history/index.yaml`, as one commit.
A running loop takes the new revision on its next round; `helix-loop milestones` then lists each milestone with its progress and projected date.

## Checklist

- The first milestone is a walking skeleton; the second is the thinnest path a user values.
- Every milestone has a demo the owner can perform, and none says "Day N".
- Every task is in exactly one milestone, and no task waits on a later one.
- Every placeholder says what stands in, has exactly one wiring task, and that task is in the dependency's milestone or later.
- The owner confirmed the list before it was applied.
