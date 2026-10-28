import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { builderEnv, scriptsIn, type Activity, type Adapter, type AgentResult, type PassMcp } from './agents/adapter.ts';
import { signIn, type SignIn } from './agents/auth.ts';
import { hashToken, LiveBoard, newToken } from './live.ts';
import { describePace, loadQuota, loopMode, mapAgents, markAvailable, markLimited, overBudget, paceSlots, rollDay, saveQuota, helixSpentUsd, type Pace, type QuotaState } from './agents/quota.ts';
import type { Clock } from './clock.ts';
import { suspensionWatch } from './clock.ts';
import { asset, gitAuthor, productEnv, projectInfo, repoConfig, weeklyTargets, type Config, type Paths } from './config.ts';
import { commitLeftovers, runGate, type GateStep } from './gate.ts';
import { addWorktree, branchFor, commitsAhead, ensureUnionMerge, git, gitOk, head, removeWorktree } from './git.ts';
import { compress, meanPassHours, readLedger, record, type LedgerEvent, type PassPhases } from './ledger.ts';
import { computeMap, rankTasks } from './map/graph.ts';
import { buildMetrics } from './metrics/model.ts';
import { readVersions, VERSION_EVERY, writeVersion } from './metrics/archive.ts';
import { normaliseFailure } from './metrics/model.ts';
import { failingTest, filedFor, fixTaskFor, nextFixId, RECURRING_WINDOW_MS, reopenedFix, type FailureSeen } from './flaky.ts';
import { taskHistory } from './metrics/render.ts';
import { carryInto, compareWithOrigin, MergeQueue, mergeTask } from './merge.ts';
import { releaseRepo, releaseSettings, retryTagPushes, unreleased } from './release.ts';
import { E2ERunner, type E2EUse } from './e2e-runner.ts';
import { statSync } from 'node:fs';
import { sh } from './proc.ts';
import { Semaphore } from './semaphore.ts';
import type { Notifier } from './notify.ts';
import { atomicWrite, loadPlan, writeTask } from './plan/store.ts';
import { clipNote, clipSummary, firstLine } from './summary.ts';
import { membership, reachedBy, recordedReached } from './plan/milestones.ts';
import { errorsOnly, validateGraph, validateHierarchy, validateMilestones, validateReleaseHolds, validateRepos, validateSchemas, validateState, validateStructure } from './plan/validate.ts';
import { BUILDER_NICE, run } from './proc.ts';
import { loadTemplate, PromptOverBudget, renderPrompt, type CarriedWork } from './prompt.ts';
import { conflictCount, countedAttempts, onlyHumanWorkLeft, pick } from './sched/scheduler.ts';
import { loadIndex } from './spec/index.ts';
import { AGENTS, UNCOUNTED_OUTCOMES, type AgentName, type Attempt, type AttemptOutcome, type CarryReason, type LoopMode, type MapModel, type Plan, type Task, type TaskStatus } from './types.ts';

// The loop (design doc §4 and §7). It owns every decision a script can make: what runs, where,
// when to wait, what reaches main. Agents only write one task's code and tests.

export const EXIT = {
  allDone: 0,
  harnessError: 1,
  stopped: 3, // runs/STOP or a signal
  onlyHumanWork: 10,
} as const;

export interface LoopDeps {
  config: Config;
  paths: Paths;
  clock: Clock;
  adapters: Record<AgentName, Adapter>;
  notify: Notifier;
  renderMap: (model: MapModel) => string;
  log: (line: string) => void;
  maxPasses?: number; // stop after this many passes (pilot runs)
  keepAwake?: boolean; // hold a caffeinate assertion while running (on by default on macOS)
  signal?: AbortSignal;
}

interface Running {
  task: Task;
  agent: AgentName;
  promise: Promise<void>;
}

const iso = (t: number) => new Date(t).toISOString();

export async function runLoop(deps: LoopDeps): Promise<number> {
  const { config, paths: p, clock, notify, log } = deps;
  mkdirSync(p.runs, { recursive: true });
  mkdirSync(p.logs, { recursive: true });

  if (!acquireLock(p.lock)) {
    log(`Another loop holds ${p.lock}. Exiting.`);
    return EXIT.harnessError;
  }
  const stopAwake = deps.keepAwake !== false ? keepAwake() : () => {};
  let runnerRef: E2ERunner | undefined;
  let stopWatching = () => {};
  const live = new LiveBoard(p.live, clock);
  const finish = (code: number, detail?: string) => {
    record(p.ledger, { kind: 'loop', at: iso(clock.now()), event: 'exit', code, detail });
    stopWatching();
    live.close();
    void runnerRef?.stop();
    stopAwake();
    rmSync(p.lock, { force: true });
    return code;
  };

  try {
    const problems = [...validateSchemas(p.schema, p.tasks, p.human)];
    const plan = loadPlan(p.tasks, p.human);
    problems.push(...validateGraph(plan), ...validateRepos(plan, config.repos), ...validateState(plan), ...validateReleaseHolds(plan, config.release.hold_until));
    // The TaskSet's hierarchy and the milestones: a plan without milestones has no delivery order, and is refused.
    problems.push(...errorsOnly([...validateHierarchy(plan, config.repos), ...validateMilestones(plan)]));
    if (problems.length) {
      for (const x of problems.slice(0, 30)) log(`plan: ${x.id}: ${x.message}`);
      notify('The loop', `Plan is invalid (${problems.length} problems). Run: helix-loop validate`);
      return finish(EXIT.harnessError, `plan invalid: ${problems.length} problems`);
    }
    const index = loadIndex(p.specIndex);
    const template = loadTemplate(p.prompts, 'build');
    const quota = loadQuota(p.agentsState, clock.now());
    const queue = new MergeQueue();
    let runner: E2ERunner | undefined;
    if (config.e2e_runner) {
      runner = new E2ERunner(config.e2e_runner.script, config.e2e_runner.timeout_minutes * 60_000, log, config.e2e_runner.concurrency ?? 2);
      try {
        log(`e2e runner on ${await runner.start(config.e2e_runner.port)}`);
        runnerRef = runner;
      } catch (e) {
        log(`e2e runner could not start (${(e as Error).message}); agents will rely on the gate for browser tests`);
        runner = undefined;
      }
    }
    const running: Running[] = [];
    let passes = 0;
    let lastMode: LoopMode | null = null;
    let stopping = false;
    let paused = false; // runs/PAUSE, as last seen
    const abort = new AbortController();
    deps.signal?.addEventListener('abort', () => {
      stopping = true;
      abort.abort();
    });

    // Crash recovery: a claim with no pass behind it goes back to ready; stale worktrees go.
    for (const t of plan.tasks.values()) {
      if (t.status === 'claimed') {
        t.status = 'ready';
        t.claimed_by = null;
        writeTask(p.tasks, t);
      }
    }
    rmSync(p.worktrees, { recursive: true, force: true });
    for (const repo of Object.keys(config.repos)) {
      if (existsSync(join(p.repos, repo, '.git'))) await gitOk(join(p.repos, repo), 'worktree', 'prune');
    }
    record(p.ledger, { kind: 'loop', at: iso(clock.now()), event: 'start', slots: Object.fromEntries(AGENTS.map((a) => [a, config.agents[a].enabled ? config.agents[a].slots : 0])) });

    const enabled = AGENTS.filter((a) => config.agents[a].enabled);
    const ctx: PassContext = {
      deps,
      plan,
      index,
      template,
      sources: sourceStamp(p),
      quota,
      queue,
      abort: abort.signal,
      runner,
      diverged: new Map(),
      editedInPass: new Set(),
      live,
      signIns: new Map(),
      stop: (why: string) => {
        if (!stopping) log(`stopping: ${why}`);
        stopping = true;
      },
      refreshMap: () => {},
      gates: new Semaphore(config.limits.concurrent_gates ?? 2),
      failures: recentFailures(readLedger(p.ledger), clock.now()),
      passEnded: () => {},
      stops: new Map(),
    };
    stopWatching = watchStopRequests(ctx);
    // The last commit to the harness or the prompts: plan commits move HEAD all day, but don't change the loop.
    ctx.harness = (await git(config.root, 'log', '-1', '--format=%h', '--', 'harness', 'prompts').catch(() => '')) || undefined;
    // The metrics page is kept as a history (runs/metrics/): a new version every N passes, and one now if there
    // is none yet. A version that fails to write is reported and never stops the loop.
    const every = config.metrics_every_passes ?? VERSION_EVERY;
    let passCount = readLedger(p.ledger).filter((e) => e.kind === 'pass').length;
    const writeMetrics = () => {
      try {
        const v = writeVersion(p.metrics, buildMetrics({ events: readLedger(p.ledger), plan: ctx.plan, now: clock.now(), history: taskHistory(config.root), targets: weeklyTargets(config), timeZone: projectInfo(config).timezone, product: projectInfo(config).name }), every);
        log(`metrics: wrote ${v.file}, after ${v.passes} passes`);
      } catch (e) {
        log(`metrics: ${(e as Error).message}`);
      }
    };
    ctx.passEnded = () => {
      passCount++;
      if (passCount % every === 0) writeMetrics();
    };
    if (passCount > 0 && !readVersions(p.metrics).length) writeMetrics();
    for (const repo of Object.keys(config.repos)) {
      if (existsSync(join(p.repos, repo)) && (await ensureUnionMerge(join(p.repos, repo), config.union_merge_paths ?? []))) log(`${repo}: union merge set for ${(config.union_merge_paths ?? []).join(', ')}`);
    }
    if (config.push) await syncAtStart(ctx);

    // Rewrites the dependency map. Atomic (temp file, then rename), because the owner keeps it open in their
    // editor. `finished`: a task whose pass is ending, shown as no longer held.
    const refreshMap = (finished?: string) => {
      try {
        const model = mapModel(ctx, running.filter((r) => r.task.id !== finished), lastMode ?? 'idle');
        atomicWrite(p.map, deps.renderMap(model));
        return model;
      } catch (e) {
        log(`map: ${(e as Error).message}`);
        return undefined;
      }
    };
    ctx.refreshMap = refreshMap;
    const paced: Partial<Record<AgentName, number>> = {}; // the slots each agent's pace allowed, as last logged

    while (true) {
      reloadPlan(ctx);
      await recheckDiverged(ctx, running);
      if (existsSync(p.stopFile)) {
        rmSync(p.stopFile, { force: true });
        log('Stop file found; finishing the passes in flight.');
        stopping = true;
      }
      if (deps.maxPasses !== undefined && passes >= deps.maxPasses) stopping = true;
      // The loop app pauses the loop with runs/PAUSE: the passes in flight run to their end, and none starts.
      if (existsSync(p.pause) !== paused) {
        paused = !paused;
        record(p.ledger, { kind: 'loop', at: iso(clock.now()), event: paused ? 'pause' : 'resume' });
        log(paused ? 'paused (runs/PAUSE): no new passes start until it is removed' : 'resumed: runs/PAUSE was removed');
        live.paused(paused);
      }

      const now = clock.now();
      const available = {} as Record<AgentName, boolean>;
      const pace = {} as Record<AgentName, Pace>;
      for (const a of AGENTS) {
        const q = quota[a];
        rollDay(q, now);
        pace[a] = paceSlots(q.usage, config.agents[a].slots, now, config.agents[a].weekly_target);
        if (!enabled.includes(a)) {
          available[a] = false;
          continue;
        }
        if (q.limited && q.resetAt !== null && now >= q.resetAt) await probe(ctx, a);
        // Helix, in the loop app, draws on the same subscription, so its spend counts toward the budget.
        const budget = config.limits.daily_budget_usd[a] - (helixSpentUsd([p.steward, p.helixTurns], q.day)[a] ?? 0);
        available[a] = !q.limited && !overBudget(q, budget, now) && pace[a].slots > 0 && (await onSubscription(ctx, a));
        if (paced[a] !== pace[a].slots && (paced[a] !== undefined || pace[a].slots < config.agents[a].slots)) notePace(ctx, a, pace[a], now);
        paced[a] = pace[a].slots;
      }

      // Fill free slots, best-ranked task first.
      if (!stopping && !paused) {
        const model = mapModel(ctx, running, lastMode ?? 'idle');
        const rank = rankTasks(model, plan).filter((id) => !ctx.diverged.has(plan.tasks.get(id)!.repo));
        for (const a of enabled) {
          while (available[a] && running.filter((r) => r.agent === a).length < pace[a].slots) {
            if (deps.maxPasses !== undefined && passes >= deps.maxPasses) break;
            const heldAreas = new Set(running.map((r) => r.task.area));
            const task = pick({ plan, rank, agent: a, heldAreas, maxAttempts: config.limits.max_attempts });
            if (!task) break;
            passes++;
            const entry: Running = { task, agent: a, promise: Promise.resolve() };
            entry.promise = runPass(ctx, task, a)
              .catch((e) => {
                log(`harness error in ${task.id}: ${(e as Error).stack ?? e}`);
                const why = `harness error: ${(e as Error).message}`;
                if (task.status === 'claimed') release(ctx, task, a, 'agent_error', why, '', firstLine(why));
              })
              // Every pass ends with the map rewritten, whatever its outcome.
              .finally(() => {
                running.splice(running.indexOf(entry), 1);
                refreshMap();
              });
            running.push(entry);
          }
        }
      }

      const anyWork = [...plan.tasks.values()].some((t) => t.status !== 'done');
      const mode = loopMode(available, anyWork);
      if (mode !== lastMode) {
        const detail = [
          ...AGENTS.filter((a) => quota[a].limited).map((a) => `${a} resets ${quota[a].resetAt ? iso(quota[a].resetAt!) : 'unknown'}`),
          ...enabled.filter((a) => !quota[a].limited && pace[a].until !== undefined).map((a) => `${a} paced until ${iso(pace[a].until!)}`),
        ].join('; ');
        record(p.ledger, { kind: 'mode', at: iso(now), mode, detail: detail || undefined });
        log(`mode: ${mode}${detail ? ` (${detail})` : ''}`);
        if (mode === 'paused') notify('The loop paused', `Neither agent can take work: ${detail}`);
        if (lastMode === 'paused') notify('The loop resumed', `Running ${mode}.`);
        lastMode = mode;
        refreshMap();
      }

      if (running.length === 0) {
        if (stopping) {
          refreshMap();
          return finish(EXIT.stopped, 'stop requested');
        }
        if (paused) {
          // Paused with nothing in flight: no exit and no polling of the plan, only of the control files.
          log('paused with no pass in flight; waiting for runs/PAUSE to be removed');
          await waitForControl(p, paused, abort.signal);
          continue;
        }
        if (existsSync(join(p.runs, 'PLANNING')) && !stopping) {
          // Planning is still adding tasks: wait for them instead of exiting.
          log('no work to pick while planning continues (runs/PLANNING); checking again in a minute');
          await clock.sleep(60_000, abort.signal);
          continue;
        }
        if (!anyWork) {
          refreshMap();
          notify('The loop', 'Every task is done.');
          return finish(EXIT.allDone);
        }
        const unavailable = enabled.filter((a) => !available[a]);
        if (unavailable.length) {
          // Paused, or the only pickable work is waiting for the agent that is out (a third attempt
          // goes to the other agent). No passes, no polling: sleep until the earliest reset, or
          // midnight for a spent budget.
          const wake = nextWake(ctx, unavailable, pace);
          const idle = enabled.filter((a) => available[a]);
          log(`waiting until ${iso(wake)} for ${unavailable.join(' and ')}${idle.length ? `; ${idle.join(' and ')} has nothing it can take` : ''}`);
          // An agent left with nothing to take while the other is out is worth a look: the build may be
          // waiting on one task only the other agent may try.
          if (idle.length && wake - clock.now() > 30 * 60_000) {
            notify('The loop is idle', `${idle.join(' and ')} has nothing it can take until ${unavailable.join(' and ')} is back at ${new Date(wake).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}.`);
          }
          // A stop file ends the wait too, so a restart doesn't wait for the reset.
          const woke = new AbortController();
          const signal = AbortSignal.any([abort.signal, woke.signal]);
          await Promise.race([clock.sleep(wake - clock.now(), signal), waitForControl(p, paused, signal)]);
          woke.abort();
          continue;
        }
        // Every agent is free but nothing can be picked: the rest waits on a person.
        refreshMap();
        const diverged = [...ctx.diverged.keys()];
        const why = diverged.length
          ? `main has diverged from origin/main in ${diverged.join(', ')}; reconcile it, then run the loop again`
          : onlyHumanWorkLeft(plan) ? 'only work that needs a person is left' : 'no task is ready: each waits on other work';
        notify('The loop needs you', why);
        return finish(EXIT.onlyHumanWork, why);
      }

      // Wait for a pass to finish, a limited agent's reset time, a stop file, or a pause that starts or ends,
      // whichever is first.
      // The waits that lose the race are cancelled, so none outlive this iteration.
      const done = new AbortController();
      const waitSignal = AbortSignal.any([abort.signal, done.signal]);
      // An agent back from its session limit or its pace can take a slot before any pass ends.
      const resumes = enabled.flatMap((a) => (quota[a].limited ? (quota[a].resetAt ? [quota[a].resetAt!] : []) : pace[a].until !== undefined ? [pace[a].until!] : []));
      const waits: Promise<unknown>[] = running.map((r) => r.promise);
      // After a stop signal only the passes in flight are worth waiting for: the other waits end at once on an
      // aborted signal, and racing them would spin without ever yielding to the passes' exit events.
      if (!abort.signal.aborted) {
        if (resumes.length && !stopping) waits.push(clock.sleep(Math.min(...resumes) - clock.now(), waitSignal));
        waits.push(waitForControl(p, paused, waitSignal));
      }
      await Promise.race(waits);
      done.abort();
    }
  } catch (e) {
    log(`harness error: ${(e as Error).stack ?? e}`);
    notify('The loop stopped', `Harness error: ${(e as Error).message}`);
    return finish(EXIT.harnessError, (e as Error).message);
  }
}

interface PassContext {
  deps: LoopDeps;
  plan: Plan;
  index: ReturnType<typeof loadIndex>;
  template: string;
  sources: string; // mtimes of the spec index and the build prompt, to reload them when they change
  quota: QuotaState;
  queue: MergeQueue;
  abort: AbortSignal;
  runner: E2ERunner | undefined;
  diverged: Map<string, string>; // repo → how its main and origin/main differ; it takes no tasks meanwhile
  editedInPass: Set<string>; // tasks changed on disk during their pass, already reported
  live: LiveBoard; // runs/live.json, for the loop app
  signIns: Map<AgentName, SignIn & { checkedAt: number }>; // each agent's last sign-in check (onSubscription)
  stop: (why: string) => void;
  refreshMap: (finished?: string) => void;
  gates: Semaphore; // the gates (and re-gates) running at once
  failures: Map<string, FailureSeen[]>; // failing test → the passes it failed in the last day (flaky.ts)
  passEnded: () => void; // counts the pass, and writes a new version of the metrics page every N passes
  harness?: string; // the control plane's commit, recorded with every pass
  stops: Map<string, PassStop>; // task → its pass in flight, for the loop app's stop requests
}

type PassEvent = Extract<LedgerEvent, { kind: 'pass' }>;

function sourceStamp(p: Paths): string {
  const m = (f: string) => (existsSync(f) ? statSync(f).mtimeMs : 0);
  return `${m(p.specIndex)}:${m(join(p.prompts, 'build.md'))}`;
}

function mapModel(ctx: PassContext, running: Running[], mode: LoopMode): MapModel {
  const { config, clock, paths: p } = ctx.deps;
  const agents = mapAgents(config, ctx.quota, running.map((r) => ({ agent: r.agent, task: r.task.id })), clock.now());
  return { ...computeMap(ctx.plan, { now: clock.now(), passHours: meanPassHours(readLedger(p.ledger)), agents, mode }), lanes: Object.keys(config.repos), product: projectInfo(config).name, owner: projectInfo(config).owner };
}

// The earliest time one of these unavailable agents can work again.
function nextWake(ctx: PassContext, unavailable: AgentName[], pace: Record<AgentName, Pace>): number {
  const { clock, config } = ctx.deps;
  const now = clock.now();
  const times = unavailable.map((a) => {
    const q = ctx.quota[a];
    if (q.limited) return q.resetAt ?? now + config.limits.unknown_reset_backoff_minutes.first * 60_000;
    // Not on its subscription: look again when the sign-in check is next due.
    if (ctx.signIns.get(a)?.subscription === false) return now + SIGN_IN_RECHECK_MS;
    if (pace[a].until !== undefined && !overBudget(q, config.limits.daily_budget_usd[a], now)) return pace[a].until!;
    const midnight = new Date(now);
    midnight.setHours(24, 0, 5, 0);
    return midnight.getTime();
  });
  return Math.max(now + 1000, Math.min(...times));
}

// Each change in how many passes an agent's pace allows goes to the log and the ledger.
function notePace(ctx: PassContext, agent: AgentName, pace: Pace, now: number): void {
  const { config, paths: p, log } = ctx.deps;
  const usage = ctx.quota[agent].usage;
  log(`⏱ ${agent}: ${describePace(usage, pace, config.agents[agent].weekly_target, now) ?? `${pace.slots} passes at a time`}`);
  const w = usage?.weekly;
  record(p.ledger, {
    kind: 'pace',
    at: iso(now),
    agent,
    slots: pace.slots,
    used: w?.used,
    allowed: pace.allowed,
    resetsAt: w ? iso(w.resetsAt) : undefined,
    until: pace.until !== undefined ? iso(pace.until) : undefined,
  });
}

// A repo whose main has diverged from origin/main takes no merges, releases or new tasks: their passes
// would only be refused at the merge. the owner hears about it once.
function holdDiverged(ctx: PassContext, repo: string, detail: string): void {
  if (!ctx.diverged.has(repo)) ctx.deps.notify(`${repo} has diverged from origin`, 'Its merges, releases and tasks wait until main and origin/main agree. Details in runs/runs.jsonl.');
  ctx.diverged.set(repo, detail);
}

// At start, each cloned repo with an origin is fetched: one whose main has diverged is held from the first
// pick, and the others get any release tag whose push failed pushed again.
async function syncAtStart(ctx: PassContext): Promise<void> {
  const { config, paths: p, clock, log } = ctx.deps;
  for (const repo of Object.keys(config.repos)) {
    const dir = join(p.repos, repo);
    if (!existsSync(join(dir, '.git'))) continue;
    const origin = await compareWithOrigin(dir).catch(() => undefined);
    if (origin?.relation === 'diverged') {
      record(p.ledger, { kind: 'warning', at: iso(clock.now()), detail: `${repo}: ${origin.detail}; it takes no merges, releases or tasks until they agree` });
      holdDiverged(ctx, repo, origin.detail!);
      continue;
    }
    const retried = await retryTagPushes({ repo, dir, ledger: p.ledger }, clock.now()).catch(() => undefined);
    if (retried) log(`🏷 ${repo}: pushed ${retried.tags.join(', ')} again${retried.pushed ? '' : ' — the push failed again'}`);
  }
}

// Before each round of picks, each held repo with no pass in flight is fetched again, and once main and
// origin/main agree its tasks run again. A fetch that fails keeps the hold.
async function recheckDiverged(ctx: PassContext, running: Running[]): Promise<void> {
  const { paths: p, log } = ctx.deps;
  for (const repo of [...ctx.diverged.keys()]) {
    if (running.some((r) => r.task.repo === repo)) continue; // that pass's merge checks again
    const origin = await ctx.queue.enqueue(repo, () => compareWithOrigin(join(p.repos, repo))).catch(() => undefined);
    if (!origin || origin.relation === 'diverged' || origin.relation === 'unknown') continue;
    ctx.diverged.delete(repo);
    log(`${repo}: main and origin/main agree again; its tasks run again`);
  }
}

// At the reset time, one cheap request before any task (design doc §7.4).
async function probe(ctx: PassContext, agent: AgentName): Promise<void> {
  const { deps, quota } = ctx;
  const { clock, config, paths: p } = deps;
  const adapter = deps.adapters[agent];
  const dir = join(p.runs, 'probe');
  mkdirSync(dir, { recursive: true });
  const inv = adapter.probe(dir);
  const res = await run(inv.cmd, inv.args, { cwd: dir, stdin: inv.stdin, env: agentEnv(clock, inv.env), timeoutMs: 120_000 });
  const r = await adapter.interpret(res.stdout, res.stderr, res.code, clock.now());
  const q = quota[agent];
  if (r.kind === 'limited' || r.kind === 'transient') {
    markLimited(q, r.resetAt, clock.now(), config.limits.unknown_reset_backoff_minutes);
    record(p.ledger, { kind: 'agent', at: iso(clock.now()), agent, state: 'limited', resetAt: q.resetAt ? iso(q.resetAt) : undefined, detail: `probe: ${r.detail ?? r.kind}` });
  } else {
    markAvailable(q);
    record(p.ledger, { kind: 'agent', at: iso(clock.now()), agent, state: 'available' });
  }
  q.spentUsd += r.costUsd;
  if (r.usage) q.usage = r.usage;
  saveQuota(p.agentsState, quota);
}

// Builders run only on the CLI's subscription sign-in, never an API key (DECISIONS.md, 2026-10-25). The CLI
// is asked how it is signed in when the loop starts and then every ten minutes of real time; an agent signed in
// any other way takes no task, and the owner hears about it once per change. A check that cannot tell counts as
// not on a subscription: a stalled agent is visible, a runaway bill is not.
const SIGN_IN_RECHECK_MS = 10 * 60_000;

async function onSubscription(ctx: PassContext, agent: AgentName): Promise<boolean> {
  const { config, paths: p, clock, log, notify, adapters } = ctx.deps;
  const last = ctx.signIns.get(agent);
  if (last && Date.now() - last.checkedAt < SIGN_IN_RECHECK_MS) return last.subscription;
  const env = agentEnv(clock, adapters[agent].probe(p.runs).env);
  const s = await signIn(agent, config.agents[agent].command, env);
  ctx.signIns.set(agent, { ...s, checkedAt: Date.now() });
  if (s.subscription !== (last?.subscription ?? true)) {
    const detail = s.subscription
      ? `${agent} is signed in with its subscription again; it takes tasks again`
      : `${agent} is not signed in with its subscription (${s.method}${s.detail ? `: ${s.detail}` : ''}); it takes no tasks until it is, since builders never run on an API key`;
    record(p.ledger, { kind: 'warning', at: iso(clock.now()), detail });
    log(detail);
    if (!s.subscription) notify('The loop needs you', `Sign ${agent} in with its subscription: it is ${s.method}.`);
  }
  return s.subscription;
}

// While the loop app answers on its port, a pass's builder gets the app's MCP endpoint and a token for this
// pass alone; otherwise no MCP server at all, so an app that is down can never fail a pass.
async function passMcp(ctx: PassContext, token: string): Promise<PassMcp | undefined> {
  const port = ctx.deps.config.app?.port;
  if (!port) return undefined;
  const url = `http://127.0.0.1:${port}`;
  try {
    const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(1000) });
    if (!res.ok) return undefined;
  } catch {
    return undefined;
  }
  return { url: `${url}/mcp/builder`, token };
}

// The issues a pass's builder reported over MCP (app/mcp.ts writes runs/reports.jsonl), for its attempt's note.
function reportedIssues(file: string, passId: string): string[] {
  if (!existsSync(file)) return [];
  const out: string[] = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.includes(passId)) continue;
    try {
      const r = JSON.parse(line) as { pass?: string; kind?: string; issue?: string; message?: string };
      if (r.pass === passId && r.kind === 'issue') out.push(`- ${r.issue}: ${r.message}`);
    } catch {
      // a line mid-append
    }
  }
  return out;
}

// Every builder process (passes and probes) starts from the loop's environment cleaned of what a parent
// session would leak (builderEnv), so starting the loop from a Claude Code session is safe.
function agentEnv(clock: Clock, extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  // HELIX_LOOP_NOW lets the dry run's fake CLIs share the loop's (virtual) clock.
  return { ...builderEnv(process.env), ...extra, HELIX_LOOP_NOW: String(clock.now()) };
}

// Ends a pass's claim: records the attempt, moves the task on, and sets its summary for the map. An
// interruption (session limit, suspension, transient error) changes nothing, so it keeps the summary.
function release(ctx: PassContext, task: Task, agent: AgentName, outcome: AttemptOutcome, note: string, log: string, summary?: string, kept?: string): void {
  const { config, paths: p, clock } = ctx.deps;
  task.attempts.push({ agent, outcome, at: iso(clock.now()), log, note: note ? clipNote(note) : undefined, ...(kept ? { kept } : {}) });
  task.claimed_by = null;
  if (outcome === 'merged') task.status = 'done';
  else if (countedAttempts(task) >= config.limits.max_attempts || conflictCount(task) >= config.limits.max_conflicts) task.status = 'needs_human';
  else task.status = 'ready';
  if (summary && !UNCOUNTED_OUTCOMES.includes(outcome)) {
    const spent = conflictCount(task) >= config.limits.max_conflicts ? `${conflictCount(task)} conflicts` : `${countedAttempts(task)} attempts`;
    task.summary = clipSummary(task.status === 'needs_human' ? `blocked after ${spent}: ${summary}` : summary);
  }
  writeTask(p.tasks, task);
  if (task.status === 'needs_human') ctx.deps.notify('A task needs you', `${task.id}: ${task.title}`);
}

// What a pass did, in a few words: the merged commit's subject without its task id, or what failed.
const FAILED_AS: Partial<Record<AttemptOutcome, string>> = {
  gate_failed: 'gate failed', conflict: 'conflict', forbidden_paths: 'refused', no_commit: 'no change', timeout: 'timed out', agent_error: 'agent error',
};
function passSummary(outcome: AttemptOutcome, what: string): string | undefined {
  if (outcome === 'merged') return firstLine(what).replace(/^T-\d+:\s*/, '') || undefined;
  const label = FAILED_AS[outcome];
  return label && `${label}: ${firstLine(what)}`;
}

// Why kept work did not merge, read from the attempt that kept it (prompt.ts tells the next attempt).
function carryReason(a: Attempt): CarryReason {
  const note = a.note ?? '';
  if (a.outcome === 'conflict' || /^after rebasing onto the new main/.test(note) || /have diverged/.test(note)) return 'moved';
  if (a.outcome === 'no_commit' && /^BLOCKED:/i.test(note)) return 'blocked';
  if (['timeout', 'agent_error', ...UNCOUNTED_OUTCOMES].includes(a.outcome)) return 'cut';
  return 'failed';
}

// An attempt's change against the main it started from.
async function diffStat(worktree: string, base: string): Promise<{ files: number; added: number; deleted: number }> {
  const s = await git(worktree, 'diff', '--shortstat', `${base}...HEAD`).catch(() => '');
  const n = (re: RegExp) => Number(re.exec(s)?.[1] ?? 0);
  return { files: n(/(\d+) files? changed/), added: n(/(\d+) insertions?/), deleted: n(/(\d+) deletions?/) };
}

// Whether an attempt that did not merge leaves work for the next one, which starts from it (carryInto). The
// gate commits a finished pass's tree; work stopped before the gate is committed here, as it stands.
async function keepsWork(worktree: string, task: Task, base: string, agentLabel: string, summary: string): Promise<boolean> {
  try {
    await commitLeftovers(worktree, task, summary, agentLabel);
    return (await commitsAhead(worktree, base)) > 0;
  } catch {
    return false;
  }
}

// The loop app stops one pass by writing runs/stop-pass/<task>.json. Each request is taken within a second and
// its file deleted: a pass in its setup, agent or gate is ended as a timeout ends it, its work kept for the next
// attempt; a pass already merging finishes; a request for a task with no pass in flight is dropped.
export interface StopRequest {
  at?: string; // when the app asked
  to: 'ready' | 'needs_human'; // where the task goes; ready by default
  note?: string; // appended to the task's notes, for the next builder
  why?: string; // goes into the attempt's note
}

interface PassStop {
  controller: AbortController; // kills the pass's agent, or its gate
  closed?: 'merging' | 'ending'; // past the last point a stop can take effect: requests are dropped from here
  request?: StopRequest;
}

class PassStopped extends Error {}

const STOP_POLL_MS = 1000;
const UNREADABLE_AFTER_MS = 5000; // a request still unreadable this long after its last write is not mid-write

function watchStopRequests(ctx: PassContext): () => void {
  const timer = setInterval(() => takeStopRequests(ctx), STOP_POLL_MS);
  timer.unref();
  return () => clearInterval(timer);
}

function takeStopRequests(ctx: PassContext): void {
  const { paths: p, log } = ctx.deps;
  let files: string[];
  try {
    files = readdirSync(p.stopPass).filter((f) => f.endsWith('.json'));
  } catch {
    return; // no request yet
  }
  for (const f of files) {
    const file = join(p.stopPass, f);
    const task = f.slice(0, -'.json'.length);
    let request: StopRequest | string;
    try {
      request = parseStopRequest(readFileSync(file, 'utf8'));
      if (typeof request === 'string' && Date.now() - statSync(file).mtimeMs < UNREADABLE_AFTER_MS) continue; // maybe mid-write
    } catch {
      continue; // gone since the listing
    }
    rmSync(file, { force: true });
    const pass = ctx.stops.get(task);
    if (typeof request === 'string') log(`${task}: stop request ignored: ${request}`);
    else if (!pass) log(`${task}: stop request ignored: no pass of it is running`);
    else if (pass.closed) log(`${task}: stop request ignored: its pass is already ${pass.closed}`);
    else if (pass.request) log(`${task}: stop request ignored: its pass is already stopping`);
    else {
      pass.request = request;
      pass.controller.abort();
      ctx.live.stopping(task);
      log(`${task}: stopping its pass, as the loop app asked${request.why ? ` (${request.why})` : ''}; it goes to ${request.to}`);
    }
  }
}

// A request as the app wrote it, or why it can't be taken.
function parseStopRequest(text: string): StopRequest | string {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return 'it is not JSON';
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 'it is not a JSON object';
  const r = raw as Record<string, unknown>;
  const to = r.to ?? 'ready';
  if (to !== 'ready' && to !== 'needs_human') return `"to" is ${JSON.stringify(to)}, not "ready" or "needs_human"`;
  for (const k of ['at', 'note', 'why'] as const) if (r[k] !== undefined && typeof r[k] !== 'string') return `"${k}" is not a string`;
  const str = (k: 'at' | 'note' | 'why') => (r[k] as string | undefined)?.trim() || undefined;
  return { at: str('at'), to, note: str('note'), why: str('why') };
}

async function runPass(ctx: PassContext, task: Task, agent: AgentName): Promise<void> {
  const { deps, quota } = ctx;
  const { config, paths: p, clock, log } = deps;
  const adapter = deps.adapters[agent];
  const role = task.role ?? 'build';
  const model = config.agents[agent].models[role].model;
  const label = `${agent} (${model})`;
  const attempt = task.attempts.length + 1;
  const repoDir = join(p.repos, task.repo);
  const worktree = join(p.worktrees, task.repo, `${task.id}-${agent}`);
  const branch = branchFor(task.id, agent, attempt);
  const day = iso(clock.now()).slice(0, 10);
  mkdirSync(join(p.logs, day), { recursive: true });
  const logRel = join('runs', 'logs', day, `${task.id}-${agent}-${attempt}.log`);
  const logFile = join(p.runs, '..', logRel);
  const startedAt = iso(clock.now());
  const startedMono = clock.monotonic();
  const since = (t: number) => Math.round(clock.monotonic() - t);

  task.status = 'claimed';
  task.claimed_by = agent;
  writeTask(p.tasks, task);
  log(`▶ ${task.id} → ${agent} (attempt ${attempt}): ${task.title}`);
  const livePass = `${task.id}:${agent}:${attempt}`;
  const mcpToken = newToken();
  ctx.live.start({ id: livePass, task: task.id, repo: task.repo, agent, attempt, startedAt, tokenHash: hashToken(mcpToken) });
  const stop: PassStop = { controller: new AbortController() };
  ctx.stops.set(task.id, stop);
  // Where a stop from the loop app takes effect: the agent and the gate are killed by its signal, and these
  // checks end the pass between its steps.
  const checkStop = () => {
    if (stop.request) throw new PassStopped();
  };

  let outcome: AttemptOutcome = 'agent_error';
  let keepBranch = false; // the work did not merge: the next attempt starts from it
  let carried: CarriedWork | undefined;
  let blocked = false; // the agent answered BLOCKED: the task goes to a person
  let note = ''; // for the next attempt's prompt and the ledger
  let failing: string | undefined; // what the gate says failed, in a few words, for the map
  let subject = ''; // the merged commit's subject
  let result: AgentResult | undefined;
  let commit: string | undefined;
  let passId: string | undefined;
  let base: string | undefined;
  // The pass's metrics (ledger.ts): where its time went, what failed, and what it started from.
  const phases: PassPhases = { setupMs: 0, agentMs: 0, gateMs: 0 };
  const activity: Activity = { toolCalls: 0, commands: [] };
  let gateSteps: GateStep[] | undefined;
  let failedStep: string | undefined;
  let carry: PassEvent['carried'];
  let diff: PassEvent['diff'];
  let promptBytes: number | undefined;
  let retryBytes: number | undefined;
  let mainMoved: number | undefined;
  let e2e: E2EUse | undefined;
  const controlBefore = await controlPlaneChanges(config.root);
  try {
    if (!existsSync(join(repoDir, '.git'))) throw new Error(`repository ${task.repo} is not cloned at ${repoDir}`);
    base = await head(repoDir, 'main');
    await addWorktree(repoDir, worktree, branch);
    // The latest work an earlier attempt kept goes in first, so the prepare step installs what it needs.
    const keptBy = task.attempts.findLast((a) => a.kept);
    if (keptBy?.kept) {
      const c = await carryInto(worktree, keptBy.kept, { relock: config.relock, jsonMerge: config.json_merge });
      if (c.ok) {
        const why = carryReason(keptBy);
        carried = { branch: keptBy.kept, why, conflicts: c.messages };
        carry = { from: keptBy.kept, why, conflicts: c.conflicts.length, resolved: c.resolved.length };
        const conflicts = c.conflicts.length ? `, with conflicts in ${c.conflicts.join(', ')}` : '';
        log(`${task.id}: starts from the work kept on ${keptBy.kept}${conflicts}${c.resolved.length ? `; ${c.resolved.join(', ')} resolved mechanically` : ''}`);
      } else log(`${task.id}: starts from main; the work kept on ${keptBy.kept} was not carried: ${c.why}`);
    }
    const prepare = repoConfig(config, task.repo).prepare;
    if (prepare) {
      const pr = await sh(prepare, { cwd: worktree, timeoutMs: 15 * 60_000, logFile, signal: stop.controller.signal });
      checkStop();
      if (pr.code !== 0) log(`${task.id}: prepare step failed (exit ${pr.code}); the agent will see the same state`);
    }
    passId = ctx.runner?.register(worktree);

    let prompt: string;
    try {
      // The last failure that counted against the task. Interruptions (a session limit, a suspension, a
      // transient error, an origin that diverged) say nothing about the code, and their notes are for the owner.
      const last = task.attempts.filter((a) => a.outcome !== 'merged' && !UNCOUNTED_OUTCOMES.includes(a.outcome)).pop();
      const input = { template: ctx.template, task, index: ctx.index, sectionsDir: p.specSections, budgetBytes: config.limits.prompt_budget_bytes, product: projectInfo(config).name };
      prompt = renderPrompt({ ...input, retryLog: last?.note, carried });
      promptBytes = Buffer.byteLength(prompt);
      retryBytes = promptBytes - Buffer.byteLength(renderPrompt(input));
    } catch (e) {
      if (!(e instanceof PromptOverBudget)) throw e;
      task.attempts.push({ agent, outcome: 'agent_error', at: iso(clock.now()), log: '', note: e.message });
      task.status = 'needs_human';
      task.summary = clipSummary(`blocked: ${firstLine(e.message)}`);
      task.claimed_by = null;
      writeTask(p.tasks, task);
      deps.notify('A task needs you', e.message);
      return;
    }

    const inv = adapter.invocation(role, worktree, prompt, await passMcp(ctx, mcpToken));
    const slept = suspensionWatch(clock, config.limits.suspension_threshold_seconds * 1000);
    const e2eEnv = ctx.runner && passId
      ? productEnv(config, { E2E_CLIENT: asset('clients', 'e2e-client.mjs'), E2E_RUNNER: ctx.runner.url, E2E_PASS: passId })
      : {};
    phases.setupMs = since(startedMono);
    checkStop();
    ctx.live.phase(task.id, 'agent');
    const agentStarted = clock.monotonic();
    const res = await run(inv.cmd, inv.args, {
      cwd: worktree,
      stdin: inv.stdin,
      env: agentEnv(clock, { ...inv.env, ...e2eEnv }),
      timeoutMs: config.limits.pass_timeout_minutes * 60_000,
      logFile,
      signal: AbortSignal.any([ctx.abort, stop.controller.signal]),
      nice: BUILDER_NICE,
      onLine: (line) => {
        const a = adapter.observe(line);
        activity.toolCalls += a.toolCalls;
        activity.commands.push(...a.commands);
        if (a.toolCalls) ctx.live.activity(task.id, a.toolCalls, a.commands.at(-1));
      },
    });
    phases.agentMs = since(agentStarted);
    result = await adapter.interpret(res.stdout, res.stderr, res.code, clock.now());
    const q = quota[agent];
    q.spentUsd += result.costUsd;
    q.passes++;
    if (result.usage) q.usage = result.usage;
    saveQuota(p.agentsState, quota);
    checkStop();

    if (ctx.abort.aborted) {
      outcome = 'transient';
      note = 'the loop was stopped mid-pass';
    } else if (result.kind === 'limited') {
      markLimited(q, result.resetAt, clock.now(), config.limits.unknown_reset_backoff_minutes);
      saveQuota(p.agentsState, quota);
      record(p.ledger, { kind: 'agent', at: iso(clock.now()), agent, state: 'limited', resetAt: q.resetAt ? iso(q.resetAt) : undefined, detail: result.detail });
      outcome = 'quota';
      note = `session limit: ${result.detail ?? ''}`;
    } else if (result.kind === 'suspended' || slept()) {
      outcome = 'suspended';
      note = 'the host was suspended during the pass';
      record(p.ledger, { kind: 'suspension', at: iso(clock.now()), task: task.id, detail: note });
    } else if (result.kind === 'transient') {
      markLimited(q, null, clock.now(), config.limits.unknown_reset_backoff_minutes);
      saveQuota(p.agentsState, quota);
      outcome = 'transient';
      note = result.detail ?? 'transient API error';
    } else if (res.timedOut) {
      outcome = 'timeout';
      note = `the pass ran past ${config.limits.pass_timeout_minutes} minutes`;
    } else if (result.kind === 'error') {
      outcome = 'agent_error';
      note = result.detail ?? 'agent error';
    } else if (/^BLOCKED:/i.test(result.summary)) {
      // The task cannot be done as written: it goes straight to a person, below, once the pass is recorded.
      outcome = 'no_commit';
      note = result.summary;
      blocked = true;
    } else {
      const gateInput = {
        worktree,
        task,
        agentLabel: label,
        summary: result.summary,
        envPrefix: config.env_prefix,
        gateCommand: repoConfig(config, task.repo).gate,
        prepare: repoConfig(config, task.repo).prepare,
        gateTimeoutMs: config.limits.gate_timeout_minutes * 60_000,
        forbidden: config.forbidden_paths,
        allowed: config.forbidden_exceptions ?? [],
        restricted: config.restricted_paths ?? {},
        agentsMdBudget: config.limits.agents_md_budget_bytes,
        suspensionMs: config.limits.suspension_threshold_seconds * 1000,
        clock,
        logFile,
        signal: stop.controller.signal,
      };
      const asked = clock.monotonic();
      const g = await ctx.gates.run(() => {
        phases.gateWaitMs = since(asked);
        checkStop(); // asked while it waited for a gate
        ctx.live.phase(task.id, 'gate');
        return runGate(gateInput);
      });
      phases.gateMs = g.gateMs;
      gateSteps = g.steps;
      diff = await diffStat(worktree, base);
      checkStop();
      if (!g.ok) {
        outcome = g.outcome;
        note = g.detail;
        failing = g.failing;
        failedStep = g.failedStep;
      } else {
        const queued = clock.monotonic();
        let merging = queued;
        stop.closed = 'merging'; // the work passed its gate
        ctx.live.phase(task.id, 'merge');
        const m = await ctx.queue.enqueue(task.repo, () => {
          merging = clock.monotonic();
          return mergeTask({
            repo: repoDir,
            worktree,
            branch,
            gatedOn: base!,
            push: config.push,
            relock: config.relock,
            jsonMerge: config.json_merge,
            regate: async () => {
              const again = await ctx.gates.run(() => runGate({ ...gateInput, summary: '', signal: undefined }));
              return again.ok
                ? { ok: true, detail: '', gateMs: again.gateMs }
                : { ok: false, detail: again.detail, failing: again.failing, failedStep: again.failedStep, gateMs: again.gateMs };
            },
          });
        });
        phases.queueMs = Math.round(merging - queued);
        phases.mergeMs = since(merging);
        phases.regateMs = m.regateMs;
        mainMoved = m.mainMoved;
        if (m.ok) {
          outcome = 'merged';
          commit = m.commit;
          note = m.pushNote ?? '';
          subject = await git(repoDir, 'log', '-1', '--format=%s', m.commit).catch(() => '');
          if (m.fromOrigin) log(`${task.repo}: main caught up with origin/main (${m.fromOrigin.slice(0, 12)}) before ${task.id} merged`);
          if (m.resolved.length) log(`${task.id}: the rebase conflicted only in ${m.resolved.join(', ')}; manifests merged key by key, lockfiles regenerated`);
          // A push that went through proves main and origin/main agree.
          if (m.pushed === true && ctx.diverged.delete(task.repo)) log(`${task.repo}: main and origin/main agree again; its tasks run again`);
          record(p.ledger, { kind: 'merge', at: iso(clock.now()), task: task.id, repo: task.repo, commit: m.commit, agent, regated: m.regated });
          await ctx.queue.enqueue(task.repo, () => checkpointRelease(ctx, task.repo));
        } else if (m.outcome === 'diverged') {
          // Not the task's fault, so the attempt does not count: the task goes back to the queue, its gated
          // work stays on its branch for the next attempt, and the repo takes no new tasks until main and
          // origin/main agree.
          outcome = 'transient';
          failedStep = m.failedStep;
          note = `${m.detail}. Nothing was merged; the gated work is kept on branch ${branch}. Reconcile main with origin/main in repos/${task.repo}.`;
          record(p.ledger, { kind: 'warning', at: iso(clock.now()), task: task.id, detail: `${task.repo}: ${note}` });
          holdDiverged(ctx, task.repo, m.detail);
        } else {
          outcome = m.outcome;
          note = m.detail;
          failing = m.failing;
          failedStep = m.failedStep;
        }
      }
    }
    stop.closed ??= 'ending'; // its outcome is decided; nothing between the last check and here awaits
    // Every attempt that did not merge keeps its work, however it ended, and the next attempt starts from it.
    if (outcome !== 'merged') {
      keepBranch = await keepsWork(worktree, task, base, label, result.summary);
      if (keepBranch) diff ??= await diffStat(worktree, base);
    }
  } catch (e) {
    if (!(e instanceof PassStopped)) throw e;
    // Stopped from the loop app: an interruption, so the attempt is not counted, and its work is kept as a
    // timeout's is.
    outcome = 'stopped';
    note = `stopped from the loop app${stop.request?.why ? `: ${stop.request.why}` : ''}`;
    if (base) {
      keepBranch = await keepsWork(worktree, task, base, label, result?.summary ?? '');
      if (keepBranch) diff ??= await diffStat(worktree, base);
    }
  } finally {
    ctx.stops.delete(task.id);
    ctx.live.end(task.id); // its MCP token stops working here
    if (passId) e2e = ctx.runner?.unregister(passId);
    await checkTampering(ctx, task, repoDir, controlBefore);
    await removeWorktree(repoDir, worktree).catch(() => undefined);
    if (outcome === 'merged') {
      await gitOk(repoDir, 'branch', '-d', branch);
      for (const a of task.attempts) if (a.kept) await gitOk(repoDir, 'branch', '-D', a.kept);
    } else if (!keepBranch) await gitOk(repoDir, 'branch', '-D', branch);
  }
  if (mainMoved === undefined && base) mainMoved = Number(await git(repoDir, 'rev-list', '--count', `${base}..main`).catch(() => '0'));

  const gz = await compress(logFile).catch(() => logFile);
  const logPath = gz === logFile ? logRel : `${logRel}.gz`;
  const kept = keepBranch ? branch : undefined;
  // What the builder reported as in its way goes with the attempt, so the next attempt and the owner see it.
  const issues = reportedIssues(p.reports, livePass);
  if (issues.length) note = [note, `The builder reported:\n${issues.join('\n')}`].filter(Boolean).join('\n\n');
  if (blocked) {
    task.attempts.push({ agent, outcome, at: iso(clock.now()), log: logPath, note: clipNote(note), ...(kept ? { kept } : {}) });
    task.status = 'needs_human';
    task.summary = clipSummary(`blocked: ${firstLine(note.replace(/^BLOCKED:\s*/i, ''))}`);
    task.claimed_by = null;
    task.notes = [task.notes, `${agent}: ${note}`].filter(Boolean).join('\n\n');
    writeTask(p.tasks, task);
    deps.notify('A task needs you', `${task.id} is blocked: ${note.slice(8, 200)}`);
  } else if (outcome === 'stopped' && stop.request && task.status === 'claimed') {
    // The task goes where the request said, and its note goes into the task's notes for the next builder.
    const asked = stop.request;
    task.attempts.push({ agent, outcome, at: iso(clock.now()), log: logPath, note: clipNote(note), ...(kept ? { kept } : {}) });
    task.status = asked.to;
    task.claimed_by = null;
    if (asked.to === 'needs_human') task.summary = clipSummary(note);
    if (asked.note) task.notes = [task.notes, asked.note].filter(Boolean).join('\n\n');
    writeTask(p.tasks, task);
  } else if (task.status === 'claimed') {
    release(ctx, task, agent, outcome, note, logPath, passSummary(outcome, outcome === 'merged' ? subject : (failing ?? note)), kept);
  }
  log(`${outcome === 'merged' ? '✔' : '✘'} ${task.id} ${agent}: ${outcome}${note && outcome !== 'merged' ? ` — ${note.split('\n')[0]!.slice(0, 160)}` : ''}`);
  record(p.ledger, {
    kind: 'pass',
    at: iso(clock.now()),
    startedAt,
    harness: ctx.harness,
    task: task.id,
    repo: task.repo,
    agent,
    model,
    attempt,
    outcome,
    durationMs: since(startedMono),
    gateMs: phases.gateMs || undefined,
    costUsd: result?.costUsd ?? 0,
    tokens: result?.tokens ?? { input: 0, cachedInput: 0, output: 0 },
    commit,
    log: logPath,
    note: note ? note.slice(0, 500) : undefined,
    phases,
    gateSteps,
    failedStep,
    failing,
    carried: carry,
    kept,
    diff,
    promptBytes,
    retryBytes,
    toolCalls: activity.toolCalls,
    scripts: scriptsIn(activity.commands),
    e2e,
    mainMoved,
    usage: result?.usage && {
      session: result.usage.session?.used,
      weekly: result.usage.weekly?.used,
      weeklyResetsAt: result.usage.weekly ? iso(result.usage.weekly.resetsAt) : undefined,
    },
  });
  ctx.passEnded();
  if (outcome !== 'merged' && failing) await noteFailure(ctx, task, { task: task.id, agent, attempt, at: clock.now(), log: logPath, line: failing });
  // A filed fix that merged starts its test's count afresh.
  const fixed = outcome === 'merged' ? filedFor(task) : undefined;
  if (fixed) ctx.failures.delete(fixed);
  if (outcome === 'merged') {
    const reached = await milestoneReached(ctx, task);
    if (reached) ctx.refreshMap(task.id); // the milestone's snapshot, committed with it
    await commitPlan(ctx, `plan: ${task.id} done (${agent})${reached ? `; milestone ${reached.key} reached` : ''}`, !!reached);
  }
}

// The failures of the last day, by failing test, from the ledger: what noteFailure counts from at start.
function recentFailures(events: LedgerEvent[], now: number): Map<string, FailureSeen[]> {
  const out = new Map<string, FailureSeen[]>();
  for (const e of events) {
    if (e.kind !== 'pass' || e.outcome === 'merged' || now - Date.parse(e.at) >= RECURRING_WINDOW_MS) continue;
    const line = e.failing ?? /^the gate failed: (.*)$/m.exec(e.note ?? '')?.[1];
    const signature = line && normaliseFailure(line);
    if (!signature) continue;
    out.set(signature, [...(out.get(signature) ?? []), { task: e.task, agent: e.agent, attempt: e.attempt, at: Date.parse(e.at), log: e.log, line }]);
  }
  return out;
}

// Counts a failed pass's failing test. When the same test has failed two different tasks within a day and no
// fix for it is open, files a fix-first task for it (flaky.ts) and commits it, so the builders take it next; a
// fix parked as not reproducible is made ready again instead, once it fails two more tasks.
async function noteFailure(ctx: PassContext, task: Task, seen: FailureSeen): Promise<void> {
  const signature = normaliseFailure(seen.line);
  if (!signature || !failingTest(signature)) return;
  const { paths: p, clock, log, notify } = ctx.deps;
  const list = [...(ctx.failures.get(signature) ?? []).filter((f) => seen.at - f.at < RECURRING_WINDOW_MS), seen];
  ctx.failures.set(signature, list);
  const tasks = [...new Set(list.map((f) => f.task))];
  if (tasks.length < 2) return;
  const open = [...ctx.plan.tasks.values()].find((t) => t.status !== 'done' && filedFor(t) === signature);
  if (open) {
    const again = reopenedFix(open, list, projectInfo(ctx.deps.config).timezone);
    if (!again) return;
    writeTask(p.tasks, again);
    ctx.plan.tasks.set(again.id, again);
    ctx.failures.delete(signature);
    log(`🔧 ${again.id} is ready again, fix first: ${again.summary}`);
    record(p.ledger, { kind: 'warning', at: iso(clock.now()), task: again.id, detail: `${again.id} ${again.summary}: ${signature}` });
    notify('The loop reopened a fix', `${again.id}: ${again.summary}`);
    return void (await commitPlan(ctx, `plan: ${again.id} ${again.summary}`, false));
  }
  const knownReq = (r: string) => Boolean(ctx.index.reqs[r]) || [...ctx.plan.tasks.values()].some((t) => t.reqs.includes(r));
  const fix = fixTaskFor({
    id: nextFixId(ctx.plan, (id) => existsSync(join(p.tasks, `${id}.yaml`))),
    signature,
    failures: list,
    first: ctx.plan.tasks.get(list[0]!.task) ?? task,
    knownReq,
    timeZone: projectInfo(ctx.deps.config).timezone,
    passMinutes: ctx.deps.config.limits.pass_timeout_minutes,
  });
  if (!fix) return;
  writeTask(p.tasks, fix);
  ctx.plan.tasks.set(fix.id, fix);
  ctx.failures.delete(signature);
  const which = tasks.join(' and ');
  log(`🔧 filed ${fix.id}, fix first: a test failed ${which}: ${signature.slice(0, 160)}`);
  record(p.ledger, { kind: 'warning', at: iso(clock.now()), task: fix.id, detail: `filed ${fix.id} for a test failing ${which}: ${signature}` });
  notify('The loop filed a fix', `${fix.id}: a test failed ${which}`);
  await commitPlan(ctx, `plan: ${fix.id} filed, fix first, for a test failing ${which}`, false);
}

// The loop's side of a release; release.ts decides and records it. Logs what happened, tells the owner
// what needs a person, and holds a repo found diverged. A release that fails is reported; it never undoes a merge.
async function tagRelease(ctx: PassContext, repo: string, ids: string[], reason: string): Promise<void> {
  const { config, paths: p, clock, log, notify } = ctx.deps;
  try {
    const r = await releaseRepo({
      ...releaseSettings(config, p, repo),
      human: ctx.plan.human,
      now: clock.now(),
      reason,
      tasks: ids.map((id) => ({ id, title: ctx.plan.tasks.get(id)?.title ?? '' })),
    });
    if (r.retried) log(`🏷 ${repo}: pushed ${r.retried.tags.join(', ')} again${r.retried.pushed ? '' : ' — the push failed again'}`);
    if (r.kind === 'tagged') {
      log(`🏷 ${repo} ${r.tag}: ${reason} (${ids.length} task${ids.length === 1 ? '' : 's'})${r.pushed === false ? ' — push failed' : ''}`);
    } else if (r.kind === 'current') {
      log(`🏷 ${repo}: main is already released as ${r.tag}`);
    } else {
      log(`🏷 ${repo}: release held ${r.detail}`);
      if (r.diverged) holdDiverged(ctx, repo, r.diverged);
      if (r.approval?.requested) {
        const { tag, paths } = r.approval.approval;
        notify('A release needs your approval', `${repo} ${tag} changes ${paths.length === 1 ? paths[0] : `${paths.length} files`} that run with production secrets. See: helix-loop status`);
      }
    }
  } catch (e) {
    const detail = `release of ${repo} failed: ${(e as Error).message}`;
    record(p.ledger, { kind: 'warning', at: iso(clock.now()), detail });
    notify('A release failed', detail);
    log(`🏷 ${detail}`);
  }
}

// Checkpoint release: every N merges in a repo. Runs inside that repo's merge queue, right after a merge.
// A held release counts as one, so a long hold is noted every N merges rather than after each merge.
async function checkpointRelease(ctx: PassContext, repo: string): Promise<void> {
  const every = ctx.deps.config.release.every_merged_tasks;
  let merges = 0;
  for (const e of readLedger(ctx.deps.paths.ledger)) {
    if ((e.kind === 'release' || e.kind === 'release_held') && e.repo === repo) merges = 0;
    if (e.kind === 'merge' && e.repo === repo) merges++;
  }
  if (merges >= every) await tagRelease(ctx, repo, unreleased(ctx.deps.paths.ledger, repo), `Checkpoint every ${every} tasks`);
}

// Milestone release: when the last task of a milestone is done, each lane it touched with unreleased work is tagged,
// and Home says so, with the milestone's demo to review. The loop doesn't pause: the next milestone's work goes on.
// Called after the task's status is final; the status updates are synchronous, so exactly the last task of the
// milestone to finish sees it reached. Returns the milestone it reached.
async function milestoneReached(ctx: PassContext, task: Task) {
  const m = reachedBy(ctx.plan, task.id);
  if (!m) return undefined;
  const { paths: p, clock, log, notify } = ctx.deps;
  // Reached before: this was follow-up work filed into it, which neither releases nor asks for a review again.
  if (recordedReached(readLedger(p.ledger)).has(m.key)) return undefined;
  const members = membership(ctx.plan).tasks.get(m.key) ?? [];
  const repos = [...new Set(members.map((id) => ctx.plan.tasks.get(id)!.repo))].filter((r) => ctx.deps.config.repos[r]);
  record(p.ledger, { kind: 'milestone', at: iso(clock.now()), key: m.key, title: m.title, demo: m.demo, repos });
  log(`🏁 milestone reached: ${m.title}`);
  notify('Milestone reached', `${m.title}. Review it: ${m.demo}`);
  await Promise.all(
    repos.map((repo) =>
      ctx.queue.enqueue(repo, async () => {
        const ids = unreleased(p.ledger, repo);
        if (ids.length) await tagRelease(ctx, repo, ids, `Milestone reached: ${m.title}`);
      }),
    ),
  );
  return m;
}

// Planning continues while the loop runs, and every change must validate before it is taken: new task
// files join the plan; a task the loop isn't running (ready, waiting on a person or parked, and unclaimed)
// is taken from disk when a person has changed it there, so a task can be revised or handed back without
// a restart; and human tasks are re-read so the owner can mark one done. A task in a pass, or done, stays
// as the loop has it, and the loop writes it back when the pass ends.
const IDLE: readonly TaskStatus[] = ['ready', 'needs_human', 'parked'];
const idle = (t: Task) => IDLE.includes(t.status) && !t.claimed_by;
const canonical = (v: unknown): unknown =>
  Array.isArray(v) ? v.map(canonical) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical((v as Record<string, unknown>)[k])])) : v;
const sameTask = (a: Task, b: Task) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
const structureOf = (plan: Plan) => JSON.stringify([plan.taskset && { ...plan.taskset, epics: [...plan.taskset.epics], features: [...plan.taskset.features], stories: [...plan.taskset.stories] }, plan.milestones]);

function reloadPlan(ctx: PassContext): void {
  const { paths: p, log } = ctx.deps;
  const stamp = sourceStamp(p);
  if (stamp !== ctx.sources) {
    ctx.index = loadIndex(p.specIndex);
    ctx.template = loadTemplate(p.prompts, 'build');
    ctx.sources = stamp;
    log(`reloaded the spec index (v${ctx.index.version}) and the build prompt`);
  }
  let fresh: Plan;
  try {
    fresh = loadPlan(p.tasks, p.human);
  } catch (e) {
    log(`plan reload skipped: ${(e as Error).message}`); // a file mid-save, or a broken edit: try next round
    return;
  }
  const added = [...fresh.tasks.values()].filter((t) => !ctx.plan.tasks.has(t.id));
  const changed = [...fresh.tasks.values()].filter((t) => {
    const mine = ctx.plan.tasks.get(t.id);
    return mine !== undefined && idle(mine) && idle(t) && !sameTask(mine, t);
  });
  // An edit to a task in its pass can't be taken: the loop writes its own copy back when the pass ends.
  for (const t of fresh.tasks.values()) {
    const mine = ctx.plan.tasks.get(t.id);
    if (mine?.status !== 'claimed' || sameTask(mine, t)) ctx.editedInPass.delete(t.id);
    else if (!ctx.editedInPass.has(t.id)) {
      ctx.editedInPass.add(t.id);
      log(`${t.id}: changed on disk during its pass; the loop's copy wins, so make the change again once the pass ends`);
    }
  }
  const humanChanged = JSON.stringify([...fresh.human]) !== JSON.stringify([...ctx.plan.human]);
  // A new TaskSet revision or new milestones (helix-loop milestones apply) come in whole, with the tasks they change.
  const structureChanged = structureOf(fresh) !== structureOf(ctx.plan);
  if (!added.length && !changed.length && !humanChanged && !structureChanged) return;
  const bad = new Set(validateSchemas(p.schema, p.tasks, p.human).map((x) => x.id));
  const candidate: Plan = { ...ctx.plan, tasks: new Map(ctx.plan.tasks), human: fresh.human, taskset: fresh.taskset, milestones: fresh.milestones };
  for (const t of [...added, ...changed]) if (!bad.has(t.id)) candidate.tasks.set(t.id, t);
  // What the change breaks: graph problems, and hierarchy or milestone problems the loop's own plan doesn't have.
  const before = new Set(validateStructure(ctx.plan).map((x) => `${x.id}: ${x.message}`));
  const graph = [...validateGraph(candidate), ...validateStructure(candidate).filter((x) => !before.has(`${x.id}: ${x.message}`))];
  if (graph.length || [...fresh.human.keys()].some((id) => bad.has(id)) || (structureChanged && [...bad].some((id) => id.endsWith('.yaml')))) {
    for (const x of graph.slice(0, 10)) log(`plan reload skipped: ${x.id}: ${x.message}`);
    return;
  }
  if (structureChanged) log(`plan reload: TaskSet revision ${fresh.taskset?.revision ?? '?'}${fresh.milestones ? `, ${fresh.milestones.length} milestones` : ''}`);
  for (const t of added) if (bad.has(t.id)) log(`plan reload: ${t.id} fails the schema; not added`);
  for (const t of changed) {
    const was = ctx.plan.tasks.get(t.id)!.status;
    if (bad.has(t.id)) log(`plan reload: ${t.id} was changed on disk but fails the schema; kept as it was`);
    else if (was !== 'ready' && t.status === 'ready') log(`${t.id}: handed back by a person; ready again`);
    else log(`${t.id}: changed by a person; taken from disk${was === t.status ? '' : ` (now ${t.status})`}`);
  }
  ctx.plan.tasks = candidate.tasks;
  ctx.plan.human = candidate.human;
  ctx.plan.taskset = candidate.taskset;
  ctx.plan.milestones = candidate.milestones;
  const n = added.filter((t) => !bad.has(t.id)).length;
  if (n) log(`plan reload: ${n} new task${n === 1 ? '' : 's'}`);
}

// Defence in depth behind the sandboxes: after every pass, the product repo's primary checkout must be
// clean and on main, and the control plane's protected files must not have changed during the pass.
const PROTECTED = ['harness', 'prompts', 'spec', 'plan/schema', 'plan/capabilities.yaml', 'plan/planners.yaml', 'CLAUDE.md'];

async function controlPlaneChanges(root: string): Promise<string> {
  if (!existsSync(join(root, '.git'))) return '';
  return git(root, 'status', '--porcelain', '--', ...PROTECTED).catch(() => '');
}

async function checkTampering(ctx: PassContext, task: Task, repoDir: string, controlBefore: string): Promise<void> {
  const { config, paths: p, clock, notify } = ctx.deps;
  const problems: string[] = [];
  if (existsSync(join(repoDir, '.git'))) {
    // Read-only: a plain status refreshes the checkout's index under its lock, and the other agent's merge,
    // a fast-forward of this same checkout, fails if it finds that lock taken.
    const status = await git(repoDir, '--no-optional-locks', 'status', '--porcelain').catch(() => '');
    const branch = await git(repoDir, 'rev-parse', '--abbrev-ref', 'HEAD').catch(() => '');
    if (status) problems.push(`${task.repo}'s primary checkout has uncommitted changes:\n${status}`);
    if (branch && branch !== 'main') problems.push(`${task.repo}'s primary checkout is on ${branch}, not main`);
  }
  const controlAfter = await controlPlaneChanges(config.root);
  if (controlAfter !== controlBefore) {
    // Could be the loop engineer editing while the loop runs; recorded and reported, not fatal.
    record(p.ledger, { kind: 'warning', at: iso(clock.now()), task: task.id, detail: `control-plane protected files changed during the pass:\n${controlAfter}` });
    notify('The loop', `Protected control-plane files changed during ${task.id}; check runs/runs.jsonl.`);
  }
  if (problems.length) {
    record(p.ledger, { kind: 'warning', at: iso(clock.now()), task: task.id, detail: `tampering: ${problems.join('; ')}` });
    notify('The loop stopped', `${task.id}: ${problems[0]!.split('\n')[0]}`);
    ctx.stop(`after ${task.id}: ${problems.join('; ')}`);
  }
}

// Plan state is progress, and progress lives in git: the control plane commits plan/tasks and plan/human
// after each merge, and nothing else under plan/. The dependency map (about 390 KB) is rewritten after
// every pass but committed only as a milestone's snapshot when the milestone is reached; `helix-loop plan map`
// regenerates it from the plan data at any time.
async function commitPlan(ctx: PassContext, message: string, withMap: boolean): Promise<void> {
  const { config, paths: p } = ctx.deps;
  const root = config.root;
  if (!existsSync(join(root, '.git'))) return;
  const present = (f: string) => existsSync(f) && (statSync(f).isFile() || readdirSync(f).length > 0); // git refuses an empty pathspec
  const files = [p.tasks, p.human, ...(withMap ? [p.map] : [])].filter(present).map((f) => relative(root, f));
  if (!files.length) return;
  await ctx.queue.enqueue('control-plane', async () => {
    await gitOk(root, 'add', '--', ...files);
    await gitOk(root, ...gitAuthor(ctx.deps.config), 'commit', '-q', '-m', message, '--', ...files);
  });
}

function acquireLock(file: string): boolean {
  if (existsSync(file)) {
    const pid = Number(readFileSync(file, 'utf8'));
    try {
      if (pid) {
        process.kill(pid, 0);
        return false;
      }
    } catch {
      // stale lock from a dead process
    }
  }
  writeFileSync(file, String(process.pid));
  return true;
}

// Holds a macOS power assertion for as long as the loop runs (L3). -i idle, -m disk, -s system sleep on AC.
function keepAwake(): () => void {
  if (process.platform !== 'darwin') return () => {};
  const c = spawn('caffeinate', ['-ims', '-w', String(process.pid)], { stdio: 'ignore', detached: false });
  return () => c.kill();
}

// Resolves when the stop file appears, or runs/PAUSE appears or goes (`paused`: whether it was there); stops
// polling once `signal` aborts. Its timer holds the process open: a paused loop with no pass in flight waits on
// nothing else.
async function waitForControl(p: Paths, paused: boolean, signal: AbortSignal): Promise<void> {
  while (!signal.aborted && !existsSync(p.stopFile) && existsSync(p.pause) === paused) {
    await delay(1000, undefined, { signal }).catch(() => undefined);
  }
}
