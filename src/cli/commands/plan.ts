import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { parse } from 'yaml';
import { commit } from '../../app/actions.ts';
import { ownerOf } from '../../app/prompts.ts';
import { diffTaskSet, initTaskSet, loadTaskSet, readTaskSetFile, tasksetFile, writeTaskSetFile } from '../../app/taskset.ts';
import { loadConfig, paths, projectInfo } from '../../config.ts';
import { prepareDryRun } from '../../dryrun.ts';
import { renderDependencyMap } from '../../map/render.ts';
import { renderHumanPlan, renderImplementationPlan } from '../../plan/render.ts';
import { loadDeferred, loadSynthetic } from '../../plan/requirements.ts';
import { stagesOf, stageTitle } from '../../plan/stages.ts';
import { atomicWrite, loadPlan, writeTask } from '../../plan/store.ts';
import { validateCoverage, validateGraph, validatePrompts, validateReleaseHolds, validateRepos, validateSchemas, validateState } from '../../plan/validate.ts';
import { loadIndex, writeIndex } from '../../spec/index.ts';
import { define, UsageError } from '../command.ts';
import { currentMap, shown } from '../shared.ts';

// The spec and the TaskSet: indexing the spec, checking the plan, writing its documents, and bringing a TaskSet
// written with the Helix skill into the project.

const specIndex = define({
  name: 'spec index',
  group: 'Spec and TaskSet',
  summary: 'Split the spec into sections and index its requirements',
  description: `Reads .helix/spec/ (spec.md, or the one other Markdown file there) and writes .helix/spec/sections/ and .helix/spec/index.json.
Builders get only the sections their task cites, so run this after every change to the spec.`,
  run({ root, out }) {
    const p = paths(root);
    if (!existsSync(p.spec)) throw new UsageError(`No spec at ${relative(root, p.spec)}. Write one with the Helix skill (/helix spec), or copy yours there.`);
    const i = writeIndex(p.spec, p.specSections, p.specIndex);
    out(`spec v${i.version}: ${Object.keys(i.sections).length} sections, ${Object.keys(i.reqs).length} requirements`);
  },
});

const specSections = define({
  name: 'spec sections',
  group: 'Spec and TaskSet',
  summary: 'List the section keys a task can cite, with their sizes',
  args: [{ name: 'filter', description: 'Only keys that contain this text', optional: true }],
  json: true,
  run({ root, args, json, out }) {
    const p = paths(root);
    const index = loadIndex(p.specIndex);
    const filter = (args[0] ?? '').toLowerCase();
    const rows = Object.values(index.sections)
      .filter((s) => !filter || s.key.toLowerCase().includes(filter))
      .map((s) => ({ key: s.key, title: s.title, bytes: Buffer.byteLength(readFileSync(join(p.specSections, s.file), 'utf8').split('\n').slice(s.startLine - 1, s.endLine).join('\n')) }));
    if (json) return out(JSON.stringify(rows, null, 2));
    for (const r of rows) out(`${String(r.bytes).padStart(6)}  ${r.key}`);
  },
});

export function validateProject(root: string): { problems: { id: string; message: string }[]; tasks: number; human: number } {
  const p = paths(root);
  const plan = loadPlan(p.tasks, p.human);
  const config = loadConfig(root);
  const index = loadIndex(p.specIndex);
  const problems = [
    ...validateSchemas(p.schema, p.tasks, p.human),
    ...validateGraph(plan),
    ...validateRepos(plan, config.repos),
    ...validateState(plan),
    ...validateReleaseHolds(plan, config.release.hold_until),
    ...validateCoverage(plan, index, p.syntheticReqs, loadDeferred(root)),
    ...validatePrompts(plan, index, p.specSections, readFileSync(join(p.prompts, 'build.md'), 'utf8'), config.limits.prompt_budget_bytes),
  ];
  return { problems, tasks: plan.tasks.size, human: plan.human.size };
}

const validate = define({
  name: 'validate',
  group: 'Spec and TaskSet',
  summary: 'Check the plan: schemas, dependencies, repos, coverage, prompt sizes, state',
  description: `Runs every check the loop runs before it starts: each task and human task against the schemas, every dependency resolving with no cycles and no task waiting on a later stage, each task's repo in the config, every requirement claimed by a task (or deferred), each task's prompt within its budget, and claim state that makes sense.
Exits 0 when the plan is clean, 1 when it has problems.`,
  json: true,
  run({ root, json, out }) {
    const r = validateProject(root);
    if (json) out(JSON.stringify(r, null, 2));
    else {
      for (const x of r.problems) out(`${x.id}: ${x.message}`);
      out(`${r.tasks} tasks, ${r.human} human tasks, ${r.problems.length} problem${r.problems.length === 1 ? '' : 's'}`);
    }
    return r.problems.length ? 1 : 0;
  },
});

const render = define({
  name: 'plan render',
  group: 'Spec and TaskSet',
  summary: 'Write the Implementation Plan, the Human Implementation Plan and the dependency map',
  description: `Writes .helix/plan/ImplementationPlan.md (Lane › Epic › Task), HumanImplementationPlan.md (the steps only the owner can do, with start-by dates) and DependencyMap.html, from the plan as it stands.
The app and Helix run this after every plan change; never edit those files by hand.`,
  run({ root, out }) {
    const p = paths(root);
    const plan = loadPlan(p.tasks, p.human);
    const info = projectInfo(loadConfig(root));
    const map = currentMap(root);
    const synthetic = loadSynthetic(root).filter((s) => [...plan.tasks.values()].some((t) => t.reqs.includes(s.id)));
    atomicWrite(p.implementationPlan, renderImplementationPlan(plan, map, loadIndex(p.specIndex), synthetic, loadTaskSet(root, plan), info));
    atomicWrite(p.humanPlan, renderHumanPlan(plan, map, info));
    atomicWrite(p.map, renderDependencyMap(map));
    for (const f of [p.implementationPlan, p.humanPlan, p.map]) out(shown(f));
  },
});

const map = define({
  name: 'plan map',
  group: 'Spec and TaskSet',
  summary: 'Write the dependency map, a self-contained HTML Gantt chart',
  description: `Writes .helix/plan/DependencyMap.html: every task and human task against time, the critical path highlighted.
It opens in any browser, with no app running; the app's Map is the live version.`,
  run({ root, out }) {
    const p = paths(root);
    atomicWrite(p.map, renderDependencyMap(currentMap(root)));
    out(shown(p.map));
  },
});

const tasksetShow = define({
  name: 'taskset',
  group: 'Spec and TaskSet',
  summary: 'Show the TaskSet: lanes, their epics in order, and how far each has got',
  json: true,
  run({ root, json, out }) {
    const p = paths(root);
    const plan = loadPlan(p.tasks, p.human);
    const ts = loadTaskSet(root, plan);
    const lanes = ts.lanes.map((l) => ({
      lane: l.name,
      epics: l.epics.map((e) => ({ key: e.key, title: e.title, tasks: e.tasks.length, done: e.tasks.filter((id) => plan.tasks.get(id)?.status === 'done').length })),
    }));
    if (json) return out(JSON.stringify({ derived: ts.derived, timelines: ts.timelines, stages: stagesOf(plan), lanes }, null, 2));
    if (ts.derived) out('No .helix/plan/taskset.yaml yet: epics are derived from each task\'s feature. `helix-loop taskset init` writes them down.\n');
    const stages = stagesOf(plan);
    if (stages.length) out(`Stages: ${stages.map((s) => stageTitle(plan, s)).join(' → ')}\n`);
    for (const l of lanes) {
      out(`${l.lane}  (${l.epics.reduce((n, e) => n + e.done, 0)} of ${l.epics.reduce((n, e) => n + e.tasks, 0)} done)`);
      for (const e of l.epics) out(`  ${`${e.done}/${e.tasks}`.padStart(7)}  ${e.title}  [${e.key}]`);
      out();
    }
    out(`Timelines shown: ${ts.timelines.join(' and ')}`);
  },
});

const tasksetInit = define({
  name: 'taskset init',
  group: 'Spec and TaskSet',
  summary: 'Write taskset.yaml for a plan that has none, one epic per lane and feature',
  description: `For a plan written before TaskSets: writes .helix/plan/taskset.yaml with its stages, both timelines, and one epic per lane and feature, and sets each task's epic.
Rename, split and merge the epics afterwards (keep each task's epic in step), or regroup the plan properly with the Helix skill and \`helix-loop taskset import\`.`,
  run({ root, out }) {
    if (readTaskSetFile(root)) throw new UsageError('.helix/plan/taskset.yaml exists already: edit it, or import a new TaskSet with `helix-loop taskset import`.');
    const p = paths(root);
    const plan = loadPlan(p.tasks, p.human);
    const { file, changed } = initTaskSet(root, plan);
    writeTaskSetFile(root, file);
    for (const t of changed) writeTask(p.tasks, t);
    const epics = Object.values(file.lanes).reduce((n, l) => n + Object.keys(l.epics).length, 0);
    out(`Wrote .helix/plan/taskset.yaml: ${Object.keys(file.lanes).length} lanes, ${epics} epics; set the epic of ${changed.length} tasks.`);
  },
});

const tasksetImport = define({
  name: 'taskset import',
  group: 'Spec and TaskSet',
  summary: 'Check a TaskSet from the Helix skill and bring it into the plan',
  description: `Takes a TaskSet folder (taskset.yaml, tasks/, human/, or a plan/ folder holding them) or a zip of one.
It is checked against the schemas and its dependency graph, then compared with the running plan: what it adds, what it removes (only tasks nobody has started), and the tasks it keeps as they are because they are merged, running or attempted.
Nothing is written without --apply (one commit) or --dry-run (into the dry run, to watch it with the fake agents first).`,
  args: [{ name: 'path', description: 'A TaskSet folder or a zip of one' }],
  options: {
    apply: { type: 'boolean', description: 'Write it into the plan, as one commit' },
    'dry-run': { type: 'boolean', description: 'Write it into a fresh dry run instead, to try it with the fake agents' },
  },
  examples: [
    ['helix-loop taskset import ~/Downloads/helix-taskset.zip', 'See what the TaskSet would change'],
    ['helix-loop taskset import ./taskset --apply', 'Bring it into the plan'],
  ],
  async run({ root, args, opts, out }) {
    return importTaskSet(root, args[0]!, { apply: opts.apply === true, dry: opts['dry-run'] === true }, out);
  },
});

async function importTaskSet(root: string, from: string, mode: { apply: boolean; dry: boolean }, out: (s?: string) => void): Promise<number> {
  const p = paths(root);
  if (!existsSync(from)) throw new UsageError(`No TaskSet at ${from}.`);
  let dir = from;
  if (from.endsWith('.zip')) {
    dir = mkdtempSync(join(tmpdir(), 'helix-taskset-'));
    execFileSync('unzip', ['-q', from, '-d', dir]);
  }
  // The folder may hold plan/ or be it; a skill's zip holds one more level.
  const base = [join(dir, 'plan'), dir, join(dir, 'helix', 'plan')].find((d) => existsSync(join(d, 'tasks')));
  if (!base) throw new UsageError(`${from} has no tasks/ folder.`);
  const incoming = loadPlan(join(base, 'tasks'), join(base, 'human'));
  const problems = [...validateSchemas(p.schema, join(base, 'tasks'), join(base, 'human')), ...validateGraph(incoming)];
  for (const x of problems) out(`${x.id}: ${x.message}`);
  if (problems.length) throw new UsageError(`The TaskSet doesn't validate: ${problems.length} problem${problems.length === 1 ? '' : 's'}.`);
  const current = loadPlan(p.tasks, p.human);
  const ts = loadTaskSet(root, current);
  const file = existsSync(join(base, 'taskset.yaml')) ? (parse(readFileSync(join(base, 'taskset.yaml'), 'utf8')) as Parameters<typeof diffTaskSet>[3]) : undefined;
  const { diff, plan } = diffTaskSet(current, incoming, new Set(ts.lanes.flatMap((l) => l.epics.map((e) => e.id))), file);
  const merged = validateGraph(plan);
  out(`+${diff.added.length} tasks${diff.epicsAdded.length ? ` in ${diff.epicsAdded.length} new epics` : ''}`);
  out(`~${diff.depsChanged.length} tasks with changed dependencies`);
  out(`-${diff.removed.length} tasks removed, none started`);
  if (diff.kept.length) out(`${diff.kept.length} merged, running or attempted tasks keep their state and notes`);
  out(`human tasks: +${diff.human.added.length}`);
  for (const x of merged) out(`after import, ${x.id}: ${x.message}`);
  if (merged.length) return 1;
  if (!mode.apply && !mode.dry) {
    out('Nothing written: --apply writes it into the plan, --dry-run into a dry run.');
    return 0;
  }
  const target = mode.dry ? prepareDryRun(root).root : root;
  const tp = paths(target);
  for (const id of diff.removed) rmSync(join(tp.tasks, `${id}.yaml`), { force: true });
  for (const t of plan.tasks.values()) writeTask(tp.tasks, t);
  for (const id of diff.human.added) cpSync(join(base, 'human', `${id}.yaml`), join(tp.human, `${id}.yaml`));
  if (file) writeTaskSetFile(target, file);
  if (mode.dry) {
    out(`Written into the dry run in ${shown(target)}. Start it with \`helix-loop run --dry-run\` or from the app.`);
    return 0;
  }
  const git = existsSync(join(root, '.git'));
  const n = (git ? Number(execFileSync('git', ['rev-list', '--count', 'HEAD', '--', relative(root, tasksetFile(root))], { cwd: root }).toString().trim()) : 0) + 1;
  const files = [tasksetFile(root), ...[...plan.tasks.keys(), ...diff.removed].map((id) => join(p.tasks, `${id}.yaml`)), ...diff.human.added.map((id) => join(p.human, `${id}.yaml`))].map((f) => relative(root, f));
  if (git) await commit(root, files.filter((f) => existsSync(join(root, f)) || diff.removed.some((id) => f.endsWith(`${id}.yaml`))), `Plan: import TaskSet rev ${n} (${ownerOf(root)}, in Helix Loop)`);
  out(`Imported: rev ${n}.`);
  return 0;
}

export const PLAN_COMMANDS = [specIndex, specSections, validate, render, map, tasksetShow, tasksetInit, tasksetImport];
