# The app

`helix-loop app` serves the control room on `http://127.0.0.1:47320`, for this machine only.
It and the loop share only files, so either can restart without the other.
Most of what the app does has a command too; this page names it beside each screen.
What stays in the app is visual: the Map's chart, Live's grid of passes, and the metrics' charts.

## Home

Everything that waits on you, grouped by shared cause and sorted by how much work each group holds up, with what to do first, and each milestone the loop reached, for you to review its demo.
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

The TaskSet against time, from the projection: the critical path, what is running, what failed, what waits on a person, the two finish dates as dashed lines, and each milestone as a dotted line with its number and title.

- **View**, from the widest to the narrowest: Lane, Epic, Feature, Story and Task show one row per item of that level, each with a bar from its first task's start to its last projected finish and its progress; Hybrid nests Lane › Epic › Feature › Story › tasks, folding what is finished or has nothing on the frontier.
  The toolbar says how many the view holds: "54 epics", or for Hybrid "4 lanes · 20 epics · 61 features · 190 stories · 765 tasks".
- **Scope:** Frontier (what is running, next, failing or waiting on a person), All, or the Critical path.
- **Milestone:** one milestone's work alone, each item rolled up from it, with the human tasks it waits on; clicking a milestone's title on the timeline does the same.

Pinch on a trackpad to zoom the time scale; Hours, Days and Weeks are presets.
Selecting a task opens its detail: where it sits (Lane › Epic › Feature › Story), its milestone and demo, the placeholder it is built against or wires in, why it stopped, its builder history, its commits on main, its notes.
Selecting a lane, an epic, a feature or a story shows its outcome or need, its progress and its tasks by state.
`helix-loop task <id>`, `helix-loop tasks --under <key>` and `helix-loop milestones` show the same; `helix-loop plan map` writes a static version of the chart.

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
| Spec and TaskSet | `helix-loop taskset`, `helix-loop taskset import`, `helix-loop milestones apply`, `helix-loop taskset history`, `helix-loop skill install` |
