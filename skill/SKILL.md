---
name: helix
description: Write a Helix Spec (a technical and design specification with numbered requirements), break it into a Helix TaskSet (Lane › Epic › Feature › Story › Task, with human tasks and dependencies) that a Helix loop of headless builder agents can run, and order its delivery with Helix Milestones, then validate them. Use when asked to write or harden a product spec for a build loop, decompose a spec into epics, features, stories and tasks, plan work for Claude Code or Codex builders, plan milestones or a delivery order, write T-####.yaml, HT-##.yaml, taskset.yaml or milestones.yaml, or check a TaskSet; also for /helix spec, /helix harden, /helix taskset, /helix milestones and /helix validate.
metadata:
  version: "2.0"
---

# Helix: from a spec to a TaskSet and its milestones, for a loop to run

A Helix loop builds a product unattended.
Headless builders (Claude Code, Codex) take one task each per pass, with no memory between passes, and a script gates and merges their work.
This skill is how you prepare what the loop runs, as three artifacts, in order: the **Helix Spec** it is built from, the **Helix TaskSet** it works through, and the **Helix Milestones** that order the delivery.

The loop is only as good as these documents.
Every gap in the spec becomes a builder's guess, and every badly cut task becomes a failed pass, a merge conflict or work that is built but never wired in.

## Words

Use these words and no synonyms; the loop, its app and its files all use them.

| Term | Means |
| --- | --- |
| Helix Spec | The technical and design specification the TaskSet is derived from. |
| Helix TaskSet | The scope in loadable form, Lane › Epic › Feature › Story › Task: `taskset.yaml`, `tasks/`, `human/`, and the schemas. |
| Helix Milestones | The delivery order: named, demoable outcomes in `milestones.yaml`, planned after the TaskSet. A priority for the loop, not a gate. |
| Lane | A repository the loop builds. Each lane has its own merge queue and releases. |
| Epic | A large strategic outcome inside one lane, named for the outcome: "Social publishing". 2–8 features. |
| Feature | A capability a user would recognise, built as a vertical slice: "Network connections". 2–6 stories. |
| Story | One user-centred need, small enough to demo on its own: "As a …, I want …, so that …". 2–8 tasks. |
| Task | One atomic piece of build work: one pass, one gate, one merge. `T-####`. |
| Placeholder | A task built before something it needs, against a stand-in its acceptance describes (`placeholder_for`). |
| Wiring task | The follow-up that replaces a placeholder with the real dependency (`wires`). |
| Human task | Work only the owner can do: accounts, payments, legal, judgment. `HT-##`. |
| Pass | One builder session on one task. |
| Gate | The checks a pass's commit must pass before it merges. |
| Area | The module a task owns while it runs; two builders never hold the same area at once. |
| Owner | The person the loop works for, who answers questions and does the human tasks. |

## Commands

Run them in this order for a new product; re-run any of them when the spec changes.

### `/helix spec`

Use it when there is an idea, a brief or an old document, but no spec a builder could work from.

1. Interview the owner before writing anything: who the users are and what jobs they hire the product for, what is in and out of the first release, the repositories and where each runs, the external services and accounts, the quality bar, and the deadline.
   Ask in small batches and offer a recommended answer with each question.
2. Write the technical spec with [guides/spec-technical.md](guides/spec-technical.md), and the design spec (screens, states, look) with [guides/spec-design.md](guides/spec-design.md).
   Write it so it decomposes: epics as outcomes, features as capabilities, user stories as needs, and a build plan that names demoable outcomes in order, never days.
3. Every requirement gets an ID and is testable as written.
4. Finish with the changelog row for the version, and list what you assumed in the reply.

### `/helix harden`

Use it on a spec before any task exists, and again after a large change.
It finds what a builder would have to ask about, and settles it before the loop starts, because a spec that grows mid-build turns into rework.

1. Read the spec section by section, as a builder would who sees only that section.
2. For each ambiguity, contradiction or gap, write a finding in the format in [guides/spec-technical.md](guides/spec-technical.md#hardening), with the resolution that adds the least scope.
3. Put the decisions only the owner can make at the top, each with a recommendation and its reason.
4. Never edit the spec on your own: the owner approves the findings, then they are folded into the next spec version.

### `/helix taskset`

Use it once the spec is hardened.
It writes the TaskSet's first revision: Lane › Epic › Feature › Story in `taskset.yaml`, one file per task in `tasks/`, one per human task in `human/`.
It orders nothing beyond the dependencies: that is `/helix milestones`, next.

1. Follow [guides/decompose.md](guides/decompose.md) for the hierarchy and the order of work: lanes, the walking skeleton, epics, features and stories, then tasks.
2. Cut each task with [guides/atomic-tasks.md](guides/atomic-tasks.md): one pass, one gate, acceptance tests named for the requirements they prove, honest dependencies, an area.
3. Write the human tasks with [guides/human-tasks.md](guides/human-tasks.md): a done check, a lead time, a ready-to-paste hand-off, secrets named and never valued.
4. Ask the owner whether they want two timelines, Code complete and Project complete, or Project complete alone, and recommend both.
   Project complete is when everything is done, human tasks and their lead times included; Code complete is when the last builder task would merge if every human task were done the moment it is needed, so a real-world wait such as a D-U-N-S number or an app-store account doesn't count against the build.
   Write the answer at the top of `taskset.yaml` as `timelines: [code, project]` or `timelines: [project]`.
5. Run `/helix validate` until it is clean, then report the counts by lane, epic, feature and story, the total estimated passes, the longest dependency chain, and the open questions.
   The owner imports it with `helix-loop taskset import`.

### `/helix milestones`

Use it once the TaskSet is imported, and again when its scope changes.
It plans the delivery order as Helix Milestones and applies them as the TaskSet's next revision; the loop runs only a plan with milestones.

1. Read the TaskSet and its dependencies: `helix-loop taskset --json`.
2. Propose milestones with [guides/milestones.md](guides/milestones.md): a walking skeleton, then the thinnest end-to-end path a user values, then breadth, the riskiest work early in each; a semi-working UI as soon as its core backend exists.
3. Run `helix-loop milestones check <folder>`, and resolve each dependency that points forward: pull it forward, or build the waiting task against a placeholder, rewriting its title, notes and acceptance, and write the wiring task.
4. Show the owner the milestone list, with each demo and each placeholder, and have them confirm it.
5. Apply it: `helix-loop milestones apply <folder>`.

### `/helix validate`

Use it after every change to a TaskSet, and before handing one to the loop.

```sh
node scripts/validate.mjs <plan-dir>                 # the folder holding taskset.yaml, tasks/ and human/
node scripts/validate.mjs <plan-dir> --reqs reqs.txt # also check that every requirement is delivered
```

It needs only Node, and runs the checks the loop runs on import: the schemas in `schema/`; every `blocked_by` resolving, with no cycles; the hierarchy (every task in a declared story of the lane that builds its repo, every level with children, unique kebab-case keys, no "Day N", and a warning outside the usual sizes); the milestones, once planned (every task in exactly one, no task waiting on a later one, each placeholder wired in by exactly one task in its dependency's milestone or later); estimates (a warning above one pass, an error above three); acceptance tags that are a subset of the task's requirements; claim state; no secret values; and requirement coverage when a requirements list is given.
Each problem prints as `ID: message`, warnings as `ID: warning: message`; it exits 1 when there is an error.
Fix every error, and fix or justify every warning.
The loop's own `helix-loop validate` also checks spec citations against the spec index and each task's rendered prompt against the prompt budget.

## What is in this skill

| Path | What |
| --- | --- |
| `guides/spec-technical.md` | Writing the technical spec: structure, requirement IDs, quality bar, and hardening. |
| `guides/spec-design.md` | Writing the design spec: screens, states, design references, accessibility. |
| `guides/decompose.md` | From spec to TaskSet: the hierarchy and its sizes, lanes, the walking skeleton, epics, features and stories, coverage. |
| `guides/atomic-tasks.md` | What a good task is, field by field, with examples. |
| `guides/human-tasks.md` | What a good human task is, field by field, with an example. |
| `guides/milestones.md` | Ordering the delivery: milestones, the forward-dependency rule, placeholders and wiring tasks. |
| `schema/` | The `taskset`, `milestones`, `task` and `human` JSON schemas, copied from the loop's `schema/` when the skill is packed. |
| `examples/mini-taskset/` | A small valid TaskSet with its milestones: one lane, one epic, two features, four stories, ten tasks (one placeholder and its wiring task), two human tasks, and its `reqs.txt`. |
| `scripts/validate.mjs` | The validator; its header documents the YAML subset it reads. |

## Rules that hold everywhere

- **The spec is the source of truth.** A task cites it; it never restates or overrides it. If a task needs something the spec doesn't say, that is a hardening finding, not a note.
- **Never write a secret value** into a spec, a task or a human task. Name the secret and say where it is stored.
- **Every rule a script can check belongs in the loop's gate, not in a task's notes.** Notes carry judgment.
- **Done means reachable.** Every task delivers behaviour someone can reach through the product's real entry point, and proves it with a test that goes through that entry point.
- **Files the loop generates** (rendered plans, the dependency map, the spec index and sections) are regenerated by the loop, never edited by hand.
