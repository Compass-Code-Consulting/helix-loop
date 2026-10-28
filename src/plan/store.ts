import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parse, stringify } from 'yaml';
import type { HumanTask, Plan, Task } from '../types.ts';
import { milestonesPath, readMilestones } from './milestones.ts';
import { readTaskSet } from './taskset.ts';

// The plan is data: one YAML file per task. While it runs, the loop writes the tasks it holds, and a
// person may edit one it isn't running (loop.ts reloadPlan). Every loop write is atomic (temp file, then
// rename), so a crash never leaves half a file.

function readDir<T>(dir: string): Map<string, { value: T; file: string }> {
  const out = new Map<string, { value: T; file: string }>();
  if (!existsSync(dir)) return out;
  for (const f of readdirSync(dir).sort()) {
    if (!f.endsWith('.yaml')) continue;
    const file = join(dir, f);
    const value = parse(readFileSync(file, 'utf8')) as T & { id?: string };
    const id = value?.id;
    if (!id) throw new Error(`plan: ${file} has no id`);
    if (f !== `${id}.yaml`) throw new Error(`plan: ${file} holds ${id}; the file must be named ${id}.yaml`);
    out.set(id, { value, file });
  }
  return out;
}

export function loadPlan(tasksDir: string, humanDir: string): Plan {
  const tasks = new Map<string, Task>();
  for (const [id, { value }] of readDir<Task>(tasksDir)) tasks.set(id, normaliseTask(value));
  const human = new Map<string, HumanTask>();
  for (const [id, { value }] of readDir<HumanTask>(humanDir)) human.set(id, value);
  // The TaskSet and its milestones beside the tasks: what each task's story is part of, and the delivery order.
  const planDir = dirname(tasksDir);
  const taskset = readTaskSet(planDir).def;
  const file = milestonesPath(planDir, taskset);
  const milestones = file ? readMilestones(file).defs : undefined;
  return { tasks, human, ...(taskset ? { taskset } : {}), ...(milestones ? { milestones } : {}) };
}

// Fills the runtime fields a planner may leave out.
function normaliseTask(t: Task): Task {
  return {
    ...t,
    status: t.status ?? 'ready',
    claimed_by: t.claimed_by ?? null,
    attempts: t.attempts ?? [],
    blocked_by: t.blocked_by ?? [],
  };
}

// Raw documents, for schema validation before normalisation hides a missing field.
export function loadRaw(dir: string): { id: string; file: string; value: unknown }[] {
  return [...readDir<unknown>(dir)].map(([id, { value, file }]) => ({ id, file, value }));
}

const FIELD_ORDER: (keyof Task)[] = [
  'id', 'repo', 'story', 'area', 'title', 'priority', 'agent', 'role', 'reqs', 'spec', 'acceptance',
  'blocked_by', 'placeholder_for', 'wires', 'estimate_passes', 'status', 'summary', 'claimed_by', 'attempts', 'notes',
];

export function writeTask(tasksDir: string, task: Task): void {
  mkdirSync(tasksDir, { recursive: true });
  const ordered: Record<string, unknown> = {};
  for (const k of FIELD_ORDER) if (task[k] !== undefined) ordered[k] = task[k];
  atomicWrite(join(tasksDir, `${task.id}.yaml`), stringify(ordered, { lineWidth: 0 }));
}

export function atomicWrite(file: string, text: string): void {
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
}

export function nextTaskId(plan: Plan): string {
  let max = 0;
  for (const id of plan.tasks.keys()) max = Math.max(max, Number(id.slice(2)));
  return `T-${String(max + 1).padStart(4, '0')}`;
}
