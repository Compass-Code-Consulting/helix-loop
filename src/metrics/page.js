// The metrics page's tiles, charts and tables, drawn from the model render.ts embeds in #data (model.ts).
// Every string from the model goes in through textContent or setAttribute, never as markup. Charts follow
// the dataviz method: thin marks, a 2px surface gap between stacked segments, hairline grid, a legend for
// two or more series, a crosshair or per-bar tooltip that keyboard focus reaches too, and a table view.
(() => {
  // The page draws once from its embedded model; inside the loop app it is redrawn in place with each new model
  // (window.mushyMetrics.update), keeping its scroll position and theme.
  let M = JSON.parse(document.getElementById('data').textContent);
  const LIVE = (() => {
    try {
      return window.parent !== window && !!window.parent.mushyApp;
    } catch {
      return false;
    }
  })();
  const HOUR = 3_600_000;
  const NS = 'http://www.w3.org/2000/svg';
  const tz = M.timeZone;
  let now = M.generatedAt;

  // ---- formatting ----
  const dtf = (o) => new Intl.DateTimeFormat('en-US', { timeZone: tz, ...o });
  const F = {
    stamp: dtf({ weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }),
    when: dtf({ weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }),
    dayTime: dtf({ weekday: 'short', hour: 'numeric', minute: '2-digit' }),
    dayHour: dtf({ weekday: 'short', hour: 'numeric' }),
    weekday: dtf({ weekday: 'short' }),
    day: dtf({ day: 'numeric' }),
    hour: dtf({ hour: 'numeric' }),
    hour23: dtf({ hour: 'numeric', hourCycle: 'h23' }),
  };
  const localHour = (t) => Number(F.hour23.format(t)) % 24;
  const dayTick = (t) => `${F.weekday.format(t)} ${F.day.format(t)}`;
  const n0 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
  const n1 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1, minimumFractionDigits: 1 });
  const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });
  const usd = (x) => (x == null ? '—' : x >= 100 ? `$${n0.format(x)}` : `$${x.toFixed(2)}`);
  const pct = (x) => (x == null ? '—' : `${Math.round(x * 100)}%`);
  const hrs = (h) => (h == null ? '—' : `${h >= 10 ? n0.format(h) : n1.format(h)} h`);
  const dur = (ms) => {
    if (ms == null) return '—';
    if (ms < 60_000) return `${Math.round(ms / 1000)} s`;
    const m = Math.round(ms / 60_000);
    return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} m`;
  };
  const windowLabel = (w) => `${F.dayHour.format(w.start)} – ${F.hour.format(w.end)}${w.partial ? ' (so far)' : ''}`;

  // ---- DOM ----
  function h(tag, attrs, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs ?? {})) {
      if (v == null) continue;
      if (k === 'class') e.className = v;
      else if (k === 'text') e.textContent = v;
      else e.setAttribute(k, v);
    }
    for (const k of kids) if (k != null) e.append(k);
    return e;
  }
  function s(tag, attrs, parent) {
    const e = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs ?? {})) if (v != null) e.setAttribute(k, String(v));
    parent?.append(e);
    return e;
  }
  function text(parent, x, y, content, attrs) {
    const t = s('text', { x, y, ...attrs }, parent);
    t.textContent = content;
    return t;
  }
  const lineKey = (color, dash) => h('i', { class: `ln${dash ? ' dash' : ''}`, style: `border-color:${color}` });
  const swatch = (color) => h('i', { class: 'sw', style: `background:${color}` });
  function legend(fig, items) {
    const box = fig.querySelector('.legend');
    box.replaceChildren(...items.map((it) => h('span', { class: 'key' }, it.kind === 'line' ? lineKey(it.color, it.dash) : it.kind === 'wash' ? h('i', { class: 'wash' }) : swatch(it.color), it.label)));
  }
  function table(headers, rows) {
    return h(
      'div',
      { class: 'tablewrap' },
      h(
        'table',
        null,
        h('thead', null, h('tr', null, ...headers.map((c) => h('th', { class: c.num ? 'n' : null, scope: 'col', text: c.label })))),
        h('tbody', null, ...rows.map((r) => h('tr', null, ...r.map((cell, i) => h('td', { class: headers[i].num ? 'n' : headers[i].wrap ? 'wrap' : 'nw' }, cell))))),
      ),
    );
  }
  function tableView(fig, headers, rows) {
    const d = fig.querySelector('details.tv');
    d.querySelector('.tablewrap')?.remove();
    d.append(table(headers, rows));
  }
  function empty(fig, message) {
    fig.querySelector('.plot').replaceChildren(h('p', { class: 'empty', text: message }));
    fig.querySelector('.legend')?.replaceChildren();
    fig.querySelector('details.tv')?.setAttribute('hidden', '');
  }
  function tooltip(fig) {
    let tip = fig.querySelector('.tip');
    if (!tip) {
      tip = h('div', { class: 'tip', role: 'status', 'aria-live': 'polite' });
      fig.append(tip);
    }
    return {
      show(x, y, title, rows) {
        tip.replaceChildren(h('div', { class: 't', text: title }), ...rows.map((r) => h('div', { class: 'row' }, h('span', null, r.mark ?? null, r.label), h('b', { text: r.value }))));
        tip.classList.add('on');
        const fw = fig.clientWidth;
        let left = x + 14;
        if (left + tip.offsetWidth > fw - 4) left = x - tip.offsetWidth - 14;
        let top = y - tip.offsetHeight - 12;
        if (top < 4) top = y + 18;
        tip.style.left = `${Math.max(4, left)}px`;
        tip.style.top = `${top}px`;
      },
      hide() {
        tip.classList.remove('on');
      },
    };
  }

  // ---- scales and ticks ----
  const linear = (d0, d1, r0, r1) => (v) => r0 + ((v - d0) * (r1 - r0)) / (d1 - d0 || 1);
  function yTicks(max, count) {
    if (!(max > 0)) return [0, 1];
    const raw = max / count;
    const p = 10 ** Math.floor(Math.log10(raw));
    const m = raw / p;
    const step = (m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : 10) * p;
    const out = [];
    for (let i = 0; i * step <= max + step * 0.999; i++) out.push(Number((i * step).toPrecision(12)));
    return out;
  }
  // Ticks at local midnight, 6 am, noon and 6 pm, found hour by hour so a change of clocks can't shift them;
  // midnights are major and carry the day.
  function timeTicks(t0, t1, px) {
    const perDay = px / ((t1 - t0) / (24 * HOUR));
    const out = [];
    let lastX = -Infinity;
    for (let t = Math.ceil(t0 / HOUR) * HOUR; t <= t1; t += HOUR) {
      if (localHour(t) % 6 !== 0) continue;
      const major = localHour(t) === 0;
      const x = ((t - t0) / (t1 - t0)) * px;
      const wanted = major || perDay >= 260;
      const room = x - lastX >= (major ? 48 : 40);
      const label = wanted && room ? (major ? dayTick(t) : F.hour.format(t)) : '';
      if (label) lastX = x;
      out.push({ t, major, label });
    }
    return out;
  }
  function frame(plot, height, margin) {
    plot.replaceChildren();
    const W = Math.max(280, Math.round(plot.clientWidth));
    const svg = s('svg', { viewBox: `0 0 ${W} ${height}`, width: W, height, role: 'img', tabindex: 0 }, plot);
    return { svg, W, H: height, m: margin };
  }
  function gridY(svg, f, ticks, Y, format) {
    const g = s('g', { class: 'grid' }, svg);
    for (const v of ticks) {
      s('line', { x1: f.m.l, x2: f.W - f.m.r, y1: Math.round(Y(v)) + 0.5, y2: Math.round(Y(v)) + 0.5 }, g);
      text(svg, f.m.l - 6, Y(v) + 3.5, format(v), { 'text-anchor': 'end' });
    }
    return g;
  }
  // The value of a series at t: a step series holds its last point; a line interpolates between its points
  // and has no value past its ends; an exact series has values only at its points.
  function valueAt(points, t, step, exact) {
    if (!points.length || t < points[0][0]) return undefined;
    let i = points.length - 1;
    while (i > 0 && points[i][0] > t) i--;
    if (step) return points[i][1];
    if (points[i][0] === t) return points[i][1];
    if (exact || i === points.length - 1) return undefined;
    const [ta, va] = points[i];
    const [tb, vb] = points[i + 1];
    return va + ((vb - va) * (t - ta)) / (tb - ta || 1);
  }
  function pathOf(points, X, Y, step) {
    if (!points.length) return '';
    let d = `M${X(points[0][0]).toFixed(1)},${Y(points[0][1]).toFixed(1)}`;
    for (let i = 1; i < points.length; i++) {
      const x = X(points[i][0]).toFixed(1);
      const y = Y(points[i][1]).toFixed(1);
      d += step ? `H${x}V${y}` : `L${x},${y}`;
    }
    return d;
  }
  // A crosshair (line charts) or a band highlight (column charts) that follows the pointer and the arrow keys.
  function interact(fig, f, count, place) {
    const tip = tooltip(fig);
    let at = -1;
    const show = (i, ev) => {
      at = Math.max(0, Math.min(count - 1, i));
      const p = place(at);
      const fr = fig.getBoundingClientRect();
      const sr = f.svg.getBoundingClientRect();
      const k = sr.width / f.W;
      const x = ev ? ev.clientX - fr.left : sr.left - fr.left + p.x * k;
      const y = ev ? ev.clientY - fr.top : sr.top - fr.top + p.y * k;
      tip.show(x, y, p.title, p.rows);
    };
    const hide = () => {
      place(-1);
      tip.hide();
    };
    f.svg.addEventListener('pointermove', (ev) => {
      const r = f.svg.getBoundingClientRect();
      const x = (ev.clientX - r.left) * (f.W / r.width);
      if (x < f.m.l - 4 || x > f.W - f.m.r + 4) return hide();
      show(f.indexAt(x), ev);
    });
    f.svg.addEventListener('pointerleave', hide);
    f.svg.addEventListener('blur', hide);
    f.svg.addEventListener('focus', () => show(at < 0 ? count - 1 : at));
    f.svg.addEventListener('keydown', (ev) => {
      if (ev.key === 'ArrowRight' || ev.key === 'ArrowLeft') {
        ev.preventDefault();
        show((at < 0 ? count - 1 : at) + (ev.key === 'ArrowRight' ? 1 : -1));
      } else if (ev.key === 'Escape') hide();
    });
  }

  // ---- charts ----
  // Lines over time. series: { label, color, points: [[t, v]], step?, dash?, dot? }; the crosshair snaps to `snaps`.
  function lineChart(fig, cfg) {
    const plot = fig.querySelector('.plot');
    const f = frame(plot, cfg.height ?? 260, { l: 46, r: cfg.right ?? 18, t: 14, b: 26 });
    f.svg.setAttribute('aria-label', cfg.aria);
    const [x0, x1] = cfg.x;
    const ticks = yTicks(cfg.ymax, f.H < 230 ? 3 : 4);
    const X = linear(x0, x1, f.m.l, f.W - f.m.r);
    const Y = linear(0, ticks.at(-1), f.H - f.m.b, f.m.t);
    const g = gridY(f.svg, f, ticks, Y, cfg.yFormat);
    for (const tk of timeTicks(x0, x1, f.W - f.m.l - f.m.r)) {
      const x = Math.round(X(tk.t)) + 0.5;
      if (tk.major) s('line', { x1: x, x2: x, y1: f.m.t, y2: f.H - f.m.b }, g);
      if (tk.label) text(f.svg, x, f.H - f.m.b + 16, tk.label, { 'text-anchor': 'middle' });
    }
    s('line', { class: 'axis', x1: f.m.l, x2: f.W - f.m.r, y1: f.H - f.m.b + 0.5, y2: f.H - f.m.b + 0.5 }, f.svg);
    for (const b of cfg.bands ?? []) {
      if (b.upper.length < 2) continue;
      const up = b.upper.map(([t, v]) => `${X(t).toFixed(1)},${Y(v).toFixed(1)}`);
      const lo = [...b.lower].reverse().map(([t, v]) => `${X(t).toFixed(1)},${Y(v).toFixed(1)}`);
      s('path', { d: `M${up.join('L')}L${lo.join('L')}Z`, style: 'fill:var(--wash)' }, f.svg);
    }
    for (const v of cfg.vlines ?? []) {
      const x = Math.round(X(v.t)) + 0.5;
      s('line', { class: 'now', x1: x, x2: x, y1: f.m.t, y2: f.H - f.m.b }, f.svg);
      if (v.label) text(f.svg, x - 4, f.m.t - 3, v.label, { 'text-anchor': 'end', class: 'ink2' });
    }
    for (const se of cfg.series) {
      s('path', { d: pathOf(se.points, X, Y, se.step), style: `fill:none;stroke:${se.color};stroke-width:2;stroke-linejoin:round;stroke-linecap:round${se.dash ? ';stroke-dasharray:6 5' : ''}` }, f.svg);
    }
    for (const mk of cfg.markers ?? []) {
      s('circle', { cx: X(mk.t), cy: Y(mk.v), r: 4.5, style: `fill:${mk.color};stroke:var(--surface);stroke-width:2` }, f.svg);
      if (mk.label) text(f.svg, X(mk.t) + (mk.anchor === 'end' ? -9 : 9), Y(mk.v) + (mk.dy ?? 4), mk.label, { 'text-anchor': mk.anchor ?? 'start', class: 'ink' });
    }
    const cross = s('line', { class: 'cross', y1: f.m.t, y2: f.H - f.m.b, visibility: 'hidden' }, f.svg);
    const dotted = cfg.series.filter((se) => se.dot !== false);
    const dots = dotted.map((se) => s('circle', { r: 4, visibility: 'hidden', style: `fill:${se.color};stroke:var(--surface);stroke-width:2` }, f.svg));
    const snaps = cfg.snaps;
    f.indexAt = (x) => {
      const t = x0 + ((x - f.m.l) / (f.W - f.m.l - f.m.r)) * (x1 - x0);
      let best = 0;
      for (let i = 1; i < snaps.length; i++) if (Math.abs(snaps[i] - t) < Math.abs(snaps[best] - t)) best = i;
      return best;
    };
    interact(fig, f, snaps.length, (i) => {
      if (i < 0) {
        cross.setAttribute('visibility', 'hidden');
        dots.forEach((d) => d.setAttribute('visibility', 'hidden'));
        return {};
      }
      const t = snaps[i];
      const x = Math.round(X(t)) + 0.5;
      cross.setAttribute('x1', x);
      cross.setAttribute('x2', x);
      cross.setAttribute('visibility', 'visible');
      let top = f.H;
      dotted.forEach((se, k) => {
        const v = valueAt(se.points, t, se.step, se.exact);
        if (v == null) return dots[k].setAttribute('visibility', 'hidden');
        dots[k].setAttribute('cx', X(t));
        dots[k].setAttribute('cy', Y(v));
        dots[k].setAttribute('visibility', 'visible');
        top = Math.min(top, Y(v));
      });
      return { x: X(t), y: Math.max(f.m.t + 8, top), ...cfg.tooltip(t) };
    });
  }

  // Columns per window, stacked when there are several keys. buckets: { start, end, values: { key: n } }.
  function columnChart(fig, cfg) {
    const plot = fig.querySelector('.plot');
    const f = frame(plot, cfg.height ?? 230, { l: 46, r: 8, t: 12, b: 26 });
    f.svg.setAttribute('aria-label', cfg.aria);
    const { buckets, keys } = cfg;
    const totals = buckets.map((b) => keys.reduce((sum, k) => sum + (b.values[k.key] ?? 0), 0));
    const ticks = yTicks(cfg.ymax ?? Math.max(...totals, 0), f.H < 230 ? 3 : 4);
    const Y = linear(0, ticks.at(-1), f.H - f.m.b, f.m.t);
    gridY(f.svg, f, ticks, Y, cfg.yFormat);
    const slot = (f.W - f.m.l - f.m.r) / Math.max(1, buckets.length);
    const bw = Math.max(3, Math.min(24, slot * 0.62));
    const cx = (i) => f.m.l + slot * (i + 0.5);
    let lastLabel = -Infinity;
    buckets.forEach((b, i) => {
      const major = localHour(b.start) === 0;
      const label = major ? dayTick(b.start) : slot >= 44 ? F.hour.format(b.start) : '';
      if (label && cx(i) - lastLabel >= (major ? 46 : 40)) {
        text(f.svg, cx(i), f.H - f.m.b + 16, label, { 'text-anchor': 'middle' });
        lastLabel = cx(i);
      }
    });
    s('line', { class: 'axis', x1: f.m.l, x2: f.W - f.m.r, y1: f.H - f.m.b + 0.5, y2: f.H - f.m.b + 0.5 }, f.svg);
    const groups = buckets.map((b, i) => {
      const g = s('g', null, f.svg);
      let base = f.H - f.m.b;
      const live = keys.filter((k) => (b.values[k.key] ?? 0) > 0);
      live.forEach((k, j) => {
        const top = Y(totals[i] - live.slice(j + 1).reduce((sum, kk) => sum + b.values[kk.key], 0));
        const bottom = j === 0 ? base : base - 2; // the 2px surface gap between stacked segments
        const y = Math.min(top, bottom - 1);
        const x = cx(i) - bw / 2;
        const isTop = j === live.length - 1;
        const r = isTop ? Math.min(4, (bottom - y) / 2, bw / 2) : 0;
        const d = r > 0
          ? `M${x},${bottom}V${y + r}Q${x},${y} ${x + r},${y}H${x + bw - r}Q${x + bw},${y} ${x + bw},${y + r}V${bottom}Z`
          : `M${x},${bottom}V${y}H${x + bw}V${bottom}Z`;
        s('path', { d, style: `fill:${k.color}${b.partial ? ';opacity:0.5' : ''}` }, g);
        base = top;
      });
      return g;
    });
    const band = s('rect', { y: f.m.t, height: f.H - f.m.t - f.m.b, width: slot, style: 'fill:var(--ink);opacity:0.05', visibility: 'hidden' }, f.svg);
    f.svg.insertBefore(band, f.svg.firstChild.nextSibling);
    f.indexAt = (x) => Math.max(0, Math.min(buckets.length - 1, Math.floor((x - f.m.l) / slot)));
    interact(fig, f, buckets.length, (i) => {
      groups.forEach((g, k) => g.classList.toggle('hover', k === i));
      if (i < 0) {
        band.setAttribute('visibility', 'hidden');
        return {};
      }
      band.setAttribute('x', f.m.l + slot * i);
      band.setAttribute('visibility', 'visible');
      return { x: cx(i), y: Y(totals[i]), ...cfg.tooltip(buckets[i], i) };
    });
  }

  // Horizontal bars, one row each, stacked when there are several keys. rows: { label, values: { key: n }, note }.
  // Labels sit left of the bars when the longest fits in 45% of the width, and above them otherwise.
  const measure = (() => {
    const ctx = document.createElement('canvas').getContext('2d');
    return (label) => {
      ctx.font = `11px ${getComputedStyle(document.body).fontFamily}`;
      return ctx.measureText(label).width;
    };
  })();
  function barRows(fig, cfg) {
    const plot = fig.querySelector('.plot');
    const labelW = Math.max(...cfg.rows.map((r) => measure(r.label))) + 14;
    const narrow = labelW > plot.clientWidth * 0.45;
    const rowH = narrow ? 40 : 30;
    const f = frame(plot, cfg.rows.length * rowH + 8, { l: narrow ? 0 : Math.ceil(labelW), r: cfg.right ?? 64, t: 4, b: 4 });
    f.svg.setAttribute('aria-label', cfg.aria);
    const max = cfg.max ?? Math.max(...cfg.rows.map((r) => cfg.keys.reduce((sum, k) => sum + (r.values[k.key] ?? 0), 0)), 1);
    const X = linear(0, max, f.m.l, f.W - f.m.r);
    const tip = tooltip(fig);
    cfg.rows.forEach((row, i) => {
      const y0 = f.m.t + i * rowH;
      const barY = narrow ? y0 + 18 : y0 + (rowH - 16) / 2;
      text(f.svg, narrow ? 0 : f.m.l - 12, narrow ? y0 + 12 : barY + 12, row.label, { 'text-anchor': narrow ? 'start' : 'end', class: 'ink2' });
      let x = f.m.l;
      const live = cfg.keys.filter((k) => (row.values[k.key] ?? 0) > 0);
      const g = s('g', null, f.svg);
      live.forEach((k, j) => {
        const w = Math.max(1, X(row.values[k.key]) - f.m.l - (j > 0 ? 2 : 0));
        const xs = x + (j > 0 ? 2 : 0);
        const isEnd = j === live.length - 1;
        const r = isEnd ? Math.min(4, w / 2) : 0;
        const d = r > 0
          ? `M${xs},${barY}H${xs + w - r}Q${xs + w},${barY} ${xs + w},${barY + r}V${barY + 16 - r}Q${xs + w},${barY + 16} ${xs + w - r},${barY + 16}H${xs}Z`
          : `M${xs},${barY}H${xs + w}V${barY + 16}H${xs}Z`;
        s('path', { d, style: `fill:${k.color}` }, g);
        if (cfg.inside && w >= cfg.inside(row, k).length * 6.6 + 10) {
          text(g, xs + w / 2, barY + 11.5, cfg.inside(row, k), { 'text-anchor': 'middle', style: `fill:${k.ink ?? '#ffffff'};font-weight:600` });
        }
        x = xs + w;
      });
      if (row.note) text(f.svg, x + 8, barY + 12, row.note, { class: 'ink2' });
      const hit = s('rect', { x: 0, y: y0, width: f.W, height: rowH, style: 'fill:transparent' }, f.svg);
      const show = (ev) => {
        const fr = fig.getBoundingClientRect();
        const r = hit.getBoundingClientRect();
        tip.show(ev ? ev.clientX - fr.left : r.left - fr.left + r.width / 2, ev ? ev.clientY - fr.top : r.top - fr.top, row.label, cfg.tooltip(row));
        g.classList.add('hover');
      };
      hit.addEventListener('pointermove', show);
      hit.addEventListener('pointerleave', () => {
        tip.hide();
        g.classList.remove('hover');
      });
    });
  }

  // ---- the page ----
  let CAT_COLOR, AGENT_COLOR, windows, k, P;
  const derive = () => {
    CAT_COLOR = Object.fromEntries(M.categories.map((c, i) => [c.key, `var(--s${i + 1})`]));
    AGENT_COLOR = Object.fromEntries(M.agents.map((a, i) => [a, `var(--s${i + 1})`]));
    windows = M.windows;
    k = M.kpi;
    P = M.projection;
  };
  derive();
  const agentName = (a) => a[0].toUpperCase() + a.slice(1);

  function stamp() {
    const every = M.versionEvery ? ` The loop writes a new version every ${M.versionEvery} passes and leaves each as it was.` : '';
    document.getElementById('stamp').textContent = `${LIVE ? 'Live, as of' : 'Version of'} ${F.stamp.format(now)}, after ${n0.format(M.passCount)} passes${M.startedAt ? ` · the build started ${F.when.format(M.startedAt)}` : ''}.${every}`;
  }

  // The strip of versions at the top. versions.js, rewritten with each new version, lists them all, so an older
  // page links to newer ones too; without it the page falls back to the versions it was written with.
  function versions() {
    const nav = document.getElementById('versions');
    if (!nav) return;
    const known = Array.isArray(window.MUSHY_METRICS_VERSIONS) ? window.MUSHY_METRICS_VERSIONS : (M.versions ?? []);
    const list = [...known].sort((a, b) => a.at - b.at);
    if (!M.file || !list.length) return nav.remove();
    const at = list.findIndex((v) => v.file === M.file);
    const label = (v) => `${F.dayHour.format(v.at)} · ${n0.format(v.passes)} passes`;
    const link = (v, text, attrs) => h('a', { href: encodeURI(v.file), ...attrs, text });
    const step = (v, text, rel) => (v ? link(v, text, { class: 'step', rel, title: label(v) }) : h('span', { class: 'step', 'aria-disabled': 'true', text }));
    const chips = h('div', { class: 'list' }, ...list.map((v) => link(v, label(v), v.file === M.file ? { 'aria-current': 'page' } : null)));
    nav.replaceChildren(
      h('span', { class: 'label', text: 'Versions' }),
      step(at > 0 ? list[at - 1] : undefined, '← Older', 'prev'),
      chips,
      step(at >= 0 && at < list.length - 1 ? list[at + 1] : undefined, 'Newer →', 'next'),
      h('a', { href: 'index.html', class: 'step', text: 'All versions' }),
    );
    const current = chips.querySelector('[aria-current="page"]');
    if (current) chips.scrollLeft = current.offsetLeft - chips.clientWidth / 2 + current.offsetWidth / 2;
    const latest = list.at(-1);
    if (latest && latest.file !== M.file) {
      nav.after(h('p', { class: 'notice' }, `This version is from ${F.when.format(now)}. The latest is from ${F.when.format(latest.at)}, after ${n0.format(latest.passes)} passes: `, link(latest, 'open it'), '.'));
    }
  }

  function delta(cur, prev, goodWhenUp, format) {
    if (cur == null || prev == null) return null;
    const d = cur - prev;
    if (Math.abs(d) < 1e-9) return h('span', { class: 'delta flat', text: '→ no change' });
    const up = d > 0;
    return h('span', { class: `delta ${up === goodWhenUp ? 'good' : 'bad'}`, text: `${up ? '▲' : '▼'} ${format(Math.abs(d))}` });
  }
  function tile(label, value, small, ...notes) {
    return h('div', { class: 'tile' }, h('div', { class: 'label', text: label }), h('div', { class: 'value' }, value, small ? h('small', { text: ` ${small}` }) : null), ...notes.filter(Boolean));
  }
  const note = (...kids) => h('div', { class: 'note' }, ...kids);

  function kpis() {
    const share = k.total ? k.done / k.total : 0;
    const p = M.plan;
    const doneTile = tile('Tasks done', n0.format(k.done), `of ${n0.format(k.total)}`, note(`${pct(share)} · ${n0.format(p.ready)} ready, ${n0.format(p.claimed)} in a pass${p.needsHuman ? `, ${n0.format(p.needsHuman)} need a person` : ''}`));
    doneTile.append(h('div', { class: 'meter', role: 'img', 'aria-label': `${pct(share)} done` }, h('i', { style: `width:${(share * 100).toFixed(1)}%` })));
    const date = dtf({ month: 'short', day: 'numeric' });
    const finish = P.finish != null
      ? tile(
          'Projected finish',
          F.dayHour.format(P.finish),
          null,
          note(`${date.format(P.finish)}, if the pace of ${P.basis} holds`),
          P.finishLow || P.finishHigh ? note(`range ${P.finishHigh ? F.dayHour.format(P.finishHigh) : '…'} – ${P.finishLow ? F.dayHour.format(P.finishLow) : 'later'}`) : null,
          P.growth > 0 && P.finishNoGrowth ? note(`with no new tasks: ${F.dayHour.format(P.finishNoGrowth)}`) : null,
        )
      : tile('Projected finish', 'Not in sight', null, note(`tasks are being added (${n1.format(P.growth)}/h) about as fast as they merge (${n1.format(P.rate)}/h)`));
    const rate = tile('Merged per hour', n1.format(k.rate24), 'tasks', note(delta(k.rate24, k.ratePrev24, true, (x) => n1.format(x)), k.ratePrev24 != null ? ' vs the 24 h before' : 'last 24 hours'));
    const merge = tile('Passes that merged', pct(k.mergeRate24), null, note(delta(k.mergeRate24, k.mergeRatePrev24, true, (x) => `${Math.round(x * 100)} pts`), k.mergeRatePrev24 != null ? ' vs the 24 h before' : 'last 24 hours'), note(`first try for ${pct(k.firstTryRate)} of tasks`));
    const time = tile('Agent time per task', hrs(k.agentHoursPerTask24), null, note('last 24 hours, failed passes included'));
    const cost = tile('Cost per task', usd(k.costPerTask24), null, note(delta(k.costPerTask24, k.costPerTaskPrev24, false, (x) => usd(x)), k.costPerTaskPrev24 != null ? ' vs the 24 h before' : 'last 24 hours'), note(k.tokensPerTask24 != null ? `${compact.format(k.tokensPerTask24)} tokens, not counting cached` : null));
    document.getElementById('kpis').replaceChildren(doneTile, finish, rate, merge, time, cost);
  }

  function progress() {
    const fig = document.getElementById('progress');
    if (!M.startedAt) return empty(fig, 'No passes yet.');
    const total = M.total;
    const at = (series, t) => valueAt(series, t, true) ?? series[0]?.[1] ?? 0;
    const end = Math.min(Math.max(now + 12 * HOUR, Math.max(P.finishLow ?? 0, P.finish ?? 0) + 6 * HOUR), now + 14 * 24 * HOUR);
    const x0 = M.startedAt;
    const done = [[x0, 0], ...M.done.filter(([t]) => t >= x0), [now, k.done]];
    const plan = [[x0, at(total, x0)], ...total.filter(([t]) => t > x0 && t <= now), [now, k.total]];
    const projT = (rate, t) => k.done + (rate * (t - now)) / HOUR;
    const planAt = (t) => k.total + (P.growth * (t - now)) / HOUR;
    const stop = P.finish != null ? Math.min(P.finish, end) : end;
    const series = [
      { label: 'Tasks in the plan', color: 'var(--muted)', points: plan, step: true },
      { label: 'Done', color: 'var(--s1)', points: done, step: true },
      { label: 'In the plan, projected', color: 'var(--muted)', points: [[now, k.total], [end, planAt(end)]], dash: true, dot: false },
      { label: 'Done, projected', color: 'var(--s1)', points: [[now, k.done], [stop, Math.min(projT(P.rate, stop), planAt(stop))]], dash: true, dot: false },
    ];
    const bands = [];
    if (P.low != null && P.high != null) {
      const ts = [];
      for (let t = now; t <= end; t += (end - now) / 40) ts.push(t);
      bands.push({ upper: ts.map((t) => [t, Math.min(projT(P.high, t), planAt(t))]), lower: ts.map((t) => [t, Math.min(projT(P.low, t), planAt(t))]) });
    }
    const markers = [{ t: now, v: k.done, color: 'var(--s1)' }];
    if (P.finish != null && P.finish <= end) markers.push({ t: P.finish, v: planAt(P.finish), color: 'var(--s1)', label: `≈ ${F.dayHour.format(P.finish)}`, anchor: 'end', dy: -10 });
    const snaps = [...new Set([x0, ...M.done.map(([t]) => t).filter((t) => t >= x0), now])].sort((a, b) => a - b);
    for (let t = now + 6 * HOUR; t <= end; t += 6 * HOUR) snaps.push(t);
    lineChart(fig, {
      aria: `Tasks done over time, ${k.done} of ${k.total} now, with the projection`,
      height: 300,
      x: [x0, end],
      ymax: Math.max(planAt(end), k.total) * 1.02,
      yFormat: (v) => n0.format(v),
      series,
      bands,
      markers,
      vlines: [{ t: now, label: 'now' }],
      snaps,
      right: 22,
      tooltip: (t) => {
        if (t <= now) {
          return {
            title: F.when.format(t),
            rows: [
              { mark: lineKey('var(--s1)'), label: 'Done', value: n0.format(at(done, t)) },
              { mark: lineKey('var(--muted)'), label: 'In the plan', value: n0.format(at(plan, t)) },
            ],
          };
        }
        const rows = [
          { mark: lineKey('var(--s1)', true), label: 'Done, projected', value: `≈ ${n0.format(Math.min(projT(P.rate, t), planAt(t)))}` },
          { mark: lineKey('var(--muted)', true), label: 'In the plan', value: `≈ ${n0.format(planAt(t))}` },
        ];
        if (P.low != null && P.high != null) rows.push({ mark: h('i', { class: 'wash' }), label: 'Range', value: `${n0.format(Math.min(projT(P.low, t), planAt(t)))}–${n0.format(Math.min(projT(P.high, t), planAt(t)))}` });
        return { title: `${F.when.format(t)} (projected)`, rows };
      },
    });
    legend(fig, [
      { kind: 'line', color: 'var(--s1)', label: 'Done' },
      { kind: 'line', color: 'var(--muted)', label: 'Tasks in the plan' },
      { kind: 'line', color: 'var(--s1)', dash: true, label: `Projected at ${n1.format(P.rate)} merged and ${n1.format(P.growth)} added per hour` },
      ...(bands.length ? [{ kind: 'wash', label: `Slow to fast pace of recent windows (${n1.format(P.low)}–${n1.format(P.high)}/h)` }] : []),
    ]);
    const rows = windows.filter((w) => w.end <= now).map((w) => [F.when.format(w.end), n0.format(at(done, w.end)), n0.format(at(plan, w.end))]);
    rows.push([`${F.when.format(now)} (now)`, n0.format(k.done), n0.format(k.total)]);
    if (P.finish != null) rows.push([`${F.when.format(P.finish)} (projected finish)`, n0.format(planAt(P.finish)), n0.format(planAt(P.finish))]);
    tableView(fig, [{ label: 'Time' }, { label: 'Done', num: true }, { label: 'In the plan', num: true }], rows);
  }

  // Each subscription's weekly window: the share used as passes reported it, and the even pace to the target.
  function allowance() {
    const fig = document.getElementById('allowance');
    const list = M.allowance ?? [];
    if (!list.length) return empty(fig, 'No pass has reported its subscription’s weekly window yet.');
    const WEEK = 7 * 24 * HOUR;
    const readings = list.flatMap((a) => a.windows.flatMap((w) => w.points.map(([t]) => t)));
    const x0 = Math.min(...readings) - 2 * HOUR;
    const x1 = Math.max(now, ...list.flatMap((a) => a.windows.map((w) => w.resetsAt))) + 2 * HOUR;
    const paceAt = (a, w, t) => (a.target * (t - (w.resetsAt - WEEK))) / WEEK;
    // A window ends at its reset, or earlier where a provider reset everyone's windows and a new one began.
    const spans = (a) => a.windows.map((w, i) => ({ w, from: Math.max(x0, w.resetsAt - WEEK), to: Math.min(w.resetsAt, a.windows[i + 1]?.points[0][0] ?? Infinity) }));
    const series = list.flatMap((a) =>
      spans(a).flatMap(({ w, from, to }) => {
        const used = { label: agentName(a.agent), color: AGENT_COLOR[a.agent], points: w.points };
        if (a.target == null) return [used];
        return [used, { label: `${agentName(a.agent)}, pace`, color: AGENT_COLOR[a.agent], points: [[from, paceAt(a, w, from)], [to, paceAt(a, w, to)]], dash: true, dot: false }];
      }),
    );
    const latest = list.map((a) => ({ a, p: a.windows.at(-1).points.at(-1) }));
    // The reading at or before t in the window that holds t, and the pace there.
    const at = (a, t) => {
      const span = spans(a).findLast(({ from, to }) => t >= from && t <= to);
      return span ? { w: span.w, used: valueAt(span.w.points, t, true), pace: a.target != null ? paceAt(a, span.w, t) : undefined } : undefined;
    };
    lineChart(fig, {
      aria: `Each subscription's weekly window used: ${latest.map(({ a, p }) => `${agentName(a.agent)} ${pct(p[1])}`).join(', ')}`,
      height: 260,
      x: [x0, x1],
      ymax: 1,
      yFormat: (v) => `${Math.round(v * 100)}%`,
      series,
      markers: latest.map(({ a, p }) => ({ t: p[0], v: p[1], color: AGENT_COLOR[a.agent], label: pct(p[1]), anchor: 'end', dy: -8 })),
      vlines: [{ t: now, label: 'now' }],
      snaps: [...new Set([...readings, now])].sort((x, y) => x - y),
      tooltip: (t) => ({
        title: F.when.format(t),
        rows: list.flatMap((a) => {
          const r = at(a, t);
          if (!r) return [];
          const name = agentName(a.agent);
          return [
            { mark: lineKey(AGENT_COLOR[a.agent]), label: `${name}, used`, value: pct(r.used) },
            ...(r.pace != null ? [{ mark: lineKey(AGENT_COLOR[a.agent], true), label: `${name}, pace to ${pct(a.target)}`, value: pct(r.pace) }] : []),
            { label: `${name} resets`, value: F.dayTime.format(r.w.resetsAt) },
          ];
        }),
      }),
    });
    legend(fig, list.flatMap((a) => [
      { kind: 'line', color: AGENT_COLOR[a.agent], label: `${agentName(a.agent)}: used` },
      ...(a.target != null ? [{ kind: 'line', color: AGENT_COLOR[a.agent], dash: true, label: `${agentName(a.agent)}: even pace to ${pct(a.target)} by the reset` }] : []),
    ]));
    const rows = list.flatMap((a) => a.windows.flatMap((w) => w.points.map(([t, v]) => [F.when.format(t), agentName(a.agent), pct(v), a.target != null ? pct(paceAt(a, w, t)) : '—', F.when.format(w.resetsAt)])));
    tableView(fig, [{ label: 'Read' }, { label: 'Agent' }, { label: 'Used', num: true }, { label: 'Pace allows', num: true }, { label: 'Window resets' }], rows);
  }

  function throughput() {
    const fig = document.getElementById('throughput');
    if (!windows.length) return empty(fig, 'No passes yet.');
    columnChart(fig, {
      aria: 'Tasks merged in each six-hour window',
      buckets: windows.map((w) => ({ start: w.start, end: w.end, partial: w.partial, values: { merged: w.merged } })),
      keys: [{ key: 'merged', label: 'Merged', color: 'var(--s1)' }],
      yFormat: (v) => n0.format(v),
      tooltip: (b, i) => ({ title: windowLabel(windows[i]), rows: [{ mark: swatch('var(--s1)'), label: 'Tasks merged', value: n0.format(windows[i].merged) }, { label: 'Passes', value: n0.format(windows[i].passes) }] }),
    });
    tableView(fig, [{ label: 'Window' }, { label: 'Merged', num: true }, { label: 'Passes', num: true }], windows.map((w) => [windowLabel(w), n0.format(w.merged), n0.format(w.passes)]));
  }

  function mergeRate() {
    const fig = document.getElementById('mergerate');
    const ws = windows.filter((w) => w.passes >= 3);
    if (ws.length < 2) return empty(fig, 'Not enough passes yet.');
    const points = ws.map((w) => [w.start + (w.end - w.start) / 2, w.merged / w.passes]);
    lineChart(fig, {
      aria: 'Share of passes that merged, per six-hour window',
      height: 230,
      x: [windows[0].start, windows.at(-1).end],
      ymax: 1,
      yFormat: (v) => `${Math.round(v * 100)}%`,
      series: [{ label: 'Passes that merged', color: 'var(--s1)', points }],
      markers: points.map(([t, v]) => ({ t, v, color: 'var(--s1)' })),
      snaps: points.map(([t]) => t),
      tooltip: (t) => {
        const w = ws[points.findIndex(([pt]) => pt === t)];
        return { title: windowLabel(w), rows: [{ mark: lineKey('var(--s1)'), label: 'Passes that merged', value: pct(w.merged / w.passes) }, { label: 'Merged / passes', value: `${w.merged} / ${w.passes}` }] };
      },
    });
    tableView(fig, [{ label: 'Window' }, { label: 'Merged', num: true }, { label: 'Passes', num: true }, { label: 'Share', num: true }], ws.map((w) => [windowLabel(w), n0.format(w.merged), n0.format(w.passes), pct(w.merged / w.passes)]));
  }

  function timeSpent() {
    const fig = document.getElementById('time');
    if (!windows.length) return empty(fig, 'No passes yet.');
    const keys = M.categories.map((c) => ({ key: c.key, label: c.label, color: CAT_COLOR[c.key] }));
    columnChart(fig, {
      aria: 'Agent hours in each six-hour window, by what the passes came to',
      height: 260,
      buckets: windows.map((w) => ({ start: w.start, end: w.end, partial: w.partial, values: w.hours })),
      keys,
      yFormat: (v) => `${n0.format(v)} h`,
      tooltip: (b, i) => {
        const w = windows[i];
        const sum = Object.values(w.hours).reduce((a, x) => a + x, 0);
        return {
          title: `${windowLabel(w)} · ${hrs(sum)}`,
          rows: keys.filter((kk) => w.hours[kk.key] > 0).map((kk) => ({ mark: swatch(kk.color), label: kk.label, value: `${hrs(w.hours[kk.key])} · ${pct(w.hours[kk.key] / sum)}` })),
        };
      },
    });
    legend(fig, keys.map((kk) => ({ kind: 'rect', color: kk.color, label: kk.label })));
    tableView(fig, [{ label: 'Window' }, ...keys.map((kk) => ({ label: kk.label, num: true }))], windows.map((w) => [windowLabel(w), ...keys.map((kk) => hrs(w.hours[kk.key]))]));
    const all = windows.reduce((acc, w) => {
      for (const kk of keys) acc[kk.key] = (acc[kk.key] ?? 0) + w.hours[kk.key];
      return acc;
    }, {});
    const sum = Object.values(all).reduce((a, x) => a + x, 0);
    document.getElementById('time-total').textContent = sum ? `Since the start: ${hrs(sum)} of agent time, ${pct(all.merged / sum)} of it in passes that merged.` : '';
  }

  function agents() {
    const fig = document.getElementById('agents');
    if (!M.usage.length || !M.upMs) return empty(fig, 'No passes yet.');
    const keys = [
      { key: 'workingMs', label: 'Working on a task', color: 'var(--s1)' },
      { key: 'gatingMs', label: 'Its pass in the gate', color: 'var(--s2)' },
      { key: 'limitedMs', label: 'Held by a usage limit or its weekly pace', color: 'var(--s3)' },
      { key: 'idleMs', label: 'Idle: no task it could take', color: 'var(--s4)', ink: '#0b0b0b' },
    ];
    // Shares of each agent's slot-time (two slots for an hour are two hours), so each bar runs the full width.
    const slotMs = (u) => u.slotMs ?? M.upMs;
    barRows(fig, {
      aria: 'How each agent spent the slot-time the loop ran',
      rows: M.usage.map((u) => ({ label: agentName(u.agent), values: Object.fromEntries(keys.map((kk) => [kk.key, u[kk.key] / slotMs(u)])), u, note: `${u.merged} merged` })),
      keys,
      max: 1,
      right: 86,
      inside: (row, kk) => pct(row.values[kk.key]),
      tooltip: (row) => [...keys.map((kk) => ({ mark: swatch(kk.color), label: kk.label, value: `${dur(row.u[kk.key])} · ${pct(row.values[kk.key])}` })), { label: 'Passes / merged', value: `${row.u.passes} / ${row.u.merged}` }],
    });
    legend(fig, keys.map((kk) => ({ kind: 'rect', color: kk.color, label: kk.label })));
    tableView(fig, [{ label: 'Agent' }, ...keys.map((kk) => ({ label: kk.label, num: true })), { label: 'Passes', num: true }, { label: 'Merged', num: true }, { label: 'Cost', num: true }], M.usage.map((u) => [agentName(u.agent), ...keys.map((kk) => `${dur(u[kk.key])} (${pct(u[kk.key] / slotMs(u))})`), n0.format(u.passes), n0.format(u.merged), usd(u.costUsd)]));
  }

  function perTask(id, field, format, aria) {
    const fig = document.getElementById(id);
    const series = M.agents.map((a) => ({
      label: agentName(a),
      color: AGENT_COLOR[a],
      exact: true,
      points: windows.filter((w) => w.byAgent[a]?.merged).map((w) => [w.start + (w.end - w.start) / 2, w.byAgent[a][field] / w.byAgent[a].merged]),
    })).filter((se) => se.points.length);
    if (!series.length) return empty(fig, 'No merged tasks yet.');
    const snaps = [...new Set(series.flatMap((se) => se.points.map(([t]) => t)))].sort((a, b) => a - b);
    lineChart(fig, {
      aria,
      height: 220,
      x: [windows[0].start, windows.at(-1).end],
      ymax: Math.max(...series.flatMap((se) => se.points.map(([, v]) => v))) * 1.08,
      yFormat: format,
      series,
      markers: series.flatMap((se) => se.points.map(([t, v]) => ({ t, v, color: se.color }))),
      snaps,
      tooltip: (t) => {
        const w = windows.find((x) => t >= x.start && t < x.end);
        return { title: windowLabel(w), rows: M.agents.filter((a) => w.byAgent[a]?.merged).map((a) => ({ mark: lineKey(AGENT_COLOR[a]), label: `${agentName(a)} (${w.byAgent[a].merged} merged)`, value: format(w.byAgent[a][field] / w.byAgent[a].merged) })) };
      },
    });
    legend(fig, series.map((se) => ({ kind: 'line', color: se.color, label: se.label })));
    tableView(fig, [{ label: 'Window' }, ...M.agents.map((a) => ({ label: agentName(a), num: true }))], windows.map((w) => [windowLabel(w), ...M.agents.map((a) => (w.byAgent[a]?.merged ? format(w.byAgent[a][field] / w.byAgent[a].merged) : '—'))]));
  }

  const STEP_NAMES = {
    rebase: 'Rebase onto the new main (conflict)',
    gitleaks: 'Secret scan',
    origin: 'origin/main had diverged',
    blocked: 'Answered BLOCKED',
    prepare: 'Install (prepare step)',
    gate: 'Gate, before its first step',
    timeout: 'Pass ran out of time',
    agent_error: 'Agent crashed',
    quota: 'Agent hit its usage limit',
    suspended: 'Host went to sleep',
    transient: 'API error, or the loop stopped',
    stopped: 'Stopped from the loop app',
    'harness:no-commit': 'Changed nothing',
    'harness:forbidden-paths': 'Touched a forbidden path',
    'harness:off-area': "Touched another area's files",
    'harness:conflict-markers': 'Left conflict markers',
    'harness:agents-md': 'AGENTS.md over budget',
    'harness:acceptance': 'Acceptance test titles missing',
  };
  const stepLabel = (st) => {
    if (STEP_NAMES[st]) return STEP_NAMES[st];
    const re = /^regate:(.*)$/.exec(st);
    const name = (re ? re[1] : st).replace(/^\d+-/, '');
    return re ? `${STEP_NAMES[re[1]] ?? name}, on the new main` : name;
  };

  function failedSteps() {
    const fig = document.getElementById('failsteps');
    const rows = M.failedSteps.slice(0, 12);
    if (!rows.length) return empty(fig, 'No failed passes yet.');
    const all = M.failedSteps.reduce((a, r) => a + r.failures, 0);
    barRows(fig, {
      aria: 'Failed passes by the step that stopped them',
      rows: rows.map((r) => ({ label: stepLabel(r.step), values: { n: r.failures }, note: n0.format(r.failures) })),
      keys: [{ key: 'n', label: 'Failed passes', color: 'var(--s2)' }],
      tooltip: (row) => [{ mark: swatch('var(--s2)'), label: 'Failed passes', value: `${n0.format(row.values.n)} · ${pct(row.values.n / all)}` }],
    });
    tableView(fig, [{ label: 'Step' }, { label: 'Failed passes', num: true }, { label: 'Share', num: true }], M.failedSteps.map((r) => [stepLabel(r.step), n0.format(r.failures), pct(r.failures / all)]));
  }

  function recurring() {
    const box = document.getElementById('recurring-table');
    if (!M.recurring.length) return box.replaceChildren(h('p', { class: 'empty', text: 'No test has failed passes of more than one task.' }));
    const ids = (tasks) => h('span', null, ...tasks.map((t) => h('span', { class: 'id', text: t })));
    box.replaceChildren(table([{ label: 'Failing test or check', wrap: true }, { label: 'Tasks' }, { label: 'Failures', num: true }, { label: 'Last', num: true }], M.recurring.slice(0, 15).map((r) => [r.failing, ids(r.tasks), n0.format(r.failures), F.dayTime.format(r.last)])));
  }

  function stepTimes() {
    const fig = document.getElementById('steptimes');
    if (!M.steps.length) return empty(fig, 'Recorded from the next pass on: the time each gate step takes.');
    barRows(fig, {
      aria: 'Median time of each gate step',
      rows: M.steps.map((st) => ({ label: stepLabel(st.step), values: { ms: st.medianMs }, note: `${dur(st.medianMs)}${st.runs > 1 ? ` · p90 ${dur(st.p90Ms)}` : ''}` })),
      keys: [{ key: 'ms', label: 'Median', color: 'var(--s1)' }],
      right: 120,
      tooltip: (row) => {
        const st = M.steps.find((x) => stepLabel(x.step) === row.label);
        return [{ mark: swatch('var(--s1)'), label: 'Median', value: dur(st.medianMs) }, { label: 'p90', value: dur(st.p90Ms) }, { label: 'Runs', value: n0.format(st.runs) }, { label: 'Failed here', value: n0.format(st.failures) }];
      },
    });
    tableView(fig, [{ label: 'Step' }, { label: 'Median', num: true }, { label: 'p90', num: true }, { label: 'Runs', num: true }, { label: 'Failed here', num: true }], M.steps.map((st) => [stepLabel(st.step), dur(st.medianMs), dur(st.p90Ms), n0.format(st.runs), n0.format(st.failures)]));
  }

  function fact(label, value, sub) {
    return h('div', { class: 'fact' }, h('div', { class: 'label', text: label }), h('div', { class: 'value', text: value }), sub ? h('div', { class: 'note', text: sub }) : null);
  }
  function carry() {
    const box = document.getElementById('carry-facts');
    const c = M.carry;
    if (!c.passes && !c.freshPasses) return box.replaceChildren(h('p', { class: 'empty', text: 'Recorded from the next pass on.' }));
    box.replaceChildren(
      fact('From kept work', c.passes ? pct(c.merged / c.passes) : '—', c.passes ? `merged, of ${c.passes} passes; median ${dur(c.medianMs)}` : 'no passes yet'),
      fact('From main', c.freshPasses ? pct(c.freshMerged / c.freshPasses) : '—', c.freshPasses ? `merged, of ${c.freshPasses} passes; median ${dur(c.freshMedianMs)}` : 'no passes yet'),
    );
  }
  function integration() {
    const box = document.getElementById('integration-facts');
    const it = M.integration;
    if (!it.passes) return box.replaceChildren(h('p', { class: 'empty', text: 'Recorded from the next pass on.' }));
    box.replaceChildren(
      fact('Ran the whole suite', pct(it.ran / it.passes), `${it.ran} of ${it.passes} passes`),
      fact('Failed at its gate step', pct(it.failedAtIntegration / it.passes), `${it.failedAtIntegration} passes, ${it.failedAtIntegrationRan} of them after running it`),
    );
  }

  function recent() {
    const box = document.getElementById('recent-table');
    if (!M.recent.length) return box.replaceChildren(h('p', { class: 'empty', text: 'No passes yet.' }));
    const SHORT = { merged: 'Merged', own: 'Own bug', recurring: 'Shared test', moved: 'main moved', blocked: 'Blocked', refused: 'Refused', cut: 'Cut short' };
    box.replaceChildren(
      table(
        [{ label: 'Ended' }, { label: 'Task' }, { label: 'Agent' }, { label: 'Result' }, { label: 'Took', num: true }, { label: 'Cost', num: true }, { label: 'What failed', wrap: true }],
        M.recent.map((r) => [
          F.dayTime.format(r.end),
          `${r.task} #${r.attempt}`,
          agentName(r.agent),
          h('span', { title: M.categories.find((c) => c.key === r.category)?.label ?? '' }, swatch(CAT_COLOR[r.category]), SHORT[r.category] ?? r.category),
          dur(r.ms),
          usd(r.costUsd),
          r.category === 'merged' ? (r.carried ? 'from kept work' : '') : (r.failing ?? stepLabel(r.failedStep ?? '')),
        ]),
      ),
    );
  }

  // ---- theme ----
  function theme() {
    const root = document.documentElement;
    const buttons = [...document.querySelectorAll('.theme button')];
    const set = (mode) => {
      if (mode === 'auto') root.removeAttribute('data-theme');
      else root.setAttribute('data-theme', mode);
      buttons.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === mode)));
      try {
        localStorage.setItem('mushy-metrics-theme', mode);
      } catch {
        // storage unavailable: the choice lasts this visit
      }
    };
    let saved = 'auto';
    try {
      saved = localStorage.getItem('mushy-metrics-theme') ?? 'auto';
    } catch {
      // no storage
    }
    buttons.forEach((b) => b.addEventListener('click', () => set(b.dataset.mode)));
    set(saved);
  }

  function draw() {
    for (const fn of [kpis, progress, allowance, throughput, mergeRate, timeSpent, agents, () => perTask('cost', 'costUsd', usd, 'Cost per merged task, by agent'), () => perTask('tokens', 'tokens', (v) => compact.format(v), 'Tokens per merged task, by agent, not counting cached input'), failedSteps, recurring, stepTimes, carry, integration, recent]) {
      try {
        fn();
      } catch (e) {
        console.error(e);
      }
    }
  }

  stamp();
  versions();
  theme();
  draw();
  let width = window.innerWidth;
  let timer;
  window.addEventListener('resize', () => {
    if (window.innerWidth === width) return;
    width = window.innerWidth;
    clearTimeout(timer);
    timer = setTimeout(draw, 150);
  });
  window.mushyMetrics = {
    update(model) {
      M = model;
      now = M.generatedAt;
      derive();
      stamp();
      versions();
      draw();
    },
  };
})();
