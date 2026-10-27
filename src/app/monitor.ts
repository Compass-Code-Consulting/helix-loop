import { existsSync, readFileSync } from 'node:fs';
import { MONITOR_LEVELS, MONITOR_PRESETS, monitorModel, monitorOf, type Config, type MonitorLevel } from '../config.ts';
import { failingTest } from '../flaky.ts';
import type { LedgerEvent } from '../ledger.ts';
import { UNCOUNTED_OUTCOMES, type AgentName } from '../types.ts';
import type { Report } from './state.ts';

// When Helix's monitor takes a turn (spec §9.1), by its level, and what each level would cost at the loop's
// recent pace. Daniel's own asks (a human task done, "Ask Helix to revise", "Run a turn now") always run; the
// heartbeat is a schedule, set by the level's every_minutes.

const DAY = 86_400_000;

// What happened that the monitor might look at.
export type MonitorChange =
  | { kind: 'pass'; failed: boolean; repeat: boolean } // a pass ended; repeat: a failure seen before
  | { kind: 'report'; issue: boolean } // a builder's report: an issue, or progress
  | { kind: 'asked' }; // Daniel asked for a turn

export function monitorShouldRun(level: MonitorLevel, change: MonitorChange): boolean {
  if (change.kind === 'asked' || level === 'thorough') return true;
  // Light and standard look only at what needs judgment: a failure the next attempt is unlikely to fix by
  // itself, and a builder saying it is stuck or unsure.
  return change.kind === 'pass' ? change.failed && change.repeat : change.issue;
}

// The changes among the events and reports after the first `since` of each. A failed pass repeats when its task
// failed before, or when the same named test failed another pass within the week: an open incident either way.
export function monitorChanges(events: LedgerEvent[], reports: Report[], since: { events: number; reports: number }): { at: string; change: MonitorChange }[] {
  const out: { at: string; change: MonitorChange }[] = [];
  const failures = new Map<string, number>(); // task → failed passes
  const tests = new Map<string, number>(); // a failing test → when it last failed
  events.forEach((e, i) => {
    if (e.kind !== 'pass') return;
    const failed = e.outcome !== 'merged' && !(UNCOUNTED_OUTCOMES as readonly string[]).includes(e.outcome);
    const at = Date.parse(e.at);
    const test = failed && e.failing && failingTest(e.failing) ? e.failing : undefined;
    const repeat = failed && ((failures.get(e.task) ?? 0) > 0 || (!!test && at - (tests.get(test) ?? -Infinity) < 7 * DAY));
    if (i >= since.events) out.push({ at: e.at, change: { kind: 'pass', failed, repeat } });
    if (failed) failures.set(e.task, (failures.get(e.task) ?? 0) + 1);
    if (test) tests.set(test, at);
  });
  for (const r of reports.slice(since.reports)) out.push({ at: r.at, change: { kind: 'report', issue: r.kind === 'issue' } });
  return out.sort((a, b) => a.at.localeCompare(b.at));
}

// The turns the server's schedule would take: a trigger starts a turn at least 5 s later and a minute after the
// one before, coalescing what comes meanwhile; the heartbeat takes one when none ran for `every` minutes while
// the loop ran.
export function simulateTurns(input: { triggers: number[]; running: [number, number][]; everyMinutes?: number; from: number; to: number }): { turns: number; heartbeats: number } {
  const every = input.everyMinutes ? input.everyMinutes * 60_000 : Infinity;
  const nextBeat = (after: number) => {
    const due = after + every;
    const span = input.running.find(([, end]) => end > due);
    return span ? Math.max(due, span[0]) : Infinity;
  };
  let last = -Infinity; // when the last turn ran: the server's first waits only the 5 s
  let pending = -Infinity;
  let turns = 0;
  let heartbeats = 0;
  for (const t of [...input.triggers.filter((x) => x >= input.from && x < input.to).sort((a, b) => a - b), input.to]) {
    for (let beat = nextBeat(Math.max(last, input.from)); beat < t && beat < input.to; beat = nextBeat(last)) {
      last = beat;
      heartbeats++;
      turns++;
    }
    if (t >= input.to) break;
    if (t <= pending) continue;
    pending = last = Math.max(t + 5_000, last + 60_000);
    turns++;
  }
  return { turns, heartbeats };
}

// When the loop ran, from its start and exit lines; a start with no exit runs to now.
export function runningSpans(events: LedgerEvent[], now: number): [number, number][] {
  const spans: [number, number][] = [];
  let start: number | undefined;
  for (const e of events) {
    if (e.kind !== 'loop' || (e.event !== 'start' && e.event !== 'exit')) continue;
    if (e.event === 'start') start ??= Date.parse(e.at);
    else if (start !== undefined) {
      spans.push([start, Date.parse(e.at)]);
      start = undefined;
    }
  }
  if (start !== undefined) spans.push([start, now]);
  return spans;
}

// A monitor turn's cost when none has run on that model yet: measured Opus turns came to about $0.25 at medium
// effort (runs/steward.jsonl), more at high; Sonnet to about a quarter of that at low effort and less than half
// at medium; a short Codex turn to $0.05.
export function fallbackTurnUsd(agent: AgentName, model: string, effort = 'medium'): number {
  if (agent === 'codex') return 0.05;
  if (/haiku/.test(model)) return 0.02;
  if (/sonnet/.test(model)) return effort === 'low' ? 0.06 : 0.1;
  return effort === 'high' || effort === 'xhigh' ? 0.35 : 0.25;
}

// What monitor turns on each model and effort have cost, from runs/helix.jsonl.
export function monitorTurnCosts(file: string): Map<string, { usd: number; n: number }> {
  const out = new Map<string, { usd: number; n: number }>();
  if (!existsSync(file)) return out;
  for (const l of readFileSync(file, 'utf8').split('\n')) {
    if (!l.startsWith('{')) continue;
    try {
      const r = JSON.parse(l) as { role?: string; model?: string; effort?: string; costUsd?: number; ok?: boolean };
      if (r.role !== 'monitor' || !r.ok || !r.model || typeof r.costUsd !== 'number') continue;
      // Turns before efforts were recorded ran at medium.
      const k = `${r.model} ${r.effort ?? 'medium'}`;
      const c = out.get(k) ?? { usd: 0, n: 0 };
      out.set(k, { usd: c.usd + r.costUsd, n: c.n + 1 });
    } catch {
      // a line mid-append
    }
  }
  return out;
}

export interface LevelEstimate {
  level: MonitorLevel;
  model: string;
  effort: string;
  triggers: number; // turns the day's passes and reports would have started
  heartbeats: number;
  turns: number;
  usdPerTurn: number;
  measured: number; // monitor turns the cost per turn comes from; 0 when it is the fallback
  everyMinutes?: number; // its heartbeat
  capUsd: number; // the cap in force at this level
  presetCapUsd: number; // the level's own, without a cap set in the config
  usdPerDay: number; // capped
  capped: boolean;
}

// What each level would have spent over the last day of the loop, for Settings › Helix.
export function estimateLevels(input: { config: Config; agent: AgentName; events: LedgerEvent[]; reports: Report[]; costs: Map<string, { usd: number; n: number }>; now: number }): { agent: AgentName; passes: number; issues: number; levels: LevelEstimate[] } {
  const { config, agent, events, reports, now } = input;
  const from = now - DAY;
  const since = { events: firstAfter(events, from), reports: firstAfter(reports, from) };
  const changes = monitorChanges(events, reports, since);
  const running = runningSpans(events, now);
  const passes = changes.filter((c) => c.change.kind === 'pass').length;
  const issues = changes.filter((c) => c.change.kind === 'report' && c.change.issue).length;
  return { agent, passes, issues, levels: MONITOR_LEVELS.map((level) => {
    const m = monitorOf(config, level);
    const { model, effort } = monitorModel(config, agent, level);
    const triggers = changes.filter((c) => monitorShouldRun(level, c.change)).map((c) => Date.parse(c.at));
    const sim = simulateTurns({ triggers, running, everyMinutes: m.everyMinutes, from, to: now });
    const cost = input.costs.get(`${model} ${effort}`);
    const usdPerTurn = cost?.n ? cost.usd / cost.n : fallbackTurnUsd(agent, model, effort);
    const usd = sim.turns * usdPerTurn;
    return { level, model, effort, triggers: triggers.length, heartbeats: sim.heartbeats, turns: sim.turns, usdPerTurn, measured: cost?.n ?? 0, everyMinutes: m.everyMinutes, capUsd: m.budgetUsd, presetCapUsd: MONITOR_PRESETS[level].budgetUsd, usdPerDay: Math.min(usd, m.budgetUsd), capped: usd > m.budgetUsd };
  }) };
}

// The index of the first line at or after a time; the files are appended in time order.
function firstAfter(rows: { at: string }[], ms: number): number {
  const at = new Date(ms).toISOString();
  const i = rows.findIndex((r) => r.at >= at);
  return i < 0 ? rows.length : i;
}
