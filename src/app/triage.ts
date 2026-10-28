import type { Config } from '../config.ts';
import type { LedgerEvent } from '../ledger.ts';
import type { Plan } from '../types.ts';
import { dependentsOf, downstream, type Board } from './board.ts';
import { feedbackRule, reached, type HitlRecord, type Raised } from './hitl.ts';
import type { Incident } from './incidents.ts';

// Home's groups (spec §6.2): everything waiting on the owner, grouped by shared cause, never listed flat, and sorted
// by what each group holds up. Each group has one action; its members can be acted on together. Groups come
// from what can be known exactly (the same human task, failure, variable or requirement); Helix's names and
// merges arrive through the incidents.

export type GroupKind = 'your_tasks' | 'ask' | 'fix' | 'questions' | 'credential' | 'scope' | 'release' | 'milestone' | 'stopped' | 'resolved' | 'notices';

export const GROUP_LABEL: Record<GroupKind, string> = {
  your_tasks: 'your tasks',
  ask: 'Helix asks',
  fix: 'fix ready',
  questions: 'questions',
  credential: 'credential',
  scope: 'scope',
  release: 'release',
  milestone: 'milestone',
  stopped: 'needs you',
  resolved: 'resolved',
  notices: 'noise',
};

export interface GroupMember {
  id: string; // a task, a human task, a release (repo@tag), a record or a notice
  title: string;
  lane?: string;
  detail?: string; // the last error, the question, why it waits
  count?: number; // failures, reports
  late?: string; // "44 d late", "due Thu"
}

export interface Group {
  id: string; // stable: its kind and cause
  kind: GroupKind;
  title: string;
  cause: string;
  members: GroupMember[];
  held: number; // open tasks waiting on any member
  heldIds?: string[];
  critical: boolean; // a member is on the critical path, or late
  finishMs?: number; // filled in by the server: what leaving it costs on the projected finish
  action: { label: string; screen?: 'checklist' | 'ask' | 'answer' | 'fix' | 'secret' | 'splits' | 'diffs' | 'resolved'; op?: 'dismiss' | 'hand_back' };
  groupedBy: 'exact' | 'helix';
  incident?: string; // its incident's key
  lanes: string[];
  at?: string; // when the latest member arrived
}

export interface TriageInput {
  plan: Plan;
  board: Board;
  events: LedgerEvent[];
  incidents: Incident[];
  approvals: { repo: string; tag: string; paths: string[]; since: string; requestedAt: string }[];
  hitl: { records: HitlRecord[]; ratings: Map<string, { rating: string; at: string }>; raised: Raised[] };
  config: Config;
  dismissed: Set<string>;
  now: number;
}

const DAY = 86_400_000;
const lateText = (now: number, latest?: number) => {
  if (latest === undefined) return undefined;
  const d = Math.round((now - latest) / DAY);
  if (d > 0) return `${d} d late`;
  const day = new Date(latest).toLocaleDateString('en-US', { weekday: 'short' });
  return latest - now < DAY ? 'due today' : `due ${day}`;
};

export function triage(input: TriageInput): Group[] {
  const { plan, board, incidents, config, now } = input;
  const dependents = dependentsOf(plan);
  const heldBy = (ids: string[]) => {
    const all = new Set<string>();
    for (const id of ids) for (const d of downstream(plan, dependents, id)) all.add(d);
    return all;
  };
  const crit = new Set(board.criticalPath);
  const groups: Group[] = [];
  const covered = new Set<string>(); // tasks already in a group, so a stopped task shows once
  const make = (g: Omit<Group, 'held' | 'heldIds' | 'lanes' | 'critical'> & { critical?: boolean; holders?: string[] }) => {
    const held = heldBy(g.holders ?? g.members.map((m) => m.id));
    const { holders: _h, ...rest } = g;
    groups.push({ ...rest, held: held.size, heldIds: [...held].slice(0, 400), lanes: [...new Set(g.members.map((m) => m.lane).filter((x): x is string => !!x))], critical: g.critical ?? g.members.some((m) => crit.has(m.id)) });
  };
  const title = (id: string) => plan.tasks.get(id)?.title ?? plan.human.get(id)?.title ?? id;
  const lane = (id: string) => plan.tasks.get(id)?.repo;

  // Your tasks: human tasks that hold work and are late, on the critical path, or due within two days.
  const mine = board.human
    .filter((h) => h.status !== 'done' && h.held > 0 && (h.critical || h.late || (h.latestStart !== undefined && h.latestStart < now + 2 * DAY)))
    .sort((a, b) => b.held - a.held);
  if (mine.length) {
    make({
      id: 'your_tasks',
      kind: 'your_tasks',
      title: 'Human tasks on the critical path',
      cause: `${mine.slice(0, 3).map((h) => h.id).join(', ')}${mine.length > 3 ? ` and ${mine.length - 3} more` : ''}. Only you can do these.`,
      members: mine.map((h) => ({ id: h.id, title: h.title, detail: h.status === 'in_progress' ? 'in progress' : undefined, late: lateText(now, h.latestStart), count: h.held })),
      critical: mine.some((h) => h.late || h.critical),
      action: { label: 'Open checklist', screen: 'checklist' },
      groupedBy: 'exact',
    });
  }

  // What Helix brought to the owner instead of deciding, by the kind of request it named.
  const asked = new Map<string, Raised[]>();
  for (const r of input.hitl.raised) {
    if (r.answered || r.tasks.every((id) => plan.tasks.get(id)?.status === 'done')) continue;
    asked.set(r.name, [...(asked.get(r.name) ?? []), r]);
  }
  for (const [name, rs] of asked) {
    make({
      id: `ask:${name}`,
      kind: 'ask',
      title: rs.length === 1 ? rs[0]!.question : `${rs.length} requests: ${name}`,
      cause: rs.length === 1 ? (rs[0]!.why ?? name) : `Helix asks you each time; rate them to teach it.`,
      members: rs.map((r) => ({ id: r.id, title: r.question, detail: r.tasks.join(', '), lane: lane(r.tasks[0] ?? '') })),
      holders: rs.flatMap((r) => r.tasks),
      action: { label: rs.length === 1 ? 'Decide' : `Decide ${rs.length}`, screen: 'ask' },
      groupedBy: 'helix',
      at: rs.at(-1)!.at,
    });
    for (const r of rs) for (const id of r.tasks) covered.add(id);
  }

  // Incidents: a fix waiting for approval, questions one answer covers, a missing secret.
  for (const inc of incidents) {
    if (!inc.open) continue;
    const waiting = (id: string) => ['needs_human', 'parked'].includes(plan.tasks.get(id)?.status ?? '');
    let open = inc.members.filter((m) => plan.tasks.get(m.task)?.status !== 'done' && !covered.has(m.task));
    if (!open.length) continue;
    const members = open.map((m) => ({ id: m.task, title: title(m.task), lane: lane(m.task), detail: m.detail, count: m.count }));
    const base = { incident: inc.key, groupedBy: inc.groupedBy, members, at: inc.last } as const;
    if (inc.fix && !inc.decision) {
      make({ ...base, id: `fix:${inc.key}`, kind: 'fix', title: inc.title ?? inc.cause, cause: inc.fix.summary, action: { label: `Accept fix for ${members.length}`, screen: 'fix' } });
    } else if (inc.kind === 'spec_question') {
      make({ ...base, id: `q:${inc.key}`, kind: 'questions', title: inc.title ?? inc.cause, cause: members.length > 1 ? `One answer covers all ${members.length}.` : members[0]?.detail ?? '', action: { label: 'Answer once', screen: 'answer' } });
    } else if (inc.kind === 'credential_missing') {
      make({ ...base, id: `cred:${inc.key}`, kind: 'credential', title: inc.title ?? inc.cause, cause: `${members.length === 1 ? 'Its task stops' : `Every one of ${members.length} tasks stops`} at setup without it.`, action: { label: 'Add the secret', screen: 'secret' } });
    } else if (inc.kind === 'scope_grew') {
      continue; // with the tasks that grew, below
    } else {
      // Gate failures and the rest: raised when their feedback rule says so, unless Helix has them.
      const rule = feedbackRule(config, inc.kind, members[0]?.lane);
      if (rule.send_to === 'off' || !reached(rule, { onTask: Math.max(0, ...inc.members.map((m) => m.count)), tasks: inc.members.length })) continue;
      if (rule.send_to === 'helix' && config.helix?.monitor?.enabled) continue;
      if (!open.some((m) => waiting(m.task)) && inc.kind !== 'flaky_test' && inc.kind !== 'environment') continue;
      // Handing back is for tasks that wait for the owner; a shared failure shows every task it hit.
      if (inc.kind === 'gate_failure') {
        open = open.filter((m) => waiting(m.task));
        members.splice(0, members.length, ...members.filter((m) => waiting(m.id)));
      }
      const many = members.length > 1;
      make({
        ...base,
        id: `inc:${inc.key}`,
        kind: 'stopped',
        title: inc.title ?? (many ? `The same failure across ${members.length} tasks` : `${members[0]?.id} keeps failing`),
        cause: inc.filed ? `${inc.cause.slice(0, 140)} · the loop filed ${inc.filed} to fix it` : inc.cause.slice(0, 160),
        action: { label: `Hand back ${members.length}`, op: 'hand_back' },
      });
    }
    for (const m of open) covered.add(m.task);
  }

  // Tasks that grew past twice their estimate: passes that ran out of time, not passes that failed their gate
  // (a failure is the code's, and goes with its cause above).
  const grown = [...plan.tasks.values()].filter((t) => t.status !== 'done' && !covered.has(t.id) && t.attempts.filter((a) => a.outcome === 'timeout').length >= Math.max(2, Math.ceil(2 * t.estimate_passes)));
  const scopeReports = incidents.filter((i) => i.kind === 'scope_grew' && i.open).flatMap((i) => i.members.map((m) => m.task));
  const scoped = [...new Set([...grown.map((t) => t.id), ...scopeReports])].filter((id) => plan.tasks.get(id)?.status !== 'done');
  if (scoped.length) {
    make({
      id: 'scope',
      kind: 'scope',
      title: 'Tasks that grew past twice their estimate',
      cause: 'Each could be split into tasks that fit one pass.',
      members: scoped.map((id) => {
        const t = plan.tasks.get(id)!;
        return { id, title: t.title, lane: t.repo, detail: `${t.attempts.filter((a) => a.outcome === 'timeout').length} passes ran out of time; estimate ${t.estimate_passes}`, count: t.attempts.length };
      }),
      action: { label: 'Review splits', screen: 'splits' },
      groupedBy: 'exact',
    });
    for (const id of scoped) covered.add(id);
  }

  // Tasks stopped for a person that no group above covers, by why they stopped.
  const stopped = [...plan.tasks.values()].filter((t) => (t.status === 'needs_human' || t.status === 'parked') && !covered.has(t.id));
  const byWhy = new Map<string, typeof stopped>();
  for (const t of stopped) {
    const last = t.attempts.at(-1);
    const why = t.status === 'parked' ? 'Parked' : last?.outcome === 'conflict' ? 'Merge conflicts kept stopping these' : last ? `Stopped after ${t.attempts.length} attempts: ${last.outcome.replace(/_/g, ' ')}` : 'Waiting for you';
    const l = byWhy.get(why) ?? [];
    l.push(t);
    byWhy.set(why, l);
  }
  for (const [why, ts] of byWhy) {
    make({
      id: `stopped:${why}`,
      kind: 'stopped',
      title: ts.length === 1 ? `${ts[0]!.id} ${ts[0]!.status === 'parked' ? 'is parked' : 'needs you'}` : `${ts.length} tasks ${why === 'Parked' ? 'are parked' : 'need you'}`,
      cause: ts.length === 1 ? (ts[0]!.summary ?? why) : why,
      members: ts.map((t) => ({ id: t.id, title: t.title, lane: t.repo, detail: t.summary ?? t.attempts.at(-1)?.note?.split('\n')[0], count: t.attempts.length })),
      action: { label: ts.length === 1 ? 'Hand back' : `Hand back ${ts.length}`, op: 'hand_back' },
      groupedBy: 'exact',
    });
  }

  // Releases waiting for approval.
  if (input.approvals.length) {
    make({
      id: 'release',
      kind: 'release',
      title: 'Releases waiting for approval',
      cause: `${input.approvals.map((a) => `${a.repo} ${a.tag}`).join(' and ')} change${input.approvals.length === 1 ? 's' : ''} ${[...new Set(input.approvals.flatMap((a) => a.paths.map((p) => `${p.split('/')[0]}/`)))].slice(0, 3).join(' and ')}.`,
      members: input.approvals.map((a) => ({ id: `${a.repo}@${a.tag}`, title: `${a.repo} ${a.tag}`, lane: a.repo, detail: `${a.paths.length} reviewed files since ${a.since}` })),
      holders: [],
      critical: false,
      action: { label: 'Review diffs', screen: 'diffs' },
      groupedBy: 'exact',
    });
  }

  // Milestones the loop reached, each once, until the owner has reviewed its demo; not those already reached when
  // their milestones were applied.
  const reachedAt = new Map<string, Extract<LedgerEvent, { kind: 'milestone' }>>();
  for (const e of input.events) if (e.kind === 'milestone' && !e.already) reachedAt.set(e.key, e);
  for (const e of reachedAt.values()) {
    const id = `milestone:${e.key}:${e.at}`;
    if (input.dismissed.has(id)) continue;
    make({
      id,
      kind: 'milestone',
      title: `Milestone reached: ${e.title}`,
      cause: `Review it: ${e.demo}`,
      members: [{ id, title: e.title, detail: `Released ${e.repos.join(', ') || 'nothing new'}` }],
      holders: [],
      critical: false,
      action: { label: 'Reviewed', op: 'dismiss' },
      groupedBy: 'exact',
      at: e.at,
    });
  }

  // What Helix resolved on the owner's behalf, not yet reviewed.
  const unrated = input.hitl.records.filter((r) => !input.hitl.ratings.has(r.id));
  if (unrated.length) {
    const unsure = unrated.filter((r) => r.confidence < 0.7).length;
    make({
      id: 'resolved',
      kind: 'resolved',
      title: 'HITL requests Helix resolved on Auto-pilot',
      cause: `What Active pilot · ${unrated[0]!.compared} would have asked, and how each was resolved.${unsure ? ` ${unsure} unsure.` : ''}`,
      members: unrated.map((r) => ({ id: r.id, title: r.chose, detail: r.question })),
      holders: [],
      critical: false,
      action: { label: unsure ? `Review unsure ${unsure}` : 'Review', screen: 'resolved' },
      groupedBy: 'exact',
    });
  }

  // Low-impact notices: the loop's warnings of the last day, other than the fixes it filed.
  const notices = input.events
    .map((e, i) => ({ e, i }))
    .filter(({ e }) => e.kind === 'warning' && now - Date.parse(e.at) < DAY && !e.detail.startsWith('filed '))
    .filter(({ i }) => !input.dismissed.has(`warning:${i}`));
  if (notices.length) {
    make({
      id: 'notices',
      kind: 'notices',
      title: 'Low-impact notices',
      cause: 'Warnings from the loop: slow steps, retried conflicts, one-offs.',
      members: notices.map(({ e, i }) => ({ id: `warning:${i}`, title: (e as { detail: string }).detail.split('\n')[0]!.slice(0, 160), detail: (e as { task?: string }).task })),
      holders: [],
      critical: false,
      action: { label: 'Dismiss all', op: 'dismiss' },
      groupedBy: 'exact',
    });
  }

  return groups.filter((g) => g.members.length && !input.dismissed.has(`group:${g.id}:${g.members.length}`));
}

const ORDER: GroupKind[] = ['your_tasks', 'ask', 'fix', 'stopped', 'questions', 'credential', 'scope', 'release', 'milestone', 'resolved', 'notices'];
// By cost of delay: what each holds up, the critical ones first among equals; noise and records last.
export function sortGroups(groups: Group[]): Group[] {
  const tail = (g: Group) => (g.kind === 'resolved' || g.kind === 'notices' ? 1 : 0);
  return [...groups].sort((a, b) => tail(a) - tail(b) || (b.finishMs ?? 0) - (a.finishMs ?? 0) || b.held - a.held || Number(b.critical) - Number(a.critical) || ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind));
}
