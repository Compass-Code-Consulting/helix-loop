# The Helix skill

The Helix skill teaches Claude Code and Codex to write the three documents a loop runs on, with you, offline:

- **`/helix spec`:** a Helix Spec, a technical and design specification with numbered requirements, section by section.
- **`/helix harden`:** reads the spec as a builder would, and lists what a builder would have to guess, for you to settle.
- **`/helix taskset`:** breaks the spec into a TaskSet, Lane › Epic › Feature › Story › Task: epics as outcomes, features as vertical slices, user stories as needs, tasks a builder can finish and test in one pass, human tasks with lead times, and the dependencies between them.
  It asks whether you want two finish dates (code complete and project complete) or one.
- **`/helix milestones`:** orders the delivery as milestones you can demo, from a walking skeleton to the thinnest valuable path to breadth, resolving every dependency that points to a later milestone with a placeholder and a wiring task or by pulling it forward; it asks you to confirm the list, then applies it.
- **`/helix validate`:** checks a TaskSet the way the loop will, with only Node: the schemas, every dependency, no cycles, the hierarchy and its sizes, the milestones and their placeholders, estimates, acceptance tags, no secret values, and requirement coverage.

## Installing it

```sh
helix-loop skill install                   # asks: globally or into one project, and for which agents
helix-loop skill install --global --agent both
helix-loop skill install --project .       # this project only: .claude/skills/helix and .codex/skills/helix
helix-loop skill                           # its version, and everywhere it is installed
```

Installed globally, it goes in `~/.claude/skills/helix` and `~/.codex/skills/helix` (or `$CODEX_HOME/skills/helix`).
Installing again updates it in place; the skill carries the schemas of the Helix Loop it came with.

`helix-loop skill pack` writes `helix-skill.zip`, for places a folder can't go, such as a skill upload.

## From the skill to the loop

The skill writes the spec into `.helix/spec/` and the TaskSet into a folder of your choosing.
`helix-loop spec index` indexes the spec; `helix-loop taskset import <folder>` shows what the TaskSet would change in the plan, and `--apply` brings it in as one commit.
Importing again later, after the spec grows, keeps every merged, running or attempted task as it is, removes only tasks nobody has started, and asks for the milestones to be planned again.
`/helix milestones` runs `helix-loop milestones check <folder>` on its proposal, and `helix-loop milestones apply <folder>` once you agree; each application, like each import, is a new revision of the TaskSet, the old one kept in `.helix/plan/history/`.
