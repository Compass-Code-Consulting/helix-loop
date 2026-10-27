# Migrating a control plane from before .helix/

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
