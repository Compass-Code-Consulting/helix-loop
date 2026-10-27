import { stageIndex, stagesOf } from '../plan/stages.ts';
import type { Plan, Task } from '../types.ts';

// When each open task will run, as the loop would pick them (sched/scheduler.ts): best-ranked first, a stage
// only once the earlier stages are settled, never two passes in one area, never before its blockers. It is a
// simulation of the loop's choices with the slots it has now, not a promise: a failed attempt, a limit or a
// person's step moves it.
//
// Whatever waits on Daniel gets a date too, or most of the plan would have none (on 2026-10-27, four tasks that
// needed him held 208 of 416): a human task is done after its lead time from now (half of it once started), a
// task that needs him or is parked is handed back now. Home measures what an item costs by moving its date
// and running this again; code complete (board.ts) is this run with every human task done now.

const HOUR = 3_600_000;

export interface ProjectionInput {
  plan: Plan;
  rank: string[]; // map/graph.ts rankTasks, best first
  now: number;
  passHours: number;
  slots: number; // passes at once, across agents
  running: { task: string; startedAt: number }[];
  // When each open human task is done, and when each task that needs Daniel or is parked can run again.
  humanDone?: Map<string, number>;
  handedBack?: Map<string, number>;
  // Whether the finish waits for the human tasks too (project complete), or only for builder work (code
  // complete). On by default.
  withHuman?: boolean;
}

export interface Projected {
  start: number;
  end: number;
}

export interface Projection {
  tasks: Map<string, Projected>;
  human: Map<string, number>; // when each open human task is expected done
  finish: number; // when the last task ends: the last human task too, unless withHuman is off
}

export function expectedHumanDone(plan: Plan, now: number): Map<string, number> {
  const out = new Map<string, number>();
  for (const h of plan.human.values()) {
    if (h.status === 'done') continue;
    const days = h.status === 'in_progress' ? Math.max(0.5, h.lead_time_days / 2) : Math.max(0.25, h.lead_time_days);
    out.set(h.id, now + days * 24 * HOUR);
  }
  return out;
}

export function project(input: ProjectionInput): Projection {
  const { plan, rank, now, passHours, running } = input;
  const slots = Math.max(1, input.slots);
  const human = input.humanDone ?? expectedHumanDone(plan, now);
  const back = input.handedBack ?? new Map<string, number>();
  const dur = (t: Task) => Math.max(0.05, t.estimate_passes * passHours) * HOUR;
  const out = new Map<string, Projected>();
  const end = new Map<string, number>(); // when each task is done in the simulation; done tasks long ago
  for (const t of plan.tasks.values()) if (t.status === 'done') end.set(t.id, -Infinity);

  // Passes in flight hold their slots until their estimate runs out (or a little longer, if it already has).
  const active: { area: string; end: number }[] = [];
  for (const r of running) {
    const t = plan.tasks.get(r.task);
    if (!t || t.status === 'done' || out.has(t.id)) continue;
    const e = Math.max(r.startedAt + dur(t), now + 0.1 * HOUR);
    out.set(t.id, { start: r.startedAt, end: e });
    end.set(t.id, e);
    active.push({ area: t.area, end: e });
  }

  const order = [...plan.tasks.values()];
  const pending = new Set(order.filter((t) => t.status !== 'done' && !out.has(t.id)).map((t) => t.id));
  const availableAt = (t: Task) => (t.status === 'needs_human' || t.status === 'parked' ? (back.get(t.id) ?? now) : now);
  const blockerDone = (d: string, at: number): boolean => {
    const h = plan.human.get(d);
    if (h) return h.status === 'done' || (human.get(d) ?? Infinity) <= at;
    return (end.get(d) ?? Infinity) <= at;
  };
  // Settled for stage gating, as openStage: waiting on a person, itself or through what blocks it.
  const waitsOnPerson = (t: Task, at: number, seen = new Set<string>()): boolean => {
    if (seen.has(t.id)) return false;
    seen.add(t.id);
    if (availableAt(t) > at) return true;
    const open = t.blocked_by.filter((d) => !blockerDone(d, at));
    return open.length > 0 && open.every((d) => plan.human.has(d) || (pending.has(d) && waitsOnPerson(plan.tasks.get(d)!, at, seen)));
  };
  const stages = stagesOf(plan);
  const openStageAt = (at: number): number => {
    for (let s = 0; s < stages.length; s++) {
      for (const t of order) {
        if (t.stage !== stages[s] || t.role === 'design' || t.priority === 'fix_first') continue;
        if ((end.get(t.id) ?? Infinity) <= at) continue;
        if (!pending.has(t.id) || !waitsOnPerson(t, at)) return s;
      }
    }
    return Math.max(0, stages.length - 1);
  };

  const ranked = rank.filter((id) => pending.has(id));
  const wakes = [...human.values(), ...order.filter((t) => pending.has(t.id)).map(availableAt)];
  let t = now;
  let stage = openStageAt(t);
  for (let guard = 0; guard < 4 * order.length + wakes.length + 100 && ranked.length; guard++) {
    // Fill the free slots, best-ranked first.
    const held = new Set(active.map((a) => a.area));
    for (let i = 0; i < ranked.length && active.length < slots; i++) {
      const task = plan.tasks.get(ranked[i]!)!;
      if (stageIndex(stages, task.stage) > stage && task.priority !== 'fix_first') continue;
      if (held.has(task.area) || availableAt(task) > t) continue;
      if (!task.blocked_by.every((d) => blockerDone(d, t))) continue;
      const e = t + dur(task);
      out.set(task.id, { start: t, end: e });
      end.set(task.id, e);
      active.push({ area: task.area, end: e });
      held.add(task.area);
      pending.delete(task.id);
      ranked.splice(i--, 1);
    }
    // Then on to the next moment that frees a slot or unblocks a task.
    const next = Math.min(...active.map((a) => a.end), ...wakes.filter((x) => x > t));
    if (!isFinite(next)) break;
    t = next;
    for (let i = active.length - 1; i >= 0; i--) if (active[i]!.end <= t) active.splice(i, 1);
    stage = openStageAt(t);
  }
  // A human task no builder waits on (a launch step, a review) still ends the project: it starts once the
  // builder work it waits on is projected done, and takes its lead time from there.
  const humanEnd = (id: string, seen = new Set<string>()): number => {
    const h = plan.human.get(id);
    if (!h || h.status === 'done' || seen.has(id)) return now;
    seen.add(id);
    const after = Math.max(now, ...h.blocked_by.map((d) => (plan.human.has(d) ? humanEnd(d, seen) : (end.get(d) ?? now))));
    return Math.max(human.get(id) ?? now, after + ((human.get(id) ?? now) - now));
  };
  const builders = Math.max(now, ...[...out.values()].map((p) => p.end));
  const finish = input.withHuman === false ? builders : Math.max(builders, ...[...plan.human.keys()].map((id) => humanEnd(id)));
  return { tasks: out, human, finish };
}
