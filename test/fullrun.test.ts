import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { systemClock } from '../src/clock.ts';
import { failingTests, filedForFullRun, firstFailing, FULL_RUN_MARK, fullRunFixTask, lastGreen, latestFullRun, mergesOf, mergesSinceFullRun, runFullCheck, type Merge } from '../src/fullrun.ts';
import type { LedgerEvent } from '../src/ledger.ts';
import type { Task } from '../src/types.ts';

const at = '2026-10-28T12:00:00.000Z';
const merge = (task: string, commit: string, repo = 'app'): LedgerEvent => ({ kind: 'merge', at, task, repo, commit, agent: 'claude', regated: false });
const full = (commit: string, ok: boolean, repo = 'app'): LedgerEvent => ({ kind: 'full_run', at, repo, commit, reason: 'r', ok, ms: 1, log: 'l' });

test('a whole-suite run is due by the merges into its repo since the last one, and the last that passed is where a search starts', () => {
  const events = [merge('T-1', 'a'), merge('T-2', 'b'), full('b', true), merge('T-3', 'c'), merge('T-9', 'x', 'site'), full('c', false), merge('T-4', 'd'), merge('T-5', 'e')];
  assert.equal(mergesSinceFullRun(events, 'app'), 2);
  assert.equal(mergesSinceFullRun(events, 'site'), 1, 'a repo with no run yet counts every merge');
  assert.equal(lastGreen(events, 'app'), 'b');
  assert.equal(latestFullRun(events, 'app')?.commit, 'c');
  assert.deepEqual(mergesOf(events, 'app', { after: new Set(['c', 'd', 'e']), last: 10 }).map((m) => m.task), ['T-3', 'T-4', 'T-5']);
  assert.deepEqual(mergesOf(events, 'app', { last: 2 }).map((m) => m.task), ['T-4', 'T-5']);
});

test('a failed run names one failing test per file, from Vitest and Playwright, without colours', () => {
  const output = [
    '> gate 70-unit: vitest',
    ' FAIL  |integration| packages/testkit/src/seed/entitlements.integration.test.ts > [PLT-1] seeded workspaces are on Free',
    ' FAIL  |integration| packages/testkit/src/seed/entitlements.integration.test.ts > [PLT-1] another in the same file',
    '\x1b[31m FAIL \x1b[39m |integration| apps/workers/src/publish-recovery.integration.test.ts [ apps/workers/src/publish-recovery.integration.test.ts ]',
    '  1) [chromium] › e2e/composer.e2e.test.ts:246:1 › [NAV-28] a draft open in the composer reopens identically ─────',
    '  2) [chromium] › e2e/composer.e2e.test.ts:297:1 › [PBS-29] an agent draft shows named lilac attribution',
    ' FAIL  src/plain.test.ts > adds',
  ].join('\n');
  assert.deepEqual(failingTests(output), [
    { file: 'packages/testkit/src/seed/entitlements.integration.test.ts', line: '|integration| packages/testkit/src/seed/entitlements.integration.test.ts > [PLT-1] seeded workspaces are on Free' },
    { file: 'apps/workers/src/publish-recovery.integration.test.ts', line: '|integration| apps/workers/src/publish-recovery.integration.test.ts [ apps/workers/src/publish-recovery.integration.test.ts ]' },
    { file: 'e2e/composer.e2e.test.ts', line: '[chromium] › e2e/composer.e2e.test.ts:246:1 › [NAV-28] a draft open in the composer reopens identically' },
    { file: 'src/plain.test.ts', line: 'src/plain.test.ts > adds' },
  ]);
});

test('the search finds the first failing merge in log2 runs, and gives up only when nothing before is known to pass', async () => {
  const commits = Array.from({ length: 25 }, (_, i) => `c${i}`);
  for (const breaks of [0, 1, 12, 23, 24]) {
    let runs = 0;
    const fails = async (c: string) => {
      runs++;
      return Number(c.slice(1)) >= breaks;
    };
    assert.equal(await firstFailing(commits, fails, true), breaks, `breaks at ${breaks}`);
    assert.ok(runs <= 5, `${runs} runs for 25 merges`);
  }
  assert.equal(await firstFailing(commits, async () => true, false), undefined, 'failing all the way back, with no green run before');
  assert.equal(await firstFailing(commits, async () => true, true), 0);
  assert.equal(await firstFailing(['only'], async () => true, true), 0);
});

const task = (id: string, extra: Partial<Task> = {}): Task => ({
  id,
  repo: 'app',
  story: 'write-drafts',
  area: 'web/composer',
  title: `${id} title`,
  priority: 'normal',
  reqs: ['PBS-1'],
  spec: ['§11 Requirements'],
  acceptance: [],
  blocked_by: [],
  estimate_passes: 1,
  status: 'done',
  claimed_by: null,
  attempts: [],
  ...extra,
});

test('a failed run files a fix-first task naming the merge that broke it, or the flaky test, with every failing test as acceptance', () => {
  const run = {
    ok: false as const,
    commit: 'abcdef1234567890',
    ms: 1,
    steps: [],
    detail: 'the gate failed: …',
    failing: '[chromium] › e2e/composer.e2e.test.ts:246:1 › [NAV-28] reopens',
    failedStep: '80-e2e',
    tests: [
      { file: 'e2e/composer.e2e.test.ts', line: '[chromium] › e2e/composer.e2e.test.ts:246:1 › [NAV-28] reopens' },
      { file: 'apps/api/src/x.integration.test.ts', line: '|integration| apps/api/src/x.integration.test.ts > [PBS-9, ZZ-1] lists' },
    ],
    flaky: false,
    culprit: { commit: 'abcdef1234567890', task: 'T-1141' },
    reason: '25 merges since the last run',
  };
  const knownReq = (id: string) => ['NAV-28', 'PBS-9'].includes(id);
  const broke = fullRunFixTask({ id: 'T-0096', run, culprit: task('T-1141'), fallback: task('T-1000'), knownReq, tests: 'pnpm gate --tests', log: 'runs/logs/x.log.gz' })!;
  assert.equal(broke.title, 'The browser test "[NAV-28] reopens" and 1 more passes on main again, after T-1141 broke it');
  assert.deepEqual(broke.acceptance, ['e2e: [NAV-28] reopens', 'integration: [PBS-9, ZZ-1] lists']);
  assert.deepEqual(broke.reqs, ['NAV-28', 'PBS-9']);
  assert.equal(broke.priority, 'fix_first');
  assert.equal(broke.area, 'web/composer');
  assert.equal(filedForFullRun(broke), '[chromium] › e2e/composer.e2e.test.ts › [NAV-28] reopens');
  assert.match(broke.notes!, /T-1141's merge/);
  assert.ok(broke.notes!.startsWith(FULL_RUN_MARK));

  const flaky = fullRunFixTask({ id: 'T-0097', run: { ...run, tests: run.tests.slice(0, 1), flaky: true, culprit: undefined }, fallback: task('T-1000'), knownReq, log: 'l' })!;
  assert.equal(flaky.title, 'The browser test "[NAV-28] reopens" passes every time, instead of failing main\'s whole-suite run');
  assert.equal(flaky.area, 'build/flaky');

  assert.equal(fullRunFixTask({ id: 'T-0098', run: { ...run, tests: [{ file: 'x', line: 'src/a.ts(3,1): error TS2322' }] }, fallback: task('T-1000'), knownReq, log: 'l' }), undefined);
});

// A repo whose gate fails while a file named BROKEN is present, as a test run does for "test/a.test.ts".
function repoWithMerges(): { dir: string; merges: Merge[]; good: string } {
  const dir = mkdtempSync(join(tmpdir(), 'helix-fullrun-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  const commit = (message: string) => {
    git('add', '-A');
    git('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', message);
    return git('rev-parse', 'HEAD');
  };
  git('init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'check.sh'), 'if [ -f BROKEN ] || [ -n "$ALWAYS_FAIL" ]; then echo " FAIL  |unit| test/a.test.ts > [PB-1] adds"; exit 1; fi; echo ok\n');
  mkdirSync(join(dir, 'test'));
  writeFileSync(join(dir, 'test', 'a.test.ts'), '// the failing test: check.sh stands in for running it\n');
  const good = commit('skeleton');
  const merges: Merge[] = [];
  for (let i = 1; i <= 9; i++) {
    writeFileSync(join(dir, `f${i}.txt`), `${i}\n`);
    if (i === 6) writeFileSync(join(dir, 'BROKEN'), 'T-6 broke it\n');
    merges.push({ commit: commit(`T-${i}: change ${i}`), task: `T-${i}` });
  }
  return { dir, merges, good };
}

test('a run that fails is traced to the merge that broke it, at the merges since the last run that passed', async (t) => {
  const { dir, merges } = repoWithMerges();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const runs = join(dir, '..', `${dir.split('/').pop()}-runs`);
  const lines: string[] = [];
  const r = await runFullCheck({
    repo: 'app',
    checkout: dir,
    dir: runs,
    gate: 'sh check.sh',
    tests: 'sh check.sh', // the given test files are appended; this repo's check ignores them
    cache: join(runs, 'cache'),
    merges,
    knownGood: true,
    timeoutMs: 60_000,
    suspensionMs: 60_000,
    clock: systemClock,
    logFile: join(runs, 'full.log'),
    log: (l) => lines.push(l),
  });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.flaky, false);
  assert.deepEqual(r.culprit, merges[5]);
  assert.deepEqual(r.tests.map((x) => x.file), ['test/a.test.ts']);
  assert.ok(lines.length <= 5, `${lines.length} runs of the failing tests: ${lines.join(' | ')}`);
  assert.deepEqual(readdirSync(runs).filter((f) => f.startsWith('app-')), [], 'its worktree is removed');
});

test('a run whose failing tests pass when run again reports a flaky test, and a passing run nothing to trace', async (t) => {
  const { dir, merges } = repoWithMerges();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const runs = join(dir, '..', `${dir.split('/').pop()}-runs`);
  const input = { repo: 'app', checkout: dir, dir: runs, cache: join(runs, 'cache'), merges, knownGood: true, timeoutMs: 60_000, suspensionMs: 60_000, clock: systemClock, logFile: join(runs, 'full.log'), log: () => {} };
  // The gate fails on every commit; the test run alone passes: flaky.
  const flaky = await runFullCheck({ ...input, gate: 'echo " FAIL  |unit| test/a.test.ts > [PB-1] adds"; exit 1', tests: 'true' });
  assert.equal(flaky.ok, false);
  assert.equal(!flaky.ok && flaky.flaky, true);
  assert.equal(!flaky.ok && flaky.culprit, undefined);
  // Without a command for given test files there is nothing to rerun or trace.
  const untraced = await runFullCheck({ ...input, gate: 'sh check.sh' });
  assert.equal(!untraced.ok && untraced.flaky === false && untraced.culprit === undefined, true);
  const green = await runFullCheck({ ...input, gate: 'true', tests: 'true' });
  assert.equal(green.ok, true);
  assert.equal(green.commit, merges.at(-1)!.commit);
  assert.equal(existsSync(join(runs, `app-${green.commit.slice(0, 12)}`)), false);
});
