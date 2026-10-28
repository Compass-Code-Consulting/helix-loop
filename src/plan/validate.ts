import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { Ajv, type ErrorObject } from 'ajv';
import { parse } from 'yaml';
import type { SpecIndex } from '../spec/index.ts';
import { resolveSection } from '../spec/index.ts';
import type { Plan } from '../types.ts';
import { forwardDeps, membership, milestonesPath, readMilestones, wiringOf } from './milestones.ts';
import { PromptOverBudget, renderPrompt } from '../prompt.ts';
import { loadRaw } from './store.ts';
import { MIGRATE_V1, readTaskSet, tasksetPath, tasksByStory } from './taskset.ts';

// The plan is validated before any pass runs (design doc §3): schema, DAG, coverage, citations, the TaskSet's
// hierarchy and the milestones' order. Traceability of done tasks is checked by the gate, against the repo's test
// titles. A warning is reported but never stops the loop.

export interface Problem {
  id: string;
  message: string;
  level?: 'warning';
}

export const errorsOnly = (problems: Problem[]) => problems.filter((p) => p.level !== 'warning');

// The fields a version 1 TaskSet's tasks had, for the one error that points to the migration instead of a schema
// error on every task.
const V1_FIELDS = ['epic', 'stage', 'feature'];
const legacyError = (e: ErrorObject) =>
  (e.keyword === 'additionalProperties' && V1_FIELDS.includes(String(e.params.additionalProperty))) || (e.keyword === 'required' && e.params.missingProperty === 'story');

// Every plan file against its schema: taskset.yaml (which must exist), milestones.yaml when there is one, and each
// task and human task.
export function validateSchemas(schemaDir: string, tasksDir: string, humanDir: string): Problem[] {
  const ajv = new Ajv({ allErrors: true });
  const problems: Problem[] = [];
  const compile = (schemaFile: string) => ajv.compile(JSON.parse(readFileSync(join(schemaDir, schemaFile), 'utf8')));
  const report = (id: string, errors: ErrorObject[] | null | undefined) => {
    for (const e of errors ?? []) problems.push({ id, message: `schema: ${e.instancePath || '/'} ${e.message}` });
  };
  const planDir = dirname(tasksDir);
  const ts = readTaskSet(planDir);
  if (!existsSync(tasksetPath(planDir))) problems.push({ id: 'taskset.yaml', message: 'missing: the TaskSet declares its lanes, epics, features and stories in plan/taskset.yaml (write it with the Helix skill: /helix taskset)' });
  for (const m of ts.problems) problems.push({ id: 'taskset.yaml', message: m });
  const v1 = ts.problems.includes(MIGRATE_V1);
  if (ts.file) {
    const check = compile('taskset.schema.json');
    if (!check(ts.file)) report('taskset.yaml', check.errors);
  }
  const msFile = milestonesPath(planDir, ts.def);
  if (msFile) {
    const ms = readMilestones(msFile);
    for (const m of ms.problems) problems.push({ id: basename(msFile), message: m });
    const check = compile('milestones.schema.json');
    if (ms.file && !check(ms.file)) report(basename(msFile), check.errors);
  }
  let legacy = 0;
  for (const [kind, dir] of [['task', tasksDir], ['human', humanDir]] as const) {
    const check = compile(`${kind}.schema.json`);
    for (const { id, value } of loadRaw(dir)) {
      if (check(value)) continue;
      const old = kind === 'task' && !!value && typeof value === 'object' && V1_FIELDS.some((k) => k in value);
      if (old) legacy++;
      report(id, old ? check.errors?.filter((e) => !legacyError(e)) : check.errors);
    }
  }
  if (legacy && !v1) problems.push({ id: 'taskset.yaml', message: `${legacy} task${legacy === 1 ? '' : 's'} still name \`epic\`, \`stage\` or \`feature\`, as a version 1 TaskSet's did; version 2 tasks name their \`story\`. Convert the plan as docs/migrating.md describes under "From a version 1 TaskSet"` });
  return problems;
}

// One task or human task, as it would be written, against its schema: for an edit checked before it lands.
export function validateDocument(schemaDir: string, kind: 'task' | 'human', id: string, value: unknown): Problem[] {
  const validate = new Ajv({ allErrors: true }).compile(JSON.parse(readFileSync(join(schemaDir, `${kind}.schema.json`), 'utf8')));
  if (validate(value)) return [];
  return (validate.errors ?? []).map((e) => ({ id, message: `schema: ${e.instancePath || '/'} ${e.message}` }));
}

export function validateGraph(plan: Plan): Problem[] {
  const problems: Problem[] = [];
  const exists = (id: string) => plan.tasks.has(id) || plan.human.has(id);
  const edges = new Map<string, string[]>();
  for (const t of plan.tasks.values()) edges.set(t.id, t.blocked_by);
  for (const h of plan.human.values()) edges.set(h.id, h.blocked_by);
  for (const [id, deps] of edges) {
    for (const d of deps) {
      if (!exists(d)) problems.push({ id, message: `blocked_by ${d}, which does not exist` });
      if (d === id) problems.push({ id, message: 'blocked by itself' });
    }
  }
  // Cycle detection, iterative DFS so a deep chain cannot overflow the stack.
  const state = new Map<string, 1 | 2>(); // 1 visiting, 2 done
  for (const start of edges.keys()) {
    if (state.has(start)) continue;
    const stack: { id: string; i: number }[] = [{ id: start, i: 0 }];
    state.set(start, 1);
    while (stack.length) {
      const top = stack[stack.length - 1]!;
      const deps = (edges.get(top.id) ?? []).filter(exists);
      if (top.i < deps.length) {
        const next = deps[top.i++]!;
        const s = state.get(next);
        if (s === 1) {
          const cycle = [...stack.slice(stack.findIndex((f) => f.id === next)).map((f) => f.id), next];
          problems.push({ id: next, message: `dependency cycle: ${cycle.join(' → ')}` });
        } else if (s === undefined) {
          state.set(next, 1);
          stack.push({ id: next, i: 0 });
        }
      } else {
        state.set(top.id, 2);
        stack.pop();
      }
    }
  }
  return problems;
}

// Every requirement in the spec, plus the synthetic IDs given to prose requirements, is claimed
// by at least one task; every acceptance test is tagged only with the task's own requirements;
// every spec citation resolves.
export function validateCoverage(plan: Plan, index: SpecIndex, syntheticFile: string, deferred: Set<string> = new Set()): Problem[] {
  const problems: Problem[] = [];
  const synthetic = existsSync(syntheticFile)
    ? ((parse(readFileSync(syntheticFile, 'utf8')) as { id: string }[] | null) ?? []).map((s) => s.id)
    : [];
  const known = new Set([...Object.keys(index.reqs), ...synthetic].filter((r) => !deferred.has(r)));
  for (const t of plan.tasks.values()) for (const r of t.reqs) if (deferred.has(r)) problems.push({ id: t.id, message: `claims ${r}, which is deferred to the fast follow` });
  const claimed = new Set<string>();
  for (const t of plan.tasks.values()) {
    for (const r of t.reqs) {
      if (!known.has(r)) problems.push({ id: t.id, message: `cites ${r}, which is neither in the spec nor in synthetic-reqs.yaml` });
      claimed.add(r);
    }
    for (const a of t.acceptance) {
      const tags = /\[([^\]]+)\]/.exec(a)?.[1]?.split(/,\s*/) ?? [];
      for (const tag of tags) {
        if (!t.reqs.includes(tag)) problems.push({ id: t.id, message: `acceptance "${a}" is tagged ${tag}, which is not in the task's reqs` });
      }
    }
    for (const s of t.spec) {
      if (!resolveSection(index, s) && !index.reqs[s]) problems.push({ id: t.id, message: `spec citation "${s}" does not resolve in spec/index.json` });
    }
  }
  for (const r of known) {
    if (!claimed.has(r)) problems.push({ id: r, message: 'no task delivers this requirement' });
  }
  return problems;
}

// Every task's prompt, rendered exactly as a pass would render it, fits the budget (L2).
export function validatePrompts(plan: Plan, index: SpecIndex, sectionsDir: string, template: string, budgetBytes: number): Problem[] {
  const problems: Problem[] = [];
  for (const t of plan.tasks.values()) {
    if (t.status === 'done') continue;
    try {
      renderPrompt({ template, task: t, index, sectionsDir, budgetBytes });
    } catch (e) {
      if (e instanceof PromptOverBudget) problems.push({ id: t.id, message: e.message });
      else throw e;
    }
  }
  return problems;
}

// A release hold (config release.hold_until) waits for a human task in the plan; one that names no such
// task would hold that repo's releases forever.
// Each task builds a repo the project config knows how to gate; the schema can't know the project's repos.
export function validateRepos(plan: Plan, repos: Record<string, unknown>): Problem[] {
  return [...plan.tasks.values()].filter((t) => !repos[t.repo]).map((t) => ({ id: t.id, message: `repo ${t.repo} is not under repos in the config (${Object.keys(repos).join(', ')})` }));
}

export function validateReleaseHolds(plan: Plan, holds: Record<string, string | undefined> = {}): Problem[] {
  return Object.entries(holds).flatMap(([repo, id]) =>
    id && plan.human.has(id) ? [] : [{ id: id ?? repo, message: `release.hold_until holds ${repo}'s releases until ${id}, which is not a human task in the plan` }],
  );
}

// Two tasks in the same area are allowed (that is the point of areas), but a done task that is
// still claimed, or a claimed task with no holder, means the plan was hand-edited badly.
export function validateState(plan: Plan): Problem[] {
  const problems: Problem[] = [];
  for (const t of plan.tasks.values()) {
    if (t.status === 'claimed' && !t.claimed_by) problems.push({ id: t.id, message: 'claimed but claimed_by is empty' });
    if (t.status !== 'claimed' && t.claimed_by) problems.push({ id: t.id, message: `status ${t.status} but claimed_by ${t.claimed_by}` });
  }
  return problems;
}

// ---- the TaskSet's hierarchy ----

// No title or key may say "Day N": the delivery order is the milestones', never a calendar's.
export const DAY_N = /\bday[\s-]?\d/i;

// The sizes FORMAT.md gives each level, in its children; outside them is a warning, not an error.
const SIZES = { epic: [2, 8, 'features'], feature: [2, 6, 'stories'], story: [2, 8, 'tasks'] } as const;

// Lane › Epic › Feature › Story › Task: every task names a declared story in a lane that builds its repo; every
// story has a task, every feature a story, every epic a feature; nothing says "Day N". `repos`, when given, are the
// config's, which each lane's repo must be one of. Nothing to check without a version 2 TaskSet: validateSchemas
// reports that.
export function validateHierarchy(plan: Plan, repos?: Record<string, unknown>): Problem[] {
  const ts = plan.taskset;
  if (!ts) return [];
  const problems: Problem[] = [];
  const error = (id: string, message: string) => problems.push({ id, message });
  const warn = (id: string, message: string) => problems.push({ id, message, level: 'warning' });
  const byStory = tasksByStory(plan);
  const size = (level: keyof typeof SIZES, key: string, n: number) => {
    const [min, max, what] = SIZES[level];
    if (n && (n < min || n > max)) warn(key, `${level} has ${n} ${n === 1 ? what.replace(/ies$/, 'y').replace(/s$/, '') : what}; ${min}–${max} is the usual size`);
  };
  const days = (id: string, ...texts: string[]) => {
    for (const x of texts) if (DAY_N.test(x)) error(id, `"${x}" says "Day N": name the outcome; the order is the milestones'`);
  };
  for (const l of ts.lanes) {
    days(l.key, l.key);
    if (repos && !repos[l.repo]) error(l.key, `lane builds repo ${l.repo}, which is not under repos in the config (${Object.keys(repos).join(', ')})`);
    if (!l.epics.length) error(l.key, 'lane has no epics');
  }
  for (const e of ts.epics.values()) {
    days(e.key, e.key, e.title);
    if (!e.features.length) error(e.key, 'epic has no features');
    size('epic', e.key, e.features.length);
  }
  for (const f of ts.features.values()) {
    days(f.key, f.key, f.title);
    if (!f.stories.length) error(f.key, 'feature has no stories');
    size('feature', f.key, f.stories.length);
  }
  for (const s of ts.stories.values()) {
    days(s.key, s.key, s.title);
    const n = byStory.get(s.key)?.length ?? 0;
    if (!n) error(s.key, 'story has no tasks');
    size('story', s.key, n);
  }
  for (const t of plan.tasks.values()) {
    days(t.id, t.title);
    const s = ts.stories.get(t.story);
    if (!s) {
      error(t.id, `story ${t.story} is not declared in taskset.yaml`);
      continue;
    }
    const lane = ts.lanes.find((l) => l.key === s.lane)!;
    if (lane.repo !== t.repo) error(t.id, `builds ${t.repo}, but its story ${t.story} is in lane ${lane.key}, which builds ${lane.repo}`);
  }
  for (const h of plan.human.values()) {
    if (h.story && !ts.stories.has(h.story)) error(h.id, `story ${h.story} is not declared in taskset.yaml`);
  }
  return problems;
}

// ---- the milestones ----

// Helix Milestones exist and order every task exactly once; no task waits on a task in a later milestone; every
// placeholder has exactly one wiring task, blocked by it and by what it stands in for, in their milestone or later.
// `forward: false` leaves out the dependencies that point forward, for `helix-loop milestones check`, which lists
// them with their resolutions.
export function validateMilestones(plan: Plan, o: { forward?: boolean } = {}): Problem[] {
  if (!plan.taskset) return []; // nothing to order yet; validateSchemas says why
  const ms = plan.milestones;
  if (!ms) return [{ id: 'milestones.yaml', message: 'missing: plan the delivery order with the Helix skill (/helix milestones), then apply it with `helix-loop milestones apply <folder>`; the loop runs only a plan with milestones' }];
  const problems: Problem[] = [];
  const error = (id: string, message: string) => problems.push({ id, message });
  const ts = plan.taskset;
  const seen = new Set<string>();
  for (const m of ms) {
    if (seen.has(m.key)) error(m.key, 'milestone is declared twice');
    seen.add(m.key);
    if (DAY_N.test(m.key) || DAY_N.test(m.title)) error(m.key, `milestone "${m.title}" says "Day N": name the outcome someone can see`);
    for (const f of m.features) if (!ts.features.has(f)) error(m.key, `names feature ${f}, which taskset.yaml doesn't declare`);
    for (const s of m.stories) if (!ts.stories.has(s)) error(m.key, `names story ${s}, which taskset.yaml doesn't declare`);
    for (const t of m.tasks) if (!plan.tasks.has(t)) error(m.key, `names task ${t}, which does not exist`);
  }
  const m = membership(plan);
  for (const id of m.unplaced) error(id, `is in no milestone: name its feature, its story (${plan.tasks.get(id)!.story}) or the task itself in milestones.yaml`);
  for (const a of m.ambiguous) error(a.task, `is in ${a.milestones.length} milestones by its ${a.by} (${a.milestones.join(', ')}); name it in one`);
  for (const [key, ids] of m.tasks) if (!ids.length && seen.has(key)) problems.push({ id: key, message: 'milestone has no tasks: what it names belongs to more specific milestones', level: 'warning' });
  const title = (key: string) => ms.find((x) => x.key === key)?.title ?? key;
  for (const f of o.forward === false ? [] : forwardDeps(plan, m)) {
    error(f.task, `waits on ${f.dep}, which is in a later milestone (${title(f.depAt)}, after ${title(f.at)}): pull ${f.dep} forward, or build ${f.task} against a placeholder (placeholder_for: [${f.dep}]) with a wiring task in ${f.depAt} or later; \`helix-loop milestones check\` shows both`);
  }
  // Placeholders and their wiring.
  const wiring = wiringOf(plan);
  const at = (id: string) => m.index.get(m.of.get(id) ?? '') ?? -1;
  for (const t of plan.tasks.values()) {
    for (const p of t.placeholder_for ?? []) {
      if (!plan.tasks.has(p)) error(t.id, `placeholder_for ${p}, which does not exist`);
      if (t.blocked_by.includes(p)) error(t.id, `placeholder_for ${p}, but also blocked_by it: a placeholder means it doesn't wait`);
    }
    if (t.placeholder_for?.length) {
      const w = wiring.get(t.id) ?? [];
      if (w.length !== 1) error(t.id, w.length ? `is wired by ${w.length} tasks (${w.map((x) => x.id).join(', ')}); one wiring task replaces its placeholder` : `builds against a placeholder for ${t.placeholder_for.join(', ')}, but no task wires it in: add a task with wires: [${t.id}]`);
    }
    for (const p of t.wires ?? []) {
      const ph = plan.tasks.get(p);
      if (!ph) {
        error(t.id, `wires ${p}, which does not exist`);
        continue;
      }
      if (!ph.placeholder_for?.length) {
        error(t.id, `wires ${p}, which has no placeholder_for`);
        continue;
      }
      const needs = [p, ...ph.placeholder_for];
      const missing = needs.filter((d) => !t.blocked_by.includes(d));
      if (missing.length) error(t.id, `wires ${p}, so it is blocked_by ${needs.join(', ')}; add ${missing.join(', ')}`);
      const late = needs.filter((d) => plan.tasks.has(d) && at(d) > at(t.id));
      if (late.length && at(t.id) >= 0) error(t.id, `wires ${p}, but ${late.join(', ')} ${late.length === 1 ? 'is' : 'are'} in a later milestone: a wiring task goes in its dependencies' milestone or later`);
    }
  }
  return problems;
}

// The hierarchy and the milestones together, as an edit is checked against them (app/actions.ts, loop.ts
// reloadPlan): only what is wrong, never the size warnings.
export const validateStructure = (plan: Plan, repos?: Record<string, unknown>): Problem[] => errorsOnly([...validateHierarchy(plan, repos), ...validateMilestones(plan)]);

