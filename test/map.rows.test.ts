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
type MapRows = (board: Board, o: { view?: string; scope?: string; milestone?: string; q?: string; owner?: string; fold?: (id: string) => string | undefined; hidden?: Set<string>; sel?: string }) => Rows;

interface Edge {
  from: number;
  to: number;
  via: boolean;
  crit: boolean;
}
type MapEdges = (board: unknown, rows: unknown[], sel: string | null) => Edge[];
type MapSelectedRow = (rows: unknown[], sel: string | null) => number;

const page = {} as { HX: { mapRows: MapRows; mapEdges: MapEdges; mapSelectedRow: MapSelectedRow; mapView: (v: string) => string; mapColumnTitle: (v: string) => string } };
runInNewContext(readFileSync(new URL('../src/app/page/maprows.js', import.meta.url), 'utf8'), page);
const { mapRows, mapEdges, mapSelectedRow, mapView, mapColumnTitle } = page.HX;

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

test('the legend kinds hide their rows: tasks by state, the human tasks, and an item once all its work is hidden', () => {
  const all = rows({ view: 'task', scope: 'all' });
  const statusOf = new Map(board.tasks.map((t) => [t.id, t.status]));
  const doneIds = ids(all, 'task').filter((id) => statusOf.get(id) === 'done');
  assert.ok(doneIds.length > 0 && doneIds.length < ids(all, 'task').length, 'the fixture has done and open work');
  const noDone = rows({ view: 'task', scope: 'all', hidden: new Set(['done']) });
  assert.deepEqual(ids(noDone, 'task'), ids(all, 'task').filter((id) => statusOf.get(id) !== 'done'));
  assert.equal(noDone.text, all.text, 'the totals count the TaskSet, not what shows');
  // The human tasks go as one.
  assert.ok(ids(all, 'human').length > 0);
  const noHuman = rows({ view: 'task', scope: 'all', hidden: new Set(['human']) });
  assert.deepEqual(ids(noHuman, 'human'), []);
  assert.ok(!noHuman.rows.some((r) => r.id === 'lane:human'));
  // An item whose work is all merged goes with "done"; an item with open work stays, its bar still counting the merged.
  const features = rows({ view: 'feature', scope: 'all' });
  const featuresOpen = rows({ view: 'feature', scope: 'all', hidden: new Set(['done']) });
  const finished = features.rows.filter((r) => r.kind === 'item' && r.roll!.done === r.roll!.total).map((r) => r.id);
  assert.ok(finished.length > 0);
  assert.deepEqual(ids(featuresOpen, 'item'), ids(features, 'item').filter((id) => !finished.includes(id)));
  const partly = featuresOpen.rows.find((r) => r.kind === 'item' && r.roll!.done > 0);
  assert.ok(partly, 'a feature partly merged still shows its merged share');
  // Every kind hidden: nothing but nothing.
  assert.deepEqual(rows({ view: 'hybrid', scope: 'all', hidden: new Set(['done', 'building', 'ready', 'needs', 'human']) }).rows, []);
});

// The dependency lines, on a board small enough to read: A ← B ← C ← D (each waits on the one before), E ← F apart,
// stories s1 (A, B) and s2 (C, D) in feature f, and the critical path A, B, C.
const small = {
  tasks: [{ id: 'A' }, { id: 'B', deps: ['A'] }, { id: 'C', deps: ['B'] }, { id: 'D', deps: ['C'] }, { id: 'E' }, { id: 'F', deps: ['E'] }],
  human: [],
  criticalPath: ['A', 'B', 'C'],
  items: [
    { id: 'feature:f', level: 'feature', tasks: ['A', 'B', 'C', 'D'] },
    { id: 'story:s1', level: 'story', parent: 'feature:f', tasks: ['A', 'B'] },
    { id: 'story:s2', level: 'story', parent: 'feature:f', tasks: ['C', 'D'] },
  ],
};
const taskRow = (id: string) => ({ kind: 'task', id });
const itemRow = (id: string, folded?: boolean) => ({ kind: 'item', id, item: small.items.find((i) => i.id === id), ...(folded === undefined ? {} : { folded }) });
const edges = (rowList: unknown[], sel: string) => (JSON.parse(JSON.stringify(mapEdges(small, rowList, sel))) as Edge[]).map((e) => `${e.from}>${e.to}${e.via ? ' via' : ''}${e.crit ? ' crit' : ''}`).sort();

test('a selected task draws its own dependencies, both ways, and nothing further', () => {
  assert.ok(board.tasks.some((t) => t.deps?.length), 'the board carries each task\'s dependencies');
  const all = ['A', 'B', 'C', 'D', 'E', 'F'].map(taskRow);
  assert.deepEqual(edges(all, 'B'), ['0>1 crit', '1>2 crit']);
  assert.deepEqual(edges(all, 'D'), ['2>3']);
  assert.deepEqual(edges(all, 'E'), ['4>5']);
  assert.equal(mapEdges(small, all, null).length, 0);
});

test('a hidden task is passed through, dashed; a folded row or a level view\'s row holds its tasks; an open row holds none', () => {
  // B hidden (a filter, or off the frontier): C's line comes from A, through it.
  assert.deepEqual(edges([taskRow('A'), taskRow('C'), taskRow('D')], 'C'), ['0>1 via', '1>2']);
  // Story view: s1 holds A and B, s2 holds C and D; selecting s2 draws s1 → s2, its own edges staying inside.
  assert.deepEqual(edges([itemRow('story:s1'), itemRow('story:s2')], 'item:story:s2'), ['0>1 crit']);
  // Hybrid with s1 folded and s2 open on its tasks: C's line starts at s1's row.
  assert.deepEqual(edges([itemRow('feature:f', false), itemRow('story:s1', true), itemRow('story:s2', false), taskRow('C'), taskRow('D')], 'C'), ['1>3 crit', '3>4']);
  // s2 open with its tasks filtered out: nothing holds them, so no line points at the open row.
  assert.deepEqual(edges([itemRow('feature:f', false), itemRow('story:s1', true), itemRow('story:s2', false)], 'item:story:s1'), []);
});

test('the selection\'s row: its own, else the folded row that holds it', () => {
  const hybrid = [itemRow('feature:f', false), itemRow('story:s1', true), itemRow('story:s2', false), taskRow('C')];
  assert.equal(mapSelectedRow(hybrid, 'C'), 3);
  assert.equal(mapSelectedRow(hybrid, 'A'), 1);
  assert.equal(mapSelectedRow(hybrid, 'D'), -1);
  assert.equal(mapSelectedRow(hybrid, 'item:story:s2'), 2);
  assert.equal(mapSelectedRow(hybrid, null), -1);
});

test('the selected task shows whatever the scope and filters, so a link to it lands on it', () => {
  const merged = board.tasks.find((t) => t.status === 'done' && !t.frontier)!;
  assert.ok(!ids(rows({ view: 'task' }), 'task').includes(merged.id), 'off the frontier, it is not shown');
  assert.ok(ids(rows({ view: 'task', sel: merged.id }), 'task').includes(merged.id));
  assert.ok(ids(rows({ view: 'task', hidden: new Set(['done']), sel: merged.id }), 'task').includes(merged.id));
  // In Hybrid, the folds stay as they are: the folded row holding it stands for it.
  assert.ok(mapSelectedRow(rows({ view: 'hybrid', sel: merged.id }).rows, merged.id) >= 0);
});
