import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describePace, loadQuota, mapAgents, paceSlots } from '../agents/quota.ts';
import { loadConfig, paths } from '../config.ts';
import { meanPassHours, readLedger } from '../ledger.ts';
import { computeMap } from '../map/graph.ts';
import { loadPlan } from '../plan/store.ts';
import type { MapModel } from '../types.ts';

// What several commands need: the dependency map as the plan stands, and each agent's pace.

export function currentMap(root: string): MapModel {
  const p = paths(root);
  const config = loadConfig(root);
  const plan = loadPlan(p.tasks, p.human);
  const quota = loadQuota(p.agentsState, Date.now());
  const map = computeMap(plan, {
    now: Date.now(),
    passHours: meanPassHours(readLedger(p.ledger)),
    // What each agent holds, as the plan's claims say.
    agents: mapAgents(config, quota, [...plan.tasks.values()].flatMap((t) => (t.status === 'claimed' && t.claimed_by ? [{ agent: t.claimed_by, task: t.id }] : [])), Date.now()),
    mode: 'idle',
  });
  return { ...map, lanes: Object.keys(config.repos), product: config.project?.name, owner: config.project?.owner };
}

// One line about an agent's weekly pace, or nothing when its usage hasn't been read.
export function paceLine(root: string, agent: 'claude' | 'codex'): string | undefined {
  const config = loadConfig(root);
  const q = loadQuota(paths(root).agentsState, Date.now())[agent];
  const pace = paceSlots(q.usage, config.agents[agent].slots, Date.now(), config.agents[agent].weekly_target);
  return describePace(q.usage, pace, config.agents[agent].weekly_target, Date.now()) || undefined;
}

// Dates as people read them, in the project's time zone.
export const when = (ms: number, timeZone?: string) => new Date(ms).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone });

// A path to show: relative when it is under the current folder, else whole.
export const shown = (file: string) => {
  const rel = relative(process.cwd(), file);
  return rel && !rel.startsWith('..') ? rel : file;
};

// The repos' checkouts sit in the project folder, each a repository of its own: the project's git ignores them,
// so its commits hold the plan and never the code. Appends what .gitignore lacks; returns what it added.
export function ignoreRepos(root: string, repos: string[]): string[] {
  const file = join(root, '.gitignore');
  const had = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const lines = new Set(had.split('\n').map((l) => l.trim()));
  const add = repos.map((r) => `/${r}/`).filter((l) => !lines.has(l) && !lines.has(l.slice(1)));
  if (!add.length) return [];
  writeFileSync(file, `${had}${had && !had.endsWith('\n') ? '\n' : ''}${had.includes('# The repos Helix Loop builds') ? '' : '# The repos Helix Loop builds: repositories of their own.\n'}${add.join('\n')}\n`);
  return add;
}
