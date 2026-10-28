// Renders the computed dependency map (MapModel) as one self-contained HTML Gantt chart.
// Design §7.1: drafting-sheet header, one scrolling grid with a sticky task column and time header,
// one colour per lane, dependency arrows with the critical path highlighted, a detail panel, light and dark.
//
// The page is static markup plus the model as JSON; the inline script builds the chart once from data.
// Nothing from the model is ever interpolated into markup: the server side only embeds JSON (with `<`
// escaped), and the client inserts every model string with textContent or setAttribute.

import type { MapModel } from '../types.ts';

// The lanes: human tasks first, then the project's repos. Repos take the palette's colours in order (six,
// then round again); the colour is never the only signal, since each lane is labelled.
export const lanesOf = (model: MapModel): string[] => ['human', ...(model.lanes ?? [...new Set(model.nodes.filter((n) => n.lane !== 'human').map((n) => n.lane))])];
const laneVar = (lanes: string[], lane: string) => (lane === 'human' ? 'var(--lane-human)' : `var(--lane-${(lanes.indexOf(lane) - 1) % 6})`);
const laneLabel = (model: MapModel, lane: string) => (lane === 'human' ? `Human tasks${model.owner ? ` (${model.owner})` : ''}` : lane);

// Status legend, shared by agent tasks and human tasks. Each status has a distinct bar shape and glyph,
// so colour is never the only signal.
const STATUS_LEGEND: { key: string; glyph: string; label: string }[] = [
  { key: 'ready', glyph: '○', label: 'ready' },
  { key: 'claimed', glyph: '◐', label: 'claimed' },
  { key: 'done', glyph: '✓', label: 'done' },
  { key: 'needs_human', glyph: '!', label: 'needs_human' },
  { key: 'parked', glyph: '‖', label: 'parked' },
  { key: 'todo', glyph: '○', label: 'todo (human)' },
  { key: 'in_progress', glyph: '◐', label: 'in_progress (human)' },
];

/** JSON safe to place inside a <script> element: no `<` survives, so `</script>` and `<!--` cannot occur. */
export function embedJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c');
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

export function renderDependencyMap(model: MapModel): string {
  const lanes = lanesOf(model);
  const laneChecks = lanes.map(
    (l) =>
      `<label class="chip" style="--c:${laneVar(lanes, l)}"><input type="checkbox" data-lane="${esc(l)}" checked><i></i>${esc(laneLabel(model, l))}</label>`,
  ).join('');
  const statusLegend = STATUS_LEGEND.map(
    (s) =>
      `<span><i class="sw st-${s.key}"></i><b class="glyph" aria-hidden="true">${s.glyph}</b>${esc(s.label)}</span>`,
  ).join('');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<title>${esc(model.product ?? '')} Dependency Map</title>
<style>${CSS}</style>
</head>
<body>
<div class="wrap">
  <header class="sheet">
    <div class="ttl">
      <h1>${esc(model.product ?? 'The')} build: dependency map</h1>
      <p class="sub">Every task and human task, placed by its earliest start from the dependency graph. Click a task to see what it waits on and what it unblocks.</p>
    </div>
    <div class="titleblock" aria-label="Sheet details">
      <div class="k">Snapshot</div><div id="tb-gen"></div>
      <div class="k">Time origin</div><div id="tb-start"></div>
      <div class="k">Pass</div><div id="tb-pass"></div>
      <div class="k">Source</div><div>plan/ · runs/ (generated)</div>
    </div>
  </header>

  <section class="banner" id="banner" aria-label="Loop state">
    <div class="mode" id="mode"><span class="k">Loop mode</span><b id="mode-v"></b><span id="mode-d" class="md"></span></div>
    <div class="agents" id="agents"></div>
  </section>

  <div class="stats" id="stats"></div>

  <div class="controls">
    <div class="seg" role="group" aria-label="Time scale" id="zoom">
      <button type="button" data-z="fit" aria-pressed="true">Fit</button>
      <button type="button" data-z="hours" aria-pressed="false">Hours</button>
      <button type="button" data-z="days" aria-pressed="false">Days</button>
      <button type="button" data-z="weeks" aria-pressed="false">Weeks</button>
    </div>
    <label><input type="search" id="q" placeholder="Find a task" aria-label="Find a task by id, title or note"></label>
    <label><input type="checkbox" id="critonly"> Critical path only</label>
    <label><input type="checkbox" id="arr" checked> Arrows</label>
    <button type="button" class="chip theme" id="theme" aria-label="Colour theme">Theme: auto</button>
  </div>
  <fieldset class="chips" id="lanes"><legend class="vh">Lanes</legend>${laneChecks}</fieldset>
  <div class="legend" aria-label="Legend">
    ${statusLegend}
    <span><i class="sw crit"></i>critical path</span>
    <span><b class="ag" aria-hidden="true">C</b>Claude Code</span>
    <span><b class="ag" aria-hidden="true">X</b>Codex</span>
    <span><i class="sw ls"></i>human latest start</span>
    <span><i class="sw now"></i>snapshot</span>
    <span><i class="sw fin"></i>projected finish</span>
  </div>

  <div class="board" id="board">
    <div class="scroller" id="scroller"><div class="chart" id="chart"></div></div>
    <aside class="panel" id="panel" aria-live="polite" aria-label="Task details"></aside>
  </div>

  <p class="foot">Generated by the harness from plan data after every pass. Do not edit by hand. Times are hours from the time origin, shown in this browser's time zone. Human task bars span their lead time; the marker on each is the latest start that keeps the projected finish.</p>
</div>
<script type="application/json" id="model">${embedJson(model)}</script>
<script type="application/json" id="lanes">${embedJson({ lanes, names: Object.fromEntries(lanes.map((l) => [l, laneLabel(model, l)])) })}</script>
<script>${CLIENT_JS}</script>
</body>
</html>
`;
}

const CSS = `
:root{
  --paper:#f5f6f3;--sheet:#ffffff;--ink:#1b2330;--muted:#5b6571;--line:#d7dbd5;--grid:#eceee9;
  --accent:#1d5bb8;--crit:#c2410c;--critSoft:#fbe7dc;--sel:#fff4c2;--ok:#2f7a3a;--now:#3d4654;
  --lane-human:#a8721a;--lane-0:#8b3d8a;--lane-1:#1d5bb8;--lane-2:#2b7a6a;--lane-3:#6e6496;--lane-4:#9a5b1e;--lane-5:#3d6e2b;
  --font-display:"Avenir Next Condensed","Arial Narrow","Roboto Condensed",system-ui,sans-serif;
  --font-body:system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif;
  --font-mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  --rh:26px;--lw:340px;--hh:44px;
  color-scheme:light;
}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){
  --paper:#12161c;--sheet:#181d24;--ink:#e6e9ee;--muted:#9aa3ae;--line:#2d343e;--grid:#222831;
  --accent:#6ea0ec;--crit:#f08a52;--critSoft:#3a2418;--sel:#3a3418;--ok:#7cc46a;--now:#c3cad3;
  --lane-human:#e0a94a;--lane-0:#cf7fcd;--lane-1:#6ea0ec;--lane-2:#5fc0aa;--lane-3:#a59bd0;--lane-4:#e3a066;--lane-5:#8fc77a;
  color-scheme:dark}}
:root[data-theme="dark"]{
  --paper:#12161c;--sheet:#181d24;--ink:#e6e9ee;--muted:#9aa3ae;--line:#2d343e;--grid:#222831;
  --accent:#6ea0ec;--crit:#f08a52;--critSoft:#3a2418;--sel:#3a3418;--ok:#7cc46a;--now:#c3cad3;
  --lane-human:#e0a94a;--lane-0:#cf7fcd;--lane-1:#6ea0ec;--lane-2:#5fc0aa;--lane-3:#a59bd0;--lane-4:#e3a066;--lane-5:#8fc77a;
  color-scheme:dark}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--paper);color:var(--ink);font-family:var(--font-body);font-size:14px;line-height:1.45}
[hidden]{display:none!important}
.vh{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.wrap{padding:20px 20px 40px;max-width:1680px;margin:0 auto;display:flex;flex-direction:column;gap:14px}
header.sheet{display:flex;flex-wrap:wrap;justify-content:space-between;gap:12px 24px;align-items:flex-end;border-bottom:2px solid var(--ink);padding-bottom:12px}
.ttl{min-width:0;flex:1 1 380px}
h1{font-family:var(--font-display);font-weight:700;font-size:clamp(22px,3vw,32px);letter-spacing:.01em;margin:0;line-height:1.15;text-wrap:balance}
.sub{color:var(--muted);margin:4px 0 0;max-width:70ch}
.titleblock{font-family:var(--font-mono);font-size:11px;display:grid;grid-template-columns:auto minmax(0,auto);border:1px solid var(--ink);min-width:0;max-width:100%}
.titleblock div{padding:3px 8px;border-right:1px solid var(--line);border-bottom:1px solid var(--line);overflow-wrap:anywhere}
.titleblock div:nth-child(2n){border-right:0}
.titleblock div:nth-last-child(-n+2){border-bottom:0}
.titleblock .k{color:var(--muted);text-transform:uppercase;letter-spacing:.06em;white-space:nowrap}
.k{color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.06em}
.banner{display:flex;flex-wrap:wrap;gap:10px;align-items:stretch}
.mode{background:var(--sheet);border:1px solid var(--line);border-left:4px solid var(--accent);padding:8px 14px;display:flex;flex-direction:column;gap:1px;flex:1 1 240px;min-width:0}
.mode b{font:700 20px/1.2 var(--font-display);letter-spacing:.01em}
.mode .md{font-size:12.5px;color:var(--muted)}
.mode.paused{border-left-color:var(--crit)}.mode.paused b{color:var(--crit)}
.mode.single{border-left-color:var(--lane-human)}
.agents{display:flex;flex-wrap:wrap;gap:10px;flex:3 1 520px;min-width:0}
.agent{background:var(--sheet);border:1px solid var(--line);padding:8px 12px;flex:1 1 250px;min-width:0;display:flex;gap:10px;align-items:flex-start}
.agent .ag{width:30px;height:30px;font-size:14px;flex:none}
.agent .ab{display:flex;flex-direction:column;gap:3px;min-width:0;flex:1}
.agent .nm{font:700 16px/1.2 var(--font-display);display:flex;flex-wrap:wrap;gap:4px 8px;align-items:center;min-width:0}
.agent .nm .open{all:unset;cursor:pointer;border-radius:3px}
.agent .nm .open:hover{color:var(--accent)}
.agent .nm .open::after{content:" ›";color:var(--muted)}
.agent .nm .open:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.agent .meta{font:11.5px var(--font-mono);color:var(--muted);overflow-wrap:anywhere}
.slots{display:inline-flex;gap:3px;align-items:center;margin-left:auto;font:500 11px var(--font-body);color:var(--muted);white-space:nowrap}
.slots i{width:9px;height:9px;border-radius:2px;border:1.5px solid var(--accent);display:inline-block}
.slots i.on{background:var(--accent)}
.slots i.held{border-style:dashed;border-color:var(--muted)}
.slots .n{margin-left:3px}
.agent.limited .slots i{border-color:var(--crit)}
.agent .task{font-size:12.5px;min-width:0;display:flex;flex-direction:column;gap:0}
.agent .task button{all:unset;cursor:pointer;color:var(--accent);text-decoration:underline;text-underline-offset:2px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.agent .task button:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.agent .task .tl{font-size:11.5px;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.agent .idle{font-size:12.5px;color:var(--muted)}
.agent .paced{font-size:12px;color:var(--warn)}
.agent.limited{border-color:var(--crit)}
.agent .reset{font-size:12.5px;color:var(--crit);font-weight:600}
.pill{font:600 10px var(--font-body);text-transform:uppercase;letter-spacing:.06em;padding:2px 7px;border-radius:999px;display:inline-block;white-space:nowrap;border:1px solid transparent}
.pill.available{background:color-mix(in srgb,var(--ok) 16%,transparent);color:var(--ok)}
.pill.busy{background:color-mix(in srgb,var(--accent) 16%,transparent);color:var(--accent)}
.pill.limited,.pill.crit,.pill.overdue{background:var(--critSoft);color:var(--crit)}
.pill.probing,.pill.plain{background:color-mix(in srgb,var(--muted) 16%,transparent);color:var(--muted)}
.pill.overdue{border-color:var(--crit)}
.ag{display:inline-grid;place-items:center;width:16px;height:16px;border-radius:50%;border:1.5px solid var(--ink);font:700 9px var(--font-mono);color:var(--ink);flex:none;background:var(--sheet)}
.stats{display:flex;flex-wrap:wrap;gap:8px}
.stat{background:var(--sheet);border:1px solid var(--line);padding:7px 12px;min-width:104px;flex:1 1 104px;display:flex;flex-direction:column}
.stat b{font:600 22px/1.15 var(--font-display);font-variant-numeric:tabular-nums}
.stat span{font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted)}
.stat.warn{border-color:var(--crit)}.stat.warn b{color:var(--crit)}
.stat.wide{flex:2 1 190px}
.controls{display:flex;flex-wrap:wrap;gap:10px 18px;align-items:center}
.controls label{font-size:13px;display:flex;align-items:center;gap:6px}
input[type=search]{font:13px var(--font-body);padding:5px 8px;border:1px solid var(--line);background:var(--sheet);color:var(--ink);width:180px;max-width:100%}
.seg{display:inline-flex;border:1px solid var(--line);background:var(--sheet)}
.seg button{font:500 12.5px var(--font-body);color:var(--ink);background:transparent;border:0;border-right:1px solid var(--line);padding:5px 12px;cursor:pointer}
.seg button:last-child{border-right:0}
.seg button[aria-pressed="true"]{background:var(--ink);color:var(--sheet)}
.chips{display:flex;flex-wrap:wrap;gap:6px;border:0;margin:0;padding:0;min-width:0}
.chip{font:500 12px var(--font-body);border:1px solid var(--line);background:var(--sheet);color:var(--ink);padding:4px 10px 4px 8px;border-radius:999px;cursor:pointer;display:inline-flex;align-items:center;gap:6px;max-width:100%}
.chip input{margin:0;accent-color:var(--c)}
.chip i{width:10px;height:10px;border-radius:2px;display:inline-block;background:var(--c);flex:none}
.chip:has(input:not(:checked)){opacity:.5}
.chip:focus-within,button:focus-visible,input:focus-visible,.lab:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.legend{display:flex;flex-wrap:wrap;gap:6px 16px;font-size:12px;color:var(--muted);align-items:center}
.legend span{display:inline-flex;align-items:center;gap:5px;white-space:nowrap}
.legend .glyph{font:700 11px var(--font-mono);color:var(--ink);width:10px;text-align:center}
.legend .ag{width:15px;height:15px;font-size:8.5px}
.sw{display:inline-block;width:26px;height:12px;border-radius:2px;--c:var(--muted);flex:none}
.sw.crit{background:var(--muted);box-shadow:0 0 0 2px var(--crit)}
.sw.ls{width:3px;height:14px;border-radius:0;background:var(--ink)}
.sw.now{width:2px;height:14px;border-radius:0;background:var(--now)}
.sw.fin{width:0;height:14px;border-radius:0;border-left:2px dashed var(--crit)}
/* Status shapes: done = solid, claimed = hatched, ready/todo = outline, needs_human = dashed outline + cross-hatch, parked = dotted and faded. */
.st-done{background:var(--c)}
.st-claimed,.st-in_progress{background:repeating-linear-gradient(135deg,var(--c) 0 3px,color-mix(in srgb,var(--c) 22%,var(--sheet)) 3px 6px);border:1.5px solid var(--c)}
.st-ready,.st-todo{background:var(--sheet);border:1.5px solid var(--c)}
.st-needs_human{background:repeating-linear-gradient(45deg,color-mix(in srgb,var(--c) 40%,transparent) 0 1.5px,transparent 1.5px 5px),repeating-linear-gradient(-45deg,color-mix(in srgb,var(--c) 40%,transparent) 0 1.5px,transparent 1.5px 5px),var(--sheet);border:1.5px dashed var(--c)}
.st-parked{background:var(--sheet);border:1.5px dotted var(--c);opacity:.55}
.board{display:grid;grid-template-columns:minmax(0,1fr) 360px;gap:16px;align-items:start}
@media (max-width:1100px){.board{grid-template-columns:minmax(0,1fr)}}
.scroller{overflow:auto;max-height:78vh;background:var(--sheet);border:1px solid var(--line);position:relative;overscroll-behavior:contain}
.chart{position:relative;min-width:100%}
.hdr{position:sticky;top:0;z-index:6;background:var(--sheet);display:flex;height:var(--hh);border-bottom:1px solid var(--line)}
.hdr .lab{z-index:7;cursor:default;flex-direction:column;align-items:flex-start;justify-content:center;gap:0}
.hdr .lab b{font:600 11px var(--font-body);text-transform:uppercase;letter-spacing:.06em;color:var(--muted)}
.hdr .lab small{font-size:11px;color:var(--muted)}
.hdr .lab .hl{display:flex;align-items:center;gap:10px;width:100%}
.hdr .lab .wrapall{margin-left:auto;margin-right:6px;display:inline-flex;align-items:center;gap:5px;font:500 11px var(--font-body);color:var(--muted);cursor:pointer;white-space:nowrap}
.hdr .lab .wrapall input{margin:0;accent-color:var(--accent);cursor:pointer}
.rsz{position:absolute;top:0;right:0;width:9px;height:100%;cursor:col-resize;touch-action:none;z-index:8;outline:none}
.rsz::after{content:"";position:absolute;top:6px;bottom:6px;right:3px;width:3px;border-radius:2px}
.rsz:hover::after,.rsz:focus-visible::after,.rsz.drag::after{background:var(--accent)}
body.resizing{cursor:col-resize;user-select:none}
.chart.wrapped .row:not(.grp){height:auto;min-height:var(--rh)}
.chart.wrapped .row:not(.grp) .lab{height:auto;align-items:flex-start;padding-top:4px;padding-bottom:4px}
.chart.wrapped .row:not(.grp) .lab .nm{white-space:normal;overflow:visible;text-overflow:clip;overflow-wrap:anywhere;line-height:16px}
.chart.wrapped .row:not(.grp) .tl{height:auto;align-self:stretch}
.chart.wrapped .bar{top:calc(50% - (var(--rh) - 13px) / 2)}
.ticks{position:relative;flex:none;height:100%;overflow:hidden}
.ticks .mj{position:absolute;top:0;height:20px;border-left:1px solid var(--line);font:600 11px/20px var(--font-display);letter-spacing:.05em;text-transform:uppercase;padding:0 6px;white-space:nowrap;color:var(--ink)}
.ticks .mn{position:absolute;top:22px;height:20px;border-left:1px solid var(--grid);font:10px/20px var(--font-mono);padding-left:3px;white-space:nowrap;color:var(--muted)}
.ticks .flag{position:absolute;top:24px;z-index:2;font:600 10px/16px var(--font-body);padding:0 5px;border-radius:2px;white-space:nowrap;color:var(--sheet);transform:translateX(-50%)}
.ticks .flag.now{background:var(--now)}
.ticks .flag.fin{background:var(--crit)}
.rows{position:relative}
.row{display:flex;height:var(--rh);border-bottom:1px solid var(--grid);position:relative}
.lab{position:sticky;left:0;z-index:4;width:var(--lw);min-width:var(--lw);height:100%;background:var(--sheet);border-right:1px solid var(--line);display:flex;align-items:center;gap:6px;padding:0 8px;overflow:hidden;cursor:pointer}
.lab .gl{font:700 11px var(--font-mono);width:12px;text-align:center;flex:none}
.lab .id{font:500 10.5px var(--font-mono);border:1px solid currentColor;padding:0 3px;border-radius:3px;flex:none;width:52px;text-align:center}
.lab .nm{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:12.5px;flex:1;min-width:0}
.lab .pill{padding:1px 5px;font-size:9px}
.tl{position:relative;flex:none;height:100%}
.grp .lab{font:700 12px var(--font-display);letter-spacing:.06em;text-transform:uppercase;cursor:default;background:var(--paper);color:var(--c)}
.grp .lab .dot{width:10px;height:10px;border-radius:2px;background:var(--c);flex:none}
.grp .lab .cnt{margin-left:auto;font:500 11px var(--font-body);letter-spacing:0;text-transform:none;color:var(--muted);white-space:nowrap}
.grp .tl{background:color-mix(in srgb,var(--paper) 70%,transparent)}
.bar{position:absolute;top:6px;height:calc(var(--rh) - 13px);border-radius:3px;cursor:pointer;z-index:3;min-width:6px}
.bar.crit{box-shadow:0 0 0 1px var(--sheet),0 0 0 2.5px var(--crit)}
.lsm{position:absolute;top:2px;bottom:2px;width:3px;margin-left:-1px;background:var(--ink);z-index:3;pointer-events:none}
.lsl{position:absolute;top:50%;transform:translateY(-50%);font:600 10px/14px var(--font-body);white-space:nowrap;color:var(--muted);z-index:4;pointer-events:none;background:var(--sheet);padding:0 4px;border-radius:2px}
.row.overdue .lsm{background:var(--crit)}
.row.overdue .lsl{color:var(--crit)}
.row.overdue .lsl{background:var(--critSoft)}
.lvl{position:absolute;top:50%;transform:translateY(-50%);font:600 10.5px/14px var(--font-body);white-space:nowrap;color:var(--accent);z-index:4;pointer-events:none;background:var(--sheet);padding:0 5px;border-radius:2px;border:1px solid color-mix(in srgb,var(--accent) 35%,transparent);max-width:420px;overflow:hidden;text-overflow:ellipsis}
.row.overdue .lab{background:var(--critSoft);box-shadow:inset 3px 0 0 var(--crit)}
.row.overdue .tl{background:color-mix(in srgb,var(--critSoft) 55%,transparent)}
.row.sel .lab,.row.sel .tl{background:var(--sel)}
.row[data-id]:hover .lab{background:color-mix(in srgb,var(--accent) 8%,var(--sheet))}
.row.overdue[data-id]:hover .lab{background:color-mix(in srgb,var(--accent) 8%,var(--critSoft))}
.chart.has-sel .row[data-id]:not(.lit):not(.sel){opacity:.3}
.gridlines{position:absolute;top:0;bottom:0;pointer-events:none;z-index:0}
.gridlines div{position:absolute;top:0;bottom:0;border-left:1px solid var(--grid)}
.gridlines div.mj{border-left-color:var(--line)}
.gridlines div.now{border-left:2px solid var(--now);opacity:.7;z-index:2}
.gridlines div.fin{border-left:2px dashed var(--crit);z-index:2}
svg.arrows{position:absolute;top:0;pointer-events:none;z-index:2;overflow:visible}
svg.arrows path{fill:none;stroke:var(--muted);stroke-width:1;opacity:.4}
svg.arrows path.crit{stroke:var(--crit);opacity:.9;stroke-width:1.5}
svg.arrows .dimmed path{opacity:.07}
svg.arrows .hi path{stroke:var(--accent);opacity:1;stroke-width:1.8}
svg.arrows .hi path.crit{stroke:var(--crit)}
.empty{color:var(--muted);font-size:13px;margin:0}
.emptyrow{padding:16px;color:var(--muted);position:sticky;left:0;width:min(100%,100vw - 40px)}
.panel{background:var(--sheet);border:1px solid var(--line);padding:14px 16px;display:flex;flex-direction:column;gap:12px;max-height:78vh;overflow:auto;min-width:0;position:sticky;top:12px}
@media (max-width:1100px){.panel{position:static;max-height:none}}
.panel h2{font:600 19px/1.25 var(--font-display);margin:0;text-wrap:balance;overflow-wrap:anywhere}
.panel h3{margin:0 0 4px;font:600 11px var(--font-body);text-transform:uppercase;letter-spacing:.07em;color:var(--muted)}
.panel .tags{display:flex;flex-wrap:wrap;gap:6px;align-items:center}
.panel .sum{margin:-6px 0 0;font-size:13.5px;line-height:1.45;overflow-wrap:anywhere}
.tag{font:500 11px var(--font-mono);border:1px solid currentColor;padding:1px 6px;border-radius:3px;display:inline-block}
.kv{display:grid;grid-template-columns:104px minmax(0,1fr);gap:4px 10px;font-size:13px;margin:0}
.kv dt{color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.06em;padding-top:2px}
.kv dd{margin:0;font-variant-numeric:tabular-nums;overflow-wrap:anywhere}
.reqs{margin:0;padding-left:18px;font:12px var(--font-mono)}
.links{display:flex;flex-direction:column;gap:3px}
.links button{all:unset;cursor:pointer;font-size:12.5px;display:flex;gap:6px;align-items:baseline;min-width:0}
.links button .gl{font:700 11px var(--font-mono);width:12px;flex:none;text-align:center}
.links button .lid{font:500 10.5px var(--font-mono);color:var(--muted);width:52px;flex:none}
.links button .lt{min-width:0;overflow-wrap:anywhere}
.links button:hover,.links button:focus-visible{color:var(--accent)}
.note{font-size:13px;background:var(--critSoft);border-left:3px solid var(--crit);padding:8px 10px;margin:0}
.foot{font-size:12px;color:var(--muted);max-width:90ch;margin:0}
@media (max-width:640px){
  .wrap{padding:16px 16px 32px;gap:12px}
  :root{--lw:184px}
  .lab .nm{font-size:12px}
  .lab .id{width:46px;font-size:9.5px}
  .lab .pill{display:none}
  .scroller{max-height:64vh}
  .stat{min-width:88px;flex-basis:88px;padding:6px 10px}
  .stat b{font-size:19px}
  .controls{gap:8px 14px}
  .grp .lab .cnt{display:none}
  .titleblock{width:100%}
}
@media (prefers-reduced-motion:no-preference){.row{transition:opacity .12s}}
`;

// Client script. Plain ES2020, no template literals, so it can live in this TS template string untouched.
const CLIENT_JS = String.raw`
(function(){
"use strict";
var LANE_DATA = JSON.parse(document.getElementById("lanes").textContent);
var LANES = LANE_DATA.lanes;
var LANE_NAME = LANE_DATA.names;
function laneVar(lane){ return lane === "human" ? "var(--lane-human)" : "var(--lane-" + ((LANES.indexOf(lane) - 1) % 6) + ")"; }
var GLYPH = {ready:"○",todo:"○",claimed:"◐",in_progress:"◐",done:"✓",needs_human:"!",parked:"‖"};
var STATUS_TEXT = {ready:"Ready",todo:"To do",claimed:"Claimed",in_progress:"In progress",done:"Done",needs_human:"Needs human",parked:"Parked"};
var AGENT_NAME = {claude:"Claude Code",codex:"Codex"};
var AGENT_BADGE = {claude:"C",codex:"X"};
var MODE = {
  "parallel":["Parallel","Both agents available, each running as many passes as its slots allow."],
  "single:claude":["Single-threaded on Claude Code","Codex is at its quota wall; Claude Code runs alone until it resets."],
  "single:codex":["Single-threaded on Codex","Claude Code is at its quota wall; Codex runs alone until it resets."],
  "paused":["Paused","Both agents are at their quota walls. No passes until the earliest reset."],
  "idle":["Idle","No pass in flight: the loop is stopped, or has nothing it can take."]
};
var HOUR = 3600e3;
// Everything drawn from the model, set by load(): the page draws once from its embedded model, and the loop
// app (when the map is shown inside it) calls window.helixMap.update with each new model, in place.
var M, t0, tGen, tFin, nowH, finH, nodes, by, critSet, overdueList, deps, succ, spanH, allEdges;
function setModel(model){
  M = model;
  t0 = Date.parse(M.startAt); tGen = Date.parse(M.generatedAt); tFin = Date.parse(M.projectedFinish);
  nowH = (tGen - t0) / HOUR; finH = (tFin - t0) / HOUR;
  nodes = M.nodes || [];
  by = Object.create(null);
  nodes.forEach(function(n){ by[n.id] = n; });
  critSet = new Set(M.criticalPath || []);
  nodes.forEach(function(n){ if (n.critical) critSet.add(n.id); });
  overdueList = nodes.filter(overdue).sort(function(a,b){ return Date.parse(a.latestStart) - Date.parse(b.latestStart); });
  deps = Object.create(null); succ = Object.create(null);
  nodes.forEach(function(n){ deps[n.id] = (n.blockedBy || []).filter(function(d){ return by[d]; }); succ[n.id] = []; });
  nodes.forEach(function(n){ deps[n.id].forEach(function(d){ succ[d].push(n.id); }); });
  // Use the model's dependents where given, union with what blockedBy implies.
  nodes.forEach(function(n){ (n.dependents || []).forEach(function(s){ if (by[s] && succ[n.id].indexOf(s) < 0) succ[n.id].push(s); }); });
  allEdges = [];
  nodes.forEach(function(n){ deps[n.id].forEach(function(d){ allEdges.push([d, n.id]); }); });
  spanH = 8;
  nodes.forEach(function(n){ spanH = Math.max(spanH, n.ef || 0, n.lf || 0); var l = lsHours(n); if (l != null) spanH = Math.max(spanH, l); });
  if (isFinite(finH)) spanH = Math.max(spanH, finH);
  if (isFinite(nowH)) spanH = Math.max(spanH, nowH);
  spanH = spanH * 1.02 + 0.5;
}
// The loop app, when this page is shown inside it: it adds its own sections to the detail panel and hears of
// selections. Absent (null) when the page is opened on its own.
var HOST = (function(){ try { return window.parent !== window && window.parent.helixApp ? window.parent.helixApp : null; } catch(e){ return null; } })();
function isCrit(n){ return critSet.has(n.id); }
function lsHours(n){ return n.latestStart ? (Date.parse(n.latestStart) - t0) / HOUR : null; }
function overdue(n){ return n.kind === "human" && n.status !== "done" && n.latestStart && Date.parse(n.latestStart) < tGen; }

var $ = function(id){ return document.getElementById(id); };
function el(tag, cls, text){ var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = String(text); return e; }
var store = { get: function(k){ try { return localStorage.getItem("helix-map:" + k); } catch(e){ return null; } },
              set: function(k, v){ try { localStorage.setItem("helix-map:" + k, v); } catch(e){} } };

// ---- formatting ----
function fmtDate(ms, withTime){
  if (!isFinite(ms)) return "–";
  var d = new Date(ms);
  var o = {weekday:"short", day:"numeric", month:"short"};
  if (withTime){ o.hour = "2-digit"; o.minute = "2-digit"; o.hour12 = false; }
  return d.toLocaleString(undefined, o);
}
function fmtTime(ms){ return new Date(ms).toLocaleTimeString(undefined, {hour:"2-digit", minute:"2-digit", hour12:false}); }
function fmtDur(h){
  if (!isFinite(h)) return "–";
  var neg = h < 0; h = Math.abs(h);
  var s;
  if (h < 1) s = Math.round(h * 60) + " min";
  else if (h < 48) { var hh = Math.floor(h), mm = Math.round((h - hh) * 60); if (mm === 60){ hh++; mm = 0; } s = hh + " h" + (mm ? " " + mm + " min" : ""); }
  else s = (Math.round(h / 24 * 10) / 10) + " days";
  return neg ? "−" + s : s;
}
function hOff(h){ return fmtDate(t0 + h * HOUR, true); }
function range(a, b){
  var s = t0 + a * HOUR, e = t0 + b * HOUR;
  return fmtDate(s, true) + " → " + (new Date(s).toDateString() === new Date(e).toDateString() ? fmtTime(e) : fmtDate(e, true));
}

// ---- header, banner, stats ----
function header(){
  $("tb-gen").textContent = fmtDate(tGen, true);
  $("tb-start").textContent = fmtDate(t0, true);
  $("tb-pass").textContent = (M.passHours != null ? fmtDur(M.passHours) : "–") + " per pass";
}
function banner(){
  var m = MODE[M.mode] || [String(M.mode), ""];
  $("mode-v").textContent = m[0];
  $("mode-d").textContent = m[1];
  var mode = $("mode");
  mode.classList.toggle("paused", M.mode === "paused");
  mode.classList.toggle("single", String(M.mode).indexOf("single:") === 0);
  var box = $("agents");
  box.replaceChildren();
  (M.agents || []).forEach(function(a){
    var tasks = a.tasks || [], slots = a.slots || 1, allowed = a.paced != null ? a.paced : slots;
    var c = el("div", "agent " + a.state);
    c.appendChild(el("b", "ag", AGENT_BADGE[a.name] || "?"));
    var body = el("div", "ab");
    var nm = el("div", "nm");
    // Inside the loop app, the agent's name opens its own view: each pass it runs, and what it is doing.
    if (HOST && HOST.openAgent){
      var open = el("button", "open", AGENT_NAME[a.name] || a.name);
      open.type = "button"; open.title = "See what " + (AGENT_NAME[a.name] || a.name) + " is doing";
      open.onclick = function(){ HOST.openAgent(a.name); };
      nm.appendChild(open);
    } else nm.appendChild(el("span", null, AGENT_NAME[a.name] || a.name));
    nm.appendChild(el("span", "pill " + a.state, a.state));
    // One mark per slot: in use, free, or held back by the weekly pace.
    var meter = el("span", "slots");
    for (var i = 0; i < Math.max(slots, tasks.length); i++) meter.appendChild(el("i", i < tasks.length ? "on" : i >= allowed ? "held" : null));
    meter.appendChild(el("span", "n", tasks.length + " of " + slots));
    meter.title = tasks.length + " of " + slots + " slot" + (slots === 1 ? "" : "s") + " in use" + (allowed < slots ? "; its weekly pace allows " + allowed : "");
    nm.appendChild(meter);
    body.appendChild(nm);
    body.appendChild(el("div", "meta", a.model || "model unknown"));
    if (a.state === "limited" || a.resetAt){
      var r = Date.parse(a.resetAt);
      body.appendChild(el("div", "reset", a.resetAt ? "Resets " + fmtDate(r, true) + " · in " + fmtDur((r - tGen) / HOUR) : "Reset time unknown; backing off"));
    }
    tasks.forEach(function(id){
      var t = el("div", "task");
      var b = el("button", null, id + (by[id] ? " · " + by[id].title : ""));
      b.type = "button";
      b.title = id + (by[id] ? " · " + by[id].title : "");
      b.onclick = function(){ goTo(id); };
      t.appendChild(b);
      if (liveMap[id]) t.appendChild(el("span", "tl", liveMap[id]));
      body.appendChild(t);
    });
    if (!tasks.length && a.state !== "limited") body.appendChild(el("div", "idle", allowed === 0 ? "Paused by its weekly pace" : a.state === "available" && M.mode !== "idle" ? "Waiting for a ready task" : "No task"));
    if (allowed < slots && a.state !== "limited"){
      var why = allowed === 0
        ? "No new pass until " + (a.pacedUntil ? fmtDate(Date.parse(a.pacedUntil), true) : "its pace catches up")
        : "Its weekly pace allows " + allowed + " of " + slots + " slots";
      body.appendChild(el("div", "paced", why));
    }
    c.appendChild(body);
    box.appendChild(c);
  });
  if (!(M.agents || []).length) box.appendChild(el("div", "agent", "No agent state recorded yet."));
}
function stats(){
  var T = M.totals || {tasks:0,done:0,ready:0,claimed:0,needsHuman:0,parked:0};
  var humans = nodes.filter(function(n){ return n.kind === "human"; });
  var hOpen = humans.filter(function(n){ return n.status !== "done"; }).length;
  var critH = 0; (M.criticalPath || []).forEach(function(id){ if (by[id]) critH += by[id].durationHours; });
  var items = [
    [T.done + " / " + T.tasks, "Tasks done"],
    [T.ready, "Ready"],
    [T.claimed, "Claimed"],
    [T.needsHuman, "Needs human", T.needsHuman > 0],
    [T.parked, "Parked"],
    [hOpen + " / " + humans.length, "Human tasks open"],
    [overdueList.length, "Human tasks overdue", overdueList.length > 0],
    [fmtDur(critH), "Critical path · " + (M.criticalPath || []).length + " tasks"],
    [isFinite(tFin) ? fmtDate(tFin, true) : "–", "Projected finish", false, true]
  ];
  var box = $("stats");
  box.replaceChildren();
  items.forEach(function(it){
    var s = el("div", "stat" + (it[2] ? " warn" : "") + (it[3] ? " wide" : ""));
    s.appendChild(el("b", null, it[0]));
    s.appendChild(el("span", null, it[1]));
    box.appendChild(s);
  });
}

// ---- theme ----
var themeBtn = $("theme");
function applyTheme(t){
  if (t === "light" || t === "dark") document.documentElement.setAttribute("data-theme", t);
  else document.documentElement.removeAttribute("data-theme");
  themeBtn.textContent = "Theme: " + t;
}
var theme = store.get("theme") || "auto";
applyTheme(theme);
themeBtn.onclick = function(){ theme = theme === "auto" ? "light" : theme === "light" ? "dark" : "auto"; store.set("theme", theme); applyTheme(theme); };

// ---- graph helpers ----
function reach(id, dir){
  var acc = new Set(), stack = [id];
  while (stack.length){ var x = stack.pop(); var nx = dir === "up" ? deps[x] : succ[x];
    for (var i = 0; i < nx.length; i++){ if (!acc.has(nx[i])){ acc.add(nx[i]); stack.push(nx[i]); } } }
  return acc;
}

// ---- span and scale ----
var ZOOM = {hours:48, days:6, weeks:0.9};
var zoom = store.get("zoom") || "fit";
if (zoom !== "fit" && !ZOOM[zoom]) zoom = "fit";
var pph = 1;
var scroller = $("scroller"), chart = $("chart");
function labW(){ return parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--lw")) || 340; }
function computePph(){
  if (zoom !== "fit") return ZOOM[zoom];
  // Fit the whole span, but never squeeze the timeline below 320 px (phones scroll inside the grid instead).
  var avail = Math.max(320, scroller.clientWidth - labW() - 2);
  return Math.max(0.02, Math.min(400, avail / spanH));
}

// ---- the chart's frame, built once; its rows are rebuilt with each model (buildRows) ----
var hdr = el("div", "hdr");
var hlab = el("div", "lab");
var hl = el("div", "hl");
hl.appendChild(el("b", null, "Task"));
var wrapLbl = el("label", "wrapall");
var wrapCb = document.createElement("input"); wrapCb.type = "checkbox"; wrapCb.id = "wrapall";
wrapLbl.appendChild(wrapCb); wrapLbl.appendChild(document.createTextNode("Wrap all"));
wrapLbl.title = "Show every task's full title, wrapped onto as many lines as it needs";
hl.appendChild(wrapLbl);
hlab.appendChild(hl);
hlab.appendChild(el("small", null, "status · id · title · agent"));
var rsz = el("div", "rsz");
rsz.tabIndex = 0;
rsz.setAttribute("role", "separator"); rsz.setAttribute("aria-orientation", "vertical"); rsz.setAttribute("aria-label", "Task column width");
rsz.title = "Drag to resize the task column; double-click to reset it";
hlab.appendChild(rsz);
var ticks = el("div", "ticks");
hdr.appendChild(hlab); hdr.appendChild(ticks);
var gridlines = el("div", "gridlines");
var rowsBox = el("div", "rows");
var svgNS = "http://www.w3.org/2000/svg";
var svg = document.createElementNS(svgNS, "svg"); svg.setAttribute("class", "arrows"); svg.setAttribute("aria-hidden", "true");
var defs = document.createElementNS(svgNS, "defs");
[["n","var(--muted)",0.6],["crit","var(--crit)",1],["hi","var(--accent)",1]].forEach(function(m){
  var mk = document.createElementNS(svgNS, "marker");
  mk.setAttribute("id", "ah-" + m[0]); mk.setAttribute("viewBox", "0 0 6 6"); mk.setAttribute("refX", "5.5"); mk.setAttribute("refY", "3");
  mk.setAttribute("markerWidth", "6"); mk.setAttribute("markerHeight", "6"); mk.setAttribute("orient", "auto");
  var p = document.createElementNS(svgNS, "path"); p.setAttribute("d", "M0,0L6,3L0,6z"); p.setAttribute("style", "fill:" + m[1] + ";stroke:none;opacity:" + m[2]);
  mk.appendChild(p); defs.appendChild(mk);
});
svg.appendChild(defs);
var gBase = document.createElementNS(svgNS, "g"), gHi = document.createElementNS(svgNS, "g");
gHi.setAttribute("class", "hi");
svg.appendChild(gBase); svg.appendChild(gHi);
var emptyRow = el("div", "emptyrow", "No tasks match these filters.");
emptyRow.hidden = true;

var rowOf, barOf, lsmOf, liveOf, groups, tls;
function buildRows(){
rowOf = Object.create(null); barOf = Object.create(null); lsmOf = Object.create(null); liveOf = Object.create(null);
groups = []; tls = [];
rowsBox.replaceChildren();
LANES.forEach(function(lane){
  var list = nodes.filter(function(n){ return n.lane === lane; })
    .sort(function(a, b){ return a.es - b.es || a.ls - b.ls || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0); });
  if (!list.length) return;
  var g = el("div", "row grp");
  g.style.setProperty("--c", laneVar(lane));
  var gl = el("div", "lab");
  gl.appendChild(el("i", "dot"));
  gl.appendChild(el("span", null, LANE_NAME[lane] || lane));
  var done = list.filter(function(n){ return n.status === "done"; }).length;
  gl.appendChild(el("span", "cnt", done + " of " + list.length + " done"));
  g.appendChild(gl);
  var gtl = el("div", "tl"); g.appendChild(gtl); tls.push(gtl);
  rowsBox.appendChild(g);
  var grp = {lane: lane, row: g, items: list};
  groups.push(grp);
  list.forEach(function(n){
    var r = el("div", "row");
    r.dataset.id = n.id;
    if (overdue(n)) r.classList.add("overdue");
    var lab = el("div", "lab");
    lab.tabIndex = 0;
    lab.setAttribute("role", "button");
    var gly = el("span", "gl", GLYPH[n.status] || "?");
    gly.setAttribute("role", "img"); gly.setAttribute("aria-label", STATUS_TEXT[n.status] || n.status); gly.title = STATUS_TEXT[n.status] || n.status;
    lab.appendChild(gly);
    var idb = el("span", "id", n.id); idb.style.color = laneVar(lane);
    lab.appendChild(idb);
    var nm = el("span", "nm", n.title); nm.title = n.summary ? n.title + "\n" + n.summary : n.title;
    lab.appendChild(nm);
    if (overdue(n)) lab.appendChild(el("span", "pill overdue", "Overdue"));
    else if (isCrit(n) && n.status !== "done") lab.appendChild(el("span", "pill crit", "CP"));
    if (n.agent){ var ag = el("b", "ag", AGENT_BADGE[n.agent] || "?"); ag.title = (n.status === "done" ? "Completed by " : "Held by ") + (AGENT_NAME[n.agent] || n.agent); ag.setAttribute("aria-label", ag.title); lab.appendChild(ag); }
    r.appendChild(lab);
    var tl = el("div", "tl"); tls.push(tl);
    var bar = el("div", "bar st-" + n.status + (isCrit(n) ? " crit" : ""));
    bar.style.setProperty("--c", laneVar(lane));
    bar.title = n.id + " · " + n.title + "\n" + (STATUS_TEXT[n.status] || n.status) + " · " + hOff(n.es) + " → " + hOff(n.ef) + (n.summary ? "\n" + n.summary : "");
    bar.dataset.id = n.id;
    tl.appendChild(bar);
    barOf[n.id] = bar;
    var lh = lsHours(n);
    if (lh != null){
      var m = el("div", "lsm");
      var ml = el("span", "lsl", (overdue(n) ? "Start was due " : "Start by ") + fmtDate(Date.parse(n.latestStart), false));
      tl.appendChild(m); tl.appendChild(ml);
      lsmOf[n.id] = {line: m, label: ml};
    }
    r.appendChild(tl);
    rowsBox.appendChild(r);
    rowOf[n.id] = r;
  });
});
rowsBox.appendChild(emptyRow);
}
chart.appendChild(hdr);
chart.appendChild(gridlines);
chart.appendChild(rowsBox);
chart.appendChild(svg);

// ---- state ----
var state = {lanes: Object.create(null), crit: false, q: "", arr: true, sel: null};
LANES.forEach(function(l){ state.lanes[l] = true; });
try { var saved = JSON.parse(store.get("lanes") || "null"); if (saved) LANES.forEach(function(l){ if (typeof saved[l] === "boolean") state.lanes[l] = saved[l]; }); } catch(e){}
document.querySelectorAll("#lanes input[data-lane]").forEach(function(cb){
  cb.checked = state.lanes[cb.dataset.lane] !== false;
  cb.onchange = function(){ state.lanes[cb.dataset.lane] = cb.checked; store.set("lanes", JSON.stringify(state.lanes)); applyFilter(); };
});

var order = []; // visible row index -> node id (null for group rows)
var yOf = Object.create(null), hOf = Object.create(null);
function visible(n){
  if (!state.lanes[n.lane]) return false;
  if (state.crit && !isCrit(n)) return false;
  if (state.q){ var q = state.q.toLowerCase(); if ((n.id + " " + n.title + " " + (n.summary || "")).toLowerCase().indexOf(q) < 0) return false; }
  return true;
}
function rh(){ return parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--rh")) || 26; }
function applyFilter(){
  order = [];
  groups.forEach(function(g){
    var any = false;
    g.items.forEach(function(n){ var v = visible(n); rowOf[n.id].hidden = !v; if (v){ if (!any){ order.push(null); any = true; } order.push(n.id); } });
    g.row.hidden = !any;
  });
  emptyRow.hidden = order.length > 0;
  var RH = rh(); yOf = Object.create(null); hOf = Object.create(null);
  if (chart.classList.contains("wrapped")){
    // Wrapped titles give rows their own heights: read them all in one pass, with no writes between.
    order.forEach(function(id){ if (id){ var r = rowOf[id]; yOf[id] = r.offsetTop + r.offsetHeight / 2; hOf[id] = r.offsetHeight; } });
  } else {
    // Each row is exactly RH tall (border included); positions come from the index, never from layout reads.
    order.forEach(function(id, i){ if (id){ yOf[id] = i * RH + RH / 2; hOf[id] = RH; } });
  }
  drawArrows();
}

// ---- time axis ----
var STEPS = [0.25, 0.5, 1, 2, 3, 6, 12, 24, 48, 168, 336, 672];
function tickTimes(stepH){
  var out = [], end = t0 + spanH * HOUR, d;
  if (stepH < 24){
    var ms = stepH * HOUR, off = new Date(t0).getTimezoneOffset() * 60e3;
    var first = Math.ceil((t0 - off) / ms) * ms + off;
    for (var t = first; t <= end; t += ms) out.push(t);
  } else if (stepH < 168){
    d = new Date(t0); d.setHours(0,0,0,0); if (d.getTime() < t0) d.setDate(d.getDate() + 1);
    var n = stepH / 24;
    for (; d.getTime() <= end; d.setDate(d.getDate() + n)) out.push(d.getTime());
  } else {
    d = new Date(t0); d.setHours(0,0,0,0); d.setDate(d.getDate() + ((8 - d.getDay()) % 7)); if (d.getTime() < t0) d.setDate(d.getDate() + 7);
    var w = stepH / 168;
    for (; d.getTime() <= end; d.setDate(d.getDate() + 7 * w)) out.push(d.getTime());
  }
  return out;
}
function drawAxis(){
  var W = spanH * pph;
  var minor = STEPS[STEPS.length - 1];
  for (var i = 0; i < STEPS.length; i++){ if (STEPS[i] * pph >= 46){ minor = STEPS[i]; break; } }
  var major = minor < 24 ? 24 : minor < 168 ? 168 : 672;
  var majors = tickTimes(major), minors = tickTimes(minor);
  var frT = document.createDocumentFragment(), frG = document.createDocumentFragment();
  var x = function(ms){ return (ms - t0) / HOUR * pph; };
  // Major band labels: one per period, starting at the origin so the first period is labelled too.
  var mstarts = [t0].concat(majors.filter(function(t){ return t > t0; }));
  mstarts.forEach(function(t, i){
    var nx = i + 1 < mstarts.length ? mstarts[i + 1] : t0 + spanH * HOUR;
    var dv = el("div", "mj");
    var dt = new Date(t);
    dv.textContent = major === 24 ? dt.toLocaleDateString(undefined, {weekday:"short", day:"numeric", month:"short"})
      : major === 168 ? "Week of " + dt.toLocaleDateString(undefined, {day:"numeric", month:"short"})
      : dt.toLocaleDateString(undefined, {day:"numeric", month:"short", year:"numeric"});
    dv.style.left = x(t) + "px"; dv.style.width = Math.max(0, x(nx) - x(t)) + "px";
    if (i === 0) dv.style.borderLeft = "0";
    frT.appendChild(dv);
  });
  var majorSet = new Set(majors);
  minors.forEach(function(t){
    var dt = new Date(t);
    var lbl = minor < 24 ? fmtTime(t) : minor < 168 ? dt.toLocaleDateString(undefined, {weekday:"short"}) + " " + dt.getDate() : dt.toLocaleDateString(undefined, {day:"numeric", month:"short"});
    var dv = el("div", "mn", lbl); dv.style.left = x(t) + "px"; dv.style.width = minor * pph + "px";
    frT.appendChild(dv);
    var gl = el("div", majorSet.has(t) ? "mj" : null); gl.style.left = x(t) + "px"; frG.appendChild(gl);
  });
  majors.forEach(function(t){ if (minors.indexOf(t) < 0){ var gl = el("div", "mj"); gl.style.left = x(t) + "px"; frG.appendChild(gl); } });
  if (isFinite(nowH) && nowH >= 0){
    var nl = el("div", "now"); nl.style.left = nowH * pph + "px"; frG.appendChild(nl);
    var nf = el("div", "flag now", HOST ? "Now" : "Snapshot"); nf.style.left = nowH * pph + "px"; nf.title = fmtDate(tGen, true); frT.appendChild(nf);
  }
  if (isFinite(finH)){
    var fl = el("div", "fin"); fl.style.left = finH * pph + "px"; frG.appendChild(fl);
    var ff = el("div", "flag fin", "Finish " + fmtDate(tFin, false)); ff.style.left = finH * pph + "px"; ff.title = "Projected finish " + fmtDate(tFin, true); frT.appendChild(ff);
  }
  ticks.replaceChildren(frT); gridlines.replaceChildren(frG);
  ticks.style.width = W + "px";
  // Keep each flag inside the axis, and hide the minor labels it would cover.
  var flags = ticks.querySelectorAll(".flag"), spans = [];
  flags.forEach(function(f){ var w = f.offsetWidth, c = Math.max(w / 2, Math.min(W - w / 2 - 2, parseFloat(f.style.left)));
    f.style.left = c + "px"; spans.push([c - w / 2 - 4, c + w / 2 + 4]); });
  ticks.querySelectorAll(".mn").forEach(function(m){
    var l = parseFloat(m.style.left), r = l + Math.min(parseFloat(m.style.width), 64);
    m.hidden = spans.some(function(s){ return l < s[1] && r > s[0]; });
  });
  // A band too narrow for its label (the part-period at the start) drops it rather than print over the next.
  var mjs = ticks.querySelectorAll(".mj"), over = [];
  mjs.forEach(function(m){ over.push(m.scrollWidth > m.offsetWidth + 1); });
  mjs.forEach(function(m, i){ if (over[i]) m.textContent = ""; });
}

function layoutBars(){
  var W = spanH * pph, LW = labW();
  tls.forEach(function(tl){ tl.style.width = W + "px"; });
  // An explicit chart width keeps the sticky task column inside its rows at any horizontal scroll.
  chart.style.width = (LW + W) + "px";
  gridlines.style.left = LW + "px"; gridlines.style.width = W + "px";
  svg.style.left = LW + "px"; svg.setAttribute("width", String(W));
  // Read every latest-start label width in one pass before any position writes (one layout, no thrash).
  var widths = Object.create(null);
  for (var id in lsmOf) widths[id] = lsmOf[id].label.offsetWidth;
  nodes.forEach(function(n){
    var b = barOf[n.id]; if (!b) return;
    b.style.left = (n.es * pph) + "px";
    b.style.width = Math.max(6, (n.ef - n.es) * pph) + "px";
    var m = lsmOf[n.id]; if (!m) return;
    var mx = lsHours(n) * pph, bl = n.es * pph, br = barEnd(n);
    m.line.style.left = mx + "px";
    // The label goes after the bar, else before it, else inside it, else beside the marker; it has its own background.
    var mw = widths[n.id] || 120;
    var after = Math.max(br, mx) + 6, before = Math.min(bl, mx) - 6 - mw, inBar = Math.max(bl, mx) + 6;
    var x = after + mw <= W - 4 ? after : before >= 0 ? before : inBar + mw <= br - 4 ? inBar : Math.max(0, Math.min(mx - 6 - mw, W - 4 - mw));
    m.label.style.left = x + "px";
  });
  for (var lid in liveOf){ if (by[lid]) liveOf[lid].style.left = (barEnd(by[lid]) + 6) + "px"; }
}
// What a running pass's builder last reported, beside its bar (the loop app sets it; empty on its own).
var liveMap = Object.create(null);
function applyLive(){
  for (var id in liveOf) liveOf[id].remove();
  liveOf = Object.create(null);
  for (var lid in liveMap){
    var b = barOf[lid]; if (!b) continue;
    var l = el("span", "lvl", liveMap[lid]); l.title = liveMap[lid];
    b.parentNode.appendChild(l); liveOf[lid] = l;
  }
}
function barEnd(n){ return Math.max(n.ef * pph, n.es * pph + 6); }
function edgePath(p, t){
  var x1 = barEnd(p), y1 = yOf[p.id], x2 = t.es * pph, y2 = yOf[t.id];
  if (x2 - 6 >= x1 + 4) return "M" + x1 + "," + y1 + "H" + (x2 - 6) + "V" + y2 + "H" + x2;
  var half = (hOf[t.id] || rh()) / 2;
  var ym = y2 + (y2 > y1 ? -half : half);
  return "M" + x1 + "," + y1 + "H" + (x1 + 5) + "V" + ym + "H" + (x2 - 6) + "V" + y2 + "H" + x2;
}
function pathsFor(edges){
  // Paths are numbers only; class names are fixed strings. No model text reaches this markup.
  var s = "";
  for (var i = 0; i < edges.length; i++){
    var p = by[edges[i][0]], t = by[edges[i][1]];
    var c = isCrit(p) && isCrit(t) && Math.abs(p.ef - t.es) < 1e-6 ? "crit" : "";
    s += '<path class="' + c + '" d="' + edgePath(p, t) + '" marker-end="url(#ah-' + (c || "n") + ')"/>';
  }
  return s;
}
function drawArrows(){
  var H = chart.classList.contains("wrapped") ? rowsBox.offsetHeight : order.length * rh();
  svg.setAttribute("height", String(Math.max(H, 1)));
  svg.style.top = hdr.offsetHeight + "px";
  gridlines.style.top = "0";
  if (!state.arr){ gBase.innerHTML = ""; gHi.innerHTML = ""; return; }
  var vis = allEdges.filter(function(e){ return yOf[e[0]] != null && yOf[e[1]] != null; });
  gBase.innerHTML = pathsFor(vis);
  drawHi();
}
var lit = new Set();
function drawHi(){
  gBase.classList.toggle("dimmed", !!state.sel);
  if (!state.sel || !state.arr){ gHi.innerHTML = ""; return; }
  var up = reach(state.sel, "up"), dn = reach(state.sel, "dn"), s = state.sel;
  var edges = allEdges.filter(function(e){
    if (yOf[e[0]] == null || yOf[e[1]] == null) return false;
    return (up.has(e[0]) && (up.has(e[1]) || e[1] === s)) || (dn.has(e[1]) && (dn.has(e[0]) || e[0] === s));
  });
  gHi.innerHTML = pathsFor(edges);
  Array.prototype.forEach.call(gHi.children, function(p){ if (!p.classList.contains("crit")) p.setAttribute("marker-end", "url(#ah-hi)"); });
}

function relayout(){
  pph = computePph();
  drawAxis();
  layoutBars();
  applyFilter();
}

// ---- selection and panel ----
function select(id){
  mark((id && by[id] && state.sel !== id) ? id : null);
  if (HOST && HOST.onSelect) HOST.onSelect(state.sel);
  panel();
}
// Shows id as the selection, with everything up- and downstream of it lit.
function mark(id){
  if (lit.size){ lit.forEach(function(x){ if (rowOf[x]) rowOf[x].classList.remove("lit"); }); lit.clear(); }
  if (state.sel && rowOf[state.sel]) rowOf[state.sel].classList.remove("sel");
  state.sel = id;
  chart.classList.toggle("has-sel", !!state.sel);
  if (state.sel){
    rowOf[state.sel].classList.add("sel");
    reach(state.sel, "up").forEach(function(x){ lit.add(x); });
    reach(state.sel, "dn").forEach(function(x){ lit.add(x); });
    lit.forEach(function(x){ if (rowOf[x]) rowOf[x].classList.add("lit"); });
  }
  drawHi();
}
function goTo(id){
  if (!by[id]) return;
  if (state.sel !== id) select(id);
  var r = rowOf[id];
  if (r && !r.hidden){
    var top = r.offsetTop, hh = hdr.offsetHeight;
    if (top < scroller.scrollTop + hh || top + r.offsetHeight > scroller.scrollTop + scroller.clientHeight) scroller.scrollTop = Math.max(0, top - hh - 2 * rh());
    var b = barOf[id]; if (b){ var bl = b.offsetLeft, lw = labW(); if (bl < scroller.scrollLeft || bl > scroller.scrollLeft + scroller.clientWidth - lw - 40) scroller.scrollLeft = Math.max(0, bl - 40); }
  }
}
rowsBox.addEventListener("click", function(e){
  var t = e.target.closest("[data-id]");
  if (t && !t.classList.contains("grp")) select(t.dataset.id);
});
rowsBox.addEventListener("keydown", function(e){
  if ((e.key === "Enter" || e.key === " ") && e.target.classList.contains("lab")){ e.preventDefault(); var r = e.target.parentNode; if (r.dataset.id) select(r.dataset.id); }
});

function linkList(ids, emptyText){
  var box = el("div", "links");
  if (!ids.length){ box.appendChild(el("p", "empty", emptyText)); return box; }
  ids.forEach(function(id){
    var n = by[id];
    var b = el("button"); b.type = "button";
    var g = el("span", "gl", n ? GLYPH[n.status] : "?"); g.title = n ? (STATUS_TEXT[n.status] || n.status) : "Unknown";
    b.appendChild(g);
    b.appendChild(el("span", "lid", id));
    b.appendChild(el("span", "lt", n ? n.title : "(not in the map)"));
    if (n) b.onclick = function(){ goTo(id); };
    box.appendChild(b);
  });
  return box;
}
function sec(title, child){ var s = el("div", "sec"); s.appendChild(el("h3", null, title)); s.appendChild(child); return s; }
function panel(){
  var p = $("panel");
  p.replaceChildren();
  if (!state.sel){
    if (overdueList.length){
      p.appendChild(el("h2", null, "Waiting on a person"));
      p.appendChild(el("p", "note", overdueList.length + " human task" + (overdueList.length === 1 ? " is" : "s are") + " past the latest start that keeps the projected finish. Every hour of delay moves the finish."));
      p.appendChild(linkList(overdueList.map(function(n){ return n.id; }), ""));
    }
    var cp = (M.criticalPath || []).filter(function(id){ return by[id]; });
    p.appendChild(el("h2", null, "Critical path"));
    p.appendChild(el("p", "empty", cp.length ? "These " + cp.length + " tasks have zero slack. A slip on any of them moves the projected finish." : "No critical path computed yet."));
    if (cp.length) p.appendChild(linkList(cp, ""));
    p.appendChild(el("p", "empty", "Click any bar or task name to see what it waits on and what it unblocks."));
    return;
  }
  var n = by[state.sel];
  var tags = el("div", "tags");
  var tg = el("span", "tag", n.id); tg.style.color = laneVar(n.lane); tags.appendChild(tg);
  tags.appendChild(el("span", "pill plain", (GLYPH[n.status] || "") + " " + (STATUS_TEXT[n.status] || n.status)));
  if (isCrit(n)) tags.appendChild(el("span", "pill crit", "Critical path"));
  if (overdue(n)) tags.appendChild(el("span", "pill overdue", "Overdue"));
  if (n.agent) tags.appendChild(el("span", "pill busy", (n.status === "done" ? "Done by " : "Held by ") + (AGENT_NAME[n.agent] || n.agent)));
  p.appendChild(tags);
  p.appendChild(el("h2", null, n.title));
  if (n.summary) p.appendChild(el("p", "sum", n.summary));
  if (overdue(n)) p.appendChild(el("p", "note", "Latest start was " + fmtDate(Date.parse(n.latestStart), true) + ", " + fmtDur((tGen - Date.parse(n.latestStart)) / HOUR) + " before this snapshot. Starting it now is the fastest way to pull the finish back."));
  var kv = el("dl", "kv");
  function row(k, v){ kv.appendChild(el("dt", null, k)); kv.appendChild(el("dd", null, v)); }
  row("Lane", LANE_NAME[n.lane] || n.lane);
  if (n.milestone) row("Milestone", n.milestone);
  if (n.area) row("Area", n.area);
  row("Earliest", range(n.es, n.ef));
  row("Latest", range(n.ls, n.lf));
  row("Duration", fmtDur(n.durationHours));
  row("Slack", isCrit(n) ? "None. A slip here moves the finish." : fmtDur(n.slack));
  if (n.latestStart) row("Start by", fmtDate(Date.parse(n.latestStart), true));
  var up = reach(n.id, "up").size, dn = reach(n.id, "dn").size;
  row("Upstream", up + " task" + (up === 1 ? "" : "s"));
  row("Downstream", dn + " task" + (dn === 1 ? "" : "s"));
  p.appendChild(kv);
  if ((n.reqs || []).length){
    var ul = el("ul", "reqs"); n.reqs.forEach(function(r){ ul.appendChild(el("li", null, r)); });
    p.appendChild(sec("Requirements", ul));
  }
  p.appendChild(sec("Waits on", linkList(n.blockedBy || [], "Nothing. It can start any time.")));
  p.appendChild(sec("Unblocks", linkList(succ[n.id], "Nothing downstream.")));
  if (HOST && HOST.decoratePanel) HOST.decoratePanel(p, n);
  var clr = el("button", "chip", "Clear selection"); clr.type = "button"; clr.style.alignSelf = "flex-start";
  clr.onclick = function(){ select(null); };
  p.appendChild(clr);
}

// ---- controls ----
var zoomBtns = document.querySelectorAll("#zoom button");
function setZoom(z){
  zoom = z; store.set("zoom", z);
  zoomBtns.forEach(function(b){ b.setAttribute("aria-pressed", String(b.dataset.z === z)); });
  // Keep the time at the left edge of the viewport in place while zooming.
  var h = scroller.scrollLeft / pph;
  relayout();
  scroller.scrollLeft = h * pph;
}
zoomBtns.forEach(function(b){ b.onclick = function(){ setZoom(b.dataset.z); }; });
zoomBtns.forEach(function(b){ b.setAttribute("aria-pressed", String(b.dataset.z === zoom)); });
$("critonly").onchange = function(e){ state.crit = e.target.checked; applyFilter(); };
$("arr").onchange = function(e){ state.arr = e.target.checked; drawArrows(); };
var qT = 0;
$("q").oninput = function(e){ clearTimeout(qT); qT = setTimeout(function(){ state.q = e.target.value.trim(); applyFilter(); }, 120); };
// Wrap all, and the task column's width: dragging its dividing line in the header, or arrow keys on it.
wrapCb.checked = store.get("wrap") === "1";
chart.classList.toggle("wrapped", wrapCb.checked);
wrapCb.onchange = function(){ chart.classList.toggle("wrapped", wrapCb.checked); store.set("wrap", wrapCb.checked ? "1" : "0"); applyFilter(); };
var LW_MIN = 160;
function lwMax(){ return Math.max(LW_MIN, Math.min(960, scroller.clientWidth - 200)); }
function setLw(px){
  px = Math.round(Math.max(LW_MIN, Math.min(lwMax(), px)));
  document.documentElement.style.setProperty("--lw", px + "px");
  rsz.setAttribute("aria-valuenow", String(px));
  return px;
}
var savedLw = parseFloat(store.get("lw") || "");
if (savedLw > 0) setLw(savedLw);
rsz.setAttribute("aria-valuemin", String(LW_MIN)); rsz.setAttribute("aria-valuemax", String(lwMax())); rsz.setAttribute("aria-valuenow", String(Math.round(labW())));
var lwFrame = 0;
function relayoutSoon(){ if (!lwFrame) lwFrame = requestAnimationFrame(function(){ lwFrame = 0; relayout(); }); }
rsz.addEventListener("pointerdown", function(e){
  if (e.button !== 0) return;
  e.preventDefault();
  var x0 = e.clientX, w0 = labW();
  rsz.setPointerCapture(e.pointerId); rsz.classList.add("drag"); document.body.classList.add("resizing");
  function move(ev){ setLw(w0 + ev.clientX - x0); relayoutSoon(); }
  function end(){
    rsz.removeEventListener("pointermove", move); rsz.removeEventListener("pointerup", end); rsz.removeEventListener("pointercancel", end);
    rsz.classList.remove("drag"); document.body.classList.remove("resizing");
    store.set("lw", String(Math.round(labW())));
  }
  rsz.addEventListener("pointermove", move); rsz.addEventListener("pointerup", end); rsz.addEventListener("pointercancel", end);
});
rsz.addEventListener("keydown", function(e){
  var d = e.key === "ArrowLeft" ? -20 : e.key === "ArrowRight" ? 20 : 0;
  if (!d) return;
  e.preventDefault(); store.set("lw", String(setLw(labW() + d))); relayout();
});
rsz.addEventListener("dblclick", function(){
  document.documentElement.style.removeProperty("--lw"); store.set("lw", "");
  rsz.setAttribute("aria-valuenow", String(Math.round(labW()))); relayout();
});
var rz = 0, lastW = scroller.clientWidth;
window.addEventListener("resize", function(){
  if (rz) return;
  rz = requestAnimationFrame(function(){ rz = 0; var w = scroller.clientWidth; if (w !== lastW){ lastW = w; relayout(); } });
});

// Draws a model: the first one, embedded in the page, and each one after it, in place. Zoom, lanes, filters,
// the selection and the scroll position carry over; the detail panel is rebuilt only when the selected task
// itself changed, so whatever the loop app added to it (a comment being written) stays as it is.
function load(model){
  var top = scroller.scrollTop, left = scroller.scrollLeft;
  var sel = state.sel, before = sel && by && by[sel] ? JSON.stringify(by[sel]) : null;
  setModel(model);
  header(); banner(); stats();
  buildRows();
  applyLive();
  relayout();
  mark(sel && by[sel] ? sel : null);
  if (!state.sel || JSON.stringify(by[state.sel]) !== before) panel();
  scroller.scrollTop = top; scroller.scrollLeft = left;
}
load(JSON.parse(document.getElementById("model").textContent));
// Start with the snapshot in view when the chart is wider than the viewport.
if (zoom !== "fit" && isFinite(nowH)) scroller.scrollLeft = Math.max(0, nowH * pph - 80);
window.helixMap = {
  update: load,
  live: function(m){ liveMap = m || Object.create(null); applyLive(); layoutBars(); banner(); },
  select: function(id){ if (id) goTo(id); else if (state.sel) select(null); },
  selected: function(){ return state.sel; }
};
if (HOST && HOST.mapReady) HOST.mapReady(window.helixMap, document);
document.documentElement.dataset.ready = "1";
})();
`;
