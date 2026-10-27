import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { atomicWrite } from '../plan/store.ts';
import type { Config } from '../config.ts';
import { AGENTS, type AgentName, type LoopMode, type MapAgent } from '../types.ts';
import type { Usage } from './adapter.ts';

// Each agent's availability (design doc §7.4), persisted to runs/agents.json so a restarted loop
// still knows a wall is up and when it lifts.

export interface AgentQuota {
  limited: boolean;
  resetAt: number | null; // epoch ms; null while limited means "unknown, back off"
  backoffMs: number; // the next wait when no reset time is known
  day: string; // YYYY-MM-DD of the spend counters (local time)
  spentUsd: number;
  passes: number;
  usage?: Usage; // the subscription's windows as the agent's last run reported them
}

export type QuotaState = Record<AgentName, AgentQuota>;

const RESET_GRACE_MS = 60_000;

const fresh = (day: string): AgentQuota => ({ limited: false, resetAt: null, backoffMs: 0, day, spentUsd: 0, passes: 0 });

export function localDay(epoch: number): string {
  const d = new Date(epoch);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function loadQuota(file: string, now: number): QuotaState {
  const day = localDay(now);
  const saved = existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Partial<QuotaState>) : {};
  const state = {} as QuotaState;
  for (const a of AGENTS) state[a] = { ...fresh(day), ...saved[a] };
  return state;
}

export function saveQuota(file: string, state: QuotaState): void {
  mkdirSync(dirname(file), { recursive: true });
  atomicWrite(file, JSON.stringify(state, null, 2) + '\n');
}

export function rollDay(q: AgentQuota, now: number): void {
  const day = localDay(now);
  if (q.day !== day) {
    q.day = day;
    q.spentUsd = 0;
    q.passes = 0;
  }
}

export function markLimited(q: AgentQuota, resetAt: number | null, now: number, backoff: { first: number; max: number }): void {
  q.limited = true;
  if (resetAt && resetAt > now) {
    // Reset times are stated to the minute; probe a minute after, not on the second.
    q.resetAt = resetAt + RESET_GRACE_MS;
    q.backoffMs = 0;
  } else {
    q.backoffMs = Math.min(backoff.max * 60_000, q.backoffMs ? q.backoffMs * 2 : backoff.first * 60_000);
    q.resetAt = now + q.backoffMs;
  }
}

export function markAvailable(q: AgentQuota): void {
  q.limited = false;
  q.resetAt = null;
  q.backoffMs = 0;
}

export function overBudget(q: AgentQuota, budgetUsd: number, now: number): boolean {
  rollDay(q, now);
  return q.spentUsd >= budgetUsd;
}

const WEEK_MS = 7 * 86_400_000;
export const PACE_MARGIN = 0.02;

export interface Pace {
  slots: number; // passes the agent may run at once
  allowed?: number; // the share of the weekly window an even pace to the target allows by now
  until?: number; // with no slots: when the pace catches up and the agent works again (epoch ms)
}

// How many passes an agent may run at once so that its subscription's weekly window lasts until it resets.
// An even pace uses `target` of the window by the reset. The agent runs all its slots while it is behind that
// pace by more than the margin, one pass while within the margin either way, and none while further ahead,
// until the pace catches up. A single pass uses more than an even pace for both subscriptions (about 0.7% of
// the window an hour against 0.54% for a 90% target), so most of a week runs one pass with pauses, and the
// second slot runs only on time the subscription would otherwise lose: an hour or a day nobody used it.
export function paceSlots(usage: Usage | undefined, slots: number, now: number, target: number | undefined): Pace {
  const w = usage?.weekly;
  if (target === undefined || !w || w.resetsAt <= now) return { slots };
  const allowed = target * Math.min(1, Math.max(0, 1 - (w.resetsAt - now) / WEEK_MS));
  const lead = w.used - allowed;
  if (lead < -PACE_MARGIN) return { slots, allowed };
  if (lead <= PACE_MARGIN) return { slots: Math.min(slots, 1), allowed };
  // The pace reaches the margin below what is used at this time, and never after the reset.
  const until = w.resetsAt - WEEK_MS * (1 - (w.used - PACE_MARGIN) / target);
  return { slots: 0, allowed, until: Math.min(Math.max(until, now), w.resetsAt) };
}

// Each agent as the dependency map shows it: what its passes in flight hold, out of how many slots, and what
// its pace allows now. The loop draws the map from its own passes, the loop app from runs/live.json.
export function mapAgents(config: Config, quota: QuotaState, held: { agent: AgentName; task: string }[], now: number): MapAgent[] {
  return AGENTS.map((a) => {
    const q = quota[a];
    const tasks = held.filter((x) => x.agent === a).map((x) => x.task);
    const { slots } = config.agents[a];
    const pace = paceSlots(q.usage, slots, now, config.agents[a].weekly_target);
    return {
      name: a,
      model: config.agents[a].models.build.model,
      state: q.limited ? 'limited' : tasks.length ? 'busy' : 'available',
      tasks,
      slots,
      paced: pace.slots < slots ? pace.slots : undefined,
      pacedUntil: pace.until !== undefined ? new Date(pace.until).toISOString() : undefined,
      resetAt: q.limited && q.resetAt ? new Date(q.resetAt).toISOString() : undefined,
    };
  });
}

// One line on an agent's weekly window and what its pace allows, for the log and `status`.
export function describePace(usage: Usage | undefined, pace: Pace, target: number | undefined, now: number): string | undefined {
  const w = usage?.weekly;
  if (!w) return undefined;
  const when = (t: number) => new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(t);
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  const slots = pace.slots === 0 ? `no new passes until ${when(pace.until ?? w.resetsAt)}` : `${pace.slots} pass${pace.slots === 1 ? '' : 'es'} at a time`;
  if (w.resetsAt <= now) return `${slots}: its weekly window reset ${when(w.resetsAt)}`;
  const pacing = target === undefined || pace.allowed === undefined ? '' : `; an even pace to ${pct(target)} by then allows ${pct(pace.allowed)}`;
  return `${slots}: ${pct(w.used)} of its weekly window used, which resets ${when(w.resetsAt)}${pacing}`;
}

// The quota table: which agents can take work, as one word for the ledger and the chart.
export function loopMode(available: Record<AgentName, boolean>, anyWork: boolean): LoopMode {
  if (!anyWork) return 'idle';
  if (available.claude && available.codex) return 'parallel';
  if (available.claude) return 'single:claude';
  if (available.codex) return 'single:codex';
  return 'paused';
}

// What Helix, the loop app's assistant, spent on each agent on `day` (runs/helix.jsonl, and runs/steward.jsonl from
// before it was renamed): it draws on the same subscriptions, so it counts toward each agent's daily budget.
export function helixSpentUsd(files: string[], day: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const file of files) {
    if (existsSync(file)) addSpend(file, day, out);
  }
  return out;
}

function addSpend(file: string, day: string, out: Record<string, number>): void {
  for (const l of readFileSync(file, 'utf8').split('\n')) {
    if (!l.startsWith('{')) continue;
    try {
      const r = JSON.parse(l) as { at: string; agent: string; costUsd?: number };
      if (localDay(Date.parse(r.at)) === day) out[r.agent] = (out[r.agent] ?? 0) + (r.costUsd ?? 0);
    } catch {
      // a line mid-append
    }
  }
}
