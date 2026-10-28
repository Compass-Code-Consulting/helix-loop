// Draws the README's banner: a shaded double helix in characters beside a card of what Helix Loop is, as an SVG,
// since a README can only colour text through an image. One file follows the reader's light or dark theme by itself,
// so a plain Markdown image shows it everywhere (GitHub, npm, an editor's preview).
// Run `node scripts/banner.ts` after changing the card or the art; it writes docs/assets/banner.svg.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CARD: Array<[string, string] | string> = [
  'helix@loop',
  '',
  ['Builds', 'a product from its spec, while you steer'],
  ['Agents', 'Claude Code and Codex, in parallel'],
  ['Plan.Scope', 'Lane › Epic › Feature › Story › Task'],
  ['Plan.Order', 'Helix Milestones, earliest first'],
  ['Pass', 'one task, one agent, one git worktree'],
  ['Gate', "the repository's full check, before every merge"],
  ['Pacing', 'every subscription lasts the week'],
  ['Pilot', 'Cautious · Prudent · Intrepid · YOLO'],
  ['Steer', 'the app, or the helix-loop CLI'],
  ['Runtime', 'Node 26 and git'],
  '',
  'Get started',
  '',
  ['Install', './scripts/install.sh'],
  ['Plan', '/helix spec › /helix taskset › /helix milestones'],
  ['Check', 'helix-loop doctor'],
  ['Run', 'helix-loop run'],
];

type Theme = { bg: string; border: string; strands: [string, string]; rungs: string; title: string; rule: string; key: string; value: string; light: boolean };
const THEMES: Record<'dark' | 'light', Theme> = {
  dark: { bg: '#0d1117', border: '#30363d', strands: ['#79c0ff', '#d2a8ff'], rungs: '#8b949e', title: '#e6edf3', rule: '#6e7681', key: '#ffa657', value: '#a5d6ff', light: false },
  light: { bg: '#ffffff', border: '#d0d7de', strands: ['#0969da', '#8250df'], rungs: '#6e7781', title: '#1f2328', rule: '#8c959f', key: '#953800', value: '#0a3069', light: true },
};

// From faint to dense: on a dark background a denser character reads brighter.
const RAMP = ' .`-:/+osyhdmN';
const COLS = 40, ROWS = 34, TURNS = 1.35, TILT = 0.3;

type Cell = { ch: string; part: number }; // part: 0 and 1 are the strands, 2 the base pairs, -1 nothing
type V = [number, number, number];

// A z-buffered splat of the two strands (tubes) and their base pairs, seen from slightly above, lit from the top left.
// Each character averages a 4×8 block of samples, since a character is about twice as tall as it is wide.
function helix(light: boolean): Cell[][] {
  const SS = 4, W = COLS * SS, H = ROWS * SS * 2;
  const depth = new Float64Array(W * H).fill(-Infinity), shade = new Float64Array(W * H), part = new Int8Array(W * H).fill(-1);
  const R = 1, tube = 0.2, rung = 0.07, length = 2 * Math.PI * TURNS;
  const scale = (W * 0.96) / (2 * (R + tube)), pitch = (H * 0.97) / scale / length; // fill the width; stretch the turns to the height
  const lamp = norm([-0.45, -0.55, 0.7]), half = norm([lamp[0], lamp[1], lamp[2] + 1]);
  const [ct, st] = [Math.cos(TILT), Math.sin(TILT)];
  const view = (p: V): V => [p[0], p[1] * ct - p[2] * st, p[1] * st + p[2] * ct];
  const splat = (p: V, n: V, who: number) => {
    const q = view(p), m = view(n), x = Math.round(W / 2 + q[0] * scale), y = Math.round(H / 2 + q[1] * scale);
    if (x < 0 || x >= W || y < 0 || y >= H || q[2] <= depth[y * W + x]!) return;
    const lit = (0.3 + 0.7 * Math.max(0, dot(m, lamp))) * (0.55 + 0.45 * (q[2] + R) / (2 * R)) + 0.5 * Math.max(0, dot(m, half)) ** 24;
    depth[y * W + x] = q[2]; shade[y * W + x] = Math.min(1, lit); part[y * W + x] = who;
  };
  const strand = (t: number, phase: number): V => [R * Math.cos(t + phase), (t - length / 2) * pitch, R * Math.sin(t + phase)];
  const ring = (centre: V, along: V, radius: number, step: number, who: number) => {
    const a = norm(cross(along, [0, 1, 0])), b = cross(along, a);
    for (let f = 0; f < 2 * Math.PI; f += step) {
      const n = add(scale3(a, Math.cos(f)), scale3(b, Math.sin(f)));
      splat(add(centre, scale3(n, radius)), n, who);
    }
  };
  for (const [who, phase] of [[0, 0], [1, Math.PI]] as const) {
    for (let t = 0; t <= length; t += 0.004) ring(strand(t, phase), norm(sub(strand(t + 1e-3, phase), strand(t, phase))), tube, 0.05, who);
  }
  const pairs = Math.round(TURNS * 10);
  for (let i = 0; i <= pairs; i++) {
    const t = (i + 0.5) * length / (pairs + 1), a = strand(t, 0), b = strand(t, Math.PI), along = norm(sub(b, a)), span = Math.hypot(...sub(b, a));
    for (let s = tube; s <= span - tube; s += 0.01) if (Math.abs(s - span / 2) >= 0.04) ring(add(a, scale3(along, s)), along, rung, 0.2, 2);
  }
  const art: Cell[][] = [];
  for (let r = 0; r < ROWS; r++) {
    const line: Cell[] = [];
    for (let c = 0; c < COLS; c++) {
      let sum = 0, covered = 0;
      const votes = [0, 0, 0];
      for (let y = r * SS * 2; y < (r + 1) * SS * 2; y++) for (let x = c * SS; x < (c + 1) * SS; x++) {
        const who = part[y * W + x]!;
        if (who < 0) continue;
        covered++; sum += shade[y * W + x]!; votes[who]!++;
      }
      const coverage = covered / (SS * SS * 2);
      if (coverage < 0.08) { line.push({ ch: ' ', part: -1 }); continue; }
      const lit = sum / covered, v = light ? coverage * (1 - 0.8 * lit) + 0.15 : coverage ** 0.6 * lit;
      line.push({ ch: RAMP[Math.max(1, Math.min(RAMP.length - 1, Math.round(v * (RAMP.length - 1))))]!, part: votes.indexOf(Math.max(...votes)) });
    }
    art.push(line);
  }
  return art;
}

function svg(): string {
  const font = 14, cw = font * 0.6, lh = Math.round(cw * 2), pad = 28; // the art assumes a cell twice as tall as wide
  const cardX = pad + COLS * cw + 4 * cw;
  const keyWidth = Math.max(...CARD.filter(l => typeof l !== 'string').map(l => l[0].length)) + 2;
  const cardTop = pad + Math.max(0, (ROWS - CARD.length) / 2) * lh;
  const longest = Math.max(...CARD.filter(l => typeof l !== 'string').map(l => l[1].length + 2));
  const width = Math.ceil(cardX + (keyWidth + longest) * cw + pad), height = Math.ceil(pad * 2 + ROWS * lh - (lh - font));
  // The art differs by theme (shading reverses on a light background), so both are drawn and the theme shows one.
  const art = (name: 'dark' | 'light') => helix(THEMES[name].light).map((row, r) => {
    const runs: string[] = [];
    let i = 0;
    while (i < row.length) {
      let j = i;
      while (j < row.length && (row[j]!.part === row[i]!.part || row[j]!.ch === ' ')) j++;
      const text = esc(row.slice(i, j).map(c => c.ch).join(''));
      runs.push(row[i]!.part < 0 ? text : `<tspan class="p${row[i]!.part}">${text}</tspan>`);
      i = j;
    }
    return `<text x="${pad}" y="${pad + font + r * lh}">${runs.join('')}</text>`;
  });
  const card: string[] = [];
  let rule = false;
  CARD.forEach((l, i) => {
    const y = cardTop + font + i * lh;
    if (l === '') {
      if (rule) card.push(`<text class="rule" x="${cardX}" y="${y}">${'─'.repeat(14)}</text>`);
      rule = false;
      return;
    }
    if (typeof l === 'string') { card.push(`<text class="title" x="${cardX}" y="${y}">${esc(l)}</text>`); rule = true; return; }
    card.push(`<text x="${cardX}" y="${y}"><tspan class="key">${esc(l[0])}:</tspan><tspan class="value" x="${cardX + keyWidth * cw}">"${esc(l[1])}"</tspan></text>`);
  });
  const colours = (t: Theme) => `.bg{fill:${t.bg};stroke:${t.border}} g{fill:${t.rungs}} .p0{fill:${t.strands[0]}} .p1{fill:${t.strands[1]}} .p2{fill:${t.rungs}} ` +
    `.title{fill:${t.title};font-weight:600} .rule{fill:${t.rule}} .key{fill:${t.key}} .value{fill:${t.value}}`;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="Helix Loop: a double helix beside what Helix Loop does">`,
    '<style>',
    `${colours(THEMES.light)} .dark{display:none}`,
    `@media (prefers-color-scheme: dark) { ${colours(THEMES.dark)} .light{display:none} .dark{display:inline} }`,
    '</style>',
    `<rect class="bg" x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" rx="12"/>`,
    `<g font-family="ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace" font-size="${font}" xml:space="preserve">`,
    '<g class="light">', ...art('light'), '</g>',
    '<g class="dark">', ...art('dark'), '</g>',
    ...card,
    '</g>',
    '</svg>',
    '',
  ].join('\n');
}

// Non-breaking spaces: an SVG collapses runs of ordinary spaces, which would shift every line of the art.
const esc = (s: string) => s.replace(/ /g, '\u00a0').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const dot = (a: V, b: V) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const add = (a: V, b: V): V => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: V, b: V): V => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale3 = (a: V, k: number): V => [a[0] * k, a[1] * k, a[2] * k];
const cross = (a: V, b: V): V => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: V): V => scale3(a, 1 / (Math.hypot(...a) || 1));

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'assets');
mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'banner.svg'), svg());
console.log(`wrote ${join(out, 'banner.svg')}`);
