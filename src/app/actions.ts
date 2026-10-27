import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { promisify } from 'node:util';
import { parseDocument } from 'yaml';
import { CONTROL_PLANE, paths } from '../config.ts';
import { readLive } from '../live.ts';
import { atomicWrite, loadPlan, nextTaskId, writeTask } from '../plan/store.ts';
import { validateDocument, validateGraph, type Problem } from '../plan/validate.ts';
import type { HumanTask, Plan, Task } from '../types.ts';

// Plan edits from the app: Daniel's direct actions and the steward's tools. Each edit is checked before it
// lands: the task must not be one the loop is running (the loop writes its own copy back when the pass ends),
// the document must pass its schema, and the whole plan, as changed, its graph checks. It is then written
// atomically, the plan documents are rendered by the CLI's own `render`, and both are committed with a
// message that says who changed what. The loop takes the change on its next round (loop.ts reloadPlan).

const exec = promisify(execFile);

export class PlanEditError extends Error {
  problems: Problem[];
  constructor(message: string, problems: Problem[] = []) {
    super(problems.length ? `${message}: ${problems.slice(0, 5).map((p) => `${p.id}: ${p.message}`).join('; ')}` : message);
    this.problems = problems;
  }
}

// What each kind of editor may change. The loop's own fields (attempts, claims, summaries) are never edited here.
export const STEWARD_TASK_FIELDS = ['title', 'acceptance', 'blocked_by', 'estimate_passes', 'priority', 'agent', 'notes', 'status'] as const;
export const STEWARD_HUMAN_FIELDS = ['status', 'blocked_by', 'lead_time_days', 'notes'] as const;
const SETTABLE_STATUS: readonly Task['status'][] = ['ready', 'parked'];

// Tasks the loop holds: claimed in the plan, or in a pass according to runs/live.json.
export function runningTasks(root: string, plan: Plan): Set<string> {
  const out = new Set([...plan.tasks.values()].filter((t) => t.status === 'claimed' || t.claimed_by).map((t) => t.id));
  for (const p of readLive(paths(root).live)?.passes ?? []) out.add(p.task);
  return out;
}

export interface EditResult<T> {
  value: T;
  committed: boolean;
  commit?: string; // the commit's SHA, for undo (changes.ts)
}

export async function updateTask(root: string, id: string, patch: Partial<Task>, opts: { fields: readonly string[]; message: string }): Promise<EditResult<Task>> {
  const p = paths(root);
  const plan = loadPlan(p.tasks, p.human);
  const task = plan.tasks.get(id);
  if (!task) throw new PlanEditError(`no task ${id}`);
  if (runningTasks(root, plan).has(id)) throw new PlanEditError(`${id} is in a pass; it can change when the pass ends`);
  const bad = Object.keys(patch).filter((k) => !opts.fields.includes(k));
  if (bad.length) throw new PlanEditError(`these fields can't be changed here: ${bad.join(', ')}`);
  if (patch.status !== undefined && !SETTABLE_STATUS.includes(patch.status)) throw new PlanEditError(`a task can be set only to ${SETTABLE_STATUS.join(' or ')}`);
  if (patch.status === 'parked' && task.status === 'done') throw new PlanEditError(`${id} is done`);
  if (patch.status === 'ready' && task.status === 'done') throw new PlanEditError(`${id} is done; a change to done work is a new fix_first task`);
  const next: Task = { ...task, ...patch };
  for (const k of Object.keys(patch) as (keyof Task)[]) if (patch[k] === null || patch[k] === '') delete next[k];
  check(plan, p.schema, 'task', next);
  writeTask(p.tasks, next);
  return { value: next, ...(await afterEdit(root, [join(p.tasks, `${id}.yaml`)], opts.message)) };
}

export async function updateHuman(root: string, id: string, patch: Partial<HumanTask>, opts: { fields: readonly string[]; message: string }): Promise<EditResult<HumanTask>> {
  const p = paths(root);
  const plan = loadPlan(p.tasks, p.human);
  const h = plan.human.get(id);
  if (!h) throw new PlanEditError(`no human task ${id}`);
  const bad = Object.keys(patch).filter((k) => !opts.fields.includes(k));
  if (bad.length) throw new PlanEditError(`these fields can't be changed here: ${bad.join(', ')}`);
  const next: HumanTask = { ...h, ...patch };
  check(plan, p.schema, 'human', next);
  // Human tasks are written by planners with block scalars (the handoff prompts): edit the document in place,
  // so only the changed fields move.
  const file = join(p.human, `${id}.yaml`);
  const doc = parseDocument(readFileSync(file, 'utf8'));
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined || v === null || v === '') doc.delete(k);
    else doc.set(k, v);
  }
  atomicWrite(file, doc.toString({ lineWidth: 0 }));
  return { value: next, ...(await afterEdit(root, [file], opts.message)) };
}

export async function createTask(root: string, input: Partial<Task>, message: string): Promise<EditResult<Task>> {
  const p = paths(root);
  const plan = loadPlan(p.tasks, p.human);
  const id = nextTaskId(plan);
  const task: Task = {
    estimate_passes: 1,
    reqs: [],
    spec: [],
    blocked_by: [],
    ...input,
    id,
    status: 'ready',
    claimed_by: null,
    attempts: [],
  } as Task;
  check(plan, p.schema, 'task', task);
  writeTask(p.tasks, task);
  return { value: task, ...(await afterEdit(root, [join(p.tasks, `${id}.yaml`)], message.replace('{id}', id))) };
}

// Several edits as one change: every one is checked against the plan as all of them leave it, then all are
// written and committed together, so a batch on Home or a fix lands, or is undone, as one commit. New tasks
// may be referred to by `ref` ("new:1") in the dependencies of the others; they get the next free ids.
export interface Batch {
  tasks?: { id: string; patch: Partial<Task> }[];
  human?: { id: string; patch: Partial<HumanTask> }[];
  create?: { ref?: string; task: Partial<Task> }[];
}

export async function applyBatch(root: string, batch: Batch, opts: { fields: readonly string[]; humanFields?: readonly string[]; message: string }): Promise<EditResult<{ tasks: string[]; created: string[] }>> {
  const p = paths(root);
  const plan = loadPlan(p.tasks, p.human);
  const running = runningTasks(root, plan);
  const candidate: Plan = { tasks: new Map(plan.tasks), human: new Map(plan.human) };
  const refs = new Map<string, string>();
  const created: Task[] = [];
  for (const c of batch.create ?? []) {
    const id = nextTaskId(candidate);
    if (c.ref) refs.set(c.ref, id);
    const task = { estimate_passes: 1, reqs: [], spec: [], blocked_by: [], ...c.task, id, status: 'ready', claimed_by: null, attempts: [] } as Task;
    candidate.tasks.set(id, task);
    created.push(task);
  }
  const resolve = (ids: string[] | undefined) => ids?.map((d) => refs.get(d) ?? d);
  for (const t of created) t.blocked_by = resolve(t.blocked_by)!;
  const changed: Task[] = [];
  for (const { id, patch } of batch.tasks ?? []) {
    const task = candidate.tasks.get(id);
    if (!task) throw new PlanEditError(`no task ${id}`);
    if (running.has(id)) throw new PlanEditError(`${id} is in a pass; it can change when the pass ends`);
    const bad = Object.keys(patch).filter((k) => !opts.fields.includes(k));
    if (bad.length) throw new PlanEditError(`these fields can't be changed here: ${bad.join(', ')}`);
    if (patch.status !== undefined && !SETTABLE_STATUS.includes(patch.status)) throw new PlanEditError(`a task can be set only to ${SETTABLE_STATUS.join(' or ')}`);
    if (patch.status !== undefined && task.status === 'done') throw new PlanEditError(`${id} is done`);
    const next: Task = { ...task, ...patch, ...(patch.blocked_by ? { blocked_by: resolve(patch.blocked_by)! } : {}) };
    for (const k of Object.keys(patch) as (keyof Task)[]) if (patch[k] === null || patch[k] === '') delete next[k];
    candidate.tasks.set(id, next);
    changed.push(next);
  }
  const humanChanged: HumanTask[] = [];
  for (const { id, patch } of batch.human ?? []) {
    const h = candidate.human.get(id);
    if (!h) throw new PlanEditError(`no human task ${id}`);
    const bad = Object.keys(patch).filter((k) => !(opts.humanFields ?? []).includes(k));
    if (bad.length) throw new PlanEditError(`these fields can't be changed here: ${bad.join(', ')}`);
    const next = { ...h, ...patch };
    candidate.human.set(id, next);
    humanChanged.push(next);
  }
  // Each document against its schema, then the whole plan against the graph checks.
  for (const t of [...created, ...changed]) {
    const doc = Object.fromEntries(Object.entries(t).filter(([, v]) => v !== undefined));
    const problems = validateDocument(p.schema, 'task', t.id, doc);
    if (problems.length) throw new PlanEditError(`${t.id} would not pass its schema`, problems);
  }
  for (const h of humanChanged) {
    const problems = validateDocument(p.schema, 'human', h.id, Object.fromEntries(Object.entries(h).filter(([, v]) => v !== undefined)));
    if (problems.length) throw new PlanEditError(`${h.id} would not pass its schema`, problems);
  }
  const before = new Set(validateGraph(plan).map((x) => `${x.id}: ${x.message}`));
  const graph = validateGraph(candidate).filter((x) => !before.has(`${x.id}: ${x.message}`));
  if (graph.length) throw new PlanEditError('the plan would not validate', graph);

  const files: string[] = [];
  for (const t of [...created, ...changed]) {
    writeTask(p.tasks, t);
    files.push(join(p.tasks, `${t.id}.yaml`));
  }
  for (const h of humanChanged) {
    const file = join(p.human, `${h.id}.yaml`);
    const doc = parseDocument(readFileSync(file, 'utf8'));
    const patch = batch.human!.find((x) => x.id === h.id)!.patch;
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined || v === null || v === '') doc.delete(k);
      else doc.set(k, v);
    }
    atomicWrite(file, doc.toString({ lineWidth: 0 }));
    files.push(file);
  }
  const ids = [...created, ...changed].map((t) => t.id);
  return { value: { tasks: [...ids, ...humanChanged.map((h) => h.id)], created: created.map((t) => t.id) }, ...(await afterEdit(root, files, opts.message.replace('{ids}', ids.join(', ')))) };
}

function check(plan: Plan, schemaDir: string, kind: 'task' | 'human', value: Task | HumanTask): void {
  const doc = Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined));
  const schema = validateDocument(schemaDir, kind, value.id, doc);
  if (schema.length) throw new PlanEditError(`${value.id} would not pass its schema`, schema);
  const candidate: Plan = { tasks: new Map(plan.tasks), human: new Map(plan.human) };
  if (kind === 'task') candidate.tasks.set(value.id, value as Task);
  else candidate.human.set(value.id, value as HumanTask);
  const before = new Set(validateGraph(plan).map((x) => `${x.id}: ${x.message}`));
  const graph = validateGraph(candidate).filter((x) => !before.has(`${x.id}: ${x.message}`));
  if (graph.length) throw new PlanEditError(`the plan would not validate`, graph);
}

// Renders the plan documents with the CLI, then commits the edited files and the documents together. A root
// that is not a git checkout (the dry run) is only rendered. Says whether a commit was made, and which.
export async function afterEdit(root: string, files: string[], message: string): Promise<{ committed: boolean; commit?: string }> {
  const docs = ['ImplementationPlan', 'HumanImplementationPlan'].map((d) => join(root, 'plan', `Mushy.LoopEngineering.${d}.md`));
  await exec(process.execPath, [join(CONTROL_PLANE, 'harness', 'bin', 'helix-loop.ts'), 'render', '--root', root], { timeout: 120_000 }).catch(() => undefined);
  if (!existsSync(join(root, '.git'))) return { committed: false };
  const rel = [...files, ...docs.filter(existsSync)].map((f) => relative(root, f));
  if (!(await commit(root, rel, message))) return { committed: false };
  // The loop may commit in the same moment: the commit is the latest one with this message.
  const sha = (await exec('git', ['log', '-5', '--format=%H%x09%s'], { cwd: root })).stdout.split('\n').find((l) => l.split('\t')[1] === message.split('\n')[0])?.split('\t')[0];
  return { committed: true, commit: sha };
}

// The loop commits plan/tasks and plan/human in this same checkout after each merge. Two commits at once
// collide on git's index lock; the loop's next commit catches up if its own fails, and this one retries.
export async function commit(root: string, files: string[], message: string): Promise<boolean> {
  const id = ['-c', 'user.name=Helix Loop', '-c', 'user.email=loop@mushymarketing.com'];
  for (let i = 0; i < 6; i++) {
    try {
      await exec('git', ['add', '--', ...files], { cwd: root });
      const staged = await exec('git', ['diff', '--cached', '--quiet', '--', ...files], { cwd: root }).then(() => false, () => true);
      if (!staged) return false;
      await exec('git', [...id, 'commit', '-q', '-m', message, '--', ...files], { cwd: root });
      return true;
    } catch (e) {
      if (!/index\.lock/.test(String((e as { stderr?: string }).stderr ?? e))) throw e;
      await new Promise((r) => setTimeout(r, 250 * (i + 1)));
    }
  }
  return false;
}
