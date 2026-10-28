# Writing the technical spec

The Helix Spec is what every builder reads, a few sections at a time.
A builder never sees the whole spec: the loop injects only the sections and requirements its task cites, plus the glossary.
So write each section to stand on its own, and give every requirement an ID the loop can find.

## How the loop reads the spec

The loop splits the spec into sections by its headings and builds an index from requirement IDs to their text.
That index is what tasks cite and what coverage is checked against, so the format is not a style choice.

- **One Markdown file**, the canonical spec, kept in the control plane's `spec/` folder.
- **Numbered top-level sections**: `## 11. Publishing and the queue`. Their key is `§11`.
- **Subsections** under them: `### Composer`, keyed `§11 Composer`, or numbered `### 10.5 MCP server`, keyed `§10.5`.
- **Appendices**: `## Appendix B. Changelog`, keyed `App. B`.
- **Requirements** are list items that start with a bold ID: `- **PB-1 On time:** scheduled posts go out within 60 seconds of their slot.` The ID is one to five capital letters, a hyphen and a number, with an optional letter (`PB-14`, `SEC-3a`).
- **The glossary** is one section, injected into every builder's prompt; keep it short.
- **The version** is the newest row of the changelog appendix, which lists newest first: `| v0.7 | Oct 23, 2026 | Folded in the hardening |`.

A task's prompt, with the spec text it cites, must fit a budget (about 40 KB in the loop this skill comes from).
Keep each subsection self-contained and under a few kilobytes, so a task can cite exactly what it needs.

## Structure

Write the spec in this order.
Sections that don't apply are left out, not left empty.

1. **§0 Building from this spec.**
   The repositories (each becomes a lane) with what each holds and where it runs; the hosts; what decomposing the spec must produce (the TaskSet and its human tasks); the tools the owner's agent may use for human tasks.
   Read first by every planner.
2. **Overview and principles.** What the product is, in one paragraph; the principles that settle trade-offs; goals; what is not in the first release.
3. **Users and their jobs.** Personas and the jobs they hire the product for. Requirements trace back to these.
4. **Launch scope.** What ships at launch and what follows, by name, so no planner has to infer it.
5. **One section per epic**, named for its outcome, with a subsection per feature, each ending with `### Requirements`.
   Prose first (how it works, states, rules), then the user stories, then the numbered requirements (below).
6. **Architecture and data model.** Stack choices with versions, the module layout, every entity with its fields and owner, tenancy and isolation, every external service behind an interface.
7. **Security and privacy.** Authorization, secrets, retention, abuse, rate limits.
8. **Quality bar.** A table of measurable targets (below).
9. **UI and design system.** See [spec-design.md](spec-design.md).
10. **Build plan.** The demoable outcomes, in the order the owner wants to see them (below).
11. **Risks and open questions.** Each open question names who answers it and by when.
12. **Glossary.**
13. **Appendices:** ownership and licences, the changelog, the human tasks known up front.

## Requirements

A requirement is one behaviour a test can prove.

- **Observable.** State what a user, an agent or another service can see or do. "Publishing is idempotent per post and channel" can be tested; "publishing is robust" cannot.
- **With its numbers.** Limits, timeouts, retries, sizes and windows are written down: "temporary errors retry at 1, 5 and 15 minutes".
- **With its edge cases.** Errors, empty states, limits reached, roles that may not, time zones, concurrency. A builder implements what is written and guesses the rest.
- **One behaviour each.** If a requirement has an "and" that could fail separately, split it, or give the second part a letter (`PB-3a`).
- **Stable IDs.** Never renumber or reuse an ID; tasks, tests and commits cite it. A dropped requirement keeps its ID and says "Removed in v0.7".
- **A prefix per area**, two to five letters (`PB` publishing, `SEC` security). Keep a table of prefixes in §0 if there are many.
- **Prose requirements.** A screen, an entity or a formula described only in prose still has to be built. Planners give each a synthetic ID (`PBS-3 Posts screen queue grouped by day`) in a separate list, so coverage counts it too.
- **Deferred requirements** that are written down but not in this build are listed by ID with the reason, so no task claims them and coverage does not expect them.

An example from a real spec, for a social media product:

```markdown
### Requirements

- **PB-2 No duplicates:** publishing is idempotent per post and channel.
  If a network times out or gives an unclear answer, the app checks the account's recent posts for a match before retrying.
  Where the network gives no way to check, it never retries blindly: the copy fails with "We couldn't confirm this was published; check before retrying."
- **PB-3 Retries:** temporary errors retry at 1, 5 and 15 minutes; permanent errors mark the copy Failed with the network's reason in plain words.
```

## Architecture rules that make tasks small

The spec decides the boundaries the plan is cut along.
Set them before the first task, so parallel builders don't collide (one shared file edited by every task becomes a merge conflict in every pass).

- **One module per route, per operation group, per connector, per worker job.** The module map becomes the task areas.
- **Registries by convention, not by a shared file.** An operation is one file found by a glob; a gate step is one numbered file. Adding one never edits a list.
- **Every external service behind an interface with a local stand-in** (storage, email, payments, models, third-party APIs), so builders build and test without real credentials. Real credentials are used only by contract tests and deploys.
- **Injected clocks and IDs**, so tests are deterministic.
- **One authorization function and one tenant-scoped data layer**, so security rules are structural and testable for every new handler.
- **A walking skeleton first:** each repository's real entry point, its full check, its end-to-end harness, and the checks that keep work wired in (an orphan check, a requirement-to-test check), before any feature.

## Quality bar

Write targets a test or a measurement can check: availability, latency at a percentile, freshness, correctness (fixture tests that pin every formula), recovery, accessibility (WCAG 2.2 AA, axe with no serious violations), devices and widths, monitoring thresholds, load.
Say when each target applies (from launch, before launch) and how it is measured.

## Epics, features and user stories

Write the spec so it decomposes cleanly into the TaskSet's hierarchy ([decompose.md](decompose.md)): epics are outcomes, features are capabilities, and user stories are needs.

- **An epic is an outcome**, named for what becomes true for people: "Social publishing", not "Publishing service". Open its section with that outcome in a sentence.
- **A feature is a capability** a user would recognise, delivered as a vertical slice through every layer it needs: "Network connections".
- **A user story is one need**, small enough to demo on its own, written "As a …, I want …, so that …": "As a marketer, I want to connect my company's LinkedIn Page, so that Mushy can publish to it and read its metrics."
  Platform work is an enabler story, written from whoever benefits: the operator, the support agent, the owner, a developer, or the end user it protects.
- **Requirements belong to stories**: each story lists the requirement IDs that make it true, so a task that serves the story claims them.

A feature section in this shape:

```markdown
### 11.2 Network connections

Connect, reconnect and disconnect each network's accounts, with their history backfilled.

User stories:

- **Connect a LinkedIn Page.** As a marketer, I want to connect my company's LinkedIn Page, so that Mushy can publish to it and read its metrics. (CN-1, CN-2)
- **Reconnect an expired account.** As a marketer, I want to be told when a connection expires and reconnect it in two clicks, so that nothing scheduled fails silently. (CN-5)

#### Requirements

- **CN-1 OAuth:** …
```

## Build plan

Name the demoable outcomes the owner wants to see, in order: "A person signs in and sees an empty workspace", "A marketer schedules a post and sees it published", "Every network connects".
Say what each lets the owner see or do, in a sentence; `/helix milestones` turns them into the TaskSet's milestones.
Never plan by days or dates: an outcome is reached when its work is done, however long that takes, and the loop prefers the earliest outcome's work without ever holding the rest behind it.
The first outcome is a walking skeleton (every repository built, deployed and reachable), and the second the thinnest end-to-end path a user values.

## Changes after the build starts

A spec that grows mid-build turns into rework (the lesson behind hardening).
After the spec is frozen, a change is a new version: a changelog row, the changed requirement IDs, and new or changed tasks for exactly those IDs.
Never edit a requirement's meaning without a changelog row.

## Hardening

`/helix harden` reads the spec as a builder would and lists every place a builder would have to guess.
Look hardest where specs are usually thin: layout and navigation, forms and validation, empty, loading and error states, permissions per role, limits and what happens at them, time zones, concurrency, module boundaries, and conflicts between the spec and the design.

Write each finding like this, numbered in one series for the whole spec:

An example finding, from a real spec's hardening:

```markdown
#### SH-14 Channel picker: spec behaviour, design visuals

- Where: §19 Channel picker; NAV-11
- Kind: ambiguity | contradiction | gap
- Problem: one or two sentences a builder would recognise.
- Proposed resolution: the reading that adds the least scope.
- Scope: none | reduces | adds (say what)
- Tasks: T-1042, T-1043 (once tasks exist)
```

- **Propose, don't decide.** Each finding carries a resolution, but the owner approves it.
- **Least scope wins** unless the owner says otherwise; say plainly when a resolution adds work.
- **Decisions for the owner go on top**: the few findings that are legal, money or product judgment, each with a recommendation and its reason.
- **Fold, then freeze.** Approved findings are written into the spec as one new version with a changelog row; the findings list stays as the record of why, and task notes cite findings as `Assumption SH-n`.

## Checklist

- Every section a builder will be pointed at makes sense read alone.
- Every requirement has an ID, a number where it needs one, and its edge cases.
- Every external service has an interface and a stand-in.
- The module map gives parallel work separate areas.
- Every epic names its outcome, every feature its capability, and every user story its person and need.
- The build plan names demoable outcomes in order, never days.
- The changelog's newest row is the current version.
