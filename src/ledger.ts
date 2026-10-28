import { appendFileSync, createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import type { CarryReason } from './types.ts';

// runs/runs.jsonl: one line per pass and per loop state change. It is the loop's memory of what
// happened (durations, tokens, cost, outcomes) and the source of actual pass durations for the map.

export type LedgerEvent =
  | {
      kind: 'pass';
      at: string;
      task: string;
      repo: string;
      agent: string;
      model: string;
      attempt: number;
      outcome: string;
      durationMs: number;
      gateMs?: number;
      costUsd: number;
      tokens: { input: number; cachedInput: number; output: number };
      commit?: string;
      log: string;
      note?: string;
      // Recorded since 2026-10-25, for the metrics: where the pass's time went, what failed, what it started from.
      startedAt?: string;
      harness?: string; // the control plane's commit the loop was started from
      phases?: PassPhases;
      gateSteps?: { step: string; ms: number }[]; // the pass's own gate: the prepare step, then each step its runner announced
      failedStep?: string; // the gate step that failed, regate:<step> on the new main, rebase, gitleaks, or a harness:<check>
      failing?: string; // what failed first, in a few words: a test's title, a type error, a check
      carried?: { from: string; why: CarryReason; conflicts: number; resolved: number }; // the kept work it started from
      kept?: string; // the branch this pass's own work was kept on
      diff?: { files: number; added: number; deleted: number }; // the attempt's change against the main it started from
      promptBytes?: number;
      retryBytes?: number; // of promptBytes, the part telling a retry about its earlier work and last failure
      toolCalls?: number;
      scripts?: Record<string, number>; // package scripts the agent ran, by name, with how many times
      e2e?: { runs: number; ms: number; failed: number }; // the agent's own browser-test runs, through the e2e runner
      mainMoved?: number; // commits main gained while the pass ran
      usage?: { session?: number; weekly?: number; weeklyResetsAt?: string }; // the subscription's windows (shares used) as the pass left them
    }
  | { kind: 'mode'; at: string; mode: string; detail?: string }
  | { kind: 'agent'; at: string; agent: string; state: 'limited' | 'available' | 'over_budget'; resetAt?: string; detail?: string }
  // A change in how many passes an agent's weekly pace allows (agents/quota.ts paceSlots).
  | { kind: 'pace'; at: string; agent: string; slots: number; used?: number; allowed?: number; resetsAt?: string; until?: string }
  // slots: passes each agent may run at once, at start. pause and resume: runs/PAUSE appeared or went.
  | { kind: 'loop'; at: string; event: 'start' | 'exit' | 'pause' | 'resume'; code?: number; detail?: string; slots?: Record<string, number> }
  | { kind: 'merge'; at: string; task: string; repo: string; commit: string; agent: string; regated: boolean }
  | { kind: 'suspension'; at: string; task?: string; detail: string }
  | { kind: 'warning'; at: string; task?: string; detail: string }
  | { kind: 'release'; at: string; repo: string; tag: string; tasks: string[]; reason: string; pushed: boolean | 'skipped' }
  // A release that was due but not tagged; its tasks go out with the first release after the hold lifts.
  // `tag` and `approval` are set when it waits for the owner to approve a change under the review paths.
  | { kind: 'release_held'; at: string; repo: string; reason: string; tasks: string[]; detail: string; tag?: string; approval?: string }
  // Release tags origin lacked because their push had failed, pushed again (`pushed`: whether it worked).
  | { kind: 'release_retry'; at: string; repo: string; tags: string[]; pushed: boolean }
  // A milestone's last task merged: its lanes (`repos`) were tagged, and Home asks the owner to review its demo.
  // `already`: it was reached before its milestones were applied, so it is recorded with no release and nothing on
  // Home. Either way a milestone reached stays reached: work filed into it later is follow-up, not a new reaching.
  | { kind: 'milestone'; at: string; key: string; title: string; demo: string; repos: string[]; already?: boolean }
  // A whole-suite run on main, for a repo with scoped gates (fullrun.ts): every N merges, or before a release.
  // A failed one names its failing tests, whether they passed when run again (`flaky`), the merge they first fail
  // at (`culprit`) and the fix-first task filed for it (`fix`).
  | {
      kind: 'full_run';
      at: string;
      repo: string;
      commit: string;
      reason: string;
      ok: boolean;
      ms: number;
      log: string;
      steps?: { step: string; ms: number }[];
      failing?: string;
      tests?: string[];
      flaky?: boolean;
      culprit?: { commit: string; task: string };
      fix?: string;
    };

export function record(file: string, event: LedgerEvent): void {
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, JSON.stringify(event) + '\n');
}

export function readLedger(file: string): LedgerEvent[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as LedgerEvent);
}

// One pass's time, end to end: setting up its worktree (with any kept work, and the prepare step), the agent,
// the gate, waiting in the repo's merge queue, then the merge itself, which holds the re-gate on a new main.
export interface PassPhases {
  setupMs: number;
  agentMs: number;
  gateWaitMs?: number; // waiting for one of the concurrent gates to free up
  gateMs: number;
  queueMs?: number;
  mergeMs?: number;
  regateMs?: number;
}

// Mean hours per merged pass, for the map; the default until there is history. A pass's duration runs from its
// start to its end, so its gate is already in it.
export function meanPassHours(events: LedgerEvent[], fallback = 0.25): number {
  const merged = events.filter((e) => e.kind === 'pass' && e.outcome === 'merged') as Extract<LedgerEvent, { kind: 'pass' }>[];
  if (merged.length < 5) return fallback;
  const recent = merged.slice(-50);
  return recent.reduce((s, e) => s + e.durationMs, 0) / recent.length / 3_600_000;
}

// Pass logs are compressed once the pass is over (v1 left 840 MB of raw logs).
export async function compress(file: string): Promise<string> {
  if (!existsSync(file)) return file;
  const gz = `${file}.gz`;
  await pipeline(createReadStream(file), createGzip(), createWriteStream(gz));
  rmSync(file);
  return gz;
}
