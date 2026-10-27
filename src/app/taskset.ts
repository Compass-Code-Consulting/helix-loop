import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';
import { paths } from '../config.ts';
import { atomicWrite } from '../plan/store.ts';
import { stageIndex, stagesOf, stageTitle } from '../plan/stages.ts';
import type { Plan, RepoName, Stage, Task } from '../types.ts';

// The Helix TaskSet (spec §13.2): lanes (the repos the loop builds), their epics in order, and the tasks in each.
// plan/taskset.yaml names the epics; each task says which one it is in (`epic`, the epic's key in its lane, the
// lane being the task's repo). A plan from before epics existed has neither: its epics are derived, one per
// (repo, feature), the same split `helix-loop taskset init` writes down, so the Map folds the same way before
// and after the migration. Stages are milestones a task belongs to, not a level of the hierarchy.

export interface Epic {
  id: string; // `${lane}/${key}`, unique across lanes
  key: string;
  lane: RepoName;
  title: string;
  stage?: Stage;
  tasks: string[]; // in plan order
}

export interface Lane {
  name: RepoName;
  repo: string;
  epics: Epic[];
}

// The finish dates the app shows (spec §20.1): `project` (human tasks take their lead times) always, and `code`
// (the last builder task's merge, as if every human task were done when it is needed) unless the TaskSet leaves it
// out, so a person's wait for an account or a D-U-N-S number doesn't count against the build.
export type Timeline = 'code' | 'project';
export const TIMELINES: Timeline[] = ['code', 'project'];

export interface TaskSet {
  lanes: Lane[];
  timelines: Timeline[];
  epicOf: Map<string, Epic>; // task id → its epic
  derived: boolean; // no plan/taskset.yaml: the epics were derived from each task's feature
  missing: string[]; // tasks whose epic plan/taskset.yaml doesn't declare
}

export interface TaskSetFile {
  version: 1;
  stages?: (Stage | { key: Stage; title?: string })[]; // the milestones, in order (plan/stages.ts)
  timelines?: Timeline[];
  lanes: Record<string, { repo: string; epics: Record<string, { title: string; stage?: Stage }> }>;
}

export const tasksetFile = (root: string) => paths(root).taskset;

const slug = (s: string) => s.toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'general';

// The epic a task of a plan without epics belongs to.
export function derivedEpic(t: Task): { key: string; title: string } {
  const feature = t.feature ?? t.area.split('/')[0]!;
  return { key: slug(feature), title: feature };
}

export function readTaskSetFile(root: string): TaskSetFile | undefined {
  const f = tasksetFile(root);
  if (!existsSync(f)) return undefined;
  const raw = parse(readFileSync(f, 'utf8')) as TaskSetFile | null;
  return raw && typeof raw === 'object' && raw.lanes ? raw : undefined;
}

// Both timelines, unless the file asks for the project one alone.
export function timelinesOf(file: TaskSetFile | undefined): Timeline[] {
  const t = file?.timelines;
  return Array.isArray(t) && t.includes('project') && !t.includes('code') ? ['project'] : TIMELINES;
}

export function loadTaskSet(root: string, plan: Plan): TaskSet {
  const file = readTaskSetFile(root);
  const lanes = new Map<RepoName, Lane>();
  const epics = new Map<string, Epic>();
  const laneOf = (name: RepoName) => {
    let l = lanes.get(name);
    if (!l) lanes.set(name, (l = { name, repo: file?.lanes[name]?.repo ?? name, epics: [] }));
    return l;
  };
  const addEpic = (lane: RepoName, key: string, title: string, stage?: Stage) => {
    const id = `${lane}/${key}`;
    let e = epics.get(id);
    if (!e) {
      e = { id, key, lane, title, stage, tasks: [] };
      epics.set(id, e);
      laneOf(lane).epics.push(e);
    }
    return e;
  };
  // Declared lanes and epics first, in the file's order.
  for (const [name, l] of Object.entries(file?.lanes ?? {})) {
    for (const [key, e] of Object.entries(l.epics ?? {})) addEpic(name, key, e.title ?? key, e.stage);
  }
  const epicOf = new Map<string, Epic>();
  const missing: string[] = [];
  for (const t of plan.tasks.values()) {
    let e = t.epic ? epics.get(`${t.repo}/${t.epic}`) : undefined;
    if (!e) {
      if (file) missing.push(t.id);
      const d = derivedEpic(t);
      e = addEpic(t.repo, t.epic ?? d.key, t.epic ?? d.title);
    }
    e.tasks.push(t.id);
    epicOf.set(t.id, e);
  }
  // Lanes in the TaskSet's order, then the order the tasks first name them; derived epics by the earliest
  // stage they reach, then by size.
  const ordered = [...lanes.values()];
  if (!file) {
    const stages = stagesOf(plan);
    const first = (e: Epic) => Math.min(...e.tasks.map((id) => stageIndex(stages, plan.tasks.get(id)?.stage)));
    for (const l of ordered) l.epics.sort((a, b) => first(a) - first(b) || b.tasks.length - a.tasks.length || a.key.localeCompare(b.key));
  }
  return { lanes: ordered.filter((l) => l.epics.some((e) => e.tasks.length) || !!file), timelines: timelinesOf(file), epicOf, derived: !file, missing };
}

// `helix-loop taskset init`: writes plan/taskset.yaml with one epic per (repo, feature, stage) and sets each
// task's epic. Returns the tasks it changed, for the caller to write and commit. Tasks that already have an
// epic keep it.
export function initTaskSet(root: string, plan: Plan): { file: TaskSetFile; changed: Task[] } {
  const ts = loadTaskSet(root, plan);
  const out: TaskSetFile = { version: 1, timelines: TIMELINES, lanes: {} };
  const stages = stagesOf(plan);
  if (stages.length) out.stages = stages.map((key) => ({ key, title: stageTitle(plan, key) }));
  for (const l of ts.lanes) {
    out.lanes[l.name] = { repo: l.repo, epics: Object.fromEntries(l.epics.map((e) => [e.key, { title: e.title, ...(e.stage ? { stage: e.stage } : {}) }])) };
  }
  const changed: Task[] = [];
  for (const t of plan.tasks.values()) {
    if (t.epic) continue;
    changed.push({ ...t, epic: ts.epicOf.get(t.id)!.key });
  }
  return { file: out, changed };
}

export function writeTaskSetFile(root: string, file: TaskSetFile): void {
  atomicWrite(tasksetFile(root), `# The Helix TaskSet: lanes and their epics, in order (spec §13.2). Tasks name their epic with \`epic\`.\n${stringify(file, { lineWidth: 0 })}`);
}

// ---- importing a TaskSet (spec §13.3) ----

export interface ImportDiff {
  added: string[]; // tasks new to the plan
  removed: string[]; // tasks the import leaves out that haven't started
  kept: string[]; // tasks the import would change or leave out, kept as they are: merged, running or attempted
  depsChanged: string[]; // tasks whose dependencies changed
  epicsAdded: string[];
  human: { added: string[]; removed: string[] };
}

// What importing `incoming` over `current` would do: merged and running tasks stay as they are, whatever the
// import says, and only tasks no pass has touched may be removed. Returns the plan as it would be.
export function diffTaskSet(current: Plan, incoming: Plan, currentEpics: Set<string>, incomingFile?: TaskSetFile): { diff: ImportDiff; plan: Plan } {
  const tasks = new Map<string, Task>();
  const diff: ImportDiff = { added: [], removed: [], kept: [], depsChanged: [], epicsAdded: [], human: { added: [], removed: [] } };
  const touched = (t: Task) => t.status === 'done' || t.status === 'claimed' || t.attempts.length > 0;
  for (const [id, t] of current.tasks) {
    const n = incoming.tasks.get(id);
    if (touched(t)) {
      tasks.set(id, n ? { ...n, status: t.status, claimed_by: t.claimed_by, attempts: t.attempts, summary: t.summary, notes: t.notes } : t);
      if (!n || JSON.stringify({ ...n, attempts: [], status: '', claimed_by: null }) !== JSON.stringify({ ...t, attempts: [], status: '', claimed_by: null, summary: undefined, notes: undefined })) diff.kept.push(id);
      if (n && n.blocked_by.join() !== t.blocked_by.join()) diff.depsChanged.push(id);
    } else if (n) {
      tasks.set(id, { ...n, status: n.status === 'done' ? 'ready' : n.status, claimed_by: null, attempts: [] });
      if (n.blocked_by.join() !== t.blocked_by.join()) diff.depsChanged.push(id);
    } else diff.removed.push(id);
  }
  for (const [id, n] of incoming.tasks) {
    if (current.tasks.has(id)) continue;
    tasks.set(id, { ...n, status: 'ready', claimed_by: null, attempts: [] });
    diff.added.push(id);
  }
  const human = new Map(current.human);
  for (const [id, h] of incoming.human) {
    if (!current.human.has(id)) {
      human.set(id, h);
      diff.human.added.push(id);
    }
  }
  for (const [lane, l] of Object.entries(incomingFile?.lanes ?? {})) for (const key of Object.keys(l.epics ?? {})) if (!currentEpics.has(`${lane}/${key}`)) diff.epicsAdded.push(`${lane}/${key}`);
  return { diff, plan: { tasks, human } };
}
