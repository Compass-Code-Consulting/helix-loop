// The Map's rows (spec §6.4): what each View shows, as a function of the board and the Map's settings, so map.js
// only draws and the tests can check it. Lane, Epic, Feature and Story show one row per item of that level, each with
// a bar from its earliest task's start to its latest projected finish and its progress; Task shows the tasks; Hybrid
// nests Lane › Epic › Feature › Story › tasks with folds. The human tasks come first. A milestone filter keeps the
// items with work in that milestone, and rolls each up from that work alone.
(() => {
  'use strict';
  const HX = (globalThis.HX ??= {});
  const LEVELS = ['lane', 'epic', 'feature', 'story'];
  const VIEWS = ['lane', 'epic', 'feature', 'story', 'task', 'hybrid'];
  const PLURAL = { lane: 'lanes', epic: 'epics', feature: 'features', story: 'stories', task: 'tasks' };
  // A View it doesn't know (app.yaml written by hand) is Hybrid; the server migrates the old ones (settings.ts).
  const viewOf = (v) => (VIEWS.includes(v) ? v : 'hybrid');
  const count = (n, level) => `${n.toLocaleString('en-US')} ${n === 1 ? level : PLURAL[level]}`;

  // An item's progress and bar, from the tasks given.
  function rollup(ts) {
    const starts = ts.map((t) => t.start).filter((x) => x != null);
    const ends = ts.map((t) => t.end).filter((x) => x != null);
    const waitsOn = new Map();
    for (const t of ts) for (const w of t.waits ?? []) if (w.startsWith('HT-')) waitsOn.set(w, (waitsOn.get(w) ?? 0) + 1);
    return {
      total: ts.length,
      done: ts.filter((t) => t.status === 'done').length,
      running: ts.filter((t) => t.status === 'claimed').length,
      failing: ts.filter((t) => t.failing).length,
      waiting: ts.filter((t) => t.status === 'needs_human' || t.status === 'parked' || t.waits?.length).length,
      start: starts.length ? Math.min(...starts) : undefined,
      end: ends.length ? Math.max(...ends) : undefined,
      frontier: ts.some((t) => t.frontier),
      critical: ts.some((t) => t.critical),
      waitsOn: [...waitsOn.entries()].sort((a, b) => b[1] - a[1])[0]?.[0],
    };
  }

  // The legend's kinds of task, which double as filters: as the chart draws them (map.js row).
  const kindOf = (t) => (t.status === 'done' ? 'done' : t.status === 'claimed' ? 'building' : t.status === 'needs_human' || t.status === 'parked' ? 'needs' : 'ready');

  // o: { view, scope ('frontier' | 'all' | 'critical'), milestone (a key, or ''), q (search text), owner,
  // fold(id) → 'open' | 'closed' | undefined, hidden (a Set of the legend's kinds switched off: done, building,
  // ready, needs, human), sel (the selected task's id) }. Returns the rows in order and the toolbar's totals. Hidden
  // kinds take rows away, never work from an item's bar: an epic still shows how much of it is merged with its
  // merged tasks hidden. The selected task shows whatever the scope and filters, where its folds allow, so a link to
  // it lands on it.
  function mapRows(board, o) {
    const view = viewOf(o.view);
    const scope = o.scope ?? 'frontier';
    const q = (o.q ?? '').trim().toLowerCase();
    const fold = o.fold ?? (() => undefined);
    const hidden = o.hidden ?? new Set();
    const visible = (t) => !hidden.has(kindOf(t));
    const byTask = new Map(board.tasks.map((t) => [t.id, t]));
    const items = new Map(board.items.map((i) => [i.id, i]));
    const crit = new Set(board.criticalPath);
    // The milestone's tasks, or every task.
    const inScope = (t) => !o.milestone || t.milestone === o.milestone;
    const tasksOf = (item) => item.tasks.map((id) => byTask.get(id)).filter((t) => t && inScope(t));
    // Search: a task by its id, its title, or the commit it merged as; an item by its title or key, which brings
    // everything under it.
    const hit = (t) => t.id.toLowerCase().includes(q) || t.title.toLowerCase().includes(q) || (q.length >= 6 && /^[0-9a-f]+$/.test(q) && t.commit?.startsWith(q));
    const named = (i) => i.title.toLowerCase().includes(q) || i.key.includes(q);
    const chain = (i) => {
      const out = [];
      for (let x = i; x; x = x.parent ? items.get(x.parent) : undefined) out.push(x);
      return out;
    };
    const laneOf = new Map(board.items.map((i) => [i.id, chain(i).at(-1).id]));
    // Items the search names, and every item above one: each shows, with what is under it.
    const nameHits = new Set(q ? board.items.filter(named).map((i) => i.id) : []);
    const above = new Set(q ? board.items.filter((i) => nameHits.has(i.id)).flatMap((i) => chain(i).map((x) => x.id)) : []);
    const covered = (i) => !!q && chain(i).some((x) => nameHits.has(x.id));
    const showTask = (t, owner) => t.id === o.sel || (visible(t) && (q ? hit(t) || covered(owner) : scope === 'critical' ? crit.has(t.id) : scope === 'frontier' ? t.frontier : true));
    const roll = new Map();
    const rolled = (i) => {
      if (!roll.has(i.id)) roll.set(i.id, rollup(tasksOf(i)));
      return roll.get(i.id);
    };
    // An item shows when it has work in the milestone of a kind not hidden, and matches the search or the critical
    // scope.
    const showItem = (i) => {
      if (o.sel && i.tasks.includes(o.sel)) return true;
      const ts = tasksOf(i).filter(visible);
      if (!ts.length) return false;
      if (q) return above.has(i.id) || covered(i) || ts.some(hit);
      if (scope === 'critical') return ts.some((t) => crit.has(t.id));
      return true;
    };
    const folded = (i) => {
      if (q) return false;
      const manual = fold(i.id);
      if (manual === 'open') return false;
      if (manual === 'closed') return true;
      const r = rolled(i);
      return r.done === r.total || (scope !== 'all' && !r.frontier);
    };

    const rows = [];
    // People first: the human tasks the build waits on; with a milestone picked, those its work waits on.
    const waitedOn = o.milestone ? new Set(board.tasks.filter(inScope).flatMap((t) => t.waits ?? [])) : undefined;
    const open = hidden.has('human') ? [] : board.human.filter((x) => x.status !== 'done' && (!waitedOn || waitedOn.has(x.id)));
    const humans = open.filter((x) => (q ? x.id.toLowerCase().includes(q) || x.title.toLowerCase().includes(q) : scope === 'all' ? true : scope === 'critical' ? x.critical : x.frontier)).sort((a, b) => b.held - a.held);
    if (humans.length) {
      rows.push({ kind: 'head', id: 'lane:human', text: `Human tasks · ${o.owner ?? 'you'}`, meta: `${humans.length} of ${open.length} open`, human: true });
      for (const x of humans) rows.push({ kind: 'human', id: x.id, t: x });
    }
    const lanes = board.items.filter((i) => i.level === 'lane');
    const kids = (i) => i.children.map((id) => items.get(id)).filter(showItem);
    const head = (l) => {
      const r = rolled(l);
      return { kind: 'head', id: `head:${l.id}`, item: l, text: l.title, meta: `${Math.round((r.done / Math.max(1, r.total)) * 100)}%` };
    };
    const itemRow = (i, depth, foldable) => ({ kind: 'item', id: i.id, item: i, roll: rolled(i), depth, ...(foldable ? { folded: folded(i) } : {}) });
    const taskRows = (s, depth) => tasksOf(s).filter((t) => showTask(t, s)).map((t) => ({ kind: 'task', id: t.id, t, depth }));
    for (const l of lanes.filter(showItem)) {
      if (view === 'lane') {
        rows.push(itemRow(l, 0, false));
        continue;
      }
      if (view === 'hybrid') {
        const walk = (i, depth) => {
          const row = itemRow(i, depth, true);
          rows.push(row);
          if (row.folded) return;
          if (i.level === 'story') rows.push(...taskRows(i, depth + 1));
          else for (const c of kids(i)) walk(c, depth + 1);
        };
        walk(l, 0);
        continue;
      }
      const under = [];
      if (view === 'task') {
        for (const s of board.items.filter((i) => i.level === 'story' && laneOf.get(i.id) === l.id)) under.push(...taskRows(s, 1));
      } else {
        for (const i of board.items.filter((x) => x.level === view && laneOf.get(x.id) === l.id && showItem(x))) under.push(itemRow(i, 1, false));
      }
      if (under.length) rows.push(head(l), ...under);
    }

    // The toolbar's totals: the items of the view's level with work in the milestone, whatever the scope shows.
    const totals = Object.fromEntries(LEVELS.map((level) => [level, board.items.filter((i) => i.level === level && tasksOf(i).length).length]));
    totals.task = board.tasks.filter(inScope).length;
    const text = view === 'hybrid' ? [...LEVELS, 'task'].map((level) => count(totals[level], level)).join(' · ') : count(totals[view], view);
    return { view, rows, totals, text };
  }

  // The dependency lines for the selection: a task, a human task, or `item:<id>` (a lane, epic, feature or story, as
  // all its tasks). They are its own: from what it waits on and to what waits on it, and, for an item, between its
  // tasks; whole chains would cover the chart from any task many others build on. Each end is drawn at the row that
  // shows its task: the task's own, or the folded row that holds it (a Lane to Story view's rows hold their tasks). A
  // task hidden by the scope or a filter is passed through to the nearest shown, and that line is marked `via`.
  // Returns [{ from, to, via, crit }] by row index, from the row waited on to the row that waits; `crit` on the
  // critical path.
  function mapEdges(board, rows, sel) {
    if (!sel) return [];
    const deps = new Map([...board.tasks, ...board.human].map((t) => [t.id, t.deps ?? []]));
    const dependents = new Map();
    for (const [id, ds] of deps) for (const d of ds) dependents.set(d, [...(dependents.get(d) ?? []), id]);
    const items = new Map(board.items.map((i) => [i.id, i]));
    const chosen = new Set(sel.startsWith('item:') ? (items.get(sel.slice(5))?.tasks ?? []) : deps.has(sel) ? [sel] : []);
    if (!chosen.size) return [];
    // The chains both ways, for the hidden tasks a line passes through.
    const reach = (next) => {
      const seen = new Set();
      const stack = [...chosen];
      while (stack.length) for (const x of next.get(stack.pop()) ?? []) if (!chosen.has(x) && !seen.has(x)) seen.add(x), stack.push(x);
      return seen;
    };
    const up = reach(deps);
    const down = reach(dependents);
    const relevant = new Set([...chosen, ...up, ...down]);
    const rowOf = rowsOf(rows);
    // The nearest predecessors that have a row, through those that have none.
    const shownBefore = (b) => {
      const out = [];
      const seen = new Set();
      const walk = (n, via) => {
        for (const a of deps.get(n) ?? []) {
          if (seen.has(a) || !relevant.has(a)) continue;
          seen.add(a);
          if (rowOf.has(a)) out.push([a, via]);
          else walk(a, true);
        }
      };
      walk(b, false);
      return out;
    };
    const own = (a, b) => chosen.has(a) || chosen.has(b);
    const crit = new Set(board.criticalPath);
    const out = new Map();
    for (const b of relevant) {
      if (!rowOf.has(b)) continue;
      for (const [a, via] of shownBefore(b)) {
        if (!own(a, b)) continue;
        const from = rowOf.get(a);
        const to = rowOf.get(b);
        if (from === to) continue;
        const key = `${from}>${to}`;
        const e = out.get(key) ?? { from, to, via: true, crit: false };
        e.via &&= via;
        e.crit ||= !via && crit.has(a) && crit.has(b);
        out.set(key, e);
      }
    }
    return [...out.values()];
  }

  // Where each task is drawn, by row index: folded rows (and a level view's rows) hold their tasks, the deepest one
  // winning, and a task's own row wins over all; an open row in Hybrid holds nothing, its tasks being shown or
  // filtered out.
  const DEPTH = { lane: 0, epic: 1, feature: 2, story: 3 };
  function rowsOf(rows) {
    const rowOf = new Map();
    rows.map((r, n) => [r, n]).filter(([r]) => r.kind === 'item' && r.folded !== false).sort(([a], [b]) => DEPTH[a.item.level] - DEPTH[b.item.level])
      .forEach(([r, n]) => { for (const id of r.item.tasks) rowOf.set(id, n); });
    rows.forEach((r, n) => { if (r.kind === 'task' || r.kind === 'human') rowOf.set(r.id, n); });
    return rowOf;
  }
  // The row that shows the selection: an item's own, or the row that draws a task (above).
  const selectedRow = (rows, sel) => (!sel ? -1 : sel.startsWith('item:') ? rows.findIndex((r) => r.kind === 'item' && r.id === sel.slice(5)) : (rowsOf(rows).get(sel) ?? -1));

  // What the Map's left column says it holds, per view.
  const columnTitle = (view) => ({ lane: 'Lane', epic: 'Lane › epic', feature: 'Lane › feature', story: 'Lane › story', task: 'Lane › task', hybrid: 'Lane › epic › feature › story' })[viewOf(view)];

  HX.mapRows = mapRows;
  HX.mapEdges = mapEdges;
  HX.mapSelectedRow = selectedRow;
  HX.mapRollup = rollup;
  HX.mapKindOf = kindOf;
  HX.mapView = viewOf;
  HX.mapColumnTitle = columnTitle;
  HX.MAP_VIEWS = VIEWS;
})();
