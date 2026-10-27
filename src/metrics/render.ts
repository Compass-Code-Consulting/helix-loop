import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { embedJson } from '../map/render.ts';
import type { MetricsVersion } from './archive.ts';
import type { MetricsModel } from './model.ts';

// The metrics page: one self-contained HTML file, static markup plus the model as JSON, which page.js draws.
// Nothing from the model is interpolated into markup; the page inserts every model string as text.

let assets: { css: string; js: string } | undefined;
const asset = (name: string) => readFileSync(new URL(name, import.meta.url), 'utf8');

const figure = (id: string, title: string, sub: string | undefined, body: string) =>
  `<figure class="card" id="${id}"><figcaption><h3>${title}</h3>${sub ? `<p class="sub">${sub}</p>` : ''}</figcaption>${body}</figure>`;
const chart = (legend: boolean) => `<div class="plot"></div>${legend ? '<div class="legend"></div>' : ''}<details class="tv"><summary>Show as a table</summary></details>`;

export function renderMetrics(model: MetricsModel): string {
  assets ??= { css: asset('./page.css'), js: asset('./page.js') };
  const zone = model.timeZone.replace(/_/g, ' ');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${esc(model.product)} Build Metrics</title>
<style>${assets.css}</style>
</head>
<body>
<main>
<header>
<div><h1>${esc(model.product)} build metrics</h1><p class="sub" id="stamp"></p></div>
${THEME}
</header>
<nav class="versions" id="versions" aria-label="Versions"></nav>
<div class="kpis" id="kpis"></div>

<section>
<h2>Progress</h2>
<p class="sub">Tasks done against tasks in the plan, and where both are heading if the recent pace holds.</p>
${figure('progress', 'Tasks done', 'Solid lines are what happened. Dashed lines continue the last 24 hours’ pace, merging and adding tasks alike; the band spans the slow and fast pace of recent six-hour windows.', chart(true))}
</section>

<section>
<h2>Subscriptions</h2>
<p class="sub">Each agent’s subscription allows so much use a week. The loop paces each agent so that its week lasts until the window resets, leaving some for the owner’s own use.</p>
${figure('allowance', 'Weekly window used', 'Solid lines are each window’s share used, as passes reported it. Dashed lines are the even pace to what the loop aims to have used by the reset: an agent ahead of its pace runs one pass at a time, or none until the pace catches up.', chart(true))}
</section>

<section>
<h2>Throughput</h2>
<div class="grid2">
${figure('throughput', 'Tasks merged per six hours', undefined, chart(false))}
${figure('mergerate', 'Share of passes that merged', 'Windows with at least three passes.', chart(false))}
</div>
</section>

<section>
<h2>Where the agents’ time goes</h2>
<p class="sub" id="time-total"></p>
<div class="stack">
${figure('time', 'Agent hours per six hours, by what each pass came to', 'A failure counts as “a test other tasks fail too” when the same test failed passes of two or more different tasks, which usually means a flaky test.', chart(true))}
${figure('agents', 'How each agent spent the time the loop ran', 'In slot-time: an agent running two passes at once for an hour has two hours.', chart(true))}
</div>
</section>

<section>
<h2>Cost</h2>
<div class="grid2">
${figure('cost', 'Cost per merged task', 'Every pass in the window, failed ones included, over the tasks it merged.', chart(true))}
${figure('tokens', 'Tokens per merged task', 'Fresh input and output; cached input is left out.', chart(true))}
</div>
</section>

<section>
<h2>What fails</h2>
<div class="grid2">
${figure('failsteps', 'Failed passes, by the step that stopped them', undefined, chart(false))}
${figure('recurring', 'Tests that failed passes of more than one task', 'Candidates for a fix to a flaky or shared test.', '<div id="recurring-table"></div>')}
</div>
</section>

<section>
<h2>New measurements</h2>
<p class="sub">Logged with every pass since the harness started recording them, to show whether its changes pay.</p>
<div class="grid2">
${figure('steptimes', 'Gate step times', 'Median time of each step of a pass’s own gate.', chart(false))}
<div class="stack">
${figure('carry', 'Starting from kept work', 'Passes that began from an earlier attempt’s work, against passes that began from main.', '<div class="facts" id="carry-facts"></div>')}
${figure('integration', 'The integration suite before finishing', 'How often agents ran it, and how often the gate still failed at that step.', '<div class="facts" id="integration-facts"></div>')}
</div>
</div>
</section>

<section>
<h2>Recent passes</h2>
${figure('recent', 'The last 40 passes', undefined, '<div id="recent-table"></div>')}
</section>
<footer>From runs/runs.jsonl, the plan and the plan’s git history, as they stood when this version was written. Windows are six hours long, in ${zone}.</footer>
</main>
<script type="application/json" id="data">${embedJson(model)}</script>
<script src="versions.js"></script>
<script>${assets.js}</script>
</body>
</html>
`;
}

const THEME =
  '<div class="theme" role="group" aria-label="Colour theme"><button type="button" data-mode="auto" aria-pressed="true">Auto</button><button type="button" data-mode="light" aria-pressed="false">Light</button><button type="button" data-mode="dark" aria-pressed="false">Dark</button></div>';
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

// The list of every version, newest first, with the numbers that show how the build has moved between them.
export function renderIndex(versions: MetricsVersion[], timeZone: string, every: number, product = 'The'): string {
  assets ??= { css: asset('./page.css'), js: asset('./page.js') };
  const when = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const finish = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric' });
  const pct = (x?: number) => (x == null ? '—' : `${Math.round(x * 100)}%`);
  const newest = [...versions].sort((a, b) => b.at - a.at);
  const rows = newest
    .map(
      (v) =>
        `<tr><td class="nw"><a href="${esc(encodeURI(v.file))}">${esc(when.format(v.at))}</a></td><td class="n">${v.passes}</td><td class="n">${v.done} of ${v.total}</td><td class="n">${v.rate24.toFixed(1)}</td><td class="n">${pct(v.mergeRate24)}</td><td class="n">${v.costPerTask24 == null ? '—' : `$${v.costPerTask24.toFixed(2)}`}</td><td class="nw">${v.finish == null ? 'not in sight' : esc(finish.format(v.finish))}</td></tr>`,
    )
    .join('');
  const latest = newest[0];
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${esc(product)} Build Metrics Versions</title>
<style>${assets.css}</style>
</head>
<body>
<main>
<header>
<div><h1>${esc(product)} build metrics</h1><p class="sub">Every version the loop has written, newest first; it writes one every ${every} passes and leaves each as it was.</p></div>
</header>
${latest ? `<p class="latest"><a href="${esc(encodeURI(latest.file))}">Open the latest version: ${esc(when.format(latest.at))}, after ${latest.passes} passes</a></p>` : '<p class="empty">No versions yet.</p>'}
<figure class="card">
<div class="tablewrap"><table>
<thead><tr><th scope="col">Version</th><th scope="col" class="n">Passes</th><th scope="col" class="n">Tasks done</th><th scope="col" class="n">Merged per hour</th><th scope="col" class="n">Passes that merged</th><th scope="col" class="n">Cost per task</th><th scope="col">Projected finish</th></tr></thead>
<tbody>${rows}</tbody>
</table></div>
</figure>
<footer>Merged per hour, passes that merged and cost per task are each version's last 24 hours.</footer>
</main>
</body>
</html>
`;
}

// Tasks in the plan over time, from the git history of plan/tasks: each task file's addition, less its
// removal. Empty outside a git checkout.
export function taskHistory(root: string): [number, number][] {
  let out: string;
  try {
    out = execFileSync('git', ['log', '--reverse', '--diff-filter=AD', '--name-status', '--format=@%ct', '--', 'plan/tasks/'], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return [];
  }
  const points: [number, number][] = [];
  let n = 0;
  let at = 0;
  for (const line of out.split('\n')) {
    if (line.startsWith('@')) {
      if (at) points.push([at, n]);
      at = Number(line.slice(1)) * 1000;
      continue;
    }
    const m = /^([AD])\s+plan\/tasks\/T-\d+\.yaml$/.exec(line);
    if (m) n += m[1] === 'A' ? 1 : -1;
  }
  if (at) points.push([at, n]);
  return points;
}
