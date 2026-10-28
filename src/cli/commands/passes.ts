import { loopStatus, passesNow } from '../../app/state.ts';
import { paths } from '../../config.ts';
import { readLedger } from '../../ledger.ts';
import { loadPlan } from '../../plan/store.ts';
import * as ops from '../../ops/index.ts';
import { ownerOf } from '../../app/prompts.ts';
import { define, str, UsageError, type Context } from '../command.ts';
import { timeZone } from '../output.ts';
import { follow, outcomeOf, printLog } from '../watch.ts';

// One pass at a time: stopping it, following what its builder does, and reading its log afterwards.

const stop = define({
  name: 'pass stop',
  group: 'The loop',
  summary: "Stop one task's pass, keeping its work; the task goes back to ready",
  description: `Asks the loop to stop the pass that holds the task; the loop does it within seconds, keeping the work done so far for the next attempt.
The stop is not counted as a failed attempt.
--note goes into the task's notes for its next builder.`,
  args: [{ name: 'task', description: 'The task whose pass to stop' }],
  options: {
    to: { type: 'string', value: 'state', description: 'Where the task goes: ready (the default) or needs_human' },
    note: { type: 'string', value: 'text', description: 'What its next builder should know' },
  },
  examples: [['helix-loop pass stop T-0042 --note "Start from the shared helper"', 'Stop it and point the next attempt the right way']],
  run(ctx) {
    const task = ctx.args[0]!;
    const to = str(ctx.opts, 'to') ?? 'ready';
    if (to !== 'ready' && to !== 'needs_human') throw new UsageError('--to is ready or needs_human.');
    ops.stopPass(ctx.root, task, { to, note: str(ctx.opts, 'note'), why: `stopped by ${ownerOf(ctx.root)} with helix-loop pass stop` });
    ctx.out(`Stopping ${task}'s pass: the loop keeps its work and sets it ${to === 'ready' ? 'back to ready' : 'to wait for you'}.`);
  },
});

const watch = define({
  name: 'watch',
  group: 'The loop',
  summary: "Follow a pass as its builder works: its words, commands, edits and gate steps",
  description: `Prints a pass's activity as it happens, as Live shows it in the app, checking every two seconds, until the pass ends.
With no task, follows every pass as they start and end, until you stop it (Ctrl-C).
A task with no pass in flight shows its last attempt instead.`,
  args: [{ name: 'task', description: 'The task to follow', optional: true }],
  examples: [
    ['helix-loop watch T-0042', "Follow T-0042's pass to its end"],
    ['helix-loop watch', 'Follow every pass'],
  ],
  async run(ctx) {
    const task = ctx.args[0];
    const tz = timeZone(ctx.root);
    if (task) {
      const p = paths(ctx.root);
      const plan = loadPlan(p.tasks, p.human);
      const t = plan.tasks.get(task);
      if (!t) throw new UsageError(`No task ${task}.`);
      const inFlight = passesNow(ctx.root, plan, loopStatus(ctx.root, readLedger(p.ledger))).some((x) => x.task === task);
      if (!inFlight) return lastAttempt(ctx, task, t.attempts.length);
    }
    const ac = new AbortController();
    const onSig = () => ac.abort();
    for (const sig of ['SIGINT', 'SIGTERM'] as const) process.once(sig, onSig);
    try {
      await follow(ctx.root, { task, out: ctx.out, signal: ac.signal, timeZone: tz });
    } finally {
      for (const sig of ['SIGINT', 'SIGTERM'] as const) process.off(sig, onSig);
    }
  },
});

function lastAttempt(ctx: Context, task: string, n: number): void {
  const t = loadPlan(paths(ctx.root).tasks, paths(ctx.root).human).tasks.get(task)!;
  const a = t.attempts[n - 1];
  if (!a) throw new UsageError(`${task} has no pass in flight and no attempt yet.`);
  ctx.out(`${task} has no pass in flight. Its last attempt, ${n} on ${a.agent}, ended: ${outcomeOf(ctx.root, task, n) ?? a.outcome.replace(/_/g, ' ')}.`);
  if (!printLog(ctx.root, a.log, ctx.out, timeZone(ctx.root))) ctx.out(`Its log, ${a.log}, is gone.`);
}

const log = define({
  name: 'log',
  group: 'The loop',
  summary: "What a pass did, from its log; --gate for the gate's output, --raw for the file",
  description: `Prints one attempt's log as a readable list of what its builder did and how the gate went.
By default the pass in flight, or else the last attempt; --attempt picks another.
--gate prints only the end of the gate's output, where a failure shows; --raw prints the log as written.`,
  args: [{ name: 'task', description: 'The task' }],
  options: {
    attempt: { type: 'string', value: 'N', description: 'The attempt, numbered from 1' },
    gate: { type: 'boolean', description: "Only the end of the gate's output" },
    raw: { type: 'boolean', description: 'The log as written, line for line' },
  },
  examples: [
    ['helix-loop log T-0042 --gate', 'Why the last attempt failed its gate'],
    ['helix-loop log T-0042 --attempt 1 --raw | less', 'The first attempt, as written'],
  ],
  run(ctx) {
    const task = ctx.args[0]!;
    const p = paths(ctx.root);
    const plan = loadPlan(p.tasks, p.human);
    const t = plan.tasks.get(task);
    if (!t) throw new UsageError(`No task ${task}.`);
    const n = str(ctx.opts, 'attempt');
    let rel: string | undefined;
    if (n !== undefined) {
      const a = t.attempts[Number(n) - 1];
      // The attempt in flight is the one after the last recorded.
      const live = Number(n) === t.attempts.length + 1 ? passesNow(ctx.root, plan, loopStatus(ctx.root, readLedger(p.ledger))).find((x) => x.task === task) : undefined;
      rel = a?.log ?? live?.log;
      if (!rel) throw new UsageError(`${task} has attempts 1 to ${t.attempts.length}${t.attempts.length ? '' : ' (none yet)'}.`);
    } else {
      rel = passesNow(ctx.root, plan, loopStatus(ctx.root, readLedger(p.ledger))).find((x) => x.task === task)?.log ?? t.attempts.at(-1)?.log;
      if (!rel) throw new UsageError(`${task} has no attempt yet.`);
    }
    if (ctx.opts.gate) {
      const tail = ops.gateTail(ctx.root, rel, 60);
      return ctx.out(tail || `No gate output in ${rel}.`);
    }
    if (ctx.opts.raw) return ctx.out(ops.readLog(ctx.root, rel).trimEnd());
    if (!printLog(ctx.root, rel, ctx.out, timeZone(ctx.root))) throw new UsageError(`The log ${rel} is gone.`);
  },
});

export const PASS_COMMANDS = [stop, watch, log];
