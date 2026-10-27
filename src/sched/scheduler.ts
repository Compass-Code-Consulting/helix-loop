import { stageIndex, stagesOf } from '../plan/stages.ts';
import { UNCOUNTED_OUTCOMES, type AgentName, type Plan, type Stage, type Task } from '../types.ts';

// Picks the next task for a free agent slot (design doc §4 step 1 and §7.2). Pure: the loop
// passes in the plan, the rank from the dependency map, and what is currently held.

export interface PickInput {
  plan: Plan;
  rank: string[]; // task ids, best first (map/graph.ts rankTasks)
  agent: AgentName;
  heldAreas: Set<string>; // areas held by any running pass, either agent
  maxAttempts: number;
}

// A stage opens when every task of every earlier stage is settled: done, waiting on a person
// (§21: each day closes green), or mascot design work. A review that takes weeks must not freeze the
// rest of the build, and neither must Codex's quota while it draws Mushy: no other work may depend on a
// design-role task (plan validation), so those finish alongside later stages. Fix-first work doesn't hold a
// stage either: it is ranked ahead of everything in every stage reached, and on 2026-10-25 one fix whose last
// attempt was the paused agent's held 472 tasks back for hours.
export function openStage(plan: Plan): Stage | undefined {
  const waiting = humanWaits(plan);
  const stages = stagesOf(plan);
  for (const s of stages) {
    const inStage = [...plan.tasks.values()].filter((t) => t.stage === s);
    if (inStage.some((t) => t.status !== 'done' && !waiting.has(t.id) && t.role !== 'design' && t.priority !== 'fix_first')) return s;
  }
  return stages.at(-1);
}

export function isUnblocked(plan: Plan, t: Task): boolean {
  return t.blocked_by.every((d) => plan.tasks.get(d)?.status === 'done' || plan.human.get(d)?.status === 'done');
}

// Counted attempts exclude what was not the code's fault: interruptions, and merge conflicts, where the work
// passed the gate and main moved under it. Conflicts have a cap of their own (limits.max_conflicts).
export function countedAttempts(t: Task, agent?: AgentName): number {
  return t.attempts.filter((a) => !UNCOUNTED_OUTCOMES.includes(a.outcome) && a.outcome !== 'conflict' && (!agent || a.agent === agent)).length;
}

export const conflictCount = (t: Task): number => t.attempts.filter((a) => a.outcome === 'conflict').length;

export function pick(input: PickInput): Task | undefined {
  const { plan, rank, agent, heldAreas, maxAttempts } = input;
  const stages = stagesOf(plan);
  const stageIdx = stageIndex(stages, openStage(plan));
  const other: AgentName = agent === 'claude' ? 'codex' : 'claude';
  for (const id of rank) {
    const t = plan.tasks.get(id);
    if (!t || t.status !== 'ready') continue;
    // Fix-first work may come from any stage already reached; feature work only from the open stage or earlier.
    if (stageIndex(stages, t.stage) > stageIdx) continue;
    if (!isUnblocked(plan, t)) continue;
    if (heldAreas.has(t.area)) continue;
    if (t.agent && t.agent !== agent) continue;
    // A task that failed twice with one agent goes to the other for its last attempt (§7.2),
    // unless it is pinned to this agent.
    const mine = countedAttempts(t, agent);
    const total = countedAttempts(t);
    if (!t.agent && total === maxAttempts - 1 && mine === total && mine > 0 && countedAttempts(t, other) === 0) continue;
    return t;
  }
  return undefined;
}

// The open tasks that are waiting on a person: needs_human or parked themselves, or blocked (directly or
// through other tasks) only by unfinished human tasks and such tasks. Memoised over the whole plan.
export function humanWaits(plan: Plan): Set<string> {
  const memo = new Map<string, boolean>();
  const visit = (t: Task, path: Set<string>): boolean => {
    const known = memo.get(t.id);
    if (known !== undefined) return known;
    if (path.has(t.id)) return false; // a cycle; validation reports it
    let result: boolean;
    if (t.status === 'needs_human' || t.status === 'parked') result = true;
    else {
      const blockers = t.blocked_by.filter((d) => plan.tasks.get(d)?.status !== 'done' && plan.human.get(d)?.status !== 'done');
      path.add(t.id);
      result = blockers.length > 0 && blockers.every((d) => plan.human.has(d) || (plan.tasks.has(d) && visit(plan.tasks.get(d)!, path)));
      path.delete(t.id);
    }
    memo.set(t.id, result);
    return result;
  };
  const out = new Set<string>();
  for (const t of plan.tasks.values()) if (t.status !== 'done' && visit(t, new Set())) out.add(t.id);
  return out;
}

// Every task left is waiting on a person.
export function onlyHumanWorkLeft(plan: Plan): boolean {
  const open = [...plan.tasks.values()].filter((t) => t.status !== 'done');
  if (open.length === 0) return false;
  const waiting = humanWaits(plan);
  return open.every((t) => waiting.has(t.id));
}
