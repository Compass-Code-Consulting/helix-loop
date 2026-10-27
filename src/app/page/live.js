// Live (spec §6.5): what every running builder is doing, as it does it. Focus shows one pass in full beside a
// strip of all of them; Grid shows every pass as a tile. A pass's feed streams from its log over its own event
// stream; items are keyed by their place in the log, so an item redraws in place and an opened command stays
// open. The feed follows the newest item; scrolling up pauses it, and new items collect behind a button.
(() => {
  'use strict';
  const { h, fill, F, S } = HX;
  const L = { el: null, sel: null, replay: null, es: null, feed: null, keys: new Map(), unseen: 0, today: [], tiles: new Map() };

  HX.views.live = {
    mount(el, parts) {
      L.el = el;
      L.layout = HX.store.get('liveLayout') === 'grid' ? 'grid' : 'focus';
      take(parts);
      build();
      render();
      loadToday();
    },
    route(parts) {
      take(parts);
      render();
    },
    async update(what) {
      render();
      if (what.has('ledger') || what.has('all')) loadToday();
      if (L.layout === 'grid' && (what.has('logs') || what.has('all'))) loadTiles();
    },
    back() {
      if (L.replay) {
        HX.go('#live');
        return true;
      }
      return false;
    },
    unmount() {
      close();
    },
  };

  function take(parts) {
    if (parts[0] === 'replay' && parts[1]) {
      L.replay = parts[1];
      L.sel = null;
    } else {
      L.replay = null;
      L.sel = parts[0] ?? L.sel;
    }
  }

  let B;
  function build() {
    B = { tiles: h('div', { class: 'tiles' }), seg: h('div'), body: h('div', { style: { display: 'contents' } }) };
    fill(L.el, h('section', { class: 'live' }, h('div', { class: 'livetop' }, B.tiles, B.seg), B.body));
  }

  function passes() {
    return S.state?.live ?? [];
  }

  // The passes in flight, and a tile for each free or held slot.
  function renderTiles() {
    const ps = passes();
    const s = S.state;
    if (!s) return;
    const free = s.agents.filter((a) => a.enabled).flatMap((a) => {
      const used = ps.filter((p) => p.agent === a.name).length;
      const allowed = a.paced ?? a.slots;
      return Array.from({ length: Math.max(0, a.slots - used) }, (_, i) => ({ a, n: used + i + 1, held: used + i >= allowed || a.state === 'limited' }));
    });
    fill(B.tiles,
      ps.map((p) => h('button', { type: 'button', class: `tile${p.id === current()?.id && !L.replay ? ' sel' : ''}`, 'data-jk': '', onclick: () => HX.go(`#live/${encodeURIComponent(p.id)}`) },
        h('div', { class: 'row' }, HX.badge(p.agent), h('b', { style: { fontWeight: 500 } }, HX.AGENT[p.agent]), h('span', { class: 'mono small muted' }, p.task), h('span', { class: 'grow' }), h('span', { class: 'mono small muted' }, HX.ticker(p.startedAt, 'clock'))),
        h('div', { class: 'ell' }, p.title ?? ''),
        h('div', { class: 'ln' }, p.phase === 'gate' ? `◆ gating${p.progress ? ` · ${p.progress}` : ''}` : p.progress ? `▸ ${p.progress}` : p.lastCommand ? `$ ${p.lastCommand}` : p.lastMessage ?? HX.PHASE[p.phase]))),
      free.map(({ a, n, held }) => h('div', { class: 'tile idle' },
        h('div', { class: 'row' }, HX.badge(a.name), h('b', { style: { fontWeight: 500 } }, HX.AGENT[a.name]), h('span', { class: 'mono small muted' }, `slot ${n}`)),
        h('div', null, held ? 'Held' : 'Free'),
        h('div', { class: 'ln' }, a.state === 'limited' ? `At its usage limit${a.resetAt ? ` until ${F.time(a.resetAt)}` : ''}` : held ? 'Held by its weekly pace' : s.loop.running ? (s.paused ? 'Paused: no new pass starts' : 'Waiting for a ready task') : 'The loop is stopped'))));
  }

  const current = () => {
    const ps = passes();
    return ps.find((p) => p.id === L.sel) ?? (L.sel ? null : ps[0]);
  };

  function render() {
    if (!B || !S.state) return;
    renderTiles();
    const head = null;
    fill(B.seg, HX.seg([['focus', 'Focus'], ['grid', 'Grid of all passes']], L.layout, (v) => {
        L.layout = v;
        HX.store.set('liveLayout', v);
        B.body.replaceChildren();
        render();
        if (v === 'grid') loadTiles();
      }));
    if (L.layout === 'grid' && !L.replay) {
      close();
      if (!B.grid) B.grid = h('div', { class: 'gridlive' });
      if (!B.body.contains(B.grid)) fill(B.body, B.grid);
      return renderGrid();
    }
    B.grid = null;
    const p = L.replay ? null : current();
    const key = L.replay ? `replay:${L.replay}` : p ? `pass:${p.log ?? p.id}` : 'none';
    if (B.key !== key) {
      B.key = key;
      close();
      buildFocus(head);
      if (L.replay) loadReplay(L.replay);
      else if (p?.log) open(p.log);
    }
    renderFocus(p);
  }

  // ---- Focus ----
  let FX;
  function buildFocus(head) {
    FX = {
      head: h('div', { class: 'stack', style: { gap: '4px' } }),
      acts: h('div', { class: 'row wrap' }),
      feedhead: h('div', { class: 'feedhead' }),
      feed: h('div', { class: 'feed', 'aria-live': 'off' }),
      jump: h('button', { type: 'button', class: 'btn btn-primary sm jump', hidden: true, onclick: () => { FX.feed.scrollTop = FX.feed.scrollHeight; } }),
      gate: h('div', { class: 'gatebar' }),
      right: h('aside', { class: 'right' }),
    };
    FX.feed.addEventListener('scroll', () => {
      if (atBottom(FX.feed)) {
        FX.jump.hidden = true;
        L.unseen = 0;
      }
    });
    L.keys.clear();
    L.feed = null;
    fill(B.body, h('div', { class: 'focus' },
      h('div', { class: 'left' }, h('div', { class: 'row top' }, h('div', { class: 'grow' }, FX.head), FX.acts), h('div', { class: 'feedwrap' }, FX.feedhead, FX.feed, FX.jump), FX.gate),
      FX.right));
  }
  const atBottom = (el) => el.scrollHeight - el.scrollTop - el.clientHeight < 40;

  function renderFocus(p) {
    if (!FX) return;
    const f = L.feed;
    const ended = L.replay ? L.today.find((t) => t.log.replace(/\.gz$/, '') === L.replay.replace(/\.gz$/, '')) : null;
    if (!p && !L.replay) {
      fill(FX.head, h('h3', null, S.state.loop.running ? 'No pass is running right now' : 'The loop is stopped'), h('div', { class: 'muted' }, 'Pick a pass that ended today to replay it.'));
      fill(FX.acts);
      fill(FX.feedhead, 'No feed');
      fill(FX.feed, h('div', { class: 'empty', style: { padding: '12px' } }, S.state.loop.running ? 'The next pass shows here as soon as it starts.' : 'Start the loop from Settings › Loop controls.'));
      fill(FX.gate);
      renderRight(null, null);
      return;
    }
    const task = p?.task ?? /([A-Z]+-\d+)-(claude|codex)-(\d+)\.log/.exec(L.replay)?.[1];
    const agent = p?.agent ?? /-(claude|codex)-\d+\.log/.exec(L.replay)?.[1];
    const attempt = p?.attempt ?? Number(/-(\d+)\.log/.exec(L.replay)?.[1]);
    const sum = f?.summary;
    const model = ended?.model ?? S.state.agents.find((a) => a.name === agent)?.model;
    fill(FX.head,
      h('div', { class: 'row wrap' },
        p ? HX.tag([h('span', { class: 'circle prog', style: { width: '10px', height: '10px' } }), ` ${p.phase === 'gate' ? 'Gating' : p.phase === 'setup' ? 'Setting up' : 'Building'} · attempt ${attempt}`], 'tag-accent') : HX.tag(`Replay · attempt ${attempt}${ended ? ` · ${ended.outcome.replace(/_/g, ' ')}` : ''}`, ended?.outcome === 'merged' ? 'tag-ok' : 'tag-neutral'),
        h('span', { class: 'mono small muted' }, [task, p?.repo ? HX.laneShort(p.repo) : null].filter(Boolean).join(' · '))),
      h('h3', { class: 'ell', title: p?.title ?? ended?.title ?? '' }, h('a', { href: `#map/${task}`, style: { color: 'inherit' } }, p?.title ?? ended?.title ?? task)),
      h('div', { class: 'soft' }, [HX.AGENT[agent], model, p ? HX.ticker(p.startedAt) : ended ? F.dur(ended.durationMs) : null, sum ? F.plural(sum.toolCalls, 'tool call') : null, sum ? F.plural(sum.commands, 'command') : null, sum ? `${F.plural(sum.files, 'file')} changed` : null, sum?.failed ? `${sum.failed} failed` : null].filter(Boolean).flatMap((x, i) => (i ? [' · ', x] : [x]))));
    fill(FX.acts, p ? [
      HX.btn('Note for next attempt', HX.act(async () => {
        const note = await HX.prompt(`Note for ${task}'s next attempt`, 'It goes into the task’s notes, for whichever builder picks it up next.', 'Add note');
        if (!note) return;
        const r = await HX.post('/api/note-next', { task, note });
        HX.toast(r.pending ? 'Noted: it goes into the task’s notes when this pass ends.' : 'Noted.');
      })),
      HX.btn('Send to Helix', HX.act(() => HX.askHelix([task], `${task} attempt ${attempt}, live`))),
      HX.btn('Stop pass', HX.act(async () => {
        const ta = h('textarea', { class: 'input', rows: 3, placeholder: 'Note for the next attempt (optional)' });
        const to = h('select', { class: 'input' }, h('option', { value: 'ready' }, 'back to ready, for the next attempt'), h('option', { value: 'needs_human' }, 'to you: it needs a person'));
        const ok = await HX.dialog(`Stop ${task}'s pass?`, [h('p', null, `${HX.AGENT[agent]} stops now. Its work so far is kept on its branch, and the next attempt starts from it. A stopped attempt doesn't count toward the task's cap.`), h('label', { class: 'stack small muted', style: { gap: '4px' } }, 'The task goes', to), ta], [{ label: 'Cancel', value: 'cancel' }, { label: 'Stop the pass', value: 'ok', class: 'btn-danger' }]);
        if (ok !== 'ok') return;
        await HX.post('/api/pass/stop', { task, to: to.value, note: ta.value });
        HX.toast(`Stopping ${task}'s pass…`);
      }), 'btn-danger'),
    ] : [HX.btn('Open on the Map', () => HX.go(`#map/${task}`))]);
    fill(FX.feedhead,
      f && !f.finished ? [h('span', { class: 'dot on' }), ' Streaming · last event ', HX.ticker(f.updatedAt), ' ago'] : f ? 'This pass has ended' : 'Reading its log…',
      h('span', { class: 'grow' }),
      f?.earlier ? h('span', { class: 'muted' }, `${F.n(f.earlier)} earlier`) : null,
      h('button', { type: 'button', class: 'link', onclick: () => HX.showLog(p?.log ?? L.replay) }, 'Full log'));
    renderFeed();
    const gate = f?.items.findLast((i) => i.kind === 'gate');
    fill(FX.gate, h('span', null, gate ? `Gate · ${gate.state === 'failed' ? 'failed' : gate.steps.some((x) => x.state === 'running') ? 'running' : 'passed'}` : 'Gate · not started'),
      (gate?.steps ?? []).map((x) => h('span', { class: `gs ${x.state}`, title: x.ms != null ? F.dur(x.ms) : '' }, x.step)));
    renderRight(p, f);
  }

  function renderRight(p, f) {
    const plan = f?.items.findLast((i) => i.kind === 'plan');
    const lines = plan?.detail?.split('\n') ?? [];
    const done = lines.filter((l) => l.startsWith('✓')).length;
    const reports = f?.items.filter((i) => i.kind === 'report') ?? [];
    fill(FX.right,
      h('div', { class: 'stack' }, h('h6', { class: 'cap' }, plan ? `Its plan · ${done} of ${lines.length} done` : 'Its plan'),
        plan ? h('div', { class: 'planlist' }, lines.map((l) => {
          const s = l[0] === '✓' ? 'done' : l[0] === '▸' ? 'now' : 'todo';
          return h('div', null, h('span', { class: `g ${s === 'done' ? 't-ok' : s === 'now' ? 't-acc' : 'dim'}` }, s === 'done' ? '✓' : s === 'now' ? '◐' : '○'), h('span', { class: s === 'done' ? 'muted' : s === 'now' ? '' : 'dim' }, l.slice(2)));
        })) : h('div', { class: 'muted' }, 'No to-do list yet.')),
      h('div', { class: 'stack' }, h('h6', { class: 'cap' }, 'Reported to the loop'),
        reports.length ? reports.slice(-6).map((r) => h('div', { class: 't-acc' }, `▸ ${r.text}`)) : h('div', { class: 'muted' }, p?.progress ? `▸ ${p.progress}` : 'Nothing reported yet.')),
      p ? h('div', { class: 'stack' }, h('h6', { class: 'cap' }, 'Helix is watching'),
        p.helix ? h('div', { class: 'watching' }, p.helix) : h('div', { class: 'muted' }, !S.state.helix.monitor.enabled ? 'Helix’s monitor is off.' : S.state.helix.monitor.level === 'light' ? 'On Light, Helix doesn’t read running passes.' : 'No read on this pass yet.')) : null,
      h('p', { class: 'small muted', style: { margin: 0 } }, 'The view follows the newest step. Scroll up to pause it; new steps then collect behind a button.'),
      h('div', { class: 'stack' }, h('h6', { class: 'cap' }, 'Ended today'),
        L.today.length ? L.today.slice(0, 12).map((t) => h('a', { class: 'row small', href: `#live/replay/${encodeURIComponent(t.log)}`, style: { color: 'inherit' } }, HX.badge(t.agent), h('span', { class: 'mono muted' }, t.task), h('span', { class: t.outcome === 'merged' ? 't-ok' : ['quota', 'transient', 'suspended', 'stopped'].includes(t.outcome) ? 'muted' : 't-crit' }, t.outcome.replace(/_/g, ' ')), h('span', { class: 'grow' }), h('span', { class: 'muted' }, F.time(t.at))))
          : h('div', { class: 'muted' }, 'No pass has ended today.')));
  }

  // ---- the feed ----
  const ICON = { message: '', thinking: '∴', command: '$', edit: '✎', look: '⌕', read: '⌕', search: '⌕', plan: '☰', report: '▸', issue: '!', tool: '⚙', gate: '◆', output: '…', done: '✓', error: '✗' };
  function renderFeed() {
    const f = L.feed;
    if (!FX) return;
    if (!f) {
      if (!FX.feed.childElementCount) fill(FX.feed, h('div', { class: 'empty', style: { padding: '12px' } }, 'Reading its log…'));
      return;
    }
    const stick = atBottom(FX.feed) || !L.keys.size;
    const first = !L.keys.size;
    if (first) FX.feed.replaceChildren(h('div', { class: 'spacer' }));
    const want = [FX.feed.firstElementChild?.classList.contains('spacer') ? FX.feed.firstElementChild : h('div', { class: 'spacer' })];
    let added = 0;
    for (const it of f.items) {
      let rec = L.keys.get(it.key);
      if (!rec || rec.v !== it.v) {
        const el = feedItem(it, rec?.el, it === f.items.at(-1) && !f.finished);
        if (!rec) added++;
        rec = { el, v: it.v };
        L.keys.set(it.key, rec);
      }
      want.push(rec.el);
    }
    if (!f.items.length) want.push(h('div', { class: 'empty', style: { padding: '12px' } }, 'Nothing in its log yet.'));
    // Times only for what was written while the app watched: a log read whole has none.
    FX.feed.classList.toggle('timed', f.items.some((i) => i.at));
    const keep = new Set(want);
    for (const [k, rec] of L.keys) if (!keep.has(rec.el)) { rec.el.remove(); L.keys.delete(k); }
    want.forEach((el, i) => { if (FX.feed.children[i] !== el) FX.feed.insertBefore(el, FX.feed.children[i] ?? null); });
    while (FX.feed.children.length > want.length) FX.feed.lastElementChild.remove();
    if (stick) FX.feed.scrollTop = FX.feed.scrollHeight;
    else if (added && !first) {
      L.unseen += added;
      FX.jump.textContent = `${F.plural(L.unseen, 'new step')} ↓`;
      FX.jump.hidden = false;
    }
  }

  // One feed item, redrawn in place when it changes, with whatever was opened kept open.
  function feedItem(it, old, last) {
    const wasOpen = old?.querySelector('details')?.open ?? false;
    const kind = it.kind === 'read' || it.kind === 'search' ? 'look' : it.kind;
    const state = it.state === 'running' ? h('span', { class: 'st run' }, 'running') : it.state === 'failed' ? h('span', { class: 'st failed' }, 'failed') : it.kind === 'command' && it.state === 'ok' ? h('span', { class: 'st ok' }, 'ok') : it.kind === 'edit' && it.detail ? h('span', { class: 'st' }, '') : h('span');
    let body;
    if (kind === 'gate') {
      body = h('div', { class: 'tx' }, h('details', { open: wasOpen || undefined }, h('summary', null, it.text), h('div', { class: 'gatebar', style: { marginTop: '4px' } }, (it.steps ?? []).map((s) => h('span', { class: `gs ${s.state}` }, `${s.step}${s.ms != null ? ` ${F.dur(s.ms)}` : ''}`))), it.detail ? h('pre', null, it.detail) : null));
    } else if (it.detail && kind !== 'message' && kind !== 'thinking') {
      body = h('div', { class: 'tx' }, h('details', { open: wasOpen || undefined }, h('summary', null, it.text.split('\n')[0]), h('pre', null, [it.text.includes('\n') ? it.text : null, it.detail].filter(Boolean).join('\n\n'))), it.note ? h('div', { class: 'sub' }, it.note) : null);
    } else {
      body = h('div', { class: 'tx' }, it.text, last && kind === 'output' ? h('span', { class: 'cursor' }) : null, it.note ? h('div', { class: 'sub' }, it.note) : null);
    }
    const el = h('div', { class: `fi k-${kind} ${it.state === 'failed' ? 'failed' : ''}` }, h('span', { class: 'tm' }, it.at ? F.clock(it.at) : ''), h('span', { class: 'g' }, ICON[it.kind] ?? '·'), body, state);
    if (old) old.replaceWith(el);
    return el;
  }

  function open(log) {
    close();
    L.es = new EventSource(`/events?root=${S.root}&pass=${encodeURIComponent(log)}`);
    L.es.addEventListener('feed', (ev) => {
      L.feed = JSON.parse(ev.data);
      renderFocus(current());
    });
  }
  function close() {
    L.es?.close();
    L.es = null;
  }
  async function loadReplay(log) {
    try {
      L.feed = await HX.api('/api/feed', { path: log });
    } catch (e) {
      L.feed = null;
      fill(FX.feed, h('div', { class: 'empty t-crit', style: { padding: '12px' } }, e.message));
      return;
    }
    renderFocus(null);
  }
  async function loadToday() {
    const both = await Promise.all(['claude', 'codex'].map((a) => HX.api('/api/agent', { name: a }).then((d) => d.today.map((t) => ({ ...t, agent: a }))).catch(() => [])));
    L.today = both.flat().sort((a, b) => b.at.localeCompare(a.at));
    if (L.layout === 'focus' && FX) renderFocus(L.replay ? null : current());
  }

  // ---- Grid ----
  function renderGrid() {
    const ps = passes();
    if (!ps.length) return fill(B.grid, h('div', { class: 'glass pad muted' }, S.state.loop.running ? 'No pass is running right now.' : 'The loop is stopped.'));
    fill(B.grid, ps.map((p) => {
      const f = L.tiles.get(p.id);
      return h('div', { class: 'glass card', 'data-jk': '', tabindex: '0', onkeydown: (e) => e.key === 'Enter' && focusPass(p) },
        h('div', { class: 'row' }, HX.badge(p.agent), h('b', { class: 'mono', style: { fontWeight: 500 } }, p.task), h('span', { class: 'muted ell grow' }, p.title), h('span', { class: 'mono small muted' }, HX.ticker(p.startedAt, 'clock'))),
        h('div', { class: 'small soft' }, HX.phaseLine(p), p.helix ? ` · Helix: ${p.helix}` : ''),
        h('div', { style: { marginTop: '6px' } }, (f?.items ?? []).slice(-6).map((it) => feedItem(it, null, false))),
        h('div', { class: 'row', style: { marginTop: '6px' } }, h('span', { class: 'grow' }), HX.btn('Focus', () => focusPass(p), 'btn-ghost sm')));
    }));
  }
  function focusPass(p) {
    L.layout = 'focus';
    HX.store.set('liveLayout', 'focus');
    B.key = null;
    B.body.replaceChildren();
    HX.go(`#live/${encodeURIComponent(p.id)}`);
  }
  async function loadTiles() {
    await Promise.all(passes().map(async (p) => {
      if (!p.log) return;
      try {
        L.tiles.set(p.id, await HX.api('/api/feed', { path: p.log, limit: 6 }));
      } catch {
        /* its log is not there yet */
      }
    }));
    if (L.layout === 'grid' && B.grid) renderGrid();
  }
})();
