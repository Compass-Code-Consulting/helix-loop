// Settings (spec §6.8): pilot mode, the loop's controls, the builder-feedback rules, agent health, Helix, releases,
// and the Helix Spec and TaskSet. Config values change through change sets that apply together, validated and
// committed; pilot mode, feedback rules and Helix's settings apply at once, each as its own commit.
(() => {
  'use strict';
  const { h, fill, F, S } = HX;
  const PAGES = [['pilot', 'Pilot mode'], ['loop', 'Loop controls'], ['feedback', 'Builder feedback'], ['agents', 'Agents'], ['helix', 'Helix'], ['releases', 'Releases'], ['taskset', 'Spec and TaskSet']];
  const X = { el: null, page: 'pilot', data: null, health: null, pending: new Map(), find: '', drafts: {}, harness: 'claude' };

  HX.views.settings = {
    mount(el, parts) {
      X.el = el;
      X.page = PAGES.some(([p]) => p === parts[0]) ? parts[0] : 'pilot';
      build();
      load();
    },
    route(parts) {
      X.page = PAGES.some(([p]) => p === parts[0]) ? parts[0] : 'pilot';
      renderSide();
      render();
      if (X.page === 'agents' || X.page === 'helix') loadHealth();
    },
    async update(what) {
      if (what.has('logs') && what.size === 1) return;
      // Typing in a field is never interrupted by a refresh.
      if (X.el.contains(document.activeElement) && /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName)) {
        X.stale = true;
        return;
      }
      await load();
    },
    job() {
      if (X.page === 'loop' || X.page === 'taskset' || X.page === 'agents') render();
    },
  };

  let B;
  function build() {
    B = { side: h('nav', { class: 'sidelist', 'aria-label': 'Settings' }), main: h('div', { class: 'pagewrap' }) };
    B.main.addEventListener('focusout', () => setTimeout(() => {
      if (X.stale && !X.el.contains(document.activeElement)) {
        X.stale = false;
        load();
      }
    }, 50));
    fill(X.el, B.side, B.main);
    renderSide();
  }
  function renderSide() {
    fill(B.side, PAGES.map(([p, label]) => h('a', { href: `#settings/${p}`, 'aria-current': X.page === p ? 'page' : null }, label)));
  }
  async function load() {
    X.data = await HX.api('/api/settings');
    render();
    if ((X.page === 'agents' || X.page === 'helix') && !X.health) loadHealth();
  }
  async function loadHealth(refresh) {
    X.health = await HX.api('/api/health', refresh ? { refresh: '1' } : {});
    if (X.page === 'agents' || X.page === 'helix' || X.page === 'loop') render();
  }
  function render() {
    if (!X.data || !S.state) return fill(B.main, h('div', { class: 'page muted' }, 'Loading…'));
    const keep = B.main.scrollTop;
    fill(B.main, { pilot, loop, feedback, agents, helix, releases, taskset }[X.page](X.data));
    B.main.scrollTop = keep;
    HX.hydrateIcons(B.main);
  }
  const head = (title, text, extra) => h('div', { class: 'row top' }, h('div', { class: 'pagehead grow' }, h('h1', null, title), h('p', null, text)), extra);

  // ---- Pilot mode (spec §7) ----
  const CELL = { asks: ['Asks you', ''], helix: ['Decides', 'dec'], parks: ['Parks', 'park'], always: ['Always asks', 'always'], daniel: ['Only you', 'only'] };
  function pilot(d) {
    const p = d.pilot.pilot;
    const set = (body, what) => HX.act(async () => {
      await HX.post('/api/pilot', body);
      HX.toast(what);
    });
    const col = p.mode === 'active' ? p.active_level : p.auto_level === 'yolo' ? 'yolo' : 'intrepid_auto';
    const cols = [['cautious', 'Cautious'], ['prudent', 'Prudent'], ['intrepid', 'Intrepid'], ['intrepid_auto', 'Intrepid'], ['yolo', 'YOLO']];
    const promptBox = h('textarea', { class: 'input mono', rows: 7 });
    const pr = d.pilot.prompt;
    promptBox.value = X.drafts[`prompt:${pr?.name}`] ?? pr?.text ?? '';
    promptBox.oninput = () => (X.drafts[`prompt:${pr?.name}`] = promptBox.value);
    return h('div', { class: 'page stack lg' },
      head('Pilot mode', 'How much the loop and Helix decide without you. Builders always run inside their sandboxes; this only governs plan changes, retries and answers.'),
      h('div', { class: 'cards2' },
        h('div', { class: `glass modecard${p.mode === 'active' ? ' on' : ''}`, onclick: (e) => p.mode !== 'active' && !e.target.closest('button') && set({ mode: 'active' }, 'Active pilot: Helix brings you what your level asks for.')() },
          h('h4', null, h('input', { type: 'radio', name: 'mode', checked: p.mode === 'active', 'aria-label': 'Active pilot' }), 'Active pilot', p.mode === 'active' ? HX.tag('current', 'tag-accent') : null),
          h('div', { class: 'soft' }, "You're at the desk. Helix brings you HITL requests as they come up; rate each one and it learns what to stop asking."),
          HX.seg([['cautious', 'Cautious'], ['prudent', 'Prudent'], ['intrepid', 'Intrepid']], p.active_level, (v) => set({ active_level: v }, `Active pilot · ${HX.LEVEL[v]}`)()),
          h('div', { class: 'levels small' },
            h('div', null, h('b', null, 'Cautious'), ' · if in doubt, ask. Everything in Prudent, plus whenever a builder isn’t sure.'),
            h('div', null, h('b', null, 'Prudent'), ' · everything in Intrepid, plus scope creep, architecture changes, and compromises a constraint forced.'),
            h('div', null, h('b', null, 'Intrepid'), ' · only high-risk items: repeated failures, security, architectural impact.'))),
        h('div', { class: `glass modecard${p.mode === 'auto' ? ' on' : ''}`, onclick: (e) => p.mode !== 'auto' && !e.target.closest('button, input') && set({ mode: 'auto' }, 'Auto-pilot: Helix resolves what it can while you are away.')() },
          h('h4', null, h('input', { type: 'radio', name: 'mode', checked: p.mode === 'auto', 'aria-label': 'Auto-pilot' }), 'Auto-pilot', p.mode === 'auto' ? HX.tag('current', 'tag-accent') : null),
          h('div', { class: 'soft' }, "You're away. The loop keeps building and Helix resolves what it can."),
          HX.seg([['intrepid', 'Intrepid'], ['yolo', 'YOLO']], p.auto_level, (v) => set({ auto_level: v }, `Auto-pilot · ${HX.LEVEL[v]}`)()),
          h('div', { class: 'levels small' },
            h('div', null, h('b', null, 'Intrepid'), ' · resolves everything except high-risk items, which park their task until you’re back. The rest of the loop keeps going.'),
            h('div', null, h('b', null, 'YOLO'), ' · resolves everything itself. Releases and approvals still wait for you.')),
          h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: p.record, onchange: (e) => set({ record: e.target.checked }, e.target.checked ? 'Recording what Helix resolves.' : 'Not recording.')() }), 'Record HITL invocations and resolutions', h('span', { class: 'small muted' }, ' · review them under Helix › Resolved for you')),
          S.state.helix.monitor.enabled ? null : h('div', { class: 'small t-warn' }, 'Helix’s monitor is off, so nothing is resolved for you yet: ', h('a', { href: '#settings/helix' }, 'turn it on')))),
      h('div', { class: 'split even', style: { gridTemplateColumns: 'minmax(0, 1.25fr) minmax(0, 1fr)', overflow: 'visible' } },
        h('div', { class: 'stack' },
          h('h6', { class: 'cap' }, 'When Helix asks you'),
          h('table', { class: 'matrix' },
            h('thead', null,
              h('tr', null, h('th'), h('th', { colspan: 3 }, 'Active pilot'), h('th', { colspan: 2 }, 'Auto-pilot')),
              h('tr', null, h('th', null, 'Request'), cols.map(([c, label]) => h('th', { class: c === col ? 'cur' : '' }, label)))),
            h('tbody', null, d.pilot.requests.map((r) => h('tr', null, h('td', null, r.label), cols.map(([c]) => {
              const v = d.pilot.table[r.kind][c];
              const [text, cls] = CELL[v] ?? [v, ''];
              return h('td', { class: `${cls} ${c === col ? 'cur' : ''}` }, text);
            }))))),
          h('div', { class: 'small muted' }, 'Intrepid sits in both modes. In Active pilot it asks you; in Auto-pilot it parks the task until you’re back. Your ▼ ratings override this table; nothing lowers its floors: releases, reviewed paths, human tasks, secrets, the config and Helix’s prompts always wait for you.')),
        h('div', { class: 'stack lg' },
          h('div', { class: 'stack' },
            h('h6', { class: 'cap' }, `Learned from your ratings · ${d.pilot.rules.length}`),
            d.pilot.rules.length ? h('div', { class: 'rules' }, d.pilot.rules.map((r) => h('div', { class: 'r' }, h('span', { class: r.decide === 'helix' ? 't-crit' : 't-ok' }, r.decide === 'helix' ? '▼' : '▲'), h('span', { class: 'ell' }, `${r.name}: ${r.decide === 'helix' ? 'Helix decides' : 'keep asking, even on Intrepid'}`), h('span', { class: 'small muted' }, `since ${new Date(r.at).toLocaleDateString(undefined, { weekday: 'short' })}`), h('button', { type: 'button', class: 'link small', onclick: HX.act(async () => { await HX.post('/api/rule/undo', { id: r.id }); HX.toast('Rule removed.'); }) }, 'Undo'))))
              : h('div', { class: 'muted small' }, 'None yet. Every request Helix brings you has ▲ Keep asking and ▼ Decide these yourself: a rating becomes a rule here.')),
          pr ? h('div', { class: 'stack' },
            h('div', { class: 'row' }, h('span', { class: 'grow' }, `Helix’s prompt for ${p.mode === 'auto' ? 'Auto-pilot' : 'Active pilot'} · ${HX.LEVEL[p.mode === 'auto' ? p.auto_level : p.active_level]}`), pr.edited ? HX.tag('edited', 'tag-accent') : null,
              h('button', { type: 'button', class: 'link small', onclick: HX.act(async () => { await HX.post('/api/prompt', { name: pr.name, reset: true }); delete X.drafts[`prompt:${pr.name}`]; HX.toast('Reset to its preset.'); }) }, 'Reset to preset')),
            promptBox,
            h('div', { class: 'row' }, h('span', { class: 'small muted grow' }, 'Judgment only: what Helix may do is its tools’ and the floors’ business.'), HX.btn('Save prompt', HX.act(async () => { await HX.post('/api/prompt', { name: pr.name, text: promptBox.value }); delete X.drafts[`prompt:${pr.name}`]; HX.toast('Prompt saved.'); }), 'btn-secondary sm'))) : null)));
  }

  // ---- Loop controls (spec §6.8) ----
  function loop(d) {
    const s = S.state;
    const l = s.loop;
    const c = d.controls;
    const agentBoxes = {};
    const runStrip = h('div', { class: 'glass runstrip' },
      h('div', { class: 'row', style: { gap: '10px' } }, h('span', { class: `dot ${l.running && !s.paused ? 'on' : l.running ? 'warn' : ''}`, style: { width: '10px', height: '10px' } }),
        h('div', null, h('div', { style: { fontSize: '17px', fontWeight: 500 } }, HX.loopPill()), h('div', { class: 'small soft' }, l.running ? ['since ', F.dayTime(Date.parse(l.since ?? new Date().toISOString())), ` · pid ${l.pid} · ${F.plural(s.live.length, 'pass')} in flight`] : l.lastExit ? `last run ended ${F.when(l.lastExit.at)}${l.lastExit.detail ? `: ${l.lastExit.detail}` : ''}` : 'not started yet'))),
      h('div', { class: 'stack', style: { gap: '4px' } },
        h('div', { class: 'row' }, ['claude', 'codex'].map((a) => {
          const hh = X.health?.find((x) => x.agent === a);
          const ok = s.dryRun || hh?.builder;
          const cb = h('input', { type: 'checkbox', checked: ok !== false, disabled: l.running || (!s.dryRun && hh && !hh.builder) });
          agentBoxes[a] = cb;
          return h('label', { class: 'check', title: s.dryRun ? 'The dry run uses the fake CLIs' : !hh ? 'Checking…' : hh.builder ? 'Installed, on its subscription, working' : "Can't build: see Agents" }, cb, HX.AGENT[a]);
        })),
        h('div', { class: 'row small' }, h('span', { class: 'muted' }, 'At most'), (X.max ??= h('input', { class: 'input', type: 'number', min: '1', placeholder: 'no cap', style: { width: '80px' }, disabled: l.running })), h('span', { class: 'muted' }, 'passes, then stop'))),
      h('span', { class: 'grow' }),
      h('div', { class: 'row wrap' },
        l.running ? HX.btn(s.paused ? 'Resume new passes' : 'Pause new passes', HX.act(async () => {
          await HX.post('/api/loop/pause', { paused: !s.paused });
          HX.toast(s.paused ? 'New passes start again.' : 'Paused: the passes in flight finish, and no new one starts.');
        })) : null,
        HX.btn('Start a dry run', HX.act(async () => {
          const ok = await HX.confirm('Start a dry run', h('p', null, 'A copy of the plan as it stands, in runs/dry-run/, with fresh repos and the fake CLIs. It replaces the last dry run; nothing real is touched. Switch to Dry run in the top bar to watch it.'), 'Start');
          if (!ok) return;
          const prev = S.root;
          S.root = 'dry';
          try {
            await HX.post('/api/loop/start', { agents: ['claude', 'codex'] });
          } finally {
            S.root = prev;
          }
          HX.toast('Dry run started.');
        })),
        l.running
          ? HX.btn('Stop after current passes', HX.act(async () => {
            if (!(await HX.confirm('Stop the loop', h('p', null, 'The loop takes no new task, lets the passes in flight finish, and exits. Nothing is cut short.'), 'Stop', true))) return;
            await HX.post('/api/loop/stop');
            HX.toast('Stopping after the current passes.');
          }), 'btn-danger', { disabled: l.stopping })
          : HX.btn(s.dryRun ? 'Start the dry run' : 'Start the loop', HX.act(async () => {
            const agents = Object.entries(agentBoxes).filter(([, b]) => b.checked && !b.disabled).map(([a]) => a);
            if (!agents.length) throw new Error('Pick at least one agent.');
            const max = Number(X.max.value) || undefined;
            if (!s.dryRun && !(await HX.confirm('Start the loop', [h('p', null, `The loop builds with ${agents.map((a) => HX.AGENT[a]).join(' and ')}${max ? `, for at most ${F.plural(max, 'pass', 'passes')}` : ''}, on their subscriptions, and merges what passes the gate into main.`), h('p', { class: 'mono small' }, `helix-loop run --agents ${agents.join(',')}${max ? ` --max-passes ${max}` : ''}`)], 'Start'))) return;
            const r = await HX.post('/api/loop/start', { agents, maxPasses: max });
            HX.toast(`Started (pid ${r.pid}); its output goes to ${r.log}.`);
          }), 'btn-primary', { disabled: !s.dryRun && !X.health })));
    if (!X.health) loadHealth();
    const find = h('input', { class: 'input', placeholder: 'Find a setting', value: X.find, style: { width: '220px' } });
    find.oninput = () => {
      X.find = find.value.toLowerCase();
      fill(X.cards, cards(c));
      find.focus();
    };
    X.cards = h('div', { class: 'cards3' }, cards(c));
    const pending = [...X.pending.entries()];
    const changeBar = pending.length ? h('div', { class: 'changeset' },
      h('b', { style: { fontWeight: 500 } }, `${F.plural(pending.length, 'change')} not applied`),
      h('span', { class: 'list grow ell' }, pending.map(([k, v]) => `${k} ${fmtVal(c.controls.find((x) => x.key === k), c.controls.find((x) => x.key === k)?.value)} → ${fmtVal(c.controls.find((x) => x.key === k), v)}`).join(' · ')),
      h('button', { type: 'button', class: 'link', onclick: () => { X.pending.clear(); render(); } }, 'Discard'),
      HX.btn('Try in dry run', HX.act(async () => {
        await HX.post('/api/config/apply', { changes: pending.map(([key, value]) => ({ key, value })), dry: true });
        HX.toast('A dry run with these values is starting. Switch to Dry run to watch it.');
      })),
      HX.btn('Apply from the next pass', HX.act(async () => {
        const changes = pending.map(([key, value]) => ({ key, value }));
        const ok = await HX.confirm('Apply to .helix/config.yaml', [h('div', { class: 'mono small' }, pending.map(([k, v]) => h('div', null, `${k}: ${fmtVal(c.controls.find((x) => x.key === k), v)}`))), h('p', { class: 'muted' }, 'Written into the file with its comments kept, checked as the loop loads it, and committed. The loop reads it at the start of its next round; nothing in flight is cut short.')], 'Apply');
        if (!ok) return;
        await HX.post('/api/config/apply', { changes });
        X.pending.clear();
        HX.toast('Applied: the loop takes it from its next round.');
      }), 'btn-primary')) : null;
    const jobs = [...S.jobs.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, 6);
    return h('div', { style: { minHeight: '100%', display: 'flex', flexDirection: 'column' } },
      h('div', { class: 'page stack lg', style: { flex: 1, maxWidth: '1300px' } },
        head('Loop controls', ['What the loop runs with right now. Values come from ', h('span', { class: 'mono' }, '.helix/config.yaml'), '; changes here are written back to it.'], find),
        runStrip,
        X.cards,
        jobs.length ? h('div', { class: 'stack' }, h('h6', { class: 'cap' }, 'Commands'), jobs.map(jobCard)) : null),
      changeBar);
  }

  function jobCard(j) {
    return h('details', { class: 'glass pad', open: j.status === 'running' || undefined },
      h('summary', { class: 'row', style: { cursor: 'pointer' } }, HX.tag(j.status, j.status === 'done' ? 'tag-ok' : j.status === 'failed' ? 'tag-crit' : 'tag-accent'), h('b', { style: { fontWeight: 500 } }, j.title), h('span', { class: 'small muted' }, F.when(j.startedAt))),
      h('div', { class: 'mono small muted', style: { margin: '6px 0' } }, j.command),
      j.urls.map((u) => h('div', null, h('a', { href: u, target: '_blank', rel: 'noopener' }, u))),
      h('pre', { class: 'codebox', style: { maxHeight: '240px' } }, j.output || '(no output yet)'));
  }

  function fmtVal(c, v) {
    if (!c) return String(v);
    if (c.type === 'bool') return v ? 'on' : 'off';
    if (c.type === 'list') return `${(v ?? []).length} ${c.key.includes('domains') ? 'hosts' : c.key.includes('paths') && !c.key.includes('union') ? 'globs' : 'paths'}`;
    if (c.type === 'model') return `${v?.model} · ${v?.effort}`;
    if (c.type === 'usd') return `$${F.n(v)}`;
    return `${v}${c.unit ? ` ${c.unit}` : ''}`;
  }

  function cards(c) {
    return c.groups.map((g) => {
      const ctls = c.controls.filter((x) => x.group === g.id && (!X.find || `${x.label} ${x.key} ${x.note}`.toLowerCase().includes(X.find)));
      if (!ctls.length) return null;
      return h('div', { class: 'glass pad' }, h('div', { class: 'ctlhead' }, h('b', null, g.title), h('span', { class: 'k' }, g.keys)), ctls.map((x) => control(x, c)));
    });
  }

  function control(x, c) {
    const value = X.pending.has(x.key) ? X.pending.get(x.key) : x.value;
    const changed = X.pending.has(x.key);
    const eff = c.effects[x.key];
    const setV = (v) => {
      if (JSON.stringify(v) === JSON.stringify(x.value)) X.pending.delete(x.key);
      else X.pending.set(x.key, v);
      render();
    };
    let input;
    if (x.type === 'bool') input = h('select', { class: `input${changed ? ' changed' : ''}`, onchange: (e) => setV(e.target.value === 'on') }, h('option', { value: 'on', selected: value }, 'on'), h('option', { value: 'off', selected: !value }, 'off'));
    else if (x.type === 'model') {
      const agent = x.key.split('.')[1];
      const models = [...new Set([...(c.models[agent] ?? []), value.model])];
      input = h('div', { class: 'row' },
        h('select', { class: `input${changed ? ' changed' : ''}`, onchange: (e) => setV({ ...value, model: e.target.value }) }, models.map((m) => h('option', { value: m, selected: m === value.model }, m))),
        h('select', { class: `input${changed ? ' changed' : ''}`, onchange: (e) => setV({ ...value, effort: e.target.value }) }, ['low', 'medium', 'high', 'xhigh'].map((m) => h('option', { value: m, selected: m === value.effort }, m))));
    } else if (x.type === 'list') {
      input = HX.btn(fmtVal(x, value), HX.act(async () => {
        const text = await HX.prompt(x.label, `${x.note}. One per line.`, 'Keep', { value: (value ?? []).join('\n'), rows: 8 });
        if (text === null) return;
        setV(text.split('\n').map((s) => s.trim()).filter(Boolean));
      }), `btn-secondary sm mono${changed ? ' changed' : ''}`);
    } else {
      input = h('input', { class: `input${changed ? ' changed' : ''}`, type: 'number', value: String(value ?? ''), min: x.min, max: x.max, 'aria-label': x.label });
      input.onchange = () => setV(Number(input.value));
    }
    return h('div', { class: 'ctl' }, h('span', { class: 'lb' }, x.label), input,
      h('div', { class: 'note' }, x.note, eff ? [' · ', h('span', { class: `eff${eff.warn ? ' warn' : ''}` }, eff.text)] : null, changed ? h('span', { class: 't-acc' }, ` · was ${fmtVal(x, x.value)}`) : null));
  }

  // ---- Builder feedback (spec §10) ----
  const AFTER = [['first', 'the first time'], ['task:2', '2 times on one task'], ['task:3', '3 times on one task'], ['tasks:2', 'on 2 tasks'], ['tasks:3', 'on 3 tasks'], ['tasks:5', 'on 5 tasks']];
  function feedback(d) {
    const fb = d.feedback;
    const set = (kind, lane, patch) => HX.act(async () => {
      await HX.post('/api/feedback', { kind, lane, ...patch });
      HX.toast(`${lane ? `${lane}: ` : ''}${kind.replace('_', ' ')} updated.`);
    })();
    const row = (k, lane, rule) => h('tr', null,
      h('td', null, h('div', null, k.label), h('div', { class: 'small muted' }, k.means)),
      h('td', null, HX.seg([['inbox', 'Inbox'], ['helix', 'Helix'], ['off', 'Off']], rule.send_to, (v) => set(k.kind, lane, { send_to: v }), 'sm')),
      h('td', null, h('select', { class: 'input', onchange: (e) => set(k.kind, lane, { after: e.target.value }) }, AFTER.map(([v, l]) => h('option', { value: v, selected: v === rule.after }, l)))),
      h('td', null, h('input', { type: 'checkbox', checked: rule.pause, 'aria-label': 'Pause the task at once', onchange: (e) => set(k.kind, lane, { pause: e.target.checked }) })),
      h('td', null, h('input', { type: 'checkbox', checked: rule.notify, 'aria-label': 'Notify', onchange: (e) => set(k.kind, lane, { notify: e.target.checked }) })),
      h('td', { class: 'small muted' }, fb.counts[k.kind] ? `${fb.counts[k.kind]} this week` : ''));
    const laneSel = h('select', { class: 'input' }, fb.repos.map((r) => h('option', { value: r }, r)));
    const kindSel = h('select', { class: 'input' }, fb.kinds.map((k) => h('option', { value: k.kind }, k.label)));
    return h('div', { class: 'page stack lg' },
      head('Builder feedback', 'What builders report with report_issue, and what the loop records at the gate: where each kind goes, after how many, whether its task stops at once, and whether you get a notification.'),
      h('div', { class: 'glass pad' }, h('table', { class: 'matrix' },
        h('thead', null, h('tr', null, h('th', null, 'Kind'), h('th', null, 'Send to'), h('th', null, 'After'), h('th', null, 'Pause'), h('th', null, 'Notify'), h('th'))),
        h('tbody', null, fb.kinds.map((k) => row(k, undefined, k.rule))))),
      h('div', { class: 'small muted' }, 'Inbox: a group of its own on Home. Helix: the monitor handles it and brings a fix (with the monitor off, it comes to Home). Pause stops the pass and the task waits for you. Reports are advisory: status and outcomes stay with the gate, the merge queue and the ledger.'),
      h('div', { class: 'stack' },
        h('h6', { class: 'cap' }, 'Per-lane overrides'),
        fb.lanes.length ? fb.lanes.map((l) => h('div', { class: 'glass pad stack' }, h('b', { style: { fontWeight: 500, color: HX.laneColor(l.lane) } }, l.lane),
          h('table', { class: 'matrix' }, h('tbody', null, Object.entries(l.rules).map(([kind, r]) => {
            const k = fb.kinds.find((x) => x.kind === kind);
            return k ? row(k, l.lane, { ...k.rule, ...r }) : null;
          })))))
          : h('div', { class: 'muted' }, 'None: every lane follows the rules above.'),
        h('div', { class: 'row' }, h('span', { class: 'muted' }, 'Override'), kindSel, h('span', { class: 'muted' }, 'for'), laneSel, HX.btn('Add', () => set(kindSel.value, laneSel.value, { send_to: 'inbox' }), 'btn-secondary sm'))));
  }

  // ---- Agents (spec §12) ----
  const keys = {};
  function agents() {
    const hs = X.health;
    if (!hs) return h('div', { class: 'page muted' }, 'Checking each CLI: installed, signed in, working…');
    const light = (l, label, detail) => h('span', { class: 'light' }, h('span', { class: `dot ${l === 'green' ? '' : l === 'amber' ? 'warn' : l === 'red' ? 'crit' : ''}`, style: { background: l === 'green' ? 'var(--ok)' : undefined } }), h('b', { style: { fontWeight: 500 } }, label), detail ? h('span', { class: 'muted' }, ` · ${detail}`) : null);
    return h('div', { class: 'page stack lg', style: { maxWidth: '980px' } },
      head('Agents', 'Each CLI the loop and Helix run: installed, signed in with its subscription, holding a Helix API key, and working. Builders only ever run on their subscriptions.', HX.btn('Check again', () => { X.health = null; render(); loadHealth(true); })),
      hs.map((x) => {
        const keyInput = (keys[x.agent] ??= h('input', { class: 'input', type: 'password', placeholder: x.agent === 'claude' ? 'sk-ant-…' : 'sk-…', autocomplete: 'off', 'aria-label': `${HX.AGENT[x.agent]} API key for Helix` }));
        return h('div', { class: 'glass pad stack' },
          h('div', { class: 'row' }, HX.badge(x.agent, true), h('b', { style: { fontSize: '16px', fontWeight: 500 } }, HX.AGENT[x.agent]), h('span', { class: 'small muted' }, x.installed.version ?? ''), h('span', { class: 'grow' }), x.builder ? HX.tag('can build', 'tag-ok') : HX.tag("can't build", 'tag-crit'), x.helix ? HX.tag('can run Helix', 'tag-accent') : null),
          h('div', { class: 'lights' },
            light(x.installed.light, 'Installed', x.installed.light === 'green' ? null : x.installed.detail),
            light(x.subscription.light, 'Subscription', x.subscription.light === 'green' ? null : x.subscription.method),
            light(x.key.light, 'Helix key', x.key.light === 'green' ? 'in the keychain' : 'none'),
            light(x.working.light, 'Working', x.working.light === 'amber' && x.working.resetAt ? `limited until ${F.time(new Date(x.working.resetAt).toISOString())}` : x.working.detail)),
          h('div', { class: 'row wrap' },
            x.installed.light !== 'green' ? HX.btn(`Install ${HX.AGENT[x.agent]}`, HX.act(() => setup(x.agent, 'install')), 'btn-primary') : null,
            x.installed.light === 'green' && x.subscription.light !== 'green' ? HX.btn('Sign in with the subscription', HX.act(() => setup(x.agent, 'signin')), 'btn-primary') : null),
          h('details', null, h('summary', { class: 'small', style: { cursor: 'pointer' } }, x.key.light === 'green' ? 'Replace or remove the Helix key' : 'Use an API key for Helix only'),
            h('p', { class: 'small muted' }, 'The key goes to the macOS keychain and only into Helix’s own process; builders never use it. It bills per token, in real money.'),
            h('div', { class: 'row' }, keyInput,
              HX.btn('Save', HX.act(async () => { await HX.post('/api/key', { agent: x.agent, key: keyInput.value }); keyInput.value = ''; HX.toast('Saved in the keychain.'); loadHealth(true); })),
              x.key.light === 'green' ? HX.btn('Remove', HX.act(async () => { await HX.post('/api/key', { agent: x.agent, key: null }); loadHealth(true); }), 'btn-danger') : null)));
      }),
      h('div', { class: 'small muted' }, `Checked ${F.when(hs[0]?.checkedAt)}. The loop checks each CLI’s sign-in at its start and every ten minutes; an agent not on its subscription takes no task.`),
      [...S.jobs.values()].filter((j) => /^(Install|Sign)/.test(j.title)).slice(0, 3).map(jobCard));
  }
  async function setup(agent, action) {
    const cmd = action === 'install' ? (agent === 'claude' ? 'brew install --cask claude-code' : 'npm install -g @openai/codex') : agent === 'claude' ? 'claude auth login --claudeai' : 'codex login --device-auth';
    const what = action === 'install' ? `Install ${HX.AGENT[agent]}` : `Sign ${HX.AGENT[agent]} in`;
    if (!(await HX.confirm(what, [h('p', null, action === 'install' ? 'Installs the CLI for this user.' : 'Opens the sign-in page; finish it in the browser. A device code, if any, shows below.'), h('p', { class: 'mono' }, cmd)], 'Run'))) return;
    await HX.post('/api/setup', { agent, action });
    HX.toast(`${what}: its output shows below.`);
  }

  // ---- Helix (spec §9) ----
  const MONITOR_LEVELS = ['light', 'standard', 'thorough'];
  const MONITOR_LEVEL = { light: ['Light'], standard: ['Standard'], thorough: ['Thorough'] };
  const every = (x) => (x.everyMinutes ? `a look every ${x.everyMinutes} minutes` : 'no heartbeat');
  const LEVEL_TEXT = {
    light: (x) => `Only what needs judgment: a failure that repeats, a builder’s issue, a human task you finish; ${every(x)}.`,
    standard: (x) => `Light’s, plus ${every(x)} while the loop runs and a one-line read of each running pass.`,
    thorough: (x) => `Every pass that ends, ${every(x)}, and reads of running passes.`,
  };
  // A level that would run into its cap spends exactly that, and stops for the rest of the day.
  const PER_DAY = (x) => (!x ? '' : x.capped ? `$${Math.round(x.usdPerDay)}/day` : x.usdPerDay < 0.5 ? 'under $1/day' : `≈ $${Math.round(x.usdPerDay)}/day`);
  // claude-sonnet-5-5 → Sonnet 5.5; other models by their own names.
  const MODEL = (id) => {
    const c = /^claude-([a-z]+)-(\d+)-(\d+)$/.exec(id);
    return c ? `${F.cap(c[1])} ${c[2]}.${c[3]}` : id;
  };
  function helix(d) {
    const hs = X.health;
    const st = S.state.helix;
    const pick = (role) => h('div', { class: 'row' }, ['claude', 'codex'].map((a) => {
      const ok = hs?.find((x) => x.agent === a)?.helix;
      return h('label', { class: 'check', title: ok ? '' : 'Not ready: see Agents' }, h('input', { type: 'radio', name: role, checked: (role === 'monitor' ? st.monitor.agent : st.assistant) === a, disabled: !ok, onchange: HX.act(async () => { await HX.post('/api/helix/settings', { [role]: a }); HX.toast(`${HX.AGENT[a]} runs Helix's ${role}.`); }) }), `${HX.AGENT[a]}${ok === false ? ' (not ready)' : ''}`);
    }));
    if (!hs) loadHealth();
    const m = st.monitor;
    const est = d.monitorLevels;
    const level = est.levels.find((x) => x.level === m.level);
    const budget = h('input', { class: 'input', type: 'number', min: '0', max: '500', value: String(m.budgetUsd), style: { width: '90px' }, 'aria-label': 'Daily cap in dollars' });
    budget.oninput = () => (saveCap.hidden = Number(budget.value) === m.budgetUsd);
    const saveCap = HX.btn('Save cap', HX.act(async () => { await HX.post('/api/helix/settings', { monitorBudget: Number(budget.value) }); HX.toast(`The monitor stops at $${Number(budget.value)} a day, at every level.`); }), 'btn-ghost');
    saveCap.hidden = true;
    const setLevel = (v) => v !== m.level && HX.act(async () => { await HX.post('/api/helix/settings', { monitorLevel: v }); HX.toast(`The monitor is on ${MONITOR_LEVEL[v][0]}.`); })();
    return h('div', { class: 'page stack lg', style: { maxWidth: '1000px' } },
      head('Helix', 'The loop’s assistant. It runs as Claude Code or Codex, in two roles with separate sessions, prompts and tools; everything it can do is a tool the app checks, so its limits are the app’s, not its prompts’.'),
      h('div', { class: 'cards2' },
        h('div', { class: 'glass pad stack' }, h('b', { style: { fontSize: '15px', fontWeight: 500 } }, 'The assistant'), h('div', { class: 'soft small' }, 'Answers you in conversations and makes the plan changes you ask for. One turn at a time, resuming each conversation’s own session.'), pick('assistant'), h('div', { class: 'small muted' }, st.status.busy && st.status.role === 'assistant' ? 'Answering now.' : `${F.plural(st.status.queued.length, 'turn')} waiting.`)),
        h('div', { class: 'glass pad stack' },
          h('div', { class: 'row' }, h('b', { class: 'grow', style: { fontSize: '15px', fontWeight: 500 } }, 'The monitor'), m.enabled ? HX.tag(`on · ${MONITOR_LEVEL[m.level][0]}`, 'tag-ok') : HX.tag('off', 'tag-neutral')),
          h('div', { class: 'soft small' }, 'Watches the loop: groups feedback into incidents, proposes one fix for each, and resolves what the pilot level lets it. Short turns from a digest the app prepares, at most one a minute; its level below sets when, and on which model.'),
          pick('monitor'),
          h('div', { class: 'row' }, h('span', { class: 'small muted' }, 'Daily cap'), budget, saveCap, h('span', { class: 'small muted grow' }, m.budgetSet ? ['Yours, at every level · ', h('button', { type: 'button', class: 'link small', onclick: HX.act(async () => { await HX.post('/api/helix/settings', { monitorBudget: null }); HX.toast('The monitor stops at its level’s cap.'); }) }, `use ${MONITOR_LEVEL[m.level][0]}’s ${F.usd(level.presetCapUsd).replace('.00', '')}`)] : `${MONITOR_LEVEL[m.level][0]}’s cap`)),
          h('div', { class: 'small muted' }, `${F.usd(m.spentUsd)} spent today; it stops at the cap, and Home says so.`),
          h('div', { class: 'row' },
            HX.btn(m.enabled ? 'Turn the monitor off' : 'Turn the monitor on', HX.act(async () => {
              if (!m.enabled && !(await HX.confirm('Turn Helix’s monitor on?', [h('p', null, `On ${MONITOR_LEVEL[m.level][0]}, each turn draws on ${HX.AGENT[m.agent]}’s subscription, the same one the builders use: ${level.capped ? `$${m.budgetUsd} a day, its cap, at today’s pace` : `${PER_DAY(level)} at today’s pace, never more than $${m.budgetUsd} a day`} at list price.`), h('p', { class: 'muted' }, 'On Auto-pilot it then resolves requests and applies fixes the pilot level allows, each as a commit you can undo for a day.')], 'Turn it on'))) return;
              await HX.post('/api/helix/settings', { monitorEnabled: !m.enabled });
              HX.toast(m.enabled ? 'The monitor is off.' : 'The monitor is on.');
            }), m.enabled ? 'btn-secondary' : 'btn-primary'),
            m.enabled ? HX.btn('Run a turn now', HX.act(async () => { await HX.post('/api/helix/watch'); HX.toast('The monitor is taking a turn.'); }), 'btn-ghost') : null))),
      h('div', { class: 'stack' },
        h('div', { class: 'row' }, h('h6', { class: 'cap grow' }, 'How closely the monitor watches'), HX.seg(MONITOR_LEVELS.map((v) => [v, MONITOR_LEVEL[v][0]]), m.level, setLevel)),
        h('div', { class: 'cards3' }, est.levels.map((x) => h('div', { class: `glass modecard${x.level === m.level ? ' on' : ''}`, onclick: () => setLevel(x.level) },
          h('div', { class: 'row' }, h('b', { class: 'grow', style: { fontSize: '15px', fontWeight: 500 } }, MONITOR_LEVEL[x.level][0]), x.level === 'light' ? h('span', { class: 'small muted' }, 'default') : null),
          h('div', { class: 'soft small grow' }, LEVEL_TEXT[x.level](x)),
          h('div', { class: 'levelcost' }, h('span', { class: x.capped ? 't-warn' : '' }, PER_DAY(x)), h('span', { class: 'small muted' }, x.capped ? 'its cap: it would stop early' : 'at today’s pace')),
          h('div', { class: 'small muted' }, `${MODEL(x.model)} · ${x.effort} · ${F.plural(x.turns, 'turn')}${x.heartbeats ? `, ${x.heartbeats} on the clock` : ''}`)))),
        h('p', { class: 'small muted', style: { margin: 0 } }, `What each level would have spent on ${HX.AGENT[est.agent]} over the loop’s last 24 hours (${F.plural(est.passes, 'pass', 'passes')}, ${est.issues ? F.plural(est.issues, 'builder issue') : 'no builder issues'}), at list price${est.levels.every((x) => x.measured) ? '' : '; a turn’s cost is estimated until the monitor has run on that model'}. Whatever the level, what you ask for runs: a human task done, Ask Helix to revise, Run a turn now.`)),
      h('div', { class: 'stack' }, h('h6', { class: 'cap' }, 'Prompts'), h('p', { class: 'small muted', style: { margin: 0 } }, 'A preset per role and level, shipped with the app. An edit is saved beside its preset (.helix/helix/prompts/<name>.local.md, in git) until you reset it.'),
        d.prompts.map((p) => {
          const ta = h('textarea', { class: 'input mono', rows: 6 });
          ta.value = X.drafts[`prompt:${p.name}`] ?? p.text;
          ta.oninput = () => (X.drafts[`prompt:${p.name}`] = ta.value);
          return h('details', { class: 'glass pad' }, h('summary', { class: 'row', style: { cursor: 'pointer' } }, h('b', { style: { fontWeight: 500 } }, p.role === 'assistant' ? 'Assistant' : `Monitor · ${p.level.replace('-', ' · ').replace(/\b\w/g, (c) => c.toUpperCase())}`), p.edited ? HX.tag('edited', 'tag-accent') : null),
            h('div', { class: 'stack', style: { marginTop: '8px' } }, ta, h('div', { class: 'row' }, h('span', { class: 'grow' }), p.edited ? HX.btn('Reset to preset', HX.act(async () => { await HX.post('/api/prompt', { name: p.name, reset: true }); delete X.drafts[`prompt:${p.name}`]; }), 'btn-ghost sm') : null, HX.btn('Save', HX.act(async () => { await HX.post('/api/prompt', { name: p.name, text: ta.value }); delete X.drafts[`prompt:${p.name}`]; HX.toast('Saved.'); }), 'btn-secondary sm'))));
        })));
  }

  // ---- Releases ----
  function releases(d) {
    return h('div', { class: 'page stack lg', style: { maxWidth: '980px' } },
      head('Releases', `Each lane is tagged every ${F.plural(d.releaseEvery, 'merged task')}, or when a stage closes with unreleased work. A release that changes ${d.reviewPaths.join(' or ')} waits for you, at every pilot level.`),
      d.releases.map((r) => h('div', { class: 'glass pad stack' },
        h('div', { class: 'row' }, h('b', { style: { fontWeight: 500, color: HX.laneColor(r.repo) } }, r.repo), h('span', { class: 'grow' }), h('span', { class: 'muted' }, `${F.plural(r.unreleased, 'task')} unreleased`)),
        r.holds.map((x) => h('div', { class: 'small t-warn' }, x)),
        r.approvals.map((a) => h('div', { class: 'row' }, HX.tag('waits for you', 'tag-crit'), h('span', { class: 'grow' }, `${a.tag} changes ${F.plural(a.paths.length, 'reviewed file')} since ${a.since}`), h('a', { class: 'btn btn-primary', href: '#home/release' }, 'Review diffs'))),
        r.unreleased && !r.approvals.length ? h('div', null, HX.btn('Release now', HX.act(async () => {
          if (!(await HX.confirm(`Release ${r.repo}`, h('p', null, `Tags ${r.repo}'s main as a release now and pushes the tag, through the same holds as the loop's own releases. A tag deploys to production.`), 'Release', true))) return;
          await HX.post('/api/release', { repo: r.repo });
          HX.toast(`Releasing ${r.repo}: see Loop controls › Commands.`);
        }))) : null)),
      h('div', { class: 'small muted' }, 'Release cadence and the reviewed paths are under ', h('a', { href: '#settings/loop' }, 'Loop controls › Safety and releases'), '.'));
  }

  // ---- Spec and TaskSet (spec §13) ----
  const HARNESS = { claude: ['Claude Code', '~/.claude/skills/helix'], codex: ['Codex', '~/.codex/skills/helix'], opencode: ['OpenCode', '~/.config/opencode/skills/helix'], any: ['Any agent', '~/skills/helix'] };
  function taskset(d) {
    const t = d.taskset;
    const k = d.skill;
    const [, dir] = HARNESS[X.harness];
    const cmd = `helix-loop skill install --to ${dir}`;
    const path = h('input', { class: 'input mono', placeholder: '/path/to/plan-folder or taskset.zip', value: X.drafts.importPath ?? '' });
    path.oninput = () => (X.drafts.importPath = path.value);
    const jobs = [...S.jobs.values()].filter((j) => /TaskSet/.test(j.title)).slice(0, 2);
    const okTag = (ok, warn, text) => HX.tag(text, ok ? 'tag-ok' : warn ? 'tag-warn' : 'tag-crit');
    return h('div', { class: 'page stack lg', style: { maxWidth: '1240px' } },
      head('Spec and TaskSet', 'A loop starts from a Helix Spec, the technical and design specification, which a harness breaks down into a Helix TaskSet: every task in Lane › Epic › Task order, with its dependencies, ready for the loop.'),
      h('div', { class: 'glass step3' },
        h('div', null, h('div', { class: 'row' }, h('span', { class: 'mono small muted' }, '01'), h('b', { style: { fontSize: '16px', fontWeight: 500 } }, 'Helix Spec'), okTag(t.plans.spec, false, t.plans.spec ? 'in spec/' : 'missing')), h('div', null, t.plans.clarifications ? 'Clarifications wait to be folded in' : 'No clarification waiting'), h('div', { class: 'small muted' }, 'spec/ · the loop engineer applies changes with you'), h('div', { class: 'row' }, h('span', { class: 'small muted' }, 'Re-harden it with /helix harden'))),
        h('div', null, h('div', { class: 'row' }, h('span', { class: 'mono small muted' }, '02'), h('b', { style: { fontSize: '16px', fontWeight: 500 } }, 'Helix TaskSet'), okTag(!t.problems, false, t.problems ? `${t.problems} problems` : 'valid')), h('div', null, `${t.lanes} lanes · ${t.epics} epics · ${F.n(t.tasks)} tasks · ${t.human} human tasks`), h('div', { class: 'small muted' }, `plan/ · ${t.file ? 'plan/taskset.yaml' : 'epics derived'}`), h('div', { class: 'row' }, h('a', { class: 'btn btn-secondary sm', href: '#map' }, 'Open on map'), HX.btn('Export', HX.act(async () => { await HX.post('/api/export', { what: 'render' }); HX.toast('Rendering the plan documents…'); }), 'btn-ghost sm'))),
        h('div', null, h('div', { class: 'row' }, h('span', { class: 'mono small muted' }, '03'), h('b', { style: { fontSize: '16px', fontWeight: 500 } }, 'Helix Loop'), okTag(t.running, true, t.running ? 'running' : 'stopped')), t.codeFinish != null ? [h('div', null, `${F.n(t.merged)} of ${F.n(t.tasks)} merged`), h('div', { class: 'small' }, `Code complete ${F.day(t.codeFinish)} · project complete ${F.day(t.finish)}`)] : h('div', null, `${F.n(t.merged)} of ${F.n(t.tasks)} merged · finish ${F.day(t.finish)}`), h('div', { class: 'small muted' }, 'Builds from the TaskSet; changes come back as new revisions'), h('div', { class: 'row' }, h('a', { class: 'btn btn-secondary sm', href: '#settings/loop' }, 'Loop controls')))),
      h('div', { class: 'cards2', style: { alignItems: 'start' } },
        h('div', { class: 'glass pad stack', style: { boxShadow: 'inset 0 0 0 1px var(--color-accent-700), var(--shadow-sm)' } },
          h('div', { class: 'row' }, h('span', { class: 'helixnote', style: { padding: '0', background: 'none', boxShadow: 'none' } }, h('span', { class: 'ring', style: { width: '30px', height: '30px' } })), h('div', { class: 'grow' }, h('b', { style: { fontSize: '17px', fontWeight: 500 } }, 'The Helix skill'), h('div', { class: 'soft' }, 'Gives any agent harness the guidelines to write a Helix Spec and break it down into a Helix TaskSet this loop can run.')), HX.tag(`v${k.version} · ${Math.round(k.bytes / 1024)} KB`, 'tag-mono')),
          h('div', { class: 'row' }, h('span', { class: 'muted' }, 'For'), HX.seg(Object.entries(HARNESS).map(([key, [l]]) => [key, l]), X.harness, (v) => { X.harness = v; render(); })),
          h('div', { class: 'codebox row', style: { whiteSpace: 'nowrap' } }, h('span', { class: 'grow ell' }, `$ ${cmd}`), h('button', { type: 'button', class: 'link small', onclick: HX.act(async () => { await navigator.clipboard.writeText(cmd); HX.toast('Copied.'); }) }, 'Copy')),
          h('div', { class: 'row' },
            HX.btn('Install it there', HX.act(async () => { const r = await HX.post('/api/skill/install', { dir }); HX.toast(`Installed ${r.files.length} files in ${dir}.`); }), 'btn-primary'),
            HX.btn('Build helix-skill.zip', HX.act(async () => { const r = await HX.post('/api/skill/pack'); HX.toast(`Wrote ${r.file} (${Math.round(r.bytes / 1024)} KB).`); })),
            HX.btn('Read SKILL.md', HX.act(async () => { const text = await HX.api('/api/skill/file', { name: 'SKILL.md' }); await HX.dialog('SKILL.md', h('div', { class: 'codebox', style: { maxHeight: '60vh' } }, text), [{ label: 'Close', value: 'close' }]); }), 'btn-ghost')),
          h('div', { class: 'cards2', style: { gap: '18px' } },
            h('div', { class: 'stack', style: { gap: '6px' } }, h('h6', { class: 'cap' }, 'What it asks the agent to do'),
              [['/helix spec', 'Interview you, then write the technical and design spec with numbered requirements and acceptance criteria'], ['/helix harden', 'Find the gaps and ambiguities a builder would ask about, before any task exists'], ['/helix taskset', 'Break it down into lanes, epics and atomic tasks, each one pass and one gate, plus the human tasks only you can do'], ['/helix validate', 'Check the TaskSet against the schema before you import it']].map(([c, t2]) => h('div', null, h('div', { class: 'mono t-acc' }, c), h('div', { class: 'small soft' }, t2)))),
            h('div', { class: 'stack', style: { gap: '2px' } }, h('h6', { class: 'cap' }, 'Inside the zip'), h('div', { class: 'mono small soft', style: { whiteSpace: 'pre' } }, treeOf(k.files))))),
        h('div', { class: 'stack lg' },
          h('div', { class: 'glass pad stack' },
            h('div', { class: 'row' }, h('b', { style: { fontSize: '15px', fontWeight: 500 } }, 'This loop’s TaskSet'), okTag(!t.problems, false, t.problems ? `${t.problems} problems` : '✓ valid'), h('span', { class: 'grow' }), h('span', { class: 'mono small muted' }, 'plan/')),
            h('div', { class: 'stat5' }, [[t.lanes, 'lanes'], [t.epics, 'epics'], [t.tasks, 'tasks'], [t.human, 'human tasks'], [t.deps, 'dependencies']].map(([v, l]) => h('div', null, h('div', { class: 'v' }, F.n(v)), h('div', { class: 'small muted' }, l)))),
            h('div', { class: 'stack', style: { gap: '3px' } }, t.checks.map((c) => h('div', { class: 'row top' }, h('span', { class: c.ok ? 't-ok' : c.warn ? 't-warn' : 't-crit' }, c.ok ? '✓' : '!'), h('span', { class: 'soft' }, c.text)))),
            t.file ? null : h('div', { class: 'row' }, HX.btn('Write .helix/plan/taskset.yaml', HX.act(async () => {
              if (!(await HX.confirm('Write the TaskSet', [h('p', null, 'Writes .helix/plan/taskset.yaml with one epic per lane and feature, and sets each task’s epic, in the real plan. Rename and merge epics afterwards by hand.'), h('p', { class: 'mono small' }, 'helix-loop taskset init')], 'Write it'))) return;
              await HX.post('/api/taskset/init');
            })), h('span', { class: 'small muted' }, 'helix-loop taskset init'))),
          h('div', { class: 'outline pad stack' },
            h('div', { class: 'row' }, h('b', { class: 'grow', style: { fontSize: '15px', fontWeight: 500 } }, 'Import a TaskSet'), h('span', { class: 'small muted' }, 'A plan folder or a zip')),
            path,
            h('div', { class: 'small muted' }, 'It is validated, then diffed against the running plan: tasks and epics added, dependencies changed, tasks removed (only tasks not yet started). Merged and running tasks are kept as they are.'),
            h('div', { class: 'row' },
              HX.btn('Check it', HX.act(async () => { await HX.post('/api/taskset/import', { path: path.value }); }), 'btn-secondary'),
              HX.btn('Try in dry run', HX.act(async () => { await HX.post('/api/taskset/import', { path: path.value, dry: true }); HX.toast('Written into a fresh dry run; start it from Loop controls with Dry run picked.'); })),
              HX.btn('Apply to the loop', HX.act(async () => {
                if (!(await HX.confirm('Apply the TaskSet', h('p', null, 'Writes it into the real plan as one commit. Merged and running tasks are kept as they are.'), 'Apply', true))) return;
                await HX.post('/api/taskset/import', { path: path.value, apply: true });
              }), 'btn-primary')),
            jobs.map(jobCard)))));
  }
  function treeOf(files) {
    const dirs = new Map();
    for (const f of files ?? []) {
      const [top, ...rest] = f.split('/');
      if (!rest.length) dirs.set(top, null);
      else dirs.set(`${top}/`, [...(dirs.get(`${top}/`) ?? []), rest.join('/')]);
    }
    return [...dirs].map(([d, kids]) => (kids ? `${d}\n${kids.slice(0, 6).map((k) => `  ${k}`).join('\n')}${kids.length > 6 ? `\n  … ${kids.length - 6} more` : ''}` : d)).join('\n');
  }
})();
