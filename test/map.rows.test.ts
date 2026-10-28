import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { stringify } from 'yaml';
import { buildBoard, type Board } from '../src/app/board.ts';
import { loadSettings } from '../src/app/settings.ts';
import { loadConfig, paths } from '../src/config.ts';
import type { LedgerEvent } from '../src/ledger.ts';
import { loadPlan } from '../src/plan/store.ts';
import { FIXTURE } from './fixture.ts';

// The Map's rows (src/app/page/maprows.js), loaded as the page loads it, against the board of the Acme fixture: what
// each View shows, its totals, the folds, the scopes, the milestone filter and search.

interface Row {
  kind: 'head' | 'item' | 'task' | 'human';
  id: string;
  depth?: number;
  folded?: boolean;
  roll?: { total: number; done: number; start?: number; end?: number };
}
interface Rows {
  view: string;
  rows: Row[];
  totals: Record<string, number>;
  text: string;
}
type MapRows = (board: Board, o: { view?: string; scope?: string; milestone?: string; q?: string; owner?: string; fold?: (id: string) => string | undefined }) => Rows;

const page = {} as { HX: { mapRows: MapRows; mapView: (v: string) => string; mapColumnTitle: (v: string) => string } };
runInNewContext(readFileSync(new URL('../src/app/page/maprows.js', import.meta.url), 'utf8'), page);
const { mapRows, mapView, mapColumnTitle } = page.HX;

const board = buildBoard({ plan: loadPlan(paths(FIXTURE).tasks, paths(FIXTURE).human), events: [] as LedgerEvent[], agents: [], running: [], config: loadConfig(FIXTURE), now: Date.parse('2026-10-27T18:00:00Z') });
// Plain values: the page's arrays come from another realm.
const rows = (o: Parameters<MapRows>[1]) => JSON.parse(JSON.stringify(mapRows(board, { owner: 'Sam', ...o }))) as Rows;
const ids = (r: Rows, kind?: Row['kind']) => r.rows.filter((x) => !kind || x.kind === kind).map((x) => x.id);

test('each View shows one row per item of its level, under its lane, with the totals the toolbar shows', () => {
  const lane = rows({ view: 'lane', scope: 'all' });
  assert.deepEqual(ids(lane, 'item'), ['lane:app', 'lane:website', 'lane:docs']);
  assert.equal(lane.text, '3 lanes');
  assert.deepEqual(lane.rows.find((r) => r.id === 'lane:app')!.roll, { ...lane.rows.find((r) => r.id === 'lane:app')!.roll, total: 24, done: 7 });
  const epic = rows({ view: 'epic', scope: 'all' });
  assert.deepEqual(epic.rows.filter((r) => r.kind !== 'human').map((r) => `${r.kind}:${r.id}`), [
    'head:lane:human', 'head:head:lane:app', 'item:epic:team-notes', 'item:epic:public-pages', 'head:head:lane:website', 'item:epic:public-website', 'head:head:lane:docs', 'item:epic:help-centre',
  ]);
  assert.equal(epic.text, '4 epics');
  assert.equal(rows({ view: 'feature', scope: 'all' }).text, '9 features');
  assert.equal(ids(rows({ view: 'feature', scope: 'all' }), 'item').length, 9);
  assert.equal(rows({ view: 'story', scope: 'all' }).text, '19 stories');
  const task = rows({ view: 'task', scope: 'all' });
  assert.equal(task.text, '40 tasks');
  assert.equal(ids(task, 'task').length, 40);
  assert.equal(rows({ view: 'hybrid' }).text, '3 lanes · 4 epics · 9 features · 19 stories · 40 tasks');
  // Every bar spans its tasks: the first start to the last projected end.
  const story = rows({ view: 'story', scope: 'all' }).rows.find((r) => r.id === 'story:unpublish-note')!;
  const ts = board.tasks.filter((t) => ['T-0014', 'T-0015', 'T-0024'].includes(t.id));
  assert.deepEqual([story.roll!.start, story.roll!.end], [Math.min(...ts.map((t) => t.start!)), Math.max(...ts.map((t) => t.end!))]);
  assert.equal(mapColumnTitle('hybrid'), 'Lane › epic › feature › story');
});

test('Hybrid nests Lane › Epic › Feature › Story › tasks, folding what is finished or off the frontier, and keeps a fold the owner set', () => {
  const r = rows({ view: 'hybrid', scope: 'frontier' });
  const at = (id: string) => r.rows.find((x) => x.id === id)!;
  assert.deepEqual(['lane:app', 'epic:team-notes', 'feature:app-shell'].map((id) => at(id).depth), [0, 1, 2]);
  assert.equal(at('feature:app-shell').folded, true, 'finished: folded');
  assert.ok(!r.rows.some((x) => x.id === 'story:sign-in-with-code'), 'nothing under a fold');
  assert.equal(at('story:write-a-note').depth, 3);
  assert.equal(at('T-0007').depth, 4);
  assert.equal(at('T-0007').kind, 'task');
  const folded = rows({ view: 'hybrid', scope: 'frontier', fold: (id) => (id === 'epic:public-pages' ? 'closed' : id === 'feature:app-shell' ? 'open' : undefined) });
  assert.equal(folded.rows.find((x) => x.id === 'epic:public-pages')!.folded, true);
  assert.ok(!folded.rows.some((x) => x.id === 'feature:publishing'));
  assert.ok(folded.rows.some((x) => x.id === 'story:sign-in-with-code'), 'opened by hand');
  // The people first, the human tasks the build waits on.
  assert.deepEqual(r.rows.slice(0, 2).map((x) => x.id), ['lane:human', 'HT-2']);
});

test('the milestone filter keeps that milestone\'s work, rolls each item up from it, and counts it', () => {
  const r = rows({ view: 'hybrid', scope: 'all', milestone: 'publish-a-page' });
  assert.equal(r.text, '1 lane · 1 epic · 2 features · 4 stories · 8 tasks');
  assert.deepEqual(ids(r, 'task'), ['T-0012', 'T-0013', 'T-0014', 'T-0015', 'T-0020', 'T-0021', 'T-0022', 'T-0023']);
  assert.equal(r.rows.find((x) => x.id === 'story:unpublish-note')!.roll!.total, 2, 'T-0024, the wiring task, is in a later milestone');
  assert.ok(!r.rows.some((x) => x.id === 'lane:website'));
  assert.ok(!r.rows.some((x) => x.kind === 'human'), 'no human task holds this milestone\'s work');
  const website = rows({ view: 'task', scope: 'all', milestone: 'website-and-help' });
  assert.ok(website.rows.some((x) => x.id === 'HT-2'), 'the human task its work waits on');
});

test('the scopes: Critical path keeps the items on it; search finds tasks, and an item by its title brings its work', () => {
  const crit = rows({ view: 'task', scope: 'critical' });
  assert.deepEqual(ids(crit, 'task').sort(), [...board.criticalPath].sort());
  const s = rows({ view: 'hybrid', q: 'take a page' });
  assert.deepEqual(ids(s, 'task'), ['T-0014', 'T-0015', 'T-0024']);
  assert.ok(s.rows.every((x) => x.folded !== true), 'nothing folded while searching');
  assert.deepEqual(ids(rows({ view: 'task', q: 't-0031' }), 'task'), ['T-0031']);
  assert.deepEqual(ids(rows({ view: 'story', q: 'jobs' }), 'item'), ['story:unpublish-note', 'story:jobs-retry', 'story:jobs-idempotent'], 'stories with a task it finds (T-0014, "until jobs exist"), and those under the feature it names');
});

test('a View the page doesn\'t know is Hybrid, and the server migrates the old Tasks and Epics', () => {
  assert.equal(mapView('epics'), 'hybrid');
  assert.equal(mapView('feature'), 'feature');
  const file = join(mkdtempSync(join(tmpdir(), 'helix-ui-')), 'app.yaml');
  writeFileSync(file, stringify({ ui: { 'map.view': 'epics', 'fold:lane/core': 'open' } }));
  assert.equal(loadSettings(file).ui!['map.view'], 'epic');
  writeFileSync(file, stringify({ ui: { 'map.view': 'tasks' } }));
  assert.equal(loadSettings(file).ui!['map.view'], 'task');
});
