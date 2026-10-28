import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import type { EpicDef, FeatureDef, LaneDef, Plan, StoryDef, Task, TaskSetDef, Timeline } from '../types.ts';

// The Helix TaskSet (plan/taskset.yaml): the scope, as Lane › Epic › Feature › Story › Task. A lane is one
// repository; an epic a large outcome; a feature a capability a user would recognise, built as a vertical slice; a
// story one need, small enough to demo on its own. Each task names its story, and its feature, epic and lane follow.
// The YAML's order is reading order only: the order work is delivered in is Helix Milestones (milestones.ts).

export interface TaskSetFile {
  version: 2;
  revision: number;
  milestones?: string;
  timelines?: Timeline[];
  lanes: Record<string, {
    repo: string;
    epics: Record<string, {
      title: string;
      outcome: string;
      features: Record<string, { title: string; capability?: string; stories: Record<string, { title: string; need: string }> }>;
    }>;
  }>;
}

// The finish dates the app shows (spec §20.1): `project` (human tasks take their lead times) always, and `code`
// (the last builder task's merge, as if every human task were done when it is needed) unless the TaskSet leaves it
// out, so a person's wait for an account or a D-U-N-S number doesn't count against the build.
export const TIMELINES: Timeline[] = ['code', 'project'];

export const MIGRATE_V1 =
  'is a version 1 TaskSet (Lane › Epic, with tasks naming `epic` and `stage`). Helix Loop now reads version 2: Lane › Epic › Feature › Story › Task, with each task naming its `story`, and the delivery order in Helix Milestones (milestones.yaml) instead of stages. Convert it as docs/migrating.md describes under "From a version 1 TaskSet"';

export interface TaskSetRead {
  file?: TaskSetFile; // the document, when it reads as version 2
  def?: TaskSetDef;
  problems: string[]; // why it doesn't read, or keys it declares twice
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const entries = (v: unknown): [string, Record<string, unknown>][] => (isObject(v) ? Object.entries(v).filter((e): e is [string, Record<string, unknown>] => isObject(e[1])) : []);
const text = (v: unknown, fallback: string) => (typeof v === 'string' ? v : fallback);

export const tasksetPath = (planDir: string) => join(planDir, 'taskset.yaml');

// Both timelines, unless the file asks for the project one alone.
export function timelinesOf(t: unknown): Timeline[] {
  return Array.isArray(t) && t.includes('project') && !t.includes('code') ? ['project'] : TIMELINES;
}

// A version 1 TaskSet: `version: 1`, or the stages and epic stages it alone had.
const isV1 = (raw: Record<string, unknown>) => raw.version === 1 || 'stages' in raw || entries(raw.lanes).some(([, l]) => entries(l.epics).some(([, e]) => 'stage' in e || !('features' in e)));

// Reads plan/taskset.yaml in planDir. Never throws: a broken file is a problem the validator reports, and the
// app and the loop still read the tasks. Parts the schema would refuse are read as far as they make sense.
export function readTaskSet(planDir: string): TaskSetRead {
  const file = tasksetPath(planDir);
  if (!existsSync(file)) return { problems: [] };
  let raw: unknown;
  try {
    raw = parse(readFileSync(file, 'utf8'));
  } catch (e) {
    return { problems: [`cannot be read: ${(e as Error).message.split('\n')[0]}`] };
  }
  if (!isObject(raw)) return { problems: ['is not a mapping of version, revision and lanes'] };
  if (isV1(raw)) return { problems: [MIGRATE_V1] };
  const problems: string[] = [];
  const epics = new Map<string, EpicDef>();
  const features = new Map<string, FeatureDef>();
  const stories = new Map<string, StoryDef>();
  const lanes: LaneDef[] = [];
  // Keys are unique at their level across the whole TaskSet, not only within their parent.
  const once = <T>(map: Map<string, T>, level: string, key: string, where: string, value: T): boolean => {
    if (map.has(key)) {
      problems.push(`${level} ${key} is declared twice (again in ${where}); keys are unique across the TaskSet`);
      return false;
    }
    map.set(key, value);
    return true;
  };
  for (const [laneKey, l] of entries(raw.lanes)) {
    if (lanes.some((x) => x.key === laneKey)) continue;
    const lane: LaneDef = { key: laneKey, repo: text(l.repo, laneKey), epics: [] };
    lanes.push(lane);
    for (const [epicKey, e] of entries(l.epics)) {
      const epic: EpicDef = { key: epicKey, title: text(e.title, epicKey), outcome: text(e.outcome, ''), lane: laneKey, features: [] };
      if (!once(epics, 'epic', epicKey, `lane ${laneKey}`, epic)) continue;
      lane.epics.push(epicKey);
      for (const [featureKey, f] of entries(e.features)) {
        const feature: FeatureDef = { key: featureKey, title: text(f.title, featureKey), ...(typeof f.capability === 'string' ? { capability: f.capability } : {}), epic: epicKey, lane: laneKey, stories: [] };
        if (!once(features, 'feature', featureKey, `epic ${epicKey}`, feature)) continue;
        epic.features.push(featureKey);
        for (const [storyKey, s] of entries(f.stories)) {
          if (once(stories, 'story', storyKey, `feature ${featureKey}`, { key: storyKey, title: text(s.title, storyKey), need: text(s.need, ''), feature: featureKey, epic: epicKey, lane: laneKey })) feature.stories.push(storyKey);
        }
      }
    }
  }
  const def: TaskSetDef = {
    revision: typeof raw.revision === 'number' ? raw.revision : 1,
    ...(typeof raw.milestones === 'string' ? { milestonesFile: raw.milestones } : {}),
    timelines: timelinesOf(raw.timelines),
    lanes,
    epics,
    features,
    stories,
  };
  return { file: raw as unknown as TaskSetFile, def, problems };
}

// ---- where a task sits ----

export interface Trail {
  lane?: LaneDef;
  epic?: EpicDef;
  feature?: FeatureDef;
  story?: StoryDef;
}

// A story's lane, epic and feature; empty when the TaskSet doesn't declare it.
export function trailOf(ts: TaskSetDef | undefined, story: string | undefined): Trail {
  const s = story ? ts?.stories.get(story) : undefined;
  if (!s || !ts) return {};
  return { lane: ts.lanes.find((l) => l.key === s.lane), epic: ts.epics.get(s.epic), feature: ts.features.get(s.feature), story: s };
}

// The tasks of each story, in plan order; a story no task names has none.
export function tasksByStory(plan: Plan): Map<string, Task[]> {
  const out = new Map<string, Task[]>();
  for (const t of plan.tasks.values()) out.set(t.story, [...(out.get(t.story) ?? []), t]);
  return out;
}

// Every task under a lane, epic, feature or story, in the TaskSet's reading order.
export function tasksUnder(plan: Plan, level: 'lane' | 'epic' | 'feature' | 'story', key: string): Task[] {
  const ts = plan.taskset;
  if (!ts) return [];
  const by = tasksByStory(plan);
  const ofFeature = (f: string) => (ts.features.get(f)?.stories ?? []).flatMap((s) => by.get(s) ?? []);
  const ofEpic = (e: string) => (ts.epics.get(e)?.features ?? []).flatMap(ofFeature);
  if (level === 'story') return by.get(key) ?? [];
  if (level === 'feature') return ofFeature(key);
  if (level === 'epic') return ofEpic(key);
  return (ts.lanes.find((l) => l.key === key)?.epics ?? []).flatMap(ofEpic);
}

// ---- importing a TaskSet (spec §13.3) ----

export interface ImportDiff {
  added: string[]; // tasks new to the plan
  removed: string[]; // tasks the import leaves out that haven't started
  kept: string[]; // tasks the import would change or leave out, kept as they are: merged, running or attempted
  depsChanged: string[]; // tasks whose dependencies changed
  storiesAdded: string[];
  human: { added: string[]; removed: string[] };
}

// What importing `incoming` over `current` would do: merged and running tasks stay as they are, whatever the
// import says, and only tasks no pass has touched may be removed. Returns the plan as it would be, with the
// incoming TaskSet, and its milestones only: a new TaskSet's order is planned afresh.
export function diffTaskSet(current: Plan, incoming: Plan): { diff: ImportDiff; plan: Plan } {
  const tasks = new Map<string, Task>();
  const diff: ImportDiff = { added: [], removed: [], kept: [], depsChanged: [], storiesAdded: [], human: { added: [], removed: [] } };
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
  for (const key of incoming.taskset?.stories.keys() ?? []) if (!current.taskset?.stories.has(key)) diff.storiesAdded.push(key);
  return { diff, plan: { tasks, human, ...(incoming.taskset ? { taskset: incoming.taskset } : {}), ...(incoming.milestones ? { milestones: incoming.milestones } : {}) } };
}
