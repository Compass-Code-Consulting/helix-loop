import { buildBoard } from '../../app/board.ts';
import { boardInput } from '../../app/views.ts';
import { loadConfig, monitorOf, paths } from '../../config.ts';
import { readLedger } from '../../ledger.ts';
import { loadPlan } from '../../plan/store.ts';
import * as ops from '../../ops/index.ts';
import { withCli } from '../../ops/actor.ts';
import { runningApp } from '../client.ts';
import { define, str, UsageError, type Context } from '../command.ts';
import { confirm, day, fit, json, plural, table, timeZone, undoHint, wrap, YES } from '../output.ts';

// The owner's own tasks (spec §6.3): the steps only a person can do, each with a lead time, a start-by date the
// build needs it by, and the builder tasks it holds up.

const DAY = 86_400_000;

function board(root: string) {
  const p = paths(root);
  const plan = loadPlan(p.tasks, p.human);
  return { plan, board: buildBoard(boardInput(root, plan, readLedger(p.ledger), loadConfig(root), Date.now())) };
}

// When it must start, in words: "3 d late", "today", or the day.
function startBy(latest: number | undefined, tz: string): string {
  if (latest === undefined) return '';
  const d = Math.floor((Date.now() - latest) / DAY);
  if (d > 0) return `${d} d late`;
  return latest - Date.now() < DAY ? 'today' : day(latest, tz);
}

export async function showHuman(ctx: Context, id: string): Promise<void> {
  const { plan, board: b } = board(ctx.root);
  const h = ops.humanCard(plan, b, id);
  if (ctx.json) return json(ctx, h);
  const tz = timeZone(ctx.root);
  const bh = b.human.find((x) => x.id === id);
  ctx.out(`${h.id} · ${h.title}`);
  const snoozed = ops.snoozedUntil(h);
  ctx.out([h.status.replace('_', ' '), `lead time ${h.lead_time_days} d`, h.status !== 'done' && h.latestStart !== undefined ? `start by ${day(h.latestStart, tz)}${h.late ? ` (${startBy(h.latestStart, tz)})` : ''}` : '', h.held ? `holds ${plural(h.held, 'task')}` : '', h.critical ? 'on the critical path' : '', snoozed ? `snoozed until ${snoozed}` : '', `an agent can help: ${h.agent_can_help}`].filter(Boolean).join(' · '));
  if (bh?.expectedDone && h.status !== 'done') ctx.out(`Expected done ${day(bh.expectedDone, tz)}`);
  ctx.out('');
  ctx.out('Done when');
  for (const l of wrap(h.done_check)) ctx.out(l);
  if (h.steps.length) {
    ctx.out('');
    ctx.out(`Steps (${h.done.length} of ${h.steps.length} done)`);
    h.steps.forEach((s, i) => {
      const [first, ...rest] = wrap(s, 9);
      ctx.out(`  [${h.done.includes(i + 1) ? 'x' : ' '}] ${String(i + 1).padStart(2)}. ${first!.trim()}`);
      for (const l of rest) ctx.out(l);
    });
  }
  if (h.secrets?.length) {
    ctx.out('');
    ctx.out('Secrets it names (never their values)');
    for (const l of table(h.secrets.map((s) => [`  ${s.name}`, `stored in ${s.stored_in}`]))) ctx.out(l);
  }
  if (h.tools?.length) ctx.out(`Tools: ${h.tools.join(', ')}`);
  if (h.blocked_by.length) ctx.out(`Waits on: ${h.blocked_by.map((d) => `${d} ${plan.tasks.get(d)?.status ?? plan.human.get(d)?.status ?? 'missing'}`).join(', ')}`);
  if (h.unblocks.length) {
    ctx.out('');
    ctx.out(`Unblocks ${plural(h.unblocks.length, 'task')} directly`);
    for (const l of table(h.unblocks.slice(0, 12).map((u) => [`  ${u.id}`, u.status.replace('_', ' '), u.title]))) ctx.out(l);
    if (h.unblocks.length > 12) ctx.out(`  … and ${h.unblocks.length - 12} more`);
  }
  const notes = (h.notes ?? '').replace(/^Steps done:.*$\n?/m, '').replace(/^Snoozed until .*$\n?/m, '').trim();
  if (notes) {
    ctx.out('');
    ctx.out('Notes');
    for (const l of wrap(notes)) ctx.out(l);
  }
  if (h.handoff_prompt?.trim()) {
    ctx.out('');
    ctx.out(`Handoff prompt (\`helix-loop human prompt ${h.id}\` prints it alone, for an agent)`);
    for (const l of h.handoff_prompt.trimEnd().split('\n')) ctx.out(`  ${l}`.trimEnd());
  }
  if (h.status !== 'done') {
    ctx.out('');
    ctx.out(`→ helix-loop human done ${h.id} --evidence "…"`);
  }
}

const list = define({
  name: 'human',
  group: 'Human tasks',
  summary: 'Your human tasks, by the date each must start, with what each holds up',
  description: `Lists the open human tasks by start-by date: the latest each can start without the build waiting for it, given its lead time.
Late ones come first; each shows how many builder tasks wait on it.
With an id, shows that task, as \`helix-loop human show\` does.`,
  args: [{ name: 'id', description: 'A human task to show, as HT-##', optional: true }],
  options: { all: { type: 'boolean', description: 'Done ones too' } },
  examples: [
    ['helix-loop human', 'What you have to do, most urgent first'],
    ['helix-loop human HT-3', 'One of them, with its steps'],
  ],
  json: true,
  async run(ctx) {
    if (ctx.args[0]) return showHuman(ctx, ctx.args[0]);
    const { plan, board: b } = board(ctx.root);
    const tz = timeZone(ctx.root);
    const rows = [...plan.human.values()]
      .filter((h) => ctx.opts.all || h.status !== 'done')
      .map((h) => ops.humanCard(plan, b, h.id))
      .sort((x, y) => Number(x.status === 'done') - Number(y.status === 'done') || (x.latestStart ?? Infinity) - (y.latestStart ?? Infinity) || x.id.localeCompare(y.id));
    if (ctx.json) return json(ctx, rows.map((h) => ({ id: h.id, title: h.title, status: h.status, leadTimeDays: h.lead_time_days, latestStart: h.latestStart === undefined ? null : new Date(h.latestStart).toISOString(), late: h.late, critical: h.critical, held: h.held, snoozedUntil: ops.snoozedUntil(h) ?? null, steps: h.steps.length, stepsDone: h.done.length })));
    if (!rows.length) return ctx.out('No human task is open.');
    const head = ['ID', 'STATUS', 'START BY', 'LEAD', 'HOLDS', 'TITLE'];
    const body = rows.map((h) => {
      const snoozed = ops.snoozedUntil(h);
      return [h.id, h.status.replace('_', ' '), h.status === 'done' ? '' : `${startBy(h.latestStart, tz)}${snoozed ? `, snoozed to ${day(Date.parse(snoozed), tz)}` : ''}`, `${h.lead_time_days} d`, h.held ? plural(h.held, 'task') : '', `${h.title}${h.critical ? ' · critical' : ''}`];
    });
    for (const l of table([head, ...body])) ctx.out(l);
    const late = rows.filter((h) => h.late && h.status !== 'done').length;
    ctx.out('');
    ctx.out(`${plural(rows.filter((h) => h.status !== 'done').length, 'open human task')}${late ? `, ${late} late` : ''}. Show one: helix-loop human ${rows[0]!.id}`);
  },
});

const show = define({
  name: 'human show',
  group: 'Human tasks',
  summary: 'One human task: its done check, steps, handoff prompt, secrets and what it unblocks',
  args: [{ name: 'id', description: 'The human task, as HT-##' }],
  json: true,
  hidden: true,
  run: (ctx) => showHuman(ctx, ctx.args[0]!),
});

const start = define({
  name: 'human start',
  group: 'Human tasks',
  summary: 'Mark a human task in progress',
  args: [{ name: 'id', description: 'The human task' }],
  async run(ctx) {
    const id = ctx.args[0]!;
    const r = await ops.humanAction(ctx.root, id, { status: 'in_progress' }, withCli(ctx.root));
    ctx.out(r.change ? `${id} is in progress.${undoHint(r.change)}` : `Nothing changed: ${id} is ${r.value.status.replace('_', ' ')} already.`);
  },
});

const done = define({
  name: 'human done',
  group: 'Human tasks',
  summary: 'Mark a human task done, with the evidence, so the tasks waiting on it can run',
  description: `Marks it done once its done check holds, with what shows it (an ID, a link; never a secret's value).
The builder tasks waiting on it can then run.
When the app runs with Helix's monitor on, the monitor then passes on what it provides to those tasks.`,
  args: [{ name: 'id', description: 'The human task' }],
  options: { evidence: { type: 'string', value: 'text', description: 'What shows it done' }, ...YES },
  examples: [['helix-loop human done HT-3 --evidence "Stripe account acct_123 approved"', 'Done, with evidence']],
  async run(ctx) {
    const id = ctx.args[0]!;
    const { root } = ctx;
    const h = loadPlan(paths(root).tasks, paths(root).human).human.get(id);
    if (!h) throw new UsageError(`No human task ${id}.`);
    if (h.status === 'done') return ctx.out(`Nothing changed: ${id} is done already.`);
    await confirm(ctx, `Mark ${id} done?`, [`Done when: ${h.done_check}`]);
    const r = await ops.humanAction(root, id, { status: 'done', evidence: str(ctx.opts, 'evidence') }, withCli(root));
    const waiting = ops.humanCard(loadPlan(paths(root).tasks, paths(root).human), board(root).board, id).unblocks.filter((u) => u.status !== 'done').length;
    ctx.out(`${id} is done${waiting ? `: ${plural(waiting, 'task')} waiting on it can run` : ''}.${undoHint(r.change)}`);
    if (!monitorOf(loadConfig(root)).enabled) return;
    // Helix's monitor runs inside the app: ask the running app to pass on what this task provides.
    const app = await runningApp(root);
    if (!app) return ctx.out("Helix's monitor runs in the app: start it (helix-loop app) for the monitor to tell the waiting tasks what this provides.");
    await app.post('/api/helix/watch', { focus: `human:${id}` }).then(() => ctx.out("Helix's monitor is telling the waiting tasks what it provides."), () => undefined);
  },
});

const step = define({
  name: 'human step',
  group: 'Human tasks',
  summary: "Tick a step of a human task's checklist, or untick it with --undo",
  args: [
    { name: 'id', description: 'The human task' },
    { name: 'n', description: 'The step, numbered from 1' },
  ],
  options: { undo: { type: 'boolean', description: 'Untick it' } },
  async run(ctx) {
    const [id, n] = ctx.args as [string, string];
    const h = loadPlan(paths(ctx.root).tasks, paths(ctx.root).human).human.get(id);
    if (!h) throw new UsageError(`No human task ${id}.`);
    const steps = ops.stepsOf(h);
    const k = Number(n);
    if (!Number.isInteger(k) || k < 1 || k > steps.length) throw new UsageError(steps.length ? `${id} has steps 1 to ${steps.length}.` : `${id}'s handoff prompt lists no steps.`);
    const ticked = new Set(ops.doneSteps(h));
    if (ctx.opts.undo) ticked.delete(k);
    else ticked.add(k);
    const r = await ops.humanAction(ctx.root, id, { steps: [...ticked] }, withCli(ctx.root));
    ctx.out(`${ctx.opts.undo ? 'Unticked' : 'Ticked'} step ${k} of ${id}: ${fit(steps[k - 1]!, 60)} (${ticked.size} of ${steps.length} done).${undoHint(r.change)}`);
  },
});

// A date, from 2026-11-02 or +3d, in the project's time zone.
function snoozeDate(s: string, tz: string): string {
  const rel = /^\+(\d{1,3})d$/.exec(s);
  if (rel) return new Date(Date.now() + Number(rel[1]) * DAY).toLocaleDateString('en-CA', { timeZone: tz });
  if (/^\d{4}-\d\d-\d\d$/.test(s) && !Number.isNaN(Date.parse(s))) return s;
  throw new UsageError(`Snooze until a date (2026-11-02), a number of days (+3d), or off; not ${s}.`);
}

const snooze = define({
  name: 'human snooze',
  group: 'Human tasks',
  summary: 'Snooze a human task until a date, or take the snooze off',
  args: [
    { name: 'id', description: 'The human task' },
    { name: 'until', description: 'A date (2026-11-02), days from today (+3d), or off' },
  ],
  examples: [['helix-loop human snooze HT-3 +2d', 'Out of the way for two days']],
  async run(ctx) {
    const [id, until] = ctx.args as [string, string];
    const date = until === 'off' ? '' : snoozeDate(until, timeZone(ctx.root));
    const r = await ops.humanAction(ctx.root, id, { snooze: date }, withCli(ctx.root));
    ctx.out(`${date ? `${id} is snoozed until ${date}` : `${id} is not snoozed`}.${undoHint(r.change)}`);
  },
});

const prompt = define({
  name: 'human prompt',
  group: 'Human tasks',
  summary: "Print a human task's handoff prompt alone, to give to an agent",
  args: [{ name: 'id', description: 'The human task' }],
  examples: [['helix-loop human prompt HT-3 | claude', 'Hand the steps to Claude Code']],
  run(ctx) {
    const h = loadPlan(paths(ctx.root).tasks, paths(ctx.root).human).human.get(ctx.args[0]!);
    if (!h) throw new UsageError(`No human task ${ctx.args[0]}.`);
    if (!h.handoff_prompt?.trim()) throw new UsageError(`${h.id} has no handoff prompt.`);
    ctx.out(h.handoff_prompt.trimEnd());
  },
});

export const HUMAN_COMMANDS = [list, show, start, done, step, snooze, prompt];
