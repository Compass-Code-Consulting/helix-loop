import { execFile, execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, relative } from 'node:path';
import { promisify } from 'node:util';
import { Ajv } from 'ajv';
import { parse, stringify } from 'yaml';
import { afterEdit } from '../app/actions.ts';
import { buildBoard } from '../app/board.ts';
import { boardInput } from '../app/views.ts';
import { loadConfig, paths } from '../config.ts';
import { prepareDryRun } from '../dryrun.ts';
import { readLedger } from '../ledger.ts';
import { forwardDeps, membership, milestonesPath, readMilestones, type ForwardDep, type MilestonesFile } from '../plan/milestones.ts';
import { historyDir, readHistory, reviseMilestonesText, reviseTaskSetText, snapshot, writeHistory, type Revision } from '../plan/revisions.ts';
import { atomicWrite, loadPlan, loadRaw, writeTask } from '../plan/store.ts';
import { diffTaskSet, readTaskSet, tasksetPath, type ImportDiff, type TaskSetFile } from '../plan/taskset.ts';
import { errorsOnly, validateDocument, validateGraph, validateHierarchy, validateMilestones, validateRepos, validateSchemas, type Problem } from '../plan/validate.ts';
import type { HumanTask, Plan, Task } from '../types.ts';
import { OpError, signed, type Actor } from './actor.ts';

// The TaskSet and its milestones as a person works with them: importing a TaskSet from the Helix skill, listing the
// milestones with their progress and dates, checking a Milestones proposal (each dependency that points forward,
// with the two ways to resolve it), applying one, and the revisions. Importing and applying both write the TaskSet's
// next revision, keeping the one they replace in plan/history/ (plan/revisions.ts), as one commit.

const exec = promisify(execFile);
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

// ---- the milestones, with their progress ----

export interface MilestoneRow {
  key: string;
  title: string;
  demo: string;
  tasks: number;
  done: number;
  reached: boolean;
  at?: number; // reached at, or projected
}

export function listMilestones(root: string, now = Date.now()): { revision?: number; milestones: MilestoneRow[]; finish: number; codeFinish?: number } {
  const p = paths(root);
  const plan = loadPlan(p.tasks, p.human);
  const board = buildBoard(boardInput(root, plan, readLedger(p.ledger), loadConfig(root), now));
  return {
    ...(board.revision ? { revision: board.revision } : {}),
    milestones: board.milestones.map((m) => ({ key: m.key, title: m.title, demo: m.demo, tasks: m.tasks.length, done: m.done, reached: m.reached, ...(m.at ? { at: m.at } : {}) })),
    finish: board.finish,
    ...(board.codeFinish !== undefined ? { codeFinish: board.codeFinish } : {}),
  };
}

// ---- writing a revision ----

interface RevisionWrite {
  taskset: string; // the next revision's taskset.yaml, as its planner wrote it; its revision number is set here
  milestones?: string; // milestones.yaml, as the skill wrote it; without it, the revision names none
  tasks: Task[]; // added or changed
  removed?: string[];
  human: HumanTask[]; // added or changed
  why: string;
  actor: Actor;
  counts: { placeholders: number; wiring: number };
}

// Keeps the current revision in plan/history/r<N>/ (when there is one), writes revision N+1 in place, records it in
// history/index.yaml, renders the plan documents and commits it all as one. Returns the new revision and where the
// old one went.
async function writeRevision(root: string, w: RevisionWrite): Promise<{ revision: number; snapshot?: string; committed: boolean }> {
  const p = paths(root);
  const current = loadPlan(p.tasks, p.human);
  const had = existsSync(tasksetPath(p.plan));
  // A version 1 TaskSet counts as revision 1.
  const was = had ? (current.taskset?.revision ?? 1) : undefined;
  const next = was === undefined ? ((parse(w.taskset) as { revision?: number } | null)?.revision ?? 1) : was + 1;
  const history = readHistory(p.plan);
  const files: string[] = [tasksetPath(p.plan), historyDir(p.plan)];
  let kept: string | undefined;
  if (was !== undefined) {
    const msFile = milestonesPath(p.plan, current.taskset);
    snapshot(p.plan, was, msFile && existsSync(msFile) ? basename(msFile) : undefined);
    kept = `history/r${was}/`;
    const entry = history.find((r) => r.revision === was);
    if (entry) entry.snapshot = kept;
    else history.push({ revision: was, date: firstWritten(root, tasksetPath(p.plan)), by: w.actor.by, why: was === 1 ? 'The TaskSet as first planned' : 'Before the history began', tasks: current.tasks.size, snapshot: kept });
  }
  for (const id of w.removed ?? []) {
    rmSync(join(p.tasks, `${id}.yaml`), { force: true });
    files.push(join(p.tasks, `${id}.yaml`));
  }
  for (const t of w.tasks) {
    writeTask(p.tasks, t);
    files.push(join(p.tasks, `${t.id}.yaml`));
  }
  for (const h of w.human) {
    atomicWrite(join(p.human, `${h.id}.yaml`), stringify(h, { lineWidth: 0 }));
    files.push(join(p.human, `${h.id}.yaml`));
  }
  const live = join(p.plan, 'milestones.yaml');
  atomicWrite(tasksetPath(p.plan), reviseTaskSetText(w.taskset, next, w.milestones ? 'milestones.yaml' : undefined));
  if (w.milestones) atomicWrite(live, reviseMilestonesText(w.milestones, was ?? next));
  else rmSync(live, { force: true }); // a new TaskSet's order is planned afresh; the old one is in the snapshot
  if (w.milestones || existsSync(join(root, '.git'))) files.push(live);
  const tasks = loadPlan(p.tasks, p.human).tasks.size;
  history.push({ revision: next, date: new Date().toISOString(), by: w.actor.by, why: w.why, tasks, ...(w.counts.placeholders ? { placeholders: w.counts.placeholders } : {}), ...(w.counts.wiring ? { wiring: w.counts.wiring } : {}) });
  writeHistory(p.plan, history.sort((a, b) => a.revision - b.revision));
  const tracked = await trackedOrPresent(root, files);
  const r = await afterEdit(root, tracked, `Plan: TaskSet revision ${next}: ${w.why.charAt(0).toLowerCase()}${w.why.slice(1)} (${signed(w.actor)})`);
  return { revision: next, ...(kept ? { snapshot: kept } : {}), committed: r.committed };
}

// Git refuses a pathspec that matches nothing: a removed file only counts when git knows it.
async function trackedOrPresent(root: string, files: string[]): Promise<string[]> {
  if (!existsSync(join(root, '.git'))) return files;
  const known = new Set((await exec('git', ['ls-files', '--', ...files.map((f) => relative(root, f))], { cwd: root })).stdout.split('\n').filter(Boolean).map((f) => join(root, f)));
  return files.filter((f) => existsSync(f) || known.has(f));
}

// When a file was first committed, or its modification time outside git.
function firstWritten(root: string, file: string): string {
  try {
    const out = execFileSync('git', ['log', '--diff-filter=A', '--format=%aI', '--', relative(root, file)], { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim().split('\n').at(-1);
    if (out) return new Date(out).toISOString();
  } catch {
    // not a git checkout
  }
  return statSync(file).mtime.toISOString();
}

export const tasksetHistory = (root: string): Revision[] => readHistory(paths(root).plan);

// ---- importing a TaskSet (spec §13.3) ----

export interface ImportResult {
  diff: ImportDiff;
  problems: Problem[]; // in the TaskSet itself
  after: Problem[]; // in the plan as the import would leave it
  revision?: number; // written: the revision it became
  dryRun?: string; // written into a fresh dry run there instead
  committed?: boolean;
}

// Takes a TaskSet folder (taskset.yaml, tasks/, human/, maybe milestones.yaml; or a plan/ folder holding them) or a
// zip of one, checks it, and compares it with the running plan. `apply` writes it as the next revision; `dry`
// writes it into a fresh dry run instead.
export async function importTaskSet(root: string, from: string, mode: { apply?: boolean; dry?: boolean; actor: Actor }): Promise<ImportResult> {
  const p = paths(root);
  if (!existsSync(from)) throw new OpError(404, `No TaskSet at ${from}.`);
  let dir = from;
  if (from.endsWith('.zip')) {
    dir = mkdtempSync(join(tmpdir(), 'helix-taskset-'));
    execFileSync('unzip', ['-q', from, '-d', dir]);
  }
  // The folder may hold plan/ or be it; a skill's zip holds one more level.
  const base = [join(dir, 'plan'), dir, join(dir, 'helix', 'plan')].find((d) => existsSync(join(d, 'tasks')));
  if (!base) throw new OpError(400, `${from} has no tasks/ folder.`);
  const config = loadConfig(root);
  const incoming = loadPlan(join(base, 'tasks'), join(base, 'human'));
  const checks = (plan: Plan) => [...validateGraph(plan), ...errorsOnly(validateHierarchy(plan, config.repos)), ...(plan.milestones ? errorsOnly(validateMilestones(plan)) : [])];
  const problems = [...validateSchemas(p.schema, join(base, 'tasks'), join(base, 'human')), ...checks(incoming)];
  const current = loadPlan(p.tasks, p.human);
  const { diff, plan } = diffTaskSet(current, incoming);
  const after = problems.length ? [] : checks(plan);
  if (problems.length || after.length || (!mode.apply && !mode.dry)) return { diff, problems, after };
  const tasksetText = readFileSync(tasksetPath(base), 'utf8');
  const msFile = incoming.taskset?.milestonesFile ? join(base, incoming.taskset.milestonesFile) : undefined;
  const ms = msFile ? readMilestones(msFile).file : undefined;
  const msText = msFile ? readFileSync(msFile, 'utf8') : undefined;
  if (mode.dry) {
    const target = prepareDryRun(root).root;
    const tp = paths(target);
    for (const id of diff.removed) rmSync(join(tp.tasks, `${id}.yaml`), { force: true });
    for (const t of plan.tasks.values()) writeTask(tp.tasks, t);
    for (const id of diff.human.added) cpSync(join(base, 'human', `${id}.yaml`), join(tp.human, `${id}.yaml`));
    const revision = incoming.taskset?.revision ?? 1;
    atomicWrite(tp.taskset, reviseTaskSetText(tasksetText, revision, msText ? 'milestones.yaml' : undefined));
    if (msText) atomicWrite(tp.milestones, msText);
    else rmSync(tp.milestones, { force: true });
    return { diff, problems, after, dryRun: target };
  }
  const placeholders = [...plan.tasks.values()].filter((t) => t.placeholder_for?.length).length;
  const wiring = [...plan.tasks.values()].filter((t) => t.wires?.length).length;
  const r = await writeRevision(root, {
    taskset: tasksetText,
    ...(msText ? { milestones: msText } : {}),
    tasks: [...plan.tasks.values()],
    removed: diff.removed,
    human: diff.human.added.map((id) => incoming.human.get(id)!),
    why: `TaskSet imported: ${plural(diff.added.length, 'task')} added, ${diff.removed.length} removed${ms ? `, with ${plural(ms.milestones.length, 'milestone')}` : ''}`,
    actor: mode.actor,
    counts: { placeholders, wiring },
  });
  return { diff, problems, after, revision: r.revision, committed: r.committed };
}

// ---- a Milestones proposal: a folder over the plan ----

// The fields a builder pass and the loop own; a proposal never changes them.
const RUNTIME: (keyof Task)[] = ['status', 'claimed_by', 'attempts', 'summary', 'notes'];
const definition = (t: Task) => JSON.stringify(Object.fromEntries(Object.entries(t).filter(([k, v]) => !RUNTIME.includes(k as keyof Task) && v !== undefined).sort(([a], [b]) => a.localeCompare(b))));

export interface Proposal {
  base: string; // the folder that holds milestones.yaml
  plan: Plan; // the project's plan with the proposal applied
  file: MilestonesFile;
  taskset?: TaskSetFile; // a TaskSet the proposal brings, when it moves stories
  added: Task[];
  changed: Task[];
  human: HumanTask[];
  problems: Problem[]; // in the proposal's files; the plan's own checks run on `plan`
}

// The folder holds milestones.yaml, and may hold taskset.yaml, tasks/ and human/ with the tasks the Milestones step
// added (wiring tasks) or changed (placeholder tasks); a plan/ or helix/plan/ folder inside it works too.
export function readProposal(root: string, folder: string): Proposal {
  const base = [join(folder, 'plan'), folder, join(folder, 'helix', 'plan')].find((d) => existsSync(join(d, 'milestones.yaml')));
  if (!base) throw new OpError(400, `${folder} has no milestones.yaml`);
  const p = paths(root);
  const current = loadPlan(p.tasks, p.human);
  const problems: Problem[] = [];
  const ajv = new Ajv({ allErrors: true });
  const schema = (name: string, id: string, value: unknown) => {
    const check = ajv.compile(JSON.parse(readFileSync(join(p.schema, name), 'utf8')));
    if (!check(value)) for (const e of check.errors ?? []) problems.push({ id, message: `schema: ${e.instancePath || '/'} ${e.message}` });
  };
  const ts = existsSync(tasksetPath(base)) ? readTaskSet(base) : undefined;
  for (const m of ts?.problems ?? []) problems.push({ id: 'taskset.yaml', message: m });
  if (ts?.file) schema('taskset.schema.json', 'taskset.yaml', ts.file);
  const ms = readMilestones(join(base, 'milestones.yaml'));
  if (!ms.file) throw new OpError(400, `${join(base, 'milestones.yaml')} can't be read: ${ms.problems.join('; ')}`);
  schema('milestones.schema.json', 'milestones.yaml', ms.file);
  const revision = current.taskset?.revision;
  if (revision !== undefined && ms.file.taskset_revision !== revision) problems.push({ id: 'milestones.yaml', message: `planned against TaskSet revision ${ms.file.taskset_revision}, but the TaskSet is at revision ${revision}: plan it again against the TaskSet as it is now` });

  const tasks = new Map(current.tasks);
  const added: Task[] = [];
  const changed: Task[] = [];
  for (const { id, value } of existsSync(join(base, 'tasks')) ? loadRaw(join(base, 'tasks')) : []) {
    const doc = value as Task;
    const was = current.tasks.get(id);
    const next: Task = was
      ? { ...doc, status: was.status, claimed_by: was.claimed_by, attempts: was.attempts, ...(was.summary ? { summary: was.summary } : {}), ...(was.notes ? { notes: was.notes } : {}) }
      : { ...doc, status: 'ready', claimed_by: null, attempts: [], blocked_by: doc.blocked_by ?? [] };
    if (!was) delete next.summary;
    if (was && definition(was) === definition(next)) continue;
    if (was && (was.status === 'done' || was.status === 'claimed')) {
      problems.push({ id, message: `is ${was.status === 'done' ? 'merged' : 'in a pass'}; the Milestones step can't change it` });
      continue;
    }
    problems.push(...validateDocument(p.schema, 'task', id, Object.fromEntries(Object.entries(next).filter(([, v]) => v !== undefined))));
    tasks.set(id, next);
    (was ? changed : added).push(next);
  }
  const human = new Map(current.human);
  const humanChanged: HumanTask[] = [];
  for (const { id, value } of existsSync(join(base, 'human')) ? loadRaw(join(base, 'human')) : []) {
    const was = current.human.get(id);
    const next = { ...(value as HumanTask), ...(was ? { status: was.status, ...(was.notes ? { notes: was.notes } : {}) } : {}) };
    if (was && JSON.stringify(was) === JSON.stringify(next)) continue;
    problems.push(...validateDocument(p.schema, 'human', id, next));
    human.set(id, next);
    humanChanged.push(next);
  }
  const taskset = ts?.def ?? current.taskset;
  const plan: Plan = { tasks, human, ...(taskset ? { taskset } : {}), milestones: ms.defs };
  return { base, plan, file: ms.file, ...(ts?.file ? { taskset: ts.file } : {}), added, changed, human: humanChanged, problems };
}

export interface MilestonesCheck {
  source: string; // where the milestones came from
  milestones: { key: string; title: string; tasks: number }[];
  forward: ForwardDep[];
  problems: Problem[]; // everything else wrong, warnings included
}

// A proposal folder, or the project's own milestones: everything that keeps them from applying, with each forward
// dependency apart, since each has two resolutions (pull it forward, or a placeholder and a wiring task).
export function checkMilestones(root: string, folder?: string): MilestonesCheck {
  const p = paths(root);
  let plan: Plan;
  let problems: Problem[] = [];
  let source: string;
  if (folder) {
    const proposal = readProposal(root, folder);
    plan = proposal.plan;
    problems = proposal.problems;
    source = join(proposal.base, 'milestones.yaml');
  } else {
    plan = loadPlan(p.tasks, p.human);
    const file = milestonesPath(p.plan, plan.taskset);
    if (!plan.milestones || !file) throw new OpError(404, 'No Helix Milestones yet: plan them with the Helix skill (/helix milestones), and check its proposal with `helix-loop milestones check <folder>`.');
    source = relative(root, file);
  }
  const config = loadConfig(root);
  problems.push(...validateGraph(plan), ...validateRepos(plan, config.repos), ...validateHierarchy(plan, config.repos), ...validateMilestones(plan, { forward: false }));
  const member = membership(plan);
  return {
    source,
    milestones: (plan.milestones ?? []).map((m) => ({ key: m.key, title: m.title, tasks: member.tasks.get(m.key)?.length ?? 0 })),
    forward: forwardDeps(plan, member),
    problems,
  };
}

export interface MilestonesApplied {
  revision: number;
  snapshot?: string; // plan/history/r<N>/
  added: string[];
  changed: string[];
  placeholders: number;
  wiring: number;
  committed: boolean;
}

// Applies a proposal: checked whole first (nothing is written while anything is wrong), then written as the TaskSet's
// next revision with the milestones and the tasks the proposal brings. The loop takes it on its next round.
export async function applyMilestones(root: string, folder: string, o: { why?: string; actor: Actor }): Promise<MilestonesApplied> {
  const p = paths(root);
  const proposal = readProposal(root, folder);
  const { plan } = proposal;
  const config = loadConfig(root);
  const problems = [...proposal.problems, ...validateGraph(plan), ...validateRepos(plan, config.repos), ...errorsOnly([...validateHierarchy(plan, config.repos), ...validateMilestones(plan)])];
  if (problems.length) throw new OpError(400, `The milestones don't apply: ${plural(problems.length, 'problem')}.\n${problems.slice(0, 30).map((x) => `${x.id}: ${x.message}`).join('\n')}${problems.length > 30 ? `\n… and ${problems.length - 30} more: helix-loop milestones check ${folder}` : ''}`);
  const current = loadPlan(p.tasks, p.human);
  if (!current.taskset && !proposal.taskset) throw new OpError(400, 'The project has no version 2 TaskSet to plan milestones for: import one first (helix-loop taskset import).');
  const tasksetText = readFileSync(proposal.taskset ? tasksetPath(proposal.base) : tasksetPath(p.plan), 'utf8');
  const placeholders = [...plan.tasks.values()].filter((t) => t.placeholder_for?.length && !current.tasks.get(t.id)?.placeholder_for?.length).length;
  const wiring = [...plan.tasks.values()].filter((t) => t.wires?.length && !current.tasks.get(t.id)?.wires?.length).length;
  const r = await writeRevision(root, {
    taskset: tasksetText,
    milestones: readFileSync(join(proposal.base, 'milestones.yaml'), 'utf8'),
    tasks: [...proposal.added, ...proposal.changed],
    human: proposal.human,
    why: o.why?.trim() || `Milestones applied: ${plural(proposal.file.milestones.length, 'milestone')}${placeholders ? `, ${plural(placeholders, 'placeholder')} and ${plural(wiring, 'wiring task')}` : ''}`,
    actor: o.actor,
    counts: { placeholders, wiring },
  });
  return { revision: r.revision, ...(r.snapshot ? { snapshot: r.snapshot } : {}), added: proposal.added.map((t) => t.id), changed: proposal.changed.map((t) => t.id), placeholders, wiring, committed: r.committed };
}
