import { stepName } from '../gate.ts';
import type { LedgerEvent } from '../ledger.ts';
import { buildStats, type AgentUsage } from '../stats.ts';
import type { MetricsVersion } from './archive.ts';
import type { Plan } from '../types.ts';

// The metrics page's numbers (render.ts draws them): the build's progress over time and a projection of
// when it finishes if the recent trend holds, where the agents' time goes, what fails and why, and what
// the passes cost. Everything comes from the ledger, the plan and the plan's git history.

type Pass = Extract<LedgerEvent, { kind: 'pass' }>;

// What a pass came to, for the charts. A failure is "recurring" when the same test failed passes of two or
// more different tasks: a flaky test, or one many tasks trip over. Either way it is not one task's bug.
export const CATEGORIES = ['merged', 'own', 'recurring', 'moved', 'blocked', 'refused', 'cut'] as const;
export type Category = (typeof CATEGORIES)[number];
export const CATEGORY_LABEL: Record<Category, string> = {
  merged: 'Merged',
  own: "Failed the gate: the task's own bug",
  recurring: 'Failed on a test other tasks fail too',
  moved: 'main moved during the pass',
  blocked: 'Blocked: plan gap or sandbox',
  refused: 'Refused: forbidden path or secret scan',
  cut: 'Cut short: limit, crash, timeout or sleep',
};

export interface PassRow {
  task: string;
  agent: string;
  attempt: number;
  outcome: string;
  category: Category;
  start: number;
  end: number;
  ms: number;
  agentMs?: number;
  gateMs?: number;
  costUsd: number;
  tokens: number; // fresh input and output, without cached input
  cached: number;
  failedStep?: string;
  failing?: string; // the failing test or check, normalised
  carried?: boolean;
  scripts?: Record<string, number>;
  e2eRuns?: number;
  toolCalls?: number;
}

export interface Window {
  start: number;
  end: number;
  partial?: boolean; // still running at `generatedAt`
  passes: number;
  merged: number;
  firstTry: number; // tasks merged by their first counted attempt
  hours: Record<Category, number>; // agent-hours by what the pass came to
  costUsd: number;
  tokens: number;
  byAgent: Record<string, { merged: number; costUsd: number; tokens: number }>;
}

export interface Projection {
  basis: string; // what the rates were measured over, in words
  rate: number; // tasks merged per hour
  growth: number; // tasks added to the plan per hour
  low?: number; // a slow and a fast rate, from the spread of recent windows
  high?: number;
  finish?: number; // when done meets total, if the trend holds; undefined when it never does
  finishLow?: number; // at the slow rate (later), and at the fast rate (sooner)
  finishHigh?: number;
  finishNoGrowth?: number; // if no more tasks were added
}

export interface Kpi {
  done: number;
  total: number;
  rate24: number; // tasks merged per hour, last 24 hours
  ratePrev24?: number; // the 24 hours before
  mergeRate24?: number; // share of passes that merged
  mergeRatePrev24?: number;
  firstTryRate?: number; // share of merged tasks that merged on their first counted attempt, all time
  agentHoursPerTask24?: number;
  costPerTask24?: number;
  costPerTaskPrev24?: number;
  tokensPerTask24?: number;
}

export interface StepTime {
  step: string;
  runs: number;
  medianMs: number;
  p90Ms: number;
  failures: number;
}

export interface Recurring {
  failing: string;
  tasks: string[];
  failures: number;
  last: number;
}

export interface CarryStats {
  passes: number;
  merged: number;
  medianMs?: number;
  freshPasses: number;
  freshMerged: number;
  freshMedianMs?: number;
}

export interface MetricsModel {
  generatedAt: number;
  passCount: number;
  file?: string; // the version's own file, every version known when it was written, and how often one is (archive.ts)
  versions?: MetricsVersion[];
  versionEvery?: number;
  startedAt?: number;
  windowHours: number;
  timeZone: string;
  categories: { key: Category; label: string }[];
  agents: string[];
  done: [number, number][]; // [time, tasks done] at each merge
  total: [number, number][]; // [time, tasks in the plan]
  windows: Window[];
  kpi: Kpi;
  projection: Projection;
  usage: AgentUsage[];
  upMs: number;
  failedSteps: { step: string; failures: number }[];
  recurring: Recurring[];
  steps: StepTime[];
  stepsSince?: number; // when step timings started being recorded
  carry: CarryStats;
  integration: { passes: number; ran: number; failedAtIntegration: number; failedAtIntegrationRan: number };
  recent: PassRow[];
  plan: { ready: number; claimed: number; needsHuman: number; parked: number; humanOpen: number };
  allowance: Allowance[];
}

// An agent's subscription, week by week: each weekly window its passes reported, as [time, share used], and
// the share of a window the loop paces the agent to (config agents.<name>.weekly_target).
export interface Allowance {
  agent: string;
  target?: number;
  windows: { resetsAt: number; points: [number, number][] }[];
}

const HOUR = 3_600_000;
const COUNTED_OUT = ['quota', 'suspended', 'transient', 'stopped'];

// A pass's note, from the plan where it can: the ledger kept only each note's first 500 characters until
// 2026-10-25, and the end of a gate's output, which names the failed step, is past them.
type NoteOf = (p: Pass) => string;

// The failing test or check a note names first, without the parts that differ between runs of the same test.
// A gate runner's own lines ("Gate failed at 40-size", "> gate 47-…") name a step, not a test, so they don't count.
export function failureSignature(p: Pass, noteOf: NoteOf = (x) => x.note ?? ''): string | undefined {
  const note = noteOf(p);
  const raw = p.failing ?? /^the gate failed: (.*)$/m.exec(note)?.[1] ?? /^after rebasing onto the new main: the gate failed: (.*)$/m.exec(note)?.[1];
  return raw ? normaliseFailure(raw) : undefined;
}

// A failing line as a signature that two runs of the same test share, or undefined when it names a gate step
// rather than a test.
export function normaliseFailure(raw: string): string | undefined {
  const s = raw.replace(/^after rebasing onto the new main, /, '');
  if (/^(Gate failed at|> gate |Checking:? )|exited with code \d+$/.test(s)) return undefined;
  return s
    .replace(/\s+\(\d+(?:\.\d+)?\s?m?s\)$/, '')
    .replace(/:(\d+):\d+ ›/, ' ›')
    .trim();
}

export function categorise(p: Pass): Category {
  const note = p.note ?? '';
  if (p.outcome === 'merged') return 'merged';
  if (p.outcome === 'conflict' || p.failedStep?.startsWith('regate:') || p.failedStep === 'rebase' || /^after rebasing onto the new main/.test(note) || /have diverged/.test(note)) return 'moved';
  if (p.outcome === 'no_commit' && /^BLOCKED/i.test(note)) return 'blocked';
  if (p.outcome === 'forbidden_paths' || p.failedStep === 'gitleaks' || /^gitleaks/.test(note)) return 'refused';
  if ([...COUNTED_OUT, 'timeout', 'agent_error'].includes(p.outcome)) return 'cut';
  return 'own';
}

// The step a failed pass stopped at, from the ledger, or for passes recorded before that, from its note: the
// last step the gate runner announced before it failed.
export function stepOf(p: Pass, noteOf: NoteOf = (x) => x.note ?? ''): string | undefined {
  if (p.outcome === 'merged') return undefined;
  if (p.failedStep) return p.failedStep;
  const note = noteOf(p);
  if (p.outcome === 'conflict') return 'rebase';
  if (/^gitleaks/.test(note)) return 'gitleaks';
  if (p.outcome === 'no_commit') return /^BLOCKED/i.test(note) ? 'blocked' : 'harness:no-commit';
  if (p.outcome === 'forbidden_paths') return 'harness:forbidden-paths';
  if (/^conflict markers/.test(note)) return 'harness:conflict-markers';
  if (/^AGENTS\.md is/.test(note)) return 'harness:agents-md';
  if (/^no test is titled/.test(note)) return 'harness:acceptance';
  const at = /Gate failed at (\S+?)(?: \(|$)/m.exec(note)?.[1] ?? note.split('\n').map(stepName).filter(Boolean).at(-1);
  if (at) return /^after rebasing/.test(note) ? `regate:${at}` : at;
  return COUNTED_OUT.includes(p.outcome) || ['timeout', 'agent_error'].includes(p.outcome) ? p.outcome : 'gate';
}

const median = (xs: number[]) => quantile(xs, 0.5);
function quantile(xs: number[], q: number): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const at = (s.length - 1) * q;
  const lo = Math.floor(at);
  return s[lo]! + (s[Math.min(lo + 1, s.length - 1)]! - s[lo]!) * (at - lo);
}

// Windows starting on the local hours divisible by `hours` in `timeZone` (midnight, 6 am, noon and 6 pm for six),
// from the window holding `from` to the one holding `to`. Found hour by hour, so a change of clocks gives one
// window an hour more or less instead of shifting every window after it.
export function windowStarts(from: number, to: number, hours: number, timeZone: string): number[] {
  const hourOf = new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', hourCycle: 'h23' });
  const onBoundary = (t: number) => (Number(hourOf.format(t)) % 24) % hours === 0;
  let t = Math.floor(from / HOUR) * HOUR;
  while (!onBoundary(t)) t -= HOUR;
  const out: number[] = [];
  for (; t <= to; t += HOUR) if (onBoundary(t)) out.push(t);
  return out;
}

// A step function's value at `t`: the last point at or before it.
function valueAt(series: [number, number][], t: number): number {
  let v = series[0]?.[1] ?? 0;
  for (const [at, n] of series) {
    if (at > t) break;
    v = n;
  }
  return v;
}

export interface MetricsInput {
  events: LedgerEvent[];
  plan: Plan;
  now: number;
  history?: [number, number][]; // [time, tasks in the plan], from the plan's git history
  windowHours?: number;
  timeZone?: string;
  targets?: Record<string, number | undefined>; // each agent's weekly_target, for the pace lines
}

export function buildMetrics(input: MetricsInput): MetricsModel {
  const { events, plan, now } = input;
  const windowHours = input.windowHours ?? 6;
  const timeZone = input.timeZone ?? 'America/Chicago';
  const passes = events.filter((e): e is Pass => e.kind === 'pass').sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const agents = [...new Set(passes.map((p) => p.agent))].sort();
  const noteOf: NoteOf = (p) => {
    const a = plan.tasks.get(p.task)?.attempts[p.attempt - 1];
    return a && a.agent === p.agent && a.outcome === p.outcome && (a.note?.length ?? 0) > (p.note?.length ?? 0) ? a.note! : (p.note ?? '');
  };
  const loopStart = events.find((e) => e.kind === 'loop' && e.event === 'start');
  const startedAt = loopStart ? Date.parse(loopStart.at) : passes[0] ? Date.parse(passes[0].at) - passes[0].durationMs : undefined;

  // Recurring failures: the same test failing passes of two or more different tasks.
  const byFailing = new Map<string, { tasks: Set<string>; failures: number; last: number }>();
  for (const p of passes) {
    if (p.outcome === 'merged') continue;
    const f = failureSignature(p, noteOf);
    if (!f) continue;
    const r = byFailing.get(f) ?? { tasks: new Set(), failures: 0, last: 0 };
    r.tasks.add(p.task);
    r.failures++;
    r.last = Math.max(r.last, Date.parse(p.at));
    byFailing.set(f, r);
  }
  const recurringSet = new Set([...byFailing].filter(([, r]) => r.tasks.size >= 2).map(([f]) => f));

  const rows: PassRow[] = passes.map((p) => {
    const end = Date.parse(p.at);
    const start = p.startedAt ? Date.parse(p.startedAt) : end - p.durationMs;
    let category = categorise(p);
    const failing = failureSignature(p, noteOf);
    if (category === 'own' && failing && recurringSet.has(failing)) category = 'recurring';
    return {
      task: p.task,
      agent: p.agent,
      attempt: p.attempt,
      outcome: p.outcome,
      category,
      start,
      end,
      ms: p.durationMs,
      agentMs: p.phases?.agentMs,
      gateMs: p.gateMs,
      costUsd: p.costUsd ?? 0,
      tokens: (p.tokens?.input ?? 0) + (p.tokens?.output ?? 0),
      cached: p.tokens?.cachedInput ?? 0,
      failedStep: stepOf(p, noteOf),
      failing,
      carried: p.carried ? true : undefined,
      scripts: p.scripts,
      e2eRuns: p.e2e?.runs,
      toolCalls: p.toolCalls,
    };
  });

  // Tasks done over time: each task's first merge.
  const doneAt = new Map<string, number>();
  for (const r of rows) if (r.outcome === 'merged' && !doneAt.has(r.task)) doneAt.set(r.task, r.end);
  const doneTimes = [...doneAt.values()].sort((a, b) => a - b);
  const done: [number, number][] = doneTimes.map((t, i) => [t, i + 1]);
  const totalNow = plan.tasks.size;
  const total: [number, number][] = [...(input.history ?? []).filter(([t]) => t <= now), [now, totalNow]];

  // First-try: merged on the task's first attempt that counted (interruptions don't count).
  const firstTryTasks = new Set<string>();
  const counted = new Map<string, number>();
  for (const r of rows) {
    if (COUNTED_OUT.includes(r.outcome)) continue;
    const n = (counted.get(r.task) ?? 0) + 1;
    counted.set(r.task, n);
    if (r.outcome === 'merged' && n === 1) firstTryTasks.add(r.task);
  }

  const emptyHours = () => Object.fromEntries(CATEGORIES.map((c) => [c, 0])) as Record<Category, number>;
  const starts = startedAt !== undefined ? windowStarts(startedAt, now, windowHours, timeZone) : [];
  const windows: Window[] = starts.map((s, i) => ({
    start: s,
    end: starts[i + 1] ?? s + windowHours * HOUR,
    ...((starts[i + 1] ?? s + windowHours * HOUR) > now ? { partial: true } : {}),
    passes: 0,
    merged: 0,
    firstTry: 0,
    hours: emptyHours(),
    costUsd: 0,
    tokens: 0,
    byAgent: {},
  }));
  const windowOf = (t: number) => windows.find((w) => t >= w.start && t < w.end) ?? windows.at(-1);
  for (const r of rows) {
    const w = windowOf(r.end);
    if (!w) continue;
    w.passes++;
    w.hours[r.category] += r.ms / HOUR;
    w.costUsd += r.costUsd;
    w.tokens += r.tokens;
    const a = (w.byAgent[r.agent] ??= { merged: 0, costUsd: 0, tokens: 0 });
    a.costUsd += r.costUsd;
    a.tokens += r.tokens;
    if (r.outcome === 'merged') {
      w.merged++;
      a.merged++;
      if (firstTryTasks.has(r.task) && doneAt.get(r.task) === r.end) w.firstTry++;
    }
  }

  // The last 24 hours against the 24 before them.
  const between = (from: number, to: number) => rows.filter((r) => r.end > from && r.end <= to);
  const last = between(now - 24 * HOUR, now);
  const prev = between(now - 48 * HOUR, now - 24 * HOUR);
  const mergedIn = (rs: PassRow[]) => rs.filter((r) => r.outcome === 'merged').length;
  const share = (n: number, of: number) => (of > 0 ? n / of : undefined);
  const covered = startedAt !== undefined ? Math.min(24, (now - startedAt) / HOUR) : 24;
  const prevCovered = startedAt !== undefined ? Math.max(0, Math.min(24, (now - 24 * HOUR - startedAt) / HOUR)) : 0;
  const kpi: Kpi = {
    done: doneAt.size,
    total: totalNow,
    rate24: covered > 0 ? mergedIn(last) / covered : 0,
    ratePrev24: prevCovered >= 6 ? mergedIn(prev) / prevCovered : undefined,
    mergeRate24: share(mergedIn(last), last.length),
    mergeRatePrev24: share(mergedIn(prev), prev.length),
    firstTryRate: share(firstTryTasks.size, doneAt.size),
    agentHoursPerTask24: mergedIn(last) ? last.reduce((s, r) => s + r.ms, 0) / HOUR / mergedIn(last) : undefined,
    costPerTask24: mergedIn(last) ? last.reduce((s, r) => s + r.costUsd, 0) / mergedIn(last) : undefined,
    costPerTaskPrev24: mergedIn(prev) ? prev.reduce((s, r) => s + r.costUsd, 0) / mergedIn(prev) : undefined,
    tokensPerTask24: mergedIn(last) ? last.reduce((s, r) => s + r.tokens, 0) / mergedIn(last) : undefined,
  };

  const projection = project({ now, windows, done: kpi.done, total, totalNow, covered, mergedLast: mergedIn(last) });
  const stats = buildStats(events, agents, now);

  const failedSteps = [...rows.filter((r) => r.outcome !== 'merged').reduce((m, r) => m.set(r.failedStep ?? 'unknown', (m.get(r.failedStep ?? 'unknown') ?? 0) + 1), new Map<string, number>())]
    .map(([step, failures]) => ({ step, failures }))
    .sort((a, b) => b.failures - a.failures);

  const recurring: Recurring[] = [...byFailing]
    .filter(([f]) => recurringSet.has(f))
    .map(([failing, r]) => ({ failing, tasks: [...r.tasks].sort(), failures: r.failures, last: r.last }))
    .sort((a, b) => b.last - a.last);

  // Gate step timings, from the passes that recorded them.
  const timed = passes.filter((p) => p.gateSteps?.length);
  const stepRuns = new Map<string, number[]>();
  for (const p of timed) for (const s of p.gateSteps!) stepRuns.set(s.step, [...(stepRuns.get(s.step) ?? []), s.ms]);
  const stepFailures = new Map<string, number>();
  for (const r of rows) if (r.failedStep && r.outcome !== 'merged') stepFailures.set(r.failedStep, (stepFailures.get(r.failedStep) ?? 0) + 1);
  const steps: StepTime[] = [...stepRuns]
    .map(([step, ms]) => ({ step, runs: ms.length, medianMs: median(ms), p90Ms: quantile(ms, 0.9), failures: stepFailures.get(step) ?? 0 }))
    .sort((a, b) => a.step.localeCompare(b.step, 'en', { numeric: true }));

  // Passes that started from an earlier attempt's kept work, against the others, since that was recorded.
  const recordedSince = passes.find((p) => p.phases)?.at;
  const comparable = recordedSince ? rows.filter((r) => r.end >= Date.parse(recordedSince) && !COUNTED_OUT.includes(r.outcome)) : [];
  const carriedRows = comparable.filter((r) => r.carried);
  const freshRows = comparable.filter((r) => !r.carried);
  const carry: CarryStats = {
    passes: carriedRows.length,
    merged: mergedIn(carriedRows),
    medianMs: carriedRows.length ? median(carriedRows.map((r) => r.ms)) : undefined,
    freshPasses: freshRows.length,
    freshMerged: mergedIn(freshRows),
    freshMedianMs: freshRows.length ? median(freshRows.map((r) => r.ms)) : undefined,
  };

  // Whether running the whole integration suite before finishing pays: how often agents did, and how often
  // passes then failed at the gate's integration step anyway.
  const withScripts = comparable.filter((r) => r.scripts);
  const ranIntegration = (r: PassRow) => (r.scripts?.['test:integration'] ?? 0) > 0;
  const atIntegration = (r: PassRow) => /(^|:)\d*-?integration$/.test(r.failedStep ?? '');
  const integration = {
    passes: withScripts.length,
    ran: withScripts.filter(ranIntegration).length,
    failedAtIntegration: withScripts.filter(atIntegration).length,
    failedAtIntegrationRan: withScripts.filter((r) => ranIntegration(r) && atIntegration(r)).length,
  };

  const statuses = [...plan.tasks.values()].map((t) => t.status);
  return {
    generatedAt: now,
    passCount: passes.length,
    startedAt,
    windowHours,
    timeZone,
    categories: CATEGORIES.map((key) => ({ key, label: CATEGORY_LABEL[key] })),
    agents,
    done,
    total,
    windows,
    kpi,
    projection,
    usage: stats.agents,
    upMs: stats.upMs,
    failedSteps,
    recurring,
    steps,
    stepsSince: timed[0] ? Date.parse(timed[0].at) : undefined,
    carry,
    integration,
    recent: rows.slice(-40).reverse(),
    plan: {
      ready: statuses.filter((s) => s === 'ready').length,
      claimed: statuses.filter((s) => s === 'claimed').length,
      needsHuman: statuses.filter((s) => s === 'needs_human').length,
      parked: statuses.filter((s) => s === 'parked').length,
      humanOpen: [...plan.human.values()].filter((h) => h.status !== 'done').length,
    },
    allowance: allowanceOf(passes, agents, input.targets ?? {}),
  };
}

// The weekly windows the passes reported, recorded since 2026-10-25. A window is known by its reset time,
// which a CLI may state a second or two apart from one reading to the next.
function allowanceOf(passes: Pass[], agents: string[], targets: Record<string, number | undefined>): Allowance[] {
  return agents
    .map((agent) => {
      const windows: Allowance['windows'] = [];
      for (const p of passes) {
        if (p.agent !== agent || p.usage?.weekly === undefined || !p.usage.weeklyResetsAt) continue;
        const resetsAt = Date.parse(p.usage.weeklyResetsAt);
        let w = windows.find((x) => Math.abs(x.resetsAt - resetsAt) < 10 * 60_000);
        if (!w) windows.push((w = { resetsAt, points: [] }));
        w.points.push([Date.parse(p.at), p.usage.weekly]);
      }
      return { agent, target: targets[agent], windows: windows.sort((a, b) => a.resetsAt - b.resetsAt) };
    })
    .filter((a) => a.windows.length);
}

// When the build finishes if the recent trend holds: tasks keep merging at the last 24 hours' rate, and the
// plan keeps growing at its rate over the same span. The slow and fast rates come from the spread of the last
// eight full windows (their 25th and 75th percentiles), widened to take in the 24-hour rate itself, so the band
// says how steady the pace has been and always holds the central projection.
export function project(input: {
  now: number;
  windows: Window[];
  done: number;
  total: [number, number][];
  totalNow: number;
  covered: number; // hours of the last 24 the build has run
  mergedLast: number;
}): Projection {
  const { now, windows, done, total, totalNow, covered, mergedLast } = input;
  const span = Math.max(covered, 1);
  const rate = mergedLast / span;
  const growth = Math.max(0, (totalNow - valueAt(total, now - span * HOUR)) / span);
  const full = windows.filter((w) => w.end <= now).slice(-8);
  const rates = full.map((w) => w.merged / ((w.end - w.start) / HOUR));
  const low = rates.length >= 3 ? Math.min(rate, quantile(rates, 0.25)) : undefined;
  const high = rates.length >= 3 ? Math.max(rate, quantile(rates, 0.75)) : undefined;
  const remaining = Math.max(0, totalNow - done);
  const eta = (r: number | undefined, g: number) => (r !== undefined && r - g > 1e-9 ? now + (remaining / (r - g)) * HOUR : undefined);
  return {
    basis: covered >= 24 ? 'the last 24 hours' : `the ${Math.max(1, Math.round(covered))} hours so far`,
    rate,
    growth,
    low,
    high,
    finish: remaining === 0 ? now : eta(rate, growth),
    finishLow: eta(low, growth),
    finishHigh: eta(high, growth),
    finishNoGrowth: remaining === 0 ? now : eta(rate, 0),
  };
}
