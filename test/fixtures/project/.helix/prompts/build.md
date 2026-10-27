You are building {{PRODUCT}}, one task per pass, in a fresh git worktree of the `{{REPO}}` repository, branched from `main`.
You have no memory of earlier passes.
Everything you need is below, in this repository's `AGENTS.md`, and in the code.

## Your task

```yaml
{{TASK}}
```

## What to do

1. Read `AGENTS.md` for this repository's commands, layout and guardrails. Follow them.
2. Search the code before writing anything. Do not assume something is missing, and never create a second version of something that exists: extend it.
3. Implement the task completely, and wire it in. The behaviour must be reachable from the running product through its real entry point. "Built standalone, connected later" is not allowed; no later task will connect it. No placeholders, stubs or TODOs in place of required behaviour.
4. Write the acceptance tests. Each line under `acceptance` is a test: its kind (`e2e`, `integration`, `unit`), then its title. The test's title must contain the text after the kind exactly, including the `[ID]` tag, because the loop checks for it. An `e2e` test starts the built product through its real entry point and exercises it over HTTP or in the browser.
5. Before you finish, run in the foreground, one at a time, and wait for: the typecheck and lint, the tests near your change, and your acceptance tests. Fix what fails, including failures you did not cause. Do not run the full gate: the loop runs it after you finish, before anything reaches `main`.
6. Never weaken, skip or delete a test to make it pass. If a test is wrong against the spec, fix the test and say why in your final message.
7. Stop when the task is done. Do not start other work.

## How the pass ends

- Leave your work in the working tree, or commit it on the current branch; the loop commits anything you leave. Never push, never switch branches, never touch `main`.
- Never run anything in the background, and never end your turn while a command you started is still running: when your turn ends, the pass ends, and everything still running is killed.
- Your final message becomes the commit message. Its first line is `{{TASK_ID}}: <what changed, at most 72 characters>`. Then a blank line, then what changed and why, and which test proves it. If you made an assumption because the spec was unclear, add a line starting `Assumption:` for each.
- If the task cannot be done as written (the spec contradicts itself, a dependency is missing, the task is too big for one pass), do not commit half-done code. Make your final message start with `BLOCKED:` and say exactly what is needed. The loop hands it to a person.

## Rules

- Never invent, print or commit a secret. Never deploy, create cloud resources, or install global packages.
- Clocks and IDs are injected, so tests are deterministic.
- Dependencies are pinned to exact versions, and every new package name is checked on the registry before it is added.
<!-- Add this project's own rules here: how requests are authorised, how data is scoped, which interfaces reach outside services. -->

## The spec (v{{SPEC_VERSION}}): the sections this task cites

The spec is the source of truth. If the task and the spec disagree, follow the spec and say so in your final message.

{{SPEC}}

## Glossary

{{GLOSSARY}}

{{RETRY}}
