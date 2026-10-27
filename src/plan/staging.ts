import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Ajv } from 'ajv';
import { parse } from 'yaml';
import { renderPrompt, PromptOverBudget } from '../prompt.ts';
import { loadIndex, resolveSection, type SpecIndex } from '../spec/index.ts';
import type { HumanTask, Plan, Stage, Task } from '../types.ts';
import { namedStages, readStages, stageIndex } from './stages.ts';
import type { Problem } from './validate.ts';
import { validateGraph } from './validate.ts';

// Planning in parallel (design doc §9 step 4): each planner writes its tasks into plan/staging/<owner>/,
// where the running loop cannot see them. Cross-planner dependencies are written as `cap:<name>`
// (plan/capabilities.yaml). `promote` resolves them, validates the whole plan and writes plan/tasks.

export interface Planner {
  id: string;
  name: string;
  tasks: [number, number];
  human: [number, number];
  synthetic: string[];
  owns: string[];
  except?: string[];
}

export interface Capability {
  name: string;
  owner: string;
  stage: Stage;
  provides: string;
}

export interface Synthetic {
  id: string;
  title: string;
  source: string;
}

const CAP = /^cap:([a-z0-9-]+)$/;
// Other planners write their staging files while this one checks, so a file may be half-written:
// unreadable files read as the fallback here, and loadStaged reports its own directory's parse errors.
const readYaml = <T>(file: string, fallback: T): T => {
  if (!existsSync(file)) return fallback;
  try {
    return (parse(readFileSync(file, 'utf8')) as T) ?? fallback;
  } catch {
    return fallback;
  }
};

export function loadPlanners(root: string): Map<string, Planner> {
  const raw = readYaml<Record<string, Omit<Planner, 'id'>>>(join(root, 'plan', 'planners.yaml'), {});
  return new Map(Object.entries(raw).map(([id, p]) => [id, { id, ...p }]));
}

export function loadCapabilities(root: string): Map<string, Capability> {
  const list = readYaml<Capability[]>(join(root, 'plan', 'capabilities.yaml'), []);
  return new Map(list.map((c) => [c.name, c]));
}

export function loadDeferred(root: string): Set<string> {
  return new Set(readYaml<{ id: string }[]>(join(root, 'plan', 'deferred-reqs.yaml'), []).map((d) => d.id));
}

// The requirement IDs a planner must cover: its patterns expanded over the spec, minus exceptions and deferrals.
export function ownedReqs(p: Planner, index: SpecIndex, deferred: Set<string>): string[] {
  const all = Object.keys(index.reqs);
  const out = new Set<string>();
  for (const pat of p.owns) {
    if (pat.endsWith('-*')) {
      for (const id of all) if (id.startsWith(pat.slice(0, -1))) out.add(id);
    } else if (all.includes(pat)) {
      out.add(pat);
    }
  }
  for (const x of p.except ?? []) out.delete(x);
  for (const d of deferred) out.delete(d);
  return [...out].sort();
}

const num = (id: string) => Number(id.replace(/^\D+-/, ''));

interface Staged {
  tasks: Map<string, Task>;
  human: Map<string, HumanTask>;
  provides: Record<string, string[]>;
  synthetic: Synthetic[];
  unreadable: string[]; // files that failed to parse
}

export function loadStaged(dir: string): Staged {
  const unreadable: string[] = [];
  const readDir = <T>(sub: string) => {
    const out = new Map<string, T>();
    const d = join(dir, sub);
    if (!existsSync(d)) return out;
    for (const f of readdirSync(d).filter((f) => f.endsWith('.yaml')).sort()) {
      try {
        const v = parse(readFileSync(join(d, f), 'utf8')) as T & { id: string };
        out.set(v?.id ?? f, v);
      } catch (e) {
        unreadable.push(`${sub}/${f}: ${(e as Error).message.split('\n')[0]}`);
      }
    }
    return out;
  };
  return {
    tasks: readDir<Task>('tasks'),
    human: readDir<HumanTask>('human'),
    provides: readYaml<Record<string, string[]>>(join(dir, 'provides.yaml'), {}),
    synthetic: readYaml<Synthetic[]>(join(dir, 'synthetic-reqs.yaml'), []),
    unreadable,
  };
}

// Every synthetic requirement defined anywhere: the promoted file plus every staging directory.
export function allSynthetic(root: string): Synthetic[] {
  const out = readYaml<Synthetic[]>(join(root, 'plan', 'synthetic-reqs.yaml'), []);
  const staging = join(root, 'plan', 'staging');
  if (existsSync(staging)) for (const d of readdirSync(staging)) out.push(...readYaml<Synthetic[]>(join(staging, d, 'synthetic-reqs.yaml'), []));
  return out;
}

export function checkStaging(root: string, owner: string): Problem[] {
  const problems: Problem[] = [];
  const add = (id: string, message: string) => problems.push({ id, message });
  const planner = loadPlanners(root).get(owner);
  if (!planner) return [{ id: owner, message: 'no such planner in plan/planners.yaml' }];
  const dir = join(root, 'plan', 'staging', owner);
  const caps = loadCapabilities(root);
  const deferred = loadDeferred(root);
  const index = loadIndex(join(root, 'spec', 'index.json'));
  const staged = loadStaged(dir);
  const stages = readStages(join(root, 'plan'))?.map((x) => x.key) ?? namedStages(staged.tasks.values());
  const at = (stage: Stage | undefined) => stageIndex(stages, stage);
  for (const u of staged.unreadable) add(u.split(':')[0]!, `YAML does not parse: ${u}`);
  const synthetic = allSynthetic(root);
  const known = new Set([...Object.keys(index.reqs), ...synthetic.map((s) => s.id)]);
  const humanKnown = new Set<string>();
  for (let i = 1; i <= 28; i++) humanKnown.add(`HT-${i}`);
  const stagingRoot = join(root, 'plan', 'staging');
  if (existsSync(stagingRoot)) for (const d of readdirSync(stagingRoot)) for (const id of loadStaged(join(stagingRoot, d)).human.keys()) humanKnown.add(id);
  for (const f of existsSync(join(root, 'plan', 'human')) ? readdirSync(join(root, 'plan', 'human')) : []) humanKnown.add(f.replace(/\.yaml$/, ''));

  // Schema, with cap: placeholders allowed in blocked_by.
  const schema = JSON.parse(readFileSync(join(root, 'plan', 'schema', 'task.schema.json'), 'utf8'));
  schema.properties.blocked_by.items.pattern = '^(T-\\d{4}|HT-\\d+|cap:[a-z0-9-]+)$';
  const hschema = JSON.parse(readFileSync(join(root, 'plan', 'schema', 'human.schema.json'), 'utf8'));
  hschema.properties.blocked_by.items.pattern = '^(T-\\d{4}|HT-\\d+|cap:[a-z0-9-]+)$';
  const ajv = new Ajv({ allErrors: true });
  const vTask = ajv.compile(schema);
  const vHuman = ajv.compile(hschema);

  // The mascot planner runs after the others and attaches each moment to the task that builds its screen,
  // so it may depend on any staged task directly; everyone else goes through capabilities.
  const visible = new Map(staged.tasks);
  if (owner === 'M' && existsSync(stagingRoot)) {
    for (const d of readdirSync(stagingRoot)) if (d !== owner) for (const [k, v] of loadStaged(join(stagingRoot, d)).tasks) if (!visible.has(k)) visible.set(k, v);
  }
  const template = readFileSync(join(root, 'prompts', 'build.md'), 'utf8');
  for (const [id, t] of staged.tasks) {
    if (!vTask(t)) for (const e of vTask.errors ?? []) add(id, `schema: ${e.instancePath || '/'} ${e.message}`);
    if (!t?.id) continue;
    const n = num(t.id);
    if (n < planner.tasks[0] || n > planner.tasks[1]) add(id, `outside ${owner}'s ID range T-${String(planner.tasks[0]).padStart(4, '0')}–T-${String(planner.tasks[1]).padStart(4, '0')}`);
    if (t.status !== 'ready' || t.claimed_by !== null || (t.attempts ?? []).length) add(id, 'a new task is status: ready, claimed_by: null, attempts: []');
    for (const d of t.blocked_by ?? []) {
      const m = CAP.exec(d);
      if (m) {
        const c = caps.get(m[1]!);
        if (!c) add(id, `blocked by unknown capability ${d}`);
        else if (c.owner === owner) add(id, `blocked by ${d}, which ${owner} provides itself: depend on the task directly`);
        else if (at(c.stage) > at(t.stage)) add(id, `blocked by ${d} (ready in ${c.stage}) but the task is in ${t.stage}`);
      } else if (d.startsWith('T-')) {
        const dep = visible.get(d);
        if (!dep) add(id, `blocked by ${d}, which is not in this staging directory (use cap: for other planners' work)`);
        else if (at(dep.stage) > at(t.stage)) add(id, `blocked by ${d} (${dep.stage}) but the task is in ${t.stage}`);
      } else if (!humanKnown.has(d)) add(id, `blocked by ${d}, which is neither in Appendix D nor a staged human task`);
    }
    for (const r of t.reqs ?? []) {
      if (deferred.has(r)) add(id, `claims ${r}, which is deferred to the fast follow`);
      else if (!known.has(r)) add(id, `claims ${r}, which is neither in the spec nor a defined synthetic requirement`);
    }
    for (const a of t.acceptance ?? []) {
      const tags = /\[([^\]]+)\]/.exec(a)?.[1]?.split(/,\s*/) ?? [];
      for (const tag of tags) if (!(t.reqs ?? []).includes(tag)) add(id, `acceptance "${a.slice(0, 60)}…" is tagged ${tag}, not in reqs`);
    }
    for (const s of t.spec ?? []) if (!resolveSection(index, s) && !index.reqs[s]) add(id, `spec citation "${s}" does not resolve (run: mushy-loop sections)`);
    try {
      renderPrompt({ template, task: { ...t, blocked_by: [] }, index, sectionsDir: join(root, 'spec', 'sections'), budgetBytes: 40_000 });
    } catch (e) {
      if (e instanceof PromptOverBudget) add(id, `${e.message}`);
    }
  }

  // Internal graph: no cycles among this planner's own tasks.
  const internal: Plan = { tasks: new Map([...staged.tasks].map(([k, t]) => [k, { ...t, blocked_by: (t.blocked_by ?? []).filter((d) => staged.tasks.has(d)) }])), human: new Map() };
  for (const x of validateGraph(internal)) if (x.message.includes('cycle')) add(x.id, x.message);

  for (const [id, h] of staged.human) {
    if (!vHuman(h)) for (const e of vHuman.errors ?? []) add(id, `schema: ${e.instancePath || '/'} ${e.message}`);
    const n = num(id);
    if (n < planner.human[0] || n > planner.human[1]) add(id, `outside ${owner}'s human ID range HT-${planner.human[0]}–HT-${planner.human[1]}`);
    for (const d of h?.blocked_by ?? []) {
      const m = CAP.exec(d);
      if (m && !caps.has(m[1]!)) add(id, `blocked by unknown capability ${d}`);
    }
  }

  // Capabilities this planner owns are provided by its tasks, early enough.
  for (const c of caps.values()) {
    if (c.owner !== owner) continue;
    const ids = staged.provides[c.name] ?? [];
    if (!ids.length) add(`cap:${c.name}`, 'owned by this planner but not listed in provides.yaml');
    for (const pid of ids) {
      const t = staged.tasks.get(pid);
      if (!t) add(`cap:${c.name}`, `provides.yaml names ${pid}, which is not a staged task`);
      else if (at(t.stage) > at(c.stage)) add(`cap:${c.name}`, `${pid} is in ${t.stage}, later than the capability's promised ${c.stage}`);
    }
  }
  for (const name of Object.keys(staged.provides)) {
    if (!caps.has(name)) add(`cap:${name}`, 'provides.yaml lists a capability that is not in capabilities.yaml');
    else if (caps.get(name)!.owner !== owner) add(`cap:${name}`, `owned by ${caps.get(name)!.owner}, not ${owner}`);
  }

  // Synthetic requirements: own prefixes, unique, each claimed.
  const claimed = new Set([...staged.tasks.values()].flatMap((t) => t.reqs ?? []));
  const seen = new Set<string>();
  for (const s of staged.synthetic) {
    const prefix = s.id.split('-')[0]!;
    if (!planner.synthetic.includes(prefix)) add(s.id, `synthetic prefix ${prefix} is not one of ${owner}'s (${planner.synthetic.join(', ')})`);
    if (index.reqs[s.id]) add(s.id, 'synthetic ID collides with a spec requirement');
    if (seen.has(s.id)) add(s.id, 'synthetic ID defined twice');
    seen.add(s.id);
    if (!claimed.has(s.id)) add(s.id, 'synthetic requirement defined but no task claims it');
  }

  // Coverage of the requirements this planner owns.
  for (const r of ownedReqs(planner, index, deferred)) if (!claimed.has(r)) add(r, `owned by ${owner} but no staged task claims it`);
  return problems;
}

// Resolves every staging directory into final plan files. Returns problems instead of writing when
// the resulting plan does not validate.
export function resolveStaging(root: string, owners: string[]): { plan: Plan; synthetic: Synthetic[]; problems: Problem[] } {
  const problems: Problem[] = [];
  const caps = loadCapabilities(root);
  const providers = new Map<string, string[]>();
  const tasks = new Map<string, Task>();
  const human = new Map<string, HumanTask>();
  const synthetic: Synthetic[] = [];
  const planners = loadPlanners(root);
  for (const owner of owners) {
    const s = loadStaged(join(root, 'plan', 'staging', owner));
    for (const [cap, ids] of Object.entries(s.provides)) providers.set(cap, ids);
    // The planner's name becomes the task's feature, so the documents never show planner codes.
    for (const [id, t] of s.tasks) tasks.set(id, { ...t, feature: t.feature ?? planners.get(owner)?.name });
    for (const [id, h] of s.human) human.set(id, h);
    synthetic.push(...s.synthetic);
  }
  const resolve = (from: string, deps: string[]) =>
    [...new Set(deps.flatMap((d) => {
      const m = CAP.exec(d);
      if (!m) return [d];
      const ids = providers.get(m[1]!);
      if (!ids?.length) {
        problems.push({ id: from, message: `${d} has no provider yet (owner ${caps.get(m[1]!)?.owner ?? '?'} not promoted)` });
        return [];
      }
      return ids;
    }))];
  for (const t of tasks.values()) t.blocked_by = resolve(t.id, t.blocked_by ?? []);
  for (const h of human.values()) h.blocked_by = resolve(h.id, h.blocked_by ?? []);
  return { plan: { tasks, human }, synthetic, problems };
}
