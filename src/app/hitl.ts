import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parse, stringify } from 'yaml';
import { FEEDBACK_KINDS, type ActiveLevel, type AutoLevel, type Config, type FeedbackKind, type FeedbackRule, type PilotConfig } from '../config.ts';
import { atomicWrite } from '../plan/store.ts';

// Pilot mode (spec §7): who resolves the decisions the loop would put to a person. On Active pilot Daniel is at
// his desk and Helix brings him what his level asks for; on Auto-pilot Helix resolves what it can and parks the
// rest. The decision table is data (config `pilot.table` overrides the default below), the rules Daniel's
// ratings taught Helix override the table (harness/helix/rules.yaml), and the floors override everything.

// The kinds of request the table knows, in the order the page lists them.
export const REQUESTS = [
  { kind: 'unsure', label: "A builder isn't sure how to proceed" },
  { kind: 'spec_plain', label: 'Spec question the spec answers plainly' },
  { kind: 'scope', label: 'Scope creep: a task grew' },
  { kind: 'compromise', label: 'Compromise forced by a constraint' },
  { kind: 'architecture', label: 'Change to the architecture' },
  { kind: 'failures', label: 'Repeated failures or a flaky test' },
  { kind: 'security', label: 'Anything touching security' },
  { kind: 'release', label: 'Release or approve a tag' },
  { kind: 'human_done', label: 'Mark a human task done' },
] as const;
export type RequestKind = (typeof REQUESTS)[number]['kind'];

export type Column = 'cautious' | 'prudent' | 'intrepid' | 'intrepid_auto' | 'yolo';
export const COLUMNS: Column[] = ['cautious', 'prudent', 'intrepid', 'intrepid_auto', 'yolo'];
// asks: Daniel decides, and the task waits for him. helix: Helix decides. parks: Helix parks the task until
// Daniel is back (Auto-pilot), and the rest of the loop goes on. always: a floor, at every level.
export type Decision = 'asks' | 'helix' | 'parks' | 'always' | 'daniel';

const row = (c: Decision, p: Decision, i: Decision, ia: Decision, y: Decision): Record<Column, Decision> => ({ cautious: c, prudent: p, intrepid: i, intrepid_auto: ia, yolo: y });
export const DEFAULT_TABLE: Record<RequestKind, Record<Column, Decision>> = {
  unsure: row('asks', 'helix', 'helix', 'helix', 'helix'),
  spec_plain: row('asks', 'helix', 'helix', 'helix', 'helix'),
  scope: row('asks', 'asks', 'helix', 'helix', 'helix'),
  compromise: row('asks', 'asks', 'helix', 'helix', 'helix'),
  architecture: row('asks', 'asks', 'asks', 'parks', 'helix'),
  failures: row('asks', 'asks', 'asks', 'parks', 'helix'),
  security: row('asks', 'asks', 'asks', 'parks', 'helix'),
  release: row('always', 'always', 'always', 'always', 'always'),
  human_done: row('daniel', 'daniel', 'daniel', 'daniel', 'daniel'),
};
// What no level and no rule lowers: these always wait for Daniel.
export const FLOORS: RequestKind[] = ['release', 'human_done'];

export const DEFAULT_PILOT: PilotConfig = { mode: 'active', active_level: 'prudent', auto_level: 'intrepid', record: true };

export function pilotOf(config: Config): PilotConfig {
  const p = config.pilot ?? {};
  const active = (['cautious', 'prudent', 'intrepid'] as ActiveLevel[]).includes(p.active_level as ActiveLevel) ? p.active_level! : DEFAULT_PILOT.active_level;
  const auto = (['intrepid', 'yolo'] as AutoLevel[]).includes(p.auto_level as AutoLevel) ? p.auto_level! : DEFAULT_PILOT.auto_level;
  return { mode: p.mode === 'auto' ? 'auto' : 'active', active_level: active, auto_level: auto, record: p.record !== false, table: p.table };
}

export function tableOf(pilot: PilotConfig): Record<RequestKind, Record<Column, Decision>> {
  const out = structuredClone(DEFAULT_TABLE);
  for (const [kind, cols] of Object.entries(pilot.table ?? {})) {
    if (!(kind in out) || FLOORS.includes(kind as RequestKind)) continue;
    for (const [c, d] of Object.entries(cols)) if (COLUMNS.includes(c as Column) && ['asks', 'helix', 'parks'].includes(d)) out[kind as RequestKind][c as Column] = d as Decision;
  }
  return out;
}

// The column in force: the mode's level, Intrepid on Auto-pilot being its own column (it parks where Active asks).
export function columnOf(pilot: PilotConfig): Column {
  if (pilot.mode === 'active') return pilot.active_level;
  return pilot.auto_level === 'yolo' ? 'yolo' : 'intrepid_auto';
}

// ---- rules learned from ratings: harness/helix/rules.yaml, in git ----

export interface Rule {
  id: string; // R-1
  name: string; // the kind of request, as Helix named it and Daniel edited it: "lockfile-only merge conflicts"
  request?: RequestKind; // the table row it belongs to, when it has one
  decide: 'helix' | 'ask'; // ▼ Decide these yourself, ▲ Keep asking
  at: string;
  from?: string; // the request it was rated on
}

export const rulesFile = (root: string) => join(root, 'harness', 'helix', 'rules.yaml');

export function readRules(root: string): Rule[] {
  const f = rulesFile(root);
  if (!existsSync(f)) return [];
  try {
    const r = (parse(readFileSync(f, 'utf8')) ?? {}) as { rules?: Rule[] };
    return Array.isArray(r.rules) ? r.rules.filter((x) => x && typeof x.name === 'string' && (x.decide === 'helix' || x.decide === 'ask')) : [];
  } catch {
    return [];
  }
}

export function writeRules(root: string, rules: Rule[]): string {
  const f = rulesFile(root);
  mkdirSync(dirname(f), { recursive: true });
  atomicWrite(f, `# What Daniel's ratings taught Helix (spec §7.3): kinds of request it now decides, or must always ask about.\n# They override the pilot table, never its floors. Written by Helix Loop; Undo in Settings › Pilot mode.\n${stringify({ rules }, { lineWidth: 0 })}`);
  return f;
}

// What happens to one request: the floors first, then a rule naming its kind, then the table.
export function decide(pilot: PilotConfig, rules: Rule[], request: RequestKind, name?: string): { decision: Decision; rule?: Rule } {
  const table = tableOf(pilot);
  if (FLOORS.includes(request)) return { decision: table[request].cautious };
  const rule = name ? rules.findLast((r) => r.name.toLowerCase() === name.toLowerCase()) : undefined;
  const column = columnOf(pilot);
  if (rule) return { decision: rule.decide === 'helix' ? 'helix' : pilot.mode === 'auto' ? 'parks' : 'asks', rule };
  return { decision: table[request][column] };
}

// ---- the record: runs/hitl.jsonl ----

export interface HitlRecord {
  id: string; // H-1
  at: string;
  request: RequestKind;
  name?: string; // the kind as Helix named it
  raisedBy: string; // a builder (T-0057 attempt 2, codex), the loop, or Helix's monitor
  task?: string;
  tasks?: string[];
  question: string; // the request as it would have been put to Daniel
  compared: ActiveLevel; // the Active-pilot level the record compares against
  mode: 'active' | 'auto';
  level: string;
  chose: string; // what Helix did
  why: string;
  confidence: number; // 0 to 1
  action: 'retry' | 'park' | 'quarantine' | 'spec_answer' | 'note' | 'split' | 'other';
  change?: string; // the applied change's id (runs/changes.jsonl), for undo
}

// A request Helix brings to Daniel instead of deciding it: shown on Home with its options, each a plan change.
export interface Raised {
  id: string; // Q-1
  at: string;
  request: RequestKind;
  name: string; // the kind as Helix named it, which a rating turns into a rule
  tasks: string[];
  question: string;
  options: { label: string; changes: import('./incidents.ts').PlanChange[] }[];
  recommend?: number; // the option Helix would pick
  why?: string;
  answered?: { option: number; at: string };
}

export type HitlEvent =
  | ({ type: 'resolved' } & HitlRecord)
  | { type: 'rated'; id: string; at: string; rating: 'agree' | 'undo' | 'always_ask' }
  | ({ type: 'raised' } & Omit<Raised, 'answered'>)
  | { type: 'answered'; id: string; at: string; option: number };

export function readHitl(file: string): { records: HitlRecord[]; ratings: Map<string, { rating: string; at: string }>; raised: Raised[] } {
  const records: HitlRecord[] = [];
  const raised: Raised[] = [];
  const ratings = new Map<string, { rating: string; at: string }>();
  if (!existsSync(file)) return { records, ratings, raised };
  for (const l of readFileSync(file, 'utf8').split('\n')) {
    if (!l.startsWith('{')) continue;
    try {
      const e = JSON.parse(l) as HitlEvent;
      if (e.type === 'resolved') {
        const { type: _t, ...r } = e;
        records.push(r);
      } else if (e.type === 'rated') ratings.set(e.id, { rating: e.rating, at: e.at });
      else if (e.type === 'raised') {
        const { type: _t, ...r } = e;
        raised.push(r);
      } else if (e.type === 'answered') {
        const r = raised.find((x) => x.id === e.id);
        if (r) r.answered = { option: e.option, at: e.at };
      }
    } catch {
      // a line mid-append
    }
  }
  return { records, ratings, raised };
}

export function appendHitl(file: string, e: HitlEvent): void {
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify(e)}\n`);
}

// ---- builder feedback rules (spec §10) ----

export const FEEDBACK_LABELS: Record<FeedbackKind, { label: string; means: string }> = {
  spec_question: { label: 'Spec question', means: 'The spec is ambiguous or silent on something the task needs' },
  gate_failure: { label: 'Gate failure', means: 'The same gate step failed (recorded by the loop, not the builder)' },
  flaky_test: { label: 'Flaky test', means: 'A test fails intermittently, on this task or others' },
  blocked_on_human: { label: 'Blocked on a person', means: 'The task needs something a human task provides' },
  credential_missing: { label: 'Credential missing', means: 'A secret, environment variable or access is missing' },
  scope_grew: { label: 'Scope grew', means: 'The task is bigger than planned' },
  conflict: { label: 'Conflict', means: 'Merge conflicts, or main diverged under the task' },
  environment: { label: 'Environment', means: 'Sandbox, network or tooling problems' },
};

export const DEFAULT_FEEDBACK: Record<FeedbackKind, FeedbackRule> = {
  spec_question: { send_to: 'helix', after: 'first', pause: false, notify: false },
  gate_failure: { send_to: 'helix', after: 'task:2', pause: false, notify: false },
  flaky_test: { send_to: 'helix', after: 'tasks:2', pause: false, notify: false },
  blocked_on_human: { send_to: 'inbox', after: 'first', pause: false, notify: false },
  credential_missing: { send_to: 'inbox', after: 'first', pause: true, notify: true },
  scope_grew: { send_to: 'helix', after: 'first', pause: false, notify: false },
  conflict: { send_to: 'helix', after: 'task:2', pause: false, notify: false },
  environment: { send_to: 'inbox', after: 'tasks:2', pause: false, notify: false },
};

export function feedbackRule(config: Config, kind: FeedbackKind, lane?: string): FeedbackRule {
  const base = { ...DEFAULT_FEEDBACK[kind], ...(config.feedback?.[kind] ?? {}) };
  return { ...base, ...((lane && config.feedback?.lanes?.[lane]?.[kind]) || {}) };
}

// Whether a kind has reached its threshold: on one task N times, or on N tasks.
export function reached(rule: FeedbackRule, counts: { onTask: number; tasks: number }): boolean {
  const [what, n] = rule.after.split(':');
  if (what === 'task') return counts.onTask >= Number(n);
  if (what === 'tasks') return counts.tasks >= Number(n);
  return counts.onTask >= 1;
}

export const isFeedbackKind = (k: string): k is FeedbackKind => (FEEDBACK_KINDS as readonly string[]).includes(k);
