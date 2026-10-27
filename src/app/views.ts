import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { loadQuota } from '../agents/quota.ts';
import { paths, type Config } from '../config.ts';
import type { LedgerEvent } from '../ledger.ts';
import { pendingApprovals, describeBase } from '../release.ts';
import type { AgentName, Plan } from '../types.ts';
import { mapAgents } from '../agents/quota.ts';
import { buildBoard, finishMoved, type Board, type BoardInput } from './board.ts';
import { readChanges, UNDO_MS } from './changes.ts';
import { decide, pilotOf, readHitl, readRules, REQUESTS, type HitlRecord } from './hitl.ts';
import { incidents as findIncidents, readStored, type Incident } from './incidents.ts';
import { loopStatus, passesNow, readReports, type PassNow, type Snapshot } from './state.ts';
import { loadTaskSet } from './taskset.ts';
import { sortGroups, triage, type Group } from './triage.ts';

// What the redesigned page reads (spec §6), derived from the files on each change: the board for the Map, the
// groups for Home, a task's whole story, and Helix's record. The server caches one View per root and drops it
// when the plan, the ledger or the reports change.

const exec = promisify(execFile);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export interface View {
  root: string;
  at: number;
  snap: Snapshot;
  config: Config;
  passes: PassNow[];
  board: Board & { rank: string[] };
  input: BoardInput;
  incidents: Incident[];
  groups: Group[];
}

// What the board is built from: the plan and the ledger, the TaskSet, and the passes and slots the loop has now.
export function boardInput(root: string, plan: Plan, events: LedgerEvent[], config: Config, now: number): BoardInput & { running: PassNow[] } {
  const passes = passesNow(root, plan, loopStatus(root, events));
  const agents = mapAgents(config, loadQuota(paths(root).agentsState, now), passes, now);
  return { plan, events, taskset: loadTaskSet(root, plan), agents, running: passes, config, now };
}

export function buildView(root: string, snap: Snapshot, config: Config, opts: { dismissed: Set<string>; now?: number }): View {
  const now = opts.now ?? Date.now();
  const input = boardInput(root, snap.plan, snap.events, config, now);
  const passes = input.running;
  const board = buildBoard(input);
  const p = paths(root);
  const incidents = findIncidents({ plan: snap.plan, events: snap.events, reports: readReports(root), stored: readStored(p.incidents), now });
  const approvals = pendingApprovals(p.approvals).map(({ approval: a }) => ({ repo: a.repo, tag: a.tag, paths: a.paths, since: describeBase(a.since), requestedAt: a.requestedAt }));
  const groups = triage({ plan: snap.plan, board, events: snap.events, incidents, approvals, hitl: readHitl(p.hitl), config, dismissed: opts.dismissed, now });
  // What each group costs: the human tasks' lateness, in time on the projected finish.
  const cost = { ...input, rank: board.rank, slots: board.slots, finish: board.finish };
  for (const g of groups) {
    const humans = g.members.map((m) => m.id).filter((id) => snap.plan.human.has(id));
    if (humans.length) g.finishMs = finishMoved(cost, humans, { doneNow: true });
  }
  return { root, at: now, snap, config, passes, board, input, incidents, groups: sortGroups(groups) };
}

// ---- Home ----

export interface Welcome {
  awayMs: number;
  mode: 'active' | 'auto';
  merged: number;
  failed: number; // tasks that came to need a person since
  finishMovedMs: number; // later is positive
  finish: number;
  movers: string[]; // what moved it most: the costliest groups' first members
}

// The summary that leads Home after an hour away (spec §6.2), from the ledger, not a model.
export function welcome(v: View, last: { at: string; finish?: number; mode?: 'active' | 'auto' } | undefined): Welcome | undefined {
  if (!last) return undefined;
  const since = Date.parse(last.at);
  const awayMs = v.at - since;
  if (awayMs < HOUR) return undefined;
  const after = v.snap.events.filter((e) => Date.parse(e.at) > since);
  const merged = after.filter((e) => e.kind === 'merge').length;
  const failedTasks = new Set(after.filter((e): e is Extract<LedgerEvent, { kind: 'pass' }> => e.kind === 'pass' && e.outcome !== 'merged').map((e) => e.task));
  const failed = [...failedTasks].filter((id) => ['needs_human', 'parked'].includes(v.snap.plan.tasks.get(id)?.status ?? '')).length;
  return {
    awayMs,
    mode: last.mode ?? pilotOf(v.config).mode,
    merged,
    failed,
    finishMovedMs: last.finish ? v.board.finish - last.finish : 0,
    finish: v.board.finish,
    movers: v.groups.filter((g) => (g.finishMs ?? 0) > 6 * HOUR || g.held > 20).slice(0, 2).map((g) => (g.kind === 'your_tasks' ? g.members[0]!.id : g.title)),
  };
}

// Merges per six hours over the last three days, oldest first.
export function mergeBuckets(events: LedgerEvent[], now: number): number[] {
  const out = new Array(12).fill(0) as number[];
  const start = now - 3 * DAY;
  for (const e of events) {
    if (e.kind !== 'merge') continue;
    const at = Date.parse(e.at);
    if (at < start) continue;
    out[Math.min(11, Math.floor((at - start) / (6 * HOUR)))]!++;
  }
  return out;
}

// ---- a task's story: its commits on main and its builder history ----

export interface CommitInfo {
  sha: string;
  subject: string;
  files: number;
  added: number;
  deleted: number;
  paths: string[];
  merge?: boolean;
}

// The commits a merged task put on its repo's main: from the previous merge into that repo to its own.
export async function taskCommits(root: string, events: LedgerEvent[], task: string): Promise<{ repo: string; commits: CommitInfo[] } | undefined> {
  const merges = events.filter((e): e is Extract<LedgerEvent, { kind: 'merge' }> => e.kind === 'merge');
  const i = merges.findLastIndex((m) => m.task === task);
  if (i < 0) return undefined;
  const m = merges[i]!;
  const prev = merges.slice(0, i).findLast((x) => x.repo === m.repo);
  const dir = join(paths(root).repos, m.repo);
  if (!existsSync(dir)) return { repo: m.repo, commits: [] };
  const range = prev ? `${prev.commit}..${m.commit}` : `${m.commit}~1..${m.commit}`;
  const out = await exec('git', ['log', '--numstat', '--format=@@%H%x09%P%x09%s', '-n', '30', range], { cwd: dir, maxBuffer: 8_000_000 }).then((r) => r.stdout, () => '');
  const commits: CommitInfo[] = [];
  for (const block of out.split('@@').filter(Boolean)) {
    const [head, ...lines] = block.split('\n');
    const [sha, parents, subject] = head!.split('\t');
    const stats = lines.filter(Boolean).map((l) => l.split('\t'));
    commits.push({
      sha: sha!,
      subject: subject ?? '',
      files: stats.length,
      added: stats.reduce((n, s) => n + (Number(s[0]) || 0), 0),
      deleted: stats.reduce((n, s) => n + (Number(s[1]) || 0), 0),
      paths: stats.map((s) => s[2]!).slice(0, 8),
      ...((parents ?? '').split(' ').length > 1 ? { merge: true } : {}),
    });
  }
  return { repo: m.repo, commits };
}

export interface HistoryItem {
  at: string;
  kind: 'claimed' | 'attempt' | 'gate' | 'merged' | 'unblocked' | 'state';
  title: string;
  detail?: string;
  state?: 'ok' | 'failed' | 'running' | 'info';
  log?: string;
  attempt?: number;
  agent?: string;
  commit?: string;
}

export function builderHistory(plan: Plan, events: LedgerEvent[], id: string, running?: PassNow & { progress?: string }): HistoryItem[] {
  const out: HistoryItem[] = [];
  const passes = events.filter((e): e is Extract<LedgerEvent, { kind: 'pass' }> => e.kind === 'pass' && e.task === id);
  const AG: Record<string, string> = { claude: 'Claude Code', codex: 'Codex' };
  if (passes[0]) out.push({ at: passes[0].startedAt ?? new Date(Date.parse(passes[0].at) - passes[0].durationMs).toISOString(), kind: 'claimed', title: `Claimed by ${AG[passes[0].agent] ?? passes[0].agent}`, state: 'info' });
  for (const p of passes) {
    const ok = p.outcome === 'merged';
    const gateMs = p.phases?.gateMs ?? p.gateMs;
    const what = ok ? `${Math.round(p.durationMs / 60_000)} min${p.toolCalls ? ` · ${p.toolCalls} tool calls` : ''}${p.carried ? ` · started from attempt ${p.carried.from.split('-').pop()}'s kept work` : ''}` : (p.failing ?? p.note?.split('\n')[0] ?? p.outcome.replace(/_/g, ' '));
    out.push({
      at: p.startedAt ?? p.at,
      kind: 'attempt',
      title: `Attempt ${p.attempt} · ${AG[p.agent] ?? p.agent}${ok ? '' : ` · ${p.failedStep ? `gate failed at ${p.failedStep}` : p.outcome.replace(/_/g, ' ')}`}`,
      detail: what,
      state: ok ? 'ok' : ['quota', 'suspended', 'transient', 'stopped'].includes(p.outcome) ? 'info' : 'failed',
      log: p.log,
      attempt: p.attempt,
      agent: p.agent,
    });
    if (ok && gateMs) {
      const steps = p.gateSteps ?? [];
      out.push({ at: new Date(Date.parse(p.at) - gateMs).toISOString(), kind: 'gate', title: `Gate passed${steps.length ? ` · ${steps.length} steps` : ''}`, detail: `${fmt(gateMs)}${steps.length ? ` · slowest ${[...steps].sort((a, b) => b.ms - a.ms)[0]!.step} ${fmt([...steps].sort((a, b) => b.ms - a.ms)[0]!.ms)}` : ''}`, state: 'ok', log: p.log });
    }
  }
  if (running) out.push({ at: running.startedAt, kind: 'attempt', title: `Attempt ${running.attempt} · ${AG[running.agent]} · ${running.phase === 'gate' ? 'gating' : 'working'}`, detail: running.progress ?? running.lastMessage, state: 'running', log: running.log, attempt: running.attempt, agent: running.agent });
  const merge = events.findLast((e): e is Extract<LedgerEvent, { kind: 'merge' }> => e.kind === 'merge' && e.task === id);
  if (merge) {
    out.push({ at: merge.at, kind: 'merged', title: 'Merged into main', detail: merge.regated ? 'rebased on newer commits, re-gated clean' : undefined, state: 'ok', commit: merge.commit });
    const freed = [...plan.tasks.values()].filter((t) => t.blocked_by.includes(id));
    if (freed.length) {
      const ready = freed.filter((t) => t.status !== 'done' && t.blocked_by.every((d) => plan.tasks.get(d)?.status === 'done' || plan.human.get(d)?.status === 'done'));
      out.push({ at: merge.at, kind: 'unblocked', title: `Unblocked ${freed.slice(0, 3).map((t) => t.id).join(', ')}${freed.length > 3 ? ` and ${freed.length - 3} more` : ''}`, detail: ready.length ? `${ready.length === freed.length ? (freed.length === 1 ? 'ready now' : 'all ready now') : `${ready.length} ready now`}` : undefined, state: 'info' });
    }
  }
  return out.sort((a, b) => a.at.localeCompare(b.at));
}

const fmt = (ms: number) => (ms < 60_000 ? `${Math.round(ms / 1000)} s` : `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`);

// ---- Helix: what it resolved, the fixes waiting, the incidents, the undo list ----

export interface ResolvedItem extends HitlRecord {
  rating?: string;
  outcome: { text: string; tone: 'ok' | 'warn' | 'bad' };
}

export function resolvedRecord(v: View, sinceIso?: string): { items: ResolvedItem[]; held: number; undid: number; unsure: number } {
  const { records, ratings } = readHitl(paths(v.root).hitl);
  const plan = v.snap.plan;
  const items = records
    .filter((r) => !sinceIso || r.at >= sinceIso)
    .map((r) => {
      const ids = r.tasks ?? (r.task ? [r.task] : []);
      const ts = ids.map((id) => plan.tasks.get(id)).filter(Boolean);
      const merged = ts.filter((t) => t!.status === 'done').length;
      const parked = ts.filter((t) => t!.status === 'parked' || t!.status === 'needs_human').length;
      // Undid itself: the same failure came back on a task after Helix acted.
      const again = ids.some((id) => v.snap.events.some((e) => e.kind === 'pass' && e.task === id && e.at > r.at && e.outcome !== 'merged' && e.outcome !== 'quota'));
      const outcome: ResolvedItem['outcome'] = again && !merged
        ? { text: 'Undid itself: failures continued', tone: 'bad' }
        : parked
          ? { text: `Still parked${ts.length > 1 ? ` · ${parked}` : ''}`, tone: 'warn' }
          : merged
            ? { text: ts.length > 1 ? `${merged} merged since${ts.length > merged ? ` · ${ts.length - merged} still building` : ''}` : 'Merged', tone: 'ok' }
            : { text: 'Applied', tone: 'ok' };
      return { ...r, rating: ratings.get(r.id)?.rating, outcome };
    });
  return { items, held: items.filter((i) => i.outcome.tone === 'ok').length, undid: items.filter((i) => i.outcome.tone === 'bad').length, unsure: items.filter((i) => i.confidence < 0.7).length };
}

export function helixSummary(v: View) {
  const fixes = v.incidents.filter((i) => i.fix && !i.decision && i.open);
  const changes = readChanges(paths(v.root).changes).filter((c) => v.at - Date.parse(c.at) < UNDO_MS).reverse();
  return {
    fixes: fixes.map((i) => ({ key: i.key, title: i.title ?? i.cause, kind: i.kind, members: i.members.length, fix: i.fix! })),
    incidents: v.incidents.slice(0, 80).map((i) => ({ key: i.key, kind: i.kind, cause: i.cause, title: i.title, members: i.members.slice(0, 50), failures: i.failures, first: i.first, last: i.last, filed: i.filed, fix: i.fix, decision: i.decision, open: i.open, groupedBy: i.groupedBy })),
    changes,
  };
}

// The decision table with the rules in force, for Settings › Pilot mode.
export function pilotView(root: string, config: Config) {
  const pilot = pilotOf(config);
  const rules = readRules(root);
  return { pilot, rules, requests: REQUESTS.map((r) => ({ ...r, now: decide(pilot, rules, r.kind).decision })) };
}

export function agentOf(name: string): AgentName | undefined {
  return name === 'claude' || name === 'codex' ? name : undefined;
}
