import { membership, milestoneRank } from '../plan/milestones.ts';
import type { LoopMode, MapAgent, MapModel, MapNode, Plan } from '../types.ts';

// The dependency map (design doc §7.1): a DAG of every task and human task, with a forward pass
// for earliest start/finish, a backward pass for latest start/finish, slack, and the critical path.
// Times are hours of remaining work measured from `startAt` (now); done work takes no time.

export interface MapOptions {
  now: number;
  passHours: number; // hours one estimated pass is worth; replaced by the ledger's mean actual
  agents: MapAgent[];
  mode: LoopMode;
}

const EPS = 1e-6;

export function computeMap(plan: Plan, opts: MapOptions): MapModel {
  const nodes = new Map<string, MapNode>();
  const member = membership(plan);
  const milestoneTitle = new Map((plan.milestones ?? []).map((m) => [m.key, m.title]));
  for (const t of plan.tasks.values()) {
    const milestone = milestoneTitle.get(member.of.get(t.id) ?? '');
    const mergedBy = [...t.attempts].reverse().find((a) => a.outcome === 'merged')?.agent ?? null;
    nodes.set(t.id, {
      id: t.id,
      kind: 'task',
      lane: t.repo,
      title: t.title,
      ...(milestone ? { milestone } : {}),
      area: t.area,
      status: t.status,
      ...(t.summary ? { summary: t.summary } : {}),
      agent: t.claimed_by ?? mergedBy,
      reqs: t.reqs,
      blockedBy: t.blocked_by,
      dependents: [],
      durationHours: t.status === 'done' ? 0 : t.estimate_passes * opts.passHours,
      es: 0, ef: 0, ls: 0, lf: 0, slack: 0, critical: false,
    });
  }
  for (const h of plan.human.values()) {
    nodes.set(h.id, {
      id: h.id,
      kind: 'human',
      lane: 'human',
      title: h.title,
      status: h.status,
      agent: null,
      reqs: [],
      blockedBy: h.blocked_by,
      dependents: [],
      durationHours: h.status === 'done' ? 0 : h.lead_time_days * 24,
      es: 0, ef: 0, ls: 0, lf: 0, slack: 0, critical: false,
    });
  }
  for (const n of nodes.values()) {
    n.blockedBy = n.blockedBy.filter((d) => nodes.has(d));
    for (const d of n.blockedBy) nodes.get(d)!.dependents.push(n.id);
  }

  // The build: the loop never waits for a person (a task waiting on one is skipped until the person is
  // done), so a human step takes no time here and only passes its own blockers through. The build's
  // critical path, slack and finish are builder work alone; weeks of review lead time would otherwise
  // swamp every pass-sized difference the scheduler ranks on.
  const order = topoOrder(nodes);
  const buildHours = (n: MapNode) => (n.kind === 'task' ? n.durationHours : 0);
  for (const id of order) {
    const n = nodes.get(id)!;
    n.es = Math.max(0, ...n.blockedBy.map((d) => nodes.get(d)!.ef));
    n.ef = n.es + buildHours(n);
  }
  const finish = Math.max(0, ...[...nodes.values()].map((n) => n.ef));
  for (const id of [...order].reverse()) {
    const n = nodes.get(id)!;
    n.lf = Math.min(finish, ...n.dependents.map((d) => nodes.get(d)!.ls));
    n.ls = n.lf - buildHours(n);
    n.slack = Math.max(0, n.ls - n.es);
    n.critical = n.kind === 'task' && n.slack < EPS && n.status !== 'done' && n.durationHours > 0;
  }

  // The critical path: from the task finishing last, walk back through zero-slack blockers, passing
  // through human steps (which take no build time) to the tasks behind them.
  const criticalPath: string[] = [];
  const onPath = (d: MapNode, c: MapNode) => Math.abs(d.ef - c.es) < EPS && (d.critical || (d.kind === 'human' && d.slack < EPS));
  let cur = [...nodes.values()].filter((n) => n.critical).sort((a, b) => b.ef - a.ef)[0];
  while (cur) {
    if (cur.kind === 'task') criticalPath.unshift(cur.id);
    const c: MapNode = cur;
    cur = c.blockedBy
      .map((d) => nodes.get(d)!)
      .filter((d) => onPath(d, c))
      .sort((a, b) => b.durationHours - a.durationHours)[0];
  }

  // Human steps, with their lead times. A step that gates builder work, directly or through other
  // steps, must be done by the latest start of that work in the build above; one whose latest start
  // has passed holds that work up. A step that gates only the launch (reviews, going live) has no
  // build deadline, so it gets no latest start.
  for (const id of order) {
    const n = nodes.get(id)!;
    if (n.kind !== 'human') continue;
    n.es = Math.max(0, ...n.blockedBy.map((d) => nodes.get(d)!.ef));
    n.ef = n.es + n.durationHours;
  }
  for (const id of [...order].reverse()) {
    const n = nodes.get(id)!;
    if (n.kind !== 'human') continue;
    const due = Math.min(Infinity, ...n.dependents.map((d) => nodes.get(d)!).map((d) => (d.kind === 'task' || d.latestStart ? d.ls : Infinity)));
    if (due === Infinity) {
      n.ls = n.es;
      n.lf = n.ef;
      n.slack = 0;
      n.critical = false;
      continue;
    }
    n.lf = due;
    n.ls = n.lf - n.durationHours;
    n.slack = Math.max(0, n.ls - n.es);
    n.critical = n.status !== 'done' && n.durationHours > 0 && n.ls - n.es < EPS;
    n.latestStart = new Date(opts.now + n.ls * 3_600_000).toISOString();
  }
  // The longest chain through the people's side: the launch can't open before its last step is done.
  const humans = [...nodes.values()].filter((n) => n.kind === 'human' && n.status !== 'done');
  let last = humans.sort((a, b) => b.ef - a.ef)[0];
  const humanFinish = last ? new Date(opts.now + last.ef * 3_600_000).toISOString() : undefined;
  const humanPath: string[] = [];
  while (last) {
    humanPath.unshift(last.id);
    const c: MapNode = last;
    last = c.blockedBy.map((d) => nodes.get(d)!).filter((d) => d.status !== 'done' && Math.abs(d.ef - c.es) < EPS).sort((a, b) => b.durationHours - a.durationHours)[0];
  }

  const tasks = [...plan.tasks.values()];
  const count = (s: string) => tasks.filter((t) => t.status === s).length;
  const working = Math.max(1, opts.agents.filter((a) => a.state !== 'limited').length);
  const remaining = tasks.filter((t) => t.status !== 'done').reduce((h, t) => h + t.estimate_passes * opts.passHours, 0);
  const taskFinish = Math.max(
    ...[...nodes.values()].filter((n) => n.kind === 'task').map((n) => n.ef),
    remaining / working,
    0,
  );

  return {
    generatedAt: new Date(opts.now).toISOString(),
    startAt: new Date(opts.now).toISOString(),
    passHours: opts.passHours,
    nodes: order.map((id) => nodes.get(id)!),
    criticalPath,
    agents: opts.agents,
    mode: opts.mode,
    totals: {
      tasks: tasks.length,
      done: count('done'),
      ready: count('ready'),
      claimed: count('claimed'),
      needsHuman: count('needs_human'),
      parked: count('parked'),
    },
    projectedFinish: new Date(opts.now + taskFinish * 3_600_000).toISOString(),
    humanFinish,
    humanPath,
  };
}

function topoOrder(nodes: Map<string, MapNode>): string[] {
  const indeg = new Map<string, number>();
  for (const n of nodes.values()) indeg.set(n.id, n.blockedBy.length);
  const queue = [...nodes.values()].filter((n) => n.blockedBy.length === 0).map((n) => n.id).sort();
  const out: string[] = [];
  while (queue.length) {
    const id = queue.shift()!;
    out.push(id);
    for (const d of nodes.get(id)!.dependents) {
      const left = indeg.get(d)! - 1;
      indeg.set(d, left);
      if (left === 0) queue.push(d);
    }
  }
  if (out.length !== nodes.size) throw new Error('dependency map: the plan has a cycle; run `helix-loop validate`');
  return out;
}

// Scheduling rank (design doc §7.1), best first: fix-first, then the earliest milestone not yet reached (a task's
// milestone: one already reached has no open work), then the critical path, least slack, and the task that
// unblocks the most downstream work. Ties break on id so runs are reproducible.
export function rankTasks(model: MapModel, plan: Plan): string[] {
  const byId = new Map(model.nodes.map((n) => [n.id, n]));
  const downstream = new Map<string, number>();
  const countDown = (id: string): number => {
    const cached = downstream.get(id);
    if (cached !== undefined) return cached;
    const seen = new Set<string>();
    const stack = [...(byId.get(id)?.dependents ?? [])];
    while (stack.length) {
      const d = stack.pop()!;
      if (seen.has(d)) continue;
      seen.add(d);
      stack.push(...(byId.get(d)?.dependents ?? []));
    }
    downstream.set(id, seen.size);
    return seen.size;
  };
  const milestone = milestoneRank(plan);
  return [...plan.tasks.values()]
    .map((t) => {
      const n = byId.get(t.id)!;
      return { id: t.id, fix: t.priority === 'fix_first' ? 0 : 1, ms: milestone.get(t.id)!, crit: n.critical ? 0 : 1, slack: n.slack, down: countDown(t.id) };
    })
    .sort((a, b) => a.fix - b.fix || a.ms - b.ms || a.crit - b.crit || a.slack - b.slack || b.down - a.down || a.id.localeCompare(b.id))
    .map((r) => r.id);
}
