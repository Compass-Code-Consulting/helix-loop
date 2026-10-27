import type { TaskSet } from '../app/taskset.ts';
import type { ProjectInfo } from '../config.ts';
import type { SpecIndex } from '../spec/index.ts';
import type { HumanTask, MapModel, Plan, Task } from '../types.ts';
import { stageIndex, stagesOf, stageTitle } from './stages.ts';
import type { Synthetic } from './requirements.ts';

// Renders the plan data into the two documents people read: the Implementation Plan, Lane › Epic › Task as the
// TaskSet orders them, and the Human Implementation Plan for the owner. Generated after every plan change; never
// edited by hand.

const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\n+/g, ' ');
const passes = (ts: Task[]) => ts.reduce((s, t) => s + t.estimate_passes, 0);
const formats = (timeZone: string) => ({
  date: (iso: string) => new Date(iso).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone, timeZoneName: 'short' }),
  day: (iso: string) => new Date(iso).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', timeZone }),
});

// The stages an epic's tasks fall in, as "Day 1–Day 3" or "Day 2"; nothing for a plan without stages.
function stageSpan(plan: Plan, tasks: Task[]): string {
  const stages = stagesOf(plan);
  const at = [...new Set(tasks.filter((t) => t.stage).map((t) => stageIndex(stages, t.stage)))].sort((a, b) => a - b);
  if (!at.length) return '';
  const label = (i: number) => stageTitle(plan, stages[i]!).split(':')[0]!;
  return at.length === 1 ? label(at[0]!) : `${label(at[0]!)}–${label(at.at(-1)!)}`;
}

export function renderImplementationPlan(plan: Plan, map: MapModel, index: SpecIndex, synthetic: Synthetic[], taskset: TaskSet, info: ProjectInfo): string {
  const { date } = formats(info.timezone);
  const tasks = [...plan.tasks.values()];
  const byId = new Map(map.nodes.map((n) => [n.id, n]));
  const epicTasks = (ids: string[]) => ids.map((id) => plan.tasks.get(id)).filter((t): t is Task => !!t);
  const done = (ts: Task[]) => ts.filter((t) => t.status === 'done').length;
  const hasStages = stagesOf(plan).length > 0;
  const out: string[] = [];
  out.push(`# ${info.name} Implementation Plan`);
  out.push('');
  out.push(`Generated ${date(map.generatedAt)} from the plan data in \`.helix/plan/\`, against spec v${index.version}.`);
  out.push('Never edit this file: change the TaskSet and the task files, and regenerate it with `helix-loop plan render`.');
  out.push('');
  out.push('## Summary');
  out.push('');
  out.push(`- **Tasks:** ${tasks.length} in ${taskset.lanes.length} lane${taskset.lanes.length === 1 ? '' : 's'} and ${taskset.lanes.reduce((n, l) => n + l.epics.length, 0)} epics, estimated at ${passes(tasks)} passes.`);
  out.push(`- **Status:** ${map.totals.done} done, ${map.totals.ready} ready, ${map.totals.claimed} in progress, ${map.totals.needsHuman} waiting on a person, ${map.totals.parked} parked.`);
  out.push(`- **Projected finish:** ${date(map.projectedFinish)}, at ${Math.round(map.passHours * 60)} minutes per pass with ${map.agents.length} agents.`);
  out.push(`- **Critical path:** ${map.criticalPath.length} steps; the full chain is listed at the end.`);
  const pinned = tasks.filter((t) => t.agent);
  if (pinned.length) out.push(`- **Pinned:** ${pinned.length} tasks run only on ${[...new Set(pinned.map((t) => `${t.agent}${t.role === 'design' ? ' in the design role' : ''}`))].join(' or ')}.`);
  if (taskset.derived) out.push('- **Epics:** derived from each task\'s feature, since the plan has no `taskset.yaml` yet (`helix-loop taskset init` writes one).');
  out.push('');
  if (hasStages) {
    out.push('Each task also belongs to a stage. A stage opens when every task in earlier stages is done, waiting on a person, or design work; inside the open stages the loop runs the critical path first.');
    out.push('');
  }
  out.push(`| Lane | Epic | Tasks | Done | Passes |${hasStages ? ' Stages |' : ''}`);
  out.push(`| --- | --- | --- | --- | --- |${hasStages ? ' --- |' : ''}`);
  for (const l of taskset.lanes) {
    for (const e of l.epics) {
      const ts = epicTasks(e.tasks);
      if (!ts.length) continue;
      out.push(`| ${l.name} | ${cell(e.title)} | ${ts.length} | ${done(ts)} | ${passes(ts)} |${hasStages ? ` ${stageSpan(plan, ts)} |` : ''}`);
    }
  }
  out.push(`| **Total** | | ${tasks.length} | ${done(tasks)} | ${passes(tasks)} |${hasStages ? ' |' : ''}`);
  out.push('');
  for (const l of taskset.lanes) {
    const laneTasks = l.epics.flatMap((e) => epicTasks(e.tasks));
    if (!laneTasks.length) continue;
    out.push(`## ${l.name}`);
    out.push('');
    out.push(`${laneTasks.length} tasks in ${l.epics.length} epics, ${done(laneTasks)} done, ${passes(laneTasks)} passes.`);
    out.push('');
    for (const e of l.epics) {
      const rows = epicTasks(e.tasks).sort((a, b) => (byId.get(a.id)?.es ?? 0) - (byId.get(b.id)?.es ?? 0) || a.id.localeCompare(b.id));
      if (!rows.length) continue;
      const span = stageSpan(plan, rows);
      out.push(`### ${e.title}`);
      out.push('');
      out.push(`${rows.length} tasks, ${done(rows)} done, ${passes(rows)} passes${span ? `, in ${span}` : ''}.`);
      out.push('');
      out.push(`| Task | Title |${hasStages ? ' Stage |' : ''} Requirements | Waits on | Passes | Status |`);
      out.push(`| --- | --- |${hasStages ? ' --- |' : ''} --- | --- | --- | --- |`);
      for (const t of rows) {
        const crit = byId.get(t.id)?.critical ? ' ◆' : '';
        const who = t.agent ? ` (${t.agent}${t.role ? `, ${t.role}` : ''})` : '';
        const stage = hasStages ? ` ${t.stage ? stageTitle(plan, t.stage).split(':')[0] : '—'} |` : '';
        out.push(`| ${t.id}${crit} | ${cell(t.title)}${who} |${stage} ${t.reqs.join(', ')} | ${t.blocked_by.join(', ') || '—'} | ${t.estimate_passes} | ${t.status} |`);
      }
      out.push('');
    }
  }
  out.push('◆ marks a task on the critical path.');
  out.push('');
  out.push('## Requirement coverage');
  out.push('');
  out.push('Every requirement in the spec and every synthetic requirement, with the tasks that deliver it.');
  out.push('');
  const claim = new Map<string, string[]>();
  for (const t of tasks) for (const r of t.reqs) claim.set(r, [...(claim.get(r) ?? []), t.id]);
  const ids = [...Object.keys(index.reqs), ...synthetic.map((x) => x.id)];
  const titles = new Map(synthetic.map((x) => [x.id, x.title]));
  out.push('| Requirement | Delivered by |');
  out.push('| --- | --- |');
  for (const id of ids.sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))) {
    out.push(`| ${id}${titles.has(id) ? ` (${cell(titles.get(id)!)})` : ''} | ${(claim.get(id) ?? ['— not planned']).join(', ')} |`);
  }
  out.push('');
  out.push('## Critical path');
  out.push('');
  for (const id of map.criticalPath) {
    const n = byId.get(id)!;
    const e = taskset.epicOf.get(id);
    out.push(`1. ${id} (${n.kind === 'human' ? 'human step' : `${e ? `${e.lane} › ${e.title}` : 'no epic'}`}): ${n.title}`);
  }
  out.push('');
  return out.join('\n');
}

export function renderHumanPlan(plan: Plan, map: MapModel, info: ProjectInfo): string {
  const { date, day } = formats(info.timezone);
  const byId = new Map(map.nodes.map((n) => [n.id, n]));
  const isDone = (id: string) => (plan.tasks.get(id)?.status ?? plan.human.get(id)?.status) === 'done';
  const waitsOn = (h: HumanTask) => h.blocked_by.filter((d) => !isDone(d));
  // Only steps that gate builder work have a start-by date; those that gate only the launch don't.
  const startBy = (h: HumanTask) => byId.get(h.id)?.latestStart;
  const late = (h: HumanTask) => h.status !== 'done' && (startBy(h) ?? '9999') <= map.generatedAt;
  const launchPath = new Set((map.humanPath ?? []).filter((id) => plan.human.has(id)));
  const blocks = new Map<string, Task[]>();
  for (const t of plan.tasks.values()) for (const d of t.blocked_by) if (plan.human.has(d)) blocks.set(d, [...(blocks.get(d) ?? []), t]);
  const byLead = (a: HumanTask, b: HumanTask) => b.lead_time_days - a.lead_time_days || a.id.localeCompare(b.id, 'en', { numeric: true });
  const order = (a: HumanTask, b: HumanTask) => {
    const sa = startBy(a);
    const sb = startBy(b);
    if (sa && sb) return sa.localeCompare(sb) || byLead(a, b);
    return sa ? -1 : sb ? 1 : byLead(a, b);
  };
  const all = [...plan.human.values()];
  const fastFollow = all.filter((h) => h.status !== 'done' && h.title.startsWith('Fast follow')).sort(order);
  const launch = all.filter((h) => h.status !== 'done' && !h.title.startsWith('Fast follow'));
  const now = launch.filter((h) => !waitsOn(h).length).sort(order);
  const later = launch.filter((h) => waitsOn(h).length).sort(order);
  const done = all.filter((h) => h.status === 'done').sort((a, b) => a.id.localeCompare(b.id, 'en', { numeric: true }));
  const startCell = (h: HumanTask) => {
    const s = startBy(h);
    if (!s || h.status === 'done') return '—';
    return late(h) ? `now (was due ${day(s)})` : day(s);
  };
  const blocksCell = (h: HumanTask) => {
    const b = blocks.get(h.id) ?? [];
    return b.length ? `${b.length} task${b.length === 1 ? '' : 's'}` : '—';
  };
  const out: string[] = [];
  out.push(`# ${info.name} Human Implementation Plan`);
  out.push('');
  out.push(`Generated ${date(map.generatedAt)} from the plan data in \`.helix/plan/human/\`.`);
  out.push(`These are the steps only ${info.owner} can do, sign or pay for.`);
  out.push('Never edit this file: change the files in `.helix/plan/human/` and regenerate it with `helix-loop plan render`.');
  out.push('');
  out.push('## Summary');
  out.push('');
  out.push(`- **Steps:** ${all.length}: ${all.filter((h) => h.status === 'todo').length} to do, ${all.filter((h) => h.status === 'in_progress').length} in progress, ${done.length} done; ${fastFollow.length} of the open ones are for the fast follow.`);
  out.push(`- **Start now:** ${now.length} steps wait on nothing else.`);
  const lateSteps = launch.filter(late);
  if (lateSteps.length) out.push(`- **Late for the build:** ${lateSteps.map((h) => h.id).join(', ')} gate builder tasks that could already run; until they're done those tasks wait (they never hold a stage).`);
  if (map.humanFinish && launchPath.size) {
    out.push(`- **Last human step done:** no earlier than ${day(map.humanFinish)} at the lead times planned here, set by ${[...launchPath].join(' → ')}.`);
  }
  out.push('- **Start by** is the latest start that doesn\'t hold up the builder tasks waiting on the step. Steps that gate only the launch have no build deadline: start the long ones first.');
  out.push('');
  const table = (title: string, intro: string, rows: HumanTask[], withWaits: boolean) => {
    if (!rows.length) return;
    out.push(`## ${title}`);
    out.push('');
    out.push(intro);
    out.push('');
    out.push(`| Step | What | Status | Lead time | Start by | ${withWaits ? 'Waits on | ' : ''}Blocks |`);
    out.push(`| --- | --- | --- | --- | --- | ${withWaits ? '--- | ' : ''}--- |`);
    for (const h of rows) {
      out.push(`| ${h.id}${launchPath.has(h.id) ? ' ◆' : ''} | ${cell(h.title)} | ${h.status} | ${h.lead_time_days} d | ${startCell(h)} | ${withWaits ? `${waitsOn(h).join(', ')} | ` : ''}${blocksCell(h)} |`);
    }
    out.push('');
  };
  table('Start now', 'Nothing else has to happen first: steps the build is waiting on first, then the longest lead times.', now, false);
  table('Later', 'Each waits on the steps or tasks named, in the same order.', later, true);
  table('Fast follow', 'After launch, with staging and the support system.', fastFollow, true);
  if (done.length) {
    out.push('## Done');
    out.push('');
    for (const h of done) out.push(`- ${h.id}: ${h.title}`);
    out.push('');
  }
  out.push('◆ marks a step on the chain that finishes last: any delay to it moves the last human step.');
  out.push('');
  out.push('## Every step in detail');
  out.push('');
  for (const h of [...now, ...later, ...fastFollow, ...done]) {
    out.push(`### ${h.id}: ${h.title}`);
    out.push('');
    out.push(`- **Done when:** ${h.done_check}`);
    out.push(`- **Status:** ${h.status}. **Lead time:** ${h.lead_time_days} days.${byId.get(h.id)?.latestStart && h.status !== 'done' ? ` **Start by:** ${startCell(h)}.` : ''}`);
    out.push(`- **Agent can help:** ${h.agent_can_help}.`);
    if (h.blocked_by.length) out.push(`- **Waits on:** ${h.blocked_by.map((d) => `${d}${isDone(d) ? ' (done)' : ''}`).join(', ')}.`);
    const b = blocks.get(h.id) ?? [];
    if (b.length) out.push(`- **Blocks:** ${b.map((t) => `${t.id}${t.stage ? ` (${stageTitle(plan, t.stage)})` : ''}`).join(', ')}.`);
    if (h.tools?.length) out.push(`- **Tools:** ${h.tools.join(', ')}.`);
    if (h.secrets?.length) out.push(`- **Credentials:** ${h.secrets.map((s) => `${s.name}, kept in ${s.stored_in}`).join('; ')}.`);
    if (h.handoff_prompt) {
      out.push('');
      out.push(`Hand-off prompt for ${info.owner}'s agent:`);
      out.push('');
      out.push('```text');
      out.push(h.handoff_prompt.trim());
      out.push('```');
    }
    out.push('');
  }
  return out.join('\n');
}

export type { HumanTask };
