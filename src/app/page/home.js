// Home (spec §6.2): what needs the owner, and what to do first. Everything waiting on them in groups with one shared
// cause and one action, sorted by what each holds up; a group opens in place to act on its members together. The
// loop panel on the right says how the loop is doing, and collapses to a strip.
(() => {
  'use strict';
  const { h, fill, F, S } = HX;
  const KIND_ORDER = ['your_tasks', 'ask', 'fix', 'stopped', 'questions', 'credential', 'scope', 'release', 'resolved', 'notices'];
  const KIND_LABEL = { your_tasks: 'your tasks', ask: 'Helix asks', fix: 'fix ready', questions: 'questions', credential: 'credential', scope: 'scope', release: 'release', stopped: 'needs you', resolved: 'resolved', notices: 'noise' };

  const V = { el: null, data: null, welcome: undefined, open: new Set(), sel: new Map(), seenTimer: null, by: 'cause', page: 0 };

  HX.views.home = {
    mount(el, parts) {
      V.el = el;
      V.welcome = undefined;
      V.by = HX.store.get('groupBy') ?? 'cause';
      if (parts[0]) return HX.screens.open(el, parts);
      build();
      load();
      // Looking at Home for a while counts as being back: the next welcome is measured from now.
      clearTimeout(V.seenTimer);
      V.seenTimer = setTimeout(() => S.root === 'real' && HX.post('/api/home/seen').catch(() => undefined), 8000);
    },
    route(parts) {
      HX.screens.close();
      if (parts[0]) return HX.screens.open(V.el, parts);
      build();
      load();
    },
    async update(what) {
      if (HX.screens.active()) return HX.screens.update(what);
      if (what.has('logs') && what.size === 1) return renderRail();
      await load();
    },
    back() {
      if (HX.screens.active()) {
        if (!HX.screens.back()) HX.go('#home');
        return true;
      }
      return false;
    },
    unmount() {
      clearTimeout(V.seenTimer);
      HX.screens.close();
    },
  };

  let B = null;
  function build() {
    const railOpen = HX.ui('homeRail', true) !== false;
    B = {
      welcome: h('div', { class: 'welcome' }),
      tools: h('div', { class: 'row wrap', style: { gap: '10px' } }),
      groups: h('div', { class: 'groups' }),
      rail: h('aside', { class: `rail${railOpen ? '' : ' closed'}`, 'aria-label': 'The loop' }),
    };
    fill(V.el, h('section', { class: 'home-main' }, B.welcome, B.tools, B.groups), B.rail);
    if (V.data) render();
    renderRail();
  }

  async function load() {
    const d = await HX.api('/api/home');
    V.data = d;
    if (V.welcome === undefined) V.welcome = d.welcome ?? null;
    if (B && !HX.screens.active()) render();
    renderRail();
  }

  function waiting(groups) {
    return groups.filter((g) => g.kind !== 'resolved' && g.kind !== 'notices').reduce((n, g) => n + g.members.length, 0);
  }

  function render() {
    const groups = V.data.groups;
    const n = waiting(groups);
    const w = V.welcome;
    // What the three costliest groups hold, against what all of them hold: each task counted once.
    const union = (gs) => new Set(gs.flatMap((g) => g.heldIds ?? [])).size;
    const held = union(groups);
    const top3 = union([...groups].sort((a, b) => b.held - a.held).slice(0, 3));
    const share = held ? Math.min(1, top3 / held) : 0;
    const headline = n === 0
      ? 'Nothing is waiting for you. The loop has it.'
      : `${F.n(n)} ${n === 1 ? 'thing is' : 'things are'} waiting for you.${groups.length > 3 && share > 0.3 ? ` Three groups unblock ${F.pct(share)} of the held work.` : ''}`;
    const finish = F.day(V.data.finish);
    // With both timelines, the finish is project complete, and code complete is said beside it.
    const code = V.data.codeFinish != null ? F.day(V.data.codeFinish) : null;
    const the = code ? 'project complete' : 'the finish';
    const projected = code ? `code complete is projected for ${code} and project complete for ${finish}` : `the finish is projected for ${finish}`;
    const moved = w?.finishMovedMs ?? 0;
    const movedText = Math.abs(moved) < 6 * 3_600_000 ? null : [`${the} ${moved > 0 ? 'moved' : 'came'} `, h('span', { class: moved > 0 ? 't-crit' : 't-ok' }, `${F.days(Math.abs(moved))} ${moved > 0 ? 'later' : 'sooner'}`), `, to ${finish}`, code ? `; code complete is projected for ${code}` : ''];
    fill(B.welcome,
      w ? h('div', { class: 'who' }, `Welcome back, ${HX.owner()} · away ${F.dur(w.awayMs).replace(/ \d+ min$/, '')}, on ${w.mode === 'auto' ? 'Auto-pilot' : 'Active pilot'}`) : null,
      h('h2', null, headline),
      w
        ? h('p', null, `While you were away: ${F.plural(w.merged, 'task')} merged, ${w.failed} failed for good`, movedText ? [', and ', movedText] : `, and ${projected}`, '.', w.movers.length && moved > 0 ? ` Most of that slip comes from ${w.movers.join(' and ')}.` : '')
        : h('p', null, `${F.cap(projected)}${S.state ? `, with ${F.plural(S.state.totals.done, 'task')} of ${F.n(S.state.totals.tasks)} merged` : ''}.`));
    fill(B.tools,
      groups.length ? h('div', { class: 'helixnote' }, h('span', { class: 'ring' }), groups.some((g) => g.groupedBy === 'helix') ? 'Helix grouped these by shared cause and sorted them by what each group holds up' : 'Grouped by shared cause, and sorted by what each group holds up') : null,
      h('span', { class: 'grow' }),
      h('span', { class: 'muted' }, 'Group by'),
      HX.seg([['cause', 'Cause'], ['kind', 'Kind'], ['lane', 'Lane'], ['none', 'None']], V.by, (v) => {
        V.by = v;
        V.page = 0;
        HX.store.set('groupBy', v);
        render();
      }));
    const max = Math.max(1, ...groups.map((g) => g.held));
    if (!groups.length) return fill(B.groups, h('div', { class: 'glass pad soft' }, 'No group is waiting. Each one appears here as it forms, and disappears when everything in it is handled.'));
    if (V.by === 'none') return fill(B.groups, flatList(groups));
    if (V.by === 'kind') return fill(B.groups, [...groups].sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || b.held - a.held).map((g) => group(g, max)));
    if (V.by === 'lane') {
      const lanes = new Map();
      for (const g of groups) {
        const l = g.lanes.length === 1 ? g.lanes[0] : g.lanes.length ? 'several lanes' : 'no lane';
        lanes.set(l, [...(lanes.get(l) ?? []), g]);
      }
      return fill(B.groups, [...lanes].map(([l, gs]) => [h('div', { class: 'cap', style: { margin: '10px 0 2px', color: HX.laneColor(l) ?? 'var(--color-neutral-400)' } }, l), gs.map((g) => group(g, max))]));
    }
    fill(B.groups, groups.map((g) => group(g, max)));
  }

  function costLabel(g) {
    if (g.kind === 'release') return 'production';
    if (g.kind === 'resolved') return 'already applied';
    if (g.kind === 'notices') return 'holds nothing';
    const parts = [g.held ? `holds ${F.plural(g.held, 'task')}` : 'holds nothing yet'];
    if (g.finishMs > 3_600_000) parts.push(`${F.days(g.finishMs)} of finish`);
    return parts.join(' · ');
  }

  function group(g, max) {
    const open = V.open.has(g.id);
    const sel = selection(g);
    const el = h('div', { class: `group glass${open ? ' sel' : ''}` },
      h('div', { class: 'head', tabindex: '0', 'data-jk': '', onclick: (e) => !e.target.closest('button') && toggle(g), onkeydown: (e) => e.key === 'Enter' && !e.target.closest('button') && primary(g)() },
        h('button', { type: 'button', class: 'chev', 'aria-label': open ? 'Close' : 'Open', 'aria-expanded': String(open), onclick: () => toggle(g) }, open ? '▾' : '▸'),
        h('span', { class: 'n' }, F.n(g.members.length)),
        h('div', { style: { minWidth: 0 } },
          h('div', { class: 'row' }, h('span', { class: 't ell' }, g.title), HX.tag(KIND_LABEL[g.kind] ?? g.kind, g.kind === 'ask' ? 'tag-accent' : 'tag-neutral'), g.groupedBy === 'helix' ? h('span', { class: 'tiny t-acc' }, 'grouped by Helix') : null),
          h('div', { class: 'why ell' }, g.cause)),
        HX.costBar(g.kind === 'release' ? max * 0.04 : g.held, max, g.critical, costLabel(g)),
        h('div', { class: 'acts' }, HX.btn(g.action.label, primary(g), 'btn-primary'), HX.btn(open ? 'Close' : 'Review', () => toggle(g)))));
    if (open) el.append(h('div', { class: 'body' }, batchBar(g, sel), memberTable(g, sel)));
    return el;
  }

  function toggle(g) {
    if (V.open.has(g.id)) V.open.delete(g.id);
    else V.open.add(g.id);
    render();
  }

  // The members selected in an open group: all, until the owner unticks some.
  function selection(g) {
    let s = V.sel.get(g.id);
    if (!s) V.sel.set(g.id, (s = new Set(g.members.map((m) => m.id))));
    for (const id of [...s]) if (!g.members.some((m) => m.id === id)) s.delete(id);
    return s;
  }

  function primary(g) {
    return HX.act(async () => {
      if (g.action.screen) return HX.go(`#home/${encodeURIComponent(g.id)}`);
      if (g.action.op === 'dismiss') {
        await HX.post('/api/dismiss', { ids: [...g.members.map((m) => m.id), `group:${g.id}:${g.members.length}`] });
        return HX.toast(`Dismissed ${F.plural(g.members.length, 'notice')}.`);
      }
      if (g.action.op === 'hand_back') return batch(g, 'hand_back', selection(g));
    });
  }

  // A batch action shows what it will change before it changes it, and lands as one commit.
  async function batch(g, action, sel) {
    const ids = [...sel].filter((id) => /^T-/.test(id));
    if (!ids.length) return HX.toast('Select tasks first.', { bad: true });
    const verb = action === 'park' ? 'Park' : 'Hand back';
    const note = await HX.prompt(`${verb} ${F.plural(ids.length, 'task')}`, [
      action === 'park' ? 'They wait until you hand them back. ' : 'They go back to ready, and the loop picks them up in rank order. ',
      `Changes: ${ids.slice(0, 12).join(', ')}${ids.length > 12 ? ` and ${ids.length - 12} more` : ''}, as one commit you can undo for a day. An optional note goes into each task's notes for its next builder.`,
    ], verb, { placeholder: 'Note for the next attempt (optional)' });
    if (note === null) return;
    const r = await HX.post('/api/batch', { ids, action, note, group: g.id });
    HX.toast(`${verb === 'Park' ? 'Parked' : 'Handed back'} ${F.plural(r.tasks.length, 'task')}.`, { undo: r.change?.id });
  }

  function batchBar(g, sel) {
    const tasks = g.members.filter((m) => /^T-/.test(m.id));
    return h('div', { class: 'batchbar' },
      g.kind === 'fix' ? [h('span', { class: 'lead' }, `Helix's fix for all ${g.members.length}:`), h('span', { class: 'ell grow' }, g.cause)] : h('span', { class: 'grow soft ell' }, g.cause),
      h('span', { class: 'small muted' }, `${sel.size} selected`),
      tasks.length ? [
        HX.btn('Park all', HX.act(() => batch(g, 'park', sel)), 'btn-ghost'),
        HX.btn('Hand back', HX.act(() => batch(g, 'hand_back', sel)), 'btn-ghost'),
      ] : null,
      HX.btn('Ask Helix', HX.act(() => askHelix([...sel], g.title)), 'btn-ghost'));
  }

  // Ask Helix about a selection: a conversation of its own, opened in the Helix tab.
  async function askHelix(ids, title) {
    const text = await HX.prompt('Ask Helix', `About ${ids.length === 1 ? ids[0] : `${F.plural(ids.length, 'item')} of "${title}"`}. Helix answers in a conversation under Helix › Conversations.`, 'Ask', { placeholder: 'What should Helix look into?' });
    if (!text) return;
    const t = await HX.post('/api/converse', { text, about: ids });
    HX.go(`#helix/conversations/${encodeURIComponent(t.key)}`);
  }
  HX.askHelix = askHelix;

  function memberTable(g, sel) {
    const shown = g.members.slice(0, 50);
    const isHuman = g.kind === 'your_tasks';
    const head = h('div', { class: 'mrow hd' },
      h('input', { type: 'checkbox', 'aria-label': 'Select all', checked: sel.size === g.members.length, onchange: (e) => { for (const m of g.members) e.target.checked ? sel.add(m.id) : sel.delete(m.id); render(); } }),
      h('span', null, isHuman ? 'Human task' : 'Task'), h('span', null, isHuman ? 'Lateness' : 'Lane'), h('span', null, isHuman ? 'Holds' : g.kind === 'stopped' || g.kind === 'fix' ? 'Failed' : 'Count'), h('span', null, isHuman ? 'State' : g.kind === 'questions' ? 'Question' : 'Last error'));
    const rows = shown.map((m) => h('div', { class: 'mrow' },
      h('input', { type: 'checkbox', checked: sel.has(m.id), 'aria-label': `Select ${m.id}`, onchange: (e) => { e.target.checked ? sel.add(m.id) : sel.delete(m.id); render(); } }),
      h('span', { class: 'ell' }, /^(T|HT)-/.test(m.id) ? HX.taskLink(m.id) : h('span', { class: 'id' }, m.id), ' ', m.title),
      h('span', { class: `ell ${isHuman && /late/.test(m.late ?? '') ? 't-crit' : 'muted'}` }, isHuman ? (m.late ?? '') : HX.laneShort(m.lane)),
      h('span', null, m.count != null ? (isHuman ? F.n(m.count) : `${m.count}×`) : ''),
      h('span', { class: `ell ${isHuman || g.kind === 'questions' ? 'soft' : 'err'}`, title: m.detail ?? '' }, m.detail ?? '')));
    return h('div', { class: 'mtable' }, head, rows, g.members.length > shown.length ? h('div', { class: 'more' }, `and ${g.members.length - shown.length} more; ${g.action.screen ? `${g.action.label} shows every one` : 'the batch actions apply to all selected'}`) : null);
  }

  // Group by None: every waiting item in one list, a page at a time.
  function flatList(groups) {
    const all = groups.filter((g) => g.kind !== 'notices').flatMap((g) => g.members.map((m) => ({ ...m, g })));
    const per = 60;
    const page = all.slice(V.page * per, (V.page + 1) * per);
    return h('div', { class: 'glass', style: { padding: '6px 14px 10px' } },
      h('div', { class: 'mrow hd' }, h('span'), h('span', null, 'Item'), h('span', null, 'Group'), h('span'), h('span', null, 'Detail')),
      page.map((m) => h('div', { class: 'mrow', 'data-jk': '', tabindex: '0', onkeydown: (e) => e.key === 'Enter' && m.g.action.screen && HX.go(`#home/${encodeURIComponent(m.g.id)}`) },
        h('span'), h('span', { class: 'ell' }, /^(T|HT)-/.test(m.id) ? HX.taskLink(m.id) : h('span', { class: 'id' }, m.id), ' ', m.title),
        h('span', { class: 'ell muted' }, KIND_LABEL[m.g.kind]), h('span', null, m.count != null ? `${m.count}×` : ''), h('span', { class: 'ell soft' }, m.detail ?? m.late ?? ''))),
      all.length > per ? h('div', { class: 'row', style: { marginTop: '8px' } }, HX.btn('Previous', () => { V.page--; render(); }, 'btn-ghost', { disabled: V.page === 0 }), h('span', { class: 'small muted' }, `${V.page * per + 1}–${Math.min(all.length, (V.page + 1) * per)} of ${F.n(all.length)}`), HX.btn('Next', () => { V.page++; render(); }, 'btn-ghost', { disabled: (V.page + 1) * per >= all.length })) : null);
  }

  // ---- the loop panel ----
  function renderRail() {
    if (!B || !S.state) return;
    const s = S.state;
    const open = !B.rail.classList.contains('closed');
    const toggleRail = () => {
      const now = B.rail.classList.toggle('closed');
      HX.setUi('homeRail', !now);
      renderRail();
    };
    const merged = s.totals.done;
    const total = s.totals.tasks;
    const moved = V.welcome?.finishMovedMs ?? 0;
    const passes = s.live;
    const allowed = s.agents.reduce((n, a) => n + (a.enabled ? (a.paced ?? a.slots) : 0), 0);
    const slots = s.agents.reduce((n, a) => n + (a.enabled ? a.slots : 0), 0);
    const strip = h('div', { class: 'strip' },
      HX.btn(HX.icon('sidebar-simple'), toggleRail, 'btn-ghost collapse', { title: 'Show the loop panel', 'aria-label': 'Show the loop panel' }),
      h('div', { class: 's', title: `${merged} of ${total} merged` }, h('span', { class: 'dot', style: { background: 'var(--ok)' } }), `${Math.round((merged / Math.max(1, total)) * 100)}%`),
      h('a', { class: 's', href: '#live', title: `${passes.length} passes running`, style: { color: 'var(--color-accent-300)' } }, HX.icon('broadcast'), String(passes.length)),
      h('a', { class: 's', href: '#helix/resolved', title: `${s.resolved.total} resolved for you` }, HX.icon('dna'), String(s.resolved.total)));
    const paced = s.agents.filter((a) => a.enabled && a.paced != null && a.paced < a.slots && a.state !== 'limited');
    const max = Math.max(1, ...s.merges);
    const median = [...s.merges].sort((a, b) => a - b)[6] ?? 0;
    const inner = h('div', { class: 'in' },
      h('div', null,
        h('div', { class: 'row' }, h('h6', { class: 'cap grow' }, 'The loop'), HX.btn(HX.icon('sidebar-simple'), toggleRail, 'btn-ghost collapse', { title: 'Collapse the panel', 'aria-label': 'Collapse the panel' })),
        h('div', { class: 'row', style: { alignItems: 'baseline', gap: '6px', marginTop: '4px' } }, h('span', { class: 'loopbig' }, F.n(merged)), h('span', { class: 'soft' }, `of ${F.n(total)} merged`)),
        h('div', { class: 'progress' }, h('i', { style: { width: `${(merged / Math.max(1, total)) * 100}%` } })),
        s.codeFinish != null ? h('div', { title: "The last builder task's merge, if every human task were done when it is needed" }, `Code complete ${F.dayTime(s.codeFinish)}`) : null,
        h('div', { title: s.codeFinish != null ? "When everything is done: the last builder task's merge or the last human task, with human tasks taking their lead times" : null }, `${s.codeFinish != null ? 'Project complete' : 'Finish'} ${F.dayTime(s.finish)}`, Math.abs(moved) > 6 * 3_600_000 ? h('span', { class: moved > 0 ? 't-crit' : 't-ok' }, ` · ${moved > 0 ? '+' : '−'}${F.days(Math.abs(moved))}`) : null)),
      h('div', { class: 'stack' },
        h('h6', { class: 'cap' }, 'Running now · ', h('a', { href: '#live' }, 'watch live')),
        passes.length ? passes.map((p) => h('a', { class: 'passcard', href: `#live/${encodeURIComponent(p.id)}` },
          h('div', { class: 'row' }, HX.badge(p.agent), h('b', { class: 'mono', style: { fontWeight: 500 } }, p.task), h('span', { class: 'muted ell grow' }, HX.PHASE[p.phase] ?? p.phase), h('span', { class: 'mono small muted' }, HX.ticker(p.startedAt, 'clock'))),
          p.progress || p.lastMessage ? h('div', { class: 'say ell' }, `▸ ${p.progress ?? p.lastMessage}`) : null))
          : h('div', { class: 'muted' }, s.loop.running ? (s.paused ? 'Paused: no new passes start.' : 'No pass in flight right now.') : 'The loop is stopped.'),
        paced.map((a) => h('div', { class: 'small t-warn' }, a.paced === 0 ? `${HX.AGENT[a.name]} waits for its weekly pace` : `${HX.AGENT[a.name]} slot${a.slots - a.paced > 1 ? 's' : ''} ${a.paced + 1}${a.slots - a.paced > 1 ? `–${a.slots}` : ''} held by weekly pace`)),
        allowed < slots && !paced.length ? h('div', { class: 'small t-warn' }, `${slots - allowed} slot${slots - allowed === 1 ? '' : 's'} held`) : null),
      h('div', { class: 'stack' },
        h('h6', { class: 'cap' }, 'Merged per 6 h · last 3 days'),
        h('div', { class: 'spark', title: s.merges.join(', ') }, s.merges.map((v) => h('i', { class: v < median / 2 ? 'low' : '', style: { height: `${Math.max(3, (v / max) * 50)}px` }, title: `${v} merged` })))),
      h('div', { class: 'stack' },
        h('h6', { class: 'cap' }, 'Helix decided on its own'),
        s.resolved.total
          ? [h('div', { class: 'soft' }, `${F.plural(s.resolved.total, 'HITL request')} resolved that Active pilot · ${HX.LEVEL[s.resolved.compared]} would have brought to you${s.resolved.unsure ? `. ${s.resolved.unsure} it's unsure of.` : '.'}`), h('div', null, HX.btn('Review how it resolved them', () => HX.go('#helix/resolved')))]
          : h('div', { class: 'muted' }, s.helix.monitor.enabled ? `Nothing yet. On ${s.pilot.mode === 'auto' ? 'Auto-pilot' : 'Active pilot'}, Helix resolves what the level lets it.` : ["Helix's monitor is off, so everything waits for you. ", h('a', { href: '#settings/helix' }, 'Settings › Helix')])));
    fill(B.rail, strip, inner);
    B.rail.classList.toggle('closed', !open);
  }
})();
