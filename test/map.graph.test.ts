import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeMap } from '../src/map/graph.ts';
import type { HumanTask, Plan, Task } from '../src/types.ts';

// Human steps in the dependency map: the build's schedule ignores their lead times, and each step's
// latest start is measured back from the work it gates.

function task(id: string, over: Partial<Task> = {}): Task {
  return {
    id, repo: 'acme-app', story: 'acme-app-story', area: `area-${id}`, title: `Task ${id} title`, reqs: ['PB-14'],
    spec: ['§11 Requirements'], acceptance: [`unit: [PB-14] behaviour of ${id}`], blocked_by: [], estimate_passes: 1,
    status: 'ready', claimed_by: null, attempts: [], ...over,
  };
}
function human(id: string, over: Partial<HumanTask> = {}): HumanTask {
  return { id, title: `Human task ${id}`, done_check: 'it is done', lead_time_days: 2, agent_can_help: 'no', blocked_by: [], status: 'todo', ...over };
}
const planOf = (tasks: Task[], humans: HumanTask[] = []): Plan => ({ tasks: new Map(tasks.map((t) => [t.id, t])), human: new Map(humans.map((h) => [h.id, h])) });
const opts = { now: 0, passHours: 1, agents: [], mode: 'idle' as const };
const HOUR = 3_600_000;

test('map: a long human step neither sets the build finish nor joins its critical path', () => {
  // T-0001 → T-0002 → T-0003 is 3 hours of building; T-0004 waits 42 days on HT-5.
  const plan = planOf(
    [task('T-0001'), task('T-0002', { blocked_by: ['T-0001'] }), task('T-0003', { blocked_by: ['T-0002'] }), task('T-0004', { blocked_by: ['HT-5'] })],
    [human('HT-5', { lead_time_days: 42 })],
  );
  const m = computeMap(plan, opts);
  const n = (id: string) => m.nodes.find((x) => x.id === id)!;
  assert.deepEqual(m.criticalPath, ['T-0001', 'T-0002', 'T-0003']);
  // Four one-pass tasks for one working agent: the throughput bound, not 42 days.
  assert.equal(Date.parse(m.projectedFinish), 4 * HOUR);
  // HT-5 must be done by T-0004's latest start (hour 2), so it was due 42 days before that.
  assert.equal(n('T-0004').ls, 2);
  assert.equal(Date.parse(n('HT-5').latestStart!), (2 - 42 * 24) * HOUR);
  assert.equal(n('HT-5').critical, true);
});

test('map: a step that gates only the launch has no build deadline, and the longest chain sets the human finish', () => {
  // T-0001 (2h) → HT-9 (6h) → HT-10 (2 days): nothing builder-side waits on either step.
  const plan = planOf(
    [task('T-0001', { estimate_passes: 2 })],
    [human('HT-9', { lead_time_days: 0.25, blocked_by: ['T-0001'] }), human('HT-10', { blocked_by: ['HT-9'] }), human('HT-11', { lead_time_days: 1 })],
  );
  const m = computeMap(plan, opts);
  const n = (id: string) => m.nodes.find((x) => x.id === id)!;
  assert.equal(n('HT-9').es, 2);
  assert.equal(n('HT-9').latestStart, undefined);
  assert.equal(n('HT-9').critical, false);
  assert.equal(Date.parse(m.humanFinish!), (2 + 6 + 48) * HOUR);
  assert.deepEqual(m.humanPath, ['T-0001', 'HT-9', 'HT-10']);
});

test('map: the critical path runs through a human step between two tasks', () => {
  // T-0001 → HT-40 → T-0002: the step takes no build time, so the chain stays critical end to end.
  const plan = planOf(
    [task('T-0001', { estimate_passes: 2 }), task('T-0002', { blocked_by: ['HT-40'] }), task('T-0003')],
    [human('HT-40', { lead_time_days: 1, blocked_by: ['T-0001'] })],
  );
  assert.deepEqual(computeMap(plan, opts).criticalPath, ['T-0001', 'T-0002']);
});
