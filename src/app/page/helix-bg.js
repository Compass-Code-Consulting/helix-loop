// The helixes behind every screen (spec §6.1): slow double helixes of points lit by depth, rungs between their
// strands, and a few drifting 0s, 1s and specks. Decoration only: one canvas behind the content, faded at its
// edges, no pointer events. Helixes come and go: one floats 15% of the time, two 45% of the time and three 40%
// of the time. Every minute to three the count is drawn again, and a helix arriving or leaving fades over eight
// seconds. Each turns about once every three minutes, drifts along its own random direction and bounces softly
// inside the frame; the canvas redraws at most 15 times a second. With reduced motion it draws one count once and
// stays still; it pauses while the tab is hidden.
(() => {
  'use strict';
  const cv = document.getElementById('helix-bg');
  if (!cv || !cv.getContext) return;
  const ctx = cv.getContext('2d');
  const query = new URLSearchParams(location.search);
  // Screenshots and tests hold it still with ?still, as reduced motion does, and pick how many with ?helixes=N.
  const still = query.has('still');
  const reduce = still || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  let rnd = Math.floor(Math.random() * 233280);
  const rand = () => ((rnd = (rnd * 9301 + 49297) % 233280) / 233280);
  const ZOOM = 2;
  const turns = 4.6;
  const N = 260;
  // Strand colours (front, back) and the colour of the bits around them. The first is Nocturne's violet, the
  // second a lighter violet, the third a much lighter #ee8266.
  const COLOURS = [
    { a: '181,171,252', b: '145,132,217', bit: '210,206,253' },
    { a: '214,208,253', b: '190,182,236', bit: '232,229,254' },
    { a: '249,212,202', b: '245,192,178', bit: '252,228,222' },
  ];
  const asked = Number(query.get('helixes'));
  const pinned = asked >= 1 && asked <= 3 ? Math.floor(asked) : 0;
  const pick = () => {
    const r = rand();
    return pinned || (r < 0.15 ? 1 : r < 0.6 ? 2 : 3);
  };
  const FADE = 8;
  // The first always sits right of centre; the others start elsewhere along the width, leaning their own way, and
  // start somewhere new each time they come back.
  const place = (hx, n) => Object.assign(hx, {
    seed: rand() * 10,
    x: n === 0 ? 0.72 : 0.2 + rand() * 0.6,
    y: n === 0 ? 0.5 : 0.3 + rand() * 0.4,
    dir: rand() * 6.283,
    sp: 9 + rand() * 6,
    spin: 0.03 + rand() * 0.01,
    tilt: n === 0 ? -0.35 : -0.35 + (rand() - 0.5) * 1.6,
    bits: Array.from({ length: 50 }, () => ({ s: rand(), o: rand() * 6.28, sp: 0.02 + rand() * 0.05, k: rand() < 0.5 ? 0 : 1, ch: rand() < 0.5 ? '0' : '1', sz: rand() })),
  });
  const helixes = COLOURS.map((c, n) => place({ ...c, on: false, vis: 0 }, n));
  let next = 0;
  function recount(t) {
    const count = pick();
    cv.dataset.helixes = String(count);
    helixes.forEach((hx, n) => {
      if (n < count && !hx.on && hx.vis === 0) place(hx, n);
      hx.on = n < count;
    });
    next = t + 60 + rand() * 120;
  }
  recount(0);
  // The first count shows at once rather than fading in.
  for (const hx of helixes) hx.vis = hx.on ? 1 : 0;
  const tri = (v) => {
    const m = ((v % 4) + 4) % 4;
    return m < 2 ? m - 1 : 3 - m;
  };
  let W = 0;
  let H = 0;
  let scale = 1;
  function size() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = window.innerWidth;
    H = window.innerHeight;
    cv.width = Math.round(W * dpr);
    cv.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    scale = Math.max(0.6, Math.min(1.2, Math.hypot(W, H) / 1700)) * ZOOM;
  }
  size();
  window.addEventListener('resize', () => {
    size();
    if (reduce) draw(performance.now());
  });

  function drawHelix(hx, t) {
    const len = Math.max(W, H) * 1.05 * scale;
    const A = 120 * scale;
    const dot = Math.sqrt(scale / ZOOM) * ZOOM;
    const roam = Math.min(W, H) * 0.3;
    const ph = t * hx.spin + hx.seed;
    const k = (t * hx.sp) / Math.max(1, roam);
    const cx = W * hx.x + tri(k * Math.cos(hx.dir) + hx.seed) * roam;
    const cy = H * hx.y + tri(k * Math.sin(hx.dir) + hx.seed * 0.7) * roam * 0.7;
    const tl = hx.tilt + Math.sin(t * 0.008 + hx.seed) * 0.25;
    const cos = Math.cos(tl);
    const sin = Math.sin(tl);
    const P = (u, p) => {
      const along = (u - 0.5) * len;
      const a = u * turns * 6.283 + p;
      const off = Math.sin(a) * A;
      return [cx + along * sin + off * cos, cy + along * cos - off * sin, Math.cos(a)];
    };
    for (let i = 0; i < N; i++) {
      const u = i / (N - 1);
      const a = P(u, ph);
      const b = P(u, ph + Math.PI);
      const edge = Math.max(0, Math.sin(u * Math.PI));
      if (i % 3 === 0) {
        const g = ctx.createLinearGradient(a[0], a[1], b[0], b[1]);
        g.addColorStop(0, `rgba(${hx.b},${((0.16 + (0.3 * (a[2] + 1)) / 2) * edge).toFixed(3)})`);
        g.addColorStop(1, `rgba(${hx.a},${((0.16 + (0.3 * (b[2] + 1)) / 2) * edge).toFixed(3)})`);
        ctx.strokeStyle = g;
        ctx.lineWidth = ZOOM;
        ctx.beginPath();
        ctx.moveTo(a[0], a[1]);
        ctx.lineTo(b[0], b[1]);
        ctx.stroke();
      }
      for (const [p, c] of [[a, hx.a], [b, hx.b]]) {
        const d = (p[2] + 1) / 2;
        ctx.fillStyle = `rgba(${c},${((0.2 + 0.8 * d) * edge).toFixed(3)})`;
        ctx.beginPath();
        ctx.arc(p[0], p[1], (1 + 2.6 * d) * dot, 0, 6.283);
        ctx.fill();
      }
    }
    ctx.font = `${10 * ZOOM}px "JetBrains Mono", monospace`;
    for (const bt of hx.bits) {
      const u = (bt.s + t * bt.sp * 0.02) % 1;
      const p = P(u, ph + (bt.k ? Math.PI : 0));
      const drift = (Math.sin(t * 0.12 + bt.o) * 18 + 16) * dot;
      const edge = Math.max(0, Math.sin(u * Math.PI));
      ctx.fillStyle = `rgba(${hx.bit},${((0.08 + (0.3 * (p[2] + 1)) / 2) * edge).toFixed(3)})`;
      if (bt.sz < 0.6) ctx.fillText(bt.ch, p[0] + drift * cos, p[1] - drift * sin);
      else ctx.fillRect(p[0] + drift * cos, p[1] - drift * sin, 2 * ZOOM, 2 * ZOOM);
    }
  }

  let raf = 0;
  let last = 0;
  const t0 = performance.now();
  function draw(now) {
    raf = 0;
    if (!reduce && now - last < 66) return schedule();
    const dt = last ? Math.min(1, (now - last) / 1000) : 0;
    last = now;
    const t = still ? 40 : reduce ? 0 : (now - t0) / 1000;
    if (!reduce && t >= next) recount(t);
    ctx.clearRect(0, 0, W, H);
    // The lightest last, so it floats in front.
    for (const hx of helixes) {
      hx.vis = Math.max(0, Math.min(1, hx.vis + (hx.on ? dt : -dt) / FADE));
      if (!hx.vis) continue;
      ctx.globalAlpha = hx.vis;
      drawHelix(hx, t);
    }
    ctx.globalAlpha = 1;
    if (!reduce) schedule();
  }
  const schedule = () => {
    if (!raf && !document.hidden) raf = requestAnimationFrame(draw);
  };
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && !reduce) schedule();
  });
  raf = requestAnimationFrame(draw);
})();
