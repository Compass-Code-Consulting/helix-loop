import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { isMap, isSeq, parseDocument } from 'yaml';
import { configPath, loadConfig, paths, type Config } from '../config.ts';
import { atomicWrite } from '../plan/store.ts';
import { commit } from './actions.ts';
import { ownerOf } from './prompts.ts';

// Settings › Loop controls (spec §6.8): every value the loop runs with that the page may change, where it lives
// in harness/config.yaml, what it does, and how to check a new value. Edits collect in a change set and are
// applied together: written into the file in place (its comments kept), checked by loading it as the loop
// would, and committed. The loop reads the file at the start of its next round, so nothing in flight is cut.

export type ControlType = 'int' | 'usd' | 'bool' | 'list' | 'model' | 'effort' | 'text';

export interface Control {
  key: string; // dotted path into config.yaml
  group: string;
  label: string;
  note: string;
  type: ControlType;
  unit?: string;
  min?: number;
  max?: number;
  options?: string[];
}

export const GROUPS = [
  { id: 'agents', title: 'Agents and slots', keys: 'agents.*' },
  { id: 'passes', title: 'Passes', keys: 'limits.*' },
  { id: 'gate', title: 'Gate', keys: 'limits.gate_*' },
  { id: 'spend', title: 'Spend', keys: 'limits.daily_budget_usd' },
  { id: 'merge', title: 'Merge and push', keys: 'push, union_merge_paths' },
  { id: 'safety', title: 'Safety and releases', keys: 'forbidden_paths, release' },
] as const;

export const EFFORTS = ['low', 'medium', 'high', 'xhigh'];

export const CONTROLS: Control[] = [
  { key: 'agents.claude.slots', group: 'agents', label: 'Claude Code slots', note: 'Passes at once', type: 'int', min: 0, max: 6 },
  { key: 'agents.codex.slots', group: 'agents', label: 'Codex slots', note: 'Passes at once', type: 'int', min: 0, max: 6 },
  { key: 'agents.claude.weekly_target', group: 'agents', label: 'Claude Code weekly target', note: 'Share of the weekly window to have used by its reset', type: 'int', unit: '%', min: 10, max: 100 },
  { key: 'agents.codex.weekly_target', group: 'agents', label: 'Codex weekly target', note: 'Share of the weekly window to have used by its reset', type: 'int', unit: '%', min: 10, max: 100 },
  { key: 'agents.claude.models.build', group: 'agents', label: 'Claude Code build', note: 'Model and effort for build passes', type: 'model' },
  { key: 'agents.codex.models.build', group: 'agents', label: 'Codex build', note: 'Model and effort for build passes', type: 'model' },
  { key: 'limits.pass_timeout_minutes', group: 'passes', label: 'Pass timeout', note: 'A pass running longer is stopped and its work kept', type: 'int', unit: 'min', min: 10, max: 240 },
  { key: 'limits.max_attempts', group: 'passes', label: 'Attempts before needs-you', note: 'Then the task comes to you or to Helix', type: 'int', min: 1, max: 10 },
  { key: 'limits.max_conflicts', group: 'passes', label: 'Conflicts before needs-you', note: "A conflict doesn't use an attempt", type: 'int', min: 1, max: 10 },
  { key: 'limits.prompt_budget_bytes', group: 'passes', label: 'Prompt budget', note: 'Largest build prompt the loop sends', type: 'int', unit: 'KB', min: 10, max: 200 },
  { key: 'limits.gate_timeout_minutes', group: 'gate', label: 'Gate timeout', note: 'A gate running longer fails', type: 'int', unit: 'min', min: 5, max: 120 },
  { key: 'limits.concurrent_gates', group: 'gate', label: 'Gates at once', note: 'Heavy local work: browser tests', type: 'int', min: 1, max: 6 },
  { key: 'e2e_runner.concurrency', group: 'gate', label: 'Browser test runs at once', note: "Builders' own runs, through the e2e runner", type: 'int', min: 1, max: 6 },
  { key: 'e2e_runner.timeout_minutes', group: 'gate', label: 'Browser test timeout', note: 'One run of a repo’s browser tests', type: 'int', unit: 'min', min: 5, max: 60 },
  { key: 'limits.daily_budget_usd.claude', group: 'spend', label: 'Claude Code per day', note: 'Notional list price; stops a runaway', type: 'usd', min: 0, max: 100_000 },
  { key: 'limits.daily_budget_usd.codex', group: 'spend', label: 'Codex per day', note: 'Notional list price; stops a runaway', type: 'usd', min: 0, max: 100_000 },
  { key: 'limits.unknown_reset_backoff_minutes.max', group: 'spend', label: 'Unknown reset backoff', note: 'Longest wait when a limit gives no reset time', type: 'int', unit: 'min', min: 5, max: 600 },
  { key: 'limits.suspension_threshold_seconds', group: 'spend', label: 'Suspension threshold', note: 'Detects a sleeping laptop', type: 'int', unit: 's', min: 5, max: 600 },
  { key: 'push', group: 'merge', label: 'Push after each merge', note: 'Once the repo has a remote', type: 'bool' },
  { key: 'union_merge_paths', group: 'merge', label: 'Union-merged files', note: 'Rebases keep both sides', type: 'list' },
  { key: 'forbidden_paths', group: 'safety', label: 'Forbidden paths', note: 'A pass touching them is refused', type: 'list' },
  { key: 'agent_network.allowed_domains', group: 'safety', label: 'Network allowlist', note: 'Claude Code sandbox only', type: 'list' },
  { key: 'release.every_merged_tasks', group: 'safety', label: 'Release every', note: 'Or when a stage closes', type: 'int', unit: 'merged', min: 1, max: 10_000 },
  { key: 'release.review_paths', group: 'safety', label: 'Review before tagging', note: 'Always asks, at every pilot level', type: 'list' },
];

// Values as the page edits them: the file's own, except percentages and kilobytes.
export function getValue(config: Config, c: Control): unknown {
  let v: unknown = config;
  for (const k of c.key.split('.')) v = (v as Record<string, unknown> | undefined)?.[k];
  if (c.unit === '%' && typeof v === 'number') return Math.round(v * 100);
  if (c.unit === 'KB' && typeof v === 'number') return Math.round(v / 1000);
  return v;
}

function toFile(c: Control, v: unknown): unknown {
  if (c.unit === '%') return Number(v) / 100;
  if (c.unit === 'KB') return Number(v) * 1000;
  return v;
}

export class ConfigEditError extends Error {}

// Checks one value against its control; returns it as the page will show it.
export function checkValue(c: Control, v: unknown): unknown {
  switch (c.type) {
    case 'int':
    case 'usd': {
      const n = Number(v);
      if (!Number.isFinite(n) || (c.type === 'int' && !Number.isInteger(n))) throw new ConfigEditError(`${c.label}: ${String(v)} is not a ${c.type === 'int' ? 'whole number' : 'number'}`);
      if ((c.min !== undefined && n < c.min) || (c.max !== undefined && n > c.max)) throw new ConfigEditError(`${c.label} is between ${c.min} and ${c.max}`);
      return n;
    }
    case 'bool':
      if (typeof v !== 'boolean') throw new ConfigEditError(`${c.label} is on or off`);
      return v;
    case 'list':
      if (!Array.isArray(v) || v.some((x) => typeof x !== 'string' || !x.trim())) throw new ConfigEditError(`${c.label} is a list of non-empty lines`);
      if (c.key === 'release.review_paths' && !v.length) throw new ConfigEditError('Review before tagging needs at least one path: an empty list would release anything unreviewed');
      return v.map((x: string) => x.trim());
    case 'model': {
      const m = v as { model?: unknown; effort?: unknown };
      if (!m || typeof m.model !== 'string' || !/^[\w.-]+$/.test(m.model)) throw new ConfigEditError(`${c.label}: name a model`);
      if (!EFFORTS.includes(String(m.effort))) throw new ConfigEditError(`${c.label}: effort is one of ${EFFORTS.join(', ')}`);
      return { model: m.model, effort: m.effort };
    }
    default:
      return String(v);
  }
}

export interface ChangeSet {
  key: string;
  value: unknown;
}

// Writes a change set into a copy of the config text, keeping its comments and layout.
export function applyToText(text: string, changes: ChangeSet[]): string {
  const doc = parseDocument(text);
  for (const ch of changes) {
    const c = CONTROLS.find((x) => x.key === ch.key) ?? (ch.key.startsWith('pilot.') || ch.key.startsWith('feedback.') || ch.key.startsWith('helix.') ? ({ key: ch.key, type: 'text' } as Control) : undefined);
    if (!c) throw new ConfigEditError(`${ch.key} isn't a setting the app changes`);
    // null takes a setting out, back to its default: Helix's monitor cap, back to its level's.
    if (ch.value === null && c.type === 'text') {
      doc.deleteIn(ch.key.split('.'));
      continue;
    }
    const value = c.type === 'text' ? ch.value : toFile(c, checkValue(c, ch.value));
    const path = ch.key.split('.');
    // A flow map like `{ model: x, effort: y }` stays one: set its fields, not a new block.
    if (c.type === 'model') {
      const node = doc.getIn(path, true);
      if (isMap(node)) {
        node.set('model', (value as { model: string }).model);
        node.set('effort', (value as { effort: string }).effort);
        continue;
      }
    }
    const existing = doc.getIn(path, true);
    if (isSeq(existing) && Array.isArray(value)) {
      const flow = existing.flow;
      doc.setIn(path, doc.createNode(value, { flow }));
      continue;
    }
    doc.setIn(path, value);
  }
  return doc.toString({ lineWidth: 0 });
}

// The change set applied to a copy of harness/config.yaml and loaded as the loop loads it; throws what's wrong.
export function checkConfig(root: string, text: string): Config {
  const dir = mkdtempSync(join(tmpdir(), 'helix-config-'));
  try {
    const f = join(dir, 'config.yaml');
    writeFileSync(f, text);
    try {
      return loadConfig(root, f);
    } catch (e) {
      throw new ConfigEditError((e as Error).message);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export const configFile = (root: string) => configPath(root);

// Applies a change set to a root's config. In git it is committed, saying which keys changed.
export async function applyChangeSet(root: string, changes: ChangeSet[], by = ownerOf(root), where = 'in Helix Loop'): Promise<{ committed: boolean; text: string }> {
  if (!changes.length) throw new ConfigEditError('nothing to apply');
  const file = configFile(root);
  const text = applyToText(readFileSync(file, 'utf8'), changes);
  checkConfig(root, text);
  atomicWrite(file, text);
  const committed = existsSync(join(root, '.git')) ? await commit(root, [relative(root, file)], `Config: ${changes.map((c) => c.key).join(', ')} (${by}, ${where})`) : false;
  return { committed, text };
}

// What each setting is doing right now, in a few words, from the ledger and the agents' state.
export interface Effects {
  [key: string]: { text: string; warn?: boolean } | undefined;
}

export function effects(input: {
  config: Config;
  events: { kind: string; at: string; [k: string]: unknown }[];
  agents: { name: string; slots: number; paced?: number; spentUsd: number }[];
  now: number;
}): Effects {
  const { config, events, agents, now } = input;
  const day = new Date(now).toDateString();
  const today = events.filter((e) => new Date(e.at).toDateString() === day);
  const week = events.filter((e) => now - Date.parse(e.at) < 7 * 86_400_000);
  const passes = (es: typeof events) => es.filter((e) => e.kind === 'pass') as unknown as { outcome: string; durationMs: number; promptBytes?: number; gateMs?: number; phases?: { gateMs?: number }; failedStep?: string }[];
  const out: Effects = {};
  for (const a of agents) {
    const allowed = a.paced ?? a.slots;
    const target = config.agents[a.name as 'claude'].weekly_target;
    out[`agents.${a.name}.slots`] = { text: `${target ? `Weekly target ${Math.round(target * 100)}% · ` : ''}pace allows ${allowed} now${allowed < a.slots ? `, so ${a.slots - allowed === 1 ? `the ${ordinal(allowed + 1)}` : `${a.slots - allowed}`} wait${a.slots - allowed === 1 ? 's' : ''}` : ''}`, warn: allowed < a.slots };
    out[`limits.daily_budget_usd.${a.name}`] = { text: `$${Math.round(a.spentUsd)} today`, warn: a.spentUsd > 0.85 * config.limits.daily_budget_usd[a.name as 'claude'] };
  }
  for (const a of ['claude', 'codex'] as const) {
    const roles = config.agents[a].models;
    out[`agents.${a}.models.build`] = { text: `Design, plan and review use ${roles.review.model} · ${roles.review.effort}` };
  }
  const t = passes(today);
  const w = passes(week);
  const longest = Math.max(0, ...t.map((p) => p.durationMs));
  const timeouts = w.filter((p) => p.outcome === 'timeout').length;
  out['limits.pass_timeout_minutes'] = { text: `Longest pass today ${Math.round(longest / 60_000)} min${timeouts ? ` · ${timeouts} timed out this week` : ''}`, warn: timeouts > 0 };
  const failed = w.filter((p) => !['merged', 'quota', 'suspended', 'transient', 'stopped', 'conflict'].includes(p.outcome)).length;
  out['limits.max_attempts'] = { text: `${failed} counted attempts failed this week` };
  const prompt = Math.max(0, ...t.map((p) => p.promptBytes ?? 0));
  out['limits.prompt_budget_bytes'] = { text: prompt ? `Largest prompt today ${Math.round(prompt / 1000)} KB` : 'No pass today yet' };
  const gates = w.map((p) => p.phases?.gateMs ?? p.gateMs ?? 0).filter((x) => x > 0).sort((a, b) => a - b);
  if (gates.length) out['limits.gate_timeout_minutes'] = { text: `Median gate ${fmtMin(gates[Math.floor(gates.length / 2)]!)}` };
  const gateTimeouts = w.filter((p) => /timed out|timeout/.test(p.failedStep ?? '')).length;
  if (gateTimeouts) out['limits.concurrent_gates'] = { text: `${gateTimeouts} gate timeouts this week`, warn: true };
  const tampered = week.filter((e) => e.kind === 'pass' && (e as { outcome?: string }).outcome === 'forbidden_paths').length;
  out.forbidden_paths = { text: `${config.forbidden_paths.slice(0, 2).join(', ')}…${tampered ? ` · refused ${tampered} passes this week` : ''}`, warn: tampered > 0 };
  out['release.review_paths'] = { text: `${config.release.review_paths.join(', ')} · always asks, at every pilot level`, warn: true };
  out.union_merge_paths = { text: (config.union_merge_paths ?? []).join(', ') };
  return out;
}

const ordinal = (n: number) => `${n}${n === 1 ? 'st' : n === 2 ? 'nd' : n === 3 ? 'rd' : 'th'}`;
const fmtMin = (ms: number) => (ms < 60_000 ? `${Math.round(ms / 1000)} s` : `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`);

// The dry run's config, with a change set applied: "Try in dry run".
export function applyToDryRun(controlPlane: string, changes: ChangeSet[]): void {
  const root = paths(controlPlane).dryRun;
  const file = configFile(root);
  if (!existsSync(file)) throw new ConfigEditError('there is no dry run yet: start one first');
  const text = applyToText(readFileSync(file, 'utf8'), changes);
  checkConfig(root, text);
  atomicWrite(file, text);
}
