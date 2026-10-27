# The app

`helix-loop app` serves the control room on `http://127.0.0.1:47320`, for this machine only.
It and the loop share only files, so either can restart without the other.
Most of what the app does has a command too; this page names it beside each screen.
What stays in the app is visual: the Map's chart, Live's grid of passes, and the metrics' charts.

## Home

Everything that waits on you, grouped by shared cause and sorted by how much work each group holds up, with what to do first.
Each group acts on all its members at once (hand them back, open the checklist, answer once, accept a fix), and every change can be undone for a day.

| In the app | From the CLI |
| --- | --- |
| The groups, and what each holds up | `helix-loop inbox` |
| Hand back, park | `helix-loop task hand-back <id...>`, `helix-loop task park <id...>` |
| The human tasks' checklist | `helix-loop human`, `helix-loop human done <id>`, `helix-loop human step <id> <n>` |
| Accept, decline or try a fix | `helix-loop fix accept <key>`, `fix decline`, `fix dry` |
| Answer once | `helix-loop answer <key> <text>` |
| Undo | `helix-loop changes`, `helix-loop undo <id>` |

## Map

Lanes, epics and tasks against time, from the projection: the critical path, what is running, what failed, what waits on a person, and the two finish dates as dashed lines.
Pinch on a trackpad to zoom the time scale; Hours, Days and Weeks are presets.
Selecting a task opens its detail: why it stopped, its builder history, its commits on main, its notes.
`helix-loop task <id>` shows the same detail; `helix-loop plan map` writes a static version of the chart.

## Live

Every pass in flight, as its builder works: its messages, its commands and their results, the gate's steps.
Stop a pass, or leave a note for its next attempt.
`helix-loop watch [task]` follows passes in the terminal; `helix-loop pass stop <task>` and `helix-loop task note <id> <text>` do the rest.

## Helix

What Helix resolved for you, the fixes waiting for approval, the incidents and the undo list, and your conversations with Helix.
`helix-loop incidents`, `helix-loop asks` and `helix-loop ask "<question>"` cover them from the CLI.

## Metrics

Progress and its projection, where the time goes, what it costs, and what fails, kept as a version every hundred passes.
`helix-loop metrics` writes a version now; `helix-loop stats` prints the time and cost per agent.

## Settings

| Page | From the CLI |
| --- | --- |
| Pilot mode | `helix-loop pilot`, `helix-loop rules` |
| Loop controls | `helix-loop config`, `helix-loop config set <key> <value>` |
| Builder feedback | `helix-loop feedback` |
| Agents | `helix-loop doctor`, `helix-loop status` |
| Helix | `helix-loop monitor`, `helix-loop prompts` |
| Releases | `helix-loop releases`, `helix-loop release run`, `helix-loop release approve` |
| Spec and TaskSet | `helix-loop taskset`, `helix-loop taskset import`, `helix-loop skill install` |
