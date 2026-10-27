import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildStats, formatStats } from '../src/stats.ts';
import type { LedgerEvent } from '../src/ledger.ts';

// Agent utilization over the build, computed from the ledger alone.

const at = (min: number) => new Date(Date.UTC(2026, 9, 24, 1, 0) + min * 60_000).toISOString();
// As the loop logs it: the duration runs from the claim to the end of the pass, the gate's time included.
const pass =(min: number, agent: string, outcome: string, durationMin: number, gateMin: number): LedgerEvent => ({
  kind: 'pass', at: at(min), task: 'T-0001', repo: 'mushy-social-media', agent, model: 'm', attempt: 1, outcome,
  durationMs: durationMin * 60_000, gateMs: gateMin * 60_000, costUsd: 1.5, tokens: { input: 1_000_000, cachedInput: 500_000, output: 100_000 }, log: 'x',
});

test('stats: working, gating, limited and idle add up to the time the loop ran, per agent', () => {
  const events: LedgerEvent[] = [
    { kind: 'loop', at: at(0), event: 'start' },
    pass(30, 'claude', 'merged', 20, 5),
    pass(40, 'codex', 'gate_failed', 30, 5),
    { kind: 'agent', at: at(45), agent: 'codex', state: 'limited', resetAt: at(75) },
    { kind: 'agent', at: at(75), agent: 'codex', state: 'available' },
    { kind: 'merge', at: at(31), task: 'T-0001', repo: 'mushy-social-media', commit: 'abc', agent: 'claude', regated: false },
    { kind: 'loop', at: at(100), event: 'exit', code: 0 },
    // Down for 20 minutes, then running again until "now" (minute 140).
    { kind: 'loop', at: at(120), event: 'start' },
  ];
  const s = buildStats(events, ['claude', 'codex'], Date.parse(at(140)));
  assert.equal(s.startedAt, at(0));
  assert.equal(s.elapsedMs, 140 * 60_000);
  assert.equal(s.upMs, 120 * 60_000);
  assert.equal(s.merges, 1);
  const [claude, codex] = s.agents;
  assert.deepEqual([claude!.passes, claude!.merged, claude!.workingMs / 60_000, claude!.gatingMs / 60_000, claude!.limitedMs, claude!.idleMs / 60_000], [1, 1, 15, 5, 0, 100]);
  assert.deepEqual([codex!.passes, codex!.merged, codex!.workingMs / 60_000, codex!.limitedMs / 60_000, codex!.idleMs / 60_000], [1, 0, 25, 30, 60]);
  for (const a of s.agents) assert.equal(a.workingMs + a.gatingMs + a.limitedMs + a.idleMs, s.upMs);
  assert.equal(codex!.tokens.input, 1_000_000);
  assert.match(formatStats(s)[0]!, /2 h 20 m elapsed, the loop running for 2 h 00 m; 1 tasks merged/);
});

test('stats: time its weekly pace allows an agent no passes counts as limited, and a wall inside it does not end it', () => {
  const events: LedgerEvent[] = [
    { kind: 'loop', at: at(0), event: 'start' },
    { kind: 'pace', at: at(10), agent: 'claude', slots: 1 },
    { kind: 'pace', at: at(20), agent: 'claude', slots: 0 },
    { kind: 'agent', at: at(30), agent: 'claude', state: 'limited' },
    { kind: 'agent', at: at(40), agent: 'claude', state: 'available' },
    { kind: 'pace', at: at(50), agent: 'claude', slots: 1 },
    { kind: 'loop', at: at(60), event: 'exit', code: 0 },
  ];
  const [claude] = buildStats(events, ['claude'], Date.parse(at(60))).agents;
  assert.equal(claude!.limitedMs / 60_000, 30);
});

test('stats: with two slots an agent has two hours of slot-time an hour, and its pace holding one back limits one', () => {
  const events: LedgerEvent[] = [
    { kind: 'loop', at: at(0), event: 'start', slots: { claude: 2, codex: 1 } },
    pass(30, 'claude', 'merged', 30, 10),
    pass(35, 'claude', 'merged', 30, 10),
    { kind: 'pace', at: at(40), agent: 'claude', slots: 1 },
    { kind: 'loop', at: at(60), event: 'exit', code: 0 },
    // The next run paces afresh: the slot held back before the restart is free again.
    { kind: 'loop', at: at(60), event: 'start', slots: { claude: 2, codex: 1 } },
    { kind: 'loop', at: at(90), event: 'exit', code: 0 },
  ];
  const s = buildStats(events, ['claude', 'codex'], Date.parse(at(90)));
  const [claude, codex] = s.agents;
  assert.equal(claude!.slotMs / 60_000, 180);
  assert.deepEqual([claude!.workingMs, claude!.gatingMs, claude!.limitedMs, claude!.idleMs].map((ms) => ms / 60_000), [40, 20, 20, 100]);
  assert.equal(codex!.slotMs / 60_000, 90);
  assert.equal(codex!.idleMs / 60_000, 90);
});

test('stats: a limit still open counts until now, but only while the loop runs', () => {
  const events: LedgerEvent[] = [
    { kind: 'loop', at: at(0), event: 'start' },
    { kind: 'agent', at: at(10), agent: 'claude', state: 'limited' },
  ];
  const s = buildStats(events, ['claude'], Date.parse(at(60)));
  assert.equal(s.agents[0]!.limitedMs, 50 * 60_000);
  assert.deepEqual(formatStats(buildStats([], ['claude'], 0)), ['The loop has not started yet.']);
});

test('stats: a pass still running counts as working from that agent\'s last logged pass', () => {
  const events: LedgerEvent[] = [{ kind: 'loop', at: at(0), event: 'start' }, pass(20, 'claude', 'merged', 15, 5)];
  const s = buildStats(events, ['claude', 'codex'], Date.parse(at(50)), ['claude', 'codex']);
  assert.equal(s.agents[0]!.workingMs / 60_000, 15 - 5 + 30);
  assert.equal(s.agents[1]!.workingMs / 60_000, 50);
});

test('stats: a run killed without an exit ends at its last entry, not at the next start', () => {
  const events: LedgerEvent[] = [
    { kind: 'loop', at: at(0), event: 'start' },
    pass(16, 'claude', 'forbidden_paths', 8, 0),
    { kind: 'loop', at: at(26), event: 'start' },
  ];
  const s = buildStats(events, ['claude'], Date.parse(at(30)));
  assert.equal(s.upMs / 60_000, 16 + 4);
  assert.equal(s.elapsedMs / 60_000, 30);
});
