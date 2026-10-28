import { clipSummary } from './summary.ts';
import type { Plan, Task } from './types.ts';

// A test that fails passes of two different tasks is not either task's bug: it is flaky, or broken for every
// task. The loop files one fix-first task for it as soon as that happens (loop.ts), with the evidence, so the
// builders fix it before more passes fail on it. The task's notes carry the mark, so a test is filed once,
// and filed again only if it starts failing tasks after its fix merged.

export const FILED_MARK = 'Filed by the loop for a test failing passes of more than one task:';
export const RECURRING_WINDOW_MS = 24 * 3_600_000;

export interface FailureSeen {
  task: string;
  agent: string;
  attempt: number;
  at: number;
  log: string;
  line: string; // the failure's first line, as the gate gave it
}

// The test a failure names, from the gate's first failing line (gate.ts firstFailure) once normalised:
// "|integration| apps/api/src/x.test.ts > [AD-1] title", "[chromium] › e2e/x.e2e.test.ts › [SGN-11] title".
export function failingTest(signature: string): { kind: 'unit' | 'integration' | 'e2e'; file: string; title: string } | undefined {
  const vitest = /^\|(unit|integration)\|\s+(\S+)\s+>\s+(.+)$/.exec(signature);
  if (vitest) return { kind: vitest[1] as 'unit' | 'integration', file: vitest[2]!, title: vitest[3]!.split(' > ').at(-1)!.trim() };
  const browser = /^\[(?:chromium|chrome|firefox|webkit)\]\s+›\s+(\S+?)(?::\d+:\d+)?\s+›\s+(.+)$/.exec(signature);
  if (browser) return { kind: 'e2e', file: browser[1]!, title: browser[2]!.split(' › ').at(-1)!.trim() };
  return undefined;
}

// The signature a filed task was filed for, from its notes.
export function filedFor(task: Task): string | undefined {
  const line = (task.notes ?? '').split('\n').find((l) => l.startsWith(FILED_MARK));
  return line?.slice(FILED_MARK.length).trim() || undefined;
}

// The next free id among the fix-first tasks (T-00NN), after the highest one used. `taken` says whether a
// task file already holds an id: the loop engineer may have written one the loop hasn't loaded yet, and
// writing over it would lose it (T-0057, 2026-10-26).
export function nextFixId(plan: Plan, taken: (id: string) => boolean = () => false): string {
  const used = [...plan.tasks.keys()].map((id) => Number(/^T-(\d{4})$/.exec(id)?.[1] ?? NaN)).filter((n) => n < 100);
  for (let n = Math.max(0, ...used) + 1; n < 100; n++) {
    const id = `T-${String(n).padStart(4, '0')}`;
    if (!plan.tasks.has(id) && !taken(id)) return id;
  }
  const max = Math.max(...[...plan.tasks.keys()].map((id) => Number(id.slice(2))).filter(Number.isFinite));
  return `T-${String(max + 1).padStart(4, '0')}`;
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

// One line of evidence per failed pass, for a fix's notes.
function evidence(failures: FailureSeen[], timeZone: string): string[] {
  const when = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', hour: 'numeric', minute: '2-digit' });
  return failures.map((f) => `- ${f.task} attempt ${f.attempt} (${f.agent}, ${when.format(f.at)}; ${f.log}): ${clip(f.line, 300)}`);
}

// A parked fix (its test passed every repeated run) whose test then fails passes of two more tasks after the
// fix's last attempt is ready again, with the new evidence first; parked, it would stop the loop filing the test
// again, and the failures would go unanswered. Undefined when the task isn't parked or the failures don't add up.
export function reopenedFix(task: Task, failures: FailureSeen[], timeZone: string): Task | undefined {
  if (task.status !== 'parked') return undefined;
  const since = Math.max(0, ...task.attempts.map((a) => Date.parse(a.at)));
  const again = failures.filter((f) => f.at > since && f.task !== task.id);
  const tasks = [...new Set(again.map((f) => f.task))];
  if (tasks.length < 2) return undefined;
  return {
    ...task,
    status: 'ready',
    summary: clipSummary(`taken up again: its test failed ${tasks.join(' and ')} after it was parked`),
    notes: [`Taken up again by the loop: after it was parked, its test failed ${again.length} passes of ${tasks.length} different tasks (${tasks.join(', ')}):`, ...evidence(again, timeZone), '', task.notes ?? ''].join('\n'),
  };
}

// The fix-first task for a test that failed `failures` (two or more tasks), or undefined when the failure
// doesn't name a test. Its requirements are every requirement in the test's tag that the plan knows, as the
// plan's validation expects of an acceptance line, else the first task's first (T-0078 was filed with only FG-1
// of "[FG-1, PLT-5]", which failed validation, 2026-10-27). Its notes bound the repeated runs by the pass's time limit (`passMinutes`): asked for 30 runs of the whole
// suite, fix-first passes took up to the full hour (two of eleven timed out), and suites run side by side
// exhausted the shared Postgres server's connections, failing other passes' gates (T-0063, 2026-10-26).
export function fixTaskFor(input: { id: string; signature: string; failures: FailureSeen[]; first: Task; knownReq: (id: string) => boolean; timeZone: string; passMinutes: number }): Task | undefined {
  const test = failingTest(input.signature);
  if (!test) return undefined;
  const tags = /\[([^\]]+)\]/.exec(test.title)?.[1]?.split(/,\s*/) ?? [];
  const known = tags.filter((t) => input.knownReq(t));
  const reqs = known.length > 0 ? known : input.first.reqs.slice(0, 1);
  if (reqs.length === 0) return undefined;
  const tasks = [...new Set(input.failures.map((f) => f.task))];
  const kind = { unit: 'unit test', integration: 'integration test', e2e: 'browser test' }[test.kind];
  return {
    id: input.id,
    repo: input.first.repo,
    // The first failing task's story: the same lane, and its milestone, though fix-first work runs before any.
    story: input.first.story,
    area: 'build/flaky',
    title: `The ${kind} "${clip(test.title, 80)}" passes every time, instead of failing unrelated tasks`,
    priority: 'fix_first',
    reqs,
    spec: input.first.spec,
    acceptance: [`${test.kind}: ${test.title}`],
    blocked_by: [],
    estimate_passes: 0.5,
    status: 'ready',
    claimed_by: null,
    attempts: [],
    notes: [
      `${FILED_MARK} ${input.signature}`,
      `It failed ${input.failures.length} passes of ${tasks.length} different tasks (${tasks.join(', ')}), none of which set out to change it:`,
      ...evidence(input.failures, input.timeZone),
      '',
      `Reproduce it first, from the failures above and by running ${test.file} repeatedly: at least 30 times on its own, and its whole suite no more than twice. Your pass ends after ${input.passMinutes} minutes, and the gate runs every suite again once you finish, so keep the repeated runs, before and after the fix together, to about ${Math.round(input.passMinutes / 3)} minutes. Run them one at a time, never two suites at once: other passes share this machine and its Postgres server. Then fix the cause, whether a race, state shared between tests, an order the test assumes, a time limit a busy machine can't meet, or a real break on main. Never raise a time limit, add a retry, skip the test or weaken what it checks. Show the repeated runs passing every time in your final message. If they pass every time and the failures point to nothing shared, answer BLOCKED: not reproducible, saying what you ran.`,
    ].join('\n'),
  };
}
