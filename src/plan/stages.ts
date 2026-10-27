import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import type { Plan, Stage, Task } from '../types.ts';

// A plan's stages: milestones in order, declared by the TaskSet (plan/taskset.yaml `stages`), each a key or a
// key with a title. Work in a later stage waits until every earlier stage is settled (sched/scheduler.ts
// openStage). Stages are optional: a plan that declares none and whose tasks name none has no stage gating.

export interface StageDef {
  key: Stage;
  title: string;
}

// "day0" reads "Day 0", "beta-ready" reads "Beta ready".
export const stageLabel = (key: Stage): string => {
  const s = key.replace(/[-_]+/g, ' ').replace(/([a-z])(\d)/gi, '$1 $2');
  return s.charAt(0).toUpperCase() + s.slice(1);
};

// The stages the TaskSet in planDir declares, or undefined when it declares none.
export function readStages(planDir: string): StageDef[] | undefined {
  const file = join(planDir, 'taskset.yaml');
  if (!existsSync(file)) return undefined;
  let raw: { stages?: unknown } | null;
  try {
    raw = parse(readFileSync(file, 'utf8')) as { stages?: unknown } | null;
  } catch {
    return undefined; // a TaskSet being rewritten; validation reports a broken one
  }
  if (!Array.isArray(raw?.stages)) return undefined;
  return raw.stages.flatMap((s): StageDef[] => {
    if (typeof s === 'string') return [{ key: s, title: stageLabel(s) }];
    if (s && typeof s === 'object' && typeof (s as StageDef).key === 'string') return [{ key: (s as StageDef).key, title: String((s as StageDef).title ?? stageLabel((s as StageDef).key)) }];
    return [];
  });
}

// The stages tasks name, in natural order ("day2" before "day10"), for a plan whose TaskSet declares none.
export const namedStages = (tasks: Iterable<Task>): Stage[] =>
  [...new Set([...tasks].map((t) => t.stage).filter((s): s is Stage => !!s))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

export const stagesOf = (plan: Plan): Stage[] => plan.stages ?? namedStages(plan.tasks.values());

// A task's place among the stages; work that names no stage, or one the plan doesn't declare, is never held
// back (validation reports an unknown one).
export const stageIndex = (stages: Stage[], stage: Stage | undefined): number => (stage ? Math.max(0, stages.indexOf(stage)) : 0);

export const stageTitle = (plan: Plan, key: Stage): string => plan.stageTitles?.[key] ?? stageLabel(key);
