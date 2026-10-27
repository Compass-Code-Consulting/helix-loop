import { existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { localDay } from '../agents/quota.ts';
import { loadConfig, MONITOR_LEVELS, monitorOf, paths, type MonitorLevel } from '../config.ts';
import { readLedger } from '../ledger.ts';
import type { AgentName } from '../types.ts';
import { commit } from '../app/actions.ts';
import { undoChange } from '../app/changes.ts';
import { applyChangeSet, type ChangeSet } from '../app/config.ts';
import { health } from '../app/health.ts';
import { monitorSpentToday, type HelixRole } from '../app/helix.ts';
import { appendHitl, readHitl, readRules, REQUESTS, writeRules, type Rule } from '../app/hitl.ts';
import { estimateLevels, monitorTurnCosts } from '../app/monitor.ts';
import { loadSettings, saveSettings } from '../app/settings.ts';
import { readReports } from '../app/state.ts';
import { OpError, signed, type Actor } from './actor.ts';

// Helix's side of the project: pilot mode, the rules the owner's ratings taught it, which agent runs each of its
// roles, and its monitor's level and cap. Rules and the monitor's settings are the project's (in git); the agents
// are this machine's (.helix/app.yaml), since they depend on what is installed and signed in here.

// ---- rules ----

export async function addRule(root: string, r: Omit<Rule, 'id' | 'at'>, actor: Actor): Promise<Rule> {
  const rules = readRules(root);
  const rule: Rule = { id: `R-${Math.max(0, ...rules.map((x) => Number(x.id.slice(2)) || 0)) + 1}`, at: new Date().toISOString(), ...r };
  const file = writeRules(root, [...rules.filter((x) => x.name.toLowerCase() !== r.name.toLowerCase()), rule]);
  await commitFile(root, file, `Helix: rule ${rule.id}, ${rule.decide === 'helix' ? 'decide' : 'always ask about'} "${rule.name}" (${signed(actor)})`);
  return rule;
}

// ▲ Keep asking / ▼ Decide these yourself (spec §7.3), on a kind of request Helix named.
export async function rate(root: string, r: { name: string; request?: string; decide: 'helix' | 'ask'; from?: string }, actor: Actor): Promise<Rule> {
  const name = r.name.trim();
  if (name.length < 3) throw new OpError(400, 'name the kind of request');
  const request = REQUESTS.find((x) => x.kind === r.request)?.kind;
  if (request === 'release' || request === 'human_done') throw new OpError(409, 'releases and human tasks always wait for you; no rating changes that');
  return addRule(root, { name: name.slice(0, 80), request, decide: r.decide, from: r.from }, actor);
}

export async function undoRule(root: string, id: string, actor: Actor): Promise<{ rules: Rule[] }> {
  const rules = readRules(root);
  const next = rules.filter((r) => r.id !== id);
  if (next.length === rules.length) throw new OpError(404, 'no such rule');
  await commitFile(root, writeRules(root, next), `Helix: rule ${id} removed (${signed(actor)})`);
  return { rules: next };
}

// Agree, Undo or Always ask, on what Helix resolved on the owner's behalf (spec §7.4). `home` holds the rules.
export async function rateResolved(root: string, home: string, ids: string[], rating: 'agree' | 'undo' | 'always_ask', actor: Actor): Promise<{ rated: number }> {
  const { records } = readHitl(paths(root).hitl);
  for (const id of ids) {
    const rec = records.find((r) => r.id === id);
    if (!rec) throw new OpError(404, `no record ${id}`);
    if (rating === 'undo' && rec.change) await undoChange(root, rec.change, Date.now(), actor);
    if (rating === 'always_ask') await addRule(home, { name: rec.name ?? rec.request, request: rec.request, decide: 'ask', from: id }, actor);
    appendHitl(paths(root).hitl, { type: 'rated', id, at: new Date().toISOString(), rating });
  }
  return { rated: ids.length };
}

async function commitFile(root: string, file: string, message: string): Promise<boolean> {
  if (!existsSync(join(root, '.git'))) return false;
  return commit(root, [relative(root, file)], message).catch(() => false);
}

// ---- pilot mode ----

export const ACTIVE_LEVELS = ['cautious', 'prudent', 'intrepid'] as const;
export const AUTO_LEVELS = ['intrepid', 'yolo'] as const;

// Pilot mode applies at once: one commit of config.yaml's pilot section.
export async function setPilot(root: string, p: { mode?: 'active' | 'auto'; active_level?: string; auto_level?: string; record?: boolean }, actor: Actor) {
  const changes: ChangeSet[] = [];
  if (p.mode !== undefined) {
    if (p.mode !== 'active' && p.mode !== 'auto') throw new OpError(400, 'pilot mode is active or auto');
    changes.push({ key: 'pilot.mode', value: p.mode });
  }
  if (p.active_level !== undefined) {
    if (!(ACTIVE_LEVELS as readonly string[]).includes(p.active_level)) throw new OpError(400, `Active pilot's level is ${ACTIVE_LEVELS.join(', ')}`);
    changes.push({ key: 'pilot.active_level', value: p.active_level });
  }
  if (p.auto_level !== undefined) {
    if (!(AUTO_LEVELS as readonly string[]).includes(p.auto_level)) throw new OpError(400, `Auto-pilot's level is ${AUTO_LEVELS.join(' or ')}`);
    changes.push({ key: 'pilot.auto_level', value: p.auto_level });
  }
  if (p.record !== undefined) changes.push({ key: 'pilot.record', value: p.record });
  return applyChangeSet(root, changes, actor.by, actor.where);
}

// ---- Helix's agents and its monitor ----

// The agent each role runs on: this machine's choice, else the config's for the monitor, else Claude Code.
export function helixAgentOf(root: string, role: HelixRole): AgentName {
  const s = loadSettings(paths(root).appSettings).helix;
  return (role === 'monitor' ? (s?.monitor ?? loadConfig(root).helix?.monitor?.agent) : s?.assistant) ?? 'claude';
}

// Picks the agent for one role or both; each must be able to run Helix here (installed, a subscription or a key,
// working), which health checks with one tiny request.
export async function setHelixAgents(root: string, roles: Partial<Record<HelixRole, AgentName>>): Promise<{ assistant?: AgentName; monitor?: AgentName }> {
  const file = paths(root).appSettings;
  const s = loadSettings(file);
  const next = { ...(s.helix ?? {}) };
  for (const role of ['assistant', 'monitor'] as const) {
    const agent = roles[role];
    if (agent === undefined) continue;
    const h = (await health(loadConfig(root))).find((x) => x.agent === agent);
    if (!h) throw new OpError(400, `not an agent: ${agent}`);
    if (!h.helix) throw new OpError(409, `${agent} can't run Helix yet: it needs to be installed, signed in or given a key, and working`);
    next[role] = agent;
  }
  saveSettings(file, { ...s, helix: next });
  return next;
}

// The monitor on or off, its level, and its daily cap (null: back to the level's own), as one commit.
export async function setMonitor(root: string, m: { enabled?: boolean; level?: string; budget?: number | null }, actor: Actor): Promise<{ committed: boolean } | undefined> {
  const changes: ChangeSet[] = [];
  if (m.enabled !== undefined) changes.push({ key: 'helix.monitor.enabled', value: m.enabled });
  if (m.level !== undefined) {
    if (!(MONITOR_LEVELS as readonly string[]).includes(m.level)) throw new OpError(400, `the monitor's level is ${MONITOR_LEVELS.join(', ')}`);
    changes.push({ key: 'helix.monitor.level', value: m.level });
  }
  if (m.budget !== undefined) {
    if (m.budget !== null && !(typeof m.budget === 'number' && Number.isFinite(m.budget) && m.budget >= 0 && m.budget <= 500)) throw new OpError(400, 'the daily cap is between $0 and $500');
    changes.push({ key: 'helix.monitor.daily_budget_usd', value: m.budget });
  }
  if (!changes.length) return undefined;
  return applyChangeSet(root, changes, actor.by, actor.where);
}

// The monitor as Settings › Helix shows it: on or off, its level and agent, its cap and what it spent today, and
// what each level would have spent over the last day of the loop.
export function monitorStatus(root: string, now = Date.now()) {
  const config = loadConfig(root);
  const p = paths(root);
  const m = monitorOf(config);
  const agent = helixAgentOf(root, 'monitor');
  return {
    enabled: m.enabled,
    level: m.level as MonitorLevel,
    agent,
    assistant: helixAgentOf(root, 'assistant'),
    budgetUsd: m.budgetUsd,
    budgetSet: m.budgetSet,
    everyMinutes: m.everyMinutes,
    spentUsd: monitorSpentToday(p.helixTurns, localDay(now), localDay),
    estimate: estimateLevels({ config, agent, events: existsSync(p.ledger) ? readLedger(p.ledger) : [], reports: readReports(root), costs: monitorTurnCosts(p.helixTurns), now }),
  };
}
