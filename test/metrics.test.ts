import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scriptsIn } from '../src/agents/adapter.ts';
import type { LedgerEvent } from '../src/ledger.ts';
import { buildMetrics, categorise, failureSignature, project, stepOf, windowStarts, type Window } from '../src/metrics/model.ts';
import { renderMetrics } from '../src/metrics/render.ts';
import type { Plan, Task } from '../src/types.ts';

// The metrics page's numbers (metrics/model.ts) and what an agent's commands say it ran (agents/adapter.ts).

type Pass = Extract<LedgerEvent, { kind: 'pass' }>;
const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 9, 24, 17, 0); // Sat Oct 24, noon in Chicago
const pass = (over: Partial<Pass>): Pass => ({
  kind: 'pass',
  at: new Date(T0 + HOUR).toISOString(),
  task: 'T-0001',
  repo: 'mushy-social-media',
  agent: 'claude',
  model: 'm',
  attempt: 1,
  outcome: 'merged',
  durationMs: 30 * 60_000,
  costUsd: 1,
  tokens: { input: 100, cachedInput: 1000, output: 50 },
  log: '',
  ...over,
});
const task = (id: string, over: Partial<Task> = {}): Task => ({
  id, repo: 'mushy-social-media', stage: 'day1', area: 'a', title: id, reqs: [], spec: [], acceptance: [], blocked_by: [], estimate_passes: 1, status: 'ready', claimed_by: null, attempts: [], ...over,
});
const planOf = (tasks: Task[]): Plan => ({ tasks: new Map(tasks.map((t) => [t.id, t])), human: new Map() });

test('metrics: each pass comes to one category, and its failing test is read without what varies between runs', () => {
  assert.equal(categorise(pass({})), 'merged');
  assert.equal(categorise(pass({ outcome: 'conflict' })), 'moved');
  assert.equal(categorise(pass({ outcome: 'gate_failed', note: 'after rebasing onto the new main: the gate failed: x' })), 'moved');
  assert.equal(categorise(pass({ outcome: 'no_commit', note: 'BLOCKED: needs T-1' })), 'blocked');
  assert.equal(categorise(pass({ outcome: 'gate_failed', note: 'gitleaks found what looks like a secret' })), 'refused');
  assert.equal(categorise(pass({ outcome: 'quota' })), 'cut');
  assert.equal(categorise(pass({ outcome: 'gate_failed', note: 'the gate failed: |unit| a.test.ts > adds' })), 'own');
  assert.equal(failureSignature(pass({ outcome: 'gate_failed', note: 'the gate failed: [chromium] › e2e/a.e2e.test.ts:124:1 › [SGN-11] signs out (30.1s)' })), '[chromium] › e2e/a.e2e.test.ts › [SGN-11] signs out');
  assert.equal(failureSignature(pass({ outcome: 'gate_failed', failing: 'after rebasing onto the new main, |unit| a.test.ts > adds' })), '|unit| a.test.ts > adds');
  // A gate runner's own line names a step, not a test.
  assert.equal(failureSignature(pass({ outcome: 'gate_failed', note: 'the gate failed: Gate failed at 40-size (exit 1)' })), undefined);
  assert.equal(failureSignature(pass({ outcome: 'gate_failed', note: 'the gate failed: pnpm run gate exited with code 1' })), undefined);
});

test('metrics: the step a failed pass stopped at, from the ledger or, for older passes, from the end of the note', () => {
  assert.equal(stepOf(pass({ outcome: 'gate_failed', failedStep: '75-integration' })), '75-integration');
  assert.equal(stepOf(pass({ outcome: 'gate_failed', note: 'the gate failed: x\n\n> gate 70-unit: pnpm test:unit\nok\n> gate 75-integration: pnpm test:integration\nFAIL\nGate failed at 75-integration (exit 1)' })), '75-integration');
  assert.equal(stepOf(pass({ outcome: 'gate_failed', note: 'the gate failed: x\n\nChecking 40-unit.ts\nChecking 65-price-literals.ts\nFAIL' })), '65-price-literals');
  assert.equal(stepOf(pass({ outcome: 'gate_failed', note: 'after rebasing onto the new main: the gate failed: x\nGate failed at 80-e2e (exit 1)' })), 'regate:80-e2e');
  assert.equal(stepOf(pass({ outcome: 'conflict', note: 'rebase onto main conflicts in: a.ts' })), 'rebase');
  assert.equal(stepOf(pass({ outcome: 'forbidden_paths', note: 'changed forbidden paths: .env' })), 'harness:forbidden-paths');
  assert.equal(stepOf(pass({})), undefined);
  // The plan's copy of a note is longer than the ledger's, which kept 500 characters: buildMetrics reads that one.
  const long = `the gate failed: x\n${'noise\n'.repeat(120)}Gate failed at 80-e2e (exit 1)`;
  const plan = planOf([task('T-0001', { attempts: [{ agent: 'claude', outcome: 'gate_failed', at: '', log: '', note: long }] })]);
  const m = buildMetrics({ events: [{ kind: 'loop', at: new Date(T0).toISOString(), event: 'start' }, pass({ outcome: 'gate_failed', note: long.slice(0, 500) })], plan, now: T0 + 2 * HOUR });
  assert.deepEqual(m.failedSteps, [{ step: '80-e2e', failures: 1 }]);
});

test('metrics: six-hour windows start at local midnight, 6 am, noon and 6 pm, across a change of clocks', () => {
  const tz = 'America/Chicago';
  const hourOf = (t: number) => Number(new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hourCycle: 'h23' }).format(t)) % 24;
  // Clocks go back at 2 am on Sunday, November 1, 2026.
  const starts = windowStarts(Date.UTC(2026, 9, 31, 22), Date.UTC(2026, 10, 2, 6), 6, tz);
  assert.deepEqual(starts.map(hourOf), [12, 18, 0, 6, 12, 18, 0]);
  const lengths = starts.slice(1).map((t, i) => (t - starts[i]!) / HOUR);
  assert.deepEqual(lengths, [6, 6, 7, 6, 6, 6], 'the night the clocks change has one 7-hour window');
});

test('metrics: the projection continues the last 24 hours, its band always holds it, and it may never converge', () => {
  const now = T0;
  const windows = [3, 5, 4, 6, 2, 4, 5, 3].map((merged, i): Window => ({ start: now - (8 - i) * 6 * HOUR, end: now - (7 - i) * 6 * HOUR, passes: merged * 2, merged: merged * 6, firstTry: 0, hours: {} as Window['hours'], costUsd: 0, tokens: 0, byAgent: {} }));
  const total: [number, number][] = [[now - 24 * HOUR, 100], [now, 124]];
  const p = project({ now, windows, done: 40, total, totalNow: 124, covered: 24, mergedLast: 48 });
  assert.equal(p.rate, 2);
  assert.equal(p.growth, 1);
  assert.ok(p.low! <= p.rate && p.rate <= p.high!, JSON.stringify(p));
  assert.equal(p.finish, now + (84 / (2 - 1)) * HOUR);
  assert.equal(p.finishNoGrowth, now + 42 * HOUR);
  assert.ok(p.finishHigh! <= p.finish! && p.finish! <= p.finishLow!);
  // Tasks added as fast as they merge: no finish in sight.
  const stalled = project({ now, windows, done: 40, total: [[now - 24 * HOUR, 76], [now, 124]], totalNow: 124, covered: 24, mergedLast: 48 });
  assert.equal(stalled.finish, undefined);
  assert.equal(project({ now, windows, done: 124, total, totalNow: 124, covered: 24, mergedLast: 48 }).finish, now);
});

test('metrics: tasks done, time by category, recurring failures and starting from kept work, from the ledger and the plan', () => {
  const at = (h: number) => new Date(T0 + h * HOUR).toISOString();
  const events: LedgerEvent[] = [
    { kind: 'loop', at: at(0), event: 'start' },
    pass({ task: 'T-0001', at: at(1), outcome: 'gate_failed', failing: '|unit| flaky.test.ts > races', failedStep: '70-unit', phases: { setupMs: 1, agentMs: 1, gateMs: 1 }, kept: 'task/T-0001-claude-1' }),
    pass({ task: 'T-0002', at: at(2), outcome: 'gate_failed', agent: 'codex', failing: '|unit| flaky.test.ts > races', failedStep: '70-unit', phases: { setupMs: 1, agentMs: 1, gateMs: 1 }, scripts: { 'test:integration': 1 } }),
    pass({ task: 'T-0001', at: at(3), attempt: 2, carried: { from: 'task/T-0001-claude-1', why: 'failed', conflicts: 0, resolved: 0 }, phases: { setupMs: 1, agentMs: 1, gateMs: 1 }, scripts: {} }),
    pass({ task: 'T-0003', at: at(4), outcome: 'gate_failed', failing: '|unit| own.test.ts > breaks', failedStep: '75-integration', phases: { setupMs: 1, agentMs: 1, gateMs: 1 }, scripts: {} }),
    pass({ task: 'T-0002', at: at(5), attempt: 2, agent: 'codex', phases: { setupMs: 1, agentMs: 1, gateMs: 1 }, gateSteps: [{ step: 'prepare', ms: 2000 }, { step: '70-unit', ms: 50_000 }] }),
  ];
  const plan = planOf([task('T-0001', { status: 'done' }), task('T-0002', { status: 'done' }), task('T-0003'), task('T-0004')]);
  const m = buildMetrics({ events, plan, now: T0 + 6 * HOUR, history: [[T0 - HOUR, 3], [T0 + 4.5 * HOUR, 4]] });
  assert.deepEqual(m.done.map(([, n]) => n), [1, 2]);
  assert.deepEqual(m.total.map(([, n]) => n), [3, 4, 4]);
  assert.equal(m.kpi.done, 2);
  assert.equal(m.kpi.total, 4);
  assert.equal(m.kpi.firstTryRate, 0, 'both merged on their second attempt');
  // The same test failed two tasks: recurring. The third task's failure is its own.
  assert.deepEqual(m.recurring.map((r) => [r.failing, r.tasks]), [['|unit| flaky.test.ts > races', ['T-0001', 'T-0002']]]);
  const hours = m.windows.reduce((acc, w) => {
    for (const [k, v] of Object.entries(w.hours)) acc[k] = (acc[k] ?? 0) + v;
    return acc;
  }, {} as Record<string, number>);
  assert.equal(hours.recurring, 1);
  assert.equal(hours.own, 0.5);
  assert.equal(hours.merged, 1);
  assert.deepEqual({ passes: m.carry.passes, merged: m.carry.merged, fresh: m.carry.freshPasses, freshMerged: m.carry.freshMerged }, { passes: 1, merged: 1, fresh: 4, freshMerged: 1 });
  assert.deepEqual(m.integration, { passes: 3, ran: 1, failedAtIntegration: 1, failedAtIntegrationRan: 0 }, 'passes that recorded what they ran');
  assert.deepEqual(m.steps.map((x) => [x.step, x.medianMs, x.failures]), [['70-unit', 50_000, 2], ['prepare', 2000, 0]]);
  assert.deepEqual(m.plan, { ready: 2, claimed: 0, needsHuman: 0, parked: 0, humanOpen: 0 });
});

test('metrics: each subscription week by week, from the windows the passes reported, a reset early or not', () => {
  const at = (h: number) => new Date(T0 + h * HOUR).toISOString();
  const reset = (h: number, s = 0) => new Date(T0 + h * HOUR + s * 1000).toISOString();
  const events: LedgerEvent[] = [
    pass({ at: at(1), usage: { weekly: 0.4, weeklyResetsAt: reset(40) } }),
    pass({ at: at(2), usage: { weekly: 0.42, weeklyResetsAt: reset(40, 1) } }), // the same window, stated a second apart
    pass({ at: at(3), usage: { weekly: 0.03, weeklyResetsAt: reset(170) } }), // everyone's windows reset early
    pass({ at: at(2), agent: 'codex', usage: { session: 0.1 } }), // no weekly window: nothing to show
    pass({ at: at(4) }),
  ];
  const m = buildMetrics({ events, plan: planOf([task('T-0001')]), now: T0 + 5 * HOUR, targets: { claude: 0.85 } });
  assert.deepEqual(m.allowance, [
    {
      agent: 'claude',
      target: 0.85,
      windows: [
        { resetsAt: T0 + 40 * HOUR, points: [[T0 + HOUR, 0.4], [T0 + 2 * HOUR, 0.42]] },
        { resetsAt: T0 + 170 * HOUR, points: [[T0 + 3 * HOUR, 0.03]] },
      ],
    },
  ]);
});

test('metrics: the page embeds the model so that no string in it can close its script', () => {
  const evil = '</script><script>alert(1)</script>';
  const events: LedgerEvent[] = [{ kind: 'loop', at: new Date(T0).toISOString(), event: 'start' }, pass({ outcome: 'gate_failed', failing: evil })];
  const html = renderMetrics(buildMetrics({ events, plan: planOf([task('T-0001')]), now: T0 + 2 * HOUR }));
  assert.equal(html.split('</script>').length - 1, 3, 'only the three script elements close: the data, versions.js and the page');
  assert.ok(html.includes('\\u003c/script>'));
});

test('agent activity: the package scripts and tools a command line runs', () => {
  assert.deepEqual(scriptsIn(['pnpm test:integration']), { 'test:integration': 1 });
  assert.deepEqual(scriptsIn(["/bin/zsh -lc 'pnpm typecheck && pnpm run --silent e2e -- e2e/a.e2e.test.ts'"]), { typecheck: 1, e2e: 1 });
  assert.deepEqual(scriptsIn(['pnpm exec vitest run src/a.test.ts', 'pnpm vitest run x', 'pnpm --filter @mushy/web lint']), { vitest: 2, lint: 1 });
  assert.deepEqual(scriptsIn(['pnpm install --frozen-lockfile', 'pnpm add -D x', 'git status', 'cat package.json | grep pnpm']), {});
});

test('metrics: each version is left as written, and the shared list and the index link them all', async () => {
  const { mkdtempSync, readFileSync, readdirSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { readVersions, writeVersion } = await import('../src/metrics/archive.ts');
  const dir = join(mkdtempSync(join(tmpdir(), 'metrics-')), 'metrics');
  const at = (h: number) => new Date(T0 + h * HOUR).toISOString();
  const events = (n: number): LedgerEvent[] => [{ kind: 'loop', at: at(0), event: 'start' }, ...Array.from({ length: n }, (_, i) => pass({ task: `T-${String(i + 1).padStart(4, '0')}`, at: at(1 + i * 0.01) }))];
  const plan = planOf(Array.from({ length: 250 }, (_, i) => task(`T-${String(i + 1).padStart(4, '0')}`)));
  const first = writeVersion(dir, buildMetrics({ events: events(100), plan, now: T0 + 3 * HOUR }), 100);
  const second = writeVersion(dir, buildMetrics({ events: events(200), plan, now: T0 + 30 * HOUR }), 100);
  assert.equal(first.file, 'Mushy.LoopEngineering.Metrics.2026-10-24.0100.html');
  assert.equal(second.file, 'Mushy.LoopEngineering.Metrics.2026-10-25.0200.html');
  const frozen = readFileSync(join(dir, first.file), 'utf8');
  const embedded = (html: string) => JSON.parse(/<script type="application\/json" id="data">(.*?)<\/script>/s.exec(html)![1]!) as { file: string; versions: { file: string }[]; versionEvery: number };
  assert.deepEqual(embedded(frozen).versions.map((v) => v.file), [first.file]);
  assert.equal(embedded(frozen).file, first.file);
  assert.equal(embedded(frozen).versionEvery, 100);
  assert.deepEqual(embedded(readFileSync(join(dir, second.file), 'utf8')).versions.map((v) => v.file), [first.file, second.file]);
  assert.ok(frozen.includes('<script src="versions.js"></script>'), 'pages load the shared list');
  // Rewriting the same version replaces it; the first is untouched.
  writeVersion(dir, buildMetrics({ events: events(200), plan, now: T0 + 30 * HOUR }), 100);
  assert.equal(readFileSync(join(dir, first.file), 'utf8'), frozen);
  assert.deepEqual(readVersions(dir).map((v) => v.passes), [100, 200]);
  assert.deepEqual(readdirSync(dir).sort(), [first.file, second.file, 'index.html', 'versions.js', 'versions.json'].sort());
  const index = readFileSync(join(dir, 'index.html'), 'utf8');
  assert.ok(index.indexOf(`href="${second.file}"`) < index.indexOf(`href="${first.file}"`), 'newest first');
  assert.match(index, /Open the latest version: Sun, Oct 25, 6:00 PM, after 200 passes/);
});
