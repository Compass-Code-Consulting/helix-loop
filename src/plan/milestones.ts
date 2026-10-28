import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import type { MilestoneDef, Plan, Task, TaskSetDef } from '../types.ts';

// Helix Milestones (plan/milestones.yaml): the order the TaskSet is delivered in, as named, demoable outcomes. A
// priority, not a gate: the loop prefers ready work in the earliest milestone not yet reached, and takes later work
// when nothing earlier is ready (map/graph.ts rankTasks). A task belongs to the milestone that names it most
// specifically: by its id, else by its story, else by its feature. No task may wait on a task in a later milestone;
// where the order wants that, the Milestones step pulls the dependency forward, or builds the task against a
// placeholder (`placeholder_for`) and wires the real thing in later (`wires`).

export interface MilestonesFile {
  version: 1;
  taskset_revision: number;
  milestones: { key: string; title: string; demo: string; features?: string[]; stories?: string[]; tasks?: string[] }[];
}

export interface MilestonesRead {
  file?: MilestonesFile;
  defs?: MilestoneDef[];
  problems: string[];
}

// The file the TaskSet names (milestones.yaml), which it names from revision 2 on; none before Milestones are planned.
export const milestonesPath = (planDir: string, ts?: TaskSetDef) => (ts?.milestonesFile ? join(planDir, ts.milestonesFile) : undefined);

const keys = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

// Never throws, as readTaskSet: what can't be read is a problem for the validator.
export function readMilestones(file: string): MilestonesRead {
  if (!existsSync(file)) return { problems: [`missing: the TaskSet names ${file.split('/').pop()}, which doesn't exist`] };
  let raw: unknown;
  try {
    raw = parse(readFileSync(file, 'utf8'));
  } catch (e) {
    return { problems: [`cannot be read: ${(e as Error).message.split('\n')[0]}`] };
  }
  const list = (raw as { milestones?: unknown } | null)?.milestones;
  if (!Array.isArray(list)) return { problems: ['has no list of milestones'] };
  const defs = list
    .filter((m): m is Record<string, unknown> => !!m && typeof m === 'object' && typeof (m as { key?: unknown }).key === 'string')
    .map((m) => ({ key: m.key as string, title: String(m.title ?? m.key), demo: String(m.demo ?? ''), features: keys(m.features), stories: keys(m.stories), tasks: keys(m.tasks) }));
  return { file: raw as MilestonesFile, defs, problems: [] };
}

// ---- membership ----

export interface Membership {
  of: Map<string, string>; // task → its milestone's key
  index: Map<string, number>; // milestone key → its place in the order
  tasks: Map<string, string[]>; // milestone key → its tasks, in plan order
  unplaced: string[]; // tasks no milestone names, by id, story or feature
  ambiguous: { task: string; by: 'task' | 'story' | 'feature'; milestones: string[] }[];
}

// Which milestone each task belongs to, most specific first. Two milestones naming the same task, story or feature
// is ambiguous; the first is used, and validation reports it.
export function membership(plan: Plan): Membership {
  const ms = plan.milestones ?? [];
  const index = new Map(ms.map((m, i) => [m.key, i]));
  const named = (pick: (m: MilestoneDef) => string[]) => {
    const out = new Map<string, string[]>();
    for (const m of ms) for (const k of pick(m)) out.set(k, [...(out.get(k) ?? []), m.key]);
    return out;
  };
  const byTask = named((m) => m.tasks);
  const byStory = named((m) => m.stories);
  const byFeature = named((m) => m.features);
  const out: Membership = { of: new Map(), index, tasks: new Map(ms.map((m) => [m.key, []])), unplaced: [], ambiguous: [] };
  for (const t of plan.tasks.values()) {
    const feature = plan.taskset?.stories.get(t.story)?.feature;
    const found = ([['task', byTask.get(t.id)], ['story', byStory.get(t.story)], ['feature', feature ? byFeature.get(feature) : undefined]] as const).find(([, m]) => m?.length);
    if (!found) {
      out.unplaced.push(t.id);
      continue;
    }
    const [by, list] = found;
    if (list!.length > 1) out.ambiguous.push({ task: t.id, by, milestones: list! });
    out.of.set(t.id, list![0]!);
    out.tasks.get(list![0]!)!.push(t.id);
  }
  return out;
}

// Each task's place in the delivery order, for ranking: tasks in no milestone come after every milestone.
export function milestoneRank(plan: Plan, m = membership(plan)): Map<string, number> {
  const last = plan.milestones?.length ?? 0;
  return new Map([...plan.tasks.keys()].map((id) => [id, m.index.get(m.of.get(id) ?? '') ?? last]));
}

// Reached: every task in it is done. A milestone with no tasks is never reached.
export function isReached(plan: Plan, key: string, m = membership(plan)): boolean {
  const ids = m.tasks.get(key) ?? [];
  return ids.length > 0 && ids.every((id) => plan.tasks.get(id)?.status === 'done');
}

// The milestone a task's merge reached, if its merge was the last one it needed.
export function reachedBy(plan: Plan, task: string): MilestoneDef | undefined {
  const m = membership(plan);
  const key = m.of.get(task);
  return key !== undefined && isReached(plan, key, m) ? plan.milestones!.find((x) => x.key === key) : undefined;
}

// ---- the invariant: no task waits on a task in a later milestone ----

export interface ForwardDep {
  task: string;
  dep: string;
  at: string; // the task's milestone
  depAt: string; // the later one its dependency is in
  pull: string[]; // pulling the dependency forward takes these with it: it and what it waits on, transitively, later than `at`
}

export function forwardDeps(plan: Plan, m = membership(plan)): ForwardDep[] {
  const out: ForwardDep[] = [];
  const at = (id: string) => m.index.get(m.of.get(id) ?? '');
  for (const t of plan.tasks.values()) {
    const i = at(t.id);
    if (i === undefined) continue;
    for (const d of t.blocked_by) {
      const j = at(d);
      if (j === undefined || j <= i) continue;
      out.push({ task: t.id, dep: d, at: m.of.get(t.id)!, depAt: m.of.get(d)!, pull: pullForward(plan, d, i, at) });
    }
  }
  return out;
}

// A task and the tasks it waits on, directly or not, that sit after milestone `i`: what must move with it.
function pullForward(plan: Plan, id: string, i: number, at: (id: string) => number | undefined): string[] {
  const seen = new Set<string>();
  const stack = [id];
  while (stack.length) {
    const x = stack.pop()!;
    if (seen.has(x)) continue;
    seen.add(x);
    for (const d of plan.tasks.get(x)?.blocked_by ?? []) if (plan.tasks.has(d) && (at(d) ?? -1) > i) stack.push(d);
  }
  return [...seen].sort();
}

// ---- placeholders ----

// The wiring task of each placeholder task: the tasks whose `wires` name it.
export function wiringOf(plan: Plan): Map<string, Task[]> {
  const out = new Map<string, Task[]>();
  for (const w of plan.tasks.values()) for (const p of w.wires ?? []) out.set(p, [...(out.get(p) ?? []), w]);
  return out;
}
