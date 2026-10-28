import { readChanges, UNDO_MS } from '../../app/changes.ts';
import { readHitl } from '../../app/hitl.ts';
import type { Incident, PlanChange } from '../../app/incidents.ts';
import { loadSettings } from '../../app/settings.ts';
import { snapshot } from '../../app/state.ts';
import { GROUP_LABEL, type Group } from '../../app/triage.ts';
import { buildView } from '../../app/views.ts';
import { loadConfig, paths } from '../../config.ts';
import { AGENTS } from '../../types.ts';
import * as ops from '../../ops/index.ts';
import { withCli } from '../../ops/actor.ts';
import { define, str, UsageError } from '../command.ts';
import { ago, confirm, duration, fit, json, plural, table, timeZone, undoHint, wrap, YES } from '../output.ts';
import { when } from '../shared.ts';

// What waits on the owner, as Home shows it (spec §6.2): everything grouped by shared cause and sorted by what each
// group holds up, each with the command that acts on it; the incidents behind the groups and Helix's fixes for
// them, the requests Helix raised, and the undo list.

// An incident as a command names it: its fix's id when it has one (keys hold a failing test's title).
const refOf = (i: Incident) => (i.fix && !i.decision ? i.fix.id : i.key);
const quote = (s: string) => (/^[\w:.@/-]+$/.test(s) ? s : `'${s.replace(/'/g, "'\\''")}'`);

// The command that acts on a group, as its one action on Home does.
function actionFor(g: Group, incidents: Incident[]): string {
  const ids = g.members.map((m) => m.id);
  const inc = g.incident ? incidents.find((i) => i.key === g.incident) : undefined;
  switch (g.kind) {
    case 'your_tasks':
      return `helix-loop human ${ids[0]}`;
    case 'ask':
      return `helix-loop asks, then helix-loop ask decide ${ids[0]} <option>`;
    case 'fix':
      return inc ? `helix-loop incident ${quote(refOf(inc))}, then helix-loop fix accept ${quote(refOf(inc))}` : 'helix-loop incidents';
    case 'questions':
      return `helix-loop answer ${quote(inc ? refOf(inc) : g.incident ?? '')} "<${ids.length > 1 ? `one answer for all ${ids.length}` : 'your answer'}>"`;
    case 'credential':
      return `helix-loop secret set ${g.incident?.replace(/^cred:/, '') ?? '<NAME>'}`;
    case 'scope':
      return `helix-loop task ${ids[0]} (split it with Helix: helix-loop ask "split ${ids[0]}")`;
    case 'release':
      return ids.map((id) => `helix-loop release approve ${id.replace('@', ' ')}`).join('; ');
    case 'stopped':
      return `helix-loop task hand-back ${ids.slice(0, 6).join(' ')}${ids.length > 6 ? ' …' : ''} --note "…"`;
    case 'resolved':
      return 'rate them in the app: Home › resolved';
    default:
      return '';
  }
}

const inbox = define({
  name: 'inbox',
  group: 'What waits on you',
  summary: 'What waits on you, grouped by cause as Home groups it, each with its command',
  description: `Home, in the terminal: what waits on you, grouped by shared cause, the group that costs the finish most first.
Each group shows how many builder tasks it holds up, its members, and the command that acts on it.
The loop's low-impact notices come last, as a count; --all lists them.`,
  options: { all: { type: 'boolean', description: 'List the notices too' } },
  json: true,
  async run(ctx) {
    const { root } = ctx;
    await ops.landNotes(root, withCli(root));
    const v = buildView(root, snapshot(root), loadConfig(root), { dismissed: new Set(loadSettings(paths(root).appSettings).dismissed) });
    if (ctx.json) return json(ctx, v.groups.map((g) => ({ ...g, command: actionFor(g, v.incidents) })));
    const groups = v.groups;
    if (!groups.length) return ctx.out('Nothing waits on you.');
    const real = groups.filter((g) => g.kind !== 'notices');
    const held = new Set(real.flatMap((g) => g.heldIds ?? [])).size;
    ctx.out(`${plural(real.length, 'group')} wait${real.length === 1 ? 's' : ''} on you${held ? `, holding up ${plural(held, 'task')}` : ''}.`);
    let n = 0;
    for (const g of groups) {
      if (g.kind === 'notices' && !ctx.opts.all) {
        ctx.out('');
        ctx.out(`${plural(g.members.length, 'notice')} from the loop (slow steps, retried conflicts): helix-loop inbox --all`);
        continue;
      }
      ctx.out('');
      const cost = [g.held ? `holds ${plural(g.held, 'task')}` : '', g.finishMs && g.finishMs > 3_600_000 ? `costs the finish ${duration(g.finishMs)}` : '', g.critical ? 'critical' : ''].filter(Boolean).join(' · ');
      ctx.out(`${++n}. ${GROUP_LABEL[g.kind]} · ${fit(g.title, 70)}${cost ? `  (${cost})` : ''}`);
      if (g.cause && g.cause !== g.title) for (const l of wrap(fit(g.cause, 300), 3)) ctx.out(l);
      for (const l of table(g.members.slice(0, 5).map((m) => [`   ${m.id}`, m.late ?? (m.count && m.count > 1 ? `${m.count}×` : ''), m.detail && m.detail !== m.title ? `${m.title} · ${m.detail}` : m.title]))) ctx.out(l);
      if (g.members.length > 5) ctx.out(`   … and ${g.members.length - 5} more`);
      const act = actionFor(g, v.incidents);
      if (act) ctx.out(`   → ${act}`);
    }
  },
});

function changeLine(c: PlanChange): string {
  switch (c.op) {
    case 'hand_back':
      return `hand back ${c.task}${c.note ? `, noting: ${fit(c.note, 60)}` : ''}`;
    case 'park':
      return `park ${c.task}${c.note ? `, noting: ${fit(c.note, 60)}` : ''}`;
    case 'note':
      return `note on ${c.task}: ${fit(c.note, 70)}`;
    case 'add_dep':
      return `${c.task} waits on ${c.on}`;
    case 'remove_dep':
      return `${c.task} no longer waits on ${c.on}`;
    case 'new_task':
      return `new task${c.ref ? ` (${c.ref})` : ''}: ${fit(String(c.task.title ?? ''), 60)}${c.task.repo ? ` in ${String(c.task.repo)}` : ''}`;
    case 'pause':
      return 'pause the loop';
  }
}

const incidents = define({
  name: 'incidents',
  group: 'What waits on you',
  summary: 'Failures with one cause, grouped, and the fixes Helix proposed',
  description: `Lists the open incidents of the last week: builder feedback and gate failures with one cause, grouped exactly or by Helix.
Each shows its fix when Helix proposed one; accept it with \`helix-loop fix accept\`.`,
  options: { all: { type: 'boolean', description: 'Closed ones too: every task they held is done' } },
  json: true,
  run(ctx) {
    const list = ops.incidentsNow(ctx.root).filter((i) => ctx.opts.all || i.open);
    if (ctx.json) return json(ctx, list);
    if (!list.length) return ctx.out('No open incident.');
    for (const i of list) {
      ctx.out(`${fit(i.key, 60)}  ${i.kind.replace(/_/g, ' ')} · ${plural(i.members.length, 'task')} · ${plural(i.failures, 'time')} · last ${ago(Date.parse(i.last))}`);
      if (i.title && i.title !== i.key) ctx.out(`  ${fit(i.title, 96)}`);
      if (i.fix) ctx.out(`  fix ${i.fix.id} (${Math.round(i.fix.confidence * 100)}% sure): ${fit(i.fix.summary, 70)}${i.decision ? ` [${i.decision.decision}]` : ''}`);
      if (i.filed) ctx.out(`  the loop filed ${i.filed} to fix it`);
    }
    ctx.out('');
    ctx.out('Show one: helix-loop incident <key or fix id>');
  },
});

const incident = define({
  name: 'incident',
  group: 'What waits on you',
  summary: 'One incident: its cause, the tasks it hit, its fix and the evidence',
  args: [{ name: 'ref', description: "The incident's key, its fix's id (F-3), or the start of its key" }],
  json: true,
  run(ctx) {
    const i = ops.findIncident(ops.incidentsNow(ctx.root), ctx.args[0]!);
    const latest = [...i.members].filter((m) => m.log).sort((a, b) => b.last.localeCompare(a.last))[0];
    const tail = latest?.log ? ops.gateTail(ctx.root, latest.log, 20) : '';
    if (ctx.json) return json(ctx, { ...i, lastOutput: latest?.log ? { task: latest.task, attempt: latest.attempt, text: tail } : undefined });
    const tz = timeZone(ctx.root);
    ctx.out(`${i.title ?? i.cause}`);
    ctx.out(`${i.kind.replace(/_/g, ' ')} · ${i.open ? 'open' : 'closed'} · grouped ${i.groupedBy === 'helix' ? 'by Helix' : 'by its exact cause'} · ${plural(i.failures, 'time')} since ${when(Date.parse(i.first), tz)}`);
    ctx.out(`key: ${i.key}`);
    if (i.title) ctx.out(`cause: ${fit(i.cause, 92)}`);
    ctx.out('');
    ctx.out(`Tasks (${i.members.length})`);
    for (const l of table(i.members.slice(0, 20).map((m) => [`  ${m.task}`, `${m.count}×`, ago(Date.parse(m.last)), m.detail]))) ctx.out(l);
    if (i.fix) {
      ctx.out('');
      ctx.out(`Fix ${i.fix.id}, proposed by ${i.fix.by === 'helix' ? 'Helix' : 'the loop'} (${Math.round(i.fix.confidence * 100)}% sure)${i.decision ? `: ${i.decision.decision} ${ago(Date.parse(i.decision.at))}` : ''}`);
      for (const l of wrap(i.fix.summary)) ctx.out(l);
      for (const c of i.fix.changes) ctx.out(`  · ${changeLine(c)}`);
      for (const a of i.fix.alternatives ?? []) ctx.out(`  ${a.chosen ? '✓' : '·'} instead: ${fit(a.title, 60)} (${a.cost})`);
      if (i.fix.evidence) for (const l of wrap(`Evidence: ${i.fix.evidence}`)) ctx.out(l);
      if (!i.decision) {
        ctx.out('');
        ctx.out(`→ helix-loop fix accept ${quote(i.fix.id)} · fix dry ${quote(i.fix.id)} · fix decline ${quote(i.fix.id)}`);
      }
    }
    if (tail) {
      ctx.out('');
      ctx.out(`The latest gate output (${latest!.task}, attempt ${latest!.attempt ?? '?'})`);
      for (const l of tail.split('\n')) ctx.out(`  ${l}`.trimEnd());
    }
  },
});

const fixAccept = define({
  name: 'fix accept',
  group: 'What waits on you',
  summary: "Accept Helix's fix for an incident: its plan changes land as one commit",
  args: [{ name: 'ref', description: "The fix's id (F-3), or its incident's key" }],
  examples: [['helix-loop fix accept F-3', 'Apply the fix']],
  async run(ctx) {
    const inc = ops.findIncident(ops.incidentsNow(ctx.root), ctx.args[0]!);
    const r = (await ops.decideFix(ctx.root, inc.key, 'accepted', withCli(ctx.root))) as ops.Applied;
    ctx.out(`Applied ${inc.fix!.id}: ${fit(inc.fix!.summary, 70)}.${undoHint(r.change)}`);
  },
});

const fixDecline = define({
  name: 'fix decline',
  group: 'What waits on you',
  summary: "Decline Helix's fix for an incident",
  args: [{ name: 'ref', description: "The fix's id, or its incident's key" }],
  async run(ctx) {
    const r = (await ops.decideFix(ctx.root, ctx.args[0]!, 'declined', withCli(ctx.root))) as { declined: string };
    ctx.out(`Declined ${r.declined}. Nothing in the plan changed.`);
  },
});

const fixDry = define({
  name: 'fix dry',
  group: 'What waits on you',
  summary: 'Try a fix first, in a dry run of the plan with fake agents',
  description: `Starts a fresh dry run of the plan as it stands, with this fix applied, in .helix/runs/dry-run/: fake agents and throwaway repos, nothing real touched.
It runs in the background, as \`helix-loop run --dry-run --plan-changes\` would; its output goes to .helix/runs/dry-run.log.`,
  args: [{ name: 'ref', description: "The fix's id, or its incident's key" }],
  options: { 'max-passes': { type: 'string', value: 'N', description: 'Stop the dry run after N passes' } },
  async run(ctx) {
    const inc = ops.findIncident(ops.incidentsNow(ctx.root), ctx.args[0]!);
    if (!inc.fix) throw new UsageError(`No fix waits for ${inc.key}.`);
    const r = await ops.startLoop(ctx.root, 'dry', { agents: [...AGENTS], planChanges: inc.fix.changes, maxPasses: Number(str(ctx.opts, 'max-passes')) || undefined });
    ctx.out(`A dry run with ${inc.fix.id} applied started (pid ${r.pid}); its output goes to .helix/${r.log}.`);
    ctx.out(`Watch it: helix-loop watch --root .helix/runs/dry-run, or in the app's Dry run.`);
  },
});

const asks = define({
  name: 'asks',
  group: 'What waits on you',
  summary: 'The requests Helix raised for you to decide, each with its options',
  json: true,
  run(ctx) {
    const raised = readHitl(paths(ctx.root).hitl).raised.filter((r) => !r.answered);
    if (ctx.json) return json(ctx, raised);
    if (!raised.length) return ctx.out('Helix has asked you nothing.');
    for (const r of raised) {
      ctx.out(`${r.id} · ${fit(r.question, 90)}`);
      ctx.out(`  ${r.name} · ${r.tasks.join(', ') || 'no task'} · ${ago(Date.parse(r.at))}`);
      if (r.why) for (const l of wrap(r.why, 2)) ctx.out(l);
      r.options.forEach((o, i) => {
        ctx.out(`  ${i + 1}) ${o.label}${r.recommend === i ? ' (Helix recommends it)' : ''}`);
        for (const c of o.changes) ctx.out(`       · ${changeLine(c)}`);
      });
      ctx.out(`  → helix-loop ask decide ${r.id} <1-${r.options.length}>`);
      ctx.out('');
    }
  },
});

const askDecide = define({
  name: 'ask decide',
  group: 'What waits on you',
  summary: 'Decide a request Helix raised: the option you pick lands as one commit',
  args: [
    { name: 'id', description: 'The request, as Q-#' },
    { name: 'option', description: 'The option, numbered from 1 as `helix-loop asks` lists them' },
  ],
  options: { ...YES },
  examples: [['helix-loop ask decide Q-2 1', 'Take the first option']],
  async run(ctx) {
    const [id, n] = ctx.args as [string, string];
    const r = readHitl(paths(ctx.root).hitl).raised.find((x) => x.id === id);
    const k = Number(n) - 1;
    const o = r?.options[k];
    if (r && !o) throw new UsageError(`${id} has options 1 to ${r.options.length}.`);
    if (r && o) await confirm(ctx, `${o.label}?`, [r.question, ...o.changes.map((c) => `  · ${changeLine(c)}`)]);
    const applied = await ops.decideAsk(ctx.root, id, k, withCli(ctx.root));
    ctx.out(`Decided ${id}: ${o!.label}.${undoHint(applied.change)}`);
  },
});

const answer = define({
  name: 'answer',
  group: 'What waits on you',
  summary: "Answer once: one answer to every builder's question about the same thing",
  description: `Puts the answer in the notes of every task that asked, handing back those that stopped for it, as one commit.
--spec also adds it to the spec's clarifications (spec/clarifications.md), for folding into the spec; --rule lets Helix answer the like itself from now on.`,
  args: [
    { name: 'ref', description: 'The question\'s incident: its key (spec:PB-14) or its fix\'s id' },
    { name: 'text', description: 'The answer', variadic: true },
  ],
  options: {
    tasks: { type: 'string', value: 'ids', description: 'Only these tasks, comma-separated' },
    spec: { type: 'boolean', description: "Also add it to the spec's clarifications" },
    rule: { type: 'boolean', description: 'Let Helix answer questions like it itself' },
  },
  examples: [['helix-loop answer spec:PB-14 "An empty list shows the empty state, not an error."', 'One answer for every task that asked']],
  async run(ctx) {
    const [ref, ...words] = ctx.args;
    const tasks = str(ctx.opts, 'tasks')?.split(',').map((s) => s.trim()).filter(Boolean);
    const r = await ops.answerOnce(ctx.root, ref!, words.join(' '), { tasks, spec: !!ctx.opts.spec, rule: !!ctx.opts.rule }, withCli(ctx.root));
    const got = r.applied?.tasks ?? [];
    ctx.out(`${got.length ? `Answered ${got.join(', ')}` : 'No open task took the answer'}${r.clarification ? `; added clarification ${r.clarification} to the spec` : ''}${r.rule ? '; Helix answers the like itself now' : ''}.${undoHint(r.applied?.change)}`);
  },
});

const changes = define({
  name: 'changes',
  group: 'What waits on you',
  summary: 'The plan changes of the last day, by you and by Helix, each one you can undo',
  json: true,
  options: { all: { type: 'boolean', description: 'Older ones too, which can no longer be undone' } },
  run(ctx) {
    const now = Date.now();
    const list = readChanges(paths(ctx.root).changes).filter((c) => ctx.opts.all || now - Date.parse(c.at) < UNDO_MS).reverse();
    if (ctx.json) return json(ctx, list);
    if (!list.length) return ctx.out('No plan change in the last day.');
    for (const l of table(list.map((c) => [c.id, ago(Date.parse(c.at)), c.by, `${c.what}${c.undone ? ' (undone)' : now - Date.parse(c.at) >= UNDO_MS ? ' (too old to undo)' : ''}`]))) ctx.out(l);
    ctx.out('');
    ctx.out('Undo one: helix-loop undo <id>');
  },
});

const undo = define({
  name: 'undo',
  group: 'What waits on you',
  summary: 'Undo a plan change of the last day, as a new commit',
  description: `Puts the tasks a change touched back as they were before it, as a new commit.
Refused when a later change touched the same tasks (the loop's passes included), or one of them is in a pass.`,
  args: [{ name: 'id', description: 'The change, as `helix-loop changes` lists it (C-12)' }],
  options: { ...YES },
  async run(ctx) {
    const id = ctx.args[0]!;
    const c = readChanges(paths(ctx.root).changes).find((x) => x.id === id);
    if (!c) throw new UsageError(`No change ${id}: \`helix-loop changes\` lists them.`);
    await confirm(ctx, `Undo ${id}?`, [`${c.what}, by ${c.by} ${ago(Date.parse(c.at))}. Its tasks go back to what they were before it.`]);
    await ops.undo(ctx.root, id, withCli(ctx.root));
    ctx.out(`Undid ${id}: ${c.what}.`);
  },
});

export const INBOX_COMMANDS = [inbox, incidents, incident, fixAccept, fixDecline, fixDry, asks, askDecide, answer, changes, undo];
