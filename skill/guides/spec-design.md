# Writing the design spec

The design spec says how the product looks and behaves on screen.
It is part of the Helix Spec (its UI section), with design references beside it.
Builders read it a section at a time, like the rest of the spec, and they never grade their own UI: tests catch behaviour, and a separate look pass catches what tests miss.

## Who decides what

- **The design decides how it looks**: layout, spacing, type, colour, components, motion.
- **The spec decides what it does**: behaviour, rules, scope, copy that carries meaning.
- Where they disagree, record a hardening finding and say which one wins for that case. Never leave a builder to pick.

## What to write

### The design system

- Name the design system and where its source lives (tokens, CSS, fonts, components).
- Make it a package in the product's repository before any UI task, so every screen and every lane uses the same tokens and components.
- List the components by name; tasks and screens refer to them by these names.
- **Colour roles**: one row per role, saying what the colour means and where it is used (the one primary action per view, agent-made content, good and bad news, limits). A colour never carries meaning alone: pair it with a word or an icon.

### Navigation

- The app shell: what is in the navigation, in what order, on wide and narrow screens.
- Routes: one per screen, with its URL and its parameters.
- **Shareable state**: which view state lives in the URL (filters, period, selection, tab), so a copied link opens the same view for someone else.
  Name it as a requirement, because every screen task then gets a test for it.

### Screens

One table, one row per screen (the example row is from a real spec, for a social media product):

| Screen | Opens with | Built from |
| --- | --- | --- |
| Posts | "3 posts need your approval" or "Next post: Thu 9:00 AM on LinkedIn" | Queue, Calendar and Published tabs; QuotaMeter; Badge for states |

- **Opens with**: the answer the screen leads with, in the product's words. Every page opens with its answer.
- **Built from**: the components, in order.

Then, for each screen, the parts a builder cannot infer:

- **Every state**: empty (first use, and filtered to nothing), loading, error, partial data, at a limit, no permission. Write the copy for each.
- **Per role**: what each role sees and may do on the screen; what someone without access gets (usually not-found, not a disabled page).
- **Forms**: each field, its validation and error copy, what is kept on error, what submit does, what it does twice.
- **Actions**: which is the primary action, which need confirmation, which can be undone.
- **Widths**: the narrowest supported width (for example 360 or 390 px) and what changes there.
- **Screens the design doesn't draw**: say which existing frame and components compose them.

### Design references

- Screenshots or a prototype per screen, with stable file names (`design-reference/screenshots/04-posts.png`) and, where there are variants, which one is canonical.
- Keep them in the product repository, read-only, so a task's notes can name the exact file to build from.
- A prototype's "decisions made during design" that differ from the spec become hardening findings.

### Charts

- Each chart answers one question, and its title is that answer.
- Say what every comparison is compared with, how series keep their colours, what happens with many series, and what clicking a mark opens.

### Accessibility

- The target (WCAG 2.2 AA), and how it is checked: axe with no serious violations on every screen a test opens, a keyboard sweep, the narrow-width pass.
- Motion: anything that loops can be paused.

### Copy

- The product's voice in a few lines, and the words it uses for its own concepts (they go in the glossary).
- Error messages say what happened and what to do, in plain words.

## How it turns into tasks

- Every screen task names its design reference in `notes` and has at least one end-to-end test that opens the screen and runs the accessibility check.
- Every screen with shareable state has a test that copies the link and opens it as someone else.
- State work is planned explicitly: the empty, loading and error states are acceptance tests, not polish left for later.
- A **look pass** per milestone (screenshots at a wide and a narrow width, light and dark) is run by a reviewer, not by the builder; it files fix-first tasks for what it finds.

## Checklist

- Every screen has a row, an "opens with", and its states with their copy.
- Every role's view of every screen is stated.
- Every form's validation and errors are written.
- The URL state of every screen is named.
- Every screen has a design reference or says what composes it.
- Conflicts between the design and the spec are findings with a winner.
