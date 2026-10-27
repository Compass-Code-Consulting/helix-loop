import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStage, pick } from '../src/sched/scheduler.ts';
import type { Plan, Task } from '../src/types.ts';

// Mascot design work (role: design, pinned to Codex) never holds a stage open, so a Codex quota wall
// while Mushy is being drawn can't stall the build.

function task(id: string, over: Partial<Task> = {}): Task {
  return {
    id, repo: 'acme-app', stage: 'day0', area: `area-${id}`, title: `Task ${id} title`, reqs: ['PB-14'],
    spec: ['§11 Requirements'], acceptance: [`unit: [PB-14] behaviour of ${id}`], blocked_by: [], estimate_passes: 1,
    status: 'ready', claimed_by: null, attempts: [], ...over,
  };
}
const planOf = (tasks: Task[]): Plan => ({ tasks: new Map(tasks.map((t) => [t.id, t])), human: new Map() });
const design = { agent: 'codex' as const, role: 'design' as const };

test('scheduler: a stage opens while only design-role work is left in earlier stages', () => {
  const plan = planOf([task('T-0001', { status: 'done' }), task('T-3100', design), task('T-0020', { stage: 'day1' })]);
  assert.equal(openStage(plan), 'day1');
  // Claude takes the next stage's work; Codex still finishes the mascot task.
  const base = { plan, rank: ['T-3100', 'T-0020'], heldAreas: new Set<string>(), maxAttempts: 3 };
  assert.equal(pick({ ...base, agent: 'claude' })?.id, 'T-0020');
  assert.equal(pick({ ...base, agent: 'codex' })?.id, 'T-3100');
});

test('scheduler: build work still holds its stage, and later design work waits for its own stage', () => {
  const plan = planOf([task('T-0001'), task('T-3110', { ...design, stage: 'day1' })]);
  assert.equal(openStage(plan), 'day0');
  assert.equal(pick({ plan, rank: ['T-3110', 'T-0001'], agent: 'codex', heldAreas: new Set(), maxAttempts: 3 })?.id, 'T-0001');
});
