import { mkdirSync, writeFileSync } from 'node:fs';
import { stringify } from 'yaml';
import { paths } from '../src/config.ts';
import type { MilestonesFile } from '../src/plan/milestones.ts';
import { loadRaw } from '../src/plan/store.ts';
import type { TaskSetFile } from '../src/plan/taskset.ts';
import type { HumanTask, MilestoneDef, Plan, Task, TaskSetDef } from '../src/types.ts';

// The TaskSet and milestones the tests wrap their ad hoc tasks in: one lane per repo the tasks build (acme-app when
// there are none), each with one epic, feature and story (`storyOf(repo)`), and the milestones in the order
// `milestoneOf` first names them, after `first`, which holds every feature. A task `milestoneOf` names is in that
// milestone by its id; the rest are in `first`.

export const storyOf = (repo: string) => `${repo}-story`;

type Repos = Iterable<{ repo: string }>;
const reposOf = (tasks: Repos) => {
  const repos = [...new Set([...tasks].map((t) => t.repo))];
  return repos.length ? repos : ['acme-app'];
};

export function tasksetFile(tasks: Repos = [], revision = 2): TaskSetFile {
  const REPOS = reposOf(tasks);
  return {
    version: 2,
    revision,
    milestones: 'milestones.yaml',
    timelines: ['code', 'project'],
    lanes: Object.fromEntries(REPOS.map((repo) => [repo, {
      repo,
      epics: { [`${repo}-epic`]: { title: `${repo} outcome`, outcome: `Everything ${repo} builds works.`, features: { [`${repo}-feature`]: { title: `${repo} feature`, stories: { [storyOf(repo)]: { title: `${repo} story`, need: `As a tester, I want ${repo} built, so that the tests pass.` } } } } } },
    }])),
  };
}

export function milestonesFile(tasks: Repos = [], milestoneOf: Record<string, string> = {}): MilestonesFile {
  const REPOS = reposOf(tasks);
  const later = [...new Set(Object.values(milestoneOf))].filter((k) => k !== 'first');
  return {
    version: 1,
    taskset_revision: 1,
    milestones: [
      { key: 'first', title: 'The first milestone', demo: 'Everything the tests start with works.', features: REPOS.map((r) => `${r}-feature`) },
      ...later.map((key) => ({ key, title: `Milestone ${key}`, demo: `What ${key} adds works.`, tasks: Object.keys(milestoneOf).filter((id) => milestoneOf[id] === key).sort() })),
    ],
  };
}

// The same, parsed, for a plan built in memory.
export function structure(tasks: Repos = [], milestoneOf: Record<string, string> = {}): { taskset: TaskSetDef; milestones: MilestoneDef[] } {
  const REPOS = reposOf(tasks);
  const taskset: TaskSetDef = { revision: 2, milestonesFile: 'milestones.yaml', timelines: ['code', 'project'], lanes: [], epics: new Map(), features: new Map(), stories: new Map() };
  for (const repo of REPOS) {
    taskset.lanes.push({ key: repo, repo, epics: [`${repo}-epic`] });
    taskset.epics.set(`${repo}-epic`, { key: `${repo}-epic`, title: `${repo} outcome`, outcome: '', lane: repo, features: [`${repo}-feature`] });
    taskset.features.set(`${repo}-feature`, { key: `${repo}-feature`, title: `${repo} feature`, epic: `${repo}-epic`, lane: repo, stories: [storyOf(repo)] });
    taskset.stories.set(storyOf(repo), { key: storyOf(repo), title: `${repo} story`, need: '', feature: `${repo}-feature`, epic: `${repo}-epic`, lane: repo });
  }
  const milestones = milestonesFile(tasks, milestoneOf).milestones.map((m) => ({ key: m.key, title: m.title, demo: m.demo, features: m.features ?? [], stories: m.stories ?? [], tasks: m.tasks ?? [] }));
  return { taskset, milestones };
}

export function planOf(tasks: Task[], humans: HumanTask[] = [], milestoneOf: Record<string, string> = {}): Plan {
  return { tasks: new Map(tasks.map((t) => [t.id, t])), human: new Map(humans.map((h) => [h.id, h])), ...structure(tasks, milestoneOf) };
}

// Writes taskset.yaml and milestones.yaml into a project's .helix/plan/, for the tasks there.
export function writeStructure(root: string, milestoneOf: Record<string, string> = {}): void {
  const p = paths(root);
  const tasks = loadRaw(p.tasks).map((t) => t.value as Task);
  mkdirSync(p.plan, { recursive: true });
  writeFileSync(p.taskset, stringify(tasksetFile(tasks)));
  writeFileSync(p.milestones, stringify(milestonesFile(tasks, milestoneOf)));
}
