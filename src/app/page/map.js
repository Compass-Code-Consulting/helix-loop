// The Map (spec §6.4): the TaskSet against time, drawn by the page from the server's board. The View picks the level,
// Lane › Epic › Feature › Story › Task, or Hybrid, which nests them with folds: finished items and those with nothing
// on the frontier fold, and the Frontier scope opens only what is running, next, failing or waiting on a person, so
// thousands of tasks read as a few dozen rows (maprows.js decides the rows). Each milestone is a dated line across
// the chart, and the Milestone filter keeps its work alone. The filters (View, scope, milestone, the legend's kinds,
// the search and the time scale) and the selection are in the URL, so a link opens the Map as it was; the ones last
// used, folds, Wrap and the task column's width are kept in .helix/app.yaml. Hours, Days and Weeks are presets of the
// time scale, and a pinch on a trackpad zooms it between them and beyond, around the time under the pointer. Selecting
// a row draws its dependencies: lines from what it waits on and to what waits on it. Rows are drawn only where the
// view can see them.
(() => {
  'use strict';
  const { h, fill, F, S } = HX;
  const ROW = 31;
  const PX = { hours: 40 / 3_600_000, days: 34 / 86_400_000, weeks: 9 / 86_400_000 };
  const PX_MIN = 3 / 86_400_000;
  const PX_MAX = 160 / 3_600_000;
  const DAY = 86_400_000;
  // Tick steps, finest first: the first at least 60 px apart is used.
  const STEPS = [3_600_000, 3 * 3_600_000, 6 * 3_600_000, 12 * 3_600_000, DAY, 2 * DAY, 7 * DAY, 14 * DAY, 28 * DAY];
  const M = { el: null, board: null, sel: null, detail: null, q: '', rows: [], scrollTop: 0, f: {} };

  HX.views.map = {
    mount(el, parts, params) {
      M.el = el;
      M.sel = parts[0] || HX.store.get('mapSel') || null;
      M.reveal = M.sel;
      fromRoute(params);
      build();
      syncRoute();
      load();
    },
    // A link to a task, or a URL edited by hand or met going back: its filters, then its selection.
    route(parts, params) {
      if (named(params) && filterQuery(params) !== filterQuery(new URLSearchParams(queryOf()))) {
        fromRoute(params);
        renderTools();
        renderLegend();
        layout();
      }
      const id = parts[0];
      if (id && id !== M.sel) {
        M.reveal = id;
        if (id.startsWith('item:')) {
          const i = M.itemById?.get(id.slice(5));
          if (i) selectItem(i);
        } else select(id);
        reveal(id);
      } else syncRoute();
    },
    async update(what) {
      if (what.has('logs') && what.size === 1) return drawRows();
      if (['all', 'plan', 'ledger', 'live', 'reports', 'agents', 'loop', 'config'].some((w) => what.has(w))) await load();
      if (M.sel && ['all', 'plan', 'ledger', 'live', 'reports', 'threads'].some((w) => what.has(w))) loadDetail();
    },
    back() {
      if (M.sel) {
        select(null);
        return true;
      }
      return false;
    },
  };

  const opt = (k, d) => HX.ui(`map.${k}`, d);
  // Pixels per millisecond last used: the pinched scale if there is one, else the preset picked last.
  const pxSaved = () => {
    const v = Number(opt('px', 0));
    return v >= PX_MIN && v <= PX_MAX ? v : PX[opt('scale', 'days')] ?? PX.days;
  };
  const presetOf = (px) => Object.keys(PX).find((k) => Math.abs(PX[k] / px - 1) < 0.01) ?? null;

  // ---- the filters, in the URL: #map/T-1234?view=feature&scope=all&ms=publishing&hide=done,human&q=reels&scale=hours ----
  // A parameter left out is its default; a URL with none of them takes the filters last used here, and then shows
  // them. Each change is saved as the last used, and replaces the URL without adding to the history.
  const FILTERS = { view: ['map.view', 'hybrid'], scope: ['map.scope', 'frontier'], ms: ['map.milestone', ''], hide: ['map.hide', ''] };
  const KEYS = [...Object.keys(FILTERS), 'q', 'scale'];
  const named = (params) => !!params && KEYS.some((k) => params.has(k));
  const filterQuery = (params) => KEYS.map((k) => `${k}=${params?.get(k) ?? ''}`).join('&');
  // Pixels per millisecond from `scale`: a preset's name, or pixels per day.
  const scaleOf = (s) => (PX[s] ? PX[s] : Number(s) > 0 ? Math.max(PX_MIN, Math.min(PX_MAX, Number(s) / DAY)) : PX.days);
  function fromRoute(params) {
    const url = named(params);
    for (const [k, [key, d]] of Object.entries(FILTERS)) M.f[k] = url ? (params.get(k) ?? d) : String(HX.ui(key, d));
    M.f.px = url ? scaleOf(params.get('scale')) : pxSaved();
    if (url) M.q = params.get('q') ?? '';
    if (url) persist();
  }
  function persist() {
    for (const [k, [key]] of Object.entries(FILTERS)) if (HX.ui(key) !== M.f[k]) HX.setUi(key, M.f[k]);
    if (HX.ui('map.px') !== M.f.px) {
      HX.setUi('map.px', M.f.px);
      if (presetOf(M.f.px)) HX.setUi('map.scale', presetOf(M.f.px));
    }
  }
  // The filters as URL parameters, each left out at its default.
  function queryOf() {
    const p = {};
    if (M.f.view !== 'hybrid') p.view = M.f.view;
    if (M.f.scope !== 'frontier') p.scope = M.f.scope;
    if (M.f.ms) p.ms = M.f.ms;
    if (M.f.hide) p.hide = M.f.hide;
    if (M.q) p.q = M.q;
    const preset = presetOf(M.f.px);
    if (preset !== 'days') p.scale = preset ?? String(Math.round(M.f.px * DAY * 100) / 100);
    return p;
  }
  const syncRoute = () => HX.setRoute(M.sel ? [M.sel] : [], queryOf());
  // Typing and pinching change the URL once they settle: browsers limit how often a page may replace it.
  let syncTimer;
  const syncSoon = () => {
    clearTimeout(syncTimer);
    syncTimer = setTimeout(syncRoute, 250);
  };
  function setFilter(k, v) {
    M.f[k] = v;
    persist();
    syncRoute();
  }
  const pxNow = () => M.f.px;
  let B;
  function build() {
    // A new chart opens with "now" in view, however the last one was scrolled.
    M.axis = undefined;
    M.body = null;
    M.placedAt = undefined;
    B = {
      tools: h('div', { class: 'bar1' }),
      legend: h('div', { class: 'legend', role: 'group', 'aria-label': 'Show or hide' }),
      gantt: h('div', { class: 'gantt' }),
      panel: h('aside', { class: `panel${opt('panel', true) === false ? ' closed' : ''}`, 'aria-label': 'Detail' }),
    };
    B.gantt.addEventListener('scroll', () => {
      M.scrollTop = B.gantt.scrollTop;
      drawRows();
    });
    pinch();
    fill(M.el, h('section', { class: 'map' }, B.tools, B.legend, B.gantt), B.panel);
    renderLegend();
    renderTools();
    renderPanel();
  }

  const VIEW_LABELS = [['lane', 'Lane'], ['epic', 'Epic'], ['feature', 'Feature'], ['story', 'Story'], ['task', 'Task'], ['hybrid', 'Hybrid']];
  const viewNow = () => HX.mapView(M.f.view);
  // The milestone filter, while the board still has it.
  const milestoneNow = () => (M.board?.milestones.some((m) => m.key === M.f.ms) ? M.f.ms : '');

  function renderTools() {
    const search = h('input', { class: 'input search', placeholder: 'Find a task, story, feature or commit', value: M.q, 'aria-label': 'Find' });
    search.oninput = () => {
      M.q = search.value.trim();
      syncSoon();
      layout();
    };
    search.onkeydown = (e) => {
      if (e.key === 'Enter') {
        const hit = M.rows.find((r) => r.kind === 'task' || r.kind === 'human');
        if (hit) select(hit.id);
      }
    };
    const ms = M.board?.milestones ?? [];
    const pick = h('select', { class: 'input msel', 'aria-label': 'Milestone', title: 'Show one milestone\'s work' },
      h('option', { value: '' }, 'All milestones'),
      ms.map((m, i) => h('option', { value: m.key, selected: m.key === milestoneNow() }, `${i + 1}. ${m.title}${m.reached ? ' ✓' : ''}`)));
    pick.onchange = () => {
      setFilter('ms', pick.value);
      renderTools();
      layout();
    };
    fill(B.tools,
      h('span', { class: 'muted' }, 'View'),
      HX.seg(VIEW_LABELS, viewNow(), (v) => { setFilter('view', v); renderTools(); layout(); }),
      HX.seg([['frontier', 'Frontier'], ['all', 'All'], ['critical', 'Critical path']], M.f.scope, (v) => { setFilter('scope', v); renderTools(); layout(); }),
      ms.length ? pick : null,
      search,
      M.totals ? h('span', { class: 'totals', title: milestoneNow() ? 'In the milestone picked' : 'In the TaskSet' }, M.totals) : null,
      h('span', { class: 'grow' }),
      HX.seg([['hours', 'Hours'], ['days', 'Days'], ['weeks', 'Weeks']], presetOf(pxNow()), (v) => { setFilter('px', PX[v]); renderTools(); layout(true); }, 'scaleseg'),
      HX.btn('Export', HX.act(async () => { await HX.post('/api/export', { what: 'map' }); HX.toast('Exporting the static map (helix-loop map)…'); }), 'btn-ghost'));
  }

  // The legend doubles as the Map's filters: each kind of row and each line it names shows or hides when clicked,
  // and the Map remembers which are off. "Folded" only explains how a folded row is drawn, so it stays text.
  const hiddenNow = () => new Set(M.f.hide.split(',').filter(Boolean)); // as text: done,human
  const shown = (key) => !hiddenNow().has(key);
  function renderLegend() {
    const off = hiddenNow();
    const dash = (color, step = 3) => h('i', { class: 'dash', style: { background: `repeating-linear-gradient(to bottom, ${color} 0 ${step}px, transparent ${step}px ${step + 2}px)` } });
    const toggle = (key, swatch, text, title) => h('button', {
      type: 'button', class: `lkey${off.has(key) ? ' off' : ''}`, 'aria-pressed': String(!off.has(key)), title: `${title ? `${title}\n` : ''}${off.has(key) ? 'Hidden: click to show' : 'Click to hide'}`,
      onclick: () => {
        const next = hiddenNow();
        next.has(key) ? next.delete(key) : next.add(key);
        setFilter('hide', [...next].join(','));
        renderLegend();
        layout();
      },
    }, swatch, text);
    const b = M.board;
    fill(B.legend,
      toggle('done', h('i', { style: { background: 'var(--ok)' } }), '✓ done', 'Merged tasks'),
      toggle('building', h('i', { style: { background: 'repeating-linear-gradient(135deg,var(--color-accent) 0 3px,var(--color-accent-600) 3px 6px)' } }), '◐ building', 'Tasks in a pass now'),
      toggle('ready', h('i', { style: { boxShadow: 'inset 0 0 0 1px var(--color-neutral-500)' } }), '○ ready', 'Tasks waiting for a builder, or for the work they wait on'),
      toggle('needs', h('i', { style: { border: '1.5px dashed var(--crit)' } }), '! needs you', 'Tasks waiting on you, or parked'),
      toggle('human', h('i', { style: { background: 'repeating-linear-gradient(135deg,var(--warn) 0 3px,transparent 3px 6px)' } }), 'human task', 'Your human tasks, at the top'),
      h('span', { class: 'lnote' }, '▸ folded: green share is merged'),
      toggle('now', h('i', { style: { width: '1px', height: '12px', background: 'var(--color-text)' } }), 'now'),
      toggle('deps', h('i', { class: 'arrow' }), 'dependencies', 'Select a row to draw lines from what it waits on and to what waits on it; dashed where they pass through rows not shown'),
      b?.codeFinish != null ? [toggle('code', dash('var(--color-accent)'), 'code complete', TITLE.code), toggle('project', dash('var(--crit)'), 'project complete', TITLE.project)] : b ? toggle('project', dash('var(--crit)'), 'projected finish') : null,
      b?.milestones.length ? toggle('milestone', dash('var(--ms)', 2), 'milestone', 'When each milestone was reached, or is projected to be') : null,
      b?.unplaced.length ? h('span', { class: 'derived t-warn', style: { marginLeft: 'auto' }, title: 'They name a story .helix/plan/taskset.yaml does not declare: helix-loop validate lists them' }, `${F.plural(b.unplaced.length, 'task')} not in the TaskSet`) : null);
  }

  async function load() {
    M.board = await HX.api('/api/board');
    renderLegend();
    M.byId = new Map([...M.board.tasks, ...M.board.human.map((x) => ({ ...x, kind: 'human' }))].map((t) => [t.id, t]));
    M.itemById = new Map(M.board.items.map((i) => [i.id, i]));
    // An item selected by the URL or last time, as this board has it.
    if (M.sel?.startsWith('item:')) {
      const i = M.itemById.get(M.sel.slice(5));
      if (i) M.detail = { item: i };
      else {
        M.sel = null;
        M.detail = null;
        syncRoute();
      }
    }
    layout();
    if (M.sel && !M.detail) loadDetail();
    else if (M.detail?.item) renderPanel();
    else if (!M.sel) renderPanel(); // its legend note names the finish lines the board has
  }

  // ---- which rows show ----
  function layout(keepScroll) {
    if (!M.board) return;
    const r = HX.mapRows(M.board, { view: viewNow(), scope: M.f.scope, milestone: milestoneNow(), q: M.q, owner: HX.owner(), fold: (id) => HX.ui(`fold:${id}`), hidden: hiddenNow(), sel: M.sel && !M.sel.startsWith('item:') ? M.sel : undefined });
    M.rows = r.rows;
    if (M.totals !== r.text) {
      M.totals = r.text;
      renderTools();
    }
    // The time axis: from the first visible bar (at most four weeks back) to the projected finish.
    const now = M.board.now;
    const bars = M.rows.flatMap((x) => (x.t ? [x.t.start ?? x.t.expectedDone, x.t.end ?? x.t.expectedDone] : x.roll ? [x.roll.start, x.roll.end] : [])).filter((v) => v != null);
    const t0 = Math.max(Math.min(now - 86_400_000, ...bars), now - 28 * 86_400_000);
    const t1 = Math.max(now + 2 * 86_400_000, M.board.finish, ...bars) + 86_400_000;
    const start = new Date(new Date(t0).toDateString()).getTime();
    // The time at the chart's left edge stays there: another view, scope or filter can start the axis elsewhere.
    const was = M.axis ? M.axis.start + B.gantt.scrollLeft / M.axis.px : undefined;
    M.axis = { start, end: t1, px: pxNow() };
    drawGrid();
    // Open with "now" a little in from the left of the chart, and again when the scale it was placed at changes (the
    // saved scale arrives with the page's state, after a first layout at the default one).
    if (keepScroll || was === undefined || M.placedAt !== M.axis.px) {
      B.gantt.scrollLeft = Math.max(0, x(now) - 160);
      M.placedAt = M.axis.px;
    } else B.gantt.scrollLeft = Math.max(0, (was - start) * M.axis.px);
    if (M.reveal) reveal(M.reveal);
  }

  // A two-finger pinch over the chart changes its time scale, keeping the time under the pointer where it is.
  // Browsers report a trackpad pinch as a wheel event with ctrlKey set; Safari also sends gesture events.
  function pinch() {
    let want = 0;
    let at = 0;
    let frame = 0;
    const apply = () => {
      frame = 0;
      if (!M.axis) return;
      const px = Math.max(PX_MIN, Math.min(PX_MAX, want));
      if (px === M.axis.px) return;
      const r = B.gantt.getBoundingClientRect();
      const cw = colW();
      const off = Math.max(cw, Math.min(r.width, at - r.left));
      const t = M.axis.start + (B.gantt.scrollLeft + off - cw) / M.axis.px;
      M.axis.px = px;
      M.placedAt = px; // the pinch keeps the time under the pointer: it is no reason to jump back to now
      M.f.px = px;
      persist();
      syncSoon();
      drawGrid();
      B.gantt.scrollLeft = Math.max(0, cw + (t - M.axis.start) * px - off);
      const seg = B.tools.querySelector('.scaleseg');
      const pre = presetOf(px);
      seg?.querySelectorAll('button').forEach((b, i) => b.setAttribute('aria-pressed', String(['hours', 'days', 'weeks'][i] === pre)));
    };
    const zoom = (factor, clientX) => {
      want = (frame ? want : M.axis?.px ?? pxNow()) * factor;
      at = clientX;
      frame ||= requestAnimationFrame(apply);
    };
    let gesture = false;
    B.gantt.addEventListener('wheel', (e) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      if (gesture) return;
      // Spread (deltaY < 0) zooms in to a finer scale; pinch zooms out.
      zoom(Math.exp(-e.deltaY * 0.01), e.clientX);
    }, { passive: false });
    let base = 0;
    B.gantt.addEventListener('gesturestart', (e) => {
      e.preventDefault();
      gesture = true;
      base = M.axis?.px ?? pxNow();
    });
    B.gantt.addEventListener('gestureend', () => (gesture = false));
    B.gantt.addEventListener('gesturechange', (e) => {
      e.preventDefault();
      want = base * e.scale;
      at = e.clientX;
      frame ||= requestAnimationFrame(apply);
    });
  }

  // Brings a row into view: the selection, when it was opened from elsewhere; its own row, or the one that holds it.
  function reveal(id) {
    const i = HX.mapSelectedRow(M.rows, id);
    if (i < 0) return;
    M.reveal = null;
    const top = i * ROW;
    if (top < B.gantt.scrollTop + 40 || top > B.gantt.scrollTop + B.gantt.clientHeight - 80) {
      B.gantt.scrollTop = Math.max(0, top - B.gantt.clientHeight / 3);
      M.scrollTop = B.gantt.scrollTop;
      drawRows(true);
    }
  }

  const x = (ms) => (ms - M.axis.start) * M.axis.px;
  const TITLE = {
    code: "The last builder task's merge, if every human task were done when it is needed",
    project: "The last builder task's merge, with human tasks taking their lead times",
  };
  const colW = () => Math.max(200, Math.min(640, Number(opt('col', 330)) || 330));

  // The grid's fixed parts: the header with its ticks, the gridlines, and a body the rows are drawn into.
  function drawGrid() {
    const wrap = opt('wrap', false) === true;
    B.gantt.classList.toggle('wrap', wrap);
    const width = x(M.axis.end);
    const cw = colW();
    const ticks = [];
    const step = STEPS.find((s) => s * M.axis.px >= 60) ?? STEPS.at(-1);
    for (let t = M.axis.start; t < M.axis.end; t += step) ticks.push(t);
    const label = (t) => step < DAY ? (new Date(t).getHours() === 0 ? new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : new Date(t).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false })) : new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    const wrapBox = h('input', { type: 'checkbox', checked: wrap, onchange: (e) => { HX.setUi('map.wrap', e.target.checked); drawGrid(); } });
    const resize = h('div', { class: 'g-resize', tabindex: '0', role: 'separator', 'aria-label': 'Task column width', 'aria-valuenow': cw, style: { left: `${cw - 4}px` } });
    resize.onpointerdown = (e) => {
      e.preventDefault();
      const x0 = e.clientX;
      const w0 = colW();
      const move = (ev) => {
        const w = Math.max(200, Math.min(640, Math.round(w0 + ev.clientX - x0)));
        M.el.style.setProperty('--col', `${w}px`);
        for (const n of B.gantt.querySelectorAll('.g-lab, .g-head .lab')) n.style.width = `${w}px`;
        resize.style.left = `${w - 4}px`;
        M.pendingCol = w;
      };
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        document.body.style.cursor = '';
        if (M.pendingCol) HX.setUi('map.col', M.pendingCol);
        drawGrid();
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
      document.body.style.cursor = 'col-resize';
    };
    resize.onkeydown = (e) => {
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        HX.setUi('map.col', Math.max(200, Math.min(640, colW() + (e.key === 'ArrowRight' ? 16 : -16))));
        drawGrid();
        resize.focus?.();
      }
    };
    resize.ondblclick = () => {
      HX.setUi('map.col', 330);
      drawGrid();
    };
    const now = M.board.now;
    // The finish lines, each with a chip in the header beside its line. A chip that would run into the "now" chip or
    // the other one either way is left out; its line and the legend still say where it is.
    const { finish, codeFinish: code } = M.board;
    const chipW = (text) => text.length * 6.2 + 14;
    const chips = [];
    const span = (c) => (c.start ? [c.at, c.at + chipW(c.text)] : [c.at - chipW(c.text), c.at]);
    const clear = (a, b) => a[1] + 6 < b[0] || b[1] + 6 < a[0];
    const fits = (c) => clear(span(c), [x(now) - 44, x(now) + 44]) && chips.every((o) => clear(span(c), span(o)));
    // Ending at its line if it can, else starting there.
    const add = (c) => (fits(c) ? chips.push(c) : fits({ ...c, start: true }) ? chips.push({ ...c, start: true, cls: `${c.cls} start` }) : 0);
    if (shown('project')) add({ cls: 'finchip', text: code != null ? 'Project complete' : 'Finish', at: x(finish), title: code != null ? `Project complete ${F.dayTime(finish)}: ${TITLE.project.toLowerCase()}` : `Projected finish ${F.dayTime(finish)}` });
    if (code != null && shown('code')) add({ cls: 'finchip code', text: 'Code complete', at: x(code), title: `Code complete ${F.dayTime(code)}: ${TITLE.code.toLowerCase()}` });
    const covered = (t) => Math.abs(x(t) - x(now)) <= 56 || chips.some((c) => !clear([x(t) + 4, x(t) + 48], span(c)));
    // The milestones, each a dated line with its title in the strip under the axis, cut to the room before the next
    // one; the one picked in the filter stands out, and its tooltip says when.
    const picked = milestoneNow();
    const ms = shown('milestone') ? M.board.milestones.map((m, i) => ({ ...m, n: i + 1 })).filter((m) => m.at != null).sort((a, b) => a.at - b.at) : [];
    // Milestones close together keep their order: a chip that would cover the one before moves right, without its
    // marker, and shows only its number when there is no room for its title.
    let end = -Infinity;
    const msLabels = ms.map((m, i) => {
      const at = x(m.at);
      const left = Math.max(at, end + 4);
      const room = (i + 1 < ms.length ? x(ms[i + 1].at) : width) - left - 8;
      const titled = room > 60;
      end = left + (titled ? Math.min(room, m.title.length * 6.2 + 30) : 22);
      const when = `${m.reached ? 'Reached' : 'Projected'} ${F.dayTime(m.at)}`;
      return h('span', { class: `mschip${m.reached ? ' reached' : ''}${m.key === picked ? ' picked' : ''}${left > at + 1 ? ' moved' : ''}`, style: { left: `${left}px`, maxWidth: `${titled ? room : 22}px` }, title: `${m.n}. ${m.title}\n${when}\nDemo: ${m.demo}`, onclick: () => { setFilter('ms', m.key === picked ? '' : m.key); renderTools(); layout(); } },
        h('b', null, String(m.n)), titled ? h('span', null, m.title) : null);
    });
    M.body = h('div', { style: { position: 'relative' } });
    M.lines = h('div', { class: 'g-lines', style: { left: `${cw}px`, width: `${width}px` } },
      ticks.map((t) => h('i', { style: { left: `${x(t)}px` } })),
      ms.map((m) => h('i', { class: `ms${m.reached ? ' reached' : ''}${m.key === picked ? ' picked' : ''}`, style: { left: `${x(m.at)}px` } })),
      shown('now') ? h('i', { class: 'now', style: { left: `${x(now)}px` } }) : null,
      code != null && shown('code') ? h('i', { class: 'fin code', style: { left: `${x(code)}px` } }) : null,
      shown('project') ? h('i', { class: 'fin', style: { left: `${x(finish)}px` } }) : null);
    const grid = h('div', { class: `grid${ms.length ? ' with-ms' : ''}`, style: { width: `${cw + width}px` } },
      h('div', { class: 'g-head' },
        h('div', { class: 'lab', style: { width: `${cw}px` } }, HX.mapColumnTitle(viewNow()), h('label', { class: 'check wrapc' }, wrapBox, 'Wrap')),
        h('div', { class: 'axis', style: { width: `${width}px` } },
          // A label the "now" chip or a finish chip would cover is left out; its gridline stays.
          ticks.filter((t) => !covered(t)).map((t) => h('span', { class: 'tick', style: { left: `${x(t)}px` } }, label(t))),
          chips.map((c) => h('span', { class: c.cls, title: c.title, style: { left: `${c.at + 1}px` } }, c.text)),
          shown('now') ? h('span', { class: 'nowchip', style: { left: `${x(now)}px` } }, new Date(now).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })) : null,
          ms.length ? h('div', { class: 'msstrip' }, msLabels) : null)),
      h('div', { style: { position: 'relative' } }, M.lines, M.body, M.deps = svgEl('svg', { class: 'g-deps', 'aria-hidden': 'true' })),
      resize);
    M.deps.style.left = `${cw}px`;
    // The rows' height first: without it the chart is momentarily header-high, and the scroll put back would be cut to
    // the top (a selection opened from a link, or the place the owner was reading when a live update redrew).
    if (!wrap) M.body.style.height = M.lines.style.height = `${M.rows.length * ROW}px`;
    B.gantt.replaceChildren(grid);
    B.gantt.scrollTop = M.scrollTop;
    drawRows(true);
    if (wrap) B.gantt.scrollTop = M.scrollTop;
  }

  // Only the rows in view (and a screen's worth either side) are in the page; with Wrap on, rows grow, so all are.
  function drawRows(force) {
    if (!M.body || !M.board) return;
    const wrap = opt('wrap', false) === true;
    const n = M.rows.length;
    const top = B.gantt.scrollTop;
    const viewH = B.gantt.clientHeight || 800;
    const from = wrap ? 0 : Math.max(0, Math.floor(top / ROW) - 20);
    const to = wrap ? n : Math.min(n, Math.ceil((top + viewH) / ROW) + 20);
    // Sideways scrolling moves the item bars' labels into view, a step at a time.
    const left = Math.round(B.gantt.scrollLeft / 48);
    if (!force && M.drawn && M.drawn.from === from && M.drawn.to === to && M.drawn.left === left && M.drawn.v === liveStamp()) return;
    M.drawn = { from, to, left, v: liveStamp() };
    if (force) M.selRow = HX.mapSelectedRow(M.rows, M.sel);
    M.body.style.height = wrap ? '' : `${n * ROW}px`;
    M.lines.style.height = wrap ? '' : `${n * ROW}px`;
    const frag = M.rows.slice(from, to).map((r, i) => {
      const el = row(r, from + i);
      if (!wrap) Object.assign(el.style, { position: 'absolute', top: `${(from + i) * ROW}px`, left: 0, right: 0 });
      return el;
    });
    M.body.replaceChildren(...frag);
    if (!n) M.body.replaceChildren(h('div', { class: 'muted', style: { padding: '20px', position: 'sticky', left: 0 } }, M.q ? `Nothing matches “${M.q}”.` : 'Nothing in this scope.'));
    if (force) drawDeps();
  }

  // ---- dependency lines: the selection's, between the rows that show each end (maprows.js mapEdges) ----
  const SVG = 'http://www.w3.org/2000/svg';
  const svgEl = (tag, attrs = {}) => {
    const el = document.createElementNS(SVG, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    return el;
  };
  function drawDeps() {
    if (!M.deps) return;
    const wrap = opt('wrap', false) === true;
    M.deps.setAttribute('width', String(Math.ceil(x(M.axis.end))));
    M.deps.setAttribute('height', String(wrap ? M.body.offsetHeight : M.rows.length * ROW));
    const edges = M.sel && shown('deps') ? HX.mapEdges(M.board, M.rows, M.sel) : [];
    if (!edges.length) return M.deps.replaceChildren();
    // Rows are a fixed height, except with Wrap on, when every row is in the page to be measured.
    const kids = wrap ? [...M.body.children] : null;
    const mid = (n) => (wrap ? kids[n] && kids[n].offsetTop + kids[n].offsetHeight / 2 : n * ROW + ROW / 2);
    const half = (n) => (wrap ? (kids[n]?.offsetHeight ?? ROW) : ROW) / 2;
    const marker = (id) => svgEl('marker', { id, viewBox: '0 0 6 6', refX: '5.5', refY: '3', markerWidth: '6', markerHeight: '6', markerUnits: 'userSpaceOnUse', orient: 'auto' });
    const heads = [marker('dep-ah'), marker('dep-ah-crit')];
    for (const m of heads) m.append(svgEl('path', { d: 'M0,0L6,3L0,6Z' }));
    heads[1].setAttribute('class', 'crit');
    const paths = [];
    for (const e of edges) {
      const a = barOf(M.rows[e.from]);
      const b = barOf(M.rows[e.to]);
      const y1 = mid(e.from);
      const y2 = mid(e.to);
      if (!a || !b || y1 == null || y2 == null) continue;
      // From the end of the bar waited on to the start of the one that waits; around, when it starts first.
      const x1 = a[1];
      const x2 = b[0];
      const d = x2 - 6 >= x1 + 4 ? `M${x1},${y1}H${x2 - 6}V${y2}H${x2}` : `M${x1},${y1}H${x1 + 5}V${y2 + (y2 > y1 ? -half(e.to) : half(e.to))}H${x2 - 6}V${y2}H${x2}`;
      paths.push(svgEl('path', { d, class: [e.via ? 'via' : '', e.crit ? 'crit' : ''].filter(Boolean).join(' '), 'marker-end': `url(#dep-ah${e.crit ? '-crit' : ''})` }));
    }
    M.deps.replaceChildren(svgEl('defs'), ...paths);
    M.deps.firstChild.append(...heads);
  }

  // A row's bar in pixels, [left, right], or null without dates: row() draws it there and the lines meet it.
  const itemMeta = (e) => `${e.done === e.total ? '✓ ' : ''}${e.done}/${e.total}${e.waitsOn && e.done !== e.total ? ` · waits ${e.waitsOn}` : ''}`;
  function barOf(r) {
    if (!r) return null;
    if (r.kind === 'item') {
      const e = r.roll;
      if (e.start == null || e.end == null) return null;
      const left = x(e.start);
      return [left, left + Math.max(e.done === e.total ? 16 : 8 + itemMeta(e).length * 6, x(e.end) - left)];
    }
    if (r.kind !== 'task' && r.kind !== 'human') return null;
    const human = r.kind === 'human';
    const s = human ? Math.min(r.t.latestStart ?? M.board.now, M.board.now) : r.t.start;
    const e = human ? r.t.expectedDone : r.t.end;
    if (s == null || e == null) return null;
    const left = x(s);
    return [left, left + Math.max(!human && r.t.status === 'done' ? 8 : 6, x(e) - left)];
  }
  const liveStamp = () => (S.state?.live ?? []).map((p) => `${p.task}${p.phase}${p.progress ?? ''}`).join('|');

  // Each level's indent in the label column: lanes, then epics, features, stories and tasks.
  const INDENT = [14, 26, 38, 50, 62];
  const LEVEL = { lane: 'Lane', epic: 'Epic', feature: 'Feature', story: 'Story' };

  function row(r, n) {
    const cw = colW();
    const track = h('div', { class: 'g-track', style: { width: `${x(M.axis.end)}px` } });
    if (r.kind === 'head') {
      const color = r.human ? 'var(--warn)' : (HX.laneColor(r.item.repo) ?? 'var(--color-accent)');
      return h('div', { class: 'g-row lane' }, h('div', { class: 'g-lab', style: { width: `${cw}px`, color, paddingLeft: '14px' } }, h('span', { class: 'tx' }, r.text), h('span', { class: 'meta' }, r.meta)), track);
    }
    if (r.kind === 'item') {
      const i = r.item;
      const e = r.roll;
      const done = e.done === e.total;
      const foldable = r.folded !== undefined;
      const sel = M.sel === `item:${i.id}` || n === M.selRow; // the item, or the folded row holding the selected task
      const lane = i.level === 'lane';
      const glyph = done ? '✓' : foldable ? (r.folded ? '▸' : '▾') : e.running ? '◐' : '';
      const label = h('button', { type: 'button', class: 'g-lab', style: { width: `${cw}px`, paddingLeft: `${INDENT[r.depth] ?? 14}px`, ...(lane ? { color: HX.laneColor(i.repo) ?? 'var(--color-accent)' } : {}) }, 'aria-expanded': foldable ? String(!r.folded) : null, title: trailText(i), onclick: () => {
        if (foldable) {
          HX.setUi(`fold:${i.id}`, r.folded ? 'open' : 'closed');
          layout();
        } else selectItem(i);
      } },
      h('span', { class: `gl ${done ? 'ok' : ''}` }, glyph), h('span', { class: 'tx' }, i.title), h('span', { class: 'meta' }, foldable && e.running ? '◐' : e.failing ? '!' : ''));
      const span = barOf(r);
      if (span) {
        const p = e.done / Math.max(1, e.total);
        const meta = itemMeta(e);
        const [bl, br] = span;
        const bw = br - bl;
        // Its label starts where the bar comes into view, so a bar begun weeks ago still says how far it has got.
        const inset = Math.max(0, Math.min(B.gantt.scrollLeft - bl, bw - meta.length * 6 - 10));
        track.append(h('div', { class: `g-bar item ${done ? 'done' : 'prog'}${sel ? ' sel' : ''}`, style: { left: `${bl}px`, width: `${bw}px`, paddingLeft: `${5 + inset}px`, '--p': `${p * 100}%` }, title: `${i.title}: ${e.done} of ${e.total} merged${done ? '' : `, projected to finish ${F.dayTime(e.end)}`}`, onclick: () => selectItem(i) }, meta));
      }
      return h('div', { class: `g-row item ${i.level}${done ? ' done' : ''}${sel ? ' sel' : ''}` }, label, track);
    }
    const t = r.t;
    const human = r.kind === 'human';
    const live = !human && S.state?.live.find((p) => p.task === t.id);
    const st = human ? 'human' : t.status === 'done' ? 'done' : t.status === 'claimed' ? 'run' : t.status === 'needs_human' || t.status === 'parked' ? 'need' : t.waits?.length ? 'blocked' : 'ready';
    const glyph = { human: ['◆', t.late ? 'crit' : 'warn'], done: ['✓', 'ok'], run: ['◐', 'acc'], need: ['!', 'crit'], blocked: ['○', ''], ready: ['○', ''] }[st];
    const sel = M.sel === t.id;
    const label = h('button', { type: 'button', class: 'g-lab', style: { width: `${cw}px`, paddingLeft: human ? '26px' : `${INDENT[r.depth] ?? 26}px` }, 'data-jk': '', onclick: () => select(t.id) },
      h('span', { class: `gl ${glyph[1]}` }, glyph[0]), h('span', { class: 'id' }, t.id), h('span', { class: 'tx', title: t.title }, t.title),
      h('span', { class: 'meta' }, human ? `holds ${t.held}` : live ? `(${HX.BADGE[live.agent]})` : t.status === 'claimed' && t.agent ? `(${HX.BADGE[t.agent]})` : ''));
    const s = human ? Math.min(t.latestStart ?? M.board.now, M.board.now) : t.start;
    const e = human ? t.expectedDone : t.end;
    const span = barOf(r);
    if (span) {
      const [left, right] = span;
      const w = right - left;
      const bar = h('div', { class: `g-bar ${st}${human && t.late ? ' late' : ''}${sel ? ' sel' : ''}`, style: { left: `${left}px`, width: `${w}px` }, title: `${t.id} · ${human ? `expected done ${F.dayTime(e)}` : st === 'done' ? `merged ${F.dayTime(e)}` : `${t.projected ? 'projected ' : ''}${F.dayTime(s)} to ${F.dayTime(e)}`}`, onclick: () => select(t.id) }, st === 'done' && w > 14 ? '✓' : st === 'need' ? '!' : '');
      // A failed attempt is a red notch on the bar.
      for (const f of t.fails ?? []) if (f >= s && f <= e + 60_000) bar.append(h('i', { class: 'notch', style: { left: `${x(f) - left}px` } }));
      track.append(bar);
      if (live) track.append(h('span', { class: 'g-live', style: { left: `${left + w + 8}px` } }, `${HX.PHASE[live.phase] ?? live.phase}${live.progress || live.lastMessage ? ` · ${(live.progress ?? live.lastMessage).slice(0, 80)}` : ''}`));
    }
    return h('div', { class: `g-row${sel ? ' sel' : ''}${st === 'done' ? ' done' : ''}` }, label, track);
  }

  // ---- the detail panel ----
  function select(id) {
    M.sel = id;
    M.detail = null;
    HX.store.set('mapSel', id ?? '');
    syncRoute();
    // A task the rows don't show yet (a link, the search, the panel) gets its row; a click on a row moves none.
    if (id && M.board && HX.mapSelectedRow(M.rows, id) < 0) layout();
    else drawRows(true);
    if (id && B.panel.classList.contains('closed')) togglePanel();
    renderPanel();
    if (id) loadDetail();
  }
  function selectItem(i) {
    M.sel = `item:${i.id}`;
    M.detail = { item: i };
    HX.store.set('mapSel', M.sel);
    syncRoute();
    drawRows(true);
    if (B.panel.classList.contains('closed')) togglePanel();
    renderPanel();
  }
  // An item's place: "Team notes › App shell and sign-in", outermost first, without the lane.
  const trailOf = (i) => {
    const out = [];
    for (let x = i; x; x = x.parent ? M.itemById.get(x.parent) : undefined) out.unshift(x);
    return out;
  };
  const trailText = (i) => trailOf(i).map((x) => x.title).join(' › ');
  HX.openTask = (id) => HX.go(`#map/${id}`);

  async function loadDetail() {
    const id = M.sel;
    if (!id || id.startsWith('item:')) return;
    try {
      const d = await HX.api('/api/task', { id });
      if (M.sel !== id) return;
      M.detail = d;
    } catch (e) {
      M.detail = { error: e.message };
    }
    renderPanel();
  }

  function togglePanel() {
    const closed = B.panel.classList.toggle('closed');
    HX.setUi('map.panel', !closed);
    renderPanel();
  }

  function renderPanel() {
    if (!B) return;
    const d = M.detail;
    const strip = h('div', { class: 'strip' },
      HX.btn(HX.icon('sidebar-simple'), togglePanel, 'btn-ghost collapse', { title: 'Show the detail panel', 'aria-label': 'Show the detail panel' }),
      M.sel && !M.sel.startsWith('item:') ? h('span', { class: 'vid' }, M.sel) : null,
      d?.task || d?.human ? HX.statusTag((d.task ?? d.human).status) : null);
    const head = h('div', { class: 'row' }, h('span', { class: 'grow' }), HX.btn(HX.icon('sidebar-simple'), togglePanel, 'btn-ghost collapse', { title: 'Collapse the panel', 'aria-label': 'Collapse the panel' }));
    let body;
    if (!M.sel) body = h('div', { class: 'stack' }, h('h6', { class: 'cap' }, 'Nothing selected'), h('p', { class: 'muted' }, 'Pick a task, a human task, a story, a feature, an epic or a lane to see its state, why it stopped, its builder history and its commits on main, and to draw lines from what it waits on and to what waits on it.'), legendNote());
    else if (!d) body = h('div', { class: 'muted' }, 'Loading…');
    else if (d.error) body = h('div', { class: 't-crit' }, d.error);
    else if (d.item) body = itemDetail(d.item);
    else if (d.human) body = HX.humanPanel(d);
    else body = taskPanel(d);
    const keep = B.panel.querySelector('.in')?.scrollTop ?? 0;
    const inn = h('div', { class: 'in' }, head, body);
    fill(B.panel, strip, inn);
    if (keep && d?.task?.id === M.lastPanel) inn.scrollTop = keep;
    M.lastPanel = d?.task?.id;
  }

  const legendNote = () => h('p', { class: 'small muted' }, `Merged work is solid green with a check; running tasks pulse; a red notch is a failed attempt; human tasks are hatched, red when late. ${M.board?.codeFinish != null ? 'The dashed purple line is code complete, with human tasks done when needed; the dashed red one is project complete, with their lead times.' : 'The dashed red line is the projected finish.'}${M.board?.milestones.length ? ' Each dotted line is a milestone, where it was reached or is projected; pick one to see its work alone.' : ''}`);

  // A lane, epic, feature or story: where it sits, what it is for, how far it has got, and its tasks by state.
  function itemDetail(i) {
    const picked = milestoneNow();
    const ts = i.tasks.map((id) => M.byId.get(id)).filter((t) => t && (!picked || t.milestone === picked));
    const e = HX.mapRollup(ts);
    const by = (s) => ts.filter((t) => t.status === s);
    const trail = trailOf(i).slice(0, -1);
    const inMs = [...new Set(ts.map((t) => t.milestone).filter(Boolean))].map((k) => M.board.milestones.find((m) => m.key === k)).filter(Boolean);
    const open = M.rows.some((r) => r.id === i.id && r.folded === false);
    return h('div', { class: 'stack lg' },
      h('div', { class: 'row wrap' }, HX.tag(LEVEL[i.level], 'tag-accent'), HX.tag(HX.laneShort(i.repo), 'tag-neutral'), picked ? HX.tag(`in ${M.board.milestones.find((m) => m.key === picked)?.title ?? picked}`, 'tag-outline') : null),
      trail.length ? h('div', { class: 'crumbs small' }, trail.map((x, n) => [n ? h('span', { class: 'muted' }, ' › ') : null, h('button', { type: 'button', class: 'link', onclick: () => selectItem(x) }, x.title)])) : null,
      h('h3', null, i.title),
      i.about ? h('p', { class: 'soft' }, i.about) : null,
      h('div', { class: 'soft' }, `${e.done} of ${F.plural(e.total, 'task')} merged${e.running ? ` · ${e.running} building` : ''}${e.failing ? ` · ${e.failing} failing` : ''}${e.waiting ? ` · ${e.waiting} waiting on a person` : ''}`),
      h('div', { class: 'progress' }, h('i', { style: { width: `${(e.done / Math.max(1, e.total)) * 100}%` } })),
      e.end ? h('div', { class: 'muted' }, `${e.done === e.total ? 'Finished' : 'Projected to finish'} ${F.dayTime(e.end)}`) : null,
      e.waitsOn ? h('div', null, 'Most of its open work waits on ', HX.taskLink(e.waitsOn, 'mono')) : null,
      inMs.length ? h('div', { class: 'stack', style: { gap: '4px' } }, h('h6', { class: 'cap' }, inMs.length === 1 ? 'Milestone' : `In ${inMs.length} milestones`), inMs.map((m) => milestoneLine(m))) : null,
      [['claimed', 'Building'], ['needs_human', 'Needs you'], ['parked', 'Parked'], ['ready', 'Ready'], ['done', 'Merged']].map(([s, label]) => by(s).length ? h('div', { class: 'stack', style: { gap: '4px' } }, h('h6', { class: 'cap' }, `${label} · ${by(s).length}`), by(s).slice(0, 12).map((t) => h('div', { class: 'row' }, HX.taskLink(t.id, 'mono small muted'), h('span', { class: 'ell' }, t.title), t.critical ? HX.tag('critical', 'tag-crit') : null)), by(s).length > 12 ? h('div', { class: 'muted small' }, `and ${by(s).length - 12} more`) : null) : null),
      viewNow() === 'hybrid' ? HX.btn(open ? 'Fold it on the Map' : 'Open it on the Map', () => { HX.setUi(`fold:${i.id}`, open ? 'closed' : 'open'); layout(); renderPanel(); }) : null);
  }

  // A milestone in the panel: its number and title, when, and its demo.
  function milestoneLine(m) {
    const n = (M.board?.milestones ?? []).findIndex((x) => x.key === m.key) + 1;
    return h('div', { class: 'msline' },
      h('div', { class: 'row' }, n ? h('span', { class: `msnum${m.reached ? ' reached' : ''}` }, String(n)) : null, h('b', { class: 'grow', style: { fontWeight: 500 } }, m.title), m.at ? h('span', { class: 'small muted' }, `${m.reached ? 'reached' : 'projected'} ${F.day(m.at)}`) : null),
      h('div', { class: 'small soft' }, `Demo: ${m.demo}`));
  }

  // onItem: what a breadcrumb does. On the Map it shows that item in the panel; elsewhere it opens the task there.
  function taskPanel(d, onItem = selectItem) {
    const t = d.task;
    const b = d.board ?? {};
    const merged = t.status === 'done';
    const commits = d.commits?.commits ?? [];
    const lastPass = [...(d.history ?? [])].reverse().find((x) => x.log);
    const els = [];
    els.push(h('div', { class: 'row wrap' }, HX.statusTag(t.status), HX.tag(t.id, 'tag-mono'), t.priority === 'fix_first' ? HX.tag('fix first', 'tag-warn') : null, b.critical ? HX.tag('critical path', 'tag-crit') : null, t.placeholder_for?.length ? HX.tag('placeholder', 'tag-outline') : null, t.wires?.length ? HX.tag('wiring', 'tag-outline') : null));
    // Lane › Epic › Feature › Story: each opens in the panel.
    if (d.trail?.length) els.push(h('div', { class: 'crumbs small' }, d.trail.map((x, n) => [n ? h('span', { class: 'muted' }, ' › ') : null, h('button', { type: 'button', class: 'link', title: LEVEL[x.level], onclick: () => { const i = M.itemById?.get(x.id); if (i) onItem(i); } }, x.title)])));
    els.push(h('h3', null, t.title));
    if (d.milestone) els.push(milestoneLine(M.board?.milestones.find((m) => m.key === d.milestone.key) ?? d.milestone));
    // A placeholder and its wiring, both ways.
    if (t.placeholder_for?.length) els.push(h('div', { class: 'boxed small' }, 'Built before ', t.placeholder_for.map((x, n) => [n ? ', ' : '', HX.taskLink(x, 'mono')]), ', against a placeholder its notes and acceptance describe. ', d.wiredBy?.length ? ['Wired in by ', d.wiredBy.map((w, n) => [n ? ', ' : '', HX.taskLink(w.id, 'mono')]), '.'] : h('span', { class: 't-crit' }, 'No task wires it in yet.')));
    if (t.wires?.length) els.push(h('div', { class: 'boxed small' }, 'Replaces the placeholder in ', t.wires.map((x, n) => [n ? ', ' : '', HX.taskLink(x, 'mono')]), ' with the real ', [...new Set(t.wires.flatMap((x) => M.byId?.get(x)?.placeholderFor ?? []))].map((x, n) => [n ? ', ' : '', HX.taskLink(x, 'mono')]), '.'));
    if (merged) {
      const m = d.merged;
      els.push(h('div', { class: 'soft' }, `Merged ${m ? F.dayTime(Date.parse(m.at)) : ''} by ${HX.AGENT[m?.agent] ?? m?.agent ?? '–'} · ${F.plural(t.attempts.length, 'attempt')} · ${F.dur(d.cost.ms)} in all · ${F.usd(d.cost.usd)}`));
      els.push(h('div', { class: 'row wrap' },
        commits.length ? HX.btn('View diff', () => showCommit(d.commits.repo, commits.find((c) => !c.merge) ?? commits[0]), 'btn-primary') : null,
        lastPass ? HX.btn('Replay pass', () => HX.go(`#live/replay/${encodeURIComponent(lastPass.log)}`)) : null,
        d.remote && m ? h('a', { class: 'btn btn-secondary', href: `${d.remote}/commit/${m.commit}`, target: '_blank', rel: 'noopener' }, 'Open on GitHub') : null));
      if (commits.length) els.push(h('div', { class: 'stack', style: { gap: '0' } }, h('h6', { class: 'cap', style: { marginBottom: '4px' } }, `Commits on main · ${commits.length}`), commits.map((c) => h('button', { type: 'button', class: 'commit', onclick: () => showCommit(d.commits.repo, c) },
        h('span', { class: 'sha' }, c.sha.slice(0, 7)),
        h('span', { style: { minWidth: 0 } }, h('div', { class: 's ell' }, c.subject), h('div', { class: 'small muted ell' }, c.merge ? 'merge commit' : `${F.plural(c.files, 'file')} · ${[...new Set(c.paths.map((p) => p.split('/').slice(0, 2).join('/')))].slice(0, 2).join(', ')}`)),
        c.merge ? h('span') : h('span', { class: 'ad' }, h('span', { class: 't-ok' }, `+${c.added}`), ' ', h('span', { class: 't-crit' }, `−${c.deleted}`))))));
    } else {
      const why = whyStopped(d);
      if (why) els.push(h('div', { class: 'boxed', style: { boxShadow: 'inset 0 0 0 1px oklch(0.72 0.14 35 / .5)' } }, h('h6', { class: 'cap t-crit', style: { marginBottom: '4px' } }, 'Why it stopped'), why));
      els.push(h('dl', { class: 'kv' },
        h('dt', null, 'Repo'), h('dd', null, t.repo),
        b.start ? [h('dt', null, t.status === 'claimed' ? 'Started' : 'Projected'), h('dd', null, `${F.dayTime(b.start)}${b.end ? ` to ${F.time(new Date(b.end).toISOString())}` : ''}`)] : null,
        t.reqs.length ? [h('dt', null, 'Requirements'), h('dd', { class: 'mono small' }, t.reqs.join(', '))] : null,
        t.blocked_by.length ? [h('dt', null, 'Waits on'), h('dd', null, t.blocked_by.map((x, i) => [i ? ', ' : '', HX.taskLink(x, 'mono small')]))] : null,
        t.attempts.length ? [h('dt', null, 'Attempts'), h('dd', null, `${t.attempts.length} · ${F.dur(d.cost.ms)} · ${F.usd(d.cost.usd)}`)] : null));
      els.push(h('div', { class: 'stack', style: { gap: '3px' } }, h('h6', { class: 'cap' }, 'Acceptance'), t.acceptance.map((a) => h('div', { class: 'small soft' }, a))));
      if (d.live) els.push(h('a', { class: 'btn btn-primary', href: `#live/${encodeURIComponent(d.live.id)}` }, HX.icon('broadcast'), ' Watch it work'));
      els.push(taskActions(d));
    }
    els.push(notesEditor(t.id, t.notes ?? '', d.running));
    if (d.history?.length) els.push(h('div', { class: 'stack' }, h('h6', { class: 'cap' }, 'Builder history'), h('div', { class: 'timeline' }, d.history.map((x) => h('div', { class: 'tl' },
      h('i', { class: `d ${x.state ?? 'info'}` }), h('span', { class: 'when' }, F.time(x.at)),
      h('div', { style: { minWidth: 0 } }, h('div', null, x.title), x.detail ? h('div', { class: 'small muted' }, x.detail) : null),
      x.commit ? h('button', { type: 'button', class: 'link small mono', onclick: () => commits[0] && showCommit(d.commits.repo, commits.find((c) => c.sha === x.commit) ?? commits.at(-1)) }, x.commit.slice(0, 7))
        : x.kind === 'gate' && x.log ? h('button', { type: 'button', class: 'link small', onclick: () => showLog(x.log) }, 'Gate log')
          : x.log ? h('a', { class: 'small', href: x.state === 'running' ? `#live/${encodeURIComponent(d.live?.id ?? '')}` : `#live/replay/${encodeURIComponent(x.log)}` }, x.state === 'running' ? 'Watch' : 'Replay') : h('span'))))));
    if (d.unblocks?.length && !merged) els.push(h('div', { class: 'small muted' }, `${F.plural(d.unblocks.length, 'task')} wait${d.unblocks.length === 1 ? 's' : ''} on it: `, d.unblocks.slice(0, 6).map((u, i) => [i ? ', ' : '', HX.taskLink(u.id, 'mono')]), d.unblocks.length > 6 ? '…' : ''));
    els.push(HX.comments(t.id, d.threads, t.blocked_by));
    return h('div', { class: 'stack lg' }, els);
  }

  // When a task waits on a person: its latest failure or question, and what it holds up.
  function whyStopped(d) {
    const t = d.task;
    if (t.status !== 'needs_human' && t.status !== 'parked') return null;
    const last = t.attempts.at(-1);
    const issue = d.reports.filter((r) => r.kind === 'issue').at(-1);
    return h('div', { class: 'stack', style: { gap: '4px' } },
      h('div', null, t.status === 'parked' ? 'Parked.' : last ? `After ${F.plural(t.attempts.length, 'attempt')}: ${last.outcome.replace(/_/g, ' ')}.` : 'Waiting for you.'),
      last?.note ? h('div', { class: 'codebox', style: { maxHeight: '140px' } }, last.note.split('\n').slice(0, 8).join('\n')) : null,
      issue ? h('div', { class: 'small soft' }, `${issue.agent} reported (${issue.issue?.replace('_', ' ')}): ${issue.message}`) : null,
      d.board?.held ? h('div', { class: 'small t-crit' }, `It holds ${F.plural(d.board.held, 'task')}.`) : null);
  }

  function taskActions(d) {
    const t = d.task;
    const running = d.running;
    const dep = h('input', { class: 'input mono', placeholder: 'T-1180 or HT-10', style: { width: '140px' } });
    return h('div', { class: 'stack', style: { gap: '6px' } },
      h('div', { class: 'row wrap' },
        ['needs_human', 'parked'].includes(t.status) ? HX.btn('Hand back', HX.act(async () => {
          const note = await HX.prompt(`Hand back ${t.id}`, 'It goes back to ready. An optional note goes into its notes for the next builder.', 'Hand back');
          if (note === null) return;
          const r = await HX.post('/api/task/action', { id: t.id, action: 'hand_back', note });
          HX.toast(`${t.id} handed back.`, { undo: r.change?.id });
        }), 'btn-primary') : null,
        t.status !== 'parked' && t.status !== 'done' ? HX.btn('Park', HX.act(async () => { await HX.post('/api/task/action', { id: t.id, action: 'park' }); HX.toast(`${t.id} parked.`); }), 'btn-secondary', { disabled: running, title: running ? 'It is in a pass: stop the pass first, in Live' : '' }) : null,
        HX.btn('Split', HX.act(() => HX.askHelix([t.id], `Split ${t.id} into tasks that fit one pass each`)), 'btn-ghost'),
        HX.btn('Ask Helix', HX.act(() => HX.askHelix([t.id], t.title)), 'btn-ghost')),
      h('div', { class: 'row wrap' }, h('span', { class: 'small muted' }, 'Dependency'), dep,
        HX.btn('Add', HX.act(async () => { const r = await HX.post('/api/task/action', { id: t.id, action: 'add_dep', on: dep.value.trim() }); HX.toast(`${t.id} now waits on ${dep.value.trim()}.`, { undo: r.change?.id }); }), 'btn-ghost sm', { disabled: running }),
        HX.btn('Remove', HX.act(async () => { const r = await HX.post('/api/task/action', { id: t.id, action: 'remove_dep', on: dep.value.trim() }); HX.toast(`${t.id} no longer waits on ${dep.value.trim()}.`, { undo: r.change?.id }); }), 'btn-ghost sm', { disabled: running })));
  }

  // Notes: every build prompt carries them. Edited in place; a draft survives a refresh, and a change made
  // elsewhere while the owner writes is offered with "Load theirs".
  const drafts = {};
  function notesEditor(id, notes, running) {
    const ta = h('textarea', { class: 'input', rows: 4, placeholder: running ? '' : 'Notes for the next builder: what to read first, what to avoid.', readOnly: running });
    const key = `notes:${id}`;
    const draft = drafts[key] ?? HX.store.get(key);
    ta.value = draft ?? notes;
    const theirs = draft != null && draft !== notes && drafts[`${key}:base`] !== undefined && drafts[`${key}:base`] !== notes;
    drafts[`${key}:base`] ??= notes;
    ta.oninput = () => {
      drafts[key] = ta.value;
      HX.store.set(key, ta.value);
    };
    const save = HX.btn('Save notes', HX.act(async () => {
      await HX.post('/api/notes', { id, notes: ta.value });
      delete drafts[key];
      delete drafts[`${key}:base`];
      HX.store.set(key, '');
      localStorage.removeItem?.(`helix:${key}`);
      HX.toast(`${id} notes saved.`);
    }), 'btn-secondary sm', { 'data-send-button': '', disabled: running });
    return h('div', { class: 'stack', style: { gap: '4px' }, 'data-send': '' },
      h('div', { class: 'row' }, h('h6', { class: 'cap grow' }, 'Notes'), running ? h('span', { class: 'small muted' }, 'read-only while its pass runs') : h('span', { class: 'kbd' }, '⌘↩ saves')),
      ta,
      theirs ? h('div', { class: 'small t-warn' }, 'The notes changed while you were writing. ', h('button', { type: 'button', class: 'link', onclick: () => { ta.value = notes; delete drafts[key]; drafts[`${key}:base`] = notes; } }, 'Load theirs')) : null,
      running ? null : h('div', null, save));
  }
  HX.notesEditor = notesEditor;
  // The Map's detail for a task or a human task, for other screens' side panels.
  HX.taskDetail = (d) => (d.human ? HX.humanPanel(d) : taskPanel(d, () => HX.go(`#map/${d.task.id}`)));

  async function showCommit(repo, c) {
    if (!c) return;
    const box = h('div', { class: 'diffbox', style: { maxHeight: '60vh' } }, h('div', { class: 'muted', style: { padding: '12px' } }, 'Loading…'));
    HX.api('/api/commit', { repo, sha: c.sha }).then((text) => fill(box, HX.diffLines(text))).catch((e) => fill(box, h('div', { class: 't-crit', style: { padding: '12px' } }, e.message)));
    const d = HX.$('dialog');
    d.style.maxWidth = 'min(1100px, calc(100vw - 32px))';
    HX.$('dlg-body').parentElement.style.width = 'min(1060px, calc(100vw - 32px))';
    await HX.dialog(`${c.sha.slice(0, 7)} · ${c.subject}`, box, [{ label: 'Close', value: 'close' }]);
    d.style.maxWidth = '';
    HX.$('dlg-body').parentElement.style.width = '';
  }
  async function showLog(log) {
    const box = h('div', { class: 'codebox', style: { maxHeight: '60vh' } }, 'Loading…');
    HX.api('/api/log', { path: log }).then((t) => (box.textContent = t.split('\n').filter((l) => !l.startsWith('{')).slice(-400).join('\n'))).catch((e) => (box.textContent = e.message));
    await HX.dialog(log, box, [{ label: 'Close', value: 'close' }]);
  }
  HX.showLog = showLog;

  // A human task in the panel: what it holds up, how late it is, its steps and handoff prompt.
  HX.humanPanel = (d) => {
    const t = d.human;
    const b = d.board ?? {};
    const late = b.latestStart && b.latestStart < Date.now() ? Math.round((Date.now() - b.latestStart) / 86_400_000) : 0;
    return h('div', { class: 'stack lg' },
      h('div', { class: 'row wrap' }, HX.statusTag(t.status), HX.tag(t.id, 'tag-mono'), late ? HX.tag(`${late} d late`, 'tag-crit') : b.latestStart ? HX.tag(`start by ${F.day(b.latestStart)}`, 'tag-warn') : null, b.held ? HX.tag(`holds ${F.plural(b.held, 'task')}`, 'tag-neutral') : null),
      h('h3', null, t.title),
      h('div', { class: 'boxed' }, h('h6', { class: 'cap', style: { marginBottom: '4px' } }, 'Done when'), t.done_check),
      h('dl', { class: 'kv' }, h('dt', null, 'Lead time'), h('dd', null, `${t.lead_time_days} d`), b.expectedDone ? [h('dt', null, 'Expected done'), h('dd', null, F.day(b.expectedDone))] : null, h('dt', null, 'An agent can help'), h('dd', null, t.agent_can_help), t.steps?.length ? [h('dt', null, 'Steps'), h('dd', null, `${t.done.length} of ${t.steps.length} done`)] : null),
      h('div', { class: 'row wrap' },
        t.status !== 'done' && location.hash !== '#home/your_tasks' ? HX.btn('Open checklist', () => HX.go('#home/your_tasks'), 'btn-primary') : null,
        t.status === 'todo' ? HX.btn('Mark in progress', HX.act(async () => { await HX.post('/api/human/action', { id: t.id, status: 'in_progress' }); HX.toast(`${t.id} is in progress.`); })) : null,
        t.handoff_prompt ? HX.btn([HX.icon('copy'), ' Copy handoff prompt'], HX.act(async () => { await navigator.clipboard.writeText(t.handoff_prompt); HX.toast('Copied.'); }), 'btn-ghost') : null),
      (t.secrets ?? []).length ? h('div', { class: 'stack', style: { gap: '3px' } }, h('h6', { class: 'cap' }, 'Secrets it provides'), t.secrets.map((x) => h('div', { class: 'small' }, h('span', { class: 'mono' }, x.name), h('span', { class: 'muted' }, ` · ${x.stored_in}`)))) : null,
      notesEditor(t.id, t.notes ?? '', false),
      HX.comments(t.id, d.threads, t.blocked_by));
  };
})();
