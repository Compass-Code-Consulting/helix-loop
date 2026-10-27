import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Ajv } from 'ajv';
import { parse } from 'yaml';
import type { SpecIndex } from '../spec/index.ts';
import { resolveSection } from '../spec/index.ts';
import type { Plan } from '../types.ts';
import { stageIndex, stagesOf } from './stages.ts';
import { PromptOverBudget, renderPrompt } from '../prompt.ts';
import { loadRaw } from './store.ts';

// The plan is validated before any pass runs (design doc §3): schema, DAG, coverage, citations.
// Traceability of done tasks is checked by the gate, against the repo's test titles.

export interface Problem {
  id: string;
  message: string;
}

export function validateSchemas(schemaDir: string, tasksDir: string, humanDir: string): Problem[] {
  const ajv = new Ajv({ allErrors: true });
  const problems: Problem[] = [];
  const check = (schemaFile: string, dir: string) => {
    const validate = ajv.compile(JSON.parse(readFileSync(join(schemaDir, schemaFile), 'utf8')));
    for (const { id, value } of loadRaw(dir)) {
      if (!validate(value)) {
        for (const e of validate.errors ?? []) problems.push({ id, message: `schema: ${e.instancePath || '/'} ${e.message}` });
      }
    }
  };
  check('task.schema.json', tasksDir);
  check('human.schema.json', humanDir);
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
  const stages = stagesOf(plan);
  for (const t of plan.tasks.values()) {
    if (t.stage && !stages.includes(t.stage)) problems.push({ id: t.id, message: `in stage ${t.stage}, which the TaskSet doesn't declare (stages: ${stages.join(', ')})` });
  }
  // A task may wait only on work in its own stage or earlier; otherwise its stage could never close.
  // Nor may other work wait on design-role work: a stage opens while only design work is left in earlier
  // stages (openStage), so the mascot art never holds up the build.
  for (const t of plan.tasks.values()) {
    for (const d of t.blocked_by) {
      const dep = plan.tasks.get(d);
      if (dep && stageIndex(stages, dep.stage) > stageIndex(stages, t.stage)) problems.push({ id: t.id, message: `blocked by ${d} in ${dep.stage}, a later stage than its own ${t.stage}` });
      if (dep?.role === 'design' && t.role !== 'design') {
        problems.push({ id: t.id, message: `blocked by ${d}, a design-role task; only design-role tasks may wait on design work, since it can finish after later stages open` });
      }
    }
  }
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
