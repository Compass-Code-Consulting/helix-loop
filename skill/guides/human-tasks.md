# Human tasks

A human task is work only a person can do, sign or pay for: creating accounts, paying, legal sign-off, submitting reviews to third parties, DNS at a registrar, and judgment calls.
Tasks wait on human tasks like any other dependency, so a human task the owner hasn't started can stall the loop.
Each one is written so the owner can do it quickly, or hand it to their own agent, and the loop can tell when it is done.

## What is, and is not, a human task

- **Is:** anything needing the owner's identity, signature, money or judgment; anything with a third party's review or waiting period; going live (applying infrastructure to production, switching to live keys, deploying, submitting for review).
- **Is not:** anything a builder can do in a repository. Build against stand-ins instead of waiting for real accounts; real credentials are used only by contract tests and deploys.
- **Is not:** a decision the spec should make. A product question is a hardening finding, not a human task.

## The file

```yaml
id: HT-1
title: Open the email provider account, verify the sending domain and store its API key for the contract tests
done_check: "The provider's dashboard shows mail.example.com verified, and gh secret list --env contract-tests lists EMAIL_PROVIDER_API_KEY"
lead_time_days: 2
agent_can_help: partly
handoff_prompt: |
  You are the owner's agent for the waitlist build. Ground rules: ...
  Goal: ...
  Steps: ...
  The owner supplies: ...
  Report back: ...
tools: [gh, browser agent on the owner's sign-in]
secrets:
  - { name: EMAIL_PROVIDER_API_KEY, stored_in: "GitHub environment contract-tests; source: the provider's dashboard" }
blocked_by: []
status: todo
```

| Field | Rule |
| --- | --- |
| `id` | `HT-` and a number, unique, and the file is named `HT-#.yaml`. |
| `title` | What to do and why it matters, in one line. |
| `story` | Optional: the user story it clearly serves. Human tasks stay outside the hierarchy and the milestones; they are ordered by when each must start. |
| `done_check` | How anyone can tell it is done, without asking the owner (below). |
| `lead_time_days` | Calendar days from starting to done, waits included (below). |
| `agent_can_help` | `yes`, `partly` or `no`. |
| `handoff_prompt` | For `yes` and `partly`: the ready-to-paste prompt for the owner's agent (below). |
| `tools` | The CLIs and MCP servers to give that agent. |
| `secrets` | Each secret the task creates or needs: its `name` and where it is `stored_in`. Never its value. |
| `blocked_by` | Tasks or human tasks that must be done first. |
| `status` | `todo` on every new one; then `in_progress` and `done`. |
| `notes` | What the owner recorded: the evidence it is done, or why it waits. |

## The done check

A done check is a command to run or a fact anyone can look up, not "the owner says so".

- Good: "`gh secret list --env contract-tests` lists `STRIPE_SECRET_KEY`", "`https://example.com/health` answers 200", "whois shows the domain registered with transfer lock on", "the approval is recorded in DECISIONS.md with the commit it approved".
- Bad: "Stripe is set up", "DNS done".
- For a judgment, the check is where the decision is recorded.

## Lead time

The loop computes each human task's latest start date from its lead time and the tasks waiting on it, and warns the owner before it slips.
So the lead time must be honest:

- **Include third-party waits**: domain verification (up to 48 hours), app review by a platform (days to weeks), legal review, a vendor's scheduling.
- **Use the realistic case**, not the best one.
- **Start the long ones first.** List human tasks longest lead time first; long-lead ones start before the build does.

A lead time moves the Project complete date; when `taskset.yaml` shows both timelines, the Code complete date leaves it out.

## The hand-off prompt

For `yes` and `partly`, write the prompt the owner pastes into their own agent, complete enough that the agent needs nothing else:

1. **Who and what**: the agent's role, the product, and where the spec is (and which sections to read, not the whole spec).
2. **Ground rules**: what the owner confirms before the agent acts (every purchase, every account, every external message); never print, paste or log a secret value.
3. **Goal**: the end state, matching the done check, and the spec requirement it serves.
4. **Context**: the facts the agent needs (names, hosts, existing accounts, what is already decided), so it doesn't guess.
5. **Steps**, numbered, each one verifiable; secrets piped straight into their store (`... | gh secret set NAME --env ...`), never echoed.
6. **The owner supplies**: their sign-ins, payment, approvals.
7. **Report back**: what the agent returns (names, IDs, links, dates, costs), never secret values.

## Secrets

- Name every secret the task creates or the product needs from it, and say where it is kept: a CI environment, a keychain item, a password manager entry.
- **Never a value**, anywhere in the TaskSet or the spec: not in `secrets`, not in the hand-off, not in notes. The validator refuses what looks like a key.
- Prefer the narrowest scope the provider offers (send-only, read-only, one environment).

## Dependencies

- A human task may wait on tasks (approve copy once the page is built) and on other human tasks (store the key once the account exists).
- Block a build task on a human task only when it cannot be built or tested without it: usually only contract tests and deploys.
- Release holds (no release until the legal pages are approved) wait on a human task too; name it where the loop configures the hold.

## Checklist

- It is truly something only the owner can do.
- Its done check can be run or looked up by someone else.
- Its lead time includes every wait.
- `yes` and `partly` have a complete hand-off prompt that ends with what to report.
- Every secret is named with where it is stored, and no value appears anywhere.
- Build tasks are not blocked on it unless they truly cannot be built or tested without it.
