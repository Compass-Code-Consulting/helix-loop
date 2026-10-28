import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { parse, stringify } from 'yaml';
import { buildBoard } from '../src/app/board.ts';
import { snapshot } from '../src/app/state.ts';
import { buildView } from '../src/app/views.ts';
import { main } from '../src/cli/main.ts';
import { configPath, loadConfig, paths, projectInfo } from '../src/config.ts';
import type { LedgerEvent } from '../src/ledger.ts';
import { computeMap, rankTasks } from '../src/map/graph.ts';
import { forwardDeps, isReached, membership, reachedBy } from '../src/plan/milestones.ts';
import { renderImplementationPlan } from '../src/plan/render.ts';
import { loadPlan } from '../src/plan/store.ts';
import { MIGRATE_V1, readTaskSet, trailOf } from '../src/plan/taskset.ts';
import { validateHierarchy, validateMilestones, validateSchemas } from '../src/plan/validate.ts';
import { loadIndex } from '../src/spec/index.ts';
import type { MilestoneDef, Plan, Task } from '../src/types.ts';
import { FIXTURE } from './fixture.ts';
import { planOf, storyOf } from './plans.ts';

// Plan format v2 (FORMAT.md, 2026-10-27): the TaskSet's hierarchy, Helix Milestones and their invariant, placeholders
// and wiring, the order the loop takes work in, revisions, and the commands and documents that show them. Most run on
// the Acme fixture, whose plan is at revision 2: revision 1 and the milestones applied over it, with one placeholder.

const fixture = () => loadPlan(paths(FIXTURE).tasks, paths(FIXTURE).human);
const messages = (problems: { id: string; message: string }[]) => problems.map((p) => `${p.id}: ${p.message}`);

function task(id: string, over: Partial<Task> = {}): Task {
  return {
    id, repo: 'acme-app', area: `area-${id.toLowerCase()}`, title: `Task ${id} title`, reqs: ['PB-14'], spec: ['§11 Requirements'],
    acceptance: [`unit: [PB-14] behaviour of ${id}`], blocked_by: [], estimate_passes: 1, status: 'ready', claimed_by: null, attempts: [],
    ...over, story: over.story ?? storyOf(over.repo ?? 'acme-app'),
  };
}
const milestone = (key: string, over: Partial<MilestoneDef> = {}): MilestoneDef => ({ key, title: `Milestone ${key}`, demo: `What ${key} shows works.`, features: [], stories: [], tasks: [], ...over });

test('applying milestones records those already reached, which stay reached when a fix is filed into them later', async () => {
  const root = project({ revision1: true });
  const p = paths(root);
  assert.equal((await cli(root, 'milestones', 'apply', proposal())).code, 0);
  const recorded = (readFileSync(p.ledger, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) as LedgerEvent[]).filter((e) => e.kind === 'milestone');
  assert.deepEqual(recorded.map((e) => [e.key, e.already, e.repos]), [['walking-skeleton', true, []]]);
  // Reached before it existed: nothing to review on Home.
  assert.deepEqual(buildView(root, snapshot(root), loadConfig(root), { dismissed: new Set() }).groups.filter((g) => g.kind === 'milestone'), []);
  // A fix filed into its story later is follow-up work: the milestone stays reached, dated when it was.
  const story = loadPlan(p.tasks, p.human).tasks.get('T-0001')!.story;
  writeFileSync(join(p.tasks, 'T-0090.yaml'), stringify(task('T-0090', { story, fix_first: true })));
  const plan = loadPlan(p.tasks, p.human);
  assert.equal(isReached(plan, 'walking-skeleton'), false, 'by its tasks alone it would not be');
  const board = buildBoard({ plan, events: readFileSync(p.ledger, 'utf8').trim().split('\n').map((l) => JSON.parse(l)), agents: [], running: [], config: loadConfig(root), now: Date.now() });
  const skeleton = board.milestones.find((m) => m.key === 'walking-skeleton')!;
  assert.deepEqual([skeleton.reached, skeleton.done, skeleton.tasks.length, skeleton.at], [true, 7, 8, Date.parse(recorded[0]!.at)]);
});

test('notes in a proposal replace the task notes, saying what a placeholder stands in for; a proposal without notes keeps them', async () => {
  const root = project({ revision1: true });
  const p = paths(root);
  const dir = proposal();
  const file = join(dir, 'tasks', 'T-0014.yaml');
  writeFileSync(file, stringify({ ...parse(readFileSync(file, 'utf8')), notes: 'Stand in for the job queue: unpublish in the request.' }));
  writeFileSync(join(p.tasks, 'T-0015.yaml'), stringify({ ...parse(readFileSync(join(p.tasks, 'T-0015.yaml'), 'utf8')), notes: 'Kept by the owner.' }));
  const t15 = join(dir, 'tasks', 'T-0015.yaml');
  const { notes: _drop, ...without } = parse(readFileSync(join(p.tasks, 'T-0015.yaml'), 'utf8'));
  writeFileSync(t15, stringify({ ...without, title: 'An Unpublish button on the note, with a confirmation' }));
  assert.equal((await cli(root, 'milestones', 'apply', dir)).code, 0);
  const plan = loadPlan(p.tasks, p.human);
  assert.equal(plan.tasks.get('T-0014')!.notes, 'Stand in for the job queue: unpublish in the request.');
  assert.equal(plan.tasks.get('T-0015')!.notes, 'Kept by the owner.');
});

test('milestones apply --dry-run writes the revision into a fresh dry run and leaves the plan alone; options may lead the command', async () => {
  const root = project({ revision1: true });
  const p = paths(root);
  const head = () => execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root }).toString().trim();
  const was = head();
  const out: string[] = [];
  const code = await main(['--root', root, 'milestones', 'apply', proposal(), '--dry-run'], { out: (s = '') => void out.push(s), err: (s) => void out.push(s) });
  assert.equal(code, 0, out.join('\n'));
  assert.match(out[0]!, /^In the dry run \(.+\), not the plan: see it with `helix-loop milestones --root .+` or the app's Dry run\.$/);
  assert.equal(head(), was);
  assert.equal(loadPlan(p.tasks, p.human).taskset!.revision, 1);
  const dry = paths(p.dryRun);
  assert.equal(loadPlan(dry.tasks, dry.human).taskset!.revision, 2);
  assert.deepEqual(validateMilestones(loadPlan(dry.tasks, dry.human)), []);
});

// A copy of the fixture project, as a git checkout, at revision 1 (the TaskSet before milestones) when asked.
function project(o: { revision1?: boolean } = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'helix-ms-'));
  cpSync(paths(FIXTURE).home, paths(root).home, { recursive: true });
  const p = paths(root);
  if (o.revision1) {
    for (const part of ['taskset.yaml', 'tasks', 'human']) rmSync(join(p.plan, part), { recursive: true, force: true });
    cpSync(join(p.history, 'r1'), p.plan, { recursive: true });
    rmSync(p.history, { recursive: true });
    rmSync(p.milestones);
  }
  writeFileSync(configPath(root), stringify({ ...loadConfig(FIXTURE), root: undefined, push: false }));
  writeFileSync(join(root, '.gitignore'), '.helix/runs/\n');
  const g = (...a: string[]) => execFileSync('git', a, { cwd: root, stdio: 'pipe' });
  g('init', '-q', '-b', 'main');
  g('-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '-A');
  g('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'seed');
  return root;
}

// The proposal that made the fixture's revision 2: its milestones, the placeholder task and its wiring task.
function proposal(): string {
  const dir = mkdtempSync(join(tmpdir(), 'helix-proposal-'));
  const p = paths(FIXTURE);
  mkdirSync(join(dir, 'tasks'));
  writeFileSync(join(dir, 'milestones.yaml'), readFileSync(p.milestones, 'utf8'));
  for (const id of ['T-0014', 'T-0024']) cpSync(join(p.tasks, `${id}.yaml`), join(dir, 'tasks', `${id}.yaml`));
  return dir;
}

async function cli(root: string, ...argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main([...argv, '--root', root], { out: (s = '') => void out.push(s), err: (s) => void err.push(s) });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

// ---- the TaskSet ----

test('the fixture reads as Lane › Epic › Feature › Story, and a task finds its place through its story', () => {
  const plan = fixture();
  const ts = plan.taskset!;
  assert.equal(ts.revision, 2);
  assert.equal(ts.milestonesFile, 'milestones.yaml');
  assert.deepEqual(ts.lanes.map((l) => [l.key, l.repo]), [['app', 'acme-app'], ['website', 'acme-website'], ['docs', 'acme-docs']]);
  assert.deepEqual([ts.epics.size, ts.features.size, ts.stories.size, plan.tasks.size], [4, 9, 19, 40]);
  const t = trailOf(ts, plan.tasks.get('T-0014')!.story);
  assert.deepEqual([t.lane?.key, t.epic?.key, t.feature?.key, t.story?.key], ['app', 'public-pages', 'publishing', 'unpublish-note']);
  assert.deepEqual(trailOf(ts, 'no-such-story'), {});
});

test('a version 1 TaskSet is one error that points to the migration, not a schema error on every task', () => {
  const root = mkdtempSync(join(tmpdir(), 'helix-v1-'));
  const p = paths(root);
  mkdirSync(p.tasks, { recursive: true });
  mkdirSync(p.human, { recursive: true });
  writeFileSync(p.taskset, stringify({ version: 1, stages: [{ key: 'day0', title: 'Day 0: Skeleton' }], lanes: { 'acme-app': { repo: 'acme-app', epics: { core: { title: 'The core', stage: 'day0' } } } } }));
  for (const id of ['T-0001', 'T-0002']) {
    const { story: _s, ...v1 } = task(id);
    writeFileSync(join(p.tasks, `${id}.yaml`), stringify({ ...v1, stage: 'day0', epic: 'core', feature: 'The core' }));
  }
  assert.deepEqual(readTaskSet(p.plan).problems, [MIGRATE_V1]);
  const problems = validateSchemas(paths(FIXTURE).schema, p.tasks, p.human);
  assert.deepEqual(messages(problems), [`taskset.yaml: ${MIGRATE_V1}`]);
  assert.match(MIGRATE_V1, /docs\/migrating\.md/);
  // Tasks still in the old shape under a version 2 TaskSet: one line for them all.
  writeFileSync(p.taskset, readFileSync(paths(FIXTURE).taskset, 'utf8'));
  rmSync(p.milestones, { force: true });
  const mixed = messages(validateSchemas(paths(FIXTURE).schema, p.tasks, p.human));
  assert.ok(mixed.some((m) => /^taskset\.yaml: 2 tasks still name `epic`, `stage` or `feature`/.test(m)), mixed.join('\n'));
  assert.ok(mixed.every((m) => !/additional property 'stage'/.test(m)), mixed.join('\n'));
  // A plan the loop can't place is one the app still reads.
  assert.equal(loadPlan(p.tasks, p.human).tasks.size, 2);
});

test('keys are unique at their level across the whole TaskSet', () => {
  const dir = mkdtempSync(join(tmpdir(), 'helix-dup-'));
  const file = parse(readFileSync(paths(FIXTURE).taskset, 'utf8'));
  file.lanes.docs.epics['help-centre'].features['publishing-guides'].stories['find-notes'] = { title: 'Find the guides', need: 'As a member, I want to find guides, so that I learn.' };
  writeFileSync(join(dir, 'taskset.yaml'), stringify(file));
  assert.deepEqual(readTaskSet(dir).problems, ['story find-notes is declared twice (again in feature publishing-guides); keys are unique across the TaskSet']);
});

test('validate: every task in a declared story of its repo\'s lane, every level with children, no "Day N", sizes as warnings', () => {
  const base = fixture();
  assert.deepEqual(validateHierarchy(base, loadConfig(FIXTURE).repos), []);
  const plan: Plan = structuredClone(base);
  plan.tasks.get('T-0001')!.story = 'no-such-story';
  plan.tasks.get('T-0025')!.story = 'write-a-note'; // a website task in the app's lane
  plan.tasks.get('T-0026')!.title = 'Day 2: the home page explains Acme Notes';
  plan.taskset!.stories.get('copy-link')!.title = 'Day-3 copy link';
  plan.taskset!.features.get('sharing')!.stories.push('empty-story');
  plan.taskset!.stories.set('empty-story', { key: 'empty-story', title: 'A story nobody built', need: '', feature: 'sharing', epic: 'public-pages', lane: 'app' });
  plan.taskset!.epics.get('public-pages')!.features.push('empty-feature');
  plan.taskset!.features.set('empty-feature', { key: 'empty-feature', title: 'A feature with nothing', epic: 'public-pages', lane: 'app', stories: [] });
  plan.taskset!.lanes.push({ key: 'support', repo: 'acme-helpdesk', epics: [] });
  plan.human.get('HT-2')!.story = 'no-such-story';
  const p = messages(validateHierarchy(plan, loadConfig(FIXTURE).repos).filter((x) => x.level !== 'warning'));
  for (const want of [
    'T-0001: story no-such-story is not declared in taskset.yaml',
    'T-0025: builds acme-website, but its story write-a-note is in lane app, which builds acme-app',
    'T-0026: "Day 2: the home page explains Acme Notes" says "Day N": name the outcome; the order is the milestones\'',
    'copy-link: "Day-3 copy link" says "Day N": name the outcome; the order is the milestones\'',
    'empty-story: story has no tasks',
    'empty-feature: feature has no stories',
    'support: lane builds repo acme-helpdesk, which is not under repos in the config (acme-app, acme-website, acme-docs, acme-support)',
    'support: lane has no epics',
    'HT-2: story no-such-story is not declared in taskset.yaml',
  ]) assert.ok(p.includes(want), `${want}\n— not in —\n${p.join('\n')}`);
  // Sizes: a story with one task, a feature with seven stories.
  const warnings = messages(validateHierarchy(plan).filter((x) => x.level === 'warning'));
  assert.ok(warnings.includes('learn-the-product: story has 1 task; 2–8 is the usual size'), warnings.join('\n'));
  assert.ok(!/stage|epic \w+ is not declared/.test(p.join('\n')));
});

// ---- membership and the invariant ----

test('membership resolves most specific first: a task by its id, then its story, then its feature', () => {
  const plan = fixture();
  const m = membership(plan);
  assert.equal(m.of.get('T-0025'), 'walking-skeleton', 'named by id, though its feature is in the last milestone');
  assert.equal(m.of.get('T-0026'), 'website-and-help', 'by its feature');
  assert.equal(m.of.get('T-0024'), 'reliable-jobs', 'the wiring task, named by id, away from its story\'s feature');
  assert.equal(m.of.get('T-0014'), 'publish-a-page');
  assert.deepEqual([m.unplaced, m.ambiguous], [[], []]);
  assert.deepEqual([...m.tasks.values()].map((ids) => ids.length), [7, 6, 8, 5, 14]);
  // A story beats its feature; the same level twice is ambiguous; a task nothing names is unplaced.
  const moved: Plan = { ...plan, milestones: [...plan.milestones!.slice(0, 1).map((x) => ({ ...x, stories: ['copy-link'] })), ...plan.milestones!.slice(1)] };
  assert.equal(membership(moved).of.get('T-0020'), 'walking-skeleton');
  const twice: Plan = { ...plan, milestones: plan.milestones!.map((x, i) => (i === 1 ? { ...x, features: [...x.features, 'sharing'] } : i === 4 ? { ...x, features: x.features.filter((f) => f !== 'pricing') } : x)) };
  const t = membership(twice);
  assert.deepEqual(t.ambiguous.find((a) => a.task === 'T-0020'), { task: 'T-0020', by: 'feature', milestones: ['write-and-find', 'publish-a-page'] });
  assert.deepEqual(t.unplaced, ['T-0029', 'T-0030', 'T-0031', 'T-0032']);
  const v = messages(validateMilestones(twice));
  assert.ok(v.includes('T-0020: is in 2 milestones by its feature (write-and-find, publish-a-page); name it in one'), v.join('\n'));
  assert.ok(v.includes('T-0029: is in no milestone: name its feature, its story (compare-plans) or the task itself in milestones.yaml'), v.join('\n'));
});

test('no task waits on a later milestone: each such dependency is an error, with what pulling it forward takes along', () => {
  const plan = planOf(
    [task('T-0001'), task('T-0002', { blocked_by: ['T-0003'] }), task('T-0003', { blocked_by: ['T-0004'] }), task('T-0004'), task('T-0005', { blocked_by: ['T-0001'] })],
    [],
    { 'T-0003': 'second', 'T-0004': 'third', 'T-0005': 'third' },
  );
  const f = forwardDeps(plan);
  assert.deepEqual(f.map((x) => [x.task, x.dep, x.at, x.depAt, x.pull]), [
    ['T-0002', 'T-0003', 'first', 'second', ['T-0003', 'T-0004']],
    ['T-0003', 'T-0004', 'second', 'third', ['T-0004']],
  ]);
  const p = messages(validateMilestones(plan));
  assert.ok(p[0]!.startsWith('T-0002: waits on T-0003, which is in a later milestone (Milestone second, after The first milestone): pull T-0003 forward, or build T-0002 against a placeholder (placeholder_for: [T-0003])'), p.join('\n'));
  assert.equal(validateMilestones(plan, { forward: false }).length, 0, 'the check lists them apart');
});

test('a placeholder has exactly one wiring task, blocked by it and what it stands in for, in their milestone or later', () => {
  const ok = fixture();
  assert.deepEqual(validateMilestones(ok), []);
  const t14 = ok.tasks.get('T-0014')!;
  assert.deepEqual([t14.placeholder_for, t14.blocked_by], [['T-0016'], ['T-0012']]);
  const broken = (edit: (p: Plan) => void) => {
    const p = structuredClone(ok);
    edit(p);
    return messages(validateMilestones(p));
  };
  assert.deepEqual(broken((p) => p.tasks.delete('T-0024')), ['reliable-jobs: names task T-0024, which does not exist', 'T-0014: builds against a placeholder for T-0016, but no task wires it in: add a task with wires: [T-0014]']);
  assert.ok(broken((p) => p.tasks.set('T-0041', { ...p.tasks.get('T-0024')!, id: 'T-0041' })).includes('T-0014: is wired by 2 tasks (T-0024, T-0041); one wiring task replaces its placeholder'));
  assert.deepEqual(broken((p) => (p.tasks.get('T-0024')!.blocked_by = ['T-0014'])), ['T-0024: wires T-0014, so it is blocked_by T-0014, T-0016; add T-0016']);
  assert.ok(broken((p) => p.tasks.get('T-0014')!.blocked_by.push('T-0016')).includes('T-0014: placeholder_for T-0016, but also blocked_by it: a placeholder means it doesn\'t wait'));
  assert.deepEqual(broken((p) => (p.tasks.get('T-0024')!.wires = ['T-0013'])), ['T-0014: builds against a placeholder for T-0016, but no task wires it in: add a task with wires: [T-0014]', 'T-0024: wires T-0013, which has no placeholder_for']);
  // The wiring task moved before what it waits for: the invariant and the wiring rule both say so.
  const early = broken((p) => (p.milestones![3]!.tasks = [], p.milestones![2]!.tasks = ['T-0024']));
  assert.ok(early.some((m) => m.startsWith('T-0024: waits on T-0016, which is in a later milestone')), early.join('\n'));
  assert.ok(early.includes('T-0024: wires T-0014, but T-0016 is in a later milestone: a wiring task goes in its dependencies\' milestone or later'), early.join('\n'));
});

test('milestones are required, name only what the TaskSet declares, and never say "Day N"', () => {
  const plan = fixture();
  assert.deepEqual(messages(validateMilestones({ ...plan, milestones: undefined })), ['milestones.yaml: missing: plan the delivery order with the Helix skill (/helix milestones), then apply it with `helix-loop milestones apply <folder>`; the loop runs only a plan with milestones']);
  const bad = messages(validateMilestones({ ...plan, milestones: [milestone('day-1', { title: 'Day 1: the skeleton', features: ['app-shell', 'no-feature'], stories: ['no-story'], tasks: ['T-9999'] }), ...plan.milestones!] }));
  for (const want of ['day-1: milestone "Day 1: the skeleton" says "Day N": name the outcome someone can see', 'day-1: names feature no-feature, which taskset.yaml doesn\'t declare', 'day-1: names story no-story, which taskset.yaml doesn\'t declare', 'day-1: names task T-9999, which does not exist']) assert.ok(bad.includes(want), `${want}\n${bad.join('\n')}`);
});

test('a milestone is reached when every task in it is done, by the merge that finishes it', () => {
  const plan = fixture();
  assert.equal(isReached(plan, 'walking-skeleton'), true);
  assert.equal(isReached(plan, 'write-and-find'), false);
  assert.equal(reachedBy(plan, 'T-0001')?.key, 'walking-skeleton');
  for (const id of ['T-0007', 'T-0009', 'T-0010']) plan.tasks.get(id)!.status = 'done';
  assert.equal(reachedBy(plan, 'T-0010'), undefined, 'T-0011 is still open');
  plan.tasks.get('T-0011')!.status = 'done';
  assert.equal(reachedBy(plan, 'T-0011')?.title, 'A team writes and finds its notes');
});

test('the loop ranks ready work fix-first, then by the earliest milestone not reached, then by the critical path', () => {
  const plan = fixture();
  const rank = rankTasks(computeMap(plan, { now: 0, passHours: 1, agents: [], mode: 'idle' }), plan);
  const open = rank.filter((id) => plan.tasks.get(id)!.status !== 'done');
  const m = membership(plan);
  const order = open.map((id) => m.index.get(m.of.get(id)!)!);
  assert.deepEqual(order, [...order].sort((a, b) => a - b), 'never a later milestone before an earlier one');
  // A fix filed in the last milestone goes first.
  plan.tasks.set('T-0041', { ...plan.tasks.get('T-0040')!, id: 'T-0041', priority: 'fix_first', blocked_by: [] });
  assert.equal(rankTasks(computeMap(plan, { now: 0, passHours: 1, agents: [], mode: 'idle' }), plan)[0], 'T-0041');
});

test('the board dates each milestone: when it was reached, or when it is projected to be', () => {
  const plan = fixture();
  const now = Date.parse('2026-10-27T18:00:00Z');
  const board = buildBoard({ plan, events: [] as LedgerEvent[], agents: [], running: [], config: loadConfig(FIXTURE), now });
  const [skeleton, notes, ...rest] = board.milestones;
  assert.deepEqual([skeleton!.reached, skeleton!.done, skeleton!.tasks.length, skeleton!.at], [true, 7, 7, Date.parse('2026-10-25T16:00:00Z')]);
  assert.equal(notes!.reached, false);
  assert.ok(notes!.at! > now);
  for (const m of rest) assert.ok(m.at! >= notes!.at! || m.key === 'reliable-jobs', `${m.key} is projected after the notes`);
  assert.ok(board.milestones.at(-1)!.at! <= board.finish);
  // Every task under its story's item; the items in reading order, lane first.
  assert.deepEqual(board.items.slice(0, 4).map((i) => i.id), ['lane:app', 'epic:team-notes', 'feature:app-shell', 'story:sign-in-with-code']);
  assert.equal(board.tasks.find((t) => t.id === 'T-0014')!.story, 'story:unpublish-note');
  assert.deepEqual(board.tasks.find((t) => t.id === 'T-0024')!.wires, ['T-0014']);
});

// ---- revisions ----

test('applying milestones keeps revision 1 in history/r1/, writes revision 2 in place and records it, as one commit', async () => {
  const root = project({ revision1: true });
  const p = paths(root);
  const before = readFileSync(p.taskset, 'utf8');
  assert.equal(loadPlan(p.tasks, p.human).taskset!.revision, 1);
  assert.match(messages(validateMilestones(loadPlan(p.tasks, p.human))).join(), /milestones\.yaml: missing/);
  const r = await cli(root, 'milestones', 'apply', proposal(), '--why', 'Delivery order planned');
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^TaskSet revision 2; revision 1 is kept in \.helix\/plan\/history\/r1\/\.\n1 task added, 1 task changed: 1 placeholder, 1 wiring task\.$/);
  // The snapshot is revision 1 as it was; the live TaskSet keeps the planner's comments, with its new revision and milestones.
  assert.equal(readFileSync(join(p.history, 'r1', 'taskset.yaml'), 'utf8'), before);
  assert.equal(readdirSync(join(p.history, 'r1', 'tasks')).length, 39);
  const after = readFileSync(p.taskset, 'utf8');
  assert.match(after, /^# The test project's Helix TaskSet[^\n]*\nversion: 2\nrevision: 2\nmilestones: milestones\.yaml\ntimelines: \[code, project\]\n/);
  const history = parse(readFileSync(join(p.history, 'index.yaml'), 'utf8')).revisions;
  assert.deepEqual(history.map((x: { revision: number; why: string; tasks: number; snapshot?: string; placeholders?: number; wiring?: number }) => [x.revision, x.why, x.tasks, x.snapshot, x.placeholders, x.wiring]), [
    [1, 'The TaskSet as first planned', 39, 'history/r1/', undefined, undefined],
    [2, 'Delivery order planned', 40, undefined, 1, 1],
  ]);
  const plan = loadPlan(p.tasks, p.human);
  assert.deepEqual(validateMilestones(plan), []);
  assert.deepEqual(plan.tasks.get('T-0014')!.placeholder_for, ['T-0016']);
  const git = (...a: string[]) => execFileSync('git', a, { cwd: root }).toString().trim();
  assert.equal(git('log', '-1', '--format=%s'), 'Plan: TaskSet revision 2: delivery order planned (Sam, with helix-loop)');
  // Everything it wrote is in the commit; the dependency map is re-rendered, and committed only when a milestone is reached.
  assert.equal(git('status', '--porcelain'), '?? .helix/plan/DependencyMap.html');
  // The history, as the CLI shows it.
  const h = await cli(root, 'taskset', 'history');
  assert.match(h.out, /^r1 {4}\S+, \S+ \d+ {2}Sam {2}39 tasks {2,}kept in \.helix\/plan\/history\/r1\/\n {6}The TaskSet as first planned\nr2 • .*40 tasks, 1 placeholder, 1 wiring task {2}current\n {6}Delivery order planned$/);
});

test('a proposal that doesn\'t apply writes nothing: forward dependencies, a stale revision, a merged task changed', async () => {
  const root = project({ revision1: true });
  const p = paths(root);
  const head = () => execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root }).toString().trim();
  const was = head();
  // Without the placeholder, T-0014 waits on T-0016 in a later milestone.
  const bare = proposal();
  rmSync(join(bare, 'tasks'), { recursive: true });
  writeFileSync(join(bare, 'milestones.yaml'), readFileSync(join(bare, 'milestones.yaml'), 'utf8').replace('    tasks: [T-0024]\n', ''));
  const check = await cli(root, 'milestones', 'check', bare);
  assert.equal(check.code, 1);
  assert.match(check.out, /1 dependency points forward:\n {2}T-0014 \(3\. A member publishes a note as a public page\) waits on T-0016 \(4\. Publishing runs on jobs that retry and act once\)\n {4}a\. Pull it forward: name T-0016 in publish-a-page or earlier\.\n {4}b\. Placeholder: T-0014 takes placeholder_for: \[T-0016\] instead of waiting on it/);
  const json = JSON.parse((await cli(root, 'milestones', 'check', bare, '--json')).out);
  assert.deepEqual(json.forward.map((f: { task: string; dep: string }) => [f.task, f.dep]), [['T-0014', 'T-0016']]);
  const refused = await cli(root, 'milestones', 'apply', bare);
  assert.equal(refused.code, 1);
  assert.match(refused.err, /The milestones don't apply: 1 problem\.\nT-0014: waits on T-0016, which is in a later milestone/);
  assert.equal(head(), was);
  assert.ok(!existsSync(p.history) && !existsSync(p.milestones), 'nothing written');
  // The real proposal checks clean; once applied, applying it again is planned against a revision that has gone.
  assert.match((await cli(root, 'milestones', 'check', proposal())).out, /They apply: helix-loop milestones apply /);
  assert.equal((await cli(root, 'milestones', 'apply', proposal())).code, 0);
  const again = await cli(root, 'milestones', 'apply', proposal());
  assert.match(again.err, /milestones\.yaml: planned against TaskSet revision 1, but the TaskSet is at revision 2/);
  // A merged task is the loop's: a proposal may not rewrite it.
  const merged = proposal();
  writeFileSync(join(merged, 'milestones.yaml'), readFileSync(p.milestones, 'utf8').replace('taskset_revision: 1', 'taskset_revision: 2'));
  writeFileSync(join(merged, 'tasks', 'T-0001.yaml'), readFileSync(join(p.tasks, 'T-0001.yaml'), 'utf8').replace(/^title: .*$/m, 'title: A new title for done work'));
  assert.match((await cli(root, 'milestones', 'check', merged)).out, /T-0001: is merged; the Milestones step can't change it/);
});

test('helix-loop milestones lists each with its progress and date; taskset --json gives each story\'s dependencies', async () => {
  const root = project();
  const list = await cli(root, 'milestones');
  assert.equal(list.code, 0, list.err);
  assert.match(list.out, /^TaskSet revision 2: 5 milestones\n\n {1}1\. ✓ The app builds, deploys and signs a person in +7\/7 {2}reached /);
  assert.match(list.out, /\n {1}2\. {3}A team writes and finds its notes +2\/6 {2}projected /);
  assert.match(list.out, /\n {7}Demo: Publish a note, open its link in a private window/);
  assert.ok(!/day \d/i.test(list.out));
  const ts = JSON.parse((await cli(root, 'taskset', '--json')).out);
  const unpublish = ts.lanes[0].epics[1].features[0].stories[1];
  assert.deepEqual([unpublish.key, unpublish.taskIds, unpublish.waitsOn, unpublish.milestones], ['unpublish-note', ['T-0014', 'T-0015', 'T-0024'], ['publish-own-note', 'write-a-note', 'jobs-retry'], ['publish-a-page', 'reliable-jobs']]);
  const tasks = await cli(root, 'tasks', '--milestone', 'reliable-jobs', '--json');
  assert.deepEqual(JSON.parse(tasks.out).map((t: { id: string }) => t.id), ['T-0016', 'T-0017', 'T-0018', 'T-0019', 'T-0024']);
  const under = JSON.parse((await cli(root, 'tasks', '--under', 'sharing', '--all', '--json')).out);
  assert.deepEqual(under.map((t: { id: string; feature: string }) => [t.id, t.feature]), [['T-0020', 'sharing'], ['T-0021', 'sharing'], ['T-0022', 'sharing'], ['T-0023', 'sharing']]);
  const show = await cli(root, 'task', 'T-0014');
  assert.match(show.out, /\napp › Public pages › Publish a note › Take a page down\nBuilt against a placeholder for T-0016; T-0024 wires it in\n/);
  assert.match(show.out, /milestone A member publishes a note as a public page/);
});

// ---- the plan documents ----

test('the Implementation Plan lists the milestones, each with its demo, date, features, placeholders and wiring, then the scope', () => {
  const plan = fixture();
  const dates = new Map([['walking-skeleton', { at: Date.parse('2026-10-25T16:00:00Z'), reached: true }], ['write-and-find', { at: Date.parse('2026-10-28T16:00:00Z'), reached: false }]]);
  const map = computeMap(plan, { now: Date.parse('2026-10-27T18:00:00Z'), passHours: 1, agents: [], mode: 'idle' });
  const md = renderImplementationPlan(plan, map, loadIndex(paths(FIXTURE).specIndex), [], projectInfo(loadConfig(FIXTURE)), dates);
  assert.match(md, /TaskSet revision 2\./);
  assert.match(md, /- \*\*Tasks:\*\* 40 in 3 lanes, 4 epics, 9 features and 19 stories/);
  assert.match(md, /- \*\*Milestones:\*\* 5, 1 reached; next is A team writes and finds its notes, projected Wed, Oct 28, 2026\./);
  assert.match(md, /\n## Milestones\n[\s\S]*\n\| 1\. The app builds, deploys and signs a person in \| 7 \| 7 \| 5\.5 \| reached Sun, Oct 25, 2026 \|\n/);
  assert.match(md, /\n### 3\. A member publishes a note as a public page\n\n\*\*Demo:\*\* Publish a note, open its link in a private window, copy the link, then unpublish it and see it gone\.\n/);
  assert.match(md, /- \*\*Features:\*\* Publish a note \(`publishing`\), Share a page \(`sharing`\)\./);
  assert.match(md, /- \*\*Placeholder:\*\* T-0014 is built before T-0016, against a placeholder; T-0024 wires it in \(4\. Publishing runs on jobs that retry and act once\)\./);
  assert.match(md, /### 4\. Publishing runs on jobs that retry and act once[\s\S]*- \*\*Tasks, from stories placed elsewhere:\*\* T-0024 Unpublishing runs on the job queue[\s\S]*- \*\*Wiring:\*\* T-0024 replaces the placeholder in T-0014 with the real T-0016\./);
  // The scope: a heading per level, the story's need, and its tasks.
  assert.match(md, /\n## app\n\nBuilds `acme-app`: 2 epics, 24 tasks[\s\S]*\n### Public pages\n\nA member publishes a note as a public page anyone can read, and takes it down again\.[\s\S]*\n#### Publish a note\n[\s\S]*\n##### Take a page down\n\nAs a member, I want to unpublish a page, so that it is gone within a minute\. \(`unpublish-note`\)\n\n\| Task \| Title \| Milestone \|/);
  assert.match(md, /\| T-0014[ ◆]* \| Unpublishing takes the page down within a minute, in the request until jobs exist ⧉ \(placeholder for T-0016\) \| 3\. A member publishes a note as a public page \|/);
  assert.ok(!/stage|day \d/i.test(md));
});

test('importing a TaskSet over one is the next revision too: the old one, milestones and all, is kept, and the order is planned afresh', async () => {
  const root = project();
  const p = paths(root);
  const incoming = mkdtempSync(join(tmpdir(), 'helix-import-'));
  cpSync(p.tasks, join(incoming, 'tasks'), { recursive: true });
  cpSync(p.human, join(incoming, 'human'), { recursive: true });
  writeFileSync(join(incoming, 'taskset.yaml'), readFileSync(p.taskset, 'utf8').replace('revision: 2\nmilestones: milestones.yaml\n', 'revision: 1\n'));
  writeFileSync(join(incoming, 'tasks', 'T-0041.yaml'), stringify({ ...task('T-0041'), story: 'copy-link' }));
  const dry = await cli(root, 'taskset', 'import', incoming);
  assert.match(dry.out, /^\+1 tasks\n/);
  assert.match(dry.out, /Nothing written/);
  const r = await cli(root, 'taskset', 'import', incoming, '--apply');
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /Imported as TaskSet revision 3\./);
  assert.ok(existsSync(join(p.history, 'r2', 'milestones.yaml')), 'revision 2 is kept with its milestones');
  assert.ok(!existsSync(p.milestones), 'the new TaskSet has no order yet');
  const plan = loadPlan(p.tasks, p.human);
  assert.deepEqual([plan.taskset!.revision, plan.taskset!.milestonesFile, plan.milestones], [3, undefined, undefined]);
  assert.match(messages(validateMilestones(plan)).join(), /milestones\.yaml: missing/);
  const history = parse(readFileSync(join(p.history, 'index.yaml'), 'utf8')).revisions;
  assert.deepEqual(history.map((x: { revision: number; snapshot?: string }) => [x.revision, x.snapshot]), [[1, 'history/r1/'], [2, 'history/r2/'], [3, undefined]]);
  assert.match(history[2].why, /^TaskSet imported: 1 task added, 0 removed$/);
});

test('Home asks the owner to review a reached milestone\'s demo, once, until it is reviewed', () => {
  const root = project();
  const p = paths(root);
  mkdirSync(p.runs, { recursive: true });
  const reached = { kind: 'milestone', at: '2026-10-25T16:00:00.000Z', key: 'walking-skeleton', title: 'The app builds, deploys and signs a person in', demo: 'Sign in with an email code, land in an empty workspace.', repos: ['acme-app'] };
  writeFileSync(p.ledger, `${JSON.stringify(reached)}\n${JSON.stringify({ ...reached, at: '2026-10-26T10:00:00.000Z' })}\n`);
  const groups = (dismissed: string[]) => buildView(root, snapshot(root), loadConfig(root), { dismissed: new Set(dismissed) }).groups.filter((g) => g.kind === 'milestone');
  const [g, ...more] = groups([]);
  assert.equal(more.length, 0, 'reached twice: asked once, for the latest');
  assert.deepEqual([g!.title, g!.cause, g!.action], ['Milestone reached: The app builds, deploys and signs a person in', 'Review it: Sign in with an email code, land in an empty workspace.', { label: 'Reviewed', op: 'dismiss' }]);
  assert.deepEqual(groups([g!.members[0]!.id]), []);
});
