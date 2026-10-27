import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { FeedbackKind } from '../config.ts';
import type { LedgerEvent } from '../ledger.ts';
import { failingTest } from '../flaky.ts';
import type { Plan } from '../types.ts';
import type { Report } from './state.ts';

// Incidents (spec §2, §9.1): builder feedback with one cause, grouped. Grouping starts mechanical, by what can
// be known exactly: the same failing test or step, the same missing variable, the same requirement in a
// question, the same human task. Helix's monitor then names groups and merges those whose cause is the same
// though their text differs, and proposes one fix for each; runs/incidents.jsonl keeps that, and what Daniel
// decided. Everything else is derived from the ledger and the builders' reports on each read.

const FAILED = new Set(['gate_failed', 'timeout', 'agent_error', 'no_commit']);
const DAY = 86_400_000;

export interface Member {
  task: string;
  count: number;
  last: string; // when it last happened
  detail: string; // the latest failure or report, in a line
  attempt?: number;
  log?: string;
}

// A plan change, as a fix proposes it: each is one of the direct actions (actions.ts), applied together in one
// commit when Daniel accepts the fix.
export type PlanChange =
  | { op: 'hand_back'; task: string; note?: string }
  | { op: 'park'; task: string; note?: string }
  | { op: 'note'; task: string; note: string }
  | { op: 'add_dep'; task: string; on: string }
  | { op: 'remove_dep'; task: string; on: string }
  | { op: 'new_task'; task: Record<string, unknown>; ref?: string } // ref: a name other changes use for its id ("new:1")
  | { op: 'pause' };

export interface Fix {
  id: string; // F-1
  at: string;
  by: 'helix' | 'loop';
  summary: string; // one line: what it does
  confidence: number; // 0 to 1
  changes: PlanChange[];
  alternatives?: { title: string; cost: string; chosen?: boolean }[];
  evidence?: string;
  answer?: { text: string; sections?: string[] }; // for questions: the answer each task gets in its notes
}

export interface Incident {
  key: string; // the exact cause: gate:<signature>, cred:<VAR>, spec:<REQ>, human:<HT>, <kind>:<task>
  kind: FeedbackKind;
  cause: string; // the cause in a line
  title?: string; // Helix's name for it
  members: Member[];
  failures: number;
  times: number[]; // when each failure or report happened
  first: string;
  last: string;
  filed?: string; // a fix-first task the loop filed for it (flaky.ts)
  fix?: Fix;
  decision?: { decision: 'accepted' | 'declined'; at: string; change?: string };
  groupedBy: 'exact' | 'helix';
  merged?: string[]; // the keys Helix merged into this one
  open: boolean; // it still holds a task that isn't done
}

type Stored =
  | { type: 'named'; key: string; at: string; title: string; merged?: string[] }
  | { type: 'fix'; key: string; fix: Fix }
  | { type: 'decided'; key: string; at: string; fix: string; decision: 'accepted' | 'declined'; change?: string };

export function readStored(file: string): Stored[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').flatMap((l) => {
    if (!l.startsWith('{')) return [];
    try {
      return [JSON.parse(l) as Stored];
    } catch {
      return [];
    }
  });
}

export function appendStored(file: string, s: Stored): void {
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify(s)}\n`);
}

// The legacy report kinds (before spec §10) map onto the new ones.
const LEGACY: Record<string, FeedbackKind> = { plan_problem: 'scope_grew', flake: 'flaky_test' };

const reqIn = (s: string) => /\b[A-Z]{1,5}-\d+[a-z]?\b/.exec(s)?.[0];
const varIn = (s: string) => /\b[A-Z][A-Z0-9]*_[A-Z0-9_]{2,}\b/.exec(s)?.[0];
const humanIn = (s: string) => /\bHT-\d+\b/.exec(s)?.[0];
const line = (s: string) => s.split('\n')[0]!.slice(0, 200);

export function incidents(input: { plan: Plan; events: LedgerEvent[]; reports: Report[]; stored: Stored[]; now: number; days?: number }): Incident[] {
  const { plan, events, reports, now } = input;
  const since = now - (input.days ?? 7) * DAY;
  const byKey = new Map<string, Incident>();
  const add = (key: string, kind: FeedbackKind, cause: string, task: string, at: string, detail: string, extra: Partial<Member> = {}) => {
    let inc = byKey.get(key);
    if (!inc) byKey.set(key, (inc = { key, kind, cause, members: [], failures: 0, times: [], first: at, last: at, groupedBy: 'exact', open: false }));
    inc.failures++;
    inc.times.push(Date.parse(at));
    if (at < inc.first) inc.first = at;
    if (at > inc.last) inc.last = at;
    let m = inc.members.find((x) => x.task === task);
    if (!m) inc.members.push((m = { task, count: 0, last: at, detail }));
    m.count++;
    if (at >= m.last) Object.assign(m, { last: at, detail, ...extra });
  };

  // Gate failures, by what failed first. The same named test failing on several tasks is one cause, shared and
  // often flaky; anything less specific (a step's exit code, a timeout, an agent's error) is each task's own.
  for (const e of events) {
    if (e.kind !== 'pass' || !FAILED.has(e.outcome) || Date.parse(e.at) < since) continue;
    const what = e.failing ?? (e.failedStep ? `gate step ${e.failedStep} failed` : e.outcome === 'timeout' ? 'the pass ran past its timeout' : e.note ? line(e.note) : e.outcome.replace('_', ' '));
    const shared = !!e.failing && !!failingTest(e.failing);
    add(shared ? `gate:${what}` : `gate:${e.task}:${what}`, shared ? 'flaky_test' : 'gate_failure', what, e.task, e.at, line(e.note ?? what), { attempt: e.attempt, log: e.log });
  }
  // The fix-first tasks the loop filed for a test failing several tasks.
  for (const e of events) {
    if (e.kind !== 'warning' || !e.detail.startsWith('filed ')) continue;
    const m = /^filed (T-\d+) for a test failing [^:]+: (.*)$/.exec(e.detail);
    if (!m) continue;
    for (const inc of byKey.values()) if (inc.kind === 'gate_failure' && m[2]!.startsWith(inc.cause.slice(0, 60))) inc.filed = m[1];
  }

  // Builders' reports.
  for (const r of reports) {
    if (r.kind !== 'issue' || Date.parse(r.at) < since) continue;
    const kind = (LEGACY[r.issue ?? ''] ?? r.issue) as FeedbackKind;
    const text = `${r.message} ${(r.paths ?? []).join(' ')}`;
    let key = `${kind}:${r.task}`;
    let cause = line(r.message);
    if (kind === 'spec_question' && reqIn(text)) cause = `Questions about ${(key = `spec:${reqIn(text)}`).slice(5)}`;
    else if (kind === 'credential_missing' && varIn(text)) cause = `${(key = `cred:${varIn(text)}`).slice(5)} is missing`;
    else if (kind === 'blocked_on_human' && humanIn(text)) cause = `Waiting on ${(key = `human:${humanIn(text)}`).slice(6)}`;
    add(key, kind, cause, r.task, r.at, line(r.message), { attempt: r.attempt });
  }

  // What Helix and Daniel added: names and merges, fixes, decisions.
  for (const s of input.stored) {
    if (s.type === 'named') {
      const target = byKey.get(s.key);
      if (!target) continue;
      target.title = s.title;
      target.groupedBy = 'helix';
      for (const k of s.merged ?? []) {
        const other = byKey.get(k);
        if (!other || k === s.key) continue;
        for (const m of other.members) {
          const mine = target.members.find((x) => x.task === m.task);
          if (mine) mine.count += m.count;
          else target.members.push(m);
        }
        target.failures += other.failures;
        target.times.push(...other.times);
        target.merged = [...(target.merged ?? []), k];
        byKey.delete(k);
      }
    } else if (s.type === 'fix') {
      const inc = byKey.get(s.key);
      if (inc) {
        inc.fix = s.fix;
        inc.decision = undefined;
      }
    } else if (s.type === 'decided') {
      const inc = byKey.get(s.key);
      if (inc?.fix?.id === s.fix) inc.decision = { decision: s.decision, at: s.at, change: s.change };
    }
  }
  for (const inc of byKey.values()) {
    inc.open = inc.members.some((m) => plan.tasks.get(m.task)?.status !== 'done');
    inc.members.sort((a, b) => b.count - a.count || b.last.localeCompare(a.last));
    inc.times.sort((a, b) => a - b);
  }
  return [...byKey.values()].sort((a, b) => b.members.length - a.members.length || b.failures - a.failures);
}
