import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { claudeAdapter } from '../../agents/claude.ts';
import { codexAdapter } from '../../agents/codex.ts';
import { applyToText } from '../../app/config.ts';
import { applyChanges } from '../../app/fixes.ts';
import { ownerOf } from '../../app/prompts.ts';
import { loopStatus, passesNow } from '../../app/state.ts';
import { buildBoard } from '../../app/board.ts';
import { boardInput } from '../../app/views.ts';
import { systemClock } from '../../clock.ts';
import { configPath, loadConfig, paths, projectInfo, weeklyTargets } from '../../config.ts';
import { prepareDryRun } from '../../dryrun.ts';
import { readLedger } from '../../ledger.ts';
import { EXIT, runLoop } from '../../loop.ts';
import { renderDependencyMap } from '../../map/render.ts';
import { VERSION_EVERY, writeVersion } from '../../metrics/archive.ts';
import { buildMetrics } from '../../metrics/model.ts';
import { taskHistory } from '../../metrics/render.ts';
import { macNotifier } from '../../notify.ts';
import { loadPlan } from '../../plan/store.ts';
import { describeBase, pendingApprovals } from '../../release.ts';
import { buildStats, formatStats } from '../../stats.ts';
import { AGENTS } from '../../types.ts';
import { define, str, UsageError } from '../command.ts';
import { currentMap, paceLine, when, shown } from '../shared.ts';

// Running the loop, and seeing where it is.

const run = define({
  name: 'run',
  group: 'The loop',
  summary: 'Run the loop: build the plan with the agents until it is done or stopped',
  description: `Runs passes in parallel, up to each agent's slots, the critical path first, never two in one area at once, and merges each pass that passes its repo's gate.
It paces each agent to last its subscription's week, and drops to one agent, or waits, when one reaches a limit.
It runs in the foreground; stop it gracefully with \`helix-loop stop\` (or Ctrl-C, which stops at once).
Exit codes: 0 every task is done, 10 only work that needs a person is left, 3 stopped, 1 an error.`,
  options: {
    'max-passes': { type: 'string', value: 'N', description: 'Stop after N passes' },
    agents: { type: 'string', value: 'list', description: 'The agents to run this time, comma-separated (claude, codex); overrides agents.*.enabled' },
    'dry-run': { type: 'boolean', description: 'Run on a copy of the plan in .helix/runs/dry-run/, with fake agents and throwaway repos' },
    'config-changes': { type: 'string', value: 'file', description: 'With --dry-run: a config change set (JSON) applied to the dry run first' },
    'plan-changes': { type: 'string', value: 'file', description: 'With --dry-run: plan changes (JSON, as a fix holds them) applied to the dry run first' },
  },
  examples: [
    ['helix-loop run', 'Build until everything is done'],
    ['helix-loop run --agents codex --max-passes 10', 'Run only Codex, for ten passes'],
    ['helix-loop run --dry-run', 'Watch the loop work a copy of the plan with fake agents'],
  ],
  async run({ root, opts, out }) {
    const dry = opts['dry-run'] ? prepareDryRun(root) : undefined;
    let config = dry ? dry.config : loadConfig(root);
    if (!dry && (opts['config-changes'] || opts['plan-changes'])) throw new UsageError('--config-changes and --plan-changes only try changes in a dry run: add --dry-run.');
    if (dry && opts['config-changes']) {
      const file = configPath(dry.root);
      writeFileSync(file, applyToText(readFileSync(file, 'utf8'), JSON.parse(readFileSync(str(opts, 'config-changes')!, 'utf8'))));
      config = loadConfig(dry.root);
      out(`with the config change set from ${str(opts, 'config-changes')}`);
    }
    if (dry && opts['plan-changes']) {
      const r = await applyChanges(dry.root, JSON.parse(readFileSync(str(opts, 'plan-changes')!, 'utf8')), { what: 'the fix tried in this dry run', by: ownerOf(root) });
      out(`with a fix applied: ${r.tasks.join(', ') || 'no task changed'}`);
    }
    if (dry) {
      Object.assign(process.env, dry.env);
      out(`dry run in ${shown(dry.root)}, with the fake CLIs`);
    }
    const agents = str(opts, 'agents');
    if (agents !== undefined) {
      const chosen = agents.split(',').map((a) => a.trim()).filter(Boolean);
      const unknown = chosen.filter((a) => !(AGENTS as readonly string[]).includes(a));
      if (!chosen.length || unknown.length) throw new UsageError(`--agents takes ${AGENTS.join(', ')} or both, comma-separated; not ${agents}.`);
      for (const a of AGENTS) config.agents[a].enabled = chosen.includes(a);
    }
    const ac = new AbortController();
    for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => ac.abort());
    return runLoop({
      config,
      paths: paths(dry ? dry.root : root),
      clock: systemClock,
      adapters: {
        claude: claudeAdapter(config.agents.claude, config),
        codex: dry ? codexAdapter(config.agents.codex, config, dry.codexHome) : codexAdapter(config.agents.codex, config),
      },
      notify: macNotifier(config.notify.macos, projectInfo(config).name),
      renderMap: renderDependencyMap,
      log: (line) => out(`${new Date().toLocaleTimeString()} ${line}`),
      maxPasses: opts['max-passes'] ? Number(str(opts, 'max-passes')) : undefined,
      signal: ac.signal,
    });
  },
});

const stop = define({
  name: 'stop',
  group: 'The loop',
  summary: 'Stop the loop gracefully: no new passes, and it exits once the running ones end',
  run({ root, out }) {
    const p = paths(root);
    if (!loopStatus(root, readLedger(p.ledger)).running) throw new UsageError('The loop is not running.');
    mkdirSync(p.runs, { recursive: true });
    writeFileSync(p.stopFile, '');
    out('Stopping: the loop starts no new passes and exits when the running ones end.');
  },
});

const pause = define({
  name: 'pause',
  group: 'The loop',
  summary: 'Pause new passes; running passes finish, and the loop waits instead of exiting',
  run({ root, out }) {
    const p = paths(root);
    mkdirSync(p.runs, { recursive: true });
    writeFileSync(p.pause, `paused by ${ownerOf(root)}, with helix-loop pause\n`);
    out('New passes are paused. Running passes finish. `helix-loop resume` starts them again.');
  },
});

const resume = define({
  name: 'resume',
  group: 'The loop',
  summary: 'Let the loop start new passes again',
  run({ root, out }) {
    rmSync(paths(root).pause, { force: true });
    out('New passes can start again.');
  },
});

const status = define({
  name: 'status',
  group: 'The loop',
  summary: 'One screen: the loop, the passes in flight, the tasks, the agents, the finish',
  json: true,
  run({ root, json, out }) {
    const p = paths(root);
    const config = loadConfig(root);
    const info = projectInfo(config);
    const events = readLedger(p.ledger);
    const plan = loadPlan(p.tasks, p.human);
    const loop = loopStatus(root, events);
    const m = currentMap(root);
    const board = buildBoard(boardInput(root, plan, events, config, Date.now()));
    const passes = passesNow(root, plan, loop);
    const approvals = pendingApprovals(p.approvals).map((x) => x.approval);
    const holds = Object.entries(config.release.hold_until ?? {}).flatMap(([repo, step]) => (plan.human.get(step!)?.status === 'done' ? [] : [{ repo, until: step!, status: plan.human.get(step!)?.status ?? 'not in the plan' }]));
    if (json) {
      return out(JSON.stringify({ project: info, loop, passes, totals: m.totals, agents: m.agents, criticalPath: m.criticalPath.length, finish: board.finish, codeFinish: board.codeFinish, holds, approvals }, null, 2));
    }
    const t = m.totals;
    out(`${info.name}: ${loop.running ? `the loop is running (${loop.mode}${loop.stopping ? ', stopping' : ''}${loop.modeDetail ? `: ${loop.modeDetail}` : ''})` : 'the loop is stopped'}${loop.running ? '' : loop.lastExit ? `, last exit ${when(Date.parse(loop.lastExit.at), info.timezone)}${loop.lastExit.detail ? `: ${loop.lastExit.detail}` : ''}` : ''}`);
    for (const x of passes) out(`  ${x.task} on ${x.agent}, attempt ${x.attempt}: ${x.phase}${x.title ? ` · ${x.title}` : ''}`);
    out(`tasks ${t.tasks}: ${t.done} done, ${t.ready} ready, ${t.claimed} in a pass, ${t.needsHuman} need a person, ${t.parked} parked`);
    for (const a of m.agents) {
      out(`${a.name} (${a.model}): ${a.state}${a.resetAt ? ` until ${a.resetAt}` : ''}`);
      const line = paceLine(root, a.name);
      if (line) out(`  ${line}`);
    }
    out(`critical path: ${m.criticalPath.length} steps; ${board.codeFinish !== undefined ? `code complete ${when(board.codeFinish, info.timezone)} · project complete ${when(board.finish, info.timezone)}` : `projected finish ${when(board.finish, info.timezone)}`}`);
    for (const h of holds) out(`${h.repo}: releases held until ${h.until} is done (${h.status})`);
    for (const a of approvals) {
      out(`${a.repo} ${a.tag} waits for approval: it changes ${a.paths.join(', ')} since ${describeBase(a.since)}`);
      out(`  approve: helix-loop release approve ${a.repo} ${a.tag}`);
    }
  },
});

const stats = define({
  name: 'stats',
  group: 'The loop',
  summary: 'How the build has used each agent: working, gating, limited, idle, and what it cost',
  run({ root, out }) {
    const p = paths(root);
    const holding = [...loadPlan(p.tasks, p.human).tasks.values()].filter((x) => x.status === 'claimed' && x.claimed_by).map((x) => x.claimed_by!);
    for (const line of formatStats(buildStats(readLedger(p.ledger), AGENTS, Date.now(), holding), projectInfo(loadConfig(root)).timezone)) out(line);
  },
});

const metrics = define({
  name: 'metrics',
  group: 'The loop',
  summary: 'Write a version of the metrics page now',
  description: `Writes the metrics page as a new version in .helix/runs/metrics/ (open its index.html): progress and its projection, where the time goes, cost, and what fails.
The loop writes one every metrics_every_passes passes on its own and keeps each as it was.`,
  run({ root, out }) {
    const p = paths(root);
    const config = loadConfig(root);
    const info = projectInfo(config);
    const plan = loadPlan(p.tasks, p.human);
    const v = writeVersion(p.metrics, buildMetrics({ events: readLedger(p.ledger), plan, now: Date.now(), history: taskHistory(root), targets: weeklyTargets(config), timeZone: info.timezone, product: info.name }), config.metrics_every_passes ?? VERSION_EVERY);
    out(shown(join(p.metrics, v.file)));
  },
});

export { EXIT };
export const LOOP_COMMANDS = [run, stop, pause, resume, status, stats, metrics];
