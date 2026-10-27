// The Map (spec §6.4): lanes, epics and tasks against time, drawn by the page from the server's board. Hybrid
// folds finished epics and those with nothing on the frontier; the Frontier scope opens only what is running,
// next, failing or waiting on a person, so thousands of tasks read as a few dozen rows. Folds, Wrap and the task
// column's width are kept in runs/app.yaml, as is the time scale: Hours, Days and Weeks are presets, and a pinch on a
// trackpad zooms the scale between them and beyond, around the time under the pointer. Rows are drawn only where
// the view can see them.
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
  const M = { el: null, board: null, sel: null, detail: null, q: '', rows: [], scrollTop: 0 };

  HX.views.map = {
    mount(el, parts) {
      M.el = el;
      M.sel = parts[0] ?? HX.store.get('mapSel') ?? null;
      M.reveal = M.sel;
      build();
      load();
    },
    route(parts) {
      if (parts[0] && parts[0] !== M.sel) {
        M.reveal = parts[0];
        select(parts[0], true);
        reveal(parts[0]);
      }
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
  // Pixels per millisecond: the pinched scale if there is one, else the preset picked last.
  const pxNow = () => {
    const v = Number(opt('px', 0));
    return v >= PX_MIN && v <= PX_MAX ? v : PX[opt('scale', 'days')] ?? PX.days;
  };
  const presetOf = (px) => Object.keys(PX).find((k) => Math.abs(PX[k] / px - 1) < 0.01) ?? null;
  let B;
  function build() {
    B = {
      tools: h('div', { class: 'bar1' }),
      legend: h('div', { class: 'legend' },
        h('span', null, h('i', { style: { background: 'var(--ok)' } }), '✓ done'),
        h('span', null, h('i', { style: { background: 'repeating-linear-gradient(135deg,var(--color-accent) 0 3px,var(--color-accent-600) 3px 6px)' } }), '◐ building'),
        h('span', null, h('i', { style: { boxShadow: 'inset 0 0 0 1px var(--color-neutral-500)' } }), '○ ready'),
        h('span', null, h('i', { style: { border: '1.5px dashed var(--crit)' } }), '! needs you'),
        h('span', null, h('i', { style: { background: 'repeating-linear-gradient(135deg,var(--warn) 0 3px,transparent 3px 6px)' } }), 'human task'),
        h('span', null, '▸ folded epic: green share is merged'),
        h('span', null, h('i', { style: { width: '1px', height: '12px', background: 'var(--color-text)' } }), 'now')),
      gantt: h('div', { class: 'gantt' }),
      panel: h('aside', { class: `panel${opt('panel', true) === false ? ' closed' : ''}`, 'aria-label': 'Detail' }),
    };
    B.gantt.addEventListener('scroll', () => {
      M.scrollTop = B.gantt.scrollTop;
      drawRows();
    });
    pinch();
    fill(M.el, h('section', { class: 'map' }, B.tools, B.legend, B.gantt), B.panel);
    renderTools();
    renderPanel();
  }

  function renderTools() {
    const search = h('input', { class: 'input search', placeholder: 'Find a task, epic or commit', value: M.q, 'aria-label': 'Find' });
    search.oninput = () => {
      M.q = search.value.trim();
      layout();
    };
    search.onkeydown = (e) => {
      if (e.key === 'Enter') {
        const hit = M.rows.find((r) => r.kind === 'task' || r.kind === 'human');
        if (hit) select(hit.id);
      }
    };
    fill(B.tools,
      h('span', { class: 'muted' }, 'View'),
      HX.seg([['tasks', 'Tasks'], ['epics', 'Epics'], ['hybrid', 'Hybrid']], opt('view', 'hybrid'), (v) => { HX.setUi('map.view', v); renderTools(); layout(); }),
      HX.seg([['frontier', 'Frontier'], ['all', 'All'], ['critical', 'Critical path']], opt('scope', 'frontier'), (v) => { HX.setUi('map.scope', v); renderTools(); layout(); }),
      search,
      h('span', { class: 'grow' }),
      HX.seg([['hours', 'Hours'], ['days', 'Days'], ['weeks', 'Weeks']], presetOf(pxNow()), (v) => { HX.setUi('map.scale', v); HX.setUi('map.px', PX[v]); renderTools(); layout(true); }, 'scaleseg'),
      HX.btn('Export', HX.act(async () => { await HX.post('/api/export', { what: 'map' }); HX.toast('Exporting the static map (helix-loop map)…'); }), 'btn-ghost'));
  }

  async function load() {
    M.board = await HX.api('/api/board');
    B.legend.querySelector('.derived')?.remove();
    // The finish lines: code complete and project complete, or the one projected finish.
    B.legend.querySelectorAll('.finkey').forEach((n) => n.remove());
    const key = (color, text, title) => h('span', { class: 'finkey', title }, h('i', { class: 'dash', style: { background: `repeating-linear-gradient(to bottom, ${color} 0 3px, transparent 3px 5px)` } }), text);
    B.legend.append(...(M.board.codeFinish != null
      ? [key('var(--color-accent)', 'code complete', TITLE.code), key('var(--crit)', 'project complete', TITLE.project)]
      : [key('var(--crit)', 'projected finish')]));
    if (M.board.derivedEpics) B.legend.append(h('span', { class: 'derived muted', style: { marginLeft: 'auto' }, title: 'plan/taskset.yaml does not exist yet: epics are one per repo, feature and stage. Settings › Spec and TaskSet writes them down.' }, 'Epics derived from feature and stage'));
    M.byId = new Map([...M.board.tasks, ...M.board.human.map((x) => ({ ...x, kind: 'human' }))].map((t) => [t.id, t]));
    M.epicById = new Map(M.board.epics.map((e) => [e.id, e]));
    renderTools();
    layout();
    if (M.sel && !M.detail) loadDetail();
    else if (!M.sel) renderPanel(); // its legend note names the finish lines the board has
  }

  // ---- which rows show ----
  function folded(e, view, scope) {
    const manual = HX.ui(`fold:${e.id}`);
    if (manual === 'open') return false;
    if (manual === 'closed') return true;
    if (view === 'epics') return true;
    if (view === 'tasks') return false;
    if (scope === 'all') return e.done === e.tasks.length;
    return e.done === e.tasks.length || !e.frontier;
  }

  function layout(keepScroll) {
    if (!M.board) return;
    const view = opt('view', 'hybrid');
    const scope = opt('scope', 'frontier');
    const q = M.q.toLowerCase();
    const crit = new Set(M.board.criticalPath);
    // A task by its id, its title, or the commit it merged as.
    const match = (t) => !q || t.id.toLowerCase().includes(q) || t.title.toLowerCase().includes(q) || (q.length >= 6 && /^[0-9a-f]+$/.test(q) && t.commit?.startsWith(q));
    const show = (t) => (q ? match(t) : scope === 'critical' ? crit.has(t.id) : scope === 'frontier' ? t.frontier : true);
    const rows = [];
    // People first: the human tasks the build waits on.
    const humans = M.board.human.filter((x) => x.status !== 'done' && (q ? match(x) : scope === 'all' ? true : scope === 'critical' ? x.critical : x.frontier)).sort((a, b) => b.held - a.held);
    if (humans.length) {
      rows.push({ kind: 'lane', id: 'lane:human', text: `Human tasks · ${HX.owner()}`, meta: `${humans.length} of ${M.board.human.filter((x) => x.status !== 'done').length} open`, color: 'var(--warn)' });
      for (const x of humans) rows.push({ kind: 'human', id: x.id, t: x });
    }
    for (const l of M.board.lanes) {
      const laneRows = [];
      for (const eid of l.epics) {
        const e = M.epicById.get(eid);
        const ts = e.tasks.map((id) => M.byId.get(id)).filter(Boolean);
        const hits = ts.filter(show);
        const epicMatch = q && e.title.toLowerCase().includes(q);
        if (q && !hits.length && !epicMatch) continue;
        if (scope === 'critical' && !hits.length) continue;
        const isFolded = q ? false : folded(e, view, scope);
        laneRows.push({ kind: 'epic', id: e.id, e, folded: isFolded });
        if (!isFolded) for (const t of epicMatch && !hits.length ? ts : hits) laneRows.push({ kind: 'task', id: t.id, t });
      }
      if (!laneRows.length) continue;
      rows.push({ kind: 'lane', id: `lane:${l.name}`, text: l.name, meta: `${Math.round((l.done / Math.max(1, l.total)) * 100)}%`, color: HX.laneColor(l.name) ?? 'var(--color-accent)' });
      rows.push(...laneRows);
    }
    M.rows = rows;
    // The time axis: from the first visible bar (at most four weeks back) to the projected finish.
    const now = M.board.now;
    const bars = rows.flatMap((r) => (r.t ? [r.t.start ?? r.t.expectedDone, r.t.end ?? r.t.expectedDone] : r.e ? [r.e.start, r.e.end] : [])).filter((x) => x != null);
    const t0 = Math.max(Math.min(now - 86_400_000, ...bars), now - 28 * 86_400_000);
    const t1 = Math.max(now + 2 * 86_400_000, M.board.finish, ...bars) + 86_400_000;
    const start = new Date(new Date(t0).toDateString()).getTime();
    M.axis = { start, end: t1, px: pxNow() };
    const was = B.gantt.scrollLeft;
    drawGrid();
    if (!keepScroll && !M.scrolledOnce) {
      // Open with "now" a little in from the left of the chart.
      B.gantt.scrollLeft = Math.max(0, x(now) - 160);
      M.scrolledOnce = true;
    } else if (keepScroll) B.gantt.scrollLeft = Math.max(0, x(now) - 160);
    else B.gantt.scrollLeft = was;
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
      HX.setUi('map.px', px);
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

  // Brings a row into view: the selected task, when it was opened from elsewhere.
  function reveal(id) {
    const i = M.rows.findIndex((r) => r.id === id);
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
    add({ cls: 'finchip', text: code != null ? 'Project complete' : 'Finish', at: x(finish), title: code != null ? `Project complete ${F.dayTime(finish)}: ${TITLE.project.toLowerCase()}` : `Projected finish ${F.dayTime(finish)}` });
    if (code != null) add({ cls: 'finchip code', text: 'Code complete', at: x(code), title: `Code complete ${F.dayTime(code)}: ${TITLE.code.toLowerCase()}` });
    const covered = (t) => Math.abs(x(t) - x(now)) <= 56 || chips.some((c) => !clear([x(t) + 4, x(t) + 48], span(c)));
    M.body = h('div', { style: { position: 'relative' } });
    M.lines = h('div', { class: 'g-lines', style: { left: `${cw}px`, width: `${width}px` } },
      ticks.map((t) => h('i', { style: { left: `${x(t)}px` } })),
      h('i', { class: 'now', style: { left: `${x(now)}px` } }),
      code != null ? h('i', { class: 'fin code', style: { left: `${x(code)}px` } }) : null,
      h('i', { class: 'fin', style: { left: `${x(finish)}px` } }));
    const grid = h('div', { class: 'grid', style: { width: `${cw + width}px` } },
      h('div', { class: 'g-head' },
        h('div', { class: 'lab', style: { width: `${cw}px` } }, 'Lane › epic › task', h('label', { class: 'check wrapc' }, wrapBox, 'Wrap')),
        h('div', { class: 'axis', style: { width: `${width}px` } },
          // A label the "now" chip or a finish chip would cover is left out; its gridline stays.
          ticks.filter((t) => !covered(t)).map((t) => h('span', { class: 'tick', style: { left: `${x(t)}px` } }, label(t))),
          chips.map((c) => h('span', { class: c.cls, title: c.title, style: { left: `${c.at + 1}px` } }, c.text)),
          h('span', { class: 'nowchip', style: { left: `${x(now)}px` } }, new Date(now).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })))),
      h('div', { style: { position: 'relative' } }, M.lines, M.body),
      resize);
    B.gantt.replaceChildren(grid);
    B.gantt.scrollTop = M.scrollTop;
    drawRows(true);
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
    if (!force && M.drawn && M.drawn.from === from && M.drawn.to === to && M.drawn.v === liveStamp()) return;
    M.drawn = { from, to, v: liveStamp() };
    M.body.style.height = wrap ? '' : `${n * ROW}px`;
    M.lines.style.height = wrap ? '' : `${n * ROW}px`;
    const frag = M.rows.slice(from, to).map((r, i) => {
      const el = row(r);
      if (!wrap) Object.assign(el.style, { position: 'absolute', top: `${(from + i) * ROW}px`, left: 0, right: 0 });
      return el;
    });
    M.body.replaceChildren(...frag);
    if (!n) M.body.replaceChildren(h('div', { class: 'muted', style: { padding: '20px', position: 'sticky', left: 0 } }, M.q ? `Nothing matches “${M.q}”.` : 'Nothing in this scope.'));
  }
  const liveStamp = () => (S.state?.live ?? []).map((p) => `${p.task}${p.phase}${p.progress ?? ''}`).join('|');

  function row(r) {
    const cw = colW();
    const track = h('div', { class: 'g-track', style: { width: `${x(M.axis.end)}px` } });
    if (r.kind === 'lane') {
      return h('div', { class: 'g-row lane' }, h('div', { class: 'g-lab', style: { width: `${cw}px`, color: r.color, paddingLeft: '14px' } }, h('span', { class: 'tx' }, r.text), h('span', { class: 'meta' }, r.meta)), track);
    }
    if (r.kind === 'epic') {
      const e = r.e;
      const done = e.done === e.tasks.length;
      const label = h('button', { type: 'button', class: 'g-lab', style: { width: `${cw}px`, paddingLeft: '22px' }, 'aria-expanded': String(!r.folded), onclick: () => {
        HX.setUi(`fold:${e.id}`, r.folded ? 'open' : 'closed');
        layout();
      } },
      h('span', { class: `gl ${done ? 'ok' : ''}` }, done ? '✓' : r.folded ? '▸' : '▾'), h('span', { class: 'tx' }, e.title), h('span', { class: 'meta' }, e.running ? '◐' : e.failing ? '!' : ''));
      if (e.start != null && e.end != null) {
        const p = e.done / Math.max(1, e.tasks.length);
        const meta = `${done ? '✓ ' : ''}${e.done}/${e.tasks.length}${e.waitsOn && !done ? ` · waits ${e.waitsOn}` : ''}`;
        track.append(h('div', { class: `g-bar epic ${done ? 'done' : 'prog'}`, style: { left: `${x(e.start)}px`, width: `${Math.max(14, x(e.end) - x(e.start))}px`, '--p': `${p * 100}%` }, title: `${e.title}: ${e.done} of ${e.tasks.length} merged`, onclick: () => selectEpic(e) }, meta));
      }
      return h('div', { class: `g-row epic${done ? ' done' : ''}` }, label, track);
    }
    const t = r.t;
    const human = r.kind === 'human';
    const live = !human && S.state?.live.find((p) => p.task === t.id);
    const st = human ? 'human' : t.status === 'done' ? 'done' : t.status === 'claimed' ? 'run' : t.status === 'needs_human' || t.status === 'parked' ? 'need' : t.waits?.length ? 'blocked' : 'ready';
    const glyph = { human: ['◆', t.late ? 'crit' : 'warn'], done: ['✓', 'ok'], run: ['◐', 'acc'], need: ['!', 'crit'], blocked: ['○', ''], ready: ['○', ''] }[st];
    const sel = M.sel === t.id;
    const label = h('button', { type: 'button', class: 'g-lab', style: { width: `${cw}px`, paddingLeft: human ? '22px' : '40px' }, 'data-jk': '', onclick: () => select(t.id) },
      h('span', { class: `gl ${glyph[1]}` }, glyph[0]), h('span', { class: 'id' }, t.id), h('span', { class: 'tx', title: t.title }, t.title),
      h('span', { class: 'meta' }, human ? `holds ${t.held}` : live ? `(${HX.BADGE[live.agent]})` : t.status === 'claimed' && t.agent ? `(${HX.BADGE[t.agent]})` : ''));
    const s = human ? Math.min(t.latestStart ?? M.board.now, M.board.now) : t.start;
    const e = human ? t.expectedDone : t.end;
    if (s != null && e != null) {
      const left = x(s);
      const w = Math.max(st === 'done' ? 8 : 6, x(e) - left);
      const bar = h('div', { class: `g-bar ${st}${human && t.late ? ' late' : ''}${sel ? ' sel' : ''}`, style: { left: `${left}px`, width: `${w}px` }, title: `${t.id} · ${human ? `expected done ${F.dayTime(e)}` : st === 'done' ? `merged ${F.dayTime(e)}` : `${t.projected ? 'projected ' : ''}${F.dayTime(s)} to ${F.dayTime(e)}`}`, onclick: () => select(t.id) }, st === 'done' && w > 14 ? '✓' : st === 'need' ? '!' : '');
      // A failed attempt is a red notch on the bar.
      for (const f of t.fails ?? []) if (f >= s && f <= e + 60_000) bar.append(h('i', { class: 'notch', style: { left: `${x(f) - left}px` } }));
      track.append(bar);
      if (live) track.append(h('span', { class: 'g-live', style: { left: `${left + w + 8}px` } }, `${HX.PHASE[live.phase] ?? live.phase}${live.progress || live.lastMessage ? ` · ${(live.progress ?? live.lastMessage).slice(0, 80)}` : ''}`));
    }
    return h('div', { class: `g-row${sel ? ' sel' : ''}${st === 'done' ? ' done' : ''}` }, label, track);
  }

  // ---- the detail panel ----
  function select(id, fromRoute) {
    M.sel = id;
    M.detail = null;
    HX.store.set('mapSel', id ?? '');
    if (!fromRoute) history.replaceState(null, '', id ? `#map/${id}` : '#map');
    drawRows(true);
    if (id && B.panel.classList.contains('closed')) togglePanel();
    renderPanel();
    if (id) loadDetail();
  }
  function selectEpic(e) {
    M.sel = `epic:${e.id}`;
    M.detail = { epic: e };
    renderPanel();
  }
  HX.openTask = (id) => HX.go(`#map/${id}`);

  async function loadDetail() {
    const id = M.sel;
    if (!id || id.startsWith('epic:')) return;
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
      M.sel && !M.sel.startsWith('epic:') ? h('span', { class: 'vid' }, M.sel) : null,
      d?.task || d?.human ? HX.statusTag((d.task ?? d.human).status) : null);
    const head = h('div', { class: 'row' }, h('span', { class: 'grow' }), HX.btn(HX.icon('sidebar-simple'), togglePanel, 'btn-ghost collapse', { title: 'Collapse the panel', 'aria-label': 'Collapse the panel' }));
    let body;
    if (!M.sel) body = h('div', { class: 'stack' }, h('h6', { class: 'cap' }, 'Nothing selected'), h('p', { class: 'muted' }, 'Pick a task, a human task or an epic to see its state, why it stopped, its builder history and its commits on main.'), legendNote());
    else if (!d) body = h('div', { class: 'muted' }, 'Loading…');
    else if (d.error) body = h('div', { class: 't-crit' }, d.error);
    else if (d.epic && !d.task && !d.human) body = epicDetail(d.epic);
    else if (d.human) body = HX.humanPanel(d);
    else body = taskPanel(d);
    const keep = B.panel.querySelector('.in')?.scrollTop ?? 0;
    const inn = h('div', { class: 'in' }, head, body);
    fill(B.panel, strip, inn);
    if (keep && d?.task?.id === M.lastPanel) inn.scrollTop = keep;
    M.lastPanel = d?.task?.id;
  }

  const legendNote = () => h('p', { class: 'small muted' }, `Merged work is solid green with a check; running tasks pulse; a red notch is a failed attempt; human tasks are hatched, red when late. ${M.board?.codeFinish != null ? 'The dashed purple line is code complete, with human tasks done when needed; the dashed red one is project complete, with their lead times.' : 'The dashed red line is the projected finish.'}`);

  function epicDetail(e) {
    const ts = e.tasks.map((id) => M.byId.get(id)).filter(Boolean);
    const by = (s) => ts.filter((t) => t.status === s);
    return h('div', { class: 'stack lg' },
      h('div', { class: 'row wrap' }, HX.tag('Epic', 'tag-accent'), HX.tag(HX.laneShort(e.lane), 'tag-neutral'), e.stage ? HX.tag(e.stage, 'tag-mono') : null),
      h('h3', null, e.title),
      h('div', { class: 'soft' }, `${e.done} of ${e.tasks.length} merged${e.running ? ` · ${e.running} building` : ''}${e.failing ? ` · ${e.failing} failing` : ''}${e.waiting ? ` · ${e.waiting} waiting on a person` : ''}`),
      h('div', { class: 'progress' }, h('i', { style: { width: `${(e.done / Math.max(1, e.tasks.length)) * 100}%` } })),
      e.end ? h('div', { class: 'muted' }, `${e.done === e.tasks.length ? 'Finished' : 'Projected to finish'} ${F.dayTime(e.end)}`) : null,
      e.waitsOn ? h('div', null, 'Most of its open work waits on ', HX.taskLink(e.waitsOn, 'mono')) : null,
      [['claimed', 'Building'], ['needs_human', 'Needs you'], ['parked', 'Parked'], ['ready', 'Ready'], ['done', 'Merged']].map(([s, label]) => by(s).length ? h('div', { class: 'stack', style: { gap: '4px' } }, h('h6', { class: 'cap' }, `${label} · ${by(s).length}`), by(s).slice(0, 12).map((t) => h('div', { class: 'row' }, HX.taskLink(t.id, 'mono small muted'), h('span', { class: 'ell' }, t.title), t.critical ? HX.tag('critical', 'tag-crit') : null)), by(s).length > 12 ? h('div', { class: 'muted small' }, `and ${by(s).length - 12} more`) : null) : null),
      HX.btn(M.rows.some((r) => r.kind === 'epic' && r.id === e.id && !r.folded) ? 'Fold it on the Map' : 'Open it on the Map', () => { HX.setUi(`fold:${e.id}`, M.rows.some((r) => r.kind === 'epic' && r.id === e.id && !r.folded) ? 'closed' : 'open'); layout(); renderPanel(); }));
  }

  // onEpic: what the epic tag does. On the Map it shows the epic in the panel; elsewhere it opens the task there.
  function taskPanel(d, onEpic = selectEpic) {
    const t = d.task;
    const b = d.board ?? {};
    const merged = t.status === 'done';
    const commits = d.commits?.commits ?? [];
    const lastPass = [...(d.history ?? [])].reverse().find((x) => x.log);
    const els = [];
    els.push(h('div', { class: 'row wrap' }, HX.statusTag(t.status), HX.tag(t.id, 'tag-mono'), d.epic ? h('button', { type: 'button', class: 'tag tag-neutral', style: { border: 0, cursor: 'pointer' }, onclick: () => onEpic(d.epic) }, d.epic.title) : null, t.priority === 'fix_first' ? HX.tag('fix first', 'tag-warn') : null, b.critical ? HX.tag('critical path', 'tag-crit') : null));
    els.push(h('h3', null, t.title));
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
        h('dt', null, 'Lane'), h('dd', null, t.repo),
        h('dt', null, 'Stage'), h('dd', null, t.stage),
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
