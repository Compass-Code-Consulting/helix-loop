import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { lanesOf, renderDependencyMap } from '../src/map/render.ts';
import type { MapModel, MapNode } from '../src/types.ts';

const sample = JSON.parse(
  readFileSync(new URL('./fixtures/map-model.sample.json', import.meta.url), 'utf8'),
) as MapModel;

const EMPTY: MapModel = {
  generatedAt: '2026-10-23T08:00:00.000Z',
  startAt: '2026-10-23T08:00:00.000Z',
  passHours: 0.4,
  nodes: [],
  criticalPath: [],
  agents: [],
  mode: 'idle',
  totals: { tasks: 0, done: 0, ready: 0, claimed: 0, needsHuman: 0, parked: 0 },
  projectedFinish: '2026-10-23T08:00:00.000Z',
};

function embedded(html: string): string {
  const m = /<script type="application\/json" id="model">([\s\S]*?)<\/script>/.exec(html);
  assert.ok(m, 'model script present');
  return m[1] ?? '';
}

function inlineScripts(html: string): string[] {
  return [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1] ?? '');
}

test('output is a complete, self-contained HTML document', () => {
  const html = renderDependencyMap(sample);
  assert.match(html, /^<!doctype html>\n<html lang="en">/);
  assert.match(html, /<meta charset="utf-8">/);
  assert.match(html, /<meta name="viewport"/);
  assert.match(html, /<title>[^<]+<\/title>/);
  assert.match(html, /<\/body>\n<\/html>\n$/);
  // No network resources: the file is opened from disk.
  assert.doesNotMatch(html, /\b(src|href)=["']?(https?:)?\/\//i);
  assert.doesNotMatch(html, /@import|url\(\s*["']?https?:/i);
});

test('the inline client script compiles', () => {
  const scripts = inlineScripts(renderDependencyMap(sample));
  assert.equal(scripts.length, 1);
  assert.doesNotThrow(() => new vm.Script(scripts[0] ?? ''));
});

test('the model JSON round-trips from the embedded script', () => {
  assert.deepEqual(JSON.parse(embedded(renderDependencyMap(sample))), sample);
  assert.deepEqual(JSON.parse(embedded(renderDependencyMap(EMPTY))), EMPTY);
});

test('a hostile title or summary cannot break out of the model script', () => {
  const evil = '</script><img src=x onerror=alert(1)><!-- <script>alert(2)</script>   ';
  const first = sample.nodes[0] as MapNode;
  const model: MapModel = {
    ...sample,
    nodes: [{ ...first, title: evil, summary: evil, reqs: ['</SCRIPT><svg onload=alert(3)>'] }, ...sample.nodes.slice(1)],
  };
  const html = renderDependencyMap(model);
  const json = embedded(html);
  assert.ok(!json.includes('<'), 'no raw < inside the JSON');
  assert.equal(html.match(/<\/script>/gi)?.length, 3, 'exactly the three closing tags the page itself writes');
  assert.ok(!/<img|<svg onload/i.test(html), 'payload markup never appears in the page');
  const parsed = JSON.parse(json) as MapModel;
  assert.equal(parsed.nodes[0]?.title, evil);
  assert.equal(parsed.nodes[0]?.summary, evil);
  assert.equal(parsed.nodes[0]?.reqs[0], '</SCRIPT><svg onload=alert(3)>');
});

test('the client never feeds model text to innerHTML', () => {
  const js = inlineScripts(renderDependencyMap(sample))[0] ?? '';
  // innerHTML is used only to clear a layer or to write arrow paths built from numbers.
  const uses = [...js.matchAll(/\.innerHTML\s*=\s*([^;]+);/g)].map((m) => (m[1] ?? '').trim());
  for (const rhs of uses) assert.ok(rhs === '""' || /^pathsFor\(/.test(rhs), `unexpected innerHTML source: ${rhs}`);
  assert.doesNotMatch(js, /insertAdjacentHTML|outerHTML|document\.write/);
});

test('every lane and status appears, each lane in a colour of its own', () => {
  const html = renderDependencyMap(sample);
  const LANES = lanesOf(sample);
  for (const lane of LANES) assert.ok(html.includes(`data-lane="${lane}"`), `lane filter ${lane}`);
  for (let i = 0; i < LANES.length - 1; i++) assert.ok(html.includes(`--lane-${i}:`), `lane colour ${i}`);
  assert.ok(html.includes('--lane-human:'));
  for (const status of ['ready', 'claimed', 'done', 'needs_human', 'parked', 'todo', 'in_progress']) {
    assert.ok(html.includes(`class="sw st-${status}"`), `legend swatch ${status}`);
    assert.ok(html.includes(`.st-${status}`), `bar style ${status}`);
  }
  // The sample itself covers every lane and every status, so the screenshot exercises them all.
  const lanes = new Set(sample.nodes.map((n) => n.lane));
  for (const lane of LANES) assert.ok(lanes.has(lane), `sample has lane ${lane}`);
  const statuses = new Set(sample.nodes.map((n) => n.status));
  for (const s of ['ready', 'claimed', 'done', 'needs_human', 'parked', 'todo', 'in_progress', 'done'])
    assert.ok(statuses.has(s as MapNode['status']), `sample has status ${s}`);
});

test('the sample fixture is internally consistent', () => {
  const by = new Map(sample.nodes.map((n) => [n.id, n]));
  for (const n of sample.nodes) {
    for (const d of n.blockedBy) assert.ok(by.get(d)?.dependents.includes(n.id), `${d} lists ${n.id} as dependent`);
    assert.ok(Math.abs(n.ef - n.es - n.durationHours) < 1e-6, `${n.id} ef = es + duration`);
    assert.ok(Math.abs(n.slack - (n.ls - n.es)) < 1e-6, `${n.id} slack = ls - es`);
  }
  for (const id of sample.criticalPath) assert.equal(by.get(id)?.critical, true, `${id} critical`);
  const overdue = sample.nodes.filter(
    (n) => n.kind === 'human' && n.status !== 'done' && n.latestStart && n.latestStart < sample.generatedAt,
  );
  assert.equal(overdue.length, 1, 'exactly one overdue human task');
  assert.ok(sample.agents.some((a) => a.state === 'limited' && a.resetAt));
  assert.equal(sample.mode, 'single:codex');
});

test('an empty model renders', () => {
  const html = renderDependencyMap(EMPTY);
  assert.match(html, /^<!doctype html>/);
  assert.match(html, /<\/html>\n$/);
  assert.doesNotThrow(() => new vm.Script(inlineScripts(html)[0] ?? ''));
});

test('the task column can wrap every title and be resized from its header', () => {
  const html = renderDependencyMap(sample);
  // The controls live in the column's header; their behaviour is checked in a browser (wrapped rows,
  // arrows at row centres, dragging and arrow keys, the width and the toggle kept per viewer).
  assert.match(html, /wrapCb\.id = "wrapall"/);
  assert.match(html, /createTextNode\("Wrap all"\)/);
  assert.match(html, /rsz\.setAttribute\("role", "separator"\)/);
  assert.match(html, /\.chart\.wrapped \.row:not\(\.grp\) \.lab \.nm\{white-space:normal/);
  assert.match(html, /store\.set\("lw"/);
  assert.match(html, /store\.set\("wrap"/);
});
