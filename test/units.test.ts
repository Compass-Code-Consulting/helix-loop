import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { test } from 'node:test';
import { parseResetTime, zonedToEpoch } from '../src/agents/resets.ts';
import { codexAdapter, resetFromRateLimits, usageFromRateLimits } from '../src/agents/codex.ts';
import { claudeAdapter, claudeUsage } from '../src/agents/claude.ts';
import { builderEnv, type Usage } from '../src/agents/adapter.ts';
import { describePace, loopMode, PACE_MARGIN, paceSlots } from '../src/agents/quota.ts';
import { VirtualClock, suspensionWatch } from '../src/clock.ts';
import { asset, configPath, loadConfig, paths } from '../src/config.ts';
import { firstFailure, globToRegExp, missingAcceptanceTests, offAreaPaths } from '../src/gate.ts';
import { secretFindings } from '../src/merge.ts';
import { sh } from '../src/proc.ts';
import { clipNote, clipSummary, NOTE_LIMIT } from '../src/summary.ts';
import { computeMap, rankTasks } from '../src/map/graph.ts';
import { validateGraph, validateReleaseHolds } from '../src/plan/validate.ts';
import { PromptOverBudget, renderPrompt, RETRY_RESERVE_BYTES } from '../src/prompt.ts';
import { conflictCount, countedAttempts, onlyHumanWorkLeft, pick } from '../src/sched/scheduler.ts';
import { buildIndex, loadIndex } from '../src/spec/index.ts';
import type { HumanTask, Plan, Task } from '../src/types.ts';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { parse, stringify } from 'yaml';
import { FIXTURE } from './fixture.ts';
import { planOf, storyOf } from './plans.ts';

const CHICAGO_NOON = zonedToEpoch(2026, 9, 23, 12, 0, 'America/Chicago'); // Oct 23 2026, 12:00 CDT

test('reset times: Claude session limit, the exact v1 message', () => {
  const t = parseResetTime("You've hit your session limit · resets 11:40pm (America/Chicago)", CHICAGO_NOON);
  assert.equal(t, zonedToEpoch(2026, 9, 23, 23, 40, 'America/Chicago'));
});

test('reset times: a time already past today means tomorrow', () => {
  const t = parseResetTime("You've hit your session limit · resets 1:10am (America/Chicago)", CHICAGO_NOON);
  assert.equal(t, zonedToEpoch(2026, 9, 24, 1, 10, 'America/Chicago'));
});

test('reset times: a minute-rounded time just past means the reset is due now, not tomorrow', () => {
  const justAfter = zonedToEpoch(2026, 9, 23, 12, 10, 'America/Chicago') + 20_000;
  const t = parseResetTime("You've hit your session limit · resets 12:10pm (America/Chicago)", justAfter);
  assert.equal(t, justAfter + 60_000);
});

test('reset times: weekly limit with a date', () => {
  const t = parseResetTime("You've hit your weekly limit · resets Oct 25, 3pm (America/Chicago)", CHICAGO_NOON);
  assert.equal(t, zonedToEpoch(2026, 9, 25, 15, 0, 'America/Chicago'));
});

test('reset times: Codex relative and absolute forms', () => {
  assert.equal(parseResetTime('You have hit your usage limit. Try again in 2 hours 5 minutes.', 1000), 1000 + 125 * 60_000);
  const abs = parseResetTime('Try again at Oct 25th, 2026 3:45 PM.', CHICAGO_NOON, 'America/Chicago');
  assert.equal(abs, zonedToEpoch(2026, 9, 25, 15, 45, 'America/Chicago'));
  assert.equal(parseResetTime("You've hit your usage limit.", 1000), null);
});

test('reset times: Codex rollout rate_limits, the exhausted window wins', () => {
  const line = JSON.stringify({ payload: { rate_limits: { primary: { used_percent: 100, resets_at: 1793374602 }, secondary: { used_percent: 40, resets_at: 1793999999 }, rate_limit_reached_type: 'primary' } } });
  assert.equal(resetFromRateLimits(line), 1793374602 * 1000);
  const fine = JSON.stringify({ rate_limits: { primary: { used_percent: 0, resets_at: 1 }, rate_limit_reached_type: null } });
  assert.equal(resetFromRateLimits(fine), null);
});

test('Claude adapter classifies the real result events', () => {
  const config = loadConfig(FIXTURE);
  const a = claudeAdapter(config.agents.claude, config);
  const limit = JSON.stringify({ type: 'result', is_error: true, api_error_status: 429, result: "You've hit your session limit · resets 11:40pm (America/Chicago)" });
  const r = a.interpret(limit, '', 1, CHICAGO_NOON) as ReturnType<typeof a.interpret> & { kind: string; resetAt: number };
  assert.equal(r.kind, 'limited');
  assert.equal(r.resetAt, zonedToEpoch(2026, 9, 23, 23, 40, 'America/Chicago'));
  const sleep = JSON.stringify({ type: 'result', is_error: true, result: 'API Error: Your computer went to sleep mid-response.' });
  assert.equal((a.interpret(sleep, '', 1, 0) as { kind: string }).kind, 'suspended');
  const ok = JSON.stringify({ type: 'result', is_error: false, result: 'T-0001: done', total_cost_usd: 1.25 });
  const okR = a.interpret(ok, '', 0, 0) as { kind: string; costUsd: number };
  assert.equal(okR.kind, 'ok');
  assert.equal(okR.costUsd, 1.25);
});

test('usage windows: Claude rate_limit_event lines and Codex rollout rate_limits', () => {
  // As Claude Code wrote it on 2026-10-25.
  const ev = JSON.parse(
    '{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","resetsAt":1792976400,"rateLimitType":"five_hour","overageStatus":"rejected","overageDisabledReason":"out_of_credits","isUsingOverage":false,"unifiedWindows":{"five_hour":{"utilization":0.04,"resetsAt":1792976400},"seven_day":{"utilization":0.72,"resetsAt":1793030400}}},"uuid":"615f9b30","session_id":"d25aef42"}',
  );
  assert.deepEqual(claudeUsage(ev, 5), { at: 5, session: { used: 0.04, resetsAt: 1792976400_000 }, weekly: { used: 0.72, resetsAt: 1793030400_000 } });
  assert.equal(claudeUsage({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } }, 5), undefined);
  // A pass reports the windows several times; the last report is the one kept.
  const config = loadConfig(FIXTURE);
  const later = { ...ev, rate_limit_info: { ...ev.rate_limit_info, unifiedWindows: { seven_day: { utilization: 0.73, resetsAt: 1793030400 } } } };
  const stdout = [ev, later, { type: 'result', is_error: false, result: 'T-0001: done', total_cost_usd: 1 }].map((e) => JSON.stringify(e)).join('\n');
  assert.equal((claudeAdapter(config.agents.claude, config).interpret(stdout, '', 0, 7) as { usage?: Usage }).usage?.weekly?.used, 0.73);
  // As Codex wrote it on 2026-10-25: one weekly window. Windows are told apart by their length.
  const weeklyOnly = JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', rate_limits: { limit_id: 'codex', primary: { used_percent: 13.0, window_minutes: 10080, resets_at: 1793513523 }, secondary: null, plan_type: 'pro', rate_limit_reached_type: null } } });
  assert.deepEqual(usageFromRateLimits(weeklyOnly, 5), { at: 5, weekly: { used: 0.13, resetsAt: 1793513523_000 } });
  const both = JSON.stringify({ rate_limits: { primary: { used_percent: 40, window_minutes: 300, resets_at: 10 }, secondary: { used_percent: 20, window_minutes: 10080, resets_at: 20 } } });
  assert.deepEqual(usageFromRateLimits(both, 5), { at: 5, session: { used: 0.4, resetsAt: 10_000 }, weekly: { used: 0.2, resetsAt: 20_000 } });
  assert.equal(usageFromRateLimits('{"rate_limits":{"primary":null}}', 5), undefined);
});

test('pace: every slot behind an even pace, one within the margin, none ahead of it until it catches up', () => {
  const now = Date.UTC(2026, 9, 25, 12);
  const week = 7 * 86_400_000;
  const at = (used: number, resetsIn: number): Usage => ({ at: now, weekly: { used, resetsAt: now + resetsIn } });
  // Half the week gone: an even pace to 90% allows 45%.
  assert.deepEqual(paceSlots(at(0.3, week / 2), 2, now, 0.9), { slots: 2, allowed: 0.45 });
  assert.equal(paceSlots(at(0.44, week / 2), 2, now, 0.9).slots, 1);
  assert.equal(paceSlots(at(0.46, week / 2), 2, now, 0.9).slots, 1);
  const ahead = paceSlots(at(0.6, week / 2), 2, now, 0.9);
  assert.equal(ahead.slots, 0);
  // It works again once the pace reaches what it used, less the margin.
  assert.equal(ahead.until, now + week / 2 - week * (1 - (0.6 - PACE_MARGIN) / 0.9));
  assert.match(describePace(at(0.6, week / 2), ahead, 0.9, now)!, /^no new passes until \w{3}, \w{3} \d+, \d+:\d\d\s[AP]M: 60% of its weekly window used, which resets \w{3}, \w{3} \d+, \d+:\d\d\s[AP]M; an even pace to 90% by then allows 45%$/);
  // Past the target it waits for the reset, and after the reset it has every slot again.
  assert.equal(paceSlots(at(0.95, week / 4), 2, now, 0.9).until, now + week / 4);
  assert.deepEqual(paceSlots(at(0.95, -1), 2, now, 0.9), { slots: 2 });
  // No target, or no reading yet: no pacing.
  assert.deepEqual(paceSlots(at(0.95, week / 4), 2, now, undefined), { slots: 2 });
  assert.deepEqual(paceSlots(undefined, 2, now, 0.9), { slots: 2 });
});

test("Codex adapter: a model at capacity is transient, not the task's failure", () => {
  const config = loadConfig(FIXTURE);
  const a = codexAdapter(config.agents.codex, config, '/nonexistent-codex-home');
  const msg = 'Selected model is at capacity. Please try a different model.';
  const stdout = [{ type: 'thread.started', thread_id: 't' }, { type: 'error', message: msg }, { type: 'turn.failed', error: { message: msg } }].map((e) => JSON.stringify(e)).join('\n');
  assert.equal((a.interpret(stdout, '', 1, 0) as { kind: string }).kind, 'transient');
});

test('suspension: a wall-clock jump the monotonic clock did not see', () => {
  const clock = new VirtualClock();
  const slept = suspensionWatch(clock, 30_000);
  assert.equal(slept(), false);
  clock.jumpWall(5 * 60_000);
  assert.equal(slept(), true);
});

test('the quota table', () => {
  assert.equal(loopMode({ claude: true, codex: true }, true), 'parallel');
  assert.equal(loopMode({ claude: false, codex: true }, true), 'single:codex');
  assert.equal(loopMode({ claude: true, codex: false }, true), 'single:claude');
  assert.equal(loopMode({ claude: false, codex: false }, true), 'paused');
});

test('forbidden-path globs', () => {
  assert.ok(globToRegExp('.github/workflows/**').test('.github/workflows/deploy.yml'));
  assert.ok(globToRegExp('**/*.pem').test('certs/a.pem'));
  assert.ok(globToRegExp('**/*.pem').test('a.pem'));
  assert.ok(globToRegExp('.env.*').test('.env.local'));
  assert.ok(!globToRegExp('.env').test('src/.env.ts'));
});

test('the PreToolUse hook denies background commands and writes outside the worktree', () => {
  const hook = asset('hooks', 'claude-pretooluse.ts');
  const call = (ev: object) => execFileSync('node', [hook], { input: JSON.stringify({ cwd: FIXTURE + '/worktrees/x/T-0001-claude', ...ev }) }).toString();
  const decision = (out: string) => (out ? JSON.parse(out).hookSpecificOutput.permissionDecision : 'allow');
  assert.equal(decision(call({ tool_name: 'Bash', tool_input: { command: 'npm test', run_in_background: true } })), 'deny');
  assert.equal(decision(call({ tool_name: 'Bash', tool_input: { command: 'npm test' } })), 'allow');
  assert.equal(decision(call({ tool_name: 'Write', tool_input: { file_path: 'src/a.ts' } })), 'allow');
  assert.equal(decision(call({ tool_name: 'Edit', tool_input: { file_path: '../../../plan/tasks/T-0001.yaml' } })), 'deny');
  assert.equal(decision(call({ tool_name: 'Write', tool_input: { file_path: '/etc/hosts' } })), 'deny');
});

test('spec index: every requirement of the spec resolves to its definition', () => {
  const p = paths(FIXTURE);
  const text = readFileSync(p.spec, 'utf8');
  const { index } = buildIndex(text);
  const defined = new Set([...text.matchAll(/\*\*([A-Z]{1,5}-\d+[a-z]?)\b/g)].map((m) => m[1]));
  assert.deepEqual(Object.keys(index.reqs).sort(), [...defined].sort());
  assert.equal(defined.size, 13);
  assert.match(index.version, /^\d+\.\d+(\.\d+)?$/);
  assert.equal(index.reqs['PB-14']!.section, '§11');
  assert.ok(index.sections['§11 Requirements']);
  assert.ok(index.sections['§10.5']);
  assert.equal(index.glossary, '§2');
});

// ---- plan helpers ----
function task(id: string, over: Partial<Task> = {}): Task {
  return {
    id, repo: 'acme-app', area: `area-${id}`, title: `Task ${id} title`, reqs: ['PB-14'],
    spec: ['§11 Requirements'], acceptance: [`unit: [PB-14] behaviour of ${id}`], blocked_by: [], estimate_passes: 1,
    status: 'ready', claimed_by: null, attempts: [], ...over, story: over.story ?? storyOf(over.repo ?? 'acme-app'),
  };
}
function human(id: string, over: Partial<HumanTask> = {}): HumanTask {
  return { id, title: `Human task ${id}`, done_check: 'it is done', lead_time_days: 2, agent_can_help: 'no', blocked_by: [], status: 'todo', ...over };
}

const opts = { now: 0, passHours: 1, agents: [], mode: 'idle' as const };

test('map: forward and backward pass, slack and critical path', () => {
  // A → B → D (3h) and A → C → D with C short: C has slack.
  const plan = planOf([
    task('T-0001'),
    task('T-0002', { blocked_by: ['T-0001'], estimate_passes: 2 }),
    task('T-0003', { blocked_by: ['T-0001'] }),
    task('T-0004', { blocked_by: ['T-0002', 'T-0003'] }),
  ]);
  const m = computeMap(plan, opts);
  const n = (id: string) => m.nodes.find((x) => x.id === id)!;
  assert.deepEqual(m.criticalPath, ['T-0001', 'T-0002', 'T-0004']);
  assert.equal(n('T-0003').slack, 1);
  assert.equal(n('T-0004').ef, 4);
  assert.deepEqual(rankTasks(m, plan).slice(0, 3), ['T-0001', 'T-0002', 'T-0004']);
});

test('map: fix-first outranks the critical path', () => {
  const plan = planOf([task('T-0001', { estimate_passes: 3 }), task('T-0002', { priority: 'fix_first' })]);
  assert.equal(rankTasks(computeMap(plan, opts), plan)[0], 'T-0002');
});

test('validate: cycles and dangling blockers are reported', () => {
  const plan = planOf([task('T-0001', { blocked_by: ['T-0002'] }), task('T-0002', { blocked_by: ['T-0001', 'HT-9'] })]);
  const msgs = validateGraph(plan).map((p) => p.message);
  assert.ok(msgs.some((m) => m.includes('cycle')));
  assert.ok(msgs.some((m) => m.includes('HT-9')));
});

test('scheduler: blockers and held areas; a later milestone is a priority, never a gate', () => {
  const plan = planOf([
    task('T-0001', { area: 'auth' }),
    task('T-0002', { area: 'auth' }),
    task('T-0003', { blocked_by: ['T-0001'] }),
    task('T-0004', { estimate_passes: 3 }),
  ], [], { 'T-0004': 'second' });
  const rank = rankTasks(computeMap(plan, opts), plan);
  assert.equal(rank.at(-1), 'T-0004', 'the later milestone ranks last, though it is the longest task');
  assert.equal(pick({ plan, rank, agent: 'claude', heldAreas: new Set(), maxAttempts: 3 })?.id, 'T-0001');
  // Nothing earlier can start while auth is held: the later milestone's work runs rather than nothing.
  assert.equal(pick({ plan, rank, agent: 'codex', heldAreas: new Set(['auth']), maxAttempts: 3 })?.id, 'T-0004');
});

test('scheduler: fix-first work comes before the earliest milestone, and stays pickable', () => {
  const plan = planOf([task('T-0001', { status: 'done' }), task('T-0002', { priority: 'fix_first' }), task('T-0003')], [], { 'T-0002': 'second' });
  const rank = rankTasks(computeMap(plan, opts), plan);
  assert.deepEqual(rank.slice(0, 2), ['T-0002', 'T-0003']);
  assert.equal(pick({ plan, rank, agent: 'claude', heldAreas: new Set(), maxAttempts: 3 })?.id, 'T-0002');
  assert.equal(pick({ plan, rank, agent: 'claude', heldAreas: new Set(['area-T-0002']), maxAttempts: 3 })?.id, 'T-0003');
});

test('scheduler: a task failed twice by one agent goes to the other for its third attempt', () => {
  const failed = { agent: 'claude' as const, outcome: 'gate_failed' as const, at: '', log: '' };
  const quota = { agent: 'claude' as const, outcome: 'quota' as const, at: '', log: '' };
  const plan = planOf([task('T-0001', { attempts: [failed, quota, failed] })]);
  const rank = ['T-0001'];
  assert.equal(pick({ plan, rank, agent: 'claude', heldAreas: new Set(), maxAttempts: 3 }), undefined);
  assert.equal(pick({ plan, rank, agent: 'codex', heldAreas: new Set(), maxAttempts: 3 })?.id, 'T-0001');
});

test('scheduler: only human work left', () => {
  const plan = planOf([task('T-0001', { blocked_by: ['HT-1'] }), task('T-0002', { status: 'needs_human' }), task('T-0003', { status: 'done' })], [human('HT-1')]);
  assert.equal(onlyHumanWorkLeft(plan), true);
  plan.human.get('HT-1')!.status = 'done';
  assert.equal(onlyHumanWorkLeft(plan), false);
});

test('prompt: injects only the cited spec and fails loudly over budget', () => {
  const p = paths(FIXTURE);
  const index = loadIndex(p.specIndex);
  const template = readFileSync(join(p.prompts, 'build.md'), 'utf8');
  const t = task('T-0001', { reqs: ['PB-14', 'OPS-1'] });
  const out = renderPrompt({ template, task: t, index, sectionsDir: p.specSections, budgetBytes: 40_000 });
  assert.match(out, /\*\*PB-14/);
  assert.match(out, /\*\*OPS-1/);
  assert.doesNotMatch(out, /\*\*NAV-1\b/);
  assert.ok(Buffer.byteLength(out) < 40_000);
  assert.throws(() => renderPrompt({ template, task: { ...t, spec: ['§10', '§15', '§19'] }, index, sectionsDir: p.specSections, budgetBytes: Buffer.byteLength(out) }), PromptOverBudget);
});

test("prompt: a retry's note on the last attempt fits the room the spec leaves, keeping its first line and its end", () => {
  const p = paths(FIXTURE);
  const index = loadIndex(p.specIndex);
  const template = readFileSync(join(p.prompts, 'build.md'), 'utf8');
  const t = task('T-0001', { reqs: ['PB-14', 'OPS-1'] });
  const bare = Buffer.byteLength(renderPrompt({ template, task: t, index, sectionsDir: p.specSections, budgetBytes: 40_000 }));
  const note = ['the gate failed: Error: the real failure', ...Array.from({ length: 400 }, (_, i) => `noise line ${i} ✓`), 'Error: the last line names it'].join('\n');
  const budget = bare + RETRY_RESERVE_BYTES;
  const out = renderPrompt({ template, task: t, index, sectionsDir: p.specSections, budgetBytes: budget, retryLog: note });
  assert.ok(Buffer.byteLength(out) <= budget, `${Buffer.byteLength(out)} bytes over ${budget}`);
  assert.match(out, /## Your previous attempt failed/);
  assert.match(out, /the gate failed: Error: the real failure\n\[…\]\n/);
  assert.match(out, /Error: the last line names it\n```/);
  assert.throws(() => renderPrompt({ template, task: t, index, sectionsDir: p.specSections, budgetBytes: budget - 1, retryLog: note }), PromptOverBudget, 'the spec must leave the reserve free');
});

test('prompt: carried work is always announced, then the conflicts git left and the last note, in the room left', () => {
  const p = paths(FIXTURE);
  const index = loadIndex(p.specIndex);
  const template = readFileSync(join(p.prompts, 'build.md'), 'utf8');
  const t = task('T-0001', { reqs: ['PB-14', 'OPS-1'] });
  const bare = Buffer.byteLength(renderPrompt({ template, task: t, index, sectionsDir: p.specSections, budgetBytes: 40_000 }));
  const carried = { branch: 'task/T-0001-claude-1', why: 'moved' as const, conflicts: Array.from({ length: 30 }, (_, i) => `CONFLICT (content): Merge conflict in src/file-${i}.ts`) };
  const note = 'rebase onto main conflicts in: src/file-0.ts';
  const roomy = renderPrompt({ template, task: t, index, sectionsDir: p.specSections, budgetBytes: 40_000, retryLog: note, carried });
  assert.match(roomy, /## Your earlier work on this task is in your worktree\n\n.*kept on branch `task\/T-0001-claude-1`/);
  assert.match(roomy, /`<<<<<<< HEAD` opens the current main's side.*\n\n- CONFLICT \(content\): Merge conflict in src\/file-0\.ts\n/);
  assert.match(roomy, /- CONFLICT \(content\): Merge conflict in src\/file-29\.ts\n\nThe end of the last failed attempt's output:\n\n```text\nrebase onto main conflicts in: src\/file-0\.ts\n```/);
  assert.doesNotMatch(roomy, /Your previous attempt failed|you are starting again from `main`/);
  // At the reserve alone, the announcement still fits; the conflicts list as many as fit, then a count.
  const tight = bare + RETRY_RESERVE_BYTES;
  const out = renderPrompt({ template, task: t, index, sectionsDir: p.specSections, budgetBytes: tight, retryLog: note, carried });
  assert.ok(Buffer.byteLength(out) <= tight, `${Buffer.byteLength(out)} bytes over ${tight}`);
  assert.match(out, /## Your earlier work on this task is in your worktree/);
  assert.match(out, /- CONFLICT \(content\): Merge conflict in src\/file-0\.ts\n(?:.*\n)*- … and \d+ more/);
});

test("prompt: a note or spec text holding $&, $' or $$ goes in as written", () => {
  const p = paths(FIXTURE);
  const index = loadIndex(p.specIndex);
  const template = readFileSync(join(p.prompts, 'build.md'), 'utf8');
  const note = "the gate failed: kill $$ said $& and $' and $`";
  const out = renderPrompt({ template, task: task('T-0001', { reqs: ['PB-14'] }), index, sectionsDir: p.specSections, budgetBytes: 40_000, retryLog: note });
  assert.ok(out.includes(`\`\`\`text\n${note}\n\`\`\``), 'the note is verbatim');
});

test('scheduler: a pinned task goes only to its agent, even for a third attempt', () => {
  const failed = { agent: 'codex' as const, outcome: 'gate_failed' as const, at: '', log: '' };
  const plan = planOf([task('T-0001', { agent: 'codex', role: 'design', attempts: [failed, failed] })]);
  const rank = ['T-0001'];
  assert.equal(pick({ plan, rank, agent: 'claude', heldAreas: new Set(), maxAttempts: 3 }), undefined);
  assert.equal(pick({ plan, rank, agent: 'codex', heldAreas: new Set(), maxAttempts: 3 })?.id, 'T-0001');
});

test('release tags follow v<YYYY>.<MM>.<DD>.<N>, counting that day per repo', async () => {
  const { releaseTagName } = await import('../src/release.ts');
  const day = new Date(2026, 9, 23, 15).getTime();
  assert.equal(releaseTagName([], day), 'v2026.10.23.1');
  assert.equal(releaseTagName(['v2026.10.23.1', 'v2026.10.22.4'], day), 'v2026.10.23.2');
  // A gap in the day's sequence never makes the next name collide with a tag that exists.
  assert.equal(releaseTagName(['v2026.10.23.1', 'v2026.10.23.3'], day), 'v2026.10.23.4');
  assert.equal(releaseTagName(['v2026.10.23.9', 'v2026.10.23.10'], day), 'v2026.10.23.11');
});

test('the design role runs each agent on its design model and effort: Astra for Codex', () => {
  const config = loadConfig(FIXTURE);
  const codex = codexAdapter(config.agents.codex, config).invocation('design', '/tmp/w', 'prompt').args;
  assert.equal(codex[codex.indexOf('-m') + 1], 'gpt-6-astra');
  assert.ok(codex.includes(`model_reasoning_effort="${config.agents.codex.models.design.effort}"`), codex.join(' '));
  const claude = claudeAdapter(config.agents.claude, config).invocation('design', '/tmp/w', 'prompt').args;
  assert.equal(claude[claude.indexOf('--model') + 1], config.agents.claude.models.design.model);
  assert.equal(claude[claude.indexOf('--effort') + 1], config.agents.claude.models.design.effort);
  // Each adapter reads the role's own entry, not the build one: give every role a distinct model and check.
  for (const name of ['claude', 'codex'] as const) {
    const agent = structuredClone(config.agents[name]);
    for (const role of ['build', 'design', 'plan', 'review'] as const) agent.models[role] = { model: `${name}-${role}-model`, effort: `${role}-effort` };
    const adapter = name === 'claude' ? claudeAdapter(agent, config) : codexAdapter(agent, config);
    const args = adapter.invocation('design', '/tmp/w', 'prompt').args;
    assert.ok(args.includes(`${name}-design-model`) && !args.includes(`${name}-build-model`), args.join(' '));
    assert.ok(args.some((a) => a.includes('design-effort')) && !args.some((a) => a.includes('build-effort')), args.join(' '));
  }
});

test('validate: a release hold must name a human task in the plan', () => {
  const plan = planOf([], [human('HT-25')]);
  assert.deepEqual(validateReleaseHolds(plan, { 'acme-website': 'HT-25' }), []);
  assert.deepEqual(validateReleaseHolds(plan, {}), []);
  const [problem] = validateReleaseHolds(plan, { 'acme-website': 'HT-26' });
  assert.equal(problem?.message, "release.hold_until holds acme-website's releases until HT-26, which is not a human task in the plan");
});

test('config: a release hold must name a known repo and a human task', () => {
  const raw = parse(readFileSync(configPath(FIXTURE), 'utf8')) as { release: object };
  const file = join(mkdtempSync(join(tmpdir(), 'mushy-config-')), 'config.yaml');
  const withHold = (hold: Record<string, string>) => {
    writeFileSync(file, stringify({ ...raw, release: { ...raw.release, hold_until: hold } }));
    return () => loadConfig(FIXTURE, file);
  };
  assert.deepEqual(withHold({ 'acme-website': 'HT-25' })().release.hold_until, { 'acme-website': 'HT-25' });
  // A misspelt repo would hold nothing, so it is refused rather than ignored.
  assert.throws(withHold({ 'mushy-websit': 'HT-25' }), /release\.hold_until\.mushy-websit is not a repo/);
  assert.throws(withHold({ 'acme-website': 'approved' }), /must name a human task/);
});

test('scheduler: work behind a person, even through a diamond of tasks, never holds back a later milestone', () => {
  const plan = planOf(
    [
      task('T-0001', { blocked_by: ['HT-4'] }),
      task('T-0002', { blocked_by: ['T-0001'] }),
      task('T-0003', { blocked_by: ['T-0001'] }),
      task('T-0004', { blocked_by: ['T-0002', 'T-0003'] }),
      task('T-0005'),
    ],
    [human('HT-4')],
    { 'T-0005': 'second' },
  );
  const rank = rankTasks(computeMap(plan, opts), plan);
  assert.equal(pick({ plan, rank, agent: 'claude', heldAreas: new Set(), maxAttempts: 3 })?.id, 'T-0005');
  plan.tasks.get('T-0003')!.blocked_by = [];
  assert.equal(pick({ plan, rank: rankTasks(computeMap(plan, opts), plan), agent: 'claude', heldAreas: new Set(), maxAttempts: 3 })?.id, 'T-0003', 'work it can do in the earlier milestone comes first');
});

test('builders get the loop\'s environment without what a parent Claude Code or Codex session would pass on', () => {
  const env = builderEnv({
    PATH: '/usr/bin', HOME: '/Users/daniel', LANG: 'en_US.UTF-8', TMPDIR: '/tmp', GIT_EDITOR: 'true', HELIX_FAKE_STATE: '/tmp/state',
    CLAUDECODE: '1', CLAUDE_EFFORT: 'max', CLAUDE_CODE_SESSION_ID: 'parent', CLAUDE_AGENT_SDK_VERSION: '0.3.309', CLAUDE_PID: '1',
    CODEX_SANDBOX: 'seatbelt', CODEX_HOME: '/parent/.codex', AI_AGENT: 'claude-code', MCP_CONNECTION_NONBLOCKING: 'true',
    VSCODE_IPC_HOOK: '/tmp/vscode.sock', ELECTRON_RUN_AS_NODE: '1', ANTHROPIC_API_KEY: 'not-a-key', OPENAI_BASE_URL: 'https://example.com',
  });
  // CODEX_HOME goes too: the codex adapter sets the one the loop uses.
  assert.deepEqual(Object.keys(env).sort(), ['GIT_EDITOR', 'HELIX_FAKE_STATE', 'HOME', 'LANG', 'PATH', 'TMPDIR']);
});

test('validate: any task may wait on a design-role task', () => {
  const design = { agent: 'codex' as const, role: 'design' as const };
  const plan = planOf([
    task('T-0001'),
    task('T-0002', { blocked_by: ['T-3100'] }),
    task('T-3100', design),
    task('T-3101', { ...design, blocked_by: ['T-3100', 'T-0001'] }),
  ]);
  assert.deepEqual(validateGraph(plan), []);
});

test('restricted paths: only the design-guide area changes branding/, and only ci the workflows', () => {
  const { restricted_paths } = loadConfig(FIXTURE);
  const changed = ['branding/README.md', 'branding/assets/mascot/mushy-waving.svg', '.github/workflows/ci.yml', 'src/assets/brand/branding/x.svg', 'src/index.ts'];
  assert.deepEqual(offAreaPaths(changed, restricted_paths, 'docs/branding'), ['.github/workflows/ci.yml']);
  assert.deepEqual(offAreaPaths(changed, restricted_paths, 'docs/branding/mascot'), ['.github/workflows/ci.yml'], 'areas below it may too');
  assert.deepEqual(offAreaPaths(changed, restricted_paths, 'docs/theme'), ['branding/README.md', 'branding/assets/mascot/mushy-waving.svg', '.github/workflows/ci.yml']);
  assert.deepEqual(offAreaPaths(changed, restricted_paths, 'ci'), ['branding/README.md', 'branding/assets/mascot/mushy-waving.svg']);
});

test('config: release review paths are .github/ and infra/ by default, and never an empty list', () => {
  assert.deepEqual(loadConfig(FIXTURE).release.review_paths, ['.github/**', 'infra/**']);
  const raw = parse(readFileSync(configPath(FIXTURE), 'utf8')) as { release: Record<string, unknown> };
  const file = join(mkdtempSync(join(tmpdir(), 'mushy-config-')), 'config.yaml');
  const withRelease = (release: object) => {
    writeFileSync(file, stringify({ ...raw, release }));
    return () => loadConfig(FIXTURE, file);
  };
  const { review_paths: listed, ...rest } = raw.release;
  assert.ok(listed, 'the real config lists them');
  assert.deepEqual(withRelease(rest)().release.review_paths, ['.github/**', 'infra/**']);
  assert.throws(withRelease({ ...rest, review_paths: [] }), /must list at least one path glob/);
});

test('summaries: one line under 144 characters, clipped at a word boundary', () => {
  assert.equal(clipSummary('  gate failed:\n   no test\tis titled  '), 'gate failed: no test is titled');
  const fits = 'x'.repeat(143);
  assert.equal(clipSummary(fits), fits);
  assert.equal(clipSummary(`${fits}y`).length, 143, 'one word too long for the room is cut where the room ends');
  const words = Array.from({ length: 40 }, (_, i) => `word${i}`).join(' ');
  const clipped = clipSummary(words);
  assert.ok(clipped.length < 144 && clipped.endsWith('…'), clipped);
  const kept = clipped.slice(0, -1);
  assert.ok(words.startsWith(kept) && words[kept.length] === ' ', `cut between words: ${clipped}`);
  const listed = clipSummary(Array.from({ length: 40 }, () => 'item,').join(' '));
  assert.match(listed, /item…$/, 'no comma left before the ellipsis');
});

test('notes: a long one keeps its first line and its end, and loses its middle', () => {
  assert.equal(clipNote('the gate failed: x\n\nshort'), 'the gate failed: x\n\nshort');
  const build = Array.from({ length: 300 }, (_, i) => `building module ${i}`);
  const long = ['the gate failed: Error: Unapproved dependency licence', '', ...build, 'Error: Unapproved dependency licence: @img/sharp-wasm32'].join('\n');
  const clipped = clipNote(long);
  assert.equal(clipped.length, NOTE_LIMIT);
  assert.ok(clipped.startsWith('the gate failed: Error: Unapproved dependency licence\n[…]\n'), clipped.slice(0, 80));
  assert.ok(clipped.endsWith('\nError: Unapproved dependency licence: @img/sharp-wasm32'));
  assert.equal(clipNote('y'.repeat(9000)).length, NOTE_LIMIT, 'one long line too');
});

test('a failed gate run is summarised by the first failing test or step it names', () => {
  const vitest = [' RUN  v3.2.4 /w', ' ❯ src/a.test.ts (2 tests | 1 failed) 5ms', '   \x1b[31m×\x1b[39m adds numbers 3ms', '', ' FAIL  src/a.test.ts > adds numbers', 'AssertionError: expected 1 to be 2'];
  assert.equal(firstFailure(vitest.join('\n')), 'src/a.test.ts > adds numbers');
  assert.equal(firstFailure('✔ parses an id (1.2ms)\n✖ rejects a bad id (0.8ms)\n  AssertionError [ERR_ASSERTION]\n✖ failing tests:'), 'rejects a bad id');
  const playwright = ['Running 3 tests using 1 worker', '  ✘  1 [chromium] › e2e/home.spec.ts:12:5 › shows Mushy (1.2s)', '', '  1) [chromium] › e2e/home.spec.ts:12:5 › shows Mushy ────────────'];
  assert.equal(firstFailure(playwright.join('\n')), '[chromium] › e2e/home.spec.ts:12:5 › shows Mushy');
  assert.equal(firstFailure("> tsc --noEmit\nsrc/a.ts(3,7): error TS2322: Type 'string' is not assignable to type 'number'."), "src/a.ts(3,7): error TS2322: Type 'string' is not assignable to type 'number'.");
  const eslint = ['', '/w/src/a.ts', "  3:7  error  'x' is assigned a value but never used  no-unused-vars", '', '✖ 1 problem (1 error, 0 warnings)'];
  assert.equal(firstFailure(eslint.join('\n')), "/w/src/a.ts 3:7 error 'x' is assigned a value but never used no-unused-vars");
  assert.equal(firstFailure("building\nError: Cannot find module 'x'\n    at load (node:internal)"), "Error: Cannot find module 'x'");
  assert.equal(firstFailure('one line, nothing marked'), 'one line, nothing marked');
  // A gate script's uncaught exception, as pnpm prints it, with the package manager's line after it.
  const crashed = ['Checking 95-lighthouse.ts', "  if (problems.length) throw new Error(problems.join('\\n'));", '                             ^', '', 'Error: Error: No Chromium debugging port assigned', '    at checkMobileLighthouse (/w/scripts/lib/mobile-lighthouse.ts:114:30)', '', 'Node.js v26.10.0', '[ELIFECYCLE] Command failed with exit code 1.'];
  assert.equal(firstFailure(crashed.join('\n')), 'Error: Error: No Chromium debugging port assigned');
  assert.equal(firstFailure('Error: expected, logged by a passing test\nrunning\nTypeError: x is not a function'), 'TypeError: x is not a function', 'the last uncaught error, not one logged earlier');
  assert.equal(firstFailure('Checking 60-links.ts\n[ELIFECYCLE] Command failed with exit code 1.'), 'Checking 60-links.ts', 'the step that was running, not the wrapper');
  assert.equal(firstFailure('[ELIFECYCLE] Command failed with exit code 1.'), undefined);
  // A gate runner stops at the failing step: look there, and never at a command it echoes or an earlier step's output.
  const badCode = ['> gate 40-lint: pnpm lint', '$ eslint .', '> gate 47-error-codes: pnpm check:errors', '$ node scripts/checks/errors.ts', 'apps/web/src/settings-pages.tsx:72: raised error needs a registered code and docs link.', '[ELIFECYCLE] Command failed with exit code 1.', 'Gate failed at 47-error-codes (exit 1)'];
  assert.equal(firstFailure(badCode.join('\n')), 'apps/web/src/settings-pages.tsx:72: raised error needs a registered code and docs link.');
  const laterStep = ['> gate 47-error-codes: pnpm check:errors', '$ node scripts/checks/errors.ts', 'Error code check passed: product errors use registered codes and docs links.', '> gate 75-integration: pnpm test:integration', '$ vitest run --project integration', 'error: terminating connection due to administrator command', 'Gate failed at 75-integration (exit 1)'];
  assert.equal(firstFailure(laterStep.join('\n')), 'error: terminating connection due to administrator command', 'not the passing step that says "Error code"');
  assert.equal(firstFailure('\n\n'), undefined);
});

test('a command\'s output keeps stdout and stderr in the order they arrived', async () => {
  const res = await sh("echo one; sleep 0.1; echo two >&2; sleep 0.1; echo three", { cwd: tmpdir() });
  assert.equal(res.output, 'one\ntwo\nthree\n');
  assert.equal(res.stdout, 'one\nthree\n');
  assert.equal(res.stderr, 'two\n');
});

test('a builder\'s command runs at a lower CPU priority, and so does everything it starts', async () => {
  const base = Number((await sh('ps -o nice= -p $PPID', { cwd: tmpdir() })).stdout.trim()); // this test's own
  const res = await sh('sleep 0.2; ps -o nice= -p $$; sh -c \'ps -o nice= -p $$\'', { cwd: tmpdir(), nice: 10 });
  const want = String(Math.max(base, 10)); // a process may lower its priority, never raise it
  assert.deepEqual(res.stdout.trim().split(/\s+/), [want, want]);
  assert.equal((await sh('ps -o nice= -p $$', { cwd: tmpdir() })).stdout.trim(), String(base), 'without it, a command keeps the loop\'s priority');
});

test('an acceptance line may be split the ways a line-length rule forces, and still counts word for word', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mushy-acceptance-'));
  const long = '[BLD-9] the CI workflow runs pnpm gate against a Postgres 16 service on pull requests and on manual dispatch, never on a schedule or on pushes to main';
  writeFileSync(
    join(dir, 'joined.test.ts'),
    `it(\n  "[BLD-9] the CI workflow runs pnpm gate against a Postgres 16 service on pull requests and on manual dispatch, " +\n    "never on a schedule or on pushes to main",\n  () => {},\n);\n`,
  );
  writeFileSync(join(dir, 'continued.test.ts'), `it("[BLD-1] one long title \\\ncontinued on the next line", () => {});\n`);
  const task = { acceptance: [`unit: ${long}`, 'unit: [BLD-1] one long title continued on the next line', 'unit: [BLD-2] a title no test has'] } as Task;
  assert.deepEqual(missingAcceptanceTests(dir, task), ['[BLD-2] a title no test has']);
});

test('merge conflicts are not counted as attempts, and are counted on their own', () => {
  const at = (outcome: Task['attempts'][number]['outcome'], agent: 'claude' | 'codex' = 'codex') => ({ agent, outcome, at: '', log: '' });
  const task = { attempts: [at('gate_failed'), at('conflict', 'claude'), at('quota'), at('conflict')] } as Task;
  assert.equal(countedAttempts(task), 1);
  assert.equal(countedAttempts(task, 'claude'), 0);
  assert.equal(conflictCount(task), 2);
});

test("gitleaks' verbose report gives each finding's rule, file and line, and never the value", () => {
  const report = [
    '\x1b[90m3:37AM\x1b[0m INF 2 commits scanned.',
    'Finding:     aws: "REDACTED",', 'Secret:      REDACTED', 'RuleID:      aws-access-token', 'Entropy:     4.121928',
    'File:        src/fixtures.test.ts', 'Line:        3', 'Commit:      b023e94', 'Fingerprint: b023e94:src/fixtures.test.ts:aws-access-token:3', '',
    'Finding:     stripe: "REDACTED"', 'Secret:      REDACTED', 'RuleID:      stripe-access-token', 'Entropy:     4.875000',
    'File:        src/fixtures.test.ts', 'Line:        2', 'Commit:      b023e94', '',
    '3:37AM WRN leaks found: 2',
  ].join('\n');
  assert.deepEqual(secretFindings(report), [
    { rule: 'aws-access-token', file: 'src/fixtures.test.ts', line: '3' },
    { rule: 'stripe-access-token', file: 'src/fixtures.test.ts', line: '2' },
  ]);
  assert.deepEqual(secretFindings('3:37AM INF no leaks found'), []);
});

test('prompt: carried work is introduced by why it did not merge', () => {
  const p = paths(FIXTURE);
  const index = loadIndex(p.specIndex);
  const template = readFileSync(join(p.prompts, 'build.md'), 'utf8');
  const render = (why: 'moved' | 'failed' | 'cut' | 'blocked') =>
    renderPrompt({ template, task: task('T-0001', { reqs: ['PB-14'] }), index, sectionsDir: p.specSections, budgetBytes: 40_000, carried: { branch: 'task/T-0001-codex-2', why, conflicts: [] } });
  assert.match(render('moved'), /An earlier attempt's work passed its gate but could not merge, because `main` changed under it\. .*Build on it rather than starting over: check it against the current code,/);
  assert.match(render('failed'), /Your last attempt's work failed the gate; the end of its output is below\. .*: fix what failed,/);
  assert.match(render('cut'), /An earlier attempt was stopped before it finished: .*: finish it,/);
  assert.match(render('blocked'), /An earlier attempt stopped as blocked; the task's notes say how a person answered\. .*: finish it as the notes now say,/);
});

test('semaphore: no more than its limit run at once, and the rest go in turn', async () => {
  const { Semaphore } = await import('../src/semaphore.ts');
  const gates = new Semaphore(2);
  let running = 0;
  let most = 0;
  const order: number[] = [];
  const job = (n: number, ms: number) =>
    gates.run(async () => {
      running++;
      most = Math.max(most, running);
      await new Promise((r) => setTimeout(r, ms));
      order.push(n);
      running--;
      return n;
    });
  const results = await Promise.all([job(1, 30), job(2, 10), job(3, 5), job(4, 5)]);
  assert.deepEqual(results, [1, 2, 3, 4]);
  assert.equal(most, 2);
  assert.deepEqual(order.slice(0, 2), [2, 3], 'the third starts as soon as the second ends');
  assert.equal(gates.busy, 0);
  await assert.rejects(gates.run(async () => { throw new Error('boom'); }), /boom/);
  assert.equal(gates.busy, 0, 'a failed holder still frees its place');
});

test('flaky tests: the failing test is read from the gate, and its fix-first task is filed with the evidence', async () => {
  const { failingTest, filedFor, fixTaskFor, nextFixId, FILED_MARK } = await import('../src/flaky.ts');
  assert.deepEqual(failingTest('|integration| apps/api/src/ops.integration.test.ts > operations > [AD-1] commits together'), { kind: 'integration', file: 'apps/api/src/ops.integration.test.ts', title: '[AD-1] commits together' });
  assert.deepEqual(failingTest('[chromium] › e2e/app-sign-in.e2e.test.ts:124:1 › [SGN-11] signing out'), { kind: 'e2e', file: 'e2e/app-sign-in.e2e.test.ts', title: '[SGN-11] signing out' });
  assert.deepEqual(failingTest('[chromium] › tests/e2e/mascot.spec.ts › 360px › [MA-1] peeks'), { kind: 'e2e', file: 'tests/e2e/mascot.spec.ts', title: '[MA-1] peeks' });
  assert.equal(failingTest('gitleaks flagged src/a.ts:1 (generic-api-key)'), undefined);
  const plan = planOf([task('T-0001'), task('T-0047'), task('T-0102')]);
  assert.equal(nextFixId(plan), 'T-0048');
  assert.equal(nextFixId(plan, (id) => id === 'T-0048'), 'T-0049', 'a task file the loop has not loaded yet keeps its id');
  const first = task('T-0102', { reqs: ['PB-14'], spec: ['§11'] });
  const failures = [1, 2].map((n) => ({ task: `T-010${n}`, agent: 'claude', attempt: 1, at: Date.UTC(2026, 9, 25, 17), log: `runs/logs/x-${n}.log.gz`, line: '|unit| a.test.ts > [XX-9] races' }));
  const fix = fixTaskFor({ id: 'T-0048', signature: '|unit| a.test.ts > [XX-9] races', failures, first, knownReq: () => false, timeZone: 'America/Chicago', passMinutes: 60 })!;
  assert.deepEqual(fix.reqs, ['PB-14'], 'an unknown tag falls back to the first failing task’s requirement');
  assert.match(fix.notes!, /Your pass ends after 60 minutes, .* to about 20 minutes\. Run them one at a time/, 'the repeated runs are bounded by the pass’s time limit');
  assert.deepEqual(fix.acceptance, ['unit: [XX-9] races']);
  assert.equal(fix.priority, 'fix_first');
  assert.ok(fix.title.length <= 160);
  assert.ok(fix.notes!.startsWith(`${FILED_MARK} |unit| a.test.ts > [XX-9] races`));
  assert.equal(filedFor(fix), '|unit| a.test.ts > [XX-9] races');
  const long = fixTaskFor({ id: 'T-0048', signature: `|integration| a.test.ts > [PB-14] ${'x'.repeat(300)}`, failures, first, knownReq: (r) => r === 'PB-14', timeZone: 'America/Chicago', passMinutes: 60 })!;
  assert.ok(long.title.length <= 160, `${long.title.length}`);
  assert.deepEqual(long.reqs, ['PB-14']);
  const shared = fixTaskFor({ id: 'T-0048', signature: '[chromium] › e2e/features.e2e.test.ts:6:1 › [FG-1, PLT-5, XX-9] lists features', failures, first, knownReq: (r) => r !== 'XX-9', timeZone: 'America/Chicago', passMinutes: 60 })!;
  assert.deepEqual(shared.reqs, ['FG-1', 'PLT-5'], 'every requirement the test is tagged with that the plan knows');
});

test('flaky tests: a fix parked as not reproducible is ready again once its test fails two more tasks after its last attempt', async () => {
  const { reopenedFix, filedFor, FILED_MARK } = await import('../src/flaky.ts');
  const at = (h: number) => Date.UTC(2026, 9, 26, h);
  const attempt = { agent: 'codex' as const, outcome: 'no_commit' as const, at: new Date(at(12)).toISOString(), log: 'runs/logs/x.log.gz', note: 'BLOCKED: not reproducible' };
  const parked = task('T-0056', { priority: 'fix_first', status: 'parked', attempts: [attempt], notes: `${FILED_MARK} |unit| a.test.ts > [XX-9] races\nIt failed 2 passes` });
  const seen = (t: string, h: number) => ({ task: t, agent: 'claude', attempt: 1, at: at(h), log: `runs/logs/${t}.log.gz`, line: '|unit| a.test.ts > [XX-9] races' });
  assert.equal(reopenedFix({ ...parked, status: 'ready' }, [seen('T-0201', 13), seen('T-0202', 14)], 'UTC'), undefined, 'only a parked fix is reopened');
  assert.equal(reopenedFix(parked, [seen('T-0201', 10), seen('T-0202', 11), seen('T-0203', 13)], 'UTC'), undefined, 'failures its attempt already saw do not count');
  assert.equal(reopenedFix(parked, [seen('T-0201', 13), seen('T-0201', 14), seen('T-0056', 15)], 'UTC'), undefined, 'one other task, or the fix itself, is not enough');
  const again = reopenedFix(parked, [seen('T-0201', 11), seen('T-0201', 13), seen('T-0202', 14)], 'UTC')!;
  assert.equal(again.status, 'ready');
  assert.match(again.notes!, /^Taken up again by the loop: after it was parked, its test failed 2 passes of 2 different tasks \(T-0201, T-0202\):\n- T-0201 attempt 1 \(claude, Mon 1:00 PM; runs\/logs\/T-0201\.log\.gz\)/);
  assert.equal(filedFor(again), '|unit| a.test.ts > [XX-9] races', 'it stays the fix for its test');
  assert.equal(again.summary, 'taken up again: its test failed T-0201 and T-0202 after it was parked');
});

test('gate: a runner that reports each step when it ends gives exact step times, and a failed browser test leaves its page', async () => {
  const { stepEnd, pageAtFailure } = await import('../src/gate.ts');
  assert.deepEqual(stepEnd('< gate 15-lint: passed in 31.2s'), { step: '15-lint', ok: true, ms: 31_200 });
  assert.deepEqual(stepEnd('\u001b[31m< gate 70-unit: failed in 12s (exit 1)\u001b[39m'), { step: '70-unit', ok: false, ms: 12_000 });
  assert.equal(stepEnd('> gate 15-lint: pnpm lint'), undefined);
  const { mkdtempSync, mkdirSync, writeFileSync, utimesSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const dir = mkdtempSync(join(tmpdir(), 'page-'));
  assert.equal(pageAtFailure(dir), undefined);
  for (const [name, age] of [['b-second', 1], ['a-first', 2]] as const) {
    mkdirSync(join(dir, 'test-results', name), { recursive: true });
    writeFileSync(join(dir, 'test-results', name, 'error-context.md'), `# Page snapshot\n- heading "${name}"\n`);
    const t = Date.now() / 1000 - age * 60;
    utimesSync(join(dir, 'test-results', name, 'error-context.md'), t, t);
  }
  assert.equal(pageAtFailure(dir), 'test-results/a-first/error-context.md:\n# Page snapshot\n- heading "a-first"', 'the first failure, by time');
});

// Tests start apps and loops on the fixture project: its agents must never be the real CLIs, whose health
// probe and Helix turns would spend a subscription.
test('the test project names no real agent CLI', () => {
  const config = loadConfig(FIXTURE);
  for (const a of ['claude', 'codex'] as const) assert.match(config.agents[a].command, /^helix-test-no-real-/);
});
