import type { Config } from '../config.ts';
import type { LedgerEvent } from '../ledger.ts';
import { computeMap, rankTasks } from '../map/graph.ts';
import { meanPassHours } from '../ledger.ts';
import { countedAttempts } from '../sched/scheduler.ts';
import type { AgentName, MapAgent, Plan, RepoName, Stage, Task } from '../types.ts';
import { expectedHumanDone, project, type Projection } from './projection.ts';
import type { TaskSet, Timeline } from './taskset.ts';

// The board: the plan as the Map and Home read it. Every task with its lane, epic, bar (what happened for
// finished work, the projection for the rest), what it holds up and whether it is on the frontier; every
// human task with what it holds up and how late it is; every epic rolled up. Derived from the files on each
// change of the plan or the ledger, never stored.

const HOUR = 3_600_000;
const FAILED = new Set(['gate_failed', 'no_commit', 'forbidden_paths', 'timeout', 'agent_error']);

export interface BoardTask {
  id: string;
  title: string;
  status: Task['status'];
  lane: RepoName;
  epic: string; // Epic.id
  stage?: Stage;
  agent: AgentName | null; // holder while claimed, or the agent that merged it
  estimate: number;
  critical: boolean;
  start?: number; // the bar: actual for finished work, projected for the rest
  end?: number;
  projected: boolean;
  fails: number[]; // when each failed attempt ended
  attempts: number; // counted attempts
  waits?: string[]; // what it waits on that needs a person: open human tasks, tasks that need you
  held?: number; // open tasks waiting on it, directly or not (waiting items only)
  frontier: boolean;
  summary?: string;
  fixFirst?: boolean;
  commit?: string; // the merge commit on main, for finished work
}

export interface BoardHuman {
  id: string;
  title: string;
  status: 'todo' | 'in_progress' | 'done';
  held: number;
  leadDays: number;
  latestStart?: number; // when it must start for the build not to wait on it
  late: boolean;
  expectedDone?: number;
  critical: boolean;
  frontier: boolean;
}

export interface BoardEpic {
  id: string;
  key: string;
  lane: RepoName;
  title: string;
  stage?: Stage;
  tasks: string[];
  done: number;
  running: number;
  failing: number;
  waiting: number; // needs you, parked, or behind a human task
  start?: number;
  end?: number;
  frontier: boolean;
  critical: boolean;
  waitsOn?: string; // the human task most of its open work waits on
}

export interface Board {
  now: number;
  passHours: number;
  slots: number;
  finish: number; // projected: project complete
  codeFinish?: number; // code complete, when the TaskSet shows it
  timelines: Timeline[];
  lanes: { name: RepoName; epics: string[]; done: number; total: number }[];
  epics: BoardEpic[];
  tasks: BoardTask[];
  human: BoardHuman[];
  criticalPath: string[];
  derivedEpics: boolean;
  missingEpics: string[];
}

export interface BoardInput {
  plan: Plan;
  events: LedgerEvent[];
  taskset: TaskSet;
  agents: MapAgent[];
  running: { task: string; agent: AgentName; startedAt: string }[];
  config: Config;
  now: number;
}

// Open tasks waiting on `id`, directly or through other tasks.
export function downstream(plan: Plan, dependents: Map<string, string[]>, id: string): Set<string> {
  const seen = new Set<string>();
  const stack = [...(dependents.get(id) ?? [])];
  while (stack.length) {
    const d = stack.pop()!;
    if (seen.has(d)) continue;
    const t = plan.tasks.get(d);
    if (t && t.status === 'done') continue;
    seen.add(d);
    stack.push(...(dependents.get(d) ?? []));
  }
  for (const d of [...seen]) if (!plan.tasks.has(d)) seen.delete(d);
  return seen;
}

export function dependentsOf(plan: Plan): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const add = (from: string, to: string) => {
    let l = out.get(from);
    if (!l) out.set(from, (l = []));
    l.push(to);
  };
  for (const t of plan.tasks.values()) for (const d of t.blocked_by) add(d, t.id);
  for (const h of plan.human.values()) for (const d of h.blocked_by) add(d, h.id);
  return out;
}

// The slots the loop has now: each enabled agent's, as its pace allows; one at least, so a stopped loop still
// projects.
export function slotsNow(config: Config, agents: MapAgent[]): number {
  return Math.max(1, agents.reduce((n, a) => n + (config.agents[a.name].enabled && a.state !== 'limited' ? (a.paced ?? a.slots) : 0), 0));
}

export function buildBoard(input: BoardInput): Board & { projection: Projection; rank: string[] } {
  const { plan, events, taskset, agents, running, config, now } = input;
  const passHours = meanPassHours(events);
  const map = computeMap(plan, { now, passHours, agents, mode: 'idle' });
  const node = new Map(map.nodes.map((n) => [n.id, n]));
  const rank = rankTasks(map, plan);
  const slots = slotsNow(config, agents);
  const runs = running.map((r) => ({ task: r.task, startedAt: Date.parse(r.startedAt) }));
  const projection = project({ plan, rank, now, passHours, slots, running: runs });
  // Code complete: the same run with every open human task done now, before anything needs it, so no lead time
  // counts. Never later than project complete: with fewer waits, the greedy schedule can come out a little longer.
  const codeFinish = taskset.timelines.includes('code')
    ? Math.min(projection.finish, project({ plan, rank, now, passHours, slots, running: runs, humanDone: new Map([...projection.human.keys()].map((id) => [id, now])), withHuman: false }).finish)
    : undefined;
  const dependents = dependentsOf(plan);

  // What happened to finished work: its first pass's start, its merge, and its failed attempts.
  const firstStart = new Map<string, number>();
  const merged = new Map<string, number>();
  const fails = new Map<string, number[]>();
  const mergeCommit = new Map<string, string>();
  for (const e of events) {
    if (e.kind === 'pass') {
      const at = Date.parse(e.at);
      const start = e.startedAt ? Date.parse(e.startedAt) : at - e.durationMs;
      if (!firstStart.has(e.task) || start < firstStart.get(e.task)!) firstStart.set(e.task, start);
      if (FAILED.has(e.outcome)) {
        let l = fails.get(e.task);
        if (!l) fails.set(e.task, (l = []));
        l.push(at);
      }
    } else if (e.kind === 'merge') {
      merged.set(e.task, Date.parse(e.at));
      mergeCommit.set(e.task, e.commit);
    }
  }

  const runningIds = new Set(running.map((r) => r.task));
  const stuck = (id: string) => {
    const t = plan.tasks.get(id);
    return t ? t.status === 'needs_human' || t.status === 'parked' : plan.human.get(id)?.status !== 'done';
  };
  const tasks: BoardTask[] = [];
  for (const t of plan.tasks.values()) {
    const n = node.get(t.id)!;
    const p = projection.tasks.get(t.id);
    let start: number | undefined, end: number | undefined;
    if (t.status === 'done') {
      end = merged.get(t.id) ?? (t.attempts.findLast((a) => a.outcome === 'merged') ? Date.parse(t.attempts.findLast((a) => a.outcome === 'merged')!.at) : undefined);
      start = firstStart.get(t.id) ?? (end !== undefined ? end - Math.max(0.25, t.estimate_passes * passHours) * HOUR : undefined);
    } else if (p) {
      start = p.start;
      end = p.end;
    }
    const lastFailed = t.status !== 'done' && t.attempts.length > 0 && FAILED.has(t.attempts.at(-1)!.outcome);
    const waits = t.status === 'done' ? [] : t.blocked_by.filter((d) => plan.human.has(d) ? plan.human.get(d)!.status !== 'done' : stuck(d));
    const isWaiting = t.status === 'needs_human' || t.status === 'parked';
    const nextUp = t.status === 'ready' && p !== undefined && p.start < now + 12 * HOUR;
    tasks.push({
      id: t.id,
      title: t.title,
      status: t.status,
      lane: t.repo,
      epic: taskset.epicOf.get(t.id)!.id,
      stage: t.stage,
      agent: t.claimed_by ?? t.attempts.findLast((a) => a.outcome === 'merged')?.agent ?? null,
      estimate: t.estimate_passes,
      critical: n.critical,
      start,
      end,
      projected: t.status !== 'done',
      fails: fails.get(t.id) ?? [],
      attempts: countedAttempts(t),
      ...(waits.length ? { waits } : {}),
      ...(isWaiting ? { held: downstream(plan, dependents, t.id).size } : {}),
      frontier: runningIds.has(t.id) || t.status === 'claimed' || isWaiting || lastFailed || nextUp,
      ...(t.summary ? { summary: t.summary } : {}),
      ...(t.priority === 'fix_first' ? { fixFirst: true } : {}),
      ...(t.status === 'done' && mergeCommit.has(t.id) ? { commit: mergeCommit.get(t.id) } : {}),
    });
  }

  const human: BoardHuman[] = [...plan.human.values()].map((h) => {
    const n = node.get(h.id)!;
    const held = h.status === 'done' ? 0 : downstream(plan, dependents, h.id).size;
    const latestStart = n.latestStart ? Date.parse(n.latestStart) : undefined;
    const late = h.status !== 'done' && latestStart !== undefined && latestStart < now;
    return {
      id: h.id,
      title: h.title,
      status: h.status,
      held,
      leadDays: h.lead_time_days,
      latestStart,
      late,
      expectedDone: projection.human.get(h.id),
      critical: h.status !== 'done' && (n.critical || late),
      frontier: h.status !== 'done' && held > 0 && (late || (latestStart !== undefined && latestStart < now + 7 * 24 * HOUR) || h.status === 'in_progress'),
    };
  });

  const byId = new Map(tasks.map((t) => [t.id, t]));
  const epics: BoardEpic[] = [];
  for (const l of taskset.lanes) {
    for (const e of l.epics) {
      const ts = e.tasks.map((id) => byId.get(id)!).filter(Boolean);
      const starts = ts.map((t) => t.start).filter((x): x is number => x !== undefined);
      const ends = ts.map((t) => t.end).filter((x): x is number => x !== undefined);
      const waitsOn = new Map<string, number>();
      for (const t of ts) for (const w of t.waits ?? []) if (w.startsWith('HT-')) waitsOn.set(w, (waitsOn.get(w) ?? 0) + 1);
      epics.push({
        id: e.id,
        key: e.key,
        lane: e.lane,
        title: e.title,
        stage: e.stage,
        tasks: e.tasks,
        done: ts.filter((t) => t.status === 'done').length,
        running: ts.filter((t) => t.status === 'claimed').length,
        failing: ts.filter((t) => t.status !== 'done' && t.fails.length && t.attempts > 0 && FAILED.has(plan.tasks.get(t.id)!.attempts.at(-1)?.outcome ?? '')).length,
        waiting: ts.filter((t) => t.status === 'needs_human' || t.status === 'parked' || t.waits?.length).length,
        start: starts.length ? Math.min(...starts) : undefined,
        end: ends.length ? Math.max(...ends) : undefined,
        frontier: ts.some((t) => t.frontier),
        critical: ts.some((t) => t.critical),
        waitsOn: [...waitsOn.entries()].sort((a, b) => b[1] - a[1])[0]?.[0],
      });
    }
  }
  const lanes = taskset.lanes.map((l) => {
    const ts = l.epics.flatMap((e) => e.tasks);
    return { name: l.name, epics: l.epics.map((e) => e.id), done: ts.filter((id) => byId.get(id)?.status === 'done').length, total: ts.length };
  });

  return {
    now,
    passHours,
    slots,
    finish: projection.finish,
    ...(codeFinish !== undefined ? { codeFinish } : {}),
    timelines: taskset.timelines,
    lanes,
    epics,
    tasks,
    human,
    criticalPath: map.criticalPath,
    derivedEpics: taskset.derived,
    missingEpics: taskset.missing,
    projection,
    rank,
  };
}

// What leaving items as they are costs, in time on the projected finish, by running the projection again with
// their dates moved. `done now`: human tasks done now instead of after their lead time (what their lateness
// costs). `wait`: human tasks done, and waiting tasks handed back, this much later than now (what each day of
// waiting costs).
export type CostInput = BoardInput & { rank: string[]; slots: number; finish: number };

export function finishMoved(input: CostInput, ids: string[], how: { doneNow: true } | { waitMs: number }): number {
  const { plan, now, events } = input;
  const humanDone = expectedHumanDone(plan, now);
  const handedBack = new Map<string, number>();
  for (const id of ids) {
    if (plan.human.has(id) && humanDone.has(id)) humanDone.set(id, 'doneNow' in how ? now : humanDone.get(id)! + how.waitMs);
    const t = plan.tasks.get(id);
    if (t && (t.status === 'needs_human' || t.status === 'parked') && 'waitMs' in how) handedBack.set(id, now + how.waitMs);
  }
  const p = project({ plan, rank: input.rank, now, passHours: meanPassHours(events), slots: input.slots, running: input.running.map((r) => ({ task: r.task, startedAt: Date.parse(r.startedAt) })), humanDone, handedBack });
  return 'doneNow' in how ? Math.max(0, input.finish - p.finish) : Math.max(0, p.finish - input.finish);
}
