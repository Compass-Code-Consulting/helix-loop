import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { gzipSync } from 'node:zlib';
import { stringify } from 'yaml';
import { asset, configPath, loadConfig, paths } from '../src/config.ts';
import { seedControlPlane } from '../src/dryrun.ts';
import type { LiveFile } from '../src/live.ts';
import { loadPlan } from '../src/plan/store.ts';
import type { HumanTask, Task } from '../src/types.ts';
import { referenceMarkdown } from '../src/cli/help.ts';
import { main } from '../src/cli/main.ts';
import { COMMANDS } from '../src/cli/registry.ts';
import { follow } from '../src/cli/watch.ts';
import { FIXTURE } from './fixture.ts';

// The CLI's commands, driven through main() as a person's command line is, against a scratch copy of the Acme
// fixture project. No real agent runs: the config names agent commands that don't exist, and an app port no app
// listens on.

function task(t: Partial<Task> & { id: string }): Task {
  return { repo: 'acme-app', stage: 'day1', area: `area-${t.id.toLowerCase()}`, title: `CLI test task ${t.id}`, reqs: ['PB-14'], spec: ['PB-14'], acceptance: [`unit: [PB-14] behaviour of ${t.id}`], blocked_by: [], estimate_passes: 1, status: 'ready', claimed_by: null, attempts: [], ...t };
}
function human(h: Partial<HumanTask> & { id: string }): HumanTask {
  return { title: `CLI test human step ${h.id}`, done_check: 'Sam says it is done', lead_time_days: 1, agent_can_help: 'no', blocked_by: [], status: 'todo', ...h };
}

// A port nothing listens on, for the app the CLI looks for.
async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  const port = (s.address() as { port: number }).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

async function project(tasks: Task[] = [], humans: HumanTask[] = []): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), 'helix-cli-'));
  seedControlPlane(root, FIXTURE);
  const p = paths(root);
  for (const t of tasks) writeFileSync(join(p.tasks, `${t.id}.yaml`), stringify(t));
  for (const h of humans) writeFileSync(join(p.human, `${h.id}.yaml`), stringify(h));
  const config = structuredClone(loadConfig(FIXTURE));
  config.agents.claude.command = join(root, 'no-such-claude');
  config.agents.codex.command = join(root, 'no-such-codex');
  writeFileSync(configPath(root), `# The CLI test's config.\n${stringify({ ...config, root: undefined, push: false, app: { port: await freePort() } })}`);
  mkdirSync(p.runs, { recursive: true });
  writeFileSync(join(root, '.gitignore'), '.helix/runs/\n');
  const g = (...a: string[]) => execFileSync('git', a, { cwd: root, stdio: 'pipe' });
  g('init', '-q', '-b', 'main');
  g('-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '-A');
  g('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'seed');
  return root;
}

async function cli(root: string, ...argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main([...argv, '--root', root], { out: (s = '') => void out.push(s), err: (s) => void err.push(s) });
  return { code, out: out.join('\n'), err: err.join('\n') };
}
const ok = async (root: string, ...argv: string[]) => {
  const r = await cli(root, ...argv);
  assert.equal(r.code, 0, `${argv.join(' ')}: ${r.err}`);
  return r.out;
};
const plan = (root: string) => loadPlan(paths(root).tasks, paths(root).human);
const lastCommit = (root: string) => execFileSync('git', ['log', '-1', '--format=%s'], { cwd: root }).toString().trim();

// A finished pass's log, gzipped as the loop leaves it: the builder's words, a failed command, then the gate.
function passLog(root: string, task: string, attempt = 1): string {
  const rel = `runs/logs/2026-10-27/${task}-codex-${attempt}.log`;
  mkdirSync(join(paths(root).logs, '2026-10-27'), { recursive: true });
  const lines = [
    { type: 'thread.started', thread_id: 't' },
    { type: 'item.completed', item: { id: 'i1', type: 'agent_message', text: 'Adding the export button and its test.' } },
    { type: 'item.started', item: { id: 'i2', type: 'command_execution', command: 'pnpm test', status: 'in_progress' } },
    { type: 'item.completed', item: { id: 'i2', type: 'command_execution', command: 'pnpm test', aggregated_output: 'FAIL export > writes a file', exit_code: 1, status: 'failed' } },
    { type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } },
  ].map((l) => JSON.stringify(l));
  writeFileSync(join(paths(root).home, `${rel}.gz`), gzipSync(`${[...lines, '> gate 10-check: lint', 'fine', '> gate 20-unit: unit tests', ' FAIL  |unit| export > writes a file', 'Gate failed at 20-unit'].join('\n')}\n`));
  return rel;
}

// ---- help ----

test('every command has its help, and docs/cli.md is the reference the commands declare', async () => {
  for (const c of COMMANDS) {
    const out: string[] = [];
    const code = await main([...c.name.split(' '), '--help'], { out: (s = '') => void out.push(s), err: (s) => void out.push(s) });
    assert.equal(code, 0, c.name);
    assert.ok(out.join('\n').startsWith(`helix-loop ${c.name}`), `${c.name}: ${out[0]}`);
    assert.ok(c.summary.length > 10, `${c.name} has a summary`);
    for (const line of (c.description ?? '').split('\n')) assert.ok(!/[.!?] [A-Z`]/.test(line), `${c.name}: one sentence per line: ${line}`);
  }
  assert.equal(new Set(COMMANDS.map((c) => c.name)).size, COMMANDS.length, 'no two commands share a name');
  assert.equal(readFileSync(asset('docs', 'cli.md'), 'utf8'), referenceMarkdown(COMMANDS), 'docs/cli.md is up to date: run `helix-loop docs`');
});

test('a mistyped command or subcommand is answered with the nearest one', async () => {
  const root = await project([task({ id: 'T-0001' })]);
  const r = await cli(root, 'tsks');
  assert.equal(r.code, 1);
  assert.match(r.err, /Did you mean `helix-loop tasks`\?/);
  assert.match((await cli(root, 'task', 'hand-bak', 'T-0001')).err, /no command "task hand-bak"\. Did you mean `helix-loop task hand-back`\?/);
  assert.match((await cli(root, 'human', 'strat', 'HT-1')).err, /Did you mean `helix-loop human start`\?/);
});

// ---- tasks ----

test('a task handed back is one commit, says how to undo it, and undo puts it back', async () => {
  const root = await project([task({ id: 'T-0001', status: 'needs_human', attempts: [{ agent: 'codex', outcome: 'gate_failed', at: '2026-10-27T10:00:00Z', log: 'runs/logs/2026-10-27/T-0001-codex-1.log', note: 'export test failed' }] }), task({ id: 'T-0002' })]);
  const list = await ok(root, 'tasks');
  assert.match(list, /^T-0001 {2}needs you {2}acme-app {2}1× {2}CLI test task T-0001$/m);
  assert.match(list, /2 tasks: 1 needs you, 1 ready/);

  assert.match(await ok(root, 'task', 'hand-back', 'T-0001', '--note', 'Use the sandbox host'), /^T-0001 is back with the loop\. Undo: helix-loop undo C-1$/);
  assert.equal(plan(root).tasks.get('T-0001')!.status, 'ready');
  assert.equal(plan(root).tasks.get('T-0001')!.notes, 'Use the sandbox host');
  assert.equal(lastCommit(root), 'Plan: T-0001 handed back to the loop (Sam, with helix-loop)');
  assert.match(await ok(root, 'changes'), /^C-1 {2}just now {2}Sam {2}T-0001 handed back to the loop$/m);

  const refused = await cli(root, 'undo', 'C-1');
  assert.equal(refused.code, 1, 'undo asks first, as the app does');
  assert.match(refused.err, /Add --yes/);
  assert.equal(await ok(root, 'undo', 'C-1', '--yes'), 'Undid C-1: T-0001 handed back to the loop.');
  assert.equal(plan(root).tasks.get('T-0001')!.status, 'needs_human');
  assert.equal(lastCommit(root), 'Plan: undo T-0001 handed back to the loop (Sam, with helix-loop)');

  assert.match(await ok(root, 'task', 'dep', 'add', 'T-0002', 'T-0001'), /T-0002 now waits on T-0001\. Undo: helix-loop undo C-2/);
  assert.match((await cli(root, 'task', 'dep', 'add', 'T-0002', 'T-0001')).err, /waits on T-0001 already/);
  assert.match(await ok(root, 'task', 'park', 'T-0002', '--note', 'Later'), /Parked T-0002\./);
  assert.match(await ok(root, 'task', 'park', 'T-0002'), /Nothing changed: T-0002 is parked already/);
  const shown = await ok(root, 'task', 'T-0002');
  assert.match(shown, /^T-0002 · CLI test task T-0002$/m);
  assert.match(shown, /^Waits on {3}T-0001 needs_human$/m);
  assert.match(shown, /^ {2}Later$/m);
});

test('a note for a task in a pass waits for the pass to end, and lands on the next command that reads the tasks', async () => {
  const root = await project([task({ id: 'T-0001', status: 'claimed', claimed_by: 'codex' })]);
  assert.equal(await ok(root, 'task', 'note', 'T-0001', 'Mind', 'the', 'cache'), 'T-0001 is in a pass: the note goes into its notes when the pass ends.');
  assert.equal(plan(root).tasks.get('T-0001')!.notes, undefined);
  writeFileSync(join(paths(root).tasks, 'T-0001.yaml'), stringify(task({ id: 'T-0001' })));
  await ok(root, 'tasks');
  assert.equal(plan(root).tasks.get('T-0001')!.notes, 'Mind the cache');
  assert.ok(!existsSync(join(paths(root).runs, 'pending-notes.jsonl')) || !readFileSync(join(paths(root).runs, 'pending-notes.jsonl'), 'utf8').trim());
});

// ---- human tasks ----

test('a human task: listed by its start-by date, its steps ticked, snoozed, and done with its evidence', async () => {
  const root = await project([task({ id: 'T-0001', blocked_by: ['HT-1'] })], [human({ id: 'HT-1', lead_time_days: 2, handoff_prompt: 'Do it.\n\nSteps:\n1. Open the console.\n2. Create the key,\n   then save it.\n\nReport back: the ID.\n' })]);
  assert.match(await ok(root, 'human'), /^HT-1 {2}todo {4}\S.* {2}2 d {3}1 task {2}CLI test human step HT-1/m);
  assert.match(await ok(root, 'human', 'step', 'HT-1', '2'), /Ticked step 2 of HT-1: Create the key, then save it\. \(1 of 2 done\)\./);
  assert.match((await cli(root, 'human', 'step', 'HT-1', '3')).err, /HT-1 has steps 1 to 2/);
  await ok(root, 'human', 'snooze', 'HT-1', '2026-11-02');
  const shown = await ok(root, 'human', 'HT-1');
  assert.match(shown, /\[ \] {2}1\. Open the console\.\n {2}\[x\] {2}2\. Create the key, then save it\./);
  assert.match(shown, /snoozed until 2026-11-02/);
  assert.equal(await ok(root, 'human', 'prompt', 'HT-1'), 'Do it.\n\nSteps:\n1. Open the console.\n2. Create the key,\n   then save it.\n\nReport back: the ID.');

  assert.match((await cli(root, 'human', 'done', 'HT-1')).err, /Mark HT-1 done\? Add --yes/);
  assert.match(await ok(root, 'human', 'done', 'HT-1', '--evidence', 'Key ID K-42', '--yes'), /^HT-1 is done: 1 task waiting on it can run\. Undo: helix-loop undo C-\d+$/);
  const h = plan(root).human.get('HT-1')!;
  assert.equal(h.status, 'done');
  assert.match(h.notes!, /Evidence \(\d{4}-\d\d-\d\d\): Key ID K-42/);
  assert.match(h.notes!, /Steps done: 2/);
  assert.match(readFileSync(join(paths(root).human, 'HT-1.yaml'), 'utf8'), /handoff_prompt: \|/, 'the handoff prompt keeps its block');
  assert.equal(lastCommit(root), 'Plan: HT-1 done (Sam, with helix-loop)');
});

// ---- what waits on you ----

test('the inbox lists Home\'s groups with the command for each; a fix is accepted and a request decided', async () => {
  const root = await project([task({ id: 'T-0001', status: 'needs_human', summary: 'The export test kept failing' }), task({ id: 'T-0002' }), task({ id: 'T-0003', status: 'needs_human' })]);
  const p = paths(root);
  writeFileSync(p.ledger, `${JSON.stringify({ kind: 'pass', at: new Date().toISOString(), task: 'T-0003', repo: 'acme-app', agent: 'codex', model: 'm', attempt: 1, outcome: 'gate_failed', durationMs: 60_000, costUsd: 1, tokens: { input: 0, cachedInput: 0, output: 0 }, log: 'runs/logs/x/T-0003-codex-1.log', failing: 'the export check' })}\n`);
  writeFileSync(p.incidents, `${JSON.stringify({ type: 'fix', key: 'gate:T-0003:the export check', fix: { id: 'F-1', at: new Date().toISOString(), by: 'helix', summary: 'Note the sandbox host', confidence: 0.8, changes: [{ op: 'note', task: 'T-0002', note: 'Use the sandbox host.' }] } })}\n`);
  writeFileSync(p.hitl, `${JSON.stringify({ type: 'raised', id: 'Q-1', at: new Date().toISOString(), request: 'scope', name: 'tasks that grew', tasks: ['T-0002'], question: 'Split T-0002?', options: [{ label: 'Keep going', changes: [{ op: 'note', task: 'T-0002', note: 'Keep going.' }] }, { label: 'Park it', changes: [{ op: 'park', task: 'T-0002' }] }], recommend: 0 })}\n`);
  const inbox = await ok(root, 'inbox');
  assert.match(inbox, /^\d\. needs you · T-0001 needs you/m);
  assert.match(inbox, /→ helix-loop task hand-back T-0001 --note "…"/);
  assert.match(inbox, /→ helix-loop asks, then helix-loop ask decide Q-1 <option>/);
  assert.match(inbox, /^\d\. fix ready · the export check/m);
  assert.match(inbox, /→ helix-loop incident F-1, then helix-loop fix accept F-1/);
  const groups = JSON.parse(await ok(root, 'inbox', '--json')) as { kind: string; command: string }[];
  assert.ok(groups.some((g) => g.kind === 'stopped' && g.command.startsWith('helix-loop task hand-back T-0001')));

  assert.match(await ok(root, 'incidents'), /^gate:T-0003:the export check {2}gate failure · 1 task · 1 time/m);
  assert.match(await ok(root, 'incident', 'gate:T-0003'), /· note on T-0002: Use the sandbox host\./, 'found by the start of its key');
  assert.match(await ok(root, 'fix', 'accept', 'F-1'), /^Applied F-1: Note the sandbox host\. Undo: helix-loop undo C-1$/);
  assert.equal(plan(root).tasks.get('T-0002')!.notes, 'Use the sandbox host.');
  assert.match((await cli(root, 'fix', 'decline', 'gate:T-0003:the export check')).err, /F-1 was accepted already/);

  assert.match(await ok(root, 'asks'), /1\) Keep going \(Helix recommends it\)/);
  assert.match(await ok(root, 'ask', 'decide', 'Q-1', '2', '--yes'), /^Decided Q-1: Park it\. Undo: helix-loop undo C-2$/);
  assert.equal(plan(root).tasks.get('T-0002')!.status, 'parked');
  assert.match((await cli(root, 'ask', 'decide', 'Q-1', '1', '--yes')).err, /Q-1 was decided already/);
});

// ---- the loop ----

test('a pass\'s log reads as what its builder did; watch on a task with no pass shows its last attempt', async () => {
  const root = await project([task({ id: 'T-0001', status: 'needs_human' })]);
  const rel = passLog(root, 'T-0001');
  writeFileSync(join(paths(root).tasks, 'T-0001.yaml'), stringify(task({ id: 'T-0001', status: 'needs_human', attempts: [{ agent: 'codex', outcome: 'gate_failed', at: '2026-10-27T10:00:00Z', log: rel }] })));
  const log = await ok(root, 'log', 'T-0001');
  assert.deepEqual(log.split('\n').map((l) => l.slice(0, 7).trim()), ['says', 'run', '', 'done', 'gate', 'gate', '', '', '']);
  assert.match(log, /^ {9}Gate failed at 20-unit$/m, 'a failed gate shows the end of its output');
  assert.match(log, /^run {4}✗ pnpm test$/m);
  assert.match(log, /^gate {3}✗ 20-unit$/m);
  assert.match(await ok(root, 'log', 'T-0001', '--gate'), /^> gate 20-unit: unit tests\n FAIL {2}\|unit\| export > writes a file\nGate failed at 20-unit/);
  assert.match(await ok(root, 'watch', 'T-0001'), /^T-0001 has no pass in flight\. Its last attempt, 1 on codex, ended: gate failed\./);
  assert.match((await cli(root, 'log', 'T-0001', '--attempt', '4')).err, /T-0001 has attempts 1 to 1/);
});

test('watch follows a pass in flight as its log grows, and stops when the pass ends', async (t) => {
  const root = await project([task({ id: 'T-0001', status: 'claimed', claimed_by: 'codex' })]);
  const p = paths(root);
  const startedAt = new Date().toISOString();
  const day = startedAt.slice(0, 10);
  const rel = `runs/logs/${day}/T-0001-codex-1.log`;
  mkdirSync(join(p.logs, day), { recursive: true });
  const file = join(p.home, rel);
  writeFileSync(file, `${JSON.stringify({ type: 'item.completed', item: { id: 'i1', type: 'agent_message', text: 'Starting on the export.' } })}\n`);
  writeFileSync(p.lock, String(process.pid));
  const live: LiveFile = { updatedAt: startedAt, pid: process.pid, passes: [{ id: 'T-0001:codex:1', task: 'T-0001', repo: 'acme-app', agent: 'codex', attempt: 1, startedAt, phase: 'agent', phaseAt: startedAt, toolCalls: 0, tokenHash: 'x' }] };
  writeFileSync(p.live, JSON.stringify(live));
  const lines: string[] = [];
  const ac = new AbortController();
  const following = follow(root, { task: 'T-0001', out: (l) => lines.push(l), signal: ac.signal, intervalMs: 30 });
  // However the test ends, the watch stops with it.
  t.after(() => ac.abort());
  const until = async (re: RegExp) => {
    for (let i = 0; i < 200 && !lines.some((l) => re.test(l)); i++) await new Promise((r) => setTimeout(r, 20));
    assert.ok(lines.some((l) => re.test(l)), `${re} in:\n${lines.join('\n')}`);
  };
  await until(/^ {9}says {3}Starting on the export\./);
  writeFileSync(file, `${readFileSync(file, 'utf8')}${JSON.stringify({ type: 'item.completed', item: { id: 'i2', type: 'command_execution', command: 'pnpm test', aggregated_output: 'ok', exit_code: 0, status: 'completed' } })}\n> gate 10-check: lint\n`);
  await until(/^\d\d:\d\d:\d\d run {4}✓ pnpm test$/);
  // The pass ends: the loop compresses its log.
  writeFileSync(`${file}.gz`, gzipSync(readFileSync(file)));
  rmSync(file);
  await Promise.race([following, new Promise((_, reject) => setTimeout(() => reject(new Error('watch did not stop')), 5000))]);
  ac.abort();
  assert.equal(lines[0], '▶ T-0001 on codex, attempt 1: CLI test task T-0001');
  assert.match(lines.join('\n'), /^( {9}|\d\d:\d\d:\d\d )gate {3}✓ 10-check$/m);
  assert.equal(lines.at(-1), '■ T-0001 attempt 1 ended');
});

// ---- Helix and settings ----

test('pilot mode and the monitor change as one commit each, and say how to go back', async () => {
  const root = await project();
  assert.match(await ok(root, 'pilot'), /^Active pilot, prudent \(Auto-pilot would be intrepid\)\./);
  assert.equal(await ok(root, 'pilot', 'auto', 'yolo'), 'Auto-pilot, yolo. It was Active pilot, prudent: helix-loop pilot active prudent');
  assert.deepEqual([loadConfig(root).pilot?.mode, loadConfig(root).pilot?.auto_level], ['auto', 'yolo']);
  assert.equal(lastCommit(root), 'Config: pilot.mode, pilot.auto_level (Sam, with helix-loop)');
  assert.match((await cli(root, 'pilot', 'active', 'reckless')).err, /Active pilot's level is cautious, prudent, intrepid/);

  assert.match(await ok(root, 'monitor', 'level', 'standard'), /^The monitor's level is standard, capped at \$15 a day\. Set it back: helix-loop monitor level light$/);
  assert.equal(loadConfig(root).helix?.monitor?.level, 'standard');
  assert.match((await cli(root, 'monitor', 'level', 'heavy')).err, /the monitor's level is light, standard, thorough/);
  await ok(root, 'monitor', 'cap', '8');
  assert.equal(loadConfig(root).helix?.monitor?.daily_budget_usd, 8);
  await ok(root, 'monitor', 'cap', 'default');
  assert.equal(loadConfig(root).helix?.monitor?.daily_budget_usd, undefined);
  assert.match((await cli(root, 'monitor', 'on')).err, /Add --yes/, 'turning the monitor on asks first, as the app does');
  await ok(root, 'monitor', 'on', '--yes');
  const m = JSON.parse(await ok(root, 'monitor', '--json'));
  assert.deepEqual([m.enabled, m.level, m.budgetUsd], [true, 'standard', 15]);
  assert.deepEqual(m.estimate.levels.map((l: { level: string }) => l.level), ['light', 'standard', 'thorough']);
});

test('config set writes a change set as one commit, get reads it back, and check refuses a bad value', async () => {
  const root = await project();
  const before = readFileSync(configPath(root), 'utf8');
  assert.match((await cli(root, 'config', 'set', 'limits.max_attempts=4')).err, /Add --yes/);
  const out = await ok(root, 'config', 'set', 'limits.max_attempts=4', 'agents.codex.slots=3', 'agents.codex.models.build=gpt-6.1-sol:xhigh', '--yes');
  assert.match(out, /^ {2}limits\.max_attempts: 3 → 4$/m);
  assert.match(out, /Set it back: helix-loop config set limits\.max_attempts=3 agents\.codex\.slots=2 agents\.codex\.models\.build=gpt-6\.1-sol:high$/);
  assert.equal(lastCommit(root), 'Config: limits.max_attempts, agents.codex.slots, agents.codex.models.build (Sam, with helix-loop)');
  assert.match(readFileSync(configPath(root), 'utf8'), /^# The CLI test's config\./, 'the comment survives');
  assert.notEqual(readFileSync(configPath(root), 'utf8'), before);
  assert.equal(await ok(root, 'config', 'get', 'limits.max_attempts'), '4');
  assert.equal(await ok(root, 'config', 'get', 'agents.codex.models.build'), 'gpt-6.1-sol:xhigh');
  assert.equal(await ok(root, 'config', 'get', 'agents.claude.weekly_target'), '85', 'in the units the app uses');
  assert.equal(await ok(root, 'config', 'check'), '.helix/config.yaml loads as the loop loads it.');
  const bad = await cli(root, 'config', 'check', 'limits.max_attempts=99');
  assert.equal(bad.code, 1);
  assert.match(bad.err, /between 1 and 10/);
  assert.match((await cli(root, 'config', 'set', 'repos.acme-app.gate=true', '--yes')).err, /isn't a setting the app changes/);
  await ok(root, 'feedback', 'set', 'flaky_test', 'after', 'tasks:3');
  assert.equal(loadConfig(root).feedback?.flaky_test?.after, 'tasks:3');
  assert.match((await cli(root, 'feedback', 'set', 'flaky_test', 'send_to', 'email')).err, /send_to is inbox, helix or off/);
});

test('--json prints stable JSON for everything that lists or shows', async () => {
  const root = await project([task({ id: 'T-0001', status: 'needs_human', notes: 'A note' })], [human({ id: 'HT-1' })]);
  const runs: [string[], (v: any) => void][] = [
    [['tasks'], (v) => assert.equal(v[0].id, 'T-0001')],
    [['task', 'T-0001'], (v) => assert.equal(v.task.status, 'needs_human')],
    [['task', 'notes', 'T-0001'], (v) => assert.deepEqual(v, { id: 'T-0001', notes: 'A note' })],
    [['human'], (v) => assert.equal(v[0].id, 'HT-1')],
    [['human', 'HT-1'], (v) => assert.equal(v.id, 'HT-1')],
    [['inbox'], (v) => assert.ok(Array.isArray(v))],
    [['incidents'], (v) => assert.deepEqual(v, [])],
    [['asks'], (v) => assert.deepEqual(v, [])],
    [['changes'], (v) => assert.deepEqual(v, [])],
    [['rules'], (v) => assert.deepEqual(v, [])],
    [['pilot'], (v) => assert.equal(v.mode, 'active')],
    [['monitor'], (v) => assert.equal(v.enabled, false)],
    [['config'], (v) => assert.ok(v.some((c: { key: string }) => c.key === 'limits.max_attempts'))],
    [['config', 'get', 'limits.max_attempts'], (v) => assert.deepEqual(v, { key: 'limits.max_attempts', value: 3 })],
    [['feedback'], (v) => assert.equal(v.kinds.length, 8)],
    [['prompts'], (v) => assert.ok(v.some((x: { name: string }) => x.name === 'assistant'))],
    [['prompt', 'show', 'assistant'], (v) => assert.equal(v.edited, false)],
    [['status'], (v) => assert.equal(v.totals.tasks, 1)],
  ];
  for (const [argv, check] of runs) check(JSON.parse(await ok(root, ...argv, '--json')));
});

test('ask says plainly when Helix has no agent it can run here, and runs no agent', async () => {
  const root = await project();
  const r = await cli(root, 'ask', 'Why', 'is', 'T-0001', 'stuck?');
  assert.equal(r.code, 1);
  assert.match(r.err, /^Helix isn't set up: it runs on Claude Code, and `.*no-such-claude` doesn't run here\./);
  assert.ok(!existsSync(paths(root).threads), 'no conversation was started');
});
