import { readFileSync } from 'node:fs';
import { FEEDBACK_KINDS, loadConfig, type Config, type FeedbackKind } from '../config.ts';
import { AGENTS, type AgentName } from '../types.ts';
import { applyChangeSet, applyToText, checkConfig, configFile, type ChangeSet } from '../app/config.ts';
import { OpError, type Actor } from './actor.ts';

// The loop's settings (spec §6.8): a change set of config values, written into config.yaml with its comments
// kept, checked as the loop loads it, and committed; and where each kind of builder feedback goes (spec §10).

export function parseChangeSet(raw: unknown): ChangeSet[] {
  if (!Array.isArray(raw) || !raw.length) throw new OpError(400, 'nothing to apply');
  return raw.map((c: { key?: unknown; value?: unknown }) => ({ key: String(c.key), value: c.value }));
}

export const applyConfig = (root: string, changes: ChangeSet[], actor: Actor) => applyChangeSet(root, changes, actor.by, actor.where);

// The config as it would be with these changes, loaded as the loop would load it; throws what is wrong.
export function checkConfigChanges(root: string, changes: ChangeSet[]): Config {
  return checkConfig(root, changes.length ? applyToText(readFileSync(configFile(root), 'utf8'), changes) : readFileSync(configFile(root), 'utf8'));
}

export const FEEDBACK_FIELDS = ['send_to', 'after', 'pause', 'notify'] as const;
export type FeedbackField = (typeof FEEDBACK_FIELDS)[number];

// One kind's rule, for every lane or for one lane.
export async function setFeedback(root: string, kind: string, rule: { send_to?: string; after?: string; pause?: boolean; notify?: boolean }, lane: string | undefined, actor: Actor) {
  if (!(FEEDBACK_KINDS as readonly string[]).includes(kind)) throw new OpError(400, `not a feedback kind: ${kind} (one of ${FEEDBACK_KINDS.join(', ')})`);
  const base = lane ? `feedback.lanes.${repoArg(loadConfig(root), lane)}.${kind as FeedbackKind}` : `feedback.${kind}`;
  const changes: ChangeSet[] = [];
  if (rule.send_to !== undefined) {
    if (!['inbox', 'helix', 'off'].includes(rule.send_to)) throw new OpError(400, 'send_to is inbox, helix or off');
    changes.push({ key: `${base}.send_to`, value: rule.send_to });
  }
  if (rule.after !== undefined) {
    if (!/^(first|task:\d{1,2}|tasks:\d{1,3})$/.test(rule.after)) throw new OpError(400, 'after is first, task:N (N times on one task) or tasks:N (on N tasks)');
    changes.push({ key: `${base}.after`, value: rule.after });
  }
  if (rule.pause !== undefined) changes.push({ key: `${base}.pause`, value: rule.pause });
  if (rule.notify !== undefined) changes.push({ key: `${base}.notify`, value: rule.notify });
  return applyChangeSet(root, changes, actor.by, actor.where);
}

export function repoArg(config: Config, r: unknown): string {
  if (!config.repos[String(r)]) throw new OpError(400, `not a repo: ${String(r)}`);
  return String(r);
}

export function agentArg(a: unknown): AgentName {
  if (!(AGENTS as readonly string[]).includes(String(a))) throw new OpError(400, `not an agent: ${String(a)}`);
  return a as AgentName;
}
