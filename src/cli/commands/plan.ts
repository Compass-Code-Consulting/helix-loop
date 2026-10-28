import { readFileSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { loadConfig, paths, projectInfo } from '../../config.ts';
import { renderDependencyMap } from '../../map/render.ts';
import { renderHumanPlan, renderImplementationPlan } from '../../plan/render.ts';
import { loadDeferred, loadSynthetic } from '../../plan/requirements.ts';
import { membership } from '../../plan/milestones.ts';
import { atomicWrite, loadPlan } from '../../plan/store.ts';
import { tasksByStory } from '../../plan/taskset.ts';
import { validateCoverage, validateGraph, validateHierarchy, validateMilestones, validatePrompts, validateReleaseHolds, validateRepos, validateSchemas, validateState, type Problem } from '../../plan/validate.ts';
import * as ops from '../../ops/index.ts';
import { withCli } from '../../ops/actor.ts';
import { loadIndex, writeIndex } from '../../spec/index.ts';
import { define, str, UsageError } from '../command.ts';
import { day, fit, plural, table, timeZone, wrap } from '../output.ts';
import { currentMap, shown, when } from '../shared.ts';

// The spec, the TaskSet and its milestones: indexing the spec, checking the plan, writing its documents, bringing a
// TaskSet written with the Helix skill into the project, and planning its delivery order with Helix Milestones.

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

export function validateProject(root: string): { problems: Problem[]; tasks: number; human: number } {
  const p = paths(root);
  const plan = loadPlan(p.tasks, p.human);
  const config = loadConfig(root);
  const index = loadIndex(p.specIndex);
  const problems = [
    ...validateSchemas(p.schema, p.tasks, p.human),
    ...validateHierarchy(plan, config.repos),
    ...validateMilestones(plan),
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
  summary: 'Check the plan: schemas, the TaskSet, the milestones, dependencies, coverage, prompt sizes, state',
  description: `Runs every check the loop runs before it starts: the TaskSet, its milestones, and each task and human task against their schemas; the hierarchy, Lane › Epic › Feature › Story › Task, with every task in a declared story of the lane that builds its repo; the milestones, which place every task exactly once, never make a task wait on a later milestone, and wire each placeholder in once; every dependency resolving with no cycles; each task's repo in the config; every requirement claimed by a task (or deferred); each task's prompt within its budget; and claim state that makes sense.
Warnings (a level outside its usual size, a milestone left empty) are printed but don't fail.
Exits 0 when the plan has no errors, 1 when it has.`,
  json: true,
  run({ root, json: asJson, out }) {
    const r = validateProject(root);
    const errors = r.problems.filter((x) => x.level !== 'warning').length;
    if (asJson) out(JSON.stringify(r, null, 2));
    else {
      for (const x of r.problems) out(`${x.id}: ${x.level === 'warning' ? 'warning: ' : ''}${x.message}`);
      out(`${r.tasks} tasks, ${r.human} human tasks, ${plural(errors, 'error')}, ${plural(r.problems.length - errors, 'warning')}`);
    }
    return errors ? 1 : 0;
  },
});

const render = define({
  name: 'plan render',
  group: 'Spec and TaskSet',
  summary: 'Write the Implementation Plan, the Human Implementation Plan and the dependency map',
  description: `Writes .helix/plan/ImplementationPlan.md (the milestones in delivery order, then Lane › Epic › Feature › Story › Task), HumanImplementationPlan.md (the steps only the owner can do, with start-by dates) and DependencyMap.html, from the plan as it stands.
The app and Helix run this after every plan change; never edit those files by hand.`,
  run({ root, out }) {
    const p = paths(root);
    const plan = loadPlan(p.tasks, p.human);
    const info = projectInfo(loadConfig(root));
    const map = currentMap(root);
    const synthetic = loadSynthetic(root).filter((s) => [...plan.tasks.values()].some((t) => t.reqs.includes(s.id)));
    const dates = new Map(ops.listMilestones(root).milestones.map((m) => [m.key, { at: m.at, reached: m.reached }]));
    atomicWrite(p.implementationPlan, renderImplementationPlan(plan, map, loadIndex(p.specIndex), synthetic, info, dates));
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

// ---- the TaskSet ----

const tasksetShow = define({
  name: 'taskset',
  group: 'Spec and TaskSet',
  summary: 'Show the TaskSet: Lane › Epic › Feature › Story, and how far each has got',
  description: `Lists the lanes, their epics and features, with the tasks done in each; --stories adds the stories.
--json gives the whole hierarchy, each story with its tasks and the stories it waits on (through its tasks' dependencies), which the Helix skill reads to plan milestones.`,
  options: { stories: { type: 'boolean', description: 'List the stories too' } },
  json: true,
  run({ root, json: asJson, opts, out }) {
    const p = paths(root);
    const plan = loadPlan(p.tasks, p.human);
    const ts = plan.taskset;
    if (!ts) throw new UsageError('No version 2 TaskSet in .helix/plan/taskset.yaml: run `helix-loop validate` to see why.');
    const byStory = tasksByStory(plan);
    const member = membership(plan);
    const storyOf = new Map([...plan.tasks.values()].map((t) => [t.id, t.story]));
    const count = (stories: string[]) => {
      const list = stories.flatMap((s) => byStory.get(s) ?? []);
      return { tasks: list.length, done: list.filter((t) => t.status === 'done').length };
    };
    const featureStories = (f: string) => ts.features.get(f)!.stories;
    const epicStories = (e: string) => ts.epics.get(e)!.features.flatMap(featureStories);
    const lanes = ts.lanes.map((l) => ({
      lane: l.key,
      repo: l.repo,
      ...count(l.epics.flatMap(epicStories)),
      epics: l.epics.map((ek) => {
        const e = ts.epics.get(ek)!;
        return {
          key: e.key, title: e.title, outcome: e.outcome, ...count(epicStories(ek)),
          features: e.features.map((fk) => {
            const f = ts.features.get(fk)!;
            return {
              key: f.key, title: f.title, ...(f.capability ? { capability: f.capability } : {}), ...count(f.stories),
              stories: f.stories.map((sk) => {
                const s = ts.stories.get(sk)!;
                const tasks = byStory.get(sk) ?? [];
                const waitsOn = [...new Set(tasks.flatMap((t) => t.blocked_by.map((d) => storyOf.get(d)).filter((x): x is string => !!x && x !== sk)))];
                return { key: s.key, title: s.title, need: s.need, ...count([sk]), taskIds: tasks.map((t) => t.id), waitsOn, milestones: [...new Set(tasks.map((t) => member.of.get(t.id)).filter(Boolean))] };
              }),
            };
          }),
        };
      }),
    }));
    if (asJson) return out(JSON.stringify({ revision: ts.revision, milestones: ts.milestonesFile ?? null, timelines: ts.timelines, lanes }, null, 2));
    out(`TaskSet revision ${ts.revision}: ${plural(ts.lanes.length, 'lane')}, ${plural(ts.epics.size, 'epic')}, ${plural(ts.features.size, 'feature')}, ${plural(ts.stories.size, 'story', 'stories')}, ${plural(plan.tasks.size, 'task')}`);
    out(ts.milestonesFile ? `Delivered in the order of .helix/plan/${ts.milestonesFile}: helix-loop milestones` : 'No milestones yet: plan them with the Helix skill (/helix milestones).');
    out();
    const done = (x: { done: number; tasks: number }) => `${x.done}/${x.tasks}`;
    for (const l of lanes) {
      out(`${l.lane}  (${l.repo}, ${l.done} of ${l.tasks} done)`);
      const row = (x: { done: number; tasks: number; title: string; key: string }, depth: number) => out(`${done(x).padStart(9)}  ${'  '.repeat(depth)}${fit(`${x.title}  [${x.key}]`, 86 - 2 * depth)}`);
      for (const e of l.epics) {
        row(e, 0);
        for (const f of e.features) {
          row(f, 1);
          if (opts.stories) for (const s of f.stories) row(s, 2);
        }
      }
      out();
    }
    out(`Timelines shown: ${ts.timelines.join(' and ')}`);
  },
});

const tasksetHistory = define({
  name: 'taskset history',
  group: 'Spec and TaskSet',
  summary: 'The TaskSet\'s revisions: when each became current, who made it and why',
  description: `Reads .helix/plan/history/index.yaml.
Each superseded revision is kept whole in .helix/plan/history/r<N>/: its taskset.yaml, milestones.yaml, tasks/ and human/ as they were when it was replaced.`,
  json: true,
  run({ root, json: asJson, out }) {
    const revisions = ops.tasksetHistory(root);
    if (asJson) return out(JSON.stringify(revisions, null, 2));
    const current = loadPlan(paths(root).tasks, paths(root).human).taskset?.revision;
    if (!revisions.length) return out(`No history yet: the TaskSet is at revision ${current ?? 1}${(current ?? 1) === 1 ? ', as first planned' : ''}. Applying milestones writes the next revision.`);
    const tz = timeZone(root);
    const rows = table(revisions.map((r) => [`r${r.revision}${r.revision === current ? ' •' : ''}`, day(Date.parse(r.date), tz), r.by, [plural(r.tasks, 'task'), r.placeholders ? plural(r.placeholders, 'placeholder') : '', r.wiring ? plural(r.wiring, 'wiring task') : ''].filter(Boolean).join(', '), r.snapshot ? `kept in .helix/plan/${r.snapshot}` : r.revision === current ? 'current' : '']));
    revisions.forEach((r, i) => {
      out(rows[i]);
      for (const l of wrap(r.why, 6)) out(l);
    });
  },
});

const tasksetImport = define({
  name: 'taskset import',
  group: 'Spec and TaskSet',
  summary: 'Check a TaskSet from the Helix skill and bring it into the plan',
  description: `Takes a TaskSet folder (taskset.yaml, tasks/, human/, and milestones.yaml when it has them; or a plan/ folder holding them) or a zip of one.
It is checked against the schemas, the hierarchy and its dependency graph, then compared with the running plan: what it adds, what it removes (only tasks nobody has started), and the tasks it keeps as they are because they are merged, running or attempted.
Applied, it becomes the TaskSet's next revision, and the one it replaces is kept in .helix/plan/history/.
A TaskSet without milestones.yaml leaves the plan without a delivery order until \`helix-loop milestones apply\`: the loop doesn't run until then.
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
    if (!existsSync(args[0]!)) throw new UsageError(`No TaskSet at ${args[0]}.`);
    const r = await ops.importTaskSet(root, args[0]!, { apply: opts.apply === true, dry: opts['dry-run'] === true, actor: withCli(root) });
    for (const x of r.problems) out(`${x.id}: ${x.message}`);
    if (r.problems.length) throw new UsageError(`The TaskSet doesn't validate: ${plural(r.problems.length, 'problem')}.`);
    const d = r.diff;
    out(`+${d.added.length} tasks${d.storiesAdded.length ? ` in ${plural(d.storiesAdded.length, 'new story', 'new stories')}` : ''}`);
    out(`~${d.depsChanged.length} tasks with changed dependencies`);
    out(`-${d.removed.length} tasks removed, none started`);
    if (d.kept.length) out(`${d.kept.length} merged, running or attempted tasks keep their state and notes`);
    out(`human tasks: +${d.human.added.length}`);
    for (const x of r.after) out(`after import, ${x.id}: ${x.message}`);
    if (r.after.length) return 1;
    if (r.dryRun) return out(`Written into the dry run in ${shown(r.dryRun)}. Start it with \`helix-loop run --dry-run\` or from the app.`);
    if (r.revision === undefined) return out('Nothing written: --apply writes it into the plan, --dry-run into a dry run.');
    out(`Imported as TaskSet revision ${r.revision}.${r.committed ? '' : ' (Not a git checkout: nothing committed.)'}`);
  },
});

// ---- Helix Milestones ----

const milestones = define({
  name: 'milestones',
  group: 'Spec and TaskSet',
  summary: 'The milestones in delivery order, with their progress and projected dates',
  description: `Lists Helix Milestones (.helix/plan/milestones.yaml): each named, demoable outcome, the tasks done of those in it, and when it was reached or is projected to be, at the slots the loop has now.
Milestones are a priority, not a gate: the loop prefers ready work in the earliest milestone not yet reached, and takes later work when nothing earlier is ready.`,
  json: true,
  run({ root, json: asJson, out }) {
    const r = ops.listMilestones(root);
    if (asJson) return out(JSON.stringify(r, null, 2));
    if (!r.milestones.length) return out('No milestones yet: plan them with the Helix skill (/helix milestones), then `helix-loop milestones apply <folder>`.');
    const tz = timeZone(root);
    out(`TaskSet revision ${r.revision ?? 1}: ${plural(r.milestones.length, 'milestone')}`);
    out();
    r.milestones.forEach((m, i) => {
      out(`${String(i + 1).padStart(2)}. ${m.reached ? '✓' : ' '} ${fit(m.title, 56).padEnd(56)}  ${`${m.done}/${m.tasks}`.padStart(7)}  ${m.at ? `${m.reached ? 'reached' : 'projected'} ${when(m.at, tz)}` : 'no date yet'}`);
      for (const l of wrap(`Demo: ${m.demo}`, 7)) out(l);
    });
    out();
    out(`${r.codeFinish !== undefined ? `Code complete ${when(r.codeFinish, tz)} · project` : 'Project'} complete ${when(r.finish, tz)}`);
  },
});

const milestonesCheck = define({
  name: 'milestones check',
  group: 'Spec and TaskSet',
  summary: 'Check a Milestones proposal, or the plan\'s own, listing every dependency that points forward',
  description: `Checks a proposal folder (milestones.yaml, with the tasks/ it adds or changes and a taskset.yaml when it moves stories) against the project's plan, or the plan's own milestones when no folder is given.
Every task must be in exactly one milestone, by its id, its story or its feature, most specific first.
No task may wait on a task in a later milestone: each such dependency is listed with the two ways to resolve it.
Pull it forward: name the dependency (and what it waits on in later milestones) in the same milestone or an earlier one.
Or build against a placeholder: the waiting task names the dependency in placeholder_for instead of blocked_by, its description and acceptance say what the placeholder does, and a wiring task (wires: [it], blocked_by: it and the dependency) goes in the dependency's milestone or later.
Exits 0 when the milestones would apply, 1 when they wouldn't.`,
  args: [{ name: 'folder', description: 'A Milestones proposal folder; the plan\'s own milestones when left out', optional: true }],
  examples: [
    ['helix-loop milestones check ./milestones', 'Check a proposal before applying it'],
    ['helix-loop milestones check --json', 'The plan\'s own milestones, as JSON'],
  ],
  json: true,
  run({ root, args, json: asJson, out }) {
    const r = ops.checkMilestones(root, args[0]);
    const errors = r.problems.filter((x) => x.level !== 'warning');
    if (asJson) {
      out(JSON.stringify(r, null, 2));
      return errors.length || r.forward.length ? 1 : 0;
    }
    const title = new Map(r.milestones.map((m, i) => [m.key, `${i + 1}. ${m.title}`]));
    out(`${shown(r.source)}: ${plural(r.milestones.length, 'milestone')}`);
    for (const m of r.milestones) out(`  ${fit(title.get(m.key)!, 70).padEnd(70)}  ${plural(m.tasks, 'task')}`);
    out();
    if (r.forward.length) {
      out(`${plural(r.forward.length, 'dependency', 'dependencies')} point${r.forward.length === 1 ? 's' : ''} forward:`);
      for (const f of r.forward) {
        out(`  ${f.task} (${title.get(f.at)}) waits on ${f.dep} (${title.get(f.depAt)})`);
        const others = f.pull.filter((id) => id !== f.dep);
        for (const l of wrap(`a. Pull it forward: name ${f.dep}${others.length ? `, with ${others.join(', ')} it waits on,` : ''} in ${f.at} or earlier.`, 4)) out(l);
        for (const l of wrap(`b. Placeholder: ${f.task} takes placeholder_for: [${f.dep}] instead of waiting on it, and its description and acceptance say what stands in; a new wiring task (wires: [${f.task}], blocked_by: [${f.task}, ${f.dep}]) goes in ${f.depAt} or later.`, 4)) out(l);
      }
      out();
    }
    for (const x of r.problems) out(`${x.id}: ${x.level === 'warning' ? 'warning: ' : ''}${x.message}`);
    out(errors.length || r.forward.length ? `They don't apply yet: ${plural(r.forward.length, 'forward dependency', 'forward dependencies')}, ${plural(errors.length, 'other problem')}.` : `They apply${args[0] ? `: helix-loop milestones apply ${args[0]}` : ''}.`);
    return errors.length || r.forward.length ? 1 : 0;
  },
});

const milestonesApply = define({
  name: 'milestones apply',
  group: 'Spec and TaskSet',
  summary: 'Apply a Milestones proposal: the TaskSet\'s next revision, the old one kept in history',
  description: `Checks the proposal as \`helix-loop milestones check\` does; nothing is written while anything is wrong.
Then the TaskSet as it stands (taskset.yaml, tasks/, human/) is kept in .helix/plan/history/r<N>/, never edited again, and revision N+1 is written in place: the milestones, the tasks the proposal changes (placeholders) and adds (wiring tasks), and an entry in .helix/plan/history/index.yaml, as one commit.
A running loop takes the new revision on its next round.`,
  args: [{ name: 'folder', description: 'The proposal: milestones.yaml, and the tasks/ (and taskset.yaml) it brings' }],
  options: { why: { type: 'string', value: 'text', description: 'Why, for the history (default: the milestones and placeholders it adds)' } },
  examples: [['helix-loop milestones apply ./milestones', 'Apply the proposal the Helix skill wrote']],
  async run({ root, args, opts, out }) {
    const r = await ops.applyMilestones(root, args[0]!, { why: str(opts, 'why'), actor: withCli(root) });
    out(`TaskSet revision ${r.revision}${r.snapshot ? `; revision ${r.revision - 1} is kept in .helix/plan/${r.snapshot}` : ''}.`);
    if (r.added.length || r.changed.length) out(`${plural(r.added.length, 'task')} added, ${plural(r.changed.length, 'task')} changed${r.placeholders ? `: ${plural(r.placeholders, 'placeholder')}, ${plural(r.wiring, 'wiring task')}` : ''}.`);
    if (!r.committed) out('(Not a git checkout: nothing committed.)');
  },
});

export const PLAN_COMMANDS = [specIndex, specSections, validate, render, map, tasksetShow, tasksetHistory, tasksetImport, milestones, milestonesCheck, milestonesApply];
