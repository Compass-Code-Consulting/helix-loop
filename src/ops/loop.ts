import { spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { BIN, loadConfig, paths } from '../config.ts';
import { loadPlan } from '../plan/store.ts';
import { AGENTS, type AgentName } from '../types.ts';
import { runningTasks } from '../app/actions.ts';
import { applyToText, checkConfig, configFile, type ChangeSet } from '../app/config.ts';
import { health } from '../app/health.ts';
import type { PlanChange } from '../app/incidents.ts';
import { loopStatus, snapshot } from '../app/state.ts';
import { OpError, type Actor } from './actor.ts';

// The loop from outside it: starting it as its own process, stopping or pausing it, and stopping one pass. The
// loop reads each of these from a file in runs/ on its next round, so either side can restart without the other.

export function stopLoop(root: string): void {
  if (!loopStatus(root, []).running) throw new OpError(409, 'the loop is not running');
  mkdirSync(paths(root).runs, { recursive: true });
  writeFileSync(paths(root).stopFile, '');
}

// While runs/PAUSE exists no new pass starts, and the loop waits instead of exiting.
export function setPaused(root: string, paused: boolean, actor: Actor): void {
  mkdirSync(paths(root).runs, { recursive: true });
  if (paused) writeFileSync(paths(root).pause, `paused by ${actor.by}, ${actor.where}\n`);
  else rmSync(paths(root).pause, { force: true });
}

// Stops one pass: its work is kept and the task goes back to ready, or waits for a person, with the note.
export function stopPass(root: string, task: string, o: { to?: 'ready' | 'needs_human'; note?: string; why: string }): void {
  if (!runningTasks(root, loadPlan(paths(root).tasks, paths(root).human)).has(task)) throw new OpError(409, `${task} has no pass in flight`);
  const note = o.note?.trim() ? o.note.trim().slice(0, 2000) : undefined;
  writeStopRequest(root, task, { to: o.to === 'needs_human' ? 'needs_human' : 'ready', ...(note ? { note } : {}), why: o.why });
}

// A stop request the loop picks up (runs/stop-pass/<task>.json), written whole: a temp name, then a rename.
export function writeStopRequest(root: string, task: string, r: { to: 'ready' | 'needs_human'; note?: string; why?: string }): void {
  const dir = paths(root).stopPass;
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.${task}.tmp`);
  writeFileSync(tmp, JSON.stringify({ at: new Date().toISOString(), ...r }));
  renameSync(tmp, join(dir, `${task}.json`));
}

// Starts the loop as a process of its own, on the project (`which` real) or on a fresh dry run of it, with a
// config change set or plan changes tried in the dry run first. Its output goes to a log in runs/, outside the
// dry run's root, which each dry run replaces.
export async function startLoop(root: string, which: 'real' | 'dry', o: { agents: AgentName[]; maxPasses?: number; configChanges?: ChangeSet[]; planChanges?: PlanChange[] }): Promise<{ pid?: number; log: string }> {
  const dry = paths(root).dryRun;
  if (which === 'real' && loopStatus(root, snapshot(root).events).running) throw new OpError(409, 'the loop is already running');
  if (which === 'dry' && loopStatus(dry, existsSync(paths(dry).ledger) ? snapshot(dry).events : []).running) throw new OpError(409, 'a dry run is already running');
  const agents = o.agents.filter((a) => (AGENTS as readonly string[]).includes(a));
  if (!agents.length) throw new OpError(400, 'pick at least one agent');
  if (which === 'real') {
    // Builders only on a subscription, installed and working: the same check the loop makes before each pass.
    const h = await health(loadConfig(root));
    const bad = agents.filter((a) => !h.find((x) => x.agent === a)?.builder);
    if (bad.length) throw new OpError(409, `${bad.join(' and ')} can't build: see Settings › Agents, or \`helix-loop doctor\``);
  }
  const max = Number(o.maxPasses);
  let changesFile: string | undefined;
  if (which === 'dry' && o.configChanges?.length) {
    // Checked now against the real config, so a bad value fails here rather than in the dry run's log.
    checkConfig(root, applyToText(readFileSync(configFile(root), 'utf8'), o.configChanges));
    changesFile = join(paths(root).runs, 'dry-run-config.json');
    writeFileSync(changesFile, JSON.stringify(o.configChanges));
  }
  let planFile: string | undefined;
  if (which === 'dry' && o.planChanges?.length) {
    planFile = join(paths(root).runs, 'dry-run-plan.json');
    writeFileSync(planFile, JSON.stringify(o.planChanges));
  }
  mkdirSync(paths(root).runs, { recursive: true });
  const args = [BIN, 'run', '--root', root, '--agents', agents.join(','), ...(max > 0 ? ['--max-passes', String(Math.floor(max))] : []), ...(which === 'dry' ? ['--dry-run'] : []), ...(changesFile ? ['--config-changes', changesFile] : []), ...(planFile ? ['--plan-changes', planFile] : [])];
  const logFile = join(paths(root).runs, which === 'dry' ? 'dry-run.log' : 'loop.log');
  const fd = openSync(logFile, 'a');
  const child = spawn(process.execPath, args, { cwd: root, detached: true, stdio: ['ignore', fd, fd] });
  child.unref();
  closeSync(fd);
  return { pid: child.pid, log: relative(root, logFile) };
}
