# Migrating

## A control plane from before .helix/

Before Helix Loop stood alone, a project ran the loop from inside itself: the spec in `spec/`, the plan in `plan/`, the build prompt in `prompts/`, the config in `harness/config.yaml`, and the loop's files in `runs/`, `repos/` and `worktrees/`.
`helix-loop migrate` moves each into `.helix/`.

```sh
helix-loop migrate --name Mushy --owner Daniel --timezone America/Chicago            # says what it would do
helix-loop migrate --name Mushy --owner Daniel --timezone America/Chicago --apply    # does it
```

- The loop must be stopped first.
- Tracked files move with `git mv`, so their history follows; the rendered documents take their new names (`ImplementationPlan.md`, `HumanImplementationPlan.md`, `DependencyMap.html`).
- `runs/`, `repos/` and `worktrees/` move as they are, and each repository re-links the pass worktrees that moved with it.
- The config gains a `project` block from the options, and `env_prefix` with `--env-prefix` when the product's scripts read the loop's variables under another prefix.
- Anything it doesn't recognise stays where it is, and is listed: the old harness code, planning notes, the old schemas.

Then check and commit:

```sh
helix-loop doctor
helix-loop validate
git status && git commit
```

The run history carries over: the ledger and the logs keep their paths relative to `.helix/`.

## From a version 1 TaskSet

A version 1 TaskSet was Lane › Epic › Task, with each task naming its `epic` and its `stage`, and stages gating the work.
Version 2 is Lane › Epic › Feature › Story › Task, with each task naming its `story`, and the delivery order in Helix Milestones instead of stages.
`helix-loop validate` reports a version 1 TaskSet as one error that points here, and the loop doesn't run it.

Convert it with the Helix skill, in Claude Code or Codex in the project folder:

1. Ask it to regroup the current plan with `/helix taskset`: each epic becomes an outcome, its tasks grouped into features and user stories, and every task given its `story` in place of `epic`, `stage` and `feature`.
   Merged, running and attempted tasks keep their ids, state and notes; only their grouping changes.
2. Check the folder it wrote with `/helix validate`, then bring it in with `helix-loop taskset import <folder> --apply`.
   The version 1 TaskSet is kept in `.helix/plan/history/r1/`, and the new one becomes revision 2.
3. Order it with `/helix milestones`.
   The old stages are a good first draft of the milestones, but name each as an outcome with a demo, never "Day N", and resolve every dependency that points to a later milestone.
4. `helix-loop validate` is clean, and the loop runs again.

Nothing else changes: the ledger, the logs and the merged work carry over, and the app's saved Map view (Tasks or Epics) reads as Task or Epic.
