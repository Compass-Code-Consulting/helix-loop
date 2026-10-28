import { tmpdir } from 'node:os';
import { columnOf, readRules } from '../../app/hitl.ts';
import type { Thread } from '../../app/threads.ts';
import { pilotView } from '../../app/views.ts';
import { loadConfig, MONITOR_LEVELS, MONITOR_PRESETS, type PilotConfig } from '../../config.ts';
import { run as runProc } from '../../proc.ts';
import * as ops from '../../ops/index.ts';
import { withCli } from '../../ops/actor.ts';
import { appFor } from '../client.ts';
import { define, str, UsageError } from '../command.ts';
import { ago, confirm, fit, json, table, usd, wrap, YES } from '../output.ts';

// Helix, the loop's assistant: how much it decides on the owner's behalf (pilot mode), what their ratings taught
// it, its monitor, and a question put to it from the terminal.

const AGENT_NAME = { claude: 'Claude Code', codex: 'Codex' } as const;
const DECISION: Record<string, string> = { asks: 'asks you', helix: 'Helix decides', parks: 'parks it until you are back', always: 'always you', owner: 'always you' };

const pilot = define({
  name: 'pilot',
  group: 'Helix',
  summary: 'Pilot mode: who decides what the loop would ask you, at the level in force',
  description: `Shows the mode (Active pilot: you are at your desk; Auto-pilot: Helix resolves what it can while you are away), its level, and what happens to each kind of request at that level.
Releases and marking a human task done always wait for you, at every level.`,
  json: true,
  run(ctx) {
    const v = pilotView(ctx.root, loadConfig(ctx.root));
    if (ctx.json) return json(ctx, { ...v.pilot, column: columnOf(v.pilot), requests: v.requests, rules: v.rules.length });
    const p = v.pilot;
    ctx.out(p.mode === 'active' ? `Active pilot, ${p.active_level} (Auto-pilot would be ${p.auto_level}).` : `Auto-pilot, ${p.auto_level} (Active pilot is ${p.active_level}).`);
    ctx.out(`What Helix resolves on Auto-pilot is ${p.record ? '' : 'not '}recorded for you to rate.`);
    ctx.out('');
    for (const l of table(v.requests.map((r) => [`  ${r.label}`, DECISION[r.now] ?? r.now]))) ctx.out(l);
    if (v.rules.length) {
      ctx.out('');
      ctx.out(`${v.rules.length} rule${v.rules.length === 1 ? '' : 's'} from your ratings override the table: helix-loop rules`);
    }
    ctx.out('');
    ctx.out('Change it: helix-loop pilot active <cautious|prudent|intrepid>, or helix-loop pilot auto <intrepid|yolo>');
  },
});

// How to go back to the mode and level before a change.
const backTo = (p: PilotConfig) => `It was ${p.mode === 'active' ? `Active pilot, ${p.active_level}` : `Auto-pilot, ${p.auto_level}`}: helix-loop pilot ${p.mode} ${p.mode === 'active' ? p.active_level : p.auto_level}`;

const pilotActive = define({
  name: 'pilot active',
  group: 'Helix',
  summary: 'Active pilot at a level: Helix brings you what the level asks',
  args: [{ name: 'level', description: 'cautious (asks about everything), prudent, or intrepid (asks only about the big things)', optional: true }],
  async run(ctx) {
    const level = ctx.args[0];
    const was = pilotView(ctx.root, loadConfig(ctx.root)).pilot;
    await ops.setPilot(ctx.root, { mode: 'active', ...(level ? { active_level: level } : {}) }, withCli(ctx.root));
    const p = pilotView(ctx.root, loadConfig(ctx.root)).pilot;
    ctx.out(`Active pilot, ${p.active_level}. ${backTo(was)}`);
  },
});

const pilotAuto = define({
  name: 'pilot auto',
  group: 'Helix',
  summary: 'Auto-pilot at a level: Helix resolves what it can, and parks the rest',
  args: [{ name: 'level', description: 'intrepid (parks the big things for you) or yolo (decides everything but the floors)', optional: true }],
  async run(ctx) {
    const level = ctx.args[0];
    const was = pilotView(ctx.root, loadConfig(ctx.root)).pilot;
    await ops.setPilot(ctx.root, { mode: 'auto', ...(level ? { auto_level: level } : {}) }, withCli(ctx.root));
    const p = pilotView(ctx.root, loadConfig(ctx.root)).pilot;
    ctx.out(`Auto-pilot, ${p.auto_level}. ${backTo(was)}`);
  },
});

const rules = define({
  name: 'rules',
  group: 'Helix',
  summary: 'What your ratings taught Helix to decide, or always to ask about',
  json: true,
  run(ctx) {
    const list = readRules(ctx.root);
    if (ctx.json) return json(ctx, list);
    if (!list.length) return ctx.out('No rules yet: rating what Helix resolved, in the app, teaches it.');
    for (const l of table(list.map((r) => [r.id, r.decide === 'helix' ? 'Helix decides' : 'always asks', ago(Date.parse(r.at)), `"${r.name}"${r.request ? ` (${r.request})` : ''}`]))) ctx.out(l);
    ctx.out('');
    ctx.out('Take one back: helix-loop rule undo <id>');
  },
});

const ruleUndo = define({
  name: 'rule undo',
  group: 'Helix',
  summary: 'Take back a rule your ratings taught Helix',
  args: [{ name: 'id', description: 'The rule, as R-#' }],
  async run(ctx) {
    await ops.undoRule(ctx.root, ctx.args[0]!, withCli(ctx.root));
    ctx.out(`Removed ${ctx.args[0]}: the pilot table decides those again.`);
  },
});

const monitor = define({
  name: 'monitor',
  group: 'Helix',
  summary: "Helix's monitor: level, agent, cap, today's spend, and what each level costs",
  description: `The monitor watches the loop from inside the app: it names and groups incidents, proposes fixes, and resolves what the pilot level lets it.
Its turns draw on the builders' subscription, so it is off until you turn it on, and it stops for the day at its cap.
The estimates are what each level would have spent over the last day of the loop.`,
  json: true,
  run(ctx) {
    const m = ops.monitorStatus(ctx.root);
    if (ctx.json) return json(ctx, m);
    ctx.out(`Helix's monitor is ${m.enabled ? 'on' : 'off'}: ${m.level}, on ${AGENT_NAME[m.agent]}, capped at ${usd(m.budgetUsd)} a day${m.budgetSet ? '' : " (the level's own)"}; ${usd(m.spentUsd)} spent today.`);
    ctx.out(`Helix's assistant runs on ${AGENT_NAME[m.assistant]}.`);
    ctx.out('');
    const e = m.estimate;
    ctx.out(`Each level over the last day (${e.passes} passes, ${e.issues} issues reported):`);
    for (const l of table(e.levels.map((x) => [`  ${x.level}${x.level === m.level ? ' *' : ''}`, `${x.model} · ${x.effort}`, x.everyMinutes ? `every ${x.everyMinutes} min` : 'when needed', `${x.turns} turns`, `${usd(x.usdPerDay)} a day${x.capped ? ' (capped)' : ''}${x.measured ? '' : ', estimated'}`]))) ctx.out(l);
    ctx.out('');
    ctx.out(m.enabled ? 'Change it: helix-loop monitor level <light|standard|thorough>, monitor cap <usd>, monitor off' : 'Turn it on: helix-loop monitor on [--level light]');
  },
});

const monitorOn = define({
  name: 'monitor on',
  group: 'Helix',
  summary: "Turn Helix's monitor on; it runs while the app does",
  options: { level: { type: 'string', value: 'level', description: `${MONITOR_LEVELS.join(', ')}; the current one by default` }, ...YES },
  async run(ctx) {
    const level = str(ctx.opts, 'level');
    if (level && !(MONITOR_LEVELS as readonly string[]).includes(level)) throw new UsageError(`The monitor's level is ${MONITOR_LEVELS.join(', ')}.`);
    const m = ops.monitorStatus(ctx.root);
    if (m.enabled && (!level || level === m.level)) return ctx.out(`Nothing changed: the monitor is on, ${m.level}.`);
    const l = (level ?? m.level) as (typeof MONITOR_LEVELS)[number];
    const est = m.estimate.levels.find((x) => x.level === l)!;
    const cap = m.budgetSet ? m.budgetUsd : MONITOR_PRESETS[l].budgetUsd;
    await confirm(ctx, "Turn Helix's monitor on?", [`On ${l}, each turn draws on ${AGENT_NAME[m.agent]}'s subscription, the one the builders use: about ${usd(est.usdPerDay)} a day at today's pace, never more than ${usd(cap)}.`, 'On Auto-pilot it then resolves requests and applies fixes the pilot level allows, each as a commit you can undo for a day.']);
    await ops.setMonitor(ctx.root, { enabled: true, ...(level ? { level } : {}) }, withCli(ctx.root));
    ctx.out(`Helix's monitor is on, ${l}. It runs while the app does (helix-loop app). Turn it off: helix-loop monitor off`);
  },
});

const monitorOff = define({
  name: 'monitor off',
  group: 'Helix',
  summary: "Turn Helix's monitor off",
  async run(ctx) {
    if (!ops.monitorStatus(ctx.root).enabled) return ctx.out('Nothing changed: the monitor is off.');
    await ops.setMonitor(ctx.root, { enabled: false }, withCli(ctx.root));
    ctx.out("Helix's monitor is off. Turn it on again: helix-loop monitor on");
  },
});

const monitorLevel = define({
  name: 'monitor level',
  group: 'Helix',
  summary: "Set how much Helix's monitor watches: light, standard or thorough",
  description: `light takes a turn only when something needs judgment, on a cheaper model; standard adds a turn every half hour while the loop runs, and one-line reads of the passes in flight; thorough looks after every pass, every quarter hour, on the plan model.
\`helix-loop monitor\` shows what each would have cost over the last day.`,
  args: [{ name: 'level', description: MONITOR_LEVELS.join(', ') }],
  async run(ctx) {
    const level = ctx.args[0]!;
    const before = ops.monitorStatus(ctx.root).level;
    await ops.setMonitor(ctx.root, { level }, withCli(ctx.root));
    const m = ops.monitorStatus(ctx.root);
    ctx.out(`The monitor's level is ${level}${m.budgetSet ? '' : `, capped at ${usd(m.budgetUsd)} a day`}. Set it back: helix-loop monitor level ${before}`);
  },
});

const monitorCap = define({
  name: 'monitor cap',
  group: 'Helix',
  summary: "Set the monitor's daily cap in dollars, or put back its level's own",
  args: [{ name: 'usd', description: 'Dollars a day, from 0 to 500, or default for the level\'s own' }],
  examples: [['helix-loop monitor cap 8', 'At most $8 a day'], ['helix-loop monitor cap default', "Back to the level's cap"]],
  async run(ctx) {
    const a = ctx.args[0]!.replace(/^\$/, '');
    const budget = a === 'default' ? null : Number(a);
    if (budget !== null && !Number.isFinite(budget)) throw new UsageError(`The cap is a number of dollars, or default; not ${ctx.args[0]}.`);
    await ops.setMonitor(ctx.root, { budget }, withCli(ctx.root));
    const m = ops.monitorStatus(ctx.root);
    ctx.out(`The monitor stops for the day at ${usd(m.budgetUsd)}${budget === null ? `, its level's (${m.level}) own` : ''}.`);
  },
});

const agent = define({
  name: 'helix agent',
  group: 'Helix',
  summary: "Pick the agent Helix's assistant or monitor runs on, on this machine",
  description: `Helix runs as Claude Code or Codex, headless; its assistant and its monitor can run on different ones.
The agent must be installed, signed in (or given a Helix API key in the app), and working: this checks with one tiny request.
The choice is this machine's, in .helix/app.yaml, as in the app's Settings › Helix.`,
  args: [
    { name: 'role', description: 'assistant or monitor' },
    { name: 'agent', description: 'claude or codex' },
  ],
  async run(ctx) {
    const [role, name] = ctx.args as [string, string];
    if (role !== 'assistant' && role !== 'monitor') throw new UsageError('The role is assistant or monitor.');
    const a = ops.agentArg(name);
    await ops.setHelixAgents(ctx.root, { [role]: a });
    ctx.out(`Helix's ${role} runs on ${AGENT_NAME[a]}.`);
  },
});

// The newest of Helix's messages after the owner's last, once Helix has answered.
const answerOf = (t: Thread) => {
  const mine = t.messages.findLastIndex((m) => m.author === 'owner' && m.kind === 'message');
  const after = t.messages.slice(mine + 1).filter((m) => m.author === 'helix');
  return after.length && (t.waitingOn !== 'helix' || t.state === 'resolved') ? after : undefined;
};

const ask = define({
  name: 'ask',
  group: 'Helix',
  summary: "Ask Helix's assistant a question about the loop, and print its answer",
  description: `Starts a conversation with Helix, as Ask Helix does in the app, and waits for its answer (a turn takes a minute or two).
Helix reads the plan, the spec and the logs through the app, so this uses the app running for the project, or starts one here for as long as the question takes.
The conversation stays in the app's Helix tab, where you can go on with it.`,
  args: [{ name: 'question', description: 'What to ask', variadic: true }],
  options: { about: { type: 'string', value: 'ids', description: 'Tasks or human tasks it is about, comma-separated' } },
  examples: [
    ['helix-loop ask "Why does T-0042 keep failing its gate?"', 'A question, answered in the terminal'],
    ['helix-loop ask --about T-0042,T-0043 "Should these be one task?"', 'About a selection, as on Home'],
  ],
  async run(ctx) {
    const text = ctx.args.join(' ').trim();
    if (!text) throw new UsageError('Write your question.');
    const { root } = ctx;
    // Helix runs as the agent CLI on this machine: say so plainly when there is none to run.
    const config = loadConfig(root);
    const who = ops.helixAgentOf(root, 'assistant');
    const v = await runProc(config.agents[who].command, ['--version'], { cwd: tmpdir(), timeoutMs: 20_000 }).catch((e: Error) => ({ code: -1, stdout: '', stderr: e.message }));
    if (v.code !== 0) throw new UsageError(`Helix isn't set up: it runs on ${AGENT_NAME[who]}, and \`${config.agents[who].command}\` doesn't run here. Install it (helix-loop doctor), or pick the other: helix-loop helix agent assistant ${who === 'claude' ? 'codex' : 'claude'}.`);
    const app = await appFor(root);
    const ac = new AbortController();
    const onSig = () => ac.abort();
    process.once('SIGINT', onSig);
    try {
      const about = str(ctx.opts, 'about')?.split(',').map((s) => s.trim()).filter(Boolean);
      const t = await app.post<Thread>('/api/converse', { text, ...(about?.length ? { about } : {}) });
      if (ctx.interactive) ctx.err(`Asked Helix (${AGENT_NAME[who]}); waiting for its answer…`);
      const until = Date.now() + 16 * 60_000;
      for (;;) {
        await new Promise((r) => setTimeout(r, 1000));
        if (ac.signal.aborted) throw new UsageError(`Stopped waiting. Helix's answer will be in the app, in the conversation ${t.key}.`, 130);
        const now = await app.get<Thread>(`/api/thread?key=${encodeURIComponent(t.key)}`);
        const said = answerOf(now);
        if (said) {
          for (const m of said) {
            if (m.kind === 'proposal') ctx.out(`Helix proposes a task: ${fit(m.task?.title ?? m.text, 80)} (accept it in the app)`);
            else for (const l of wrap(m.text, 0)) ctx.out(l);
          }
          ctx.out('');
          ctx.out(`(conversation ${t.key}, in the app's Helix tab)`);
          return said.some((m) => /^I couldn't answer:/.test(m.text)) ? 1 : 0;
        }
        if (Date.now() > until) throw new UsageError(`Helix hasn't answered in 16 minutes; its answer will be in the app, in ${t.key}.`);
      }
    } finally {
      process.off('SIGINT', onSig);
      await app.close();
    }
  },
});

export const HELIX_COMMANDS = [pilot, pilotActive, pilotAuto, rules, ruleUndo, monitor, monitorOn, monitorOff, monitorLevel, monitorCap, agent, ask];
