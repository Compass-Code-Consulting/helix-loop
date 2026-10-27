import { paths } from '../../config.ts';
import { loadPlan } from '../../plan/store.ts';
import { loadTaskSet } from '../../app/taskset.ts';
import type { Plan, Task } from '../../types.ts';
import * as ops from '../../ops/index.ts';
import { withCli } from '../../ops/actor.ts';
import { define, str, UsageError, type Context } from '../command.ts';
import { ago, duration, fit, json, plural, table, timeZone, undoHint, usd, wrap } from '../output.ts';
import { when } from '../shared.ts';
import { showHuman } from './human.ts';

// The builders' tasks: listing them, everything about one, and the owner's direct actions on them. Each change
// is one commit you can undo for a day (helix-loop undo), as in the app.

const FAILED = new Set(['gate_failed', 'no_commit', 'forbidden_paths', 'timeout', 'agent_error', 'conflict']);
const done = (plan: Plan, id: string) => plan.tasks.get(id)?.status === 'done' || plan.human.get(id)?.status === 'done';

// Where a task stands, in words: "waiting" is ready in the plan but behind work that isn't done.
export function stateOf(plan: Plan, t: Task): string {
  if (t.status === 'claimed') return 'in a pass';
  if (t.status === 'needs_human') return 'needs you';
  if (t.status === 'ready' && t.blocked_by.some((d) => !done(plan, d))) return 'waiting';
  return t.status;
}
const ORDER = ['in a pass', 'needs you', 'parked', 'ready', 'waiting', 'done'];
const counted = (t: Task) => t.attempts.filter((a) => !['quota', 'suspended', 'transient', 'stopped'].includes(a.outcome)).length;

// Notes queued for a pass that has since ended land before a command reads the tasks.
async function land(ctx: Context): Promise<void> {
  const r = await ops.landNotes(ctx.root, withCli(ctx.root));
  if (r.landed.length && !ctx.json) ctx.err(`(the notes queued for ${r.landed.join(', ')} went in now that their passes have ended)`);
}

const list = define({
  name: 'tasks',
  group: 'Tasks',
  summary: 'The tasks: the open ones by default, filtered by status, lane, epic or stage',
  description: `Lists the builders' tasks, one line each: where it stands, its lane, its counted attempts and its title.
"waiting" is a ready task behind work that isn't done; "needs you" stopped for a person.
By default only open tasks show; --all adds the done ones.`,
  options: {
    status: { type: 'string', value: 'list', description: 'Only these states, comma-separated: ready, waiting, claimed, needs_human, parked, done' },
    lane: { type: 'string', value: 'repo', description: 'Only this lane (repo)' },
    epic: { type: 'string', value: 'key', description: 'Only this epic' },
    stage: { type: 'string', value: 'stage', description: 'Only this stage' },
    ready: { type: 'boolean', description: 'Only tasks that can start now' },
    failing: { type: 'boolean', description: 'Only open tasks whose last attempt failed' },
    grep: { type: 'string', value: 'text', description: 'Only tasks whose id, title or area holds this text' },
    all: { type: 'boolean', description: 'Done tasks too' },
  },
  examples: [
    ['helix-loop tasks', 'The open tasks'],
    ['helix-loop tasks --status needs_human,parked', 'What waits for you'],
    ['helix-loop tasks --lane acme-app --failing --json', 'Failing tasks in one lane, as JSON'],
  ],
  json: true,
  async run(ctx) {
    await land(ctx);
    const { root, opts } = ctx;
    const plan = loadPlan(paths(root).tasks, paths(root).human);
    const epics = new Map(loadTaskSet(root, plan).lanes.flatMap((l) => l.epics.flatMap((e) => e.tasks.map((id) => [id, e.key] as const))));
    const statuses = str(opts, 'status')?.split(',').map((s) => s.trim()).filter(Boolean);
    const words: Record<string, string> = { claimed: 'in a pass', needs_human: 'needs you' };
    const grep = str(opts, 'grep')?.toLowerCase();
    const rows = [...plan.tasks.values()]
      .map((t) => ({ t, state: stateOf(plan, t) }))
      .filter(({ t, state }) => {
        if (statuses) return statuses.some((s) => s === t.status || (words[s] ?? s) === state);
        return opts.all || t.status !== 'done';
      })
      .filter(({ t }) => !str(opts, 'lane') || t.repo === str(opts, 'lane'))
      .filter(({ t }) => !str(opts, 'epic') || epics.get(t.id) === str(opts, 'epic'))
      .filter(({ t }) => !str(opts, 'stage') || t.stage === str(opts, 'stage'))
      .filter(({ state }) => !opts.ready || state === 'ready')
      .filter(({ t }) => !opts.failing || (t.status !== 'done' && FAILED.has(t.attempts.at(-1)?.outcome ?? '')))
      .filter(({ t }) => !grep || `${t.id} ${t.title} ${t.area}`.toLowerCase().includes(grep))
      .sort((a, b) => ORDER.indexOf(a.state) - ORDER.indexOf(b.state) || a.t.id.localeCompare(b.t.id));
    if (ctx.json) {
      return json(ctx, rows.map(({ t, state }) => ({ id: t.id, title: t.title, status: t.status, state, lane: t.repo, epic: epics.get(t.id) ?? null, stage: t.stage ?? null, area: t.area, attempts: counted(t), lastOutcome: t.attempts.at(-1)?.outcome ?? null, blockedBy: t.blocked_by, waitingOn: t.blocked_by.filter((d) => !done(plan, d)) })));
    }
    if (!rows.length) return ctx.out('No task matches.');
    for (const l of table(rows.map(({ t, state }) => [t.id, state, t.repo, counted(t) ? `${counted(t)}×` : '', t.title]))) ctx.out(l);
    const by = new Map<string, number>();
    for (const { state } of rows) by.set(state, (by.get(state) ?? 0) + 1);
    ctx.out('');
    ctx.out(`${plural(rows.length, 'task')}: ${ORDER.filter((s) => by.has(s)).map((s) => `${by.get(s)} ${s}`).join(', ')}`);
  },
});

async function showTask(ctx: Context): Promise<void> {
  await land(ctx);
  const id = ctx.args[0]!;
  const { root } = ctx;
  if (/^HT-/.test(id)) return showHuman(ctx, id);
  const s = await ops.taskStory(root, id);
  if (ctx.json) return json(ctx, s);
  const t = s.task!;
  const tz = timeZone(root);
  const plan = loadPlan(paths(root).tasks, paths(root).human);
  ctx.out(`${t.id} · ${t.title}`);
  const facts = [stateOf(plan, t), t.repo, s.epic ? `epic ${s.epic.title}` : '', t.stage ? `stage ${t.stage}` : '', `area ${t.area}`, `estimate ${plural(t.estimate_passes, 'pass', 'passes')}`, s.board?.critical ? 'on the critical path' : '', t.priority === 'fix_first' ? 'fix first' : '', t.agent ? `pinned to ${t.agent}` : ''];
  ctx.out(facts.filter(Boolean).join(' · '));
  if (s.live) ctx.out(`In a pass: attempt ${s.live.attempt} on ${s.live.agent}, ${s.live.phase}, started ${ago(Date.parse(s.live.startedAt))}${s.live.progress ? `: ${s.live.progress}` : ''}. Follow it: helix-loop watch ${t.id}`);
  if ((t.status === 'needs_human' || t.status === 'parked') && (t.summary || t.attempts.at(-1)?.note)) {
    ctx.out('');
    ctx.out(t.status === 'parked' ? 'Why it is parked' : 'Why it stopped');
    for (const l of wrap(t.summary ?? t.attempts.at(-1)!.note!.split('\n').slice(0, 4).join('\n'))) ctx.out(l);
  }
  if (t.attempts.length) {
    ctx.out('');
    ctx.out('Attempts');
    const rows = t.attempts.map((a, i) => [`  ${i + 1}`, a.agent, a.outcome.replace(/_/g, ' '), when(Date.parse(a.at), tz), a.note?.split('\n')[0] ?? '']);
    for (const l of table(rows)) ctx.out(l);
    ctx.out(`  logs: helix-loop log ${t.id} [--attempt N] [--gate]`);
  }
  if (t.blocked_by.length) {
    ctx.out('');
    ctx.out(`Waits on   ${t.blocked_by.map((d) => `${d} ${plan.tasks.get(d)?.status ?? plan.human.get(d)?.status ?? 'missing'}`).join(' · ')}`);
  }
  if (s.unblocks.length) {
    if (!t.blocked_by.length) ctx.out('');
    const open = s.unblocks.filter((u) => u.status !== 'done');
    ctx.out(`Waited on  ${fit(`${open.slice(0, 8).map((u) => u.id).join(', ')}${open.length > 8 ? ` and ${open.length - 8} more` : ''}${open.length < s.unblocks.length ? ` (${s.unblocks.length - open.length} done)` : ''}`, 88)}`);
  }
  if (t.notes) {
    ctx.out('');
    ctx.out('Notes (its next builder reads them)');
    for (const l of wrap(t.notes)) ctx.out(l);
  }
  if (s.commits?.commits.length) {
    ctx.out('');
    ctx.out(`Commits on ${s.commits.repo}'s main${s.remote ? ` (${s.remote})` : ''}`);
    for (const l of table(s.commits.commits.map((c) => [`  ${c.sha.slice(0, 8)}`, `+${c.added} −${c.deleted}`, c.subject]))) ctx.out(l);
  }
  if (s.cost.passes) {
    ctx.out('');
    ctx.out(`Cost: ${plural(s.cost.passes, 'pass', 'passes')}, ${duration(s.cost.ms)}, ${usd(s.cost.usd)}${s.merged ? ` · merged ${when(Date.parse(s.merged.at), tz)}` : ''}`);
  }
  const act = t.status === 'needs_human' || t.status === 'parked' ? `helix-loop task hand-back ${t.id} --note "…"` : t.status === 'ready' ? `helix-loop task park ${t.id}` : t.status === 'claimed' ? `helix-loop pass stop ${t.id}` : '';
  if (act) {
    ctx.out('');
    ctx.out(`→ ${act}`);
  }
}

const show = define({
  name: 'task',
  group: 'Tasks',
  summary: 'Everything about one task: why it stopped, its attempts, notes and dependencies',
  description: `Shows one task: its state, lane, epic and stage, why it stopped, each attempt and how it ended, its notes, what it waits on and what waits on it, its commits once merged, and what it cost.
A human task's id (HT-##) shows that task, as \`helix-loop human show\` does.`,
  args: [{ name: 'id', description: 'The task, as T-####' }],
  examples: [['helix-loop task T-0042', 'Everything about T-0042']],
  json: true,
  run: showTask,
});

const showAlias = define({ ...show, name: 'task show', hidden: true });

function changed(ctx: Context, r: ops.Applied, said: string, nothing: string): void {
  ctx.out(r.change || r.tasks.length ? `${said}${undoHint(r.change)}` : nothing);
}

const handBack = define({
  name: 'task hand-back',
  group: 'Tasks',
  summary: 'Hand tasks back to the loop, with a note for their next builder',
  description: `Sets each task back to ready, so the loop picks it up again, and adds the note to its notes.
Several tasks go back as one commit, which \`helix-loop undo\` takes back.`,
  args: [{ name: 'id', description: 'The tasks', variadic: true }],
  options: { note: { type: 'string', value: 'text', description: 'What the next builder should know' } },
  examples: [['helix-loop task hand-back T-0042 --note "Use the sandbox host"', 'Back to the loop, with a note']],
  async run(ctx) {
    const r = await ops.setStatus(ctx.root, ctx.args, 'hand_back', { note: str(ctx.opts, 'note'), actor: withCli(ctx.root) });
    changed(ctx, r, `${r.tasks.join(', ')} ${r.tasks.length === 1 ? 'is' : 'are'} back with the loop.`, `Nothing changed: ${ctx.args.join(', ')} ${ctx.args.length === 1 ? 'is' : 'are'} with the loop already.`);
  },
});

const park = define({
  name: 'task park',
  group: 'Tasks',
  summary: 'Park tasks: the loop leaves them until they are handed back',
  args: [{ name: 'id', description: 'The tasks', variadic: true }],
  options: { note: { type: 'string', value: 'text', description: 'Why, for whoever hands it back' } },
  examples: [['helix-loop task park T-0042 --note "Wait for the new API"', 'Park one task']],
  async run(ctx) {
    const r = await ops.setStatus(ctx.root, ctx.args, 'park', { note: str(ctx.opts, 'note'), actor: withCli(ctx.root) });
    changed(ctx, r, `Parked ${r.tasks.join(', ')}.`, `Nothing changed: ${ctx.args.join(', ')} ${ctx.args.length === 1 ? 'is' : 'are'} parked already.`);
  },
});

const note = define({
  name: 'task note',
  group: 'Tasks',
  summary: "Add a note for a task's next attempt",
  description: `Adds the note under the task's notes, which its next builder reads in its prompt.
While the task is in a pass, the note waits and goes in when the pass ends.`,
  args: [
    { name: 'id', description: 'The task' },
    { name: 'text', description: 'The note', variadic: true },
  ],
  examples: [['helix-loop task note T-0042 "The fixture lives in test/fixtures/notes.json"', 'A note for its next builder']],
  async run(ctx) {
    const [id, ...words] = ctx.args;
    const r = await ops.addNote(ctx.root, id!, words.join(' '), withCli(ctx.root));
    if (r.pending) return ctx.out(`${id} is in a pass: the note goes into its notes when the pass ends.`);
    ctx.out(`Noted on ${id} for its next attempt.${undoHint(r.change)}`);
  },
});

const notes = define({
  name: 'task notes',
  group: 'Tasks',
  summary: "Show a task's notes, or replace or clear them",
  description: `With no option, prints the notes of a task or a human task.
--set replaces them whole and --clear empties them, as one commit you can undo.`,
  args: [{ name: 'id', description: 'The task or human task' }],
  options: {
    set: { type: 'string', value: 'text', description: 'Replace the notes with this' },
    clear: { type: 'boolean', description: 'Empty the notes' },
  },
  json: true,
  async run(ctx) {
    const id = ctx.args[0]!;
    const { root, opts } = ctx;
    if (opts.set !== undefined && opts.clear) throw new UsageError('Use --set or --clear, not both.');
    if (opts.set === undefined && !opts.clear) {
      const plan = loadPlan(paths(root).tasks, paths(root).human);
      const t = plan.tasks.get(id) ?? plan.human.get(id);
      if (!t) throw new UsageError(`No task ${id}.`);
      if (ctx.json) return json(ctx, { id, notes: t.notes ?? '' });
      return ctx.out(t.notes?.trim() ? t.notes.trim() : `${id} has no notes.`);
    }
    const r = await ops.setNotes(root, id, opts.clear ? '' : str(opts, 'set')!, withCli(root));
    changed(ctx, r, `${id}'s notes ${opts.clear ? 'are cleared' : 'are replaced'}.`, `Nothing changed: ${id}'s notes say that already.`);
  },
});

const depAdd = define({
  name: 'task dep add',
  group: 'Tasks',
  summary: 'Make a task wait on another task or a human task',
  args: [
    { name: 'id', description: 'The task that waits' },
    { name: 'on', description: 'What it waits on: T-#### or HT-##' },
  ],
  examples: [['helix-loop task dep add T-0042 HT-3', 'T-0042 waits until HT-3 is done']],
  async run(ctx) {
    const [id, on] = ctx.args as [string, string];
    const r = await ops.setDep(ctx.root, id, on, true, withCli(ctx.root));
    ctx.out(`${id} now waits on ${on}.${undoHint(r.change)}`);
  },
});

const depRemove = define({
  name: 'task dep remove',
  group: 'Tasks',
  summary: 'Stop a task waiting on another',
  args: [
    { name: 'id', description: 'The task that waits' },
    { name: 'on', description: 'What it no longer waits on' },
  ],
  async run(ctx) {
    const [id, on] = ctx.args as [string, string];
    const r = await ops.setDep(ctx.root, id, on, false, withCli(ctx.root));
    ctx.out(`${id} no longer waits on ${on}.${undoHint(r.change)}`);
  },
});

export const TASK_COMMANDS = [list, show, showAlias, handBack, park, note, notes, depAdd, depRemove];
