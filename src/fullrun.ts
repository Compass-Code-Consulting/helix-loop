import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Clock } from './clock.ts';
import { failingTest } from './flaky.ts';
import { ANSI, gateId, gateVar, runRepoCheck, type GateStep } from './gate.ts';
import { git, gitOk, removeWorktree } from './git.ts';
import type { LedgerEvent } from './ledger.ts';
import { normaliseFailure } from './metrics/model.ts';
import type { Task } from './types.ts';

// Whole-suite runs on main, for a repo with scoped gates (config repos.<repo>.scoped). Each pass's gate tests only
// what its change can affect, so main is checked in full here instead: every `full_run_every` merges into the
// repo, and before each release the loop tags. A run that fails is not left to the next pass to stumble on:
// - its failing tests run again at the same commit, and if they pass, the test is flaky;
// - if they fail again, they run at earlier merges, halving the range each time, back to the last run that
//   passed, which finds the merge that broke them and so its task;
// - either way the loop files a fix-first task (loop.ts), and the repo's releases wait for a run that passes.

export type FullRunEvent = Extract<LedgerEvent, { kind: 'full_run' }>;
export interface Merge {
  commit: string;
  task: string;
}

// Merges into the repo since its last whole-suite run, by the ledger; every merge if it has had none.
export function mergesSinceFullRun(events: LedgerEvent[], repo: string): number {
  let n = 0;
  for (const e of events) {
    if (e.kind === 'full_run' && e.repo === repo) n = 0;
    else if (e.kind === 'merge' && e.repo === repo) n++;
  }
  return n;
}

export function latestFullRun(events: LedgerEvent[], repo: string): FullRunEvent | undefined {
  return events.findLast((e): e is FullRunEvent => e.kind === 'full_run' && e.repo === repo);
}

// The commit of the repo's newest run that passed: where the search for a break starts.
export function lastGreen(events: LedgerEvent[], repo: string): string | undefined {
  return events.findLast((e): e is FullRunEvent => e.kind === 'full_run' && e.repo === repo && e.ok)?.commit;
}

// The repo's merges, oldest first: those `after` (the commits main gained since a commit, from git), or the last
// `last` when there is no such commit.
export function mergesOf(events: LedgerEvent[], repo: string, opts: { after?: Set<string>; last: number }): Merge[] {
  const all = events.filter((e) => e.kind === 'merge' && e.repo === repo).map((e) => ({ commit: (e as { commit: string }).commit, task: (e as { task: string }).task }));
  return opts.after ? all.filter((m) => opts.after!.has(m.commit)) : all.slice(-opts.last);
}

// The tests a failed run names, one per test file, each with its first failing line as gate.ts firstFailure
// gives one: Vitest's "|integration| apps/api/src/x.integration.test.ts > [AD-1] title" (from its FAIL lines) and
// Playwright's "[chromium] › e2e/x.e2e.test.ts:12:1 › [NAV-28] title" (from its numbered failures).
const TEST_FILE = /(\S+\.(?:test|spec)\.[cm]?[jt]sx?)\b/;
export function failingTests(output: string): { file: string; line: string }[] {
  const out = new Map<string, string>();
  for (const raw of output.replace(ANSI, '').split('\n')) {
    const line = /^\s*FAIL\s+(\S.*)$/.exec(raw)?.[1] ?? /^\s*\d+\)\s+(\[[^\]]+\]\s+›\s+.+)$/.exec(raw)?.[1];
    const file = line && TEST_FILE.exec(line)?.[1];
    if (file && !out.has(file)) out.set(file, line.replace(/[\s─━]+$/, '').trim());
  }
  return [...out].map(([file, line]) => ({ file, line }));
}

// The first of `commits` (oldest first) at which `fails` holds, given that it holds at the last; `knownGood`:
// the commit before the first is known to pass. It halves the range each time, so 25 merges take 5 runs.
// Undefined when it holds at the first and nothing before that is known to pass.
export async function firstFailing(commits: string[], fails: (commit: string) => Promise<boolean>, knownGood: boolean): Promise<number | undefined> {
  let good = -1;
  let bad = commits.length - 1;
  while (bad - good > 1) {
    const mid = Math.floor((good + bad) / 2);
    if (await fails(commits[mid]!)) bad = mid;
    else good = mid;
  }
  return good === -1 && !knownGood ? undefined : bad;
}

export interface FullRunInput {
  repo: string;
  checkout: string; // the repo's checkout, on main
  dir: string; // where the run's worktree goes
  gate: string;
  prepare?: string;
  tests?: string; // runs the test files given after it
  envPrefix?: string;
  cache: string; // the repo's gate cache, which a run with no base may refresh
  // The merges since the last run that passed, oldest first, or the last few when none has; `knownGood`: the
  // commit before the first of them passed a whole-suite run.
  merges: Merge[];
  knownGood: boolean;
  timeoutMs: number;
  suspensionMs: number;
  clock: Clock;
  logFile: string;
  log: (line: string) => void;
  signal?: AbortSignal;
}

export type FullRunResult = { commit: string; ms: number; steps: GateStep[] } & (
  | { ok: true }
  | {
      ok: false;
      detail: string;
      failing?: string;
      failedStep: string;
      tests: { file: string; line: string }[];
      flaky: boolean; // its failing tests passed when they ran again
      culprit?: Merge; // the merge they first fail at; its task is empty when main gained that commit by hand
    }
);

export class FullRunStopped extends Error {}

const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

// Runs the repo's gate on main's current commit with no base, so it runs every test, in a worktree of its own.
export async function runFullCheck(input: FullRunInput): Promise<FullRunResult> {
  const { clock } = input;
  const started = clock.monotonic();
  const ms = () => Math.round(clock.monotonic() - started);
  const commit = await git(input.checkout, 'rev-parse', 'main');
  const worktree = join(input.dir, `${input.repo}-${commit.slice(0, 12)}`);
  mkdirSync(input.dir, { recursive: true });
  mkdirSync(input.cache, { recursive: true });
  if (existsSync(worktree)) await removeWorktree(input.checkout, worktree);
  await git(input.checkout, 'worktree', 'add', '--detach', '-q', worktree, commit);
  const stopped = () => {
    if (input.signal?.aborted) throw new FullRunStopped('the loop stopped');
  };
  try {
    const check = (command: string, id: string) =>
      runRepoCheck({
        worktree,
        command,
        prepare: input.prepare,
        timeoutMs: input.timeoutMs,
        suspensionMs: input.suspensionMs,
        clock,
        logFile: input.logFile,
        env: { ...gateId(input.envPrefix, id), ...gateVar(input.envPrefix, 'GATE_CACHE', input.cache) },
        signal: input.signal,
      });
    const r = await check(input.gate, `full-${commit.slice(0, 12)}`);
    stopped();
    if (r.ok) return { ok: true, commit, ms: ms(), steps: r.steps };
    const tests = failingTests(r.output);
    const failed = { ok: false as const, commit, steps: r.steps, detail: r.detail, failing: r.failing, failedStep: r.failedStep, tests };
    if (!input.tests || !tests.length || r.outcome === 'suspended') return { ...failed, ms: ms(), flaky: false };

    // The failing tests alone, at `at`: only those that existed there, so a test added later passes there.
    const passesAt = async (at: string) => {
      await git(worktree, 'checkout', '--detach', '-q', at);
      const files: string[] = [];
      for (const t of tests) if (await gitOk(worktree, 'cat-file', '-e', `${at}:${t.file}`)) files.push(t.file);
      if (!files.length) return true;
      const res = await check(`${input.tests} ${files.map(quote).join(' ')}`, `bisect-${at.slice(0, 12)}`);
      stopped();
      input.log(`${input.repo}: ${files.length} failing test file${files.length === 1 ? '' : 's'} at ${at.slice(0, 12)}: ${res.ok ? 'passed' : 'failed'}`);
      return res.ok;
    };
    if (await passesAt(commit)) return { ...failed, ms: ms(), flaky: true };
    const commits = input.merges.map((m) => m.commit);
    if (commits.at(-1) !== commit) commits.push(commit); // main moved by a hand, not a merge: still the last suspect
    const at = await firstFailing(commits, async (c) => !(await passesAt(c)), input.knownGood);
    const culprit = at === undefined ? undefined : (input.merges.find((m) => m.commit === commits[at]) ?? { commit: commits[at]!, task: '' });
    return { ...failed, ms: ms(), flaky: false, culprit };
  } finally {
    await removeWorktree(input.checkout, worktree).catch(() => undefined);
  }
}

// What a fix for main's whole-suite run was filed for: the mark and its first failing test's signature.
export const FULL_RUN_MARK = "Filed by the loop for main's whole-suite run:";
export function filedForFullRun(task: Task): string | undefined {
  const line = (task.notes ?? '').split('\n').find((l) => l.startsWith(FULL_RUN_MARK));
  return line?.slice(FULL_RUN_MARK.length).trim() || undefined;
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
const KINDS = { unit: 'unit test', integration: 'integration test', e2e: 'browser test' } as const;

// The fix-first task for a failed whole-suite run, or undefined when no failing line names a test (a type error
// on main, say: the owner hears of it instead). `culprit`: the task whose merge broke it, when the search found
// one in the plan. `story`, `spec` and `area` come from it, or else from `fallback`, the repo's latest merged task.
export function fullRunFixTask(input: {
  id: string;
  run: Extract<FullRunResult, { ok: false }> & { reason: string };
  culprit?: Task;
  fallback: Task;
  knownReq: (id: string) => boolean;
  tests?: string; // the repo's command for given test files
  log: string; // the run's log, relative to .helix/
}): Task | undefined {
  const { run } = input;
  const named = run.tests.map((t) => ({ ...t, signature: normaliseFailure(t.line) })).flatMap((t) => {
    const test = t.signature ? failingTest(t.signature) : undefined;
    return test && t.signature ? [{ ...t, signature: t.signature, test }] : [];
  });
  const first = named[0];
  if (!first) return undefined;
  const tags = named.flatMap((n) => /\[([^\]]+)\]/.exec(n.test.title)?.[1]?.split(/,\s*/) ?? []);
  const known = [...new Set(tags.filter((t) => input.knownReq(t)))];
  const owner = input.culprit ?? input.fallback;
  const reqs = known.length ? known : owner.reqs.slice(0, 1);
  if (!reqs.length) return undefined;
  const what = `the ${KINDS[first.test.kind]} "${clip(first.test.title, 80)}"`;
  const others = named.length > 1 ? ` and ${named.length - 1} more` : '';
  const short = (c: string) => c.slice(0, 12);
  const culprit = run.culprit;
  const title = run.flaky
    ? `${what[0]!.toUpperCase()}${what.slice(1)}${others} passes every time, instead of failing main's whole-suite run`
    : culprit?.task
      ? `${what[0]!.toUpperCase()}${what.slice(1)}${others} passes on main again, after ${culprit.task} broke it`
      : `${what[0]!.toUpperCase()}${what.slice(1)}${others} passes on main again`;
  const rerun = input.tests ? `\`${input.tests} ${named.map((n) => n.file).join(' ')}\`` : `the repo's gate`;
  const how = run.flaky
    ? [
        `It failed the whole-suite run at ${short(run.commit)} and passed when it ran again at the same commit, so it is flaky.`,
        `Reproduce it first by running ${first.file} repeatedly: at least 30 times on its own, one run at a time, since other passes share this machine. Then fix the cause, whether a race, state shared between tests, an order the test assumes, or a time limit a busy machine can't meet. Never raise a time limit, add a retry, skip the test or weaken what it checks. Show the repeated runs passing every time in your final message.`,
      ]
    : culprit
      ? [
          `It fails from ${short(culprit.commit)}${culprit.task ? `, ${culprit.task}'s merge,` : ''} on: the search ran ${rerun} at the merges since the last run that passed, and it passed at the merge before. ${culprit.task ? `${culprit.task}'s gate didn't run it, because its change didn't seem to reach it: find what in that change does.` : 'That commit was not a task the loop merged.'}`,
          `Fix the cause, in the code or in the test, whichever is wrong against the spec, and say which in your final message. Never skip the test or weaken what it checks.`,
        ]
      : [
          `It failed the run again at the same commit; the merge that broke it wasn't found${input.tests ? ' (it fails as far back as the search could go)' : ` (the repo has no command for given test files, repos.${input.fallback.repo}.scoped.tests)`}.`,
          `Reproduce it with ${rerun}, find the cause, and fix it, in the code or in the test, whichever is wrong against the spec. Never skip the test or weaken what it checks.`,
        ];
  return {
    id: input.id,
    repo: owner.repo,
    story: owner.story,
    area: run.flaky ? 'build/flaky' : owner.area,
    title,
    priority: 'fix_first',
    reqs,
    spec: owner.spec,
    acceptance: named.slice(0, 5).map((n) => `${n.test.kind}: ${n.test.title}`),
    blocked_by: [],
    estimate_passes: run.flaky ? 0.5 : 1,
    status: 'ready',
    claimed_by: null,
    attempts: [],
    notes: [
      `${FULL_RUN_MARK} ${first.signature}`,
      `Main's whole-suite run (${run.reason}) failed at ${short(run.commit)}; its log is ${input.log}. Failing:`,
      ...named.map((n) => `- ${clip(n.line, 300)}`),
      '',
      ...how,
      '',
      `What the run printed when it failed:\n${clip(run.detail, 3000)}`,
    ].join('\n'),
  };
}
