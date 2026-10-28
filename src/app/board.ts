import type { Config } from '../config.ts';
import type { LedgerEvent } from '../ledger.ts';
import { computeMap, rankTasks } from '../map/graph.ts';
import { meanPassHours } from '../ledger.ts';
import { membership, recordedReached } from '../plan/milestones.ts';
import { countedAttempts } from '../sched/scheduler.ts';
import type { AgentName, Level, MapAgent, Plan, RepoName, Task, Timeline } from '../types.ts';
import { expectedHumanDone, project, type Projection } from './projection.ts';

// The board: the plan as the Map and Home read it. Every task with its story, milestone, bar (what happened for
// finished work, the projection for the rest), what it holds up and whether it is on the frontier; every human task
// with what it holds up and how late it is; the TaskSet's lanes, epics, features and stories, each with the tasks
// under it, for the Map to roll up; and the milestones with their dates. Derived from the files on each change of
// the plan or the ledger, never stored.

const HOUR = 3_600_000;
const FAILED = new Set(['gate_failed', 'no_commit', 'forbidden_paths', 'timeout', 'agent_error']);

export interface BoardTask {
  id: string;
  title: string;
  status: Task['status'];
  lane: RepoName;
  story: string; // its story item's id, `story:<key>`
  milestone?: string; // its milestone's key
  placeholderFor?: string[];
  wires?: string[];
  agent: AgentName | null; // holder while claimed, or the agent that merged it
  estimate: number;
  critical: boolean;
  start?: number; // the bar: actual for finished work, projected for the rest
  end?: number;
  projected: boolean;
  fails: number[]; // when each failed attempt ended
  attempts: number; // counted attempts
  failing?: boolean; // open, and its last attempt failed
  deps?: string[]; // every task and human task it waits on (blocked_by), for the Map's dependency lines
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
  deps?: string[]; // the human tasks it waits on (blocked_by)
  leadDays: number;
  latestStart?: number; // when it must start for the build not to wait on it
  late: boolean;
  expectedDone?: number;
  critical: boolean;
  frontier: boolean;
}

// A lane, epic, feature or story, with the tasks under it; the page rolls each up from its tasks (map rows.js), so a
// milestone filter can roll up only that milestone's share.
export interface BoardItem {
  id: string; // `${level}:${key}`: keys are unique per level across the TaskSet
  level: Level;
  key: string;
  title: string;
  repo: RepoName; // its lane's, for the lane's colour
  about?: string; // the epic's outcome, the feature's capability, the story's need
  parent?: string;
  children: string[];
  tasks: string[]; // every task under it, in the TaskSet's order
}

export interface BoardMilestone {
  key: string;
  title: string;
  demo: string;
  tasks: string[];
  done: number;
  reached: boolean;
  at?: number; // when it was reached (its last merge), or is projected to be
}

export interface Board {
  now: number;
  passHours: number;
  slots: number;
  finish: number; // projected: project complete
  codeFinish?: number; // code complete, when the TaskSet shows it
  timelines: Timeline[];
  revision?: number; // the TaskSet's
  items: BoardItem[]; // lanes in order, each followed by its epics, each by its features, each by its stories
  milestones: BoardMilestone[]; // in delivery order
  unplaced: string[]; // tasks whose story the TaskSet doesn't declare: shown in their lane under "Not in the TaskSet"
  tasks: BoardTask[];
  human: BoardHuman[];
  criticalPath: string[];
}

export interface BoardInput {
  plan: Plan;
  events: LedgerEvent[];
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
  const { plan, events, agents, running, config, now } = input;
  const timelines = plan.taskset?.timelines ?? ['code', 'project'];
  const passHours = meanPassHours(events);
  const map = computeMap(plan, { now, passHours, agents, mode: 'idle' });
  const node = new Map(map.nodes.map((n) => [n.id, n]));
  const rank = rankTasks(map, plan);
  const slots = slotsNow(config, agents);
  const runs = running.map((r) => ({ task: r.task, startedAt: Date.parse(r.startedAt) }));
  const projection = project({ plan, rank, now, passHours, slots, running: runs });
  // Code complete: the same run with every open human task done now, before anything needs it, so no lead time
  // counts. Never later than project complete: with fewer waits, the greedy schedule can come out a little longer.
  const codeFinish = timelines.includes('code')
    ? Math.min(projection.finish, project({ plan, rank, now, passHours, slots, running: runs, humanDone: new Map([...projection.human.keys()].map((id) => [id, now])), withHuman: false }).finish)
    : undefined;
  const dependents = dependentsOf(plan);
  const member = membership(plan);
  const { items, unplaced } = boardItems(plan);

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
      story: `story:${plan.taskset?.stories.has(t.story) ? t.story : unplacedKey(t.repo)}`,
      ...(member.of.has(t.id) ? { milestone: member.of.get(t.id) } : {}),
      ...(t.placeholder_for?.length ? { placeholderFor: t.placeholder_for } : {}),
      ...(t.wires?.length ? { wires: t.wires } : {}),
      agent: t.claimed_by ?? t.attempts.findLast((a) => a.outcome === 'merged')?.agent ?? null,
      estimate: t.estimate_passes,
      critical: n.critical,
      start,
      end,
      projected: t.status !== 'done',
      fails: fails.get(t.id) ?? [],
      attempts: countedAttempts(t),
      ...(lastFailed ? { failing: true } : {}),
      ...(t.blocked_by.length ? { deps: t.blocked_by } : {}),
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
      ...(h.blocked_by.length ? { deps: h.blocked_by } : {}),
      leadDays: h.lead_time_days,
      latestStart,
      late,
      expectedDone: projection.human.get(h.id),
      critical: h.status !== 'done' && (n.critical || late),
      frontier: h.status !== 'done' && held > 0 && (late || (latestStart !== undefined && latestStart < now + 7 * 24 * HOUR) || h.status === 'in_progress'),
    };
  });

  const byId = new Map(tasks.map((t) => [t.id, t]));
  const recorded = recordedReached(events);
  const milestones: BoardMilestone[] = (plan.milestones ?? []).map((m) => {
    const ids = member.tasks.get(m.key) ?? [];
    const done = ids.filter((id) => byId.get(id)?.status === 'done').length;
    const allDone = ids.length > 0 && done === ids.length;
    const reachedAt = recorded.get(m.key);
    const reached = allDone || reachedAt !== undefined;
    const at = allDone ? Math.max(...ids.map((id) => byId.get(id)!.end ?? 0)) : reachedAt ? Date.parse(reachedAt) : projection.milestones.get(m.key);
    return { key: m.key, title: m.title, demo: m.demo, tasks: ids, done, reached, ...(at ? { at } : {}) };
  });

  return {
    now,
    passHours,
    slots,
    finish: projection.finish,
    ...(codeFinish !== undefined ? { codeFinish } : {}),
    timelines,
    ...(plan.taskset ? { revision: plan.taskset.revision } : {}),
    items,
    milestones,
    unplaced,
    tasks,
    human,
    criticalPath: map.criticalPath,
    projection,
    rank,
  };
}

// The story that holds a lane's tasks whose story the TaskSet doesn't declare (or every task, without a version 2
// TaskSet), so the Map still shows them; validation reports each.
const unplacedKey = (repo: string) => `not-in-the-taskset-${repo}`;

// The TaskSet as items, in reading order: each lane, then its epics, each followed by its features, each by its
// stories. A repo with tasks no lane holds gets a lane of its own.
export function boardItems(plan: Plan): { items: BoardItem[]; unplaced: string[] } {
  const ts = plan.taskset;
  const items: BoardItem[] = [];
  const byStory = new Map<string, string[]>();
  const unplaced: string[] = [];
  for (const t of plan.tasks.values()) {
    const key = ts?.stories.has(t.story) ? t.story : unplacedKey(t.repo);
    if (key !== t.story) unplaced.push(t.id);
    byStory.set(key, [...(byStory.get(key) ?? []), t.id]);
  }
  const lanes = [...(ts?.lanes ?? [])].map((l) => ({ ...l }));
  for (const id of unplaced) {
    const repo = plan.tasks.get(id)!.repo;
    if (!lanes.some((l) => l.repo === repo)) lanes.push({ key: repo, repo, epics: [] });
  }
  const add = (level: Level, key: string, title: string, repo: string, parent: string | undefined, about?: string): BoardItem => {
    const item: BoardItem = { id: `${level}:${key}`, level, key, title, repo, ...(about ? { about } : {}), ...(parent ? { parent } : {}), children: [], tasks: [] };
    items.push(item);
    return item;
  };
  for (const l of lanes) {
    const lane = add('lane', l.key, l.key, l.repo, undefined);
    const stray = unplaced.some((id) => plan.tasks.get(id)!.repo === l.repo && lanes.find((x) => x.repo === l.repo) === l);
    const epics = [...l.epics.map((k) => ts!.epics.get(k)!), ...(stray ? [{ key: unplacedKey(l.repo), title: 'Not in the TaskSet', outcome: '', features: [unplacedKey(l.repo)] }] : [])];
    for (const e of epics) {
      const epic = add('epic', e.key, e.title, l.repo, lane.id, e.outcome);
      lane.children.push(epic.id);
      const features = e.key === unplacedKey(l.repo) ? [{ key: e.key, title: 'Not in the TaskSet', capability: undefined, stories: [e.key] }] : e.features.map((k) => ts!.features.get(k)!);
      for (const f of features) {
        const feature = add('feature', f.key, f.title, l.repo, epic.id, f.capability);
        epic.children.push(feature.id);
        for (const sk of f.stories) {
          const s = ts?.stories.get(sk);
          const story = add('story', sk, s?.title ?? 'Tasks whose story the TaskSet does not declare', l.repo, feature.id, s?.need);
          feature.children.push(story.id);
          story.tasks = byStory.get(sk) ?? [];
          feature.tasks.push(...story.tasks);
        }
        epic.tasks.push(...feature.tasks);
      }
      lane.tasks.push(...epic.tasks);
    }
  }
  return { items, unplaced };
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
