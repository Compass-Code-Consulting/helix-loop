# Helix Loop app: spec

Revised 2026-10-27 from the loop app spec of 2026-10-25 (`Mushy.LoopEngineering.LoopApp.2026-10-25.md`), to match the redesigned control room (`Mushy.LoopEngineering.HelixLoopDesigns.2026-10-27/Loop Control Room v2.dc.html`).
The app, formerly "the Mushy loop app", is now **Helix Loop**; the steward is now **Helix**.
What still holds from the 2026-10-25 build is kept here as it was; §19 lists every change and why, and §20 where the build differs from this spec.
Numbers quoted from the mock-ups (512 waiting, 41 tasks, 312 resolved) are illustrative, not measurements.

## 1. What it is

`helix-loop app` is one local Node process that serves one live page, the control room for a loop: a plan of hundreds or thousands of dependency-aware tasks that builders (Claude Code, Codex) work through unattended.

The page is organised around what needs Daniel, not around the chart:
- **Home** is a triage queue. Helix groups everything waiting for Daniel by shared cause, sorts the groups by how much work each holds up, and offers one action per group.
- **Map** is the Gantt chart, by task, by epic or a hybrid of both, with every finished task tied to its builder history and its commits.
- **Live** streams what each running builder is doing, as it does it.
- **Helix** is where its work is reviewed: what it resolved on Daniel's behalf, the fixes it proposes, its incidents and its conversations.
- **Settings** holds the pilot mode, the loop's controls, the builder-feedback rules, agent health, Helix's prompts, releases, and the Helix Spec and TaskSet.

The same process gives agents a small MCP endpoint in two parts: builders report progress and problems while a pass runs (§11), and Helix reads and changes the plan through it (§9).

Why the redesign: the first version showed the plan well but made Daniel hunt for what needed him, didn't show what a human task was costing the loop, gave no sense of the loop's health, and became unreadable at several hundred tasks. A person coming back after three days to 512 waiting items could not act on them one by one.

## 2. Domain language

The app, the code, the prompts and the files use these words and no synonyms.

| Term | Means |
| --- | --- |
| **Loop** | One plan being built: a control plane folder with its plan, runs and config. |
| **Helix Spec** | The technical and design specification the plan is derived from (`spec/`). |
| **Helix TaskSet** | The plan in its loadable form: lanes, epics, tasks, human tasks and their dependencies (`plan/`, §13). |
| **Lane** | A repository the loop builds. Each lane has its own merge queue and releases. |
| **Epic** | A named group of tasks inside one lane that delivers one capability. The unit the Map folds to. |
| **Task** | One atomic piece of build work: one pass, one gate, one merge. `T-####`. |
| **Human task** | Work only Daniel can do (accounts, payments, legal, judgment). `HT-##`. Tasks wait on them like any other dependency. |
| **Pass** | One builder session on one task. **Attempt** is a pass as recorded on the task. |
| **Gate** | The checks a pass's commit must pass before it merges. |
| **Builder** | The CLI that runs a pass. |
| **Helix** | The loop's AI assistant. It has two roles, **monitor** and **assistant** (§9). |
| **HITL request** | A decision the loop would put to a human: a question, a fix, a split, a park. Raised by builders or by Helix. |
| **Incident** | Repeated builder feedback with one cause, grouped by Helix (for example one flaky test failing 41 tasks). |
| **Fix** | Helix's single proposed resolution for an incident or a HITL request: a plan change Daniel accepts, edits or declines. |
| **Group** | A set of waiting items on Home with one shared cause and one action. |
| **Pilot mode** | Who decides HITL requests: **Active pilot** (Daniel, at the desk) or **Auto-pilot** (Helix, while Daniel is away). |
| **Level** | How much reaches Daniel within a mode: Cautious, Prudent, Intrepid, YOLO (§7). |
| **Cost of delay** | What a waiting item holds up: the tasks downstream of it and the time it adds to the projected finish. |

## 3. Footprint rules

- No new runtime dependencies. Node 26's `http`, `fs.watch` and `child_process`, plus the `yaml` and `ajv` already in `harness/package.json`.
- No build step, no framework, no database (§5 says why). The page is plain HTML, CSS and JS, served as files.
- The existing renderers are reused where they still fit. The Map is redrawn by the app's own page code (§6.4), because folding, the hybrid view and the frontier need a model the static export doesn't have; `helix-loop map` keeps producing the static export from the same model.
- Every loop action calls the same code as its CLI command; releases, approvals, exports and TaskSet imports run the CLI itself.
- The loop never needs the app.
  - A pass wires its builder to the app's MCP endpoint only while the app answers on its port.
  - With the app down, the loop runs as before, with one difference: on Auto-pilot the loop applies the pilot level's rules (§7) itself, and HITL requests that need Helix wait until the app is back.
- Budget: not estimated yet. The 2026-10-25 build was about 3,100 lines; §18 orders the work so each step ships on its own.

## 4. Shape

```
 browser ──HTTP + SSE──►  helix-loop app  (127.0.0.1:47320)
                            │  reads/watches: plan/, runs/, harness/config.yaml, harness/helix/
                            │  writes:        plan/ (validated), harness/config.yaml (change sets), harness/helix/,
                            │                 runs/reports.jsonl, runs/hitl.jsonl, runs/incidents.jsonl, runs/threads/, runs/helix.jsonl, runs/app.yaml
                            │  spawns:        helix-loop run (detached), Helix turns (monitor and assistant), the CLI's own commands, installs and sign-ins
 builders ──MCP──► /mcp/builder
 Helix    ──MCP──► /mcp/helix
                            ▼
                         helix-loop run   (its own process; writes runs/live.json, wires the builders' MCP while the app answers)
```

The two processes share files only, with no IPC.
That keeps both independently restartable, and the files are already the loop's interface: `runs/STOP`, `loop.lock`, the ledger, and plan edits picked up on the next round.

New or changed code:
- **`harness/src/app/`:**
  - `server.ts`: HTTP, SSE, the guards, file watching;
  - `state.ts`: what the page shows, derived from the files, including cost of delay and the epic roll-ups;
  - `triage.ts` (new): Home's groups, their order and their batch actions;
  - `actions.ts`: validated plan edits, batch edits and their commits;
  - `hitl.ts` (new): HITL requests, the pilot-mode decision table, ratings and the record;
  - `incidents.ts` (new): grouping builder feedback into incidents;
  - `config.ts` (new): reading, diffing and writing `harness/config.yaml` change sets;
  - `taskset.ts` (new): TaskSet validation, diffing against the running plan, and import;
  - `threads.ts`, `mcp.ts`, `helix.ts` (was `steward.ts`), `health.ts`, `jobs.ts`, `settings.ts`, `feed.ts`;
  - `page/`: `index.html`, `app.js`, `app.css`, `map.js` (new), `helix-bg.js` (new).
- **Loop side:** `harness/src/live.ts`, `harness/src/agents/auth.ts`, `harness/src/dryrun.ts`, and `harness/src/pilot.ts` (new: the loop's own reading of the pilot level, for when the app is down).
- **Helix's prompts:** `harness/helix/prompts/` (§9.3).
- **The Helix skill:** `skill/` (§13), packaged by `helix-loop skill pack`.

## 5. Data: files, not a database

Every source of truth is a human-readable file, and the app keeps it that way.
The views are derived from these files in memory; nothing derived is stored except the exports Daniel asks for.

| File | Writer | In git | Holds |
| --- | --- | --- | --- |
| `plan/taskset.yaml` (new) | TaskSet import, app | yes | the lanes and their epics, in order, with titles (§13) |
| `plan/tasks/T-####.yaml`, `plan/human/HT-##.yaml` | loop, app, Helix (through the app) | yes | one file per task, as before; tasks gain `epic`, attempts gain `commits` |
| `harness/config.yaml` | Daniel, app (change sets) | yes | the loop's controls, now including `pilot:` and `feedback:` (§7, §10) |
| `harness/helix/prompts/*.md` (new) | app | yes | Helix's preset prompts and Daniel's edits to them |
| `harness/helix/rules.yaml` (new) | app | yes | what Daniel's ratings taught Helix: kinds of request it now decides, or must always ask |
| `runs/runs.jsonl` | loop | no | the ledger, as before; merge entries gain the merged commit SHAs |
| `runs/agents.json`, `runs/approvals/*.json`, `runs/logs/**.log.gz` | loop | no | quota state, held releases, pass logs, as before |
| `runs/live.json` | loop | no | running passes: phase, timings, activity, builder token hashes |
| `runs/reports.jsonl` | app | no | builder reports, one per line, keyed by pass |
| `runs/incidents.jsonl` (new) | app | no | incidents: cause, members, counts, state, the fix and its outcome |
| `runs/hitl.jsonl` (new) | app, loop | no | every HITL request: who raised it, the level in force, who resolved it and how, Daniel's rating, and later its outcome |
| `runs/threads/<target>.jsonl` | app | no | comments and thread messages, as before |
| `runs/helix.jsonl` (was `steward.jsonl`) | app | no | each Helix turn: role, thread or incident, agent, model, cost, and the end of its output when it failed |
| `runs/app.yaml` | app | no | this machine's settings: Helix's agent per role, dismissed items, the last time Daniel looked at Home, panel widths and toggles |

Why still not SQLite: the plan has to stay YAML in git, because the loop, people and plan reviews read and diff it, and a database beside it would need syncing.
At 665 tasks the whole plan loads in under 200 ms.
**Scale target for this revision:** 5,000 tasks and 500 human tasks with Home, the Map's folded view and a live update each under 100 ms after load.
The model is indexed in memory (by epic, by status, by what each task waits on and what waits on it), and cost of delay is recomputed only for the part of the graph a change touches.
If loading 5,000 files ever exceeds about 1 s, the fix is a cached snapshot keyed by file mtimes, not a database.

## 6. The page

One page with a top bar and six tabs: **Home**, **Map**, **Live**, **Helix**, **Metrics** and **Settings**.
Counts on the tabs: items waiting on Home, passes running on Live, fixes waiting on Helix.

The top bar also carries:
- the Helix Loop mark and the loop's name;
- the **pilot mode and level** in force (for example "Auto-pilot · Intrepid"), which opens Settings › Pilot mode;
- the loop's state ("Running · both agents", "Stopping", "Stopped"), which opens Settings › Loop controls;
- the **Build / Dry run** switch, which picks the real control plane or the dry run's in `runs/dry-run/`.

Keyboard: `J` / `K` move between items in any list, `Enter` opens, `Esc` goes back, `⌘↩` sends or applies.

**Live updates, without a reload.**
- The server watches `plan/`, `runs/`, `harness/config.yaml` and `harness/helix/`, and sends one `changed` event over SSE (`GET /events`) per burst of changes, naming what changed.
- The page fetches only what that change needs and redraws it in place: zoom, folds, filters, the selection, scroll positions, panel widths and any text being written all carry over.
- After a reconnect the page fetches everything once.

The page lays out at phone width too: tabs collapse to a menu, side panels stack below the main area, with no sideways scroll.

### 6.1 Look

- **Nocturne**, the dark design system: its tokens, type (Inter at medium weight) and components; Phosphor icons.
- **The helix background.** Every screen has a slow, double-helix drawing behind its content: strands of points lit by depth, rungs between them, a few drifting 0s, 1s and specks.
  - It is decoration only and must never compete with content. It turns about once every three minutes, drifts slowly along a random direction and bounces softly inside the frame, and redraws at most 15 times a second.
  - It is drawn on one `<canvas>` behind the content, faded at its edges, with no pointer events.
  - Under dense content it shows through only faintly: the Map's chart sits on an 82%-opaque ground, other panels on 74%-opaque surfaces with a light blur.
  - With `prefers-reduced-motion` it draws once and stays still. It pauses while the tab is hidden.
- Status colours are used for meaning only: green for done or healthy, amber for waiting or at risk, red-orange for failing, late or production; the accent marks Helix and selection.

### 6.2 Home

Home answers "what needs me, and what should I do first?".

**Welcome back.** When Daniel has been away for more than an hour (the last time he looked at Home is in `runs/app.yaml`), a short summary leads the page, written from the ledger, not by a model:
- how long he was away and in which pilot mode;
- how many items wait, and how much of the held work the top three groups unblock;
- what merged and what failed for good since he left;
- how far the projected finish moved, and which items moved it most.

**Groups.** Everything waiting on Daniel is grouped, never listed flat:

| Group kind | Members | One action |
| --- | --- | --- |
| Your tasks | human tasks on the critical path, or due within two days | **Open checklist** (§6.3) |
| Fix ready | an incident with a fix waiting for approval | **Accept fix for N** |
| Questions | spec questions that one answer covers | **Answer once** |
| Credential | passes stopped at setup for the same missing secret | **Add the secret** |
| Scope | tasks that grew past twice their estimate, each with a proposed split | **Review splits** |
| Release | releases waiting for approval | **Review diffs** |
| Resolved | HITL requests Helix resolved on Auto-pilot | **Review unsure N** |
| Notices | low-impact warnings: slow steps, retried conflicts, one-offs | **Dismiss all** |

- Groups are built in two steps. `triage.ts` groups mechanically by what can be known exactly: the same human task, the same failing test and line, the same missing variable, the same requirement ID in a question. Helix's monitor then merges groups whose cause is the same but whose text differs, and names each group in one line. A group Helix formed shows "grouped by Helix".
- Each group shows its count, its kind, the shared cause in one line, its **cost of delay** as a bar and in words ("holds 112 tasks", "3 d of finish"), and its action.
- **Sort** is by cost of delay by default; **Group by** switches between Cause (default), Kind, Lane and None (a flat list, paged).
- A group opens in place to show its members with checkboxes, all selected. **Batch actions** apply to the selection: the group's own action, **Park all**, **Hand back** (to `ready`, with an optional note), and **Ask Helix** (opens a conversation about the selection).
- Every batch action shows what it will change before it changes it, applies as one commit, and can be undone from Helix › Incidents for 24 hours (§8).
- Groups never expire on their own; a group disappears when its members do.

**The loop panel** sits on the right and collapses to a narrow strip (progress, passes running, items Helix resolved):
- tasks merged of the total, and the projected finish with how far it moved;
- **Running now**: each pass with its agent, task, phase, time and the builder's latest report; one opens it in Live;
- slots held by an agent's weekly pace, and why;
- merges per six hours over the last three days;
- on Auto-pilot, how many HITL requests Helix resolved and how many it is unsure of, linking to Helix › Resolved for you.

### 6.3 Screens opened from a group

Each opens full-page from Home with a breadcrumb back; `Esc` returns to Home with the group still open.

- **Open checklist** (your tasks): the group's human tasks on the left, sorted by what each holds up, each with its cost-of-delay bar and lateness; Helix's one-line advice on order ("Doing HT-10 and HT-22 today pulls the finish back to Sat 7 Nov").
  The selected human task on the right: its tags, its full title, its **steps** as a checklist (ticks are saved to its notes), **Done when** (its `done_check`), an **Evidence** field, **Mark done**, **Mark in progress**, **Snooze** (hides it from Home until a date, never past the date it starts moving the finish), the **handoff prompt** with **Copy**, and what it unblocks.
  Evidence goes into the human task's notes. Helix then adds what builders need from it (an ID, never a secret) to the notes of the tasks waiting on it.
- **Answer once** (questions): what each builder asked, as quotes, beside Helix's draft answer, its confidence and the spec sections it read. Where the answer goes, as checkboxes: the notes of every task in the group (then hand them back), the Helix Spec as a numbered clarification, and a rule so future questions about the same requirement are answered this way. **Send to N tasks** or **Ask Helix to revise**.
  A clarification to the spec is written to `spec/clarifications.md`, not into the spec's sections, so the loop engineer folds it in with an Appendix B row as before.
- **Accept fix** (fix ready): the evidence on the left (failures over time against what else was happening, the counts that point to the cause, the last gate output) and, on the right, the plan change Helix would make as a diff, its confidence, and the alternatives it considered with their cost. **Accept and apply**, **Try in dry run**, **Decline**.
- **Add the secret** (credential): the variable's name, which tasks and which prepare step need it, where it belongs (keychain item, GitHub environment secret, `.env` for the dry run). The value is entered in a field that sends it straight to `security` or `gh secret set` and is never written to a file, a log or a prompt. The group's tasks are handed back once the prepare step finds it.
- **Review splits** (scope): each task that grew, with what its passes did, and Helix's proposed split as new tasks and dependencies. Accept, edit or decline each, or accept all.
- **Review diffs** (release): the reviewed paths first (`infra/`, `.github/`, as configured), the diff, Helix's one-paragraph read of the change, and a deliberate confirm: a checkbox "I've read the changes to …" enables **Approve and tag**. Releases are never approved by Helix at any level.

### 6.4 Map

The Gantt chart: lanes, epics and tasks against time, with dependencies.

**Toolbar:**
- **View: Tasks | Epics | Hybrid.**
  - *Tasks* shows every task row under its epic.
  - *Epics* shows one row per epic: a bar from its first start to its last projected finish, filled with the share merged, marked where it holds a running, failing or waiting task.
  - *Hybrid* (default) folds finished epics and epics with nothing on the frontier into one row each, and opens the rest. Any epic can be folded or opened by hand; those choices stick per epic.
- **Scope: Frontier | All | Critical path.** *Frontier* (default) opens only what is running, ready next, failing or waiting on a person, so 5,000 tasks read as a few dozen rows. *Critical path* shows only the chain that sets the finish.
- **Scale: Hours | Days | Weeks**, and a search box that finds any task and opens its row.
- A legend: done, building, ready, needs you, human task, folded epic, now.

**Rows:**
- The task column has a header "Lane › epic › task" with a **Wrap** checkbox: off, long titles are cut with an ellipsis; on, they wrap and the row grows. The choice is saved.
- The task column's width is set by dragging its edge (200–640 px; arrow keys move it 16 px; a double-click resets it). The width is saved.
- **Done is unmistakable:** a merged task's bar is solid green with a check, its row label greyed with a check glyph; a folded epic's bar fills green with its merged share. Running tasks pulse softly; failed attempts show a red notch on the bar; human tasks are diamonds; late items are hatched.
- A running task's bar carries a live label: its phase and the builder's latest report.
- "Now" is a vertical line with the date.

**The detail panel** on the right opens for the selected task and collapses to a narrow strip that keeps the task's ID and state. For a task:
- its state, lane, epic, requirement IDs and acceptance;
- **Why it stopped**, first, when it waits on a person: the latest failure or question, and what it holds up;
- the actions: hand back, park, split, add or remove a dependency, edit notes, ask Helix;
- **for a merged task:** when and by which agent it merged, its attempts, time and cost; **View diff**, **Replay pass** (its feed, from its log, in Live) and **Open on GitHub** when the repo has a remote;
- **Commits on main**: each commit the task merged, with SHA, subject, files and lines changed; a commit opens its diff in the app (`git show`, served read-only);
- **Builder history**: a timeline of the task's life: claimed, each attempt with its outcome and a Replay link, each gate with its steps, the merge with the commit, and what the merge unblocked;
- comments and threads (§9.4).

For an epic: its tasks by state, its merged share, its critical tasks and its human-task dependencies.

### 6.5 Live

Live shows what every running builder is doing as it does it. Two layouts:
- **Focus** (default): a strip of every running pass across the top (agent, task, time, its latest line), and one pass in full below.
- **Grid**: every running pass as a tile with its last few feed items, for watching several at once.

For the focused pass:
- its task and epic, agent and model, attempt, elapsed time, and counts of tool calls, commands, files changed and failures;
- **the feed**: the builder's words and thinking (when the CLI shows it), commands with what they are for and their result, edits with lines changed, runs of reads and searches as one line, reports, and failures marked. Commands open to their output.
- **its plan**: the builder's to-do list where it last changed, with the current step marked;
- **the gate**: each step's state and time once the gate starts;
- **reported to the loop**: its `report_progress` lines;
- **Helix is watching**: the monitor's one-line read of the pass, for example how it compares with the last attempt and whether it will finish inside the timeout.

**Streaming.** Yes, a builder's work streams to the page:
- Both CLIs already write a line-delimited event log for each pass (`runs/logs/`). `feed.ts` tails it from where it last read and turns each line into a feed item through the CLI's adapter (`describeClaude`, `describeCodex`).
- The page subscribes to one pass at a time (`GET /events?pass=<id>`, SSE); new items reach the page within about a second of the CLI writing them, at a few kilobytes a second.
- Items are keyed by their place in the log, so an item redraws in place when it changes and an opened command stays open. The feed follows the newest item; scrolling up pauses it, and new items collect behind "N new steps ↓".
- A finished pass replays the same way from its compressed log.

**Stepping in:**
- **Note for next attempt** adds to the task's notes for whichever builder picks it up next.
- **Send to Helix** opens a conversation with the monitor about this pass, with its feed attached.
- **Stop pass** ends this pass after a confirmation; the task goes back to `ready` with the work kept on its branch.

### 6.6 Helix

The Helix tab is where Daniel reviews Helix's work. A side list:
- **Resolved for you**: the record of HITL requests Helix resolved on Auto-pilot (§7.4).
- **Fixes to approve**: every waiting fix, across incidents, as on Home but without the human tasks.
- **Incidents**: open, watched and resolved incidents: cause, members, the counts over time, the fix and what happened after it. Every applied change can be undone from here for 24 hours.
- **Conversations**: threads with the assistant, grouped by target, open ones first, each with its state (open, your turn, answering, resolved).
- **Ask Helix**: a new conversation about anything in the loop.

### 6.7 Metrics

The metrics page, as before, labelled "Live", in a frame.

### 6.8 Settings

A side list of seven pages:
- **Pilot mode** (§7).
- **Loop controls**: the run strip, then every value the loop runs with, grouped (agents and slots, passes, gate, spend, merge and push, safety and releases). Each value shows its `config.yaml` key, a note on what it does, and its effect right now ("pace allows 1 now, so the 3rd waits"; "$173 today").
  - Each agent's build **model** and **effort** are set together (effort: low, medium, high, xhigh, as the CLI accepts).
  - Edits don't apply one by one. They collect in a change set at the bottom, listed as `key old → new`, with **Discard**, **Try in dry run** and **Apply from the next pass**. Applying writes `harness/config.yaml`, validates it against its schema, and commits it as `Config: <keys> (Daniel, in Helix Loop)`. The loop reads it at the start of its next round; nothing in flight is cut short.
  - The run strip: the loop's state, how long it has run, which agents may build, an optional pass cap, **Pause new passes**, **Start a dry run** and **Stop after current passes**.
- **Builder feedback** (§10).
- **Agents**: health of each CLI (§12).
- **Helix**: which agent runs each role, and its prompts (§9.3).
- **Releases**: each lane's unreleased tasks, holds, release cadence and reviewed paths.
- **Spec and TaskSet** (§13): the Helix skill, the state of this loop's Helix Spec and TaskSet, and importing a new TaskSet.

## 7. Pilot mode and HITL

### 7.1 Modes and levels

Pilot mode decides who resolves HITL requests. Builders always run inside their sandboxes; pilot mode governs plan changes, retries and answers, never what a builder may touch.

**Active pilot** (Daniel is at the desk). Helix brings HITL requests to Daniel as they come up, according to the level:
- **Cautious**: if in doubt, ask. Everything in Prudent, plus whenever a builder says it isn't sure how to proceed or a spec question isn't answered plainly by the spec.
- **Prudent** (default for Active pilot): everything in Intrepid, plus scope creep, changes to the architecture, and deviations from the ideal implementation that a constraint forced.
- **Intrepid**: only high-risk items, to keep the loop moving: repeated failures, anything touching security, architectural impact.

**Auto-pilot** (Daniel is away). The loop keeps building and Helix resolves what it can:
- **Intrepid** (default for Auto-pilot): Helix resolves everything except high-risk items, which park their task until Daniel is back; the rest of the loop keeps going.
- **YOLO**: Helix resolves everything itself.
- **Record HITL invocations and resolutions** (on by default): every request Helix resolves is recorded with what Active pilot at Daniel's chosen level would have asked him, and how Helix resolved it (§7.4).

Intrepid exists in both modes with the same threshold; the difference is that in Active pilot a high-risk item asks Daniel and waits, while in Auto-pilot it parks its task and the loop moves on.

### 7.2 The decision table

| Request | Cautious | Prudent | Intrepid (Active) | Intrepid (Auto) | YOLO |
| --- | --- | --- | --- | --- | --- |
| A builder isn't sure how to proceed | asks | Helix decides | Helix decides | Helix decides | Helix decides |
| Spec question the spec answers plainly | asks | Helix decides | Helix decides | Helix decides | Helix decides |
| Scope creep: a task grew | asks | asks | Helix decides | Helix decides | Helix decides |
| Compromise forced by a constraint | asks | asks | Helix decides | Helix decides | Helix decides |
| Change to the architecture | asks | asks | asks | parks | Helix decides |
| Repeated failures or a flaky test | asks | asks | asks | parks | Helix decides |
| Anything touching security | asks | asks | asks | parks | Helix decides |
| Release or approve a tag | always asks | always asks | always asks | always asks | always asks |
| Mark a human task done | Daniel only | Daniel only | Daniel only | Daniel only | Daniel only |

The table is data (`pilot.table` in `config.yaml`), so the loop and the app read the same thing.
**Floors that no level or rule lowers:** releases and approvals, anything on a reviewed path, marking a human task done, entering a secret, and changes to `harness/config.yaml` or Helix's prompts. These always wait for Daniel.

### 7.3 Ratings

In Active pilot, every HITL request Daniel sees carries **▲ Keep asking** and **▼ Decide these yourself**.
- A rating applies to the **kind** of request, which Helix names when it raises it (for example "lockfile-only merge conflicts", "any change to apps/auth"). Helix proposes the kind; Daniel can edit it before the rule is saved.
- ▼ adds a rule that Helix decides that kind from then on, at every level. ▲ adds a rule that it always asks, even on Intrepid or in Auto-pilot (where it parks).
- Rules live in `harness/helix/rules.yaml`, in git, and override the table. Settings › Pilot mode lists them ("Learned from your ratings"), each with when it was made and **Undo**.
- A rule can't lower a floor (§7.2).

### 7.4 The record

With recording on, each request Helix resolves on Auto-pilot is written to `runs/hitl.jsonl` with: when; the request and who raised it; the level Daniel compares against (his Active-pilot level, Prudent by default); what Helix chose and why; its confidence; and later its outcome (merged, still parked, or undone itself when the same failure came back).

**Helix › Resolved for you** shows the record for a period (since Daniel was last at the desk by default):
- a summary: how many requests, how many held up, how many undid themselves, how many Helix marked unsure;
- filters by what Helix did (retries, parks, quarantines, spec answers, notes);
- sort by **Unsure first** (default), impact or time;
- each item: Helix's confidence, the request as it would have been put to Daniel, what Helix did and why, and its outcome, with **Agree**, **Undo** and **Always ask** (which adds a ▲ rule);
- **Agree with the N that held**, to clear the ones whose outcome confirmed them.

Undo reverses the plan change as a new commit and reopens the request for Daniel.

## 8. Plan actions

### 8.1 Direct actions (no agent)

Each is a button.
Every edit is validated against the schema and the graph, written atomically, rendered, and committed as `Plan: <id> <what> (Daniel, in Helix Loop)`; a batch is one commit, `Plan: <action> on N tasks (Daniel, in Helix Loop)`.
An edit to a task the loop is running is refused.

- mark a human task done (with evidence), in progress, or back to to do; snooze it;
- copy a human task's handoff prompt;
- hand a `needs_human` or parked task back to `ready`, with an optional note;
- park a task;
- add or remove a dependency;
- accept, edit or decline a fix or a split;
- the batch forms of these on Home;
- the release actions in §14.

**Undo.** Every applied change (by Daniel or Helix) is recorded with the commit that made it. For 24 hours, Helix › Incidents can undo it with a reverting commit, refused if a later change touched the same task.

**Notes** keep the rules of 2026-10-26: a task's `notes` are in every build prompt; Daniel edits them in place (`⌘↩`); Helix adds to them unless asked to replace them; an unsaved draft survives a refresh with "Load theirs"; a running task's notes are read-only until its pass ends.

## 9. Helix

Helix is the loop's AI assistant. It runs as Claude Code or Codex, chosen per role in Settings › Helix among the CLIs that pass their health check (§12). Its two roles run as separate sessions with separate prompts and tools, and share one interface: the Helix tab, Home's groups and the Live view's "Helix is watching".

### 9.1 The monitor

The monitor watches the loop and keeps it healthy.
- **When it runs:** a short turn after each burst of builder reports, gate failures or ledger warnings (at most one turn a minute), and one turn every 15 minutes while the loop runs. Each turn starts from a digest the app prepares (new reports, failures, incidents and their counts), not from the raw logs.
- **What it does:**
  - groups feedback into incidents by cause, beyond what `triage.ts` matched exactly;
  - writes **one fix** for each incident: retry with a note, park, split, add a dependency, quarantine a test and add a task to fix it, or pause new passes;
  - resolves HITL requests as the pilot level and the rules allow (§7);
  - writes the one-line reads shown on Home and in Live;
  - watches incidents that haven't reached their threshold ("one more and I'll propose a split").
- **Its tools** (on `/mcp/helix`, role `monitor`): `loop_status`, `get_task`, `find_tasks`, `get_attempt_log`, `get_incident`, `group_feedback`, `propose_fix`, `apply_fix`, `resolve_hitl`, `spec_sections`, `get_spec_section`.
  `apply_fix` and `resolve_hitl` are refused unless the pilot level and the rules allow Helix to decide that kind of request; otherwise the fix waits for Daniel.

### 9.2 The assistant

The assistant answers Daniel in conversations ("T-1200 shouldn't wait on T-1180", "split this task", "why is this blocked?") and makes the plan changes he asks for. It keeps the steward's behaviour from 2026-10-25:
- one turn at a time, resuming its thread's own session (`claude --resume`, `codex exec resume`);
- tools: `get_task`, `find_tasks`, `get_attempt_log`, `loop_status`, `spec_sections`, `get_spec_section`, `update_task`, `update_human_task`, `propose_task`, `resolve_thread`;
- a new task exists only once Daniel clicks **Accept and create**;
- `resolve_thread` is refused until it has answered at least once, unless Daniel pressed **Resolve**.

**Both roles have no built-in tools.** Everything they can do is a tool on `/mcp/helix`, so their limits are the app's, not their prompts'. Claude runs with `--tools ""`, `--system-prompt`, and `--strict-mcp-config` with only this server; Codex runs in its `read-only` sandbox with this server's tools approved up front. Both run from a folder outside the control plane.

**Every write is checked by the app before it lands:** the whole plan, as changed, must pass the schema and graph checks; the task must not be one the loop is running; the pilot level and rules must allow it. A refused write returns the problems to Helix, which says what would pass. An accepted one is committed as `Plan: <id>: <why> (Helix <role>, <incident or thread id>)`.

Helix never changes the spec, the config, its own prompts or code; it has no tool for them. A spec change is proposed as a clarification Daniel sends (§6.3) or applied by the loop engineer.

### 9.3 Prompts

Each role has a preset prompt per level, in `harness/helix/prompts/` (for example `monitor.auto-intrepid.md`), shipped with the app and editable in Settings › Helix and Settings › Pilot mode.
- An edited prompt is saved beside its preset as `<name>.local.md`, in git, and marked "edited" with **Reset to preset**.
- The prompts describe judgment; the limits are enforced by tools and floors, so an edit can change how Helix decides but not what it may do.

The monitor's preset for Auto-pilot · Intrepid, for example:

```
You run the loop while Daniel is away. Resolve every HITL request you can and record what you were asked, what you chose and why.
Park a task instead of resolving it when it touches security, changes the architecture, or keeps failing.
Group repeated failures by cause. For each group propose exactly one fix from: retry with a note, park, split, add a dependency, quarantine a test and add a task to fix it, pause new passes.
Read what you need with the tools before you decide; never guess what a task or a log says.
State your confidence as a percentage, and mark a decision unsure below 70%.
Be extremely concise: one sentence for what happened, one for the fix. Plain text, no Markdown.
```

The assistant's preset is the steward prompt of 2026-10-25, with "the plan assistant in the Mushy loop app" replaced by "Helix, the assistant in Helix Loop".

### 9.4 Comments and threads

As on 2026-10-25, with the steward renamed Helix: root comments and one level of replies; each root comment starts its own thread, keyed by target and root (`T-0034#c3`); a target is a task, a human task or a dependency edge; Helix replies only in the thread; the summary is posted under the root comment with "Full conversation →"; a reply under a root reopens its thread; one append-only file per target in `runs/threads/`, with `author` now `daniel` or `helix`.

Conversations about an incident or a selection on Home (**Ask Helix**) are threads too, targeted at the incident (`I-0012`) or at a saved selection.

## 10. Builder feedback

Builders report what is in their way with `report_issue` (§11). Each report has a **kind**:

| Kind | Means |
| --- | --- |
| `spec_question` | the spec is ambiguous or silent on something the task needs |
| `gate_failure` | recorded by the loop, not the builder: the same gate step failed |
| `flaky_test` | a test fails intermittently, on this task or others |
| `blocked_on_human` | the task needs something a human task provides |
| `credential_missing` | a secret, environment variable or access is missing |
| `scope_grew` | the task is bigger than planned |
| `conflict` | merge conflicts, or main diverged under the task |
| `environment` | sandbox, network or tooling problems |

Settings › Builder feedback sets, per kind:
- **Send to**: Inbox (Home, as its own group), Helix (the monitor handles it and brings a fix), or Off;
- **After**: a threshold before it is raised (first time, N times on one task, or N tasks);
- **Pause**: whether the task stops at once (for example on `credential_missing`) or keeps retrying;
- **Notify**: a macOS notification outside the app.

**Per-lane overrides** replace any of these for one lane (for example `mushy-website` sends `scope_grew` to the Inbox and notifies).
The rules are `feedback:` in `harness/config.yaml`, so the loop applies Pause and Notify itself when the app is down.

Reports are advisory; status and outcomes stay with the gate, the merge queue and the ledger.

## 11. MCP for builders

**Transport** unchanged: streamable HTTP, stateless, JSON responses only, about 150 lines of hand-written JSON-RPC shared by `/mcp/builder` and `/mcp/helix`.

**Two tools, on purpose.** A prompt goes in, a commit comes out, the gate decides; builders don't hold the loop's levers.

| Tool | Arguments | Effect |
| --- | --- | --- |
| `report_progress` | `message` (≤ 144 characters) | Shown live on the task's bar, in Live and on Home's Running now. |
| `report_issue` | `kind` (§10, except `gate_failure`); `message`; optional `paths`, `blocking` (true when the builder can't go on) | Routed by the feedback rules; added to the attempt's note when the pass ends. |

**Wiring** unchanged: a random token per pass, its hash in `runs/live.json`; the builder gets the server only if the app answers `/health` within a second; Claude through `--mcp-config` with `--strict-mcp-config`; Codex through `-c mcp_servers.helix.url=…` with `default_tools_approval_mode="approve"` and `--ignore-user-config`; the token binds every call to its pass.

## 12. Agent health

As on 2026-10-25: one row per CLI with four lights (Installed, Subscription, Helix key, Working), each red light offering its fix after a confirmation that shows the exact command.

| | Installed | Subscription | Helix key | Working |
| --- | --- | --- | --- | --- |
| Builders (Start) | required | required | never used | required |
| Helix (either role) | required | either this… | …or this | required |

**Builders use subscriptions only.** An API key bills per token with no ceiling but the daily cap, and an unattended loop is where costs run away. The rules hold as built: the Helix key is kept in the macOS keychain ("Helix Loop: Helix Anthropic API key", "Helix Loop: Helix OpenAI API key"), enters only Helix's own process, never a CLI's shared sign-in; adapters strip `ANTHROPIC_*`, `OPENAI_*` and `CODEX*` from builders; the loop checks each CLI's sign-in at start and every ten minutes, and an agent not on its subscription takes no task.

Helix's spend is recorded per turn in `runs/helix.jsonl`, by role, shown beside the builders' and counted toward that agent's daily budget. The monitor's turns are short and digest-fed so that watching the loop costs little; its daily spend has its own cap (`helix.monitor.daily_budget_usd`), after which it stops and Home says so.

## 13. Helix Spec, Helix TaskSet and the Helix skill

### 13.1 The skill

The **Helix skill** gives any agent harness (Claude Code, Codex, OpenCode or another) the guidelines to write a Helix Spec and break it into a Helix TaskSet this loop can run. It is used offline, before a loop exists or between revisions, so it lives under Settings › Spec and TaskSet, not in the main tabs.

- Settings offers the skill as `helix-skill.zip`, with a choice of harness that sets the install command (for example `helix-loop skill install --to ~/.claude/skills/helix`) and **Read SKILL.md**.
- Its commands:
  - `/helix spec`: interview Daniel, then write the technical and design spec with numbered requirements and acceptance criteria;
  - `/helix harden`: find the gaps and ambiguities a builder would ask about, before any task exists;
  - `/helix taskset`: break the spec into lanes, epics and atomic tasks (one pass, one gate each), plus the human tasks only a person can do, with dependencies;
  - `/helix validate`: check the TaskSet against the schema and the rules below.
- Its contents: `SKILL.md`; guides (`spec-technical.md`, `spec-design.md`, `decompose.md`, `atomic-tasks.md`, `human-tasks.md`); `schema/` (`taskset`, `task` and `human` JSON schemas, the same files as `plan/schema/`); `examples/mini-taskset/`; and `scripts/validate.mjs`, which runs the same checks as `helix-loop validate` with no dependencies.
- The guides are drawn from the plan conventions and spec-hardening documents already in `plan/`. `helix-loop skill pack` builds the zip from `skill/` and the current schemas, so the skill never drifts from what the loop accepts.

### 13.2 The TaskSet format

A TaskSet is the `plan/` folder:

```
plan/
  taskset.yaml          lanes and their epics, in order
  tasks/T-####.yaml     one file per task
  human/HT-##.yaml      one file per human task
  schema/               taskset, task and human schemas
```

`taskset.yaml`:

```yaml
version: 1
lanes:
  mushy-social-media:
    repo: mushy-social-media
    epics:
      seed-data:
        title: Seed data & allowances
        stage: day1
```

Changes to the task schema:
- `epic` (new, required): the epic's key in its lane. The lane is the task's `repo`.
- `attempts[].commits` (new): the SHAs the attempt committed, and `attempts[].merge` the merge commit on main, written by the loop when it merges.
- Everything else as before (`stage`, `area`, `feature`, `reqs`, `spec`, `acceptance`, `blocked_by`, `estimate_passes`, `status`, `claimed_by`, `attempts`, `notes`).

**Migration of the current plan:** `helix-loop taskset init` writes `taskset.yaml` with one epic per (`repo`, `feature`, `stage`), and sets each task's `epic`. Daniel or the loop engineer renames and merges epics afterwards.

**Validation** (on import and on every plan change): every task is in a lane and an epic; no dependency cycles; every requirement maps to at least one task; every task fits one pass (its estimate is under the pass timeout); every task names an acceptance test (a warning, not an error).

### 13.3 This loop's Spec and TaskSet

Settings › Spec and TaskSet shows the path from Spec to TaskSet to Loop, each with its state (hardened, valid, running), its counts, and its actions (open the spec, re-harden, open on the Map, export, open Loop controls, history).

**Import a TaskSet** (a folder or a zip):
- the app validates it, then diffs it against the running plan: tasks and epics added, tasks whose dependencies changed, tasks removed (only tasks not yet started may be removed), and how far the projected finish moves;
- merged and running tasks are kept as they are, whatever the import says;
- **Try in dry run** runs the imported plan in `runs/dry-run/`; **Apply to the loop** writes it as one commit, `Plan: import TaskSet rev N (Daniel, in Helix Loop)`.

## 14. Parity with the CLI and the loop

| CLI | In the app |
| --- | --- |
| `run [--max-passes N] [--agents …]` | Settings › Loop controls run strip, or the state in the top bar. |
| `run --dry-run` | **Start a dry run**, and **Try in dry run** on config change sets, fixes and TaskSet imports. |
| `touch runs/STOP` | **Stop after current passes**; new: **Pause new passes** (`runs/PAUSE`), which lets passes in flight finish and starts no new ones until resumed. |
| `status`, `stats` | Home's loop panel; Live. |
| `map` | The live Map; **Export** runs `helix-loop map`. |
| `metrics` | The live Metrics; **Save metrics version** runs `helix-loop metrics`. |
| `validate` | Run on every plan change; plan health in Settings › Spec and TaskSet. |
| `render` | After every plan edit the app makes. |
| `release`, `approve-release` | Settings › Releases and Home's release group (**Review diffs**). |
| Editing `harness/config.yaml` | Settings › Loop controls, Pilot mode and Builder feedback, as change sets. |
| Hand-editing task YAML | Direct actions (§8) and Helix (§9). |
| new: `taskset init`, `taskset import <path>` | Settings › Spec and TaskSet. |
| new: `skill pack`, `skill install --to <dir>` | Settings › Spec and TaskSet. |
| `index`, `stage-check`, `promote`, `sections` | CLI only, as before: they belong to the loop engineer and the planners. |

The binary is renamed `helix-loop`; `mushy-loop` stays as an alias until the next release.

## 15. Security

- The app binds `127.0.0.1` only and refuses any `Host` but `127.0.0.1:<port>` or `localhost:<port>`.
- Every state-changing request needs the launch token sent as a header; a foreign `Origin` is refused.
- `/mcp/builder` needs a live pass token; `/mcp/helix` needs the running Helix turn's token, which also carries its role, so the assistant can't call the monitor's tools or the reverse.
- Installs, sign-ins, starting the real loop, stopping, releases, approvals, config change sets and TaskSet imports each ask for confirmation first, showing exactly what will change.
- The floors of §7.2 are enforced in `hitl.ts` and in the tools, not in prompts; YOLO doesn't lift them.
- Secrets entered in **Add the secret** go straight from the request to `security` or `gh secret set` on standard input, and are never logged, stored, shown again or put in a prompt.
- Diffs and logs are served only from the loop's repos and `runs/logs/`, by checked relative paths, read-only.
- Tokens are random per launch, per pass and per Helix turn; only their hashes reach disk.

## 16. Out of scope

- A2A: builders are one-shot processes and MCP covers what they need to say.
- Remote access, accounts, more than one viewer at a time.
- Editing the spec's sections from the page (clarifications go to `spec/clarifications.md`).
- The planners' pipeline (`stage-check`, `promote`) and `index`.
- Helix editing the config, its own prompts or code.

## 17. Decisions for Daniel

1. **The monitor's agent.** Claude by default, as for the assistant; Codex is cheaper per turn but can still read files through its shell.
2. **The record's comparison level.** Resolved for you compares against Daniel's Active-pilot level (Prudent by default). The alternative is always comparing against Cautious, which records more.
3. **Rules in git.** `harness/helix/rules.yaml` and edited prompts are committed, so they survive a fresh checkout and show in review. The alternative is keeping them per machine in `runs/app.yaml`.
4. **Undo window:** 24 hours.
5. **Clarifications file.** Answers sent "into the Helix Spec" land in `spec/clarifications.md` for the loop engineer to fold in, rather than editing spec sections directly.
6. **Epic migration:** one epic per (`repo`, `feature`, `stage`), renamed by hand afterwards.

## 18. Build order

Each step ships on its own and leaves the loop runnable.

1. **Renames** (`helix-loop`, Helix, file names) with aliases; the Nocturne page shell, the tabs and the helix background.
2. **TaskSet:** `epic`, `taskset.yaml`, `taskset init`, attempts' commits; validation.
3. **Map:** Tasks / Epics / Hybrid, Frontier / All / Critical path, done styling, Wrap, column resize, the collapsible detail panel, builder history and commits.
4. **Home:** cost of delay, `triage.ts` groups, batch actions, undo, Welcome back, the collapsible loop panel; Open checklist and Review diffs.
5. **Live:** Focus and Grid, per-pass SSE, plan and gate panels, Stop pass, Note for next attempt.
6. **Builder feedback:** the new kinds, the rules in config, Pause and Notify in the loop, the Settings page.
7. **Helix monitor:** digests, incidents, `propose_fix`, Fixes to approve, Accept fix, Answer once, Add the secret, Review splits.
8. **Pilot mode:** the table in config, `hitl.ts`, ratings and rules, the record and Resolved for you; the loop's own reading for when the app is down.
9. **Loop controls:** the config change sets, effort per model, Pause new passes.
10. **Spec and TaskSet:** the skill, `skill pack`, import with diff and dry run.

## 19. Changes from the 2026-10-25 spec

- **Renamed:** the app is Helix Loop (`helix-loop`); the steward is Helix; `steward.jsonl` is `helix.jsonl`; `/mcp/steward` is `/mcp/helix`; the keychain items are renamed.
- **Home replaces the Inbox** and leads the page. Items are grouped by cause and sorted by cost of delay, with batch actions and undo, so 500 waiting items read as a handful of groups.
- **The sidebar's Loop, Inbox and Threads tabs** became Home's loop panel, Home's groups and Helix › Conversations.
- **The Map is drawn by the app**, not the static export in a frame, to support Tasks / Epics / Hybrid views, the frontier, folding, Wrap and a resizable task column at 5,000 tasks. Finished work is visually distinct, and each task links to its builder history and its commits.
- **Epics are new:** lane › epic › task, with `epic` on every task and `plan/taskset.yaml`.
- **Live** is a tab of its own, with a Focus and a Grid layout; the agent view's feed moved there, with Stop pass and Note for next attempt.
- **Helix has two roles.** The monitor, new, watches the loop, groups incidents and proposes one fix each; the assistant is the old steward.
- **Pilot mode is new**: Active pilot (Cautious, Prudent, Intrepid) and Auto-pilot (Intrepid, YOLO), a decision table in config, floors no level lowers, ▲▼ ratings that teach rules, and a record of what Helix resolved on Auto-pilot.
- **Builder feedback** has eight kinds (was four) and per-kind rules for routing, thresholds, pausing and notifying, with per-lane overrides.
- **The config is editable from the page**, in Settings › Loop controls, as validated, committed change sets; effort is set with each model. This was out of scope before.
- **Helix's prompts are editable presets**, per role and level, with Reset to preset.
- **Spec clarifications** can be sent from Answer once to `spec/clarifications.md`.
- **The Helix skill and TaskSet import** are new, under Settings › Spec and TaskSet.
- **Pause new passes** is new, beside Stop.
- **Scale target:** 5,000 tasks and 500 human tasks.

## 20. As built

Built 2026-10-27 on the branch `loop-app`, in the worktree beside the control plane.
The real loop was not touched: the app was checked against its files read-only, with every write blocked, and every action was exercised on temporary control planes in the tests.

### 20.1 Where the build differs from this spec, and why

1. **`epic` is optional in the task schema, and epics are derived until the TaskSet is written.**
   Making it required would fail the running plan's validation the moment this merges.
   Without `plan/taskset.yaml`, each (repo, feature, stage) is an epic, exactly as `helix-loop taskset init` writes them.
   Writing them is a change to the real plan, so it waits for Daniel: Settings › Spec and TaskSet has the button.
2. **The loop doesn't write `attempts[].commits`.**
   A task's commits on main are exactly the ones between the previous merge into its repo and its own, which the ledger's merge entries and git already give, for every task merged before this build too.
3. **Pause and Notify are applied by the app, not the loop.**
   Builders can report only through the app's MCP endpoint, so with the app down the only feedback is a gate failure, which the loop already records.
   The rules still live in `feedback:` in `harness/config.yaml`.
4. **Helix's monitor is off until Daniel turns it on** (`helix.monitor.enabled`, Settings › Helix), and then runs at the Light level (item 16).
   Every monitor turn draws on the same subscription as the builders, and on Auto-pilot it changes the real plan.
5. **A fix can't quarantine a test yet.**
   That needs each product repo's gate to honour a skip list, which the gates don't have.
   Fixes are made of what the plan can express: hand back, park, notes, a new task, a dependency added or removed, and pausing new passes.
6. **"Tasks that grew past twice their estimate"** counts passes that ran out of time.
   A gate failure is the code's, and goes into the group for its cause.
7. **The projected finish includes human tasks' lead times, and assumes waiting tasks are handed back now.**
   `helix-loop status` now prints the same projection (item 16); the static dependency map still uses its own, which leaves people out: on 2026-10-27, HT-10's 44-day lead time set the difference.
   Without assuming the hand-backs, four tasks that needed Daniel would have left 208 of 416 open tasks with no date.
8. **Cost of delay:** each group shows the tasks it holds up, counted once.
   "N d of finish" is shown where it can be computed honestly: for human tasks, how much sooner the finish would be had they been done now.
   For a waiting task, the checklist and the Map say how much a day's wait moves the finish.
9. **Feed times:** an item has a time only when the app saw its line written.
   CLI event logs carry none, so a log read whole shows its items without times.
10. **Helix's preset prompts ship with the app's code** (`harness/helix/prompts/`); a loop's own edits are saved in its control plane as `<name>.local.md`.
11. **Add the secret** sends the value to a GitHub environment secret (`gh secret set`) or the macOS keychain (`security`), on standard input.
    It offers no `.env` for the dry run, since that would write the value to a file.
12. **The task schema still lists Mushy's repos and stages.**
    A TaskSet for another product would fail it; the lanes in `taskset.yaml` should decide which repos are valid.
13. **Monitor tools beyond §9.1:** `raise_request` (a request Helix may not decide, brought to Home with its options and ▲▼ ratings), `note_pass` (the one-line reads in Live), and `note_tasks` (notes from a human task Daniel just finished).
14. **Builders' MCP server is called `helix`** (`mcp__helix__report_progress`); logs that call it `mushy` still read.
    `report_issue` takes the seven kinds of §10 a builder can raise, and `blocking`.
15. **A note for a running task** waits in `runs/pending-notes.jsonl` and lands when its pass ends, since the loop owns a task while it runs.
16. **Two finish dates: Code complete and Project complete.**
    Project complete is the projection of item 7, with each human task taking its lead time, and it waits for the last human task too: a launch or review step no builder task waits on still ends the project.
    Code complete runs the same projection with every human task done now, so it is when the last builder task would merge if nobody kept the build waiting: on 2026-10-27, Sun, Nov 1 against Wed, Nov 18, HT-10's 44 days being the difference.
    The TaskSet chooses with `timelines` in `taskset.yaml`: `[code, project]` (the default, and what `taskset init` writes) or `[project]`, and the `/helix taskset` skill asks the owner which.
    Home, the loop panel, the Map (a dashed purple line beside the red one), Settings › Spec and TaskSet, `helix-loop status` and Helix's `loop_status` show both, or only Project complete.
    Cost of delay ("N d of finish", the checklist's advice) stays measured on Project complete, since Code complete by definition doesn't move with a person's work.
17. **The monitor has three levels** (`helix.monitor.level`, Settings › Helix), each a preset of when it takes a turn, on which model, and its daily cap at list price.
    Light, the default, takes a turn only when something needs judgment: a failed pass that repeats an open incident or is its task's second failure, a builder's issue, a human task Daniel finishes, and his own "Ask Helix to revise" and "Run a turn now".
    It runs Sonnet 5.5 at low effort on Claude Code (the build model at low effort on Codex), has no heartbeat, offers no `note_pass`, and stops at $5 a day.
    Standard adds a turn every 30 minutes while the loop runs and the reads of running passes, on Sonnet 5.5 at medium effort on Claude Code (on Opus its half-hourly turns alone would reach the cap), capped at $15; Thorough is the first build's behaviour, a turn after every pass and every 15 minutes, at high effort, capped at $30.
    Light is the default because the monitor shares the builders' subscription, Claude's most of all, and most of what happens in a loop needs no judgment: a merge, or a first failure the retry fixes.
    As first built, the monitor took a turn on every ledger change and every 15 minutes, on Opus, about $0.25 a turn: 8 to 12 turns an hour, enough to reach a $20 cap in 7 to 10 hours.
    On the real loop's last 24 hours (94 passes, about half of them failed), Light would have taken 26 turns, about $2; Standard 62 and Thorough 145, both running into their caps.
    Settings › Helix shows that estimate for each level, from the last 24 hours of `runs/runs.jsonl` and `runs/reports.jsonl` and the cost of the monitor's own turns in `runs/helix.jsonl` (estimated per turn until there are some).
    A cap or model (`helix.monitor.model.<agent>`) set in the config holds at every level, and a heartbeat (`every_minutes`) at Standard and Thorough; Light never runs on a schedule.

### 20.2 Status and verification

- `helix-loop app` serves the page from `harness/src/app/page/`: `core.js`, `home.js`, `screens.js`, `map.js`, `live.js`, `helixtab.js`, `settings.js`, `boot.js`, `helix-bg.js`, with Nocturne, Inter, JetBrains Mono and the Phosphor icons it uses served locally.
- Server modules: `board.ts` and `projection.ts` (the Map and cost of delay), `triage.ts` (Home), `incidents.ts`, `hitl.ts` (pilot mode, rules, the record), `fixes.ts` and `changes.ts` (batches and undo), `config.ts` (change sets), `taskset.ts`, `prompts.ts`, `views.ts`, and `helix.ts` (was `steward.ts`).
- Loop side: `runs/PAUSE` and `runs/stop-pass/<task>.json`, with a `stopped` outcome that doesn't count toward the cap.
- CLI: `helix-loop` (`mushy-loop` still works), with `taskset init`, `taskset import`, `skill pack`, `skill install`, and `run --dry-run --config-changes | --plan-changes`.
- Tests: `test/helix.test.ts` (the projection, the board, epics, imports, pilot decisions and floors, incidents, Home's groups, config change sets, batches and undo, the monitor's guarded tools, its levels, triggers and estimates, and the endpoints), `test/skill.test.ts`, the updated `test/app.test.ts`, and the pause and stop-pass scenarios in `test/dryrun.test.ts`.
- Checked by eye on the real loop's data at 1440 × 900 and at 820 wide, against each mock-up, with no console error.
