import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describePace, loadQuota, localDay, mapAgents, overBudget, paceSlots, helixSpentUsd } from '../agents/quota.ts';
import { paths, type Config } from '../config.ts';
import { meanPassHours, readLedger, type LedgerEvent } from '../ledger.ts';
import { readLive, type LivePass } from '../live.ts';
import { computeMap } from '../map/graph.ts';
import { buildMetrics, type MetricsModel } from '../metrics/model.ts';
import { readVersions } from '../metrics/archive.ts';
import { taskHistory } from '../metrics/render.ts';
import { loadPlan } from '../plan/store.ts';
import { validateGraph, validateSchemas, validateState, type Problem } from '../plan/validate.ts';
import { describeBase, pendingApprovals, unreleased } from '../release.ts';
import { buildStats, type BuildStats } from '../stats.ts';
import { AGENTS, type AgentName, type LoopMode, type MapModel, type Plan } from '../types.ts';
import { readFeed } from './feed.ts';
import { allThreads, type Thread } from './threads.ts';

// What the app shows, derived from the control plane's files the way the CLI derives it: nothing here is
// stored, so the page can never disagree with `mushy-loop status`.

export interface LoopStatus {
  running: boolean;
  pid?: number;
  since?: string; // the running loop's start
  stopping: boolean; // runs/STOP is waiting for the loop to see it
  mode: LoopMode;
  modeDetail?: string;
  lastExit?: { at: string; code?: number; detail?: string };
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
};

export function loopStatus(root: string, events: LedgerEvent[]): LoopStatus {
  const p = paths(root);
  const pid = existsSync(p.lock) ? Number(readFileSync(p.lock, 'utf8')) : 0;
  const running = pid > 0 && alive(pid);
  const starts = events.filter((e) => e.kind === 'loop');
  const lastStart = starts.findLast((e) => e.kind === 'loop' && e.event === 'start');
  const lastExit = starts.findLast((e) => e.kind === 'loop' && e.event === 'exit') as Extract<LedgerEvent, { kind: 'loop' }> | undefined;
  const mode = events.findLast((e) => e.kind === 'mode') as Extract<LedgerEvent, { kind: 'mode' }> | undefined;
  return {
    running,
    pid: running ? pid : undefined,
    since: running ? lastStart?.at : undefined,
    stopping: running && existsSync(p.stopFile),
    mode: running ? ((mode?.mode as LoopMode) ?? 'idle') : 'idle',
    modeDetail: running ? mode?.detail : undefined,
    lastExit: lastExit && (!lastStart || lastExit.at >= lastStart.at) ? { at: lastExit.at, code: lastExit.code, detail: lastExit.detail } : undefined,
  };
}

// A pass in flight, with its task's title and its log.
export type PassNow = LivePass & {
  title?: string;
  log?: string; // relative to the root
  inferred?: boolean; // read from the plan's claim and the log, not from runs/live.json: its phase has no start
  lastMessage?: string; // the builder's latest words, from its log
};

// The passes in flight. A loop that writes runs/live.json says what each is doing. One that doesn't (started
// before that existed) shows its passes only as the plan's claims, and its pass logs say the rest: the phase
// the log has reached and the tool calls in it.
export function passesNow(root: string, plan: Plan, status: LoopStatus): PassNow[] {
  if (!status.running) return [];
  const live = readLive(paths(root).live);
  if (live && live.pid === status.pid) {
    return live.passes.map((x) => {
      const log = passLog(root, x.task, x.agent, x.attempt, x.startedAt);
      const feed = log ? readFeed(join(root, log), x.agent, root, 0) : undefined;
      return { ...x, title: plan.tasks.get(x.task)?.title, log, lastMessage: feed?.lastMessage };
    });
  }
  return [...plan.tasks.values()].flatMap((t) => {
    if (t.status !== 'claimed' || !t.claimed_by) return [];
    const agent = t.claimed_by;
    const attempt = t.attempts.length + 1;
    const log = passLog(root, t.id, agent, attempt);
    const feed = log ? readFeed(join(root, log), agent, root, 0) : undefined;
    const startedAt = log ? statSync(join(root, log)).birthtime.toISOString() : (status.since ?? new Date().toISOString());
    return [{ id: `${t.id}:${agent}:${attempt}`, task: t.id, title: t.title, repo: t.repo, agent, attempt, startedAt, phase: feed?.phase ?? 'setup', phaseAt: startedAt, toolCalls: feed?.summary.toolCalls ?? 0, log, inferred: true, lastMessage: feed?.lastMessage }];
  });
}

// A pass's log while it runs: runs/logs/<the UTC day it started>/<task>-<agent>-<attempt>.log. Without its start,
// today's folder and yesterday's are looked in.
export function passLog(root: string, task: string, agent: AgentName, attempt: number, startedAt?: string): string | undefined {
  const days = startedAt ? [startedAt.slice(0, 10)] : [0, 1].map((back) => new Date(Date.now() - back * 86_400_000).toISOString().slice(0, 10));
  for (const day of days) {
    const rel = join('runs', 'logs', day, `${task}-${agent}-${attempt}.log`);
    if (existsSync(join(root, rel))) return rel;
  }
  return undefined;
}

// The dependency map as the loop would draw it now: its agents busy with the passes in flight.
export function mapModel(root: string, plan: Plan, events: LedgerEvent[], config: Config, now = Date.now()): MapModel {
  const quota = loadQuota(paths(root).agentsState, now);
  const status = loopStatus(root, events);
  const agents = mapAgents(config, quota, passesNow(root, plan, status), now);
  return { ...computeMap(plan, { now, passHours: meanPassHours(events), agents, mode: status.mode }), lanes: Object.keys(config.repos) };
}

// taskHistory reads the plan's git history; it changes only when a task file is added or removed.
let history: { root: string; at: number; value: [number, number][] } | undefined;
export function metricsModel(root: string, plan: Plan, events: LedgerEvent[], config: Config, now = Date.now()): MetricsModel {
  if (!history || history.root !== root || now - history.at > 5 * 60_000) history = { root, at: now, value: taskHistory(root) };
  const model = buildMetrics({ events, plan, now, history: history.value });
  return { ...model, versions: readVersions(paths(root).metrics), versionEvery: config.metrics_every_passes };
}

export interface Report {
  at: string;
  pass: string;
  task: string;
  agent: AgentName;
  attempt: number;
  kind: 'progress' | 'issue';
  issue?: string;
  message: string;
  paths?: string[];
  blocking?: boolean; // the builder can't go on without it
}

export function readReports(root: string): Report[] {
  const f = paths(root).reports;
  if (!existsSync(f)) return [];
  return readFileSync(f, 'utf8')
    .split('\n')
    .filter(Boolean)
    .flatMap((l) => {
      try {
        return [JSON.parse(l) as Report];
      } catch {
        return [];
      }
    });
}

export interface InboxItem {
  id: string; // stable, for dismissing
  kind: 'human_due' | 'needs_human' | 'approval' | 'diverged' | 'agent' | 'warning' | 'issue' | 'thread';
  title: string;
  detail?: string;
  target?: string; // a task or human task to open
  thread?: string; // a thread to open
  agent?: AgentName; // an agent to open
  at?: string; // a deadline, or when it happened
  urgent?: boolean;
}

export interface AppState {
  root: string;
  dryRun: boolean;
  generatedAt: string;
  loop: LoopStatus;
  agents: {
    name: AgentName;
    model: string;
    enabled: boolean;
    state: string;
    resetAt?: string;
    slots: number;
    paced?: number;
    pacedUntil?: string;
    pace?: string; // its weekly window and what its pace allows, in a line
    spentUsd: number;
    stewardUsd: number;
    budgetUsd: number;
    passes: number;
    overBudget: boolean;
  }[];
  totals: MapModel['totals'];
  humanOpen: number;
  projectedFinish: string;
  live: (PassNow & { progress?: string; progressAt?: string })[];
  stats: BuildStats;
  releases: { repo: string; unreleased: number; holds: string[]; approvals: { tag: string; paths: string[]; since: string; requestedAt: string }[] }[];
  plan: { problems: number; list: Problem[] };
  inbox: InboxItem[];
  threads: ThreadSummary[];
}

export type ThreadSummary = Pick<Thread, 'key' | 'target' | 'state' | 'waitingOn'> & { first: string; at: string };

const SINCE_MS = 24 * 3_600_000; // warnings and issues stay in the inbox this long, unless dismissed

// The inputs that are costly to read, read once per change of their files (server.ts caches them).
export interface Snapshot {
  plan: Plan;
  events: LedgerEvent[];
  problems: Problem[];
}

// A root that doesn't exist yet (the dry run before its first start) reads as an empty plan.
export function snapshot(root: string): Snapshot {
  const p = paths(root);
  const plan = loadPlan(p.tasks, p.human);
  const schema = existsSync(p.schema) ? validateSchemas(p.schema, p.tasks, p.human) : [];
  return { plan, events: existsSync(p.ledger) ? readLedger(p.ledger) : [], problems: [...schema, ...validateGraph(plan), ...validateState(plan)] };
}

export function appState(root: string, snap: Snapshot, config: Config, opts: { dryRun: boolean; dismissed: Set<string>; now?: number }): AppState {
  const now = opts.now ?? Date.now();
  const p = paths(root);
  const { plan, events, problems } = snap;
  const status = loopStatus(root, events);
  const map = mapModel(root, plan, events, config, now);
  const quota = loadQuota(p.agentsState, now);
  const steward = helixSpentUsd([p.steward, p.helixTurns], localDay(now));
  const reports = readReports(root);
  const livePasses = passesNow(root, plan, status);
  const live = livePasses.map((x) => {
    const last = reports.findLast((r) => r.pass === x.id && r.kind === 'progress');
    return { ...x, progress: last?.message, progressAt: last?.at };
  });
  const holding = livePasses.map((x) => x.agent);

  const inbox: InboxItem[] = [];
  for (const n of map.nodes) {
    if (n.kind === 'human' && n.status !== 'done' && n.latestStart) {
      const due = Date.parse(n.latestStart);
      if (due < now + 2 * 86_400_000) inbox.push({ id: `due:${n.id}`, kind: 'human_due', title: `${n.id}: ${n.title}`, target: n.id, at: n.latestStart, urgent: due < now, detail: due < now ? 'past its start-by date' : 'start by' });
    }
  }
  for (const t of plan.tasks.values()) {
    if (t.status === 'needs_human') inbox.push({ id: `needs:${t.id}:${t.attempts.length}`, kind: 'needs_human', title: `${t.id}: ${t.title}`, detail: t.summary, target: t.id, at: t.attempts.at(-1)?.at, urgent: true });
  }
  for (const { approval: a } of pendingApprovals(p.approvals)) {
    inbox.push({ id: `approval:${a.repo}:${a.tag}`, kind: 'approval', title: `${a.repo} ${a.tag} waits for your approval`, detail: `It changes ${a.paths.length} file${a.paths.length === 1 ? '' : 's'} that run with production secrets, since ${describeBase(a.since)}.`, at: a.requestedAt, urgent: true });
  }
  for (const a of AGENTS) {
    if (!config.agents[a].enabled) continue;
    if (quota[a].limited) inbox.push({ id: `limited:${a}:${quota[a].resetAt}`, kind: 'agent', agent: a, title: `${a} is at its usage limit`, detail: quota[a].resetAt ? `resets ${new Date(quota[a].resetAt!).toISOString()}` : 'reset time unknown; backing off', at: quota[a].resetAt ? new Date(quota[a].resetAt!).toISOString() : undefined });
    if (overBudget(quota[a], config.limits.daily_budget_usd[a] - (steward[a] ?? 0), now)) inbox.push({ id: `budget:${a}:${quota[a].day}`, kind: 'agent', agent: a, title: `${a} has spent its daily budget`, detail: `$${quota[a].spentUsd.toFixed(2)} of $${config.limits.daily_budget_usd[a]}; it takes work again at midnight` });
  }
  const recent = (at: string) => now - Date.parse(at) < SINCE_MS;
  events.forEach((e, i) => {
    if (e.kind !== 'warning' || !recent(e.at)) return;
    const diverged = /diverged/.test(e.detail);
    inbox.push({ id: `warning:${i}`, kind: diverged ? 'diverged' : 'warning', title: e.detail.split('\n')[0]!.slice(0, 160), detail: e.detail.includes('\n') ? e.detail : undefined, target: e.task, at: e.at, urgent: diverged || /tampering/.test(e.detail) });
  });
  reports.forEach((r, i) => {
    if (r.kind !== 'issue' || !recent(r.at) || plan.tasks.get(r.task)?.status === 'done') return;
    inbox.push({ id: `issue:${i}`, kind: 'issue', title: `${r.task}: ${r.agent} reports a ${r.issue?.replace('_', ' ')}`, detail: r.message, target: r.task, at: r.at });
  });
  const threads = allThreads(p.threads);
  for (const t of threads) {
    if (t.waitingOn === 'daniel') inbox.push({ id: `thread:${t.key}:${t.messages.length}`, kind: 'thread', title: `The steward answered on ${t.target}`, detail: t.messages.at(-1)?.text.slice(0, 200), thread: t.key, at: t.messages.at(-1)?.at });
  }

  return {
    root,
    dryRun: opts.dryRun,
    generatedAt: new Date(now).toISOString(),
    loop: status,
    agents: AGENTS.map((a) => {
      const m = map.agents.find((x) => x.name === a)!;
      const target = config.agents[a].weekly_target;
      return {
        name: a,
        model: m.model,
        enabled: config.agents[a].enabled,
        state: m.state,
        resetAt: m.resetAt,
        slots: m.slots,
        paced: m.paced,
        pacedUntil: m.pacedUntil,
        pace: describePace(quota[a].usage, paceSlots(quota[a].usage, m.slots, now, target), target, now),
        spentUsd: quota[a].spentUsd,
        stewardUsd: steward[a] ?? 0,
        budgetUsd: config.limits.daily_budget_usd[a],
        passes: quota[a].passes,
        overBudget: overBudget(quota[a], config.limits.daily_budget_usd[a] - (steward[a] ?? 0), now),
      };
    }),
    totals: map.totals,
    humanOpen: [...plan.human.values()].filter((h) => h.status !== 'done').length,
    projectedFinish: map.projectedFinish,
    live,
    stats: buildStats(events, AGENTS, now, holding),
    releases: Object.keys(config.repos).map((repo) => {
      const step = config.release.hold_until?.[repo as keyof typeof config.repos];
      const h = step ? plan.human.get(step) : undefined;
      return {
        repo,
        unreleased: unreleased(p.ledger, repo).length,
        holds: step && h?.status !== 'done' ? [`releases wait for ${step} (${h ? h.status.replace('_', ' ') : 'not in the plan'})`] : [],
        approvals: pendingApprovals(p.approvals, repo).map(({ approval: a }) => ({ tag: a.tag, paths: a.paths, since: describeBase(a.since), requestedAt: a.requestedAt })),
      };
    }),
    plan: { problems: problems.length, list: problems.slice(0, 50) },
    inbox: inbox.filter((x) => !opts.dismissed.has(x.id)).sort((a, b) => Number(!!b.urgent) - Number(!!a.urgent) || (a.at ?? '').localeCompare(b.at ?? '')),
    threads: threads.map((t) => ({ key: t.key, target: t.target, state: t.state, waitingOn: t.waitingOn, first: t.root.text.split('\n')[0]!.slice(0, 120), at: (t.messages.at(-1) ?? t.root).at })),
  };
}
