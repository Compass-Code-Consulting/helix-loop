import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { stringify } from 'yaml';
import { type Config, configPath, loadConfig, monitorModel, monitorOf, paths } from '../src/config.ts';
import { seedControlPlane } from '../src/dryrun.ts';
import { loadPlan } from '../src/plan/store.ts';
import { validateGraph } from '../src/plan/validate.ts';
import { openStage } from '../src/sched/scheduler.ts';
import type { HumanTask, Plan, Task } from '../src/types.ts';
import { buildBoard, finishMoved } from '../src/app/board.ts';
import { readChanges, undoChange } from '../src/app/changes.ts';
import { applyChangeSet, applyToText, checkConfig, ConfigEditError } from '../src/app/config.ts';
import { applyChanges } from '../src/app/fixes.ts';
import { digest, MONITOR_TOOLS, monitorTools, type HelixJob } from '../src/app/helix.ts';
import { decide, DEFAULT_PILOT, readHitl, writeRules } from '../src/app/hitl.ts';
import { appendStored, incidents } from '../src/app/incidents.ts';
import { estimateLevels, monitorChanges, monitorShouldRun, simulateTurns } from '../src/app/monitor.ts';
import { project } from '../src/app/projection.ts';
import { startApp } from '../src/app/server.ts';
import { stepsOf } from '../src/app/server.ts';
import { diffTaskSet, initTaskSet, loadTaskSet } from '../src/app/taskset.ts';
import { triage } from '../src/app/triage.ts';
import type { Report } from '../src/app/state.ts';
import type { LedgerEvent } from '../src/ledger.ts';
import { FIXTURE } from './fixture.ts';

// Helix Loop (spec: Helix Loop - App Spec 2026-10-27): the board and its projection, Home's groups, pilot mode,
// incidents, config change sets, batch edits and undo, the TaskSet, and the endpoints that drive them, each
// against a temporary control plane.

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = Date.parse('2026-10-27T12:00:00Z');

function task(t: Partial<Task> & { id: string }): Task {
  return { repo: 'acme-app', stage: 'day1', area: `area-${t.id.toLowerCase()}`, title: `Helix test task ${t.id}`, reqs: ['PB-14'], spec: ['PB-14'], acceptance: [`unit: [PB-14] behaviour of ${t.id}`], blocked_by: [], estimate_passes: 1, status: 'ready', claimed_by: null, attempts: [], ...t };
}
function human(h: Partial<HumanTask> & { id: string }): HumanTask {
  return { title: `Helix test human step ${h.id}`, done_check: 'Daniel says it is done', lead_time_days: 1, agent_can_help: 'no', blocked_by: [], status: 'todo', ...h };
}
const planOf = (tasks: Task[], humans: HumanTask[] = []): Plan => ({ tasks: new Map(tasks.map((t) => [t.id, t])), human: new Map(humans.map((h) => [h.id, h])) });

function controlPlane(tasks: Task[] = [], humans: HumanTask[] = [], git = false): string {
  const root = mkdtempSync(join(tmpdir(), 'helix-'));
  seedControlPlane(root, FIXTURE);
  const p = paths(root);
  for (const t of tasks) writeFileSync(join(p.tasks, `${t.id}.yaml`), stringify(t));
  for (const h of humans) writeFileSync(join(p.human, `${h.id}.yaml`), stringify(h));
  writeFileSync(configPath(root), `# The test loop's config.\n${stringify({ ...loadConfig(FIXTURE), root: undefined, push: false })}`);
  mkdirSync(p.runs, { recursive: true });
  if (git) {
    const g = (...a: string[]) => execFileSync('git', a, { cwd: root, stdio: 'pipe' });
    g('init', '-q', '-b', 'main');
    g('-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '-A');
    g('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'seed');
  }
  return root;
}
const gitLog = (root: string, n = 1) => execFileSync('git', ['log', `-${n}`, '--format=%s'], { cwd: root }).toString().trim();

// ---- the projection and the board ----

test('the projection runs tasks as the loop would pick them: by rank, one pass per area, a stage once the earlier one is settled', () => {
  const plan = planOf([
    task({ id: 'T-0001', area: 'a' }),
    task({ id: 'T-0002', area: 'a' }),
    task({ id: 'T-0003', area: 'b' }),
    task({ id: 'T-0004', area: 'c', stage: 'day2' }),
    task({ id: 'T-0005', area: 'd', blocked_by: ['HT-1'] }),
  ], [human({ id: 'HT-1', lead_time_days: 2 })]);
  const p = project({ plan, rank: ['T-0001', 'T-0002', 'T-0003', 'T-0004', 'T-0005'], now: NOW, passHours: 1, slots: 2, running: [] });
  const at = (id: string) => (p.tasks.get(id)!.start - NOW) / HOUR;
  assert.equal(at('T-0001'), 0);
  assert.equal(at('T-0003'), 0, 'another area runs beside it');
  assert.equal(at('T-0002'), 1, 'the same area waits for the first');
  assert.equal(at('T-0005'), 48, 'a task behind a person runs once their lead time is over');
  assert.ok(at('T-0004') >= 2, 'day 2 opens once day 1 is settled: the task behind a person counts as settled');
  assert.ok(at('T-0004') < 48);
});

test('a task that needs Daniel is projected as handed back now, and costs the finish what its wait costs', () => {
  const plan = planOf([task({ id: 'T-0001', status: 'needs_human', attempts: [] }), task({ id: 'T-0002', blocked_by: ['T-0001'] })]);
  const config = loadConfig(FIXTURE);
  const input = { plan, events: [] as LedgerEvent[], taskset: loadTaskSet(mkdtempSync(join(tmpdir(), 'helix-ts-')), plan), agents: [], running: [], config, now: NOW };
  const board = buildBoard(input);
  assert.ok(board.projection.tasks.has('T-0002'), 'what waits behind it still gets a date');
  assert.equal(board.tasks.find((t) => t.id === 'T-0001')!.held, 1);
  const cost = { ...input, rank: board.rank, slots: board.slots, finish: board.finish };
  const day = finishMoved(cost, ['T-0001'], { waitMs: 24 * HOUR });
  assert.ok(Math.abs(day - 24 * HOUR) < HOUR, `a day's wait moves the finish a day, not ${day / HOUR} h`);
});

test('code complete leaves out human tasks\' lead times that project complete counts, and the TaskSet can show project complete alone', async () => {
  // T-0002 waits on an Apple Developer account that takes 44 days; T-0001 and T-0003 wait on nobody.
  const tasks = [task({ id: 'T-0001' }), task({ id: 'T-0002', blocked_by: ['HT-10'] }), task({ id: 'T-0003', blocked_by: ['T-0002'] })];
  const humans = [human({ id: 'HT-10', title: 'Apple Developer Program, after the D-U-N-S number', lead_time_days: 44 })];
  const plan = planOf(tasks, humans);
  const config = loadConfig(FIXTURE);
  const board = buildBoard({ plan, events: [] as LedgerEvent[], taskset: loadTaskSet(mkdtempSync(join(tmpdir(), 'helix-ts-')), plan), agents: [], running: [], config, now: NOW });
  assert.deepEqual(board.timelines, ['code', 'project'], 'without a TaskSet file, both');
  assert.ok(board.finish - NOW >= 44 * 24 * HOUR, 'project complete waits for the account');
  assert.ok(board.codeFinish! - NOW < 24 * HOUR, `code complete is the build alone, not ${(board.codeFinish! - NOW) / HOUR} h`);
  assert.ok(board.codeFinish! < board.finish);
  // A launch step nothing waits on still ends the project, after the work it waits on, but not the code.
  const launch = planOf([task({ id: 'T-0001' })], [human({ id: 'HT-90', title: 'Submit the app for review', lead_time_days: 3, blocked_by: ['T-0001'] })]);
  const after = buildBoard({ plan: launch, events: [] as LedgerEvent[], taskset: loadTaskSet(mkdtempSync(join(tmpdir(), 'helix-ts-')), launch), agents: [], running: [], config, now: NOW });
  assert.ok(after.finish - NOW >= 3 * 24 * HOUR, 'project complete waits for the review step');
  assert.ok(after.codeFinish! - NOW < 24 * HOUR, 'code complete does not');

  const root = controlPlane(tasks, humans);
  writeFileSync(paths(root).taskset, stringify({ version: 1, timelines: ['project'], lanes: { 'acme-app': { repo: 'acme-app', epics: { core: { title: 'The core' } } } } }));
  const app = await startApp({ root, port: 0 });
  try {
    const state = await (await fetch(`${app.url}/api/state`)).json();
    assert.deepEqual(state.timelines, ['project']);
    assert.ok(!('codeFinish' in state), 'no code complete to show');
    assert.ok(state.finish - Date.now() >= 43 * 24 * HOUR);
    const home = await (await fetch(`${app.url}/api/home`)).json();
    assert.deepEqual([home.timelines, home.codeFinish], [['project'], undefined]);
  } finally {
    await app.close();
  }
});

test('without plan/taskset.yaml, epics are derived per lane and feature, not per stage, and taskset init writes them down with the stages', () => {
  const tasks = [task({ id: 'T-0001', feature: 'Publishing, team and settings' }), task({ id: 'T-0002', feature: 'Publishing, team and settings', stage: 'day2' }), task({ id: 'T-0003', feature: 'Foundation', stage: 'day0' })];
  const root = controlPlane(tasks);
  const plan = loadPlan(paths(root).tasks, paths(root).human);
  assert.deepEqual(plan.stages, ['day0', 'day1', 'day2'], 'without a TaskSet, the stages the tasks name, in order');
  const ts = loadTaskSet(root, plan);
  assert.equal(ts.derived, true);
  assert.deepEqual(ts.lanes[0]!.epics.map((e) => [e.key, e.title, e.tasks.length]), [['foundation', 'Foundation', 1], ['publishing-team-and-settings', 'Publishing, team and settings', 2]]);
  const { file, changed } = initTaskSet(root, plan);
  assert.equal(changed.length, 3);
  assert.equal(changed.find((t) => t.id === 'T-0003')!.epic, 'foundation');
  assert.deepEqual(Object.keys(file.lanes['acme-app']!.epics), ['foundation', 'publishing-team-and-settings']);
  assert.deepEqual(file.stages, [{ key: 'day0', title: 'Day 0' }, { key: 'day1', title: 'Day 1' }, { key: 'day2', title: 'Day 2' }]);
});

test('stages are optional: a plan whose tasks name none has no stage gating, and a TaskSet declares their order and titles', () => {
  const root = controlPlane([task({ id: 'T-0001', stage: undefined }), task({ id: 'T-0002', stage: undefined, blocked_by: ['T-0001'] })]);
  let plan = loadPlan(paths(root).tasks, paths(root).human);
  assert.deepEqual(plan.stages, []);
  assert.equal(openStage(plan), undefined);
  assert.deepEqual(validateGraph(plan), []);
  writeFileSync(paths(root).taskset, stringify({ version: 1, stages: ['alpha', { key: 'beta-ready', title: 'Beta: ready for users' }], lanes: {} }));
  plan = loadPlan(paths(root).tasks, paths(root).human);
  assert.deepEqual(plan.stages, ['alpha', 'beta-ready']);
  assert.deepEqual(plan.stageTitles, { alpha: 'Alpha', 'beta-ready': 'Beta: ready for users' });
  const named = loadPlan(paths(controlPlane([task({ id: 'T-0003', stage: 'gamma' })])).tasks, paths(root).human);
  assert.match(validateGraph({ ...named, stages: plan.stages }).map((p) => p.message).join(), /stage gamma, which the TaskSet doesn't declare/);
});

test('an imported TaskSet keeps merged, running and attempted tasks as they are, and removes only untouched ones', () => {
  const current = planOf([task({ id: 'T-0001', status: 'done' }), task({ id: 'T-0002' }), task({ id: 'T-0003', attempts: [{ agent: 'claude', outcome: 'gate_failed', at: 'x', log: 'l' }] })]);
  const incoming = planOf([task({ id: 'T-0001', title: 'Renamed in the import, but done already' }), task({ id: 'T-0004' })]);
  const { diff, plan } = diffTaskSet(current, incoming, new Set(), { version: 1, lanes: { 'acme-app': { repo: 'acme-app', epics: { new: { title: 'New epic' } } } } });
  assert.deepEqual(diff.added, ['T-0004']);
  assert.deepEqual(diff.removed, ['T-0002']);
  assert.ok(diff.kept.includes('T-0001'));
  assert.equal(plan.tasks.get('T-0001')!.status, 'done');
  assert.ok(plan.tasks.has('T-0003'), 'an attempted task is never removed');
  assert.deepEqual(diff.epicsAdded, ['acme-app/new']);
});

// ---- pilot mode ----

test('pilot mode: the table by level, Intrepid parking on Auto-pilot, rules over the table, and floors over everything', () => {
  const active = { ...DEFAULT_PILOT };
  assert.equal(decide(active, [], 'spec_plain').decision, 'helix');
  assert.equal(decide({ ...active, active_level: 'cautious' }, [], 'spec_plain').decision, 'asks');
  assert.equal(decide({ ...active, mode: 'auto', auto_level: 'intrepid' }, [], 'failures').decision, 'parks');
  assert.equal(decide({ ...active, mode: 'auto', auto_level: 'yolo' }, [], 'security').decision, 'helix');
  const rules = [{ id: 'R-1', name: 'lockfile-only merge conflicts', decide: 'helix' as const, at: '' }, { id: 'R-2', name: 'any change to apps/auth', decide: 'ask' as const, at: '' }];
  assert.equal(decide(active, rules, 'failures', 'Lockfile-only merge conflicts').decision, 'helix', 'a ▼ rating lets Helix decide that kind');
  assert.equal(decide({ ...active, mode: 'auto', auto_level: 'yolo' }, rules, 'architecture', 'any change to apps/auth').decision, 'parks', 'a ▲ rating asks even on YOLO; away, that parks');
  assert.equal(decide({ ...active, mode: 'auto', auto_level: 'yolo' }, rules, 'release').decision, 'always');
  assert.equal(decide(active, [{ id: 'R-3', name: 'releases', decide: 'helix', at: '' }], 'release', 'releases').decision, 'always', 'no rule lowers a floor');
});

// ---- incidents and Home's groups ----

const pass = (task: string, at: string, failing: string, outcome = 'gate_failed'): LedgerEvent => ({ kind: 'pass', at, task, repo: 'acme-app', agent: 'codex', model: 'm', attempt: 1, outcome, durationMs: 1, costUsd: 0, tokens: { input: 0, cachedInput: 0, output: 0 }, log: `runs/logs/x/${task}-codex-1.log`, failing });

test('incidents: a named test failing several tasks is one shared cause; a timeout is each task\'s own; reports group by variable and requirement', () => {
  const plan = planOf([task({ id: 'T-0001' }), task({ id: 'T-0002' }), task({ id: 'T-0003' })]);
  const flaky = '|integration| apps/x.test.ts > [PB-14] the shared test';
  const events = [pass('T-0001', '2026-10-27T08:00:00Z', flaky), pass('T-0002', '2026-10-27T09:00:00Z', flaky), pass('T-0001', '2026-10-27T10:00:00Z', 'the pass ran past its timeout', 'timeout'), pass('T-0003', '2026-10-27T10:00:00Z', 'the pass ran past its timeout', 'timeout')];
  const report = (task: string, issue: string, message: string): Report => ({ at: '2026-10-27T11:00:00Z', pass: `${task}:codex:1`, task, agent: 'codex', attempt: 1, kind: 'issue', issue, message });
  const reports = [report('T-0001', 'credential_missing', 'STRIPE_TEST_KEY is not set in prepare'), report('T-0002', 'credential_missing', 'Needs STRIPE_TEST_KEY'), report('T-0003', 'spec_question', 'Which states does SU-7 cover?'), report('T-0002', 'spec_question', 'Is loading a help state for SU-7?')];
  const found = incidents({ plan, events, reports, stored: [], now: NOW });
  const by = (key: string) => found.find((i) => i.key === key);
  assert.equal(by(`gate:${flaky}`)!.kind, 'flaky_test');
  assert.equal(by(`gate:${flaky}`)!.members.length, 2);
  assert.ok(by('gate:T-0001:the pass ran past its timeout') && by('gate:T-0003:the pass ran past its timeout'), 'timeouts stay per task');
  assert.equal(by('cred:STRIPE_TEST_KEY')!.members.length, 2);
  assert.equal(by('spec:SU-7')!.members.length, 2);
});

test('Home: human tasks that hold work, stopped tasks by why they stopped, each task in one group only, and releases', () => {
  const plan = planOf([
    task({ id: 'T-0001', status: 'needs_human', attempts: [1, 2, 3].map(() => ({ agent: 'codex' as const, outcome: 'gate_failed' as const, at: '2026-10-27T10:00:00Z', log: 'l' })) }),
    task({ id: 'T-0002', blocked_by: ['T-0001'] }),
    task({ id: 'T-0003', blocked_by: ['HT-1'] }),
    task({ id: 'T-0004', status: 'parked' }),
  ], [human({ id: 'HT-1', lead_time_days: 5 })]);
  const config = loadConfig(FIXTURE);
  const input = { plan, events: [pass('T-0001', '2026-10-27T10:00:00Z', 'the pass ran past its timeout', 'timeout')], taskset: loadTaskSet(mkdtempSync(join(tmpdir(), 'helix-ts-')), plan), agents: [], running: [], config, now: NOW };
  const board = buildBoard(input);
  const groups = triage({ plan, board, events: input.events, incidents: incidents({ plan, events: input.events, reports: [], stored: [], now: NOW }), approvals: [{ repo: 'acme-docs', tag: 'v1', paths: ['infra/x.tf'], since: 'v0', requestedAt: '' }], hitl: { records: [], ratings: new Map(), raised: [] }, config, dismissed: new Set(), now: NOW });
  const kinds = groups.map((g) => g.kind);
  assert.ok(kinds.includes('your_tasks'));
  assert.ok(kinds.includes('release'));
  const ids = groups.flatMap((g) => g.members.map((m) => m.id)).filter((id) => id.startsWith('T-'));
  assert.equal(new Set(ids).size, ids.length, 'a task shows in one group only');
  const t1 = groups.find((g) => g.members.some((m) => m.id === 'T-0001'))!;
  assert.equal(t1.action.op, 'hand_back');
  assert.equal(t1.held, 1);
  assert.ok(groups.some((g) => g.members.some((m) => m.id === 'T-0004') && g.title.includes('parked')));
});

// ---- config change sets ----

test('a config change set is written into the file with its comments kept, checked as the loop loads it, and committed', async () => {
  const root = controlPlane([task({ id: 'T-0001' })], [], true);
  const before = readFileSync(configPath(root), 'utf8');
  const text = applyToText(before, [{ key: 'agents.codex.slots', value: 3 }, { key: 'agents.claude.weekly_target', value: 80 }, { key: 'agents.codex.models.build', value: { model: 'gpt-6.1-sol', effort: 'xhigh' } }]);
  assert.match(text, /^# The test loop's config\./, 'the comment survives');
  const config = checkConfig(root, text) as Config;
  assert.equal(config.agents.codex.slots, 3);
  assert.equal(config.agents.claude.weekly_target, 0.8, 'percentages are written as shares');
  assert.equal(config.agents.codex.models.build.effort, 'xhigh');
  assert.throws(() => applyToText(before, [{ key: 'release.review_paths', value: [] }]), ConfigEditError);
  assert.throws(() => applyToText(before, [{ key: 'agents.codex.slots', value: 99 }]), /between 0 and 6/);
  assert.throws(() => applyToText(before, [{ key: 'repos.acme-docs.gate', value: 'rm -rf /' }]), /isn't a setting the app changes/);
  await applyChangeSet(root, [{ key: 'limits.max_attempts', value: 4 }]);
  assert.equal(loadConfig(root).limits.max_attempts, 4);
  assert.equal(gitLog(root), 'Config: limits.max_attempts (Sam, in Helix Loop)');
});

// ---- batch edits and undo ----

test('a batch lands as one commit and can be undone for a day, unless something later touched its tasks', async () => {
  const root = controlPlane([task({ id: 'T-0001', status: 'needs_human' }), task({ id: 'T-0002', status: 'needs_human' }), task({ id: 'T-0003' })], [], true);
  const r = await applyChanges(root, [{ op: 'hand_back', task: 'T-0001', note: 'Use the sandbox host.' }, { op: 'hand_back', task: 'T-0002' }, { op: 'add_dep', task: 'T-0003', on: 'T-0001' }], { what: 'hand back 2 tasks', by: 'Sam' });
  assert.equal(gitLog(root), 'Plan: hand back 2 tasks (Sam, in Helix Loop)');
  const plan = () => loadPlan(paths(root).tasks, paths(root).human);
  assert.equal(plan().tasks.get('T-0001')!.status, 'ready');
  assert.equal(plan().tasks.get('T-0001')!.notes, 'Use the sandbox host.');
  assert.deepEqual(plan().tasks.get('T-0003')!.blocked_by, ['T-0001']);
  assert.equal(readChanges(paths(root).changes).length, 1);

  await undoChange(root, r.change!.id);
  assert.equal(plan().tasks.get('T-0001')!.status, 'needs_human');
  assert.deepEqual(plan().tasks.get('T-0003')!.blocked_by, []);
  await assert.rejects(undoChange(root, r.change!.id), /undone already/);

  const again = await applyChanges(root, [{ op: 'park', task: 'T-0003' }], { what: 'park T-0003', by: 'Daniel' });
  await applyChanges(root, [{ op: 'note', task: 'T-0003', note: 'Later' }], { what: 'note T-0003', by: 'Daniel' });
  await assert.rejects(undoChange(root, again.change!.id), /a later change touched the same tasks/);
});

// ---- the monitor's guarded tools ----

test("Helix's monitor applies a fix only when the pilot level and Daniel's rules let it, and records what it did", async () => {
  const root = controlPlane([task({ id: 'T-0001', status: 'needs_human' }), task({ id: 'T-0002', status: 'needs_human' })], [], true);
  const flaky = '|integration| apps/x.test.ts > [PB-14] the shared test';
  writeFileSync(paths(root).ledger, [pass('T-0001', new Date().toISOString(), flaky), pass('T-0002', new Date().toISOString(), flaky)].map((e) => JSON.stringify(e)).join('\n') + '\n');
  const job: HelixJob = { role: 'monitor', root, tokenHash: '', startedAt: '', resolved: false };
  const tool = (name: string) => MONITOR_TOOLS.find((t) => t.name === name)!;
  const key = `gate:${flaky}`;
  assert.match(await tool('propose_fix').call({ key, summary: 'Hand both back with a note on the shared test', confidence: 86, changes: [{ op: 'hand_back', task: 'T-0001', note: 'The shared test is flaky.' }, { op: 'hand_back', task: 'T-0002' }] }, { root, job }), /Proposed as F-1/);
  // Active pilot · Prudent: repeated failures ask Daniel.
  await assert.rejects(async () => tool('apply_fix').call({ key, question: 'Hand both back?', why: 'flaky' }, { root, job }), /Not yours to decide/);
  assert.equal(loadPlan(paths(root).tasks, paths(root).human).tasks.get('T-0001')!.status, 'needs_human');
  // A ▼ rating on that kind lets it decide.
  writeRules(root, [{ id: 'R-1', name: 'the shared test', decide: 'helix', at: '' }]);
  appendStored(paths(root).incidents, { type: 'named', key, at: new Date().toISOString(), title: 'the shared test' });
  assert.match(await tool('apply_fix').call({ key, question: 'Hand both back?', why: 'The test is flaky, not the tasks.' }, { root, job }), /Applied/);
  assert.equal(loadPlan(paths(root).tasks, paths(root).human).tasks.get('T-0002')!.status, 'ready');
  const { records } = readHitl(paths(root).hitl);
  assert.equal(records.length, 1);
  assert.equal(records[0]!.question, 'Hand both back?');
  assert.ok(records[0]!.change, 'what it did can be undone');
  assert.match(gitLog(root), /Helix monitor/);
});

// ---- the monitor's levels ----

test("the monitor's levels: light runs only on what needs judgment, standard adds a heartbeat, thorough runs on every pass", () => {
  const failedAgain = { kind: 'pass', failed: true, repeat: true } as const;
  const failedOnce = { kind: 'pass', failed: true, repeat: false } as const;
  const merged = { kind: 'pass', failed: false, repeat: false } as const;
  const issue = { kind: 'report', issue: true } as const;
  const progress = { kind: 'report', issue: false } as const;
  const runs = (level: 'light' | 'standard' | 'thorough') => [failedAgain, failedOnce, merged, issue, progress, { kind: 'asked' } as const].map((c) => monitorShouldRun(level, c));
  assert.deepEqual(runs('light'), [true, false, false, true, false, true]);
  assert.deepEqual(runs('standard'), [true, false, false, true, false, true]);
  assert.deepEqual(runs('thorough'), [true, true, true, true, true, true]);

  const config = loadConfig(FIXTURE);
  const with_ = (monitor: object): Config => ({ ...config, helix: { monitor } });
  // Off and light until Daniel says otherwise; light has no heartbeat and no reads of running passes.
  assert.deepEqual(monitorOf(config), { enabled: false, level: 'light', budgetUsd: 5, budgetSet: false, everyMinutes: undefined, everyPass: false, passReads: false });
  assert.deepEqual([monitorOf(with_({ level: 'standard' })).budgetUsd, monitorOf(with_({ level: 'standard' })).everyMinutes], [15, 30]);
  assert.deepEqual([monitorOf(with_({ level: 'thorough' })).budgetUsd, monitorOf(with_({ level: 'thorough' })).everyMinutes], [30, 15]);
  // A cap or heartbeat set in the config holds at every level.
  const set = with_({ level: 'thorough', daily_budget_usd: 8, every_minutes: 60 });
  assert.deepEqual([monitorOf(set).budgetUsd, monitorOf(set).budgetSet, monitorOf(set).everyMinutes, monitorOf(set, 'light').budgetUsd], [8, true, 60, 8]);
  assert.equal(monitorOf(set, 'light').everyMinutes, undefined, 'light never runs on a schedule');
  // Light on Claude Code is Sonnet at low effort, on Codex its build model; the others the plan model.
  assert.deepEqual(monitorModel(config, 'claude', 'light'), { model: 'claude-sonnet-5-5', effort: 'low' });
  assert.deepEqual(monitorModel(config, 'codex', 'light'), { model: config.agents.codex.models.build.model, effort: 'low' });
  assert.deepEqual(monitorModel(config, 'claude', 'standard'), { model: 'claude-sonnet-5-5', effort: 'medium' });
  assert.deepEqual(monitorModel(config, 'claude', 'thorough'), { model: config.agents.claude.models.plan.model, effort: 'high' });
  assert.deepEqual(monitorModel(with_({ model: { claude: { model: 'claude-haiku-5-5', effort: 'medium' } } }), 'claude', 'thorough'), { model: 'claude-haiku-5-5', effort: 'medium' });
  // Light isn't offered note_pass.
  assert.ok(!monitorTools(config).some((t) => t.name === 'note_pass'));
  assert.ok(monitorTools(with_({ level: 'standard' })).some((t) => t.name === 'note_pass'));
});

test("the monitor's triggers: a failure repeats on the task's second failure or a named test failing again; interruptions are not failures", () => {
  const flaky = '|integration| apps/x.test.ts > [PB-14] the shared test';
  const events = [
    pass('T-0001', '2026-10-20T08:00:00Z', flaky), // a week and more before: it doesn't make the next one a repeat
    pass('T-0002', '2026-10-27T08:00:00Z', 'type error in a.ts'),
    pass('T-0002', '2026-10-27T09:00:00Z', 'type error in b.ts'),
    pass('T-0003', '2026-10-27T09:30:00Z', flaky),
    pass('T-0004', '2026-10-27T10:00:00Z', flaky),
    pass('T-0005', '2026-10-27T10:30:00Z', '', 'quota'),
    pass('T-0005', '2026-10-27T11:00:00Z', 'type error'),
    pass('T-0006', '2026-10-27T11:30:00Z', '', 'merged'),
  ];
  const reports: Report[] = [{ at: '2026-10-27T11:45:00Z', pass: 'p', task: 'T-0006', agent: 'claude', attempt: 1, kind: 'issue', issue: 'spec_question', message: 'Which?' }];
  const changes = monitorChanges(events, reports, { events: 1, reports: 0 }).map((c) => c.change);
  assert.deepEqual(changes, [
    { kind: 'pass', failed: true, repeat: false },
    { kind: 'pass', failed: true, repeat: true },
    { kind: 'pass', failed: true, repeat: false },
    { kind: 'pass', failed: true, repeat: true },
    { kind: 'pass', failed: false, repeat: false },
    { kind: 'pass', failed: true, repeat: false },
    { kind: 'pass', failed: false, repeat: false },
    { kind: 'report', issue: true },
  ]);
  assert.equal(changes.filter((c) => monitorShouldRun('light', c)).length, 3);
});

test("the monitor's schedule: triggers coalesce to one turn a minute, and the heartbeat runs only while the loop does", () => {
  const T = Date.parse('2026-10-27T00:00:00Z');
  const MIN = 60_000;
  // Three triggers inside a minute are two turns: the first, then one a minute later for the rest.
  assert.deepEqual(simulateTurns({ triggers: [T + 10_000, T + 20_000, T + 30_000], running: [], from: T, to: T + HOUR }), { turns: 2, heartbeats: 0 });
  // Every 30 minutes over an hour of running, then nothing while the loop is stopped.
  assert.deepEqual(simulateTurns({ triggers: [], running: [[T, T + HOUR]], everyMinutes: 30, from: T, to: T + 3 * HOUR }), { turns: 1, heartbeats: 1 });
  // A turn resets the clock.
  assert.deepEqual(simulateTurns({ triggers: [T + 25 * MIN], running: [[T, T + HOUR]], everyMinutes: 30, from: T, to: T + HOUR }), { turns: 2, heartbeats: 1 });

  // A day of passes: light runs on the repeat alone, at the Sonnet estimate; thorough runs into its cap.
  const now = Date.parse('2026-10-27T12:00:00Z');
  const events: LedgerEvent[] = [{ kind: 'loop', at: '2026-10-26T12:00:00Z', event: 'start' }];
  for (let i = 0; i < 200; i++) events.push(pass(`T-${String(1000 + i)}`, new Date(now - DAY + 1000 + i * 7 * MIN).toISOString(), '', 'merged'));
  events.push(pass('T-0001', new Date(now - HOUR).toISOString(), 'x'), pass('T-0001', new Date(now - 30 * MIN).toISOString(), 'x'));
  const est = estimateLevels({ config: loadConfig(FIXTURE), agent: 'claude', events, reports: [], costs: new Map([['claude-opus-5-5 high', { usd: 1, n: 2 }]]), now });
  const [light, , thorough] = est.levels;
  assert.equal(est.passes, 202);
  assert.deepEqual([light!.turns, light!.usdPerTurn, light!.measured, light!.capped], [1, 0.06, 0, false]);
  assert.equal(thorough!.usdPerTurn, 0.5, 'measured turns, where there are some');
  assert.deepEqual([thorough!.usdPerDay, thorough!.capped], [30, true]);
});

test("the monitor's digest asks for reads of running passes only at the levels that offer note_pass", () => {
  const root = controlPlane([task({ id: 'T-0001', status: 'claimed', claimed_by: 'codex' })]);
  const lock = () => writeFileSync(paths(root).lock, String(process.pid));
  lock();
  assert.doesNotMatch(digest(root, undefined), /note_pass/);
  const file = configPath(root);
  writeFileSync(file, `${readFileSync(file, 'utf8')}\nhelix: { monitor: { level: standard } }\n`);
  assert.match(digest(root, undefined), /Running: T-0001\. Give each a one-line read with note_pass/);
  writeFileSync(file, `${readFileSync(file, 'utf8')}`.replace('level: standard', 'level: heavy'));
  assert.throws(() => loadConfig(root), /helix\.monitor\.level is one of light, standard, thorough, not heavy/);
});

// ---- the endpoints ----

test("Settings › Helix: the monitor's level and cap apply at once, a cap can go back to the level's, and each level has an estimate", async () => {
  const root = controlPlane([], [], true);
  const app = await startApp({ root, port: 0 });
  try {
    const token = /name="helix-token" content="([^"]+)"/.exec(await (await fetch(`${app.url}/`)).text())![1]!;
    const post = async (body: unknown) => {
      const r = await fetch(`${app.url}/api/helix/settings`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-helix-token': token }, body: JSON.stringify(body) });
      assert.equal(r.status, 200, JSON.stringify(await r.clone().json()));
    };
    const monitor = async () => (await (await fetch(`${app.url}/api/state`)).json()).helix.monitor;
    assert.deepEqual([(await monitor()).level, (await monitor()).budgetUsd], ['light', 5]);
    await post({ monitorLevel: 'standard', monitorBudget: 8 });
    assert.equal(gitLog(root), 'Config: helix.monitor.level, helix.monitor.daily_budget_usd (Sam, in Helix Loop)');
    assert.deepEqual([(await monitor()).level, (await monitor()).budgetUsd, (await monitor()).budgetSet], ['standard', 8, true]);
    await post({ monitorBudget: null });
    assert.equal(loadConfig(root).helix?.monitor?.daily_budget_usd, undefined);
    assert.deepEqual([(await monitor()).budgetUsd, (await monitor()).budgetSet], [15, false]);
    await post({ monitorLevel: 'heavy' });
    assert.equal(loadConfig(root).helix?.monitor?.level, 'standard', 'an unknown level changes nothing');
    const settings = await (await fetch(`${app.url}/api/settings`)).json();
    assert.deepEqual(settings.monitorLevels.levels.map((l: { level: string }) => l.level), ['light', 'standard', 'thorough']);
  } finally {
    await app.close();
  }
});

test('the endpoints: Home, the board, pause, stop a pass, notes for a running task, a human task\'s checklist, pilot mode and ratings', async () => {
  const root = controlPlane([task({ id: 'T-0001', status: 'needs_human' }), task({ id: 'T-0002', status: 'claimed', claimed_by: 'codex' }), task({ id: 'T-0003', blocked_by: ['HT-1'] })], [human({ id: 'HT-1', handoff_prompt: 'Do it.\n\nSteps:\n1. Open the console.\n2. Create the key,\n   then save it.\n3. Report back.\n\nReport back: the ID.' })], true);
  const app = await startApp({ root, port: 0 });
  try {
    const token = /name="helix-token" content="([^"]+)"/.exec(await (await fetch(`${app.url}/`)).text())![1]!;
    const post = async (path: string, body: unknown) => {
      const r = await fetch(`${app.url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-helix-token': token }, body: JSON.stringify(body) });
      const j = await r.json();
      assert.equal(r.status, 200, `${path}: ${JSON.stringify(j)}`);
      return j;
    };
    const home = await (await fetch(`${app.url}/api/home`)).json();
    assert.ok(home.groups.some((g: { members: { id: string }[] }) => g.members.some((m) => m.id === 'T-0001')));
    const board = await (await fetch(`${app.url}/api/board`)).json();
    assert.equal(board.tasks.length, 3);
    assert.ok(!('projection' in board));

    await post('/api/loop/pause', { paused: true });
    assert.ok(existsSync(paths(root).pause));
    await post('/api/loop/pause', { paused: false });
    assert.ok(!existsSync(paths(root).pause));

    await post('/api/pass/stop', { task: 'T-0002', note: 'Start from the shared helper.' });
    assert.deepEqual(JSON.parse(readFileSync(join(paths(root).stopPass, 'T-0002.json'), 'utf8')).note, 'Start from the shared helper.');

    // A note for a task in a pass waits until the loop lets go of it.
    assert.equal((await post('/api/note-next', { task: 'T-0002', note: 'Mind the cache.' })).pending, true);
    const t2 = loadPlan(paths(root).tasks, paths(root).human).tasks.get('T-0002')!;
    writeFileSync(join(paths(root).tasks, 'T-0002.yaml'), stringify({ ...t2, status: 'ready', claimed_by: null }));
    await (await fetch(`${app.url}/api/state`)).json();
    assert.equal(loadPlan(paths(root).tasks, paths(root).human).tasks.get('T-0002')!.notes, 'Mind the cache.');

    assert.deepEqual(stepsOf(loadPlan(paths(root).tasks, paths(root).human).human.get('HT-1')!), ['Open the console.', 'Create the key, then save it.', 'Report back.']);
    await post('/api/human/action', { id: 'HT-1', steps: [1, 3] });
    await post('/api/human/action', { id: 'HT-1', snooze: '2026-11-02' });
    assert.equal(loadPlan(paths(root).tasks, paths(root).human).human.get('HT-1')!.notes, 'Snoozed until 2026-11-02\nSteps done: 1, 3');
    await post('/api/human/action', { id: 'HT-1', status: 'done', evidence: 'Key ID K-42' });
    assert.match(loadPlan(paths(root).tasks, paths(root).human).human.get('HT-1')!.notes!, /Evidence \(\d{4}-\d\d-\d\d\): Key ID K-42/);

    await post('/api/pilot', { mode: 'auto', auto_level: 'yolo' });
    assert.equal(loadConfig(root).pilot?.mode, 'auto');
    assert.equal(gitLog(root), 'Config: pilot.mode, pilot.auto_level (Sam, in Helix Loop)');
    const rule = await post('/api/rate', { name: 'lockfile-only merge conflicts', request: 'failures', decide: 'helix' });
    assert.equal(rule.id, 'R-1');
    const refused = await fetch(`${app.url}/api/rate`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-helix-token': token }, body: JSON.stringify({ name: 'releases', request: 'release', decide: 'helix' }) });
    assert.equal(refused.status, 409, 'no rating lowers a floor');
    await post('/api/rule/undo', { id: 'R-1' });

    const batch = await post('/api/batch', { ids: ['T-0001'], action: 'hand_back', note: 'Try the sandbox host.' });
    assert.ok(batch.change?.id);
    await post('/api/undo', { id: batch.change.id });
    assert.equal(loadPlan(paths(root).tasks, paths(root).human).tasks.get('T-0001')!.status, 'needs_human');
  } finally {
    await app.close();
  }
});
