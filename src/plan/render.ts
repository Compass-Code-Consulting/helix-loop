import type { ProjectInfo } from '../config.ts';
import type { SpecIndex } from '../spec/index.ts';
import type { HumanTask, MapModel, Plan, Task } from '../types.ts';
import { membership, wiringOf } from './milestones.ts';
import type { Synthetic } from './requirements.ts';
import { tasksByStory, trailOf } from './taskset.ts';

// Renders the plan data into the two documents people read: the Implementation Plan, with the milestones in
// delivery order and then the scope as Lane › Epic › Feature › Story › Task, and the Human Implementation Plan for
// the owner. Generated after every plan change; never edited by hand.

const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\n+/g, ' ');
const passes = (ts: Task[]) => ts.reduce((s, t) => s + t.estimate_passes, 0);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const formats = (timeZone: string) => ({
  date: (iso: string) => new Date(iso).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone, timeZoneName: 'short' }),
  day: (iso: string) => new Date(iso).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', timeZone }),
});

// When each milestone was reached, or is projected to be (app/board.ts), for the plan's milestones section.
export type MilestoneDates = Map<string, { at?: number; reached: boolean }>;

export function renderImplementationPlan(plan: Plan, map: MapModel, index: SpecIndex, synthetic: Synthetic[], info: ProjectInfo, dates: MilestoneDates = new Map()): string {
  const { date, day } = formats(info.timezone);
  const tasks = [...plan.tasks.values()];
  const ts = plan.taskset;
  const byId = new Map(map.nodes.map((n) => [n.id, n]));
  const byStory = tasksByStory(plan);
  const done = (list: Task[]) => list.filter((t) => t.status === 'done').length;
  const member = membership(plan);
  const ms = plan.milestones ?? [];
  const msTitle = new Map(ms.map((m, i) => [m.key, `${i + 1}. ${m.title}`]));
  const wiring = wiringOf(plan);
  const order = (list: Task[]) => [...list].sort((a, b) => (byId.get(a.id)?.es ?? 0) - (byId.get(b.id)?.es ?? 0) || a.id.localeCompare(b.id));
  const ofFeature = (key: string) => (ts?.features.get(key)?.stories ?? []).flatMap((s) => byStory.get(s) ?? []);
  const ofEpic = (key: string) => (ts?.epics.get(key)?.features ?? []).flatMap(ofFeature);
  const ofLane = (keys: string[]) => keys.flatMap(ofEpic);
  const out: string[] = [];
  out.push(`# ${info.name} Implementation Plan`);
  out.push('');
  out.push(`Generated ${date(map.generatedAt)} from the plan data in \`.helix/plan/\`, against spec v${index.version}${ts ? `, TaskSet revision ${ts.revision}` : ''}.`);
  out.push('Never edit this file: change the TaskSet, the milestones and the task files, and regenerate it with `helix-loop plan render`.');
  out.push('');
  out.push('## Summary');
  out.push('');
  if (ts) out.push(`- **Tasks:** ${tasks.length} in ${plural(ts.lanes.length, 'lane')}, ${plural(ts.epics.size, 'epic')}, ${plural(ts.features.size, 'feature')} and ${plural(ts.stories.size, 'story', 'stories')}, estimated at ${passes(tasks)} passes.`);
  else out.push(`- **Tasks:** ${tasks.length}, estimated at ${passes(tasks)} passes, with no version 2 TaskSet: run \`helix-loop validate\`.`);
  out.push(`- **Status:** ${map.totals.done} done, ${map.totals.ready} ready, ${map.totals.claimed} in progress, ${map.totals.needsHuman} waiting on a person, ${map.totals.parked} parked.`);
  const next = ms.find((m) => !dates.get(m.key)?.reached);
  if (ms.length) out.push(`- **Milestones:** ${ms.length}, ${ms.filter((m) => dates.get(m.key)?.reached).length} reached${next ? `; next is ${next.title}${dates.get(next.key)?.at ? `, projected ${day(new Date(dates.get(next.key)!.at!).toISOString())}` : ''}` : ''}.`);
  else out.push('- **Milestones:** none yet. Plan them with the Helix skill (`/helix milestones`) and apply them with `helix-loop milestones apply`.');
  out.push(`- **Projected finish:** ${date(map.projectedFinish)}, at ${Math.round(map.passHours * 60)} minutes per pass with ${map.agents.length} agents.`);
  out.push(`- **Critical path:** ${map.criticalPath.length} steps; the full chain is listed at the end.`);
  const pinned = tasks.filter((t) => t.agent);
  if (pinned.length) out.push(`- **Pinned:** ${pinned.length} tasks run only on ${[...new Set(pinned.map((t) => `${t.agent}${t.role === 'design' ? ' in the design role' : ''}`))].join(' or ')}.`);
  out.push('');

  // The milestones, in delivery order.
  if (ms.length) {
    out.push('## Milestones');
    out.push('');
    out.push('The order the work is delivered in: each is a demoable outcome. Milestones are a priority, not a gate: the loop takes ready work in the earliest milestone not yet reached first, and later work when nothing earlier is ready. When a milestone is reached, each lane it touched is released.');
    out.push('');
    out.push('| Milestone | Tasks | Done | Passes | Reached or projected |');
    out.push('| --- | --- | --- | --- | --- |');
    for (const m of ms) {
      const list = (member.tasks.get(m.key) ?? []).map((id) => plan.tasks.get(id)!);
      const d = dates.get(m.key);
      out.push(`| ${cell(msTitle.get(m.key)!)} | ${list.length} | ${done(list)} | ${passes(list)} | ${d?.at ? `${d.reached ? 'reached' : 'projected'} ${day(new Date(d.at).toISOString())}` : '—'} |`);
    }
    out.push('');
    for (const m of ms) {
      const list = (member.tasks.get(m.key) ?? []).map((id) => plan.tasks.get(id)!);
      const d = dates.get(m.key);
      out.push(`### ${msTitle.get(m.key)}`);
      out.push('');
      out.push(`**Demo:** ${m.demo}`);
      out.push('');
      out.push(`${plural(list.length, 'task')}, ${done(list)} done, ${passes(list)} passes.${d?.at ? ` ${d.reached ? 'Reached' : 'Projected'} ${date(new Date(d.at).toISOString())}.` : ''}`);
      out.push('');
      if (m.features.length) out.push(`- **Features:** ${m.features.map((f) => `${ts?.features.get(f)?.title ?? f} (\`${f}\`)`).join(', ')}.`);
      if (m.stories.length) out.push(`- **Stories, from features placed later:** ${m.stories.map((s) => `${ts?.stories.get(s)?.title ?? s} (\`${s}\`)`).join(', ')}.`);
      if (m.tasks.length) out.push(`- **Tasks, from stories placed elsewhere:** ${m.tasks.map((id) => `${id} ${plan.tasks.get(id)?.title ?? ''}`.trim()).join('; ')}.`);
      const placeholders = list.filter((t) => t.placeholder_for?.length);
      for (const t of placeholders) out.push(`- **Placeholder:** ${t.id} is built before ${t.placeholder_for!.join(', ')}, against a placeholder; ${wiring.get(t.id)?.map((w) => `${w.id} wires it in${member.of.get(w.id) ? ` (${msTitle.get(member.of.get(w.id)!)})` : ''}`).join(', ') || 'nothing wires it in yet'}.`);
      for (const w of list.filter((t) => t.wires?.length)) out.push(`- **Wiring:** ${w.id} replaces the placeholder${w.wires!.length === 1 ? '' : 's'} in ${w.wires!.join(', ')} with the real ${w.wires!.flatMap((p) => plan.tasks.get(p)?.placeholder_for ?? []).join(', ')}.`);
      out.push('');
    }
  }

  // The scope, Lane › Epic › Feature › Story › Task.
  if (ts) {
    out.push('## Scope');
    out.push('');
    out.push('Lane › Epic › Feature › Story › Task, in the TaskSet\'s reading order. Within a story, tasks are listed in the order the dependency map can start them.');
    out.push('');
    out.push('| Lane | Epic | Features | Stories | Tasks | Done | Passes |');
    out.push('| --- | --- | --- | --- | --- | --- | --- |');
    for (const l of ts.lanes) {
      for (const k of l.epics) {
        const e = ts.epics.get(k)!;
        const list = ofEpic(k);
        out.push(`| ${l.key} | ${cell(e.title)} | ${e.features.length} | ${e.features.reduce((n, f) => n + (ts.features.get(f)?.stories.length ?? 0), 0)} | ${list.length} | ${done(list)} | ${passes(list)} |`);
      }
    }
    out.push(`| **Total** | | ${ts.features.size} | ${ts.stories.size} | ${tasks.length} | ${done(tasks)} | ${passes(tasks)} |`);
    out.push('');
    for (const l of ts.lanes) {
      const laneTasks = ofLane(l.epics);
      out.push(`## ${l.key}`);
      out.push('');
      out.push(`Builds \`${l.repo}\`: ${plural(l.epics.length, 'epic')}, ${plural(laneTasks.length, 'task')}, ${done(laneTasks)} done, ${passes(laneTasks)} passes.`);
      out.push('');
      for (const ek of l.epics) {
        const e = ts.epics.get(ek)!;
        out.push(`### ${e.title}`);
        out.push('');
        out.push(`${e.outcome} (\`${e.key}\`: ${plural(e.features.length, 'feature')}, ${done(ofEpic(ek))} of ${plural(ofEpic(ek).length, 'task')} done.)`);
        out.push('');
        for (const fk of e.features) {
          const f = ts.features.get(fk)!;
          out.push(`#### ${f.title}`);
          out.push('');
          out.push(`${f.capability ? `${f.capability} ` : ''}(\`${f.key}\`: ${plural(f.stories.length, 'story', 'stories')}, ${done(ofFeature(fk))} of ${plural(ofFeature(fk).length, 'task')} done.)`);
          out.push('');
          for (const sk of f.stories) {
            const st = ts.stories.get(sk)!;
            const rows = order(byStory.get(sk) ?? []);
            out.push(`##### ${st.title}`);
            out.push('');
            out.push(`${st.need} (\`${st.key}\`)`);
            out.push('');
            if (!rows.length) {
              out.push('No tasks yet.');
              out.push('');
              continue;
            }
            out.push('| Task | Title | Milestone | Requirements | Waits on | Passes | Status |');
            out.push('| --- | --- | --- | --- | --- | --- | --- |');
            for (const t of rows) out.push(taskRow(t));
            out.push('');
          }
        }
      }
    }
  }
  const stray = tasks.filter((t) => !ts?.stories.has(t.story));
  if (stray.length) {
    out.push('## Not in the TaskSet');
    out.push('');
    out.push('These tasks name a story the TaskSet does not declare; `helix-loop validate` reports each.');
    out.push('');
    out.push('| Task | Title | Milestone | Requirements | Waits on | Passes | Status |');
    out.push('| --- | --- | --- | --- | --- | --- | --- |');
    for (const t of order(stray)) out.push(taskRow(t));
    out.push('');
  }
  out.push('◆ marks a task on the critical path; ⧉ one built against a placeholder; ⇄ a task that wires one in.');
  out.push('');

  function taskRow(t: Task): string {
    const crit = byId.get(t.id)?.critical ? ' ◆' : '';
    const mark = t.placeholder_for?.length ? ` ⧉ (placeholder for ${t.placeholder_for.join(', ')})` : t.wires?.length ? ` ⇄ (wires ${t.wires.join(', ')})` : '';
    const who = t.agent ? ` (${t.agent}${t.role ? `, ${t.role}` : ''})` : '';
    const m = member.of.get(t.id);
    return `| ${t.id}${crit} | ${cell(t.title)}${who}${mark} | ${m ? cell(msTitle.get(m)!) : '—'} | ${t.reqs.join(', ')} | ${t.blocked_by.join(', ') || '—'} | ${t.estimate_passes} | ${t.status} |`;
  }

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
    const where = trailOf(ts, plan.tasks.get(id)?.story);
    out.push(`1. ${id} (${n.kind === 'human' ? 'human step' : where.story ? `${where.lane!.key} › ${where.feature!.title} › ${where.story.title}` : 'not in the TaskSet'}): ${n.title}`);
  }
  out.push('');
  return out.join('\n');
}

export function renderHumanPlan(plan: Plan, map: MapModel, info: ProjectInfo): string {
  const { date, day } = formats(info.timezone);
  const member = membership(plan);
  const msTitle = new Map((plan.milestones ?? []).map((m) => [m.key, m.title]));
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
  if (lateSteps.length) out.push(`- **Late for the build:** ${lateSteps.map((h) => h.id).join(', ')} gate builder tasks that could already run; until they're done those tasks wait, and the loop takes other work.`);
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
    if (b.length) out.push(`- **Blocks:** ${b.map((t) => `${t.id}${member.of.has(t.id) ? ` (${msTitle.get(member.of.get(t.id)!)})` : ''}`).join(', ')}.`);
    if (h.story && plan.taskset?.stories.has(h.story)) out.push(`- **Serves:** ${plan.taskset.stories.get(h.story)!.title} (\`${h.story}\`).`);
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
