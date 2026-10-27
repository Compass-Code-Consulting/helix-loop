import assert from 'node:assert/strict';
import { execFileSync, execSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { parse, stringify } from 'yaml';
import { claudeAdapter } from '../src/agents/claude.ts';
import { codexAdapter } from '../src/agents/codex.ts';
import { VirtualClock } from '../src/clock.ts';
import { BIN, type Config, configPath, loadConfig, logFile, paths } from '../src/config.ts';
import { readLedger, type LedgerEvent } from '../src/ledger.ts';
import { EXIT, runLoop } from '../src/loop.ts';
import { fakeConfig, seedControlPlane, seedRepos } from '../src/dryrun.ts';
import { startApp } from '../src/app/server.ts';
import { renderDependencyMap } from '../src/map/render.ts';
import type { Approval } from '../src/release.ts';
import type { HumanTask, MapModel, Task } from '../src/types.ts';
import { FIXTURE } from './fixture.ts';

// The dry run (handoff "definition of ready"): the real loop, the real adapters and real git
// repositories, with scripted fake `claude` and `codex` executables in place of the CLIs.

interface Setup {
  root: string;
  run: (opts?: { maxPasses?: number; signal?: AbortSignal }) => Promise<number>;
  task: (id: string) => Task;
  ledger: () => LedgerEvent[];
  modes: () => string[];
  passes: (id?: string) => Extract<LedgerEvent, { kind: 'pass' }>[];
  main: (repo?: string) => string[];
  notes: { title: string; message: string }[]; // the notifications the loop sent
  add: (tasks: Partial<Task>[]) => void; // more tasks (with ids), for a later run
  human: (step: Partial<HumanTask> & { id: string }) => void; // writes a human step
  git: (repo: string, ...args: string[]) => string; // in the repo's primary checkout
  tags: (repo: string) => string[]; // release tags, oldest first
  origin: (repo: string) => string; // gives the repo a bare origin with its main; returns its path
  cli: (...args: string[]) => { code: number; out: string }; // the real CLI against this control plane
  maps: MapModel[]; // every dependency map the loop rendered, in order
}

// The loop's log of the latest scenario, appended to any failure so a rare flake leaves its evidence.
let lastLog: string[] = [];
// Every scenario starts at local noon on a fixed day: at 1000 times real speed a scenario spans hours, and
// one started near midnight would see the day's budgets reset partway through.
const DRY_RUN_START = new Date(2026, 9, 24, 12, 0).getTime();
function scenario(name: string, fn: () => Promise<void>): void {
  test(name, async () => {
    try {
      await fn();
    } catch (e) {
      // Also to stderr: for an assertion with a generated message the reporter prints the diff, not the message.
      const evidence = `--- loop log ---\n${lastLog.join('\n')}`;
      process.stderr.write(`${name}\n${evidence}\n`);
      if (e instanceof Error) e.message += `\n${evidence}`;
      throw e;
    }
  });
}

function setup(
  tasks: Partial<Task>[],
  scenario: Record<string, string[]>,
  tune: (c: Config) => void = () => {},
  humans: (Partial<HumanTask> & { id: string })[] = [],
): Setup {
  lastLog = [];
  const root = mkdtempSync(join(tmpdir(), 'mushy-dryrun-'));
  const p = paths(root);
  seedControlPlane(root, FIXTURE);
  const add = (list: Partial<Task>[]) =>
    list.forEach((t, i) => {
      const id = t.id ?? `T-${String(i + 1).padStart(4, '0')}`;
      const full: Task = {
        id, repo: 'acme-app', stage: 'day1', area: `area-${id.toLowerCase()}`, title: `Dry-run task ${id}`, reqs: ['PB-14'],
        spec: ['PB-14'], acceptance: [`unit: [PB-14] dry-run behaviour of ${id}`], blocked_by: [], estimate_passes: 1,
        status: 'ready', claimed_by: null, attempts: [], ...t,
      };
      writeFileSync(join(p.tasks, `${id}.yaml`), stringify(full));
    });
  const human = (h: Partial<HumanTask> & { id: string }) => {
    const full: HumanTask = { title: `Dry-run human step ${h.id}`, done_check: 'Daniel says so', lead_time_days: 1, agent_can_help: 'no', blocked_by: [], status: 'todo', ...h };
    writeFileSync(join(p.human, `${h.id}.yaml`), stringify(full));
  };
  add(tasks);
  humans.forEach(human);
  seedRepos(p.repos, Object.keys(loadConfig(FIXTURE).repos));
  const scenarioFile = join(root, 'scenario.json');
  writeFileSync(scenarioFile, JSON.stringify(scenario));
  process.env.HELIX_FAKE_SCENARIO = scenarioFile;
  process.env.HELIX_FAKE_STATE = join(root, 'fake-state');

  const config = fakeConfig(loadConfig(FIXTURE), root);
  // No loop app in a scenario unless it starts one: a builder never reports to an app Daniel has open.
  delete config.app;
  // One pass per agent unless a scenario asks for more, so the order of passes stays predictable.
  config.agents.claude.slots = 1;
  config.agents.codex.slots = 1;
  tune(config);

  const codexHome = join(root, 'codex-home');
  const ledger = () => readLedger(p.ledger);
  const notes: { title: string; message: string }[] = [];
  const maps: MapModel[] = [];
  const git = (repo: string, ...args: string[]) => execFileSync('git', args, { cwd: join(p.repos, repo) }).toString().trim();
  return {
    root,
    run: ({ maxPasses, signal } = {}) =>
      runLoop({
        config,
        paths: p,
        clock: new VirtualClock(1000, DRY_RUN_START),
        adapters: { claude: claudeAdapter(config.agents.claude, config), codex: codexAdapter(config.agents.codex, config, codexHome) },
        notify: (title, message) => notes.push({ title, message }),
        renderMap: (model) => {
          maps.push(model);
          return renderDependencyMap(model);
        },
        log: (line) => {
          lastLog.push(line);
          if (process.env.DRYRUN_DEBUG) console.error(line);
        },
        maxPasses,
        signal,
        keepAwake: false,
      }),
    task: (id) => parse(readFileSync(join(p.tasks, `${id}.yaml`), 'utf8')) as Task,
    ledger,
    modes: () => ledger().flatMap((e) => (e.kind === 'mode' ? [e.mode] : [])),
    passes: (id) => ledger().filter((e): e is Extract<LedgerEvent, { kind: 'pass' }> => e.kind === 'pass' && (!id || e.task === id)),
    main: (repo = 'acme-app') => execFileSync('git', ['log', '--format=%s', 'main'], { cwd: join(p.repos, repo) }).toString().trim().split('\n'),
    notes,
    maps,
    add,
    human,
    git,
    tags: (repo) => git(repo, 'tag', '--list', 'v*', '--sort=v:refname').split('\n').filter(Boolean),
    origin: (repo) => {
      const bare = join(root, 'origins', `${repo}.git`);
      execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare]);
      git(repo, 'remote', 'add', 'origin', bare);
      git(repo, 'push', '-q', 'origin', 'main');
      return bare;
    },
    cli: (...args) => {
          writeFileSync(configPath(root), stringify({ ...config, root: undefined }));
      const r = spawnSync('node', [BIN, ...args, '--root', root], { encoding: 'utf8' });
      return { code: r.status ?? -1, out: `${r.stdout}${r.stderr}` };
    },
  };
}

scenario('both agents in parallel; the loop commits a dirty tree and accepts an agent commit; all done exits 0', async () => {
  const s = setup([{}, {}, {}, {}], { 'T-0002': ['commit'] });
  assert.equal(await s.run(), EXIT.allDone);
  for (const id of ['T-0001', 'T-0002', 'T-0003', 'T-0004']) assert.equal(s.task(id).status, 'done');
  assert.ok(s.modes().includes('parallel'));
  const agents = new Set(s.passes().map((p) => p.agent));
  assert.deepEqual([...agents].sort(), ['claude', 'codex']);
  const log = s.main();
  assert.ok(log.some((m) => m === 'T-0001: implement the task'));
  assert.ok(log.some((m) => m === 'T-0002: committed by the agent itself'));
  assert.ok(existsSync(join(paths(s.root).plan, 'DependencyMap.html')));
});

scenario('Claude at its session limit: single-threaded on Codex, then Claude resumes after the reset', async () => {
  const s = setup([{}, {}, {}, {}, {}, {}, {}, {}], { 'T-0001@claude': ['limit:20', 'implement'] });
  assert.equal(await s.run(), EXIT.allDone);
  const modes = s.modes();
  assert.ok(modes.includes('single:codex'), modes.join(','));
  const t1 = s.task('T-0001');
  assert.equal(t1.status, 'done');
  assert.equal(t1.attempts[0]!.outcome, 'quota');
  assert.ok(s.passes().filter((p) => p.agent === 'claude' && p.outcome === 'merged').length > 0, 'claude worked again after its reset');
  assert.ok(s.ledger().some((e) => e.kind === 'agent' && e.agent === 'claude' && e.state === 'limited' && e.resetAt));
  assert.ok(s.ledger().some((e) => e.kind === 'agent' && e.agent === 'claude' && e.state === 'available'), 'probe after the reset');
});

scenario('Codex at its session limit: single-threaded on Claude, with the reset read from the rollout file', async () => {
  const s = setup([{}, {}, {}], { 'T-0002@codex': ['limit:45', 'implement'], 'T-0001@codex': ['limit:45', 'implement'] });
  assert.equal(await s.run(), EXIT.allDone);
  assert.ok(s.modes().includes('single:claude'), s.modes().join(','));
  const lim = s.ledger().find((e) => e.kind === 'agent' && e.agent === 'codex' && e.state === 'limited') as { resetAt?: string } | undefined;
  assert.ok(lim?.resetAt, 'codex reset time parsed');
});

scenario('both at their limits: paused until the first reset, then resumes on the agent that refreshed', async () => {
  const s = setup([{}, {}], { 'T-0001@claude': ['limit:60', 'implement'], 'T-0002@codex': ['limit:120', 'implement'], 'T-0001@codex': ['limit:120'], 'T-0002@claude': ['limit:60', 'implement'] });
  assert.equal(await s.run(), EXIT.allDone);
  const modes = s.modes();
  const paused = modes.indexOf('paused');
  assert.ok(paused >= 0, modes.join(','));
  assert.equal(modes[paused + 1], 'single:claude', modes.join(','));
  for (const id of ['T-0001', 'T-0002']) {
    assert.equal(s.task(id).status, 'done');
    assert.ok(s.task(id).attempts.some((a) => a.outcome === 'quota'));
  }
});

scenario('an unparseable limit message backs off instead of stopping', async () => {
  const s = setup([{}], { 'T-0001@claude': ['limit-unknown', 'implement'], 'T-0001@codex': ['limit-unknown', 'implement'] });
  assert.equal(await s.run(), EXIT.allDone);
  assert.equal(s.task('T-0001').status, 'done');
});

// The task of the two that merged second, after an attempt that met the first's merge.
const later = (s: Setup) => ['T-0001', 'T-0002'].map((id) => s.task(id)).find((t) => t.attempts.length > 1)!;
const carriedSeen = (s: Setup, t: Task, attempt: number) =>
  JSON.parse(readFileSync(join(s.root, 'fake-state', `${t.id}@${t.attempts[attempt]!.agent}.carried.json`), 'utf8')) as { status: string; shared: string };

scenario('a merge conflict between the two agents sends the later task back with its work kept: markers left in are refused; resolved, it merges', async () => {
  const s = setup([{}, {}], { 'T-0001': ['shared', 'nothing', 'resolve'], 'T-0002': ['shared', 'nothing', 'resolve'] });
  assert.equal(await s.run(), EXIT.allDone);
  const t = later(s);
  assert.deepEqual(t.attempts.map((a) => a.outcome), ['conflict', 'gate_failed', 'merged']);
  const kept = `task/${t.id}-${t.attempts[0]!.agent}-1`;
  assert.equal(t.attempts[0]!.kept, kept);
  const second = `task/${t.id}-${t.attempts[1]!.agent}-2`;
  assert.equal(t.attempts[1]!.kept, second, 'work that fails its own gate is kept as well');
  // The second attempt changed nothing, so its commit held the merge's markers, which the gate refused.
  assert.match(t.attempts[1]!.note ?? '', /^conflict markers are left in shared\.txt \(lines \d+, \d+, \d+, \d+\)\. Resolve each conflict/);
  // The third started from the second's work, the markers it committed and all, and both tasks' lines reached main.
  const seen = carriedSeen(s, t, 2);
  assert.match(seen.status, new RegExp(`^\\?\\? src/${t.id}\\.ts$`, 'm'));
  assert.match(seen.shared, new RegExp(`^<<<<<<< HEAD\\nwritten by T-\\d+ via \\w+\\n\\|{7} [0-9a-f]+\\noriginal\\n=======\\nwritten by ${t.id} via \\w+\\n>>>>>>> ${kept}\\n$`));
  const shared = s.git('acme-app', 'show', 'main:shared.txt');
  assert.match(shared, /^written by T-\d+ via \w+\nwritten by T-\d+ via \w+$/);
  // The second attempt was told of the conflicts git left; the third, that its last attempt failed the gate.
  const prompt2 = readFileSync(join(s.root, 'fake-state', `${t.id}.prompt-2.md`), 'utf8');
  assert.match(prompt2, new RegExp(`## Your earlier work on this task is in your worktree\\n\\nAn earlier attempt's work passed its gate but could not merge.*kept on branch \`${kept}\``));
  assert.match(prompt2, /\n- CONFLICT \(content\): Merge conflict in shared\.txt\n/);
  const prompt3 = readFileSync(join(s.root, 'fake-state', `${t.id}.prompt-3.md`), 'utf8');
  assert.match(prompt3, new RegExp(`Your last attempt's work failed the gate; the end of its output is below\\. The loop has merged that work, kept on branch \`${second}\``));
  assert.match(prompt3, /The end of the last failed attempt's output:\n\n```text\nconflict markers are left in shared\.txt/);
  assert.ok(lastLog.some((l) => l.includes(`${t.id}: starts from the work kept on ${kept}, with conflicts in shared.txt`)), 'the loop logged the carry');
  assert.equal(s.git('acme-app', 'branch', '--list', 'task/*'), '', 'the kept branch went once the task merged');
});

scenario('work that fails the gate only on the new main is kept, and the next attempt finishes it', async () => {
  const s = setup([{}, {}], { 'T-0001': ['clash', 'unclash'], 'T-0002': ['clash', 'unclash'] });
  assert.equal(await s.run(), EXIT.allDone);
  const t = later(s);
  assert.deepEqual(t.attempts.map((a) => a.outcome), ['gate_failed', 'merged']);
  assert.match(t.attempts[0]!.note ?? '', /^after rebasing onto the new main: the gate failed: two clashing changes\n/);
  assert.equal(t.attempts[0]!.kept, `task/${t.id}-${t.attempts[0]!.agent}-1`);
  const seen = carriedSeen(s, t, 1);
  assert.match(seen.status, new RegExp(`^\\?\\? CLASH_${t.id}$`, 'm'));
  assert.match(seen.status, new RegExp(`^\\?\\? src/${t.id}\\.ts$`, 'm'));
  const prompt = readFileSync(join(s.root, 'fake-state', `${t.id}@${t.attempts[1]!.agent}.prompt.md`), 'utf8');
  assert.match(prompt, /## Your earlier work on this task is in your worktree/);
  assert.doesNotMatch(prompt, /Git left these conflicts/);
  const onMain = s.git('acme-app', 'ls-tree', '-r', '--name-only', 'main').split('\n');
  assert.ok(onMain.includes(`src/${t.id}.ts`) && !onMain.includes(`CLASH_${t.id}`), onMain.join(', '));
});

scenario('every pass records where its time went, what failed and what it started from, and the metrics page keeps a version every N passes', async () => {
  const s = setup([{}], { 'T-0001': ['fail', 'runsuite'] }, (c) => {
    c.agents.codex.enabled = false; // one agent, so both passes are Claude's
    c.metrics_every_passes = 1; // a version after every pass, to see the history build up
  });
  assert.equal(await s.run(), EXIT.allDone);
  const [failed, merged] = s.passes('T-0001');
  assert.ok(failed && merged, 'two passes');
  // The failed pass: its phases, the gate's steps, the step and test that failed, and the work it kept.
  assert.equal(failed.outcome, 'gate_failed');
  assert.ok(failed.startedAt && Date.parse(failed.startedAt) <= Date.parse(failed.at));
  assert.ok(failed.phases && failed.phases.agentMs >= 0 && failed.phases.gateMs > 0, JSON.stringify(failed.phases));
  assert.deepEqual(failed.gateSteps?.map((x) => x.step), ['prepare', '10-check']);
  assert.equal(failed.failedStep, '10-check');
  assert.equal(failed.failing, 'adds numbers');
  assert.equal(failed.kept, 'task/T-0001-claude-1');
  assert.ok((failed.diff?.files ?? 0) >= 3, JSON.stringify(failed.diff)); // the source, its test and GATE_FAIL
  assert.ok((failed.promptBytes ?? 0) > 0 && failed.retryBytes === 0);
  assert.equal(failed.mainMoved, 0);
  // The merged pass started from that work, was told so, and ran the integration suite.
  assert.equal(merged.outcome, 'merged');
  assert.deepEqual(merged.carried, { from: 'task/T-0001-claude-1', why: 'failed', conflicts: 0, resolved: 0 });
  assert.ok((merged.retryBytes ?? 0) > 0);
  assert.deepEqual(merged.scripts, { 'test:integration': 1 });
  assert.equal(merged.toolCalls, 1);
  assert.ok(merged.phases?.queueMs !== undefined && merged.phases.mergeMs !== undefined);
  assert.equal(merged.failedStep, undefined);
  assert.equal(merged.kept, undefined);
  // One version per pass, each kept as written, listed in versions.json, versions.js and index.html.
  const dir = join(paths(s.root).runs, 'metrics');
  const versions = JSON.parse(readFileSync(join(dir, 'versions.json'), 'utf8')) as { file: string; passes: number }[];
  assert.deepEqual(versions.map((v) => v.passes), [1, 2]);
  assert.match(versions[0]!.file, /^Metrics\.2026-10-24\.0001\.html$/);
  const model = (file: string) => JSON.parse(/<script type="application\/json" id="data">(.*?)<\/script>/s.exec(readFileSync(join(dir, file), 'utf8'))![1]!);
  assert.deepEqual(model(versions[0]!.file).versions.map((v: { passes: number }) => v.passes), [1], 'the first version knew only itself');
  assert.match(readFileSync(join(dir, 'versions.js'), 'utf8'), /^window\.HELIX_METRICS_VERSIONS = \[.*"passes":1.*"passes":2.*\];\n$/s);
  const index = readFileSync(join(dir, 'index.html'), 'utf8');
  assert.ok(index.indexOf(versions[1]!.file) < index.lastIndexOf(versions[0]!.file), 'the index lists the newest first');
  assert.match(lastLog.join('\n'), /metrics: wrote Metrics\.2026-10-24\.0002\.html, after 2 passes/);
  const m = model(versions[1]!.file);
  assert.equal(m.kpi.done, 1);
  assert.equal(m.kpi.total, 1);
  assert.deepEqual(m.recent.map((r: { outcome: string }) => r.outcome), ['merged', 'gate_failed']);
  assert.deepEqual({ passes: m.carry.passes, merged: m.carry.merged }, { passes: 1, merged: 1 });
  assert.deepEqual(m.integration, { passes: 2, ran: 1, failedAtIntegration: 0, failedAtIntegrationRan: 0 });
  assert.deepEqual(m.failedSteps, [{ step: '10-check', failures: 1 }]);
  // The command writes a version on demand; one for the same passes replaces it.
  const cli = s.cli('metrics');
  assert.equal(cli.code, 0, cli.out);
  assert.match(cli.out.trim(), /runs\/metrics\/Metrics\.\d{4}-\d{2}-\d{2}\.0002\.html$/);
});

scenario('a test that fails passes of two different tasks gets a fix-first task, filed by the loop and built next', async () => {
  const s = setup([{}, {}], { 'T-0001': ['flaky', 'implement'], 'T-0002': ['flaky', 'implement'] });
  assert.equal(await s.run(), EXIT.allDone);
  const fix = s.task('T-0003');
  assert.equal(fix.priority, 'fix_first');
  assert.equal(fix.status, 'done');
  assert.deepEqual(fix.acceptance, ['unit: [PB-14] the shared dry-run test']);
  assert.deepEqual(fix.reqs, ['PB-14']);
  assert.match(fix.title, /^The unit test "\[PB-14\] the shared dry-run test" passes every time/);
  assert.match(fix.notes ?? '', /^Filed by the loop for a test failing passes of more than one task: \|unit\| test\/flaky\.test\.ts > \[PB-14\] the shared dry-run test\n/);
  // The two passes run at once, so either gate can fail first: the evidence lists them in the order they failed.
  assert.match(fix.notes ?? '', /^- T-0001 attempt 1 /m);
  assert.match(fix.notes ?? '', /^- T-0002 attempt 1 /m);
  assert.ok(lastLog.some((l) => /^🔧 filed T-0003, fix first: a test failed (T-0001 and T-0002|T-0002 and T-0001):/.test(l)), lastLog.join('\n'));
  assert.equal(s.notes.filter((n) => n.title === 'The loop filed a fix').length, 1, 'filed once');
});

scenario('two passes per agent run at once, while the gates take turns', async () => {
  const s = setup([{}, {}, {}, {}, {}, {}], {}, (c) => {
    c.agents.claude.slots = 2;
    c.agents.codex.slots = 2;
    c.limits.concurrent_gates = 1;
  });
  assert.equal(await s.run(), EXIT.allDone);
  const passes = s.passes();
  assert.equal(passes.filter((x) => x.outcome === 'merged').length, 6);
  // Up to four passes at once: count the most that overlapped.
  const spans = passes.map((x) => [Date.parse(x.startedAt!), Date.parse(x.at)] as const);
  const most = Math.max(...spans.map(([a]) => spans.filter(([b, e]) => b <= a && a < e).length));
  assert.ok(most >= 3, `at most ${most} passes overlapped`);
  assert.deepEqual(new Set(passes.map((x) => x.agent)), new Set(['claude', 'codex']));
  assert.ok(passes.every((x) => x.phases && x.phases.gateWaitMs !== undefined), 'every pass records how long it waited for a gate');
});

scenario('an agent ahead of its weekly pace takes no new passes until the pace catches up, and the other carries on', async () => {
  const ids = ['T-0001', 'T-0002', 'T-0003', 'T-0004', 'T-0005'];
  const s = setup(ids.map(() => ({})), Object.fromEntries(ids.map((id) => [`${id}@claude`, ['weekly:80+implement']])), (c) => {
    c.agents.claude.weekly_target = 0.9;
  });
  assert.equal(await s.run(), EXIT.allDone);
  // Half the week gone allows 45% for a 90% target: at 80% Claude stops after the pass that said so.
  const claude = s.passes().filter((x) => x.agent === 'claude');
  assert.equal(claude.length, 1, claude.map((x) => x.task).join(','));
  assert.equal(claude[0]!.usage?.weekly, 0.8);
  assert.ok(claude[0]!.usage?.weeklyResetsAt);
  const pace = s.ledger().find((e): e is Extract<LedgerEvent, { kind: 'pace' }> => e.kind === 'pace' && e.agent === 'claude');
  assert.equal(pace?.slots, 0);
  assert.ok(pace?.until && Date.parse(pace.until) > Date.parse(pace.at), 'it waits until the pace catches up');
  assert.ok(s.modes().includes('single:codex'), s.modes().join(','));
  assert.ok(lastLog.some((l) => /⏱ claude: no new passes until .+: 80% of its weekly window used/.test(l)), 'the log says why');
  for (const id of ids) assert.equal(s.task(id).status, 'done');
});

scenario('an agent within its weekly pace runs one pass at a time, whatever its slots, reading Codex from its rollout file', async () => {
  const ids = ['T-0001', 'T-0002', 'T-0003', 'T-0004', 'T-0005', 'T-0006'];
  const s = setup(ids.map(() => ({})), Object.fromEntries(ids.map((id) => [`${id}@codex`, ['weekly:46+implement']])), (c) => {
    c.agents.claude.enabled = false;
    c.agents.codex.slots = 2;
    c.agents.codex.weekly_target = 0.9;
  });
  assert.equal(await s.run(), EXIT.allDone);
  const pace = s.ledger().find((e): e is Extract<LedgerEvent, { kind: 'pace' }> => e.kind === 'pace' && e.agent === 'codex');
  assert.equal(pace?.slots, 1);
  // Two passes started together before the first reading; every pass started after it ran alone.
  const passes = s.passes();
  const spans = passes.map((x) => [Date.parse(x.startedAt!), Date.parse(x.at)] as const);
  const after = spans.filter(([b]) => b >= Date.parse(pace!.at));
  assert.ok(after.length >= 3, `${after.length} passes after the pace`);
  for (const [b] of after) assert.equal(spans.filter(([b2, e2]) => b2 < b && b < e2).length, 0, 'a pass started while another ran');
  assert.ok(passes.every((x) => x.usage?.weekly === 0.46));
});

scenario('a rebase that conflicts only in a lockfile regenerates it, and both tasks merge', async () => {
  const s = setup([{}, {}], { 'T-0001': ['dep'], 'T-0002': ['dep'] });
  assert.equal(await s.run(), EXIT.allDone);
  assert.deepEqual([...s.task('T-0001').attempts, ...s.task('T-0002').attempts].map((a) => a.outcome), ['merged', 'merged']);
  assert.ok(lastLog.some((l) => /the rebase conflicted only in deps\.lock; manifests merged key by key, lockfiles regenerated/.test(l)), 'the second merge regenerated the lockfile');
  const lock = execFileSync('git', ['show', 'main:deps.lock'], { cwd: join(paths(s.root).repos, 'acme-app') }).toString();
  assert.equal(lock, 'T-0001\nT-0002\n');
});

scenario('two tasks adding dependencies to one manifest both merge: the manifest merges key by key, the lockfile is regenerated', async () => {
  const s = setup([{}, {}], { 'T-0001': ['jsondep'], 'T-0002': ['jsondep'] });
  assert.equal(await s.run(), EXIT.allDone);
  assert.deepEqual([...s.task('T-0001').attempts, ...s.task('T-0002').attempts].map((a) => a.outcome), ['merged', 'merged']);
  assert.ok(lastLog.some((l) => /the rebase conflicted only in manifest\.json, manifest\.lock/.test(l)), lastLog.join('\n'));
  const show = (f: string) => execFileSync('git', ['show', `main:${f}`], { cwd: join(paths(s.root).repos, 'acme-app') }).toString();
  assert.deepEqual(JSON.parse(show('manifest.json')), { name: 'fake', dependencies: { 't-0001': '1.0.0', 't-0002': '1.0.0' } });
  assert.equal(show('manifest.lock'), 't-0001\nt-0002\n');
});

scenario('gate failures retry from main; three failures go to a person; exit 10', async () => {
  const s = setup([{}, {}], { 'T-0001': ['fail', 'implement'], 'T-0002': ['fail'] });
  assert.equal(await s.run(), EXIT.onlyHumanWork);
  assert.deepEqual(s.task('T-0001').attempts.map((a) => a.outcome), ['gate_failed', 'merged']);
  const note = s.task('T-0001').attempts[0]!.note ?? '';
  assert.match(note, /^the gate failed: adds numbers\n/, 'the note leads with what failed');
  assert.doesNotMatch(note, /\x1b\[/, 'without terminal colours');
  const t2 = s.task('T-0002');
  assert.equal(t2.status, 'needs_human');
  assert.equal(t2.attempts.length, 3);
  assert.equal(new Set(t2.attempts.map((a) => a.agent)).size, 2, 'the third attempt went to the other agent');
  assert.ok(!s.main().some((m) => m.startsWith('T-0002')), 'main never saw the failing task');
});

scenario('the gate checks a fresh checkout: a build output left untracked does not count, a committed build step does', async () => {
  const s = setup([{}], { 'T-0001': ['untracked', 'buildstep'] });
  assert.equal(await s.run(), EXIT.allDone);
  const t = s.task('T-0001');
  assert.deepEqual(t.attempts.map((a) => a.outcome), ['gate_failed', 'merged']);
  assert.match(t.attempts[0]!.note ?? '', /^the gate failed: built\/ok is missing\n/);
});

scenario('forbidden paths, a leaked secret and an empty pass are refused; BLOCKED goes straight to a person', async () => {
  const s = setup([{}, {}, {}, {}], {
    'T-0001': ['forbidden', 'implement'],
    'T-0002': ['secret', 'implement'],
    'T-0003': ['nothing', 'implement'],
    'T-0004': ['blocked'],
  });
  assert.equal(await s.run(), EXIT.onlyHumanWork);
  assert.equal(s.task('T-0001').attempts[0]!.outcome, 'forbidden_paths');
  assert.equal(s.task('T-0002').attempts[0]!.outcome, 'gate_failed');
  assert.match(s.task('T-0002').attempts[0]!.note ?? '', /^gitleaks found what looks like a secret in the task's commits, at src\/config\.ts:1 \(github-pat\)\./, 'the note names the finding, not its value');
  assert.equal(s.task('T-0003').attempts[0]!.outcome, 'no_commit');
  assert.equal(s.task('T-0004').status, 'needs_human');
  assert.match(s.task('T-0004').notes ?? '', /BLOCKED/);
  for (const id of ['T-0001', 'T-0002', 'T-0003']) assert.equal(s.task(id).status, 'done');
  // The next attempt is told why the last one was refused.
  const retry = readFileSync(join(s.root, 'fake-state', `T-0001@${s.task('T-0001').attempts[1]!.agent}.prompt.md`), 'utf8');
  assert.match(retry, /## Your earlier work on this task is in your worktree\n\nYour last attempt's work failed the gate[\s\S]*only tasks in their own area may change: \.github\/workflows\/deploy\.yml/);
});

scenario('a process the agent left running is killed when the pass ends', async () => {
  const s = setup([{}], { 'T-0001': ['background'] });
  assert.equal(await s.run(), EXIT.allDone);
  const pid = Number(readFileSync(join(s.root, 'fake-state', 'T-0001.bgpid'), 'utf8'));
  let alive = true;
  try {
    process.kill(pid, 0);
  } catch {
    alive = false;
  }
  assert.equal(alive, false);
});

scenario('suspension, transient errors and crashes: the first two are not counted as attempts', async () => {
  const s = setup([{}, {}, {}], {
    'T-0001': ['suspend', 'implement'],
    'T-0002': ['transient', 'implement'],
    'T-0003': ['error', 'implement'],
  });
  assert.equal(await s.run(), EXIT.allDone);
  assert.equal(s.task('T-0001').attempts[0]!.outcome, 'suspended');
  assert.equal(s.task('T-0002').attempts[0]!.outcome, 'transient');
  assert.equal(s.task('T-0003').attempts[0]!.outcome, 'agent_error');
  assert.ok(s.ledger().some((e) => e.kind === 'suspension'));
  // On the map, an interruption leaves the task's summary as it was; a counted failure sets it.
  const summaries = (id: string) => [...new Set(s.maps.map((m) => m.nodes.find((n) => n.id === id)?.summary))];
  assert.deepEqual(summaries('T-0001'), [undefined, 'implement the task']);
  assert.deepEqual(summaries('T-0002'), [undefined, 'implement the task']);
  assert.deepEqual(summaries('T-0003'), [undefined, 'agent error: fake: unexpected crash', 'implement the task']);
});

scenario('a pass past its timeout is killed and retried', async () => {
  const s = setup([{}], { 'T-0001': ['slow:30', 'implement'] }, (c) => {
    c.limits.pass_timeout_minutes = 0.03;
  });
  assert.equal(await s.run(), EXIT.allDone);
  assert.equal(s.task('T-0001').attempts[0]!.outcome, 'timeout');
});

scenario('a stop signal mid-pass ends the pass and the loop at once, and the attempt does not count', async () => {
  // Before the fix, an aborted signal made every other wait end at once, and the loop spun without yielding.
  const s = setup([{}], { 'T-0001': ['linger:30', 'implement'] });
  const ac = new AbortController();
  const began = Date.now();
  const exit = s.run({ signal: ac.signal });
  // Stop while the agent itself is running: wait for the pass to start, then for the fake agent to be asleep.
  for (let i = 0; i < 100 && !lastLog.some((l) => l.includes('T-0001 → ')); i++) await new Promise((r) => setTimeout(r, 100));
  await new Promise((r) => setTimeout(r, 3000));
  ac.abort();
  assert.equal(await exit, EXIT.stopped);
  assert.ok(Date.now() - began < 25_000, 'the loop stops instead of spinning');
  const t = s.task('T-0001');
  assert.equal(t.status, 'ready');
  assert.deepEqual(t.attempts.map((a) => a.outcome), ['transient']);
});

// Waits, in real time, until `ok` holds; fails with `what` if it never does.
async function until(what: string, ok: () => boolean, ms = 20_000): Promise<void> {
  for (const end = Date.now() + ms; !ok() && Date.now() < end; ) await new Promise((r) => setTimeout(r, 100));
  assert.ok(ok(), what);
}
const live = (s: Setup) => JSON.parse(readFileSync(join(paths(s.root).runs, 'live.json'), 'utf8')) as { paused?: boolean; passes: { task: string; stopping?: boolean }[] };
// Writes a stop request as the loop app does: whole, by rename.
function askToStop(s: Setup, task: string, request: Record<string, unknown>): string {
  const dir = join(paths(s.root).runs, 'stop-pass');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${task}.json`);
  writeFileSync(`${file}.tmp`, JSON.stringify({ at: new Date().toISOString(), ...request }));
  renameSync(`${file}.tmp`, file);
  return file;
}

scenario('runs/PAUSE: no pass starts while it exists, the loop waits instead of exiting, and passes run once it goes', async () => {
  const s = setup([{}, {}], {});
  const pause = join(paths(s.root).runs, 'PAUSE');
  mkdirSync(join(paths(s.root).runs), { recursive: true });
  writeFileSync(pause, '');
  const exit = s.run();
  let exited = false;
  void exit.then(() => (exited = true));
  await until('the loop waits, paused', () => lastLog.includes('paused with no pass in flight; waiting for runs/PAUSE to be removed'));
  // At a thousand times real speed, two seconds are over half an hour of the loop's time.
  await new Promise((r) => setTimeout(r, 2000));
  assert.equal(exited, false, 'a paused loop does not exit');
  assert.deepEqual(s.passes(), []);
  assert.equal(live(s).paused, true);
  rmSync(pause);
  assert.equal(await exit, EXIT.allDone);
  assert.equal(s.passes().filter((x) => x.outcome === 'merged').length, 2);
  const events = s.ledger().flatMap((e) => (e.kind === 'loop' ? [e.event] : e.kind === 'pass' ? ['pass'] : []));
  assert.deepEqual(events, ['start', 'pause', 'resume', 'pass', 'pass', 'exit']);
  assert.ok(lastLog.includes('resumed: runs/PAUSE was removed'));
  assert.equal(live(s).paused, undefined, 'live.json says nothing is paused once the loop has exited');
});

scenario('runs/PAUSE mid-run lets the pass in flight finish and starts no other; STOP while paused stops the loop', async () => {
  const s = setup([{}, {}], { 'T-0001': ['slow:3', 'implement'] }, (c) => {
    c.agents.codex.enabled = false; // one agent, so the second task waits for the first
  });
  const exit = s.run();
  await until('the first pass starts', () => lastLog.some((l) => l.includes('T-0001 → ')));
  writeFileSync(join(paths(s.root).runs, 'PAUSE'), '');
  await until('the loop sees the pause while the pass runs', () => lastLog.includes('paused (runs/PAUSE): no new passes start until it is removed'));
  await until('the pass in flight finishes, and the loop waits', () => lastLog.includes('paused with no pass in flight; waiting for runs/PAUSE to be removed'));
  assert.deepEqual(s.passes().map((x) => [x.task, x.outcome]), [['T-0001', 'merged']]);
  writeFileSync(join(paths(s.root).runs, 'STOP'), '');
  assert.equal(await exit, EXIT.stopped);
  assert.equal(s.task('T-0002').status, 'ready', 'no pass started while paused');
  assert.deepEqual(s.ledger().flatMap((e) => (e.kind === 'loop' ? [e.event] : [])), ['start', 'pause', 'exit']);
});

scenario('a stop request from the loop app ends a pass at once: the attempt is stopped and not counted, its work is kept, its note reaches the next attempt', async () => {
  // Pinned to Claude with a cap of two: had the stopped attempt counted, the gate failure after it would be the
  // last attempt, and the task would go to a person instead of merging on the third.
  const s = setup([{ agent: 'claude', notes: 'Original note.' }], { 'T-0001': ['stall:60', 'fail', 'implement'] }, (c) => {
    c.agents.codex.enabled = false;
    c.limits.max_attempts = 2;
  });
  const began = Date.now();
  const exit = s.run();
  await until('the first pass starts', () => lastLog.some((l) => l.includes('T-0001 → claude (attempt 1)')));
  await until('the agent is at work', () => live(s).passes.some((x) => x.task === 'T-0001') && existsSync(join(s.root, 'fake-state', 'T-0001@claude.args.json')));
  await new Promise((r) => setTimeout(r, 1000)); // the fake has written its work and stalls
  const request = askToStop(s, 'T-0001', { to: 'ready', note: 'Use the shared helper instead.', why: 'wrong approach' });
  assert.equal(await exit, EXIT.allDone);
  assert.ok(Date.now() - began < 40_000, 'the stalled agent was killed, not waited for');
  assert.equal(existsSync(request), false, 'the request is deleted once taken');
  assert.ok(lastLog.includes('T-0001: stopping its pass, as the loop app asked (wrong approach); it goes to ready'), 'the log says so');
  const t = s.task('T-0001');
  assert.deepEqual(t.attempts.map((a) => a.outcome), ['stopped', 'gate_failed', 'merged']);
  assert.equal(t.attempts[0]!.note, 'stopped from the loop app: wrong approach');
  assert.equal(t.attempts[0]!.kept, 'task/T-0001-claude-1');
  assert.equal(t.notes, 'Original note.\n\nUse the shared helper instead.');
  const [stopped] = s.passes('T-0001');
  assert.equal(stopped!.outcome, 'stopped');
  assert.equal(stopped!.kept, 'task/T-0001-claude-1');
  // The next attempt started from the kept work, and read the note in the task's notes.
  assert.ok(lastLog.includes('T-0001: starts from the work kept on task/T-0001-claude-1'), 'the retry carried the work');
  assert.match(readFileSync(join(s.root, 'fake-state', 'T-0001.prompt-2.md'), 'utf8'), /Use the shared helper instead\./);
});

scenario('a stop request can send the task to a person; one for a task with no pass in flight is dropped', async () => {
  const s = setup([{}], { 'T-0001': ['stall:60'] }, (c) => {
    c.agents.codex.enabled = false;
  });
  const stale = askToStop(s, 'T-0099', { to: 'ready' });
  const exit = s.run();
  await until('the first pass starts', () => lastLog.some((l) => l.includes('T-0001 → claude')));
  await until('the stale request is dropped', () => !existsSync(stale));
  assert.ok(lastLog.includes('T-0099: stop request ignored: no pass of it is running'));
  await new Promise((r) => setTimeout(r, 1000));
  askToStop(s, 'T-0001', { to: 'needs_human' });
  await until('live.json shows the pass stopping, or already gone', () => !live(s).passes.length || live(s).passes[0]!.stopping === true);
  assert.equal(await exit, EXIT.onlyHumanWork);
  const t = s.task('T-0001');
  assert.equal(t.status, 'needs_human');
  assert.deepEqual(t.attempts.map((a) => [a.outcome, a.note]), [['stopped', 'stopped from the loop app']]);
  assert.equal(t.attempts[0]!.kept, 'task/T-0001-claude-1');
  assert.equal(t.summary, 'stopped from the loop app');
  assert.equal(t.notes, undefined);
});

scenario('a task handed back by a person runs again without a restart', async () => {
  const s = setup([{}, {}], { 'T-0001': ['blocked', 'implement'], 'T-0002': ['slow:8', 'implement'] });
  const exit = s.run();
  for (let i = 0; i < 100 && s.task('T-0001').status !== 'needs_human'; i++) await new Promise((r) => setTimeout(r, 100));
  assert.equal(s.task('T-0001').status, 'needs_human');
  // Hand it back the way a person would: set it ready in its file while the loop runs.
  const file = join(paths(s.root).plan, 'tasks', 'T-0001.yaml');
  writeFileSync(file, readFileSync(file, 'utf8').replace('status: needs_human', 'status: ready'));
  assert.equal(await exit, EXIT.allDone);
  assert.equal(s.task('T-0001').status, 'done');
  assert.ok(lastLog.some((l) => l.includes('T-0001: handed back by a person')));
});

scenario('a task the loop is not running can be revised on disk while it runs; an edit during a pass is reported, not taken', async () => {
  const s = setup([{}, {}, { blocked_by: ['T-0001'] }], { 'T-0001': ['slow:4'], 'T-0002': ['slow:10'] });
  const exit = s.run();
  const until = async (what: string, ok: () => boolean) => {
    for (let i = 0; i < 150 && !ok(); i++) await new Promise((r) => setTimeout(r, 100));
    assert.ok(ok(), what);
  };
  const file = (id: string) => join(paths(s.root).plan, 'tasks', `${id}.yaml`);
  await until('both agents hold a task', () => s.task('T-0001').status === 'claimed' && s.task('T-0002').status === 'claimed');
  // Park the task that waits on T-0001, and retitle T-0002 during its pass.
  writeFileSync(file('T-0003'), readFileSync(file('T-0003'), 'utf8').replace('status: ready', 'status: parked'));
  const t2 = parse(readFileSync(file('T-0002'), 'utf8')) as Task;
  writeFileSync(file('T-0002'), stringify({ ...t2, title: `${t2.title}, edited during its pass` }));
  await until('the parked task is taken', () => lastLog.some((l) => l.includes('T-0003: changed by a person; taken from disk (now parked)')));
  // A file caught mid-save makes a round skip the reload; it doesn't stop the loop.
  writeFileSync(file('T-0004'), 'id: T-0004\nstatus: [');
  assert.equal(await exit, EXIT.onlyHumanWork);
  assert.ok(lastLog.some((l) => l.startsWith('plan reload skipped') || l.includes(' plan reload skipped')), 'the broken file was skipped');
  assert.ok(lastLog.some((l) => l.includes("T-0002: changed on disk during its pass; the loop's copy wins")));
  assert.equal(s.task('T-0003').status, 'parked');
  assert.ok(!s.passes().some((p) => p.task === 'T-0003'), 'the parked task never ran');
  assert.equal(s.task('T-0002').status, 'done');
  assert.doesNotMatch(s.task('T-0002').title, /edited during its pass/, 'the loop wrote its own copy back');
});

scenario('the daily budget takes an agent out until midnight', async () => {
  const s = setup([{}, {}, {}, {}], { 'T-0001@claude': ['cost:500+implement'], 'T-0002@claude': ['cost:500+implement'] }, (c) => {
    c.limits.daily_budget_usd.claude = 100;
  });
  assert.equal(await s.run(), EXIT.allDone);
  const claudePasses = s.passes().filter((p) => p.agent === 'claude');
  assert.equal(claudePasses.length, 1, 'claude stopped after spending its budget');
  assert.ok(s.modes().includes('single:codex'));
});

scenario('blocked_by and stages order the work; --max-passes stops with exit 3', async () => {
  const s = setup([{}, { blocked_by: ['T-0001'] }, { stage: 'day2' }], {});
  assert.equal(await s.run({ maxPasses: 2 }), EXIT.stopped);
  assert.equal(s.task('T-0001').status, 'done');
  assert.equal(s.task('T-0002').status, 'done');
  assert.equal(s.task('T-0003').status, 'ready');
  const order = s.passes().map((p) => p.task);
  assert.deepEqual(order, ['T-0001', 'T-0002']);
});

scenario('a mascot task pinned to Codex in the design role runs on Astra; the rest of the work is shared', async () => {
  const s = setup([{ agent: 'codex', role: 'design', area: 'mascot/home' }, {}, {}], {});
  assert.equal(await s.run(), EXIT.allDone);
  const mascot = s.passes('T-0001');
  assert.equal(mascot.length, 1);
  assert.equal(mascot[0]!.agent, 'codex');
  assert.equal(mascot[0]!.model, 'gpt-6-astra');
  // What the codex CLI was actually asked to run, not only what the ledger says.
  const args = JSON.parse(readFileSync(join(s.root, 'fake-state', 'T-0001@codex.args.json'), 'utf8')) as string[];
  assert.equal(args[args.indexOf('-m') + 1], 'gpt-6-astra');
  assert.ok(args.includes('model_reasoning_effort="xhigh"'), args.join(' '));
  assert.ok(s.passes().some((p) => p.agent === 'claude'));
});

scenario('release tags: every N merges in a repo, and when a stage closes; workflows only from ci-area tasks', async () => {
  const s = setup(
    [{}, {}, {}, { repo: 'acme-docs' }, { area: 'ci', stage: 'day2' }, { stage: 'day2' }],
    { 'T-0006': ['ciwrite', 'implement'], 'T-0005': ['ciwrite'] },
    (c) => {
      c.release.every_merged_tasks = 2;
    },
  );
  assert.equal(await s.run(), EXIT.allDone);
  const releases = s.ledger().filter((e): e is Extract<LedgerEvent, { kind: 'release' }> => e.kind === 'release');
  const app = releases.filter((r) => r.repo === 'acme-app');
  assert.ok(app.some((r) => r.reason.startsWith('Checkpoint')), JSON.stringify(releases));
  assert.ok(releases.some((r) => r.repo === 'acme-docs' && r.reason === 'Stage day1 closed' && r.tasks.includes('T-0004')), JSON.stringify(releases));
  const tags = execFileSync('git', ['tag', '--list', 'v*'], { cwd: join(paths(s.root).repos, 'acme-app') }).toString().trim().split('\n');
  assert.ok(tags.length >= 2 && tags.every((t) => /^v\d{4}\.\d{2}\.\d{2}\.\d+$/.test(t)), tags.join(','));
  assert.equal(s.task('T-0006').attempts[0]!.outcome, 'forbidden_paths');
  assert.equal(s.task('T-0005').attempts[0]!.outcome, 'merged');
});

scenario('a stop file ends a wait for an agent to be back at once, not at its reset', async () => {
  const s = setup([{}], { 'T-0001@claude': ['limit:600'], 'T-0001@codex': ['limit:600'] });
  const run = s.run();
  // Both agents are at their limits for ten hours (36 seconds here): the loop waits for the first reset.
  const deadline = Date.now() + 20_000;
  while (!lastLog.some((l) => /^waiting until /.test(l)) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
  writeFileSync(join(paths(s.root).runs, 'STOP'), '');
  const stopped = Date.now();
  assert.equal(await run, EXIT.stopped);
  assert.ok(Date.now() - stopped < 10_000, `the loop took ${Date.now() - stopped} ms to stop`);
});

scenario('an agent with nothing to take while the other is out says so', async () => {
  // Two failures with Claude: the last attempt is Codex's, and Codex is at its limit for two hours.
  const failed = { agent: 'claude' as const, outcome: 'gate_failed' as const, at: '2026-10-24T10:00:00.000Z', log: '', note: 'the gate failed: x' };
  const s = setup([{ attempts: [failed, failed] }], { 'T-0001@codex': ['limit:120', 'implement'] });
  assert.equal(await s.run(), EXIT.allDone);
  assert.ok(lastLog.some((l) => /^waiting until .* for codex; claude has nothing it can take$/.test(l)), 'the log says why');
  assert.ok(s.notes.some((n) => n.title === 'The loop is idle' && /^claude has nothing it can take until codex is back at /.test(n.message)), JSON.stringify(s.notes));
  assert.equal(s.task('T-0001').attempts.at(-1)!.agent, 'codex');
});

scenario('an agent that writes into the primary checkout stops the loop', async () => {
  const s = setup([{}, {}, {}], { 'T-0001': ['tamper'] });
  assert.equal(await s.run(), EXIT.stopped);
  assert.ok(s.ledger().some((e) => e.kind === 'warning' && e.detail.includes('primary checkout')));
});

const releasesOf = (s: Setup, repo: string) => s.ledger().filter((e): e is Extract<LedgerEvent, { kind: 'release' }> => e.kind === 'release' && e.repo === repo);
const heldOf = (s: Setup, repo: string) => s.ledger().filter((e): e is Extract<LedgerEvent, { kind: 'release_held' }> => e.kind === 'release_held' && e.repo === repo);

scenario('someone pushes to origin mid-run: main catches up first, the task is re-gated, and main and its tag reach origin', async () => {
  const s = setup([{}, { blocked_by: ['T-0001'] }], { 'T-0001': ['upstream'] }, (c) => {
    c.push = true;
    c.release.every_merged_tasks = 2;
  });
  const origin = s.origin('acme-app');
  assert.equal(await s.run(), EXIT.allDone);
  assert.deepEqual(s.task('T-0001').attempts.map((a) => a.outcome), ['merged']);
  assert.equal(s.task('T-0002').status, 'done');
  assert.ok(s.main().includes('Upstream change during T-0001'), s.main().join('\n'));
  const merges = s.ledger().filter((e): e is Extract<LedgerEvent, { kind: 'merge' }> => e.kind === 'merge');
  assert.equal(merges.find((e) => e.task === 'T-0001')?.regated, true, 'main moved under the task, so it was re-gated');
  assert.ok(lastLog.some((l) => l.includes('main caught up with origin/main')));
  assert.ok(s.passes().every((x) => !x.note?.includes('push failed')));
  assert.equal(execFileSync('git', ['rev-parse', 'main'], { cwd: origin }).toString().trim(), s.git('acme-app', 'rev-parse', 'main'));
  const releases = releasesOf(s, 'acme-app');
  assert.equal(releases.length, 1);
  assert.equal(releases[0]!.pushed, true);
  assert.equal(execFileSync('git', ['tag', '--list', 'v*'], { cwd: origin }).toString().trim(), releases[0]!.tag);
});

scenario('origin rewritten mid-run: nothing merges into that repo, the task keeps its branch and waits, and runs once main and origin agree', async () => {
  const s = setup(
    [{}, { repo: 'acme-docs' }],
    { 'T-0001': ['diverge', 'implement'], 'T-0002': ['reconcile:acme-app'] },
    (c) => {
      c.push = true;
      c.agents.codex.enabled = false; // one agent, so the passes run in a known order
    },
  );
  const origin = s.origin('acme-app');
  // Without the hold the loop would retry T-0001 forever (the attempts are not counted); the cap makes that fail fast.
  assert.equal(await s.run({ maxPasses: 10 }), EXIT.allDone);
  // T-0001 ranks first, yet its repo took no task while it was held; T-0002's pass reconciled it.
  assert.deepEqual(s.passes().map((x) => x.task), ['T-0001', 'T-0002', 'T-0001']);
  const t1 = s.task('T-0001');
  assert.deepEqual(t1.attempts.map((a) => a.outcome), ['transient', 'merged']);
  assert.match(t1.attempts[0]!.note ?? '', /have diverged.*kept on branch task\/T-0001-claude-1/s);
  // That note is for Daniel: the retry's prompt carries no failure, since the code did not fail.
  assert.doesNotMatch(readFileSync(join(s.root, 'fake-state', 'T-0001@claude.prompt.md'), 'utf8'), /Your previous attempt failed|diverged/);
  // The refused work was kept, the retry started from it, and its branch went once the task merged.
  assert.equal(t1.attempts[0]!.kept, 'task/T-0001-claude-1');
  assert.ok(lastLog.some((l) => l === 'T-0001: starts from the work kept on task/T-0001-claude-1'), 'the retry carried it');
  assert.equal(s.git('acme-app', 'branch', '--list', 'task/*'), '');
  assert.ok(s.ledger().some((e) => e.kind === 'warning' && e.task === 'T-0001' && e.detail.includes('have diverged')));
  assert.deepEqual(s.notes.map((n) => n.title).filter((t) => t.includes('diverged')), ['acme-app has diverged from origin']);
  assert.ok(lastLog.some((l) => l.includes('acme-app: main and origin/main agree again')));
  assert.equal(execFileSync('git', ['rev-parse', 'main'], { cwd: origin }).toString().trim(), s.git('acme-app', 'rev-parse', 'main'));
});

scenario('no release is pushed into a repo whose origin was rewritten after its last merge; other repos release as usual', async () => {
  const s = setup([{}, { repo: 'acme-docs', blocked_by: ['T-0001'] }], { 'T-0002': ['diverge:acme-app'] }, (c) => {
    c.push = true;
  });
  const origin = s.origin('acme-app');
  assert.equal(await s.run(), EXIT.allDone);
  // T-0001 merged and was pushed; then origin/main was rewritten, and the stage closed.
  assert.deepEqual(s.tags('acme-app'), []);
  assert.equal(execFileSync('git', ['tag', '--list'], { cwd: origin }).toString().trim(), '', 'no tag republished the dropped commit');
  const [held] = heldOf(s, 'acme-app');
  assert.deepEqual(held?.tasks, ['T-0001']);
  assert.match(held?.detail ?? '', /^while main \(\w{12}\) and origin\/main \(\w{12}\) have diverged/);
  assert.deepEqual(s.notes.map((n) => n.title).filter((t) => t.includes('diverged')), ['acme-app has diverged from origin']);
  assert.equal(s.tags('acme-docs').length, 1);
});

scenario('a repo released only after its human step: held until HT-25 is done, then the next release carries the held tasks', async () => {
  const s = setup(
    [{ repo: 'acme-website' }, { repo: 'acme-website' }, {}],
    {},
    (c) => {
      c.release.every_merged_tasks = 2;
      c.release.hold_until = { 'acme-website': 'HT-25' };
    },
    [{ id: 'HT-25', status: 'in_progress' }],
  );
  assert.equal(await s.run(), EXIT.allDone);
  const held = heldOf(s, 'acme-website');
  assert.deepEqual(held.map((e) => e.reason), ['Checkpoint every 2 tasks', 'Stage day1 closed']);
  assert.ok(held.every((e) => e.detail === 'until HT-25 is done (it is in_progress)'), JSON.stringify(held));
  assert.deepEqual(s.tags('acme-website'), []);
  assert.equal(s.tags('acme-app').length, 1, 'other repos release as usual');
  assert.match(s.cli('status').out, /acme-website: releases held until HT-25 is done \(in_progress\)/);

  s.human({ id: 'HT-25', status: 'done' });
  s.add([{ id: 'T-0004', repo: 'acme-website', stage: 'day2' }]);
  assert.equal(await s.run(), EXIT.allDone);
  const [release, ...more] = releasesOf(s, 'acme-website');
  assert.equal(more.length, 0);
  assert.deepEqual([...release!.tasks].sort(), ['T-0001', 'T-0002', 'T-0004']);
  assert.deepEqual(s.tags('acme-website'), [release!.tag]);
});

scenario('a release that changes CI workflows waits for approval; later ones wait behind it, then are named and filled right', async () => {
  // A chain of tasks, so the merges (and so the checkpoints) come in a known order.
  const s = setup(
    [{ area: 'ci' }, { blocked_by: ['T-0001'] }, { blocked_by: ['T-0002'] }, { blocked_by: ['T-0003'] }],
    { 'T-0001': ['ciwrite'] },
    (c) => {
      c.release.every_merged_tasks = 2;
    },
  );
  const repo = 'acme-app';
  const approvals = join(paths(s.root).runs, 'approvals');
  assert.equal(await s.run(), EXIT.allDone);
  // One approval, from the first checkpoint; the next checkpoint and the stage release wait behind it.
  const files = readdirSync(approvals);
  assert.equal(files.length, 1, files.join(', '));
  const approval = JSON.parse(readFileSync(join(approvals, files[0]!), 'utf8')) as Approval;
  assert.equal(files[0], `${repo}-${approval.tag}.json`);
  assert.deepEqual(approval.paths, ['.github/workflows/ci.yml']);
  assert.equal(approval.tasks.length, 2);
  assert.equal(approval.tasks[0]!.id, 'T-0001');
  assert.match(execSync(approval.review).toString(), /^\+on: \[push, pull_request\]$/m, 'the review command shows the change');
  assert.deepEqual(s.tags(repo), [], 'nothing was tagged');
  const held = heldOf(s, repo);
  assert.deepEqual(held.map((e) => e.reason), ['Checkpoint every 2 tasks', 'Checkpoint every 2 tasks', 'Stage day1 closed']);
  assert.ok(held.every((e) => e.tag === approval.tag && e.approval === `runs/approvals/${files[0]}`), JSON.stringify(held));
  assert.match(held[0]!.detail, /^for approval: /);
  assert.ok(held.slice(1).every((e) => e.detail.startsWith(`behind ${approval.tag}`)));
  assert.deepEqual(s.notes.filter((n) => n.title === 'A release needs your approval').length, 1);
  const status = s.cli('status').out;
  assert.match(status, new RegExp(`${repo} ${approval.tag.replace(/\./g, '\\.')} waits for approval: it changes \\.github/workflows/ci\\.yml since the root commit`));
  assert.ok(status.includes(`approve: helix-loop release approve ${repo} ${approval.tag}`), status);

  const wrong = s.cli('release', 'approve', repo, 'v1999.01.01.1');
  assert.equal(wrong.code, 1);
  assert.match(wrong.out, /No release of acme-app waits for approval as v1999\.01\.01\.1/);
  const approved = s.cli('release', 'approve', repo, approval.tag);
  assert.equal(approved.code, 0, approved.out);
  assert.equal(s.git(repo, 'rev-parse', `${approval.tag}^{commit}`), approval.commit);
  assert.deepEqual(readdirSync(approvals), []);

  // After the approval, releases resume from it: the next tag follows it, and every task is released once.
  s.add([{ id: 'T-0005', stage: 'day2' }, { id: 'T-0006', stage: 'day2', blocked_by: ['T-0005'] }]);
  assert.equal(await s.run(), EXIT.allDone);
  const releases = releasesOf(s, repo);
  assert.deepEqual(releases.map((r) => r.tasks), [['T-0001', 'T-0002'], ['T-0003', 'T-0004', 'T-0005', 'T-0006']]);
  assert.equal(releases[0]!.tag, approval.tag);
  assert.deepEqual(s.tags(repo), releases.map((r) => r.tag));
  const [prev, next] = releases.map((r) => r.tag) as [string, string];
  const n = (t: string) => Number(t.split('.').pop());
  assert.equal(n(next), next.slice(0, 11) === prev.slice(0, 11) ? n(prev) + 1 : 1, `${prev} → ${next}`);
  assert.equal(heldOf(s, repo).length, held.length, 'no hold after the approval');
});

scenario('helix-loop release run says what holds a repo and releases it once the hold lifts; a failed tag push is retried by the next release and at loop start', async () => {
  const repo = 'acme-website';
  const s = setup([{ repo }], {}, (c) => {
    c.push = true;
    c.release.hold_until = { [repo]: 'HT-25' };
  }, [{ id: 'HT-25', status: 'todo' }]);
  const origin = s.origin(repo);
  const originTags = () => execFileSync('git', ['tag', '--list'], { cwd: origin }).toString().trim().split('\n').filter(Boolean);
  assert.equal(await s.run(), EXIT.allDone); // T-0001 is merged and pushed; its release is held at the stage close

  let out = s.cli('release', 'run', repo);
  assert.equal(out.code, 10, out.out);
  assert.ok(out.out.includes(`${repo} is not released: held until HT-25 is done (it is todo).\nTo lift the hold: mark HT-25 done in plan/human/HT-25.yaml once it is.`), out.out);
  assert.deepEqual(s.tags(repo), []);

  // HT-25 is done, but origin can't be reached: the tag is made and its push fails.
  s.human({ id: 'HT-25', status: 'done' });
  renameSync(origin, `${origin}.away`);
  out = s.cli('release', 'run', repo);
  renameSync(`${origin}.away`, origin);
  assert.equal(out.code, 1, out.out);
  const [tag] = s.tags(repo) as [string];
  assert.match(out.out, new RegExp(`^${repo} ${tag} is tagged at \\w{12}, but the push failed`, 'm'));
  assert.deepEqual(originTags(), []);
  assert.deepEqual(releasesOf(s, repo).map((r) => [r.tag, r.tasks, r.reason, r.pushed]), [[tag, ['T-0001'], 'Released by hand', false]]);

  // The next release pushes it first. Main has nothing new, and a tag that is not a release tag stays local.
  s.git(repo, 'tag', 'scratch');
  out = s.cli('release', 'run', repo);
  assert.equal(out.code, 0, out.out);
  assert.ok(out.out.includes(`Pushed ${tag} to origin; an earlier push had failed.\n${repo}: main (`), out.out);
  assert.ok(out.out.includes(`) is already released as ${tag}; nothing new to release.`), out.out);
  assert.deepEqual(originTags(), [tag]);

  // So does the loop when it starts.
  execFileSync('git', ['tag', '-d', tag], { cwd: origin });
  assert.equal(await s.run(), EXIT.allDone);
  assert.deepEqual(originTags(), [tag]);
  const retries = s.ledger().filter((e): e is Extract<LedgerEvent, { kind: 'release_retry' }> => e.kind === 'release_retry');
  assert.deepEqual(retries.map((e) => [e.repo, e.tags, e.pushed]), [[repo, [tag], true], [repo, [tag], true]]);
});

scenario('a change under infra/ alone waits for approval, and an ordinary change does not', async () => {
  const repo = 'acme-app';
  const s = setup([{}, { blocked_by: ['T-0001'] }], { 'T-0002': ['infrawrite'] }, (c) => {
    c.release.every_merged_tasks = 1;
  });
  assert.equal(await s.run(), EXIT.allDone);
  const releases = releasesOf(s, repo);
  assert.deepEqual(releases.map((r) => r.tasks), [['T-0001']], 'the ordinary change was released at its checkpoint');
  const [file, ...more] = readdirSync(join(paths(s.root).runs, 'approvals'));
  assert.equal(more.length, 0);
  const approval = JSON.parse(readFileSync(join(paths(s.root).runs, 'approvals', file!), 'utf8')) as Approval;
  assert.deepEqual([approval.paths, approval.tasks.map((t) => t.id), approval.since], [['infra/main.tf'], ['T-0002'], releases[0]!.tag]);
  assert.match(execSync(approval.review).toString(), /^\+resource "digitalocean_app" "web" \{\}$/m);
  // `release` says what holds it, and what to run.
  const out = s.cli('release', 'run', repo);
  assert.equal(out.code, 10, out.out);
  assert.ok(out.out.includes(`held behind ${approval.tag}, which waits for approval of its changes to infra/main.tf.`), out.out);
  assert.ok(out.out.includes(`To lift the hold: read the diff with ${approval.review}, then run ${approval.approve}.`), out.out);
});

scenario('builders inherit nothing from a parent Claude Code or Codex session: only what the adapter and the loop set', async () => {
  const parent: Record<string, string> = {
    CLAUDECODE: '1', CLAUDE_EFFORT: 'max', CLAUDE_CODE_SESSION_ID: 'parent-session', CLAUDE_CODE_MESSAGING_SOCKET: '/tmp/parent.sock',
    CODEX_SANDBOX: 'seatbelt', CODEX_THREAD_ID: 'parent-thread', AI_AGENT: 'claude-code', MCP_CONNECTION_NONBLOCKING: 'true',
    VSCODE_IPC_HOOK: '/tmp/vscode.sock', ELECTRON_RUN_AS_NODE: '1', ANTHROPIC_API_KEY: 'not-a-key', OPENAI_API_KEY: 'not-a-key',
  };
  const saved = Object.fromEntries(Object.keys(parent).map((k) => [k, process.env[k]]));
  Object.assign(process.env, parent);
  try {
    const s = setup([{}, {}], {});
    assert.equal(await s.run(), EXIT.allDone);
    const state = join(s.root, 'fake-state');
    const seen = (agent: string) => JSON.parse(readFileSync(join(state, readdirSync(state).find((f) => f.endsWith(`@${agent}.env.json`))!), 'utf8')) as string[];
    for (const agent of ['claude', 'codex']) {
      const names = seen(agent);
      const leaked = names.filter((n) => n in parent || (/^(CLAUDE|CODEX|ANTHROPIC_|OPENAI_|MCP_|VSCODE_)/.test(n) && n !== 'CODEX_HOME'));
      assert.deepEqual(leaked, [], agent);
      for (const kept of ['PATH', 'HOME', 'HELIX_LOOP_NOW', 'HELIX_FAKE_STATE']) assert.ok(names.includes(kept), `${agent} keeps ${kept}`);
    }
    assert.ok(seen('codex').includes('CODEX_HOME'), 'the codex adapter sets its home on purpose');
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

const node = (m: MapModel, id: string) => m.nodes.find((n) => n.id === id)!;
const mapOnDisk = (s: Setup): MapModel => {
  const html = readFileSync(join(paths(s.root).plan, 'DependencyMap.html'), 'utf8');
  return JSON.parse(/<script type="application\/json" id="model">([\s\S]*?)<\/script>/.exec(html)![1]!) as MapModel;
};

scenario('after every pass the dependency map shows each task\'s status and summary: what merged, what failed, why it is blocked', async () => {
  const s = setup([{}, { blocked_by: ['T-0001'] }, {}], { 'T-0002': ['blocked'], 'T-0003': ['fail', 'implement'] }, (c) => {
    c.agents.codex.enabled = false; // one agent, so the passes run one at a time, in rank order
  });
  assert.equal(await s.run(), EXIT.onlyHumanWork);
  assert.deepEqual(s.passes().map((x) => x.task), ['T-0001', 'T-0002', 'T-0003', 'T-0003']);
  // A task without a summary has none on the map.
  assert.ok(!('summary' in node(s.maps[0]!, 'T-0001')));
  // The map is written as each pass ends, not only when the loop exits.
  const afterMerge = s.maps.find((m) => node(m, 'T-0001').status === 'done');
  assert.deepEqual([node(afterMerge!, 'T-0001').summary, node(afterMerge!, 'T-0002').status], ['implement the task', 'ready']);
  const afterFailure = s.maps.find((m) => node(m, 'T-0003').summary?.startsWith('gate failed'));
  assert.deepEqual([node(afterFailure!, 'T-0003').status, node(afterFailure!, 'T-0003').summary], ['ready', 'gate failed: adds numbers']);
  // The file Daniel has open.
  const map = mapOnDisk(s);
  assert.deepEqual(['T-0001', 'T-0002', 'T-0003'].map((id) => [node(map, id).status, node(map, id).summary]), [
    ['done', 'implement the task'],
    ['needs_human', 'blocked: the spec contradicts itself on this point; a person must decide.'],
    ['done', 'implement the task'],
  ]);
  assert.deepEqual(readdirSync(join(paths(s.root).plan)).filter((f) => f.includes('.tmp-')), [], 'written by rename, with no temp file left behind');
  // The summary lives in the task file; the attempt notes the next prompt reads are untouched.
  assert.equal(s.task('T-0002').summary, 'blocked: the spec contradicts itself on this point; a person must decide.');
  assert.equal(s.task('T-0002').attempts[0]!.note, 'BLOCKED: the spec contradicts itself on this point; a person must decide.');
  assert.ok(existsSync(logFile(s.root, s.task('T-0002').attempts[0]!.log)), 'the blocked attempt points at its compressed log');
});

scenario('plan commits carry the task files after each merge, and the dependency map only when a stage closes', async () => {
  const s = setup([{}, { blocked_by: ['T-0001'] }], {});
  // A control plane under git, like the real one, where Daniel is editing a plan document.
  const cp = (...args: string[]) => execFileSync('git', args, { cwd: s.root }).toString().trim();
  writeFileSync(join(s.root, '.gitignore'), ['.helix/runs/', '.helix/repos/', '.helix/worktrees/', 'fake-state/', 'codex-home/', 'scenario.json', ''].join('\n'));
  writeFileSync(join(paths(s.root).plan, 'notes.md'), 'a draft\n');
  cp('init', '-q', '-b', 'main');
  cp('add', '-A');
  cp('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'control plane');
  writeFileSync(join(paths(s.root).plan, 'notes.md'), 'a draft, being edited\n');
  assert.equal(await s.run(), EXIT.allDone);
  const commits = cp('log', '--format=%x00%s', '--name-only').split('\0').filter(Boolean).map((c) => {
    const [subject, ...files] = c.trim().split('\n');
    return { subject: subject!, files: files.filter(Boolean) };
  });
  const map = '.helix/plan/DependencyMap.html';
  const first = commits.find((c) => c.subject.startsWith('plan: T-0001 done'))!;
  const closing = commits.find((c) => c.subject.startsWith('plan: T-0002 done'))!;
  assert.ok(first.files.includes('.helix/plan/tasks/T-0001.yaml') && !first.files.includes(map), JSON.stringify(first));
  assert.match(closing.subject, /; stage day1 closed$/);
  assert.ok(closing.files.includes('.helix/plan/tasks/T-0002.yaml') && closing.files.includes(map), JSON.stringify(closing));
  // The snapshot shows the stage done; the loop never commits anything else under plan/.
  const snapshot = JSON.parse(/<script type="application\/json" id="model">([\s\S]*?)<\/script>/.exec(cp('show', `HEAD:${map}`))![1]!) as MapModel;
  assert.deepEqual(['T-0001', 'T-0002'].map((id) => node(snapshot, id).status), ['done', 'done']);
  assert.equal(cp('status', '--porcelain', '--', '.helix/plan/notes.md'), 'M .helix/plan/notes.md');
});

scenario('with the loop app up, builders report over MCP; their issues go into the attempt\'s note, and live.json empties at the end', async () => {
  let config: Config | undefined;
  const s = setup([{}, {}], { 'T-0001': ['issue:spec_question+implement'] }, (c) => (config = c));
  const app = await startApp({ root: s.root, port: 0 });
  try {
    config!.app = { port: Number(new URL(app.url).port) };
    assert.equal(await s.run(), EXIT.allDone);
  } finally {
    await app.close();
  }
  const reports = readFileSync(join(paths(s.root).runs, 'reports.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { pass: string; kind: string; issue?: string });
  assert.ok(reports.some((r) => r.pass.startsWith('T-0001:') && r.kind === 'progress'), 'T-0001 reported progress');
  assert.ok(reports.some((r) => r.pass.startsWith('T-0002:') && r.kind === 'progress'), 'T-0002 reported progress');
  assert.deepEqual(reports.filter((r) => r.kind === 'issue').map((r) => [r.pass.split(':')[0], r.issue]), [['T-0001', 'spec_question']]);
  assert.match(s.task('T-0001').attempts[0]!.note ?? '', /The builder reported:\n- spec_question: /);
  assert.doesNotMatch(s.task('T-0002').attempts[0]!.note ?? '', /The builder reported/);
  const live = JSON.parse(readFileSync(join(paths(s.root).runs, 'live.json'), 'utf8')) as { passes: unknown[] };
  assert.deepEqual(live.passes, []);
});

scenario('a CLI signed in with an API key builds nothing: the loop says so once, and the other agent builds everything', async () => {
  const s = setup([{}, {}, {}], {});
  process.env.HELIX_FAKE_AUTH_CLAUDE = 'apikey';
  try {
    assert.equal(await s.run(), EXIT.allDone);
  } finally {
    delete process.env.HELIX_FAKE_AUTH_CLAUDE;
  }
  assert.deepEqual([...new Set(s.passes().map((p) => p.agent))], ['codex']);
  const warnings = s.ledger().filter((e) => e.kind === 'warning' && /claude is not signed in with its subscription \(API key\)/.test(e.detail));
  assert.equal(warnings.length, 1);
  assert.equal(s.notes.filter((n) => /Sign claude in with its subscription/.test(n.message)).length, 1);
});
