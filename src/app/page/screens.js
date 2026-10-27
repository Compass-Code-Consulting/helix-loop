// The screens a group's action opens (spec §6.3), full-page from Home with a breadcrumb back; Esc returns to Home
// with the group still open. Each loads the group's detail from the server and acts on all of it at once.
(() => {
  'use strict';
  const { h, fill, F, S } = HX;
  const X = { el: null, id: null, data: null, sel: null, kind: null, drafts: {}, side: null, panel: null };

  HX.screens = {
    active: () => !!X.id,
    async open(el, parts) {
      X.el = el;
      X.id = parts[0];
      X.sel = null;
      X.side = null;
      X.panel = h('aside', { class: 'panel', 'aria-label': 'Task detail' });
      fill(el, h('section', { class: 'screen' }, h('div', { class: 'muted' }, 'Loading…')));
      await load();
    },
    async update(what) {
      if (what.has('logs') && what.size === 1) return;
      await load(true);
    },
    close() {
      X.id = null;
      X.data = null;
      X.side = null;
    },
    // Esc closes the side panel before it leaves the screen.
    back() {
      if (!X.side) return false;
      side(null);
      return true;
    },
  };

  async function load(quiet) {
    const id = X.id;
    let d;
    try {
      d = await HX.api('/api/group', { id });
    } catch (e) {
      if (X.id !== id) return;
      // Everything in it was handled: back to Home, saying so.
      if (quiet) {
        HX.toast('That group is done.');
        return HX.go('#home');
      }
      return fill(X.el, h('section', { class: 'screen' }, crumb('Gone', 0), h('div', { class: 'glass pad soft' }, e.message)));
    }
    if (X.id !== id) return;
    X.data = d;
    const g = d.group;
    if (g.kind === 'resolved') return HX.go('#helix/resolved');
    const draw = { your_tasks: checklist, ask: asks, fix: acceptFix, questions: answerOnce, credential: secret, scope: splits, release: diffs, stopped, notices: stopped }[g.kind] ?? stopped;
    // A refresh keeps what is being written: the screen redraws only the parts that aren't being edited.
    const focused = X.el.contains(document.activeElement) && /^(TEXTAREA|INPUT)$/.test(document.activeElement.tagName);
    if (focused && quiet) return;
    fill(X.el, draw(d));
    HX.hydrateIcons(X.el);
    if (quiet && X.side) side(X.side.id);
  }

  // A task's detail beside the screen, as on the Map: opened from a task row, closed with × or Esc.
  async function side(id) {
    X.side = id ? { id, d: X.side?.id === id ? X.side.d : null } : null;
    for (const r of X.el.querySelectorAll('.urow')) {
      r.classList.toggle('open', r.dataset.id === id);
      r.firstChild.setAttribute('aria-expanded', String(r.dataset.id === id));
    }
    if (!id) return X.panel.remove();
    if (!X.panel.isConnected) X.el.append(X.panel);
    renderSide();
    try {
      const d = await HX.api('/api/task', { id });
      if (X.side?.id !== id) return;
      X.side.d = d;
    } catch (e) {
      if (X.side?.id !== id) return;
      X.side.d = { error: e.message };
    }
    renderSide();
  }
  function renderSide() {
    if (!X.side) return;
    const d = X.side.d;
    const head = h('div', { class: 'row' }, h('span', { class: 'grow' }), mapBtn(X.side.id),
      h('button', { type: 'button', class: 'iconbtn tip', 'data-tip': 'Close', 'aria-label': 'Close the panel', onclick: () => side(null) }, HX.icon('x')));
    const keep = X.panel.querySelector('.in')?.scrollTop ?? 0;
    const inn = h('div', { class: 'in' }, head, !d ? h('div', { class: 'muted' }, 'Loading…') : d.error ? h('div', { class: 't-crit' }, d.error) : HX.taskDetail(d));
    fill(X.panel, inn);
    inn.scrollTop = keep;
    HX.hydrateIcons(X.panel);
  }
  const mapBtn = (id) => h('button', { type: 'button', class: 'iconbtn tip', 'data-tip': 'View in Gantt Map', 'aria-label': `View ${id} in Gantt Map`, onclick: (e) => { e.stopPropagation(); HX.go(`#map/${id}`); } }, HX.icon('chart-bar-horizontal'));

  function crumb(title, n) {
    return h('div', { class: 'crumb' },
      h('a', { href: '#home' }, HX.icon('arrow-left'), 'Home'), h('span', { class: 'sep' }, '/'),
      h('span', { style: { fontWeight: 500 } }, title), n != null ? h('span', { class: 'num' }, F.n(n)) : null,
      h('span', { class: 'hint' }, 'Esc goes back · J / K moves between items'));
  }

  const lateText = (t) => {
    if (!t.latestStart) return null;
    const d = Math.round((Date.now() - t.latestStart) / 86_400_000);
    return d > 0 ? [`${d} d late`, 't-crit'] : [`due ${new Date(t.latestStart).toLocaleDateString(undefined, { weekday: 'short' })}`, 't-warn'];
  };

  // ---- 3a Open checklist: the human tasks on the critical path, biggest hold-up first ----
  function checklist(d) {
    const hs = d.human;
    if (!X.sel || !hs.some((x) => x.id === X.sel)) X.sel = hs[0]?.id;
    const t = hs.find((x) => x.id === X.sel);
    const max = Math.max(1, ...hs.map((x) => x.held));
    const doneCount = hs.filter((x) => x.status === 'done').length;
    const list = h('div', { class: 'stack', style: { gap: '6px' } },
      h('div', { class: 'row' }, h('span', { class: 'soft grow' }, 'Sorted by what each one holds up'), h('span', { class: 'small muted' }, `${doneCount} of ${hs.length} done`)),
      hs.map((x) => {
        const late = lateText(x);
        return h('button', { type: 'button', class: `pick glass${x.id === X.sel ? ' sel' : ''}`, 'data-jk': '', onclick: () => { X.sel = x.id; fill(X.el, checklist(d)); HX.hydrateIcons(X.el); } },
          h('div', { class: 'row top' }, h('span', { class: `circle ${x.status === 'done' ? 'done' : x.status === 'in_progress' ? 'prog' : ''}`, style: { marginTop: '10px' } }, x.status === 'done' ? '✓' : ''),
            h('div', { class: 'grow' },
              h('div', { class: 'row', style: x.id === X.sel ? { alignItems: 'baseline' } : null }, h('span', { class: 'mono small muted' }, x.id), x.id === X.sel ? h('span', { class: 'full', style: { fontWeight: 500 } }, x.title) : h('span', { class: 'ell', style: { fontWeight: 500 } }, shortTitle(x.title))),
              h('div', { class: 'row', style: { marginTop: '5px' } }, h('span', { class: 'minibar' }, h('i', { class: x.late ? 'crit' : '', style: { width: `${Math.max(4, (x.held / max) * 100)}%` } })), h('span', { class: 'small' }, `holds ${F.n(x.held)}`), late ? h('span', { class: `small ${late[1]}` }, late[0]) : null))));
      }),
      h('div', { class: 'grow' }),
      d.advice?.ids?.length && d.advice.gainMs > 3_600_000
        ? h('div', { class: 'advice' }, HX.icon('dna'), h('div', null, `Doing ${d.advice.ids.join(' and ')} today pulls ${S.state?.codeFinish != null ? 'project complete' : 'the finish'} back ${F.days(d.advice.gainMs)}, to ${F.day(d.advice.finish)}.`, waitsFine(d)))
        : null);
    return [h('section', { class: 'screen' }, crumb(d.group.title, hs.length), h('div', { class: 'split' }, list, t ? humanDetail(t, d) : h('div'))), X.side ? X.panel : null];
  }
  const shortTitle = (s) => s.replace(/\s*\((?:[^()]|\([^)]*\))*\)\s*$/, '');
  // Which of the rest can wait a day without moving the finish.
  function waitsFine(d) {
    const per = d.advice?.perTask ?? {};
    const fine = d.human.filter((x) => !d.advice.ids.includes(x.id) && per[x.id] !== undefined && per[x.id] < 3_600_000).slice(0, 2);
    return fine.length ? ` ${fine.map((x) => x.id).join(' and ')} can wait a day without moving it.` : '';
  }

  function humanDetail(t, d) {
    const late = lateText(t);
    const done = new Set(t.done);
    const stepsEl = h('div', { class: 'steps' }, t.steps.map((s, i) => h('label', { class: done.has(i + 1) ? 'done' : '' },
      h('input', { type: 'checkbox', checked: done.has(i + 1), onchange: HX.act(async (e) => {
        if (e.target.checked) done.add(i + 1);
        else done.delete(i + 1);
        e.target.parentElement.classList.toggle('done', e.target.checked);
        await HX.post('/api/human/action', { id: t.id, steps: [...done] });
      }) }),
      h('span', null, s))));
    const evidence = h('input', { class: 'input', placeholder: 'Team ID, a screenshot path, or a link' });
    evidence.value = X.drafts[`ev:${t.id}`] ?? '';
    evidence.oninput = () => (X.drafts[`ev:${t.id}`] = evidence.value);
    const perDay = d.advice?.perTask?.[t.id];
    const snoozeTo = new Date(Date.now() + 2 * 86_400_000);
    const unblocks = t.unblocks ?? [];
    return h('div', { class: 'glass detail scroll', style: { overflow: 'auto' } },
      h('div', { class: 'row wrap' }, HX.tag(t.id, 'tag-mono'), late ? HX.tag(late[0], late[1] === 't-crit' ? 'tag-crit' : 'tag-warn') : null, t.critical ? HX.tag('critical path', 'tag-accent') : null, HX.tag(`holds ${F.plural(t.held, 'task')}`, 'tag-neutral'), t.status !== 'todo' ? HX.statusTag(t.status) : null,
        h('span', { class: 'grow' }), perDay != null ? h('span', { class: 'small muted' }, perDay > 12 * 3_600_000 ? 'Each day it waits moves the finish a day' : perDay > 3_600_000 ? `Each day it waits moves the finish ${F.days(perDay)}` : 'A day’s wait doesn’t move the finish') : null, mapBtn(t.id)),
      h('h3', null, shortTitle(t.title)),
      h('div', { class: 'split even', style: { gap: '22px' } },
        h('div', { class: 'stack lg' },
          t.steps.length ? h('div', { class: 'stack', style: { gap: '4px' } }, h('h6', { class: 'cap' }, `Steps · ${done.size} of ${t.steps.length}`), stepsEl) : null,
          h('div', { class: 'boxed' }, h('h6', { class: 'cap', style: { marginBottom: '4px' } }, 'Done when'), h('div', null, t.done_check)),
          h('div', { class: 'stack', style: { gap: '4px' } }, h('label', { class: 'small muted' }, 'Evidence (optional)'), evidence),
          h('div', { class: 'row wrap' },
            t.status !== 'done' ? HX.btn([HX.icon('check'), ' Mark done'], HX.act(async () => {
              const ok = await HX.confirm(`Mark ${t.id} done?`, [h('p', null, t.done_check), evidence.value ? h('p', { class: 'muted' }, `Evidence: ${evidence.value}`) : null, h('p', { class: 'muted' }, `${F.plural(unblocks.filter((u) => u.status !== 'done').length, 'task')} waiting on it can then run.`)], 'Mark done');
              if (!ok) return;
              await HX.post('/api/human/action', { id: t.id, status: 'done', evidence: evidence.value });
              delete X.drafts[`ev:${t.id}`];
              HX.toast(`${t.id} is done.`);
            }), 'btn-primary') : HX.btn('Reopen', HX.act(async () => { await HX.post('/api/human/action', { id: t.id, status: 'todo' }); }), 'btn-secondary'),
            t.status === 'todo' ? HX.btn('Mark in progress', HX.act(async () => { await HX.post('/api/human/action', { id: t.id, status: 'in_progress', evidence: evidence.value }); HX.toast(`${t.id} is in progress.`); })) : null,
            t.status !== 'done' ? h('button', { type: 'button', class: 'link', onclick: HX.act(async () => {
              await HX.post('/api/human/action', { id: t.id, snooze: snoozeTo.toISOString() });
              HX.toast(`${t.id} snoozed until ${F.day(snoozeTo.getTime())}.`);
            }) }, `Snooze to ${snoozeTo.toLocaleDateString(undefined, { weekday: 'short' })}`) : null)),
        h('div', { class: 'stack lg' },
          t.handoff_prompt ? h('div', { class: 'stack', style: { gap: '4px' } },
            h('div', { class: 'row' }, h('h6', { class: 'cap grow' }, 'Handoff prompt'), h('button', { type: 'button', class: 'link small', onclick: HX.act(async () => { await navigator.clipboard.writeText(t.handoff_prompt); HX.toast('Copied the handoff prompt.'); }) }, HX.icon('copy'), ' Copy')),
            h('div', { class: 'codebox', style: { maxHeight: '260px' } }, t.handoff_prompt)) : null,
          h('div', { class: 'stack', style: { gap: '6px' } },
            h('h6', { class: 'cap' }, 'Unblocks when done'),
            unblocks.slice(0, 6).map((u) => h('div', { class: `urow${u.id === X.side?.id ? ' open' : ''}`, 'data-id': u.id },
              h('button', { type: 'button', class: 'urow-main', 'aria-expanded': String(u.id === X.side?.id), onclick: () => side(X.side?.id === u.id ? null : u.id) },
                h('span', { class: `circle ${u.status === 'done' ? 'done' : ''}` }), h('span', { class: 'mono small muted' }, u.id), h('span', { class: 'ttl' }, u.title)),
              mapBtn(u.id))),
            unblocks.length > 6 ? h('div', { class: 'muted' }, `+${unblocks.length - 6} more${t.held > unblocks.length ? `, and ${F.plural(t.held - unblocks.length, 'task')} behind them` : ''}`) : t.held > unblocks.length ? h('div', { class: 'muted' }, `and ${F.plural(t.held - unblocks.length, 'task')} behind them`) : null),
          h('p', { class: 'small muted', style: { margin: 0 } }, 'Builders never see your evidence; they read their tasks’ notes. When you mark it done, Helix adds what they need from it (an ID, never a secret) to the notes of the tasks waiting on it.'))));
  }

  // ---- Helix asks: requests Helix brought instead of deciding ----
  function asks(d) {
    const rs = d.raised ?? [];
    return h('section', { class: 'screen scroll', style: { overflow: 'auto' } }, crumb(d.group.title, rs.length),
      h('div', { class: 'stack lg', style: { maxWidth: '880px' } }, rs.map((r) => {
        const name = h('input', { class: 'input', value: r.name, style: { width: '260px' } });
        return h('div', { class: 'glass pad stack', 'data-jk': '', tabindex: '0' },
          h('div', { class: 'row' }, HX.tag(`${F.cap(r.request.replace('_', ' '))} · ${r.name}`, 'tag-accent'), r.tasks.map((id) => HX.taskLink(id, 'mono small muted')), h('span', { class: 'grow' }), h('span', { class: 'small muted' }, F.when(r.at))),
          h('div', { style: { fontSize: '15px', fontWeight: 500 } }, r.question),
          r.why ? h('div', { class: 'soft' }, r.why) : null,
          h('div', { class: 'row wrap' }, r.options.map((o, i) => HX.btn(o.label, HX.act(async () => {
            const ok = await HX.confirm(o.label, [h('p', null, r.question), changeList(o.changes)], 'Apply');
            if (!ok) return;
            const res = await HX.post('/api/ask/decide', { id: r.id, option: i });
            HX.toast(`Applied: ${o.label}.`, { undo: res.change?.id });
          }), i === r.recommend ? 'btn-primary' : 'btn-secondary', { title: i === r.recommend ? 'Helix would pick this' : '' }))),
          h('div', { class: 'row wrap', style: { paddingTop: '6px', boxShadow: 'inset 0 1px 0 var(--color-divider)' } },
            h('span', { class: 'muted' }, 'Worth asking you?'), h('span', { class: 'grow' }), h('span', { class: 'small muted' }, 'Kind'), name,
            HX.btn('▲ Keep asking', HX.act(async () => { await HX.post('/api/rate', { name: name.value, request: r.request, decide: 'ask', from: r.id }); HX.toast(`Helix will keep asking about "${name.value}".`); }), 'btn-secondary sm'),
            HX.btn('▼ Decide these yourself', HX.act(async () => { await HX.post('/api/rate', { name: name.value, request: r.request, decide: 'helix', from: r.id }); HX.toast(`Helix decides "${name.value}" from now on.`); }), 'btn-secondary sm')));
      })));
  }

  // A fix's plan changes, as a short diff.
  function changeList(changes) {
    return h('div', { class: 'changes glass', style: { padding: '6px 0' } }, changes.map((c) => {
      const [sign, cls, text] = c.op === 'new_task' ? ['+', 'add', `${c.task.title ?? 'new task'}${c.task.repo ? ` · ${HX.laneShort(c.task.repo)}` : ''}${c.task.estimate_passes ? ` · ${c.task.estimate_passes} pass` : ''}`]
        : c.op === 'hand_back' ? ['~', 'mod', `${c.task} handed back${c.note ? ` with a note: ${c.note}` : ''}`]
        : c.op === 'park' ? ['~', 'mod', `${c.task} parked${c.note ? `: ${c.note}` : ''}`]
        : c.op === 'note' ? ['~', 'mod', `${c.task} notes: ${c.note}`]
        : c.op === 'add_dep' ? ['+', 'add', `${c.task} waits on ${c.on}`]
        : c.op === 'remove_dep' ? ['−', 'mod', `${c.task} no longer waits on ${c.on}`]
        : c.op === 'pause' ? ['~', 'mod', 'pause new passes'] : ['~', 'mod', c.op];
      return h('div', { class: `c ${cls}` }, h('b', null, sign), h('span', { class: 'ell', title: text }, text));
    }));
  }

  // ---- 3c Accept fix: the evidence, the plan change and the alternatives ----
  function acceptFix(d) {
    const inc = d.incident;
    const fix = inc.fix;
    const tl = d.timeline;
    const max = Math.max(1, ...tl.counts);
    const conf = fix.confidence;
    const alts = [{ title: fix.summary, cost: 'Helix’s pick', chosen: true }, ...(fix.alternatives ?? [])];
    return h('section', { class: 'screen' }, crumb(d.group.title, inc.members.length),
      h('div', { class: 'split even' },
        h('div', { class: 'stack lg' },
          h('div', { class: 'glass pad stack' },
            h('div', { class: 'row' }, h('b', { class: 'grow', style: { fontSize: '16px', fontWeight: 500 } }, inc.title ?? inc.cause), h('span', { class: 'muted' }, `${F.plural(inc.failures, 'failure')} · ${F.plural(inc.members.length, 'task')} · since ${F.when(inc.first)}`)),
            h('div', { class: 'chart', title: 'Failures per hour' }, tl.counts.map((c) => h('i', { class: c ? '' : 'z', style: { height: `${(c / max) * 100}%` }, title: `${c}` }))),
            h('div', { class: 'row small muted' }, h('span', { class: 'grow' }, F.dayTime(tl.start)), h('span', null, 'now')),
            fix.evidence ? h('div', { class: 'soft' }, fix.evidence) : null),
          h('div', { class: 'statcards' },
            h('div', { class: 'glass' }, h('div', { class: 'v' }, F.n(inc.members.length)), h('div', { class: 'muted' }, 'tasks it failed')),
            h('div', { class: 'glass' }, h('div', { class: 'v' }, F.n(inc.failures)), h('div', { class: 'muted' }, 'failures in all')),
            h('div', { class: 'glass' }, h('div', { class: 'v' }, F.when(inc.last)), h('div', { class: 'muted' }, 'the latest'))),
          d.lastOutput?.text ? h('div', { class: 'glass pad stack' }, h('h6', { class: 'cap' }, `Last gate output · ${d.lastOutput.task} attempt ${d.lastOutput.attempt ?? ''}`), h('div', { class: 'codebox', style: { maxHeight: '220px' } }, d.lastOutput.text)) : null),
        h('div', { class: 'glass detail' },
          h('div', { class: 'row' }, HX.icon('dna', 't-acc'), h('b', { class: 'grow', style: { fontSize: '16px', fontWeight: 500 } }, 'What Helix would change'), HX.tag(`${conf >= 0.7 ? 'Sure' : 'Unsure'} · ${F.pct(conf)}`, conf >= 0.85 ? 'tag-ok' : conf >= 0.7 ? 'tag-warn' : 'tag-crit')),
          changeList(fix.changes),
          // The alternatives Helix weighed, with what each would cost; its pick is the one above.
          alts.length > 1 ? h('div', { class: 'stack', style: { gap: '2px' } }, h('h6', { class: 'cap' }, 'Or instead'), alts.map((a, i) => h('div', { class: 'radio-row' }, h('span', { class: `circle ${i === 0 ? 'prog' : ''}`, style: { marginTop: '3px' } }), h('span', null, h('b', { style: { fontWeight: 500 } }, a.title), h('span', { class: 'muted' }, ` · ${a.cost}`))))) : null,
          h('div', { class: 'grow' }),
          h('div', { class: 'row wrap' },
            HX.btn([HX.icon('check'), ' Accept and apply'], HX.act(async () => {
              const r = await HX.post('/api/fix', { key: inc.key, decision: 'accepted' });
              HX.toast(`Applied: ${fix.summary}`, { undo: r.change?.id });
              HX.go('#home');
            }), 'btn-primary'),
            HX.btn('Try in dry run', HX.act(async () => {
              await HX.post('/api/fix', { key: inc.key, decision: 'dry' });
              HX.toast('A dry run of the plan with this fix applied is starting. Switch to Dry run to watch it.');
            })),
            HX.btn('Ask Helix to revise', HX.act(async () => { await HX.post('/api/fix', { key: inc.key, decision: 'revise' }); HX.toast('Helix is looking at it again.'); }), 'btn-ghost'),
            HX.btn('Decline', HX.act(async () => { await HX.post('/api/fix', { key: inc.key, decision: 'declined' }); HX.toast('Declined.'); HX.go('#home'); }), 'btn-ghost'),
            h('span', { class: 'grow' }), h('span', { class: 'small muted' }, 'Undo for 24 h from Helix › Incidents')))));
  }

  // ---- 3b Answer once: what the builders asked, and one answer for all of them ----
  function answerOnce(d) {
    const inc = d.incident;
    const fix = inc.fix;
    const key = `ans:${inc.key}`;
    const ta = h('textarea', { class: 'input', rows: 8, placeholder: 'The answer every task in this group gets in its notes.' });
    ta.value = X.drafts[key] ?? fix?.answer?.text ?? '';
    ta.oninput = () => (X.drafts[key] = ta.value);
    const notes = h('input', { type: 'checkbox', checked: true });
    const spec = h('input', { type: 'checkbox', checked: !!inc.key.startsWith('spec:') });
    const rule = h('input', { type: 'checkbox' });
    const about = inc.key.startsWith('spec:') ? inc.key.slice(5) : 'this';
    const view = X.drafts.quoteView ?? 'quotes';
    const quotes = d.quotes.length ? d.quotes : inc.members.map((m) => ({ task: m.task, title: m.task, message: m.detail, at: m.last }));
    const send = HX.btn([HX.icon('paper-plane-tilt'), ` Send to ${F.plural(inc.members.length, 'task')}`], HX.act(async () => {
      const r = await HX.post('/api/answer', { key: inc.key, text: ta.value, notes: notes.checked, spec: spec.checked, rule: rule.checked });
      delete X.drafts[key];
      HX.toast(`Sent${r.clarification ? `, and added clarification ${r.clarification} to the spec's clarifications` : ''}.`, { undo: r.applied?.change?.id });
      HX.go('#home');
    }), 'btn-primary', { 'data-send-button': '' });
    return h('section', { class: 'screen' }, crumb(d.group.title, inc.members.length),
      h('div', { class: 'split even' },
        h('div', { class: 'stack' },
          h('div', { class: 'row' }, h('span', { class: 'soft grow' }, `What the builders asked${inc.groupedBy === 'helix' ? ' · grouped by Helix because they read the same requirement' : ''}`), HX.seg([['quotes', 'Quotes'], ['tasks', 'Tasks']], view, (v) => { X.drafts.quoteView = v; fill(X.el, answerOnce(d)); HX.hydrateIcons(X.el); })),
          view === 'quotes'
            ? quotes.slice(0, 30).map((q) => h('div', { class: 'glass quote', 'data-jk': '', tabindex: '0' }, h('div', { class: 'row' }, q.agent ? HX.badge(q.agent) : null, HX.taskLink(q.task, 'mono small muted'), h('span', { class: 'ell grow' }, q.title), h('span', { class: 'small muted' }, F.when(q.at))), h('div', { class: 'q' }, `“${q.message}”`)))
            : inc.members.map((m) => h('div', { class: 'row', style: { padding: '4px 0' } }, HX.taskLink(m.task, 'mono small muted'), h('span', { class: 'ell' }, m.detail))),
          quotes.length > 30 ? h('div', { class: 'muted' }, `+${quotes.length - 30} more asking the same thing`) : null),
        h('div', { class: 'glass detail', 'data-send': '' },
          h('div', { class: 'row' }, HX.icon('dna', 't-acc'), h('b', { class: 'grow', style: { fontSize: '16px', fontWeight: 500 } }, fix?.answer ? "Helix's draft answer" : 'Your answer'), fix ? HX.tag(`${fix.confidence >= 0.7 ? 'Sure' : 'Unsure'} · ${F.pct(fix.confidence)}`, fix.confidence >= 0.85 ? 'tag-ok' : fix.confidence >= 0.7 ? 'tag-warn' : 'tag-crit') : null),
          fix?.summary ? h('div', { class: 'soft' }, fix.summary) : h('div', { class: 'muted' }, S.state?.helix.monitor.enabled ? 'Helix hasn’t drafted one yet. Write it yourself, or ask Helix to.' : 'Helix’s monitor is off, so there is no draft: write the answer yourself.'),
          ta,
          fix?.answer?.sections?.length ? h('div', { class: 'chips' }, fix.answer.sections.map((s) => HX.tag(s, 'tag-outline'))) : null,
          h('div', { class: 'stack', style: { gap: '6px', paddingTop: '8px', boxShadow: 'inset 0 1px 0 var(--color-divider)' } },
            h('h6', { class: 'cap' }, 'Where it goes'),
            h('label', { class: 'check' }, notes, `Into the notes of all ${F.plural(inc.members.length, 'task')}, then hand them back to the loop`),
            h('label', { class: 'check' }, spec, `Into spec/clarifications.md as a clarification of ${about}, so new tasks read it too`),
            h('label', { class: 'check' }, rule, `Answer future questions about ${about} this way without asking`)),
          h('div', { class: 'grow' }),
          h('div', { class: 'row' }, send, HX.btn('Ask Helix to revise', HX.act(async () => { await HX.post('/api/fix', { key: inc.key, decision: 'revise' }); HX.toast('Helix is drafting it again.'); }), 'btn-secondary', { disabled: !fix }), h('span', { class: 'grow' }), h('span', { class: 'kbd' }, '⌘↩ sends')))));
  }

  // ---- Add the secret ----
  function secret(d) {
    const s = d.secret ?? {};
    const name = h('input', { class: 'input mono', value: s.name ?? '', placeholder: 'STRIPE_TEST_KEY' });
    const value = h('input', { class: 'input mono', type: 'password', autocomplete: 'off', placeholder: 'Pasted here, sent once, never shown again' });
    let where = 'github';
    const repo = h('select', { class: 'input' }, (s.repos?.length ? s.repos : S.state?.lanes ?? []).map((r) => h('option', { value: r }, r)));
    const env = h('input', { class: 'input mono', value: 'production', style: { width: '160px' } });
    const gh = h('div', { class: 'row wrap' }, h('span', { class: 'muted' }, 'Repository'), repo, h('span', { class: 'muted' }, 'Environment'), env);
    const whereBox = h('div');
    const pickWhere = (v) => {
      where = v;
      gh.hidden = v !== 'github';
      fill(whereBox, HX.seg([['github', 'GitHub environment secret'], ['keychain', 'macOS keychain']], v, pickWhere));
    };
    pickWhere('github');
    return h('section', { class: 'screen scroll', style: { overflow: 'auto' } }, crumb(d.group.title, d.group.members.length),
      h('div', { class: 'split' },
        h('div', { class: 'stack' },
          h('h6', { class: 'cap' }, 'Tasks stopped without it'),
          d.group.members.map((m) => h('div', { class: 'glass quote' }, h('div', { class: 'row' }, HX.taskLink(m.id, 'mono small muted'), h('span', { class: 'ell' }, m.title)), h('div', { class: 'small soft', style: { marginTop: '3px' } }, m.detail))),
          s.repos?.length ? h('div', { class: 'small muted' }, `Their prepare step: `, h('span', { class: 'mono' }, s.prepare?.[s.repos[0]] ?? '')) : null),
        h('div', { class: 'glass detail' },
          h('div', { class: 'row' }, HX.icon('key', 't-acc'), h('b', { style: { fontSize: '16px', fontWeight: 500 } }, 'Add the secret')),
          h('p', { class: 'soft', style: { margin: 0 } }, 'The value goes from this page straight to GitHub (gh secret set) or the keychain (security), on standard input. It is never written to a file, a log or a prompt, and never shown again.'),
          h('div', { class: 'stack', style: { gap: '4px' } }, h('label', { class: 'small muted' }, 'Name'), name),
          h('div', { class: 'stack', style: { gap: '4px' } }, h('label', { class: 'small muted' }, 'Where it belongs'), whereBox, gh),
          h('div', { class: 'stack', style: { gap: '4px' } }, h('label', { class: 'small muted' }, 'Value'), value),
          h('div', { class: 'row' }, HX.btn('Save and hand the tasks back', HX.act(async () => {
            const ok = await HX.confirm(`Save ${name.value}?`, [h('p', null, where === 'github' ? `As a GitHub secret of ${repo.value}${env.value ? `, environment ${env.value}` : ''}, with gh secret set.` : `In the macOS keychain, as "Helix Loop: ${name.value}".`), h('p', { class: 'muted' }, `Then ${F.plural(d.group.members.length, 'task')} go back to the loop.`)], 'Save it');
            if (!ok) return;
            const r = await HX.post('/api/secret', { name: name.value, value: value.value, where, repo: repo.value, env: env.value, tasks: d.group.members.map((m) => m.id) });
            value.value = '';
            HX.toast(`${r.saved} saved${r.handed ? `; ${F.plural(r.handed.tasks.length, 'task')} handed back` : ''}.`, { undo: r.handed?.change?.id });
            HX.go('#home');
          }), 'btn-primary')))));
  }

  // ---- Review splits: tasks that grew past twice their estimate ----
  function splits(d) {
    const ts = d.tasks ?? [];
    return h('section', { class: 'screen scroll', style: { overflow: 'auto' } }, crumb(d.group.title, ts.length),
      h('div', { class: 'stack lg', style: { maxWidth: '980px' } },
        h('p', { class: 'soft', style: { margin: 0 } }, 'Each of these has taken more than twice the passes it was planned for. Ask Helix to propose a split into tasks that fit one pass each, or hand it back with a note, or park it.'),
        ts.map((t) => h('div', { class: 'glass pad stack', 'data-jk': '', tabindex: '0' },
          h('div', { class: 'row' }, HX.taskLink(t.id, 'mono small muted'), h('b', { class: 'ell grow', style: { fontWeight: 500, fontSize: '14px' } }, t.title), HX.statusTag(t.status), HX.tag(`${t.attempts.length} passes · estimate ${t.estimate}`, 'tag-warn')),
          h('div', { class: 'stack', style: { gap: '2px' } }, t.attempts.slice(-4).map((a) => h('div', { class: 'row small' }, HX.badge(a.agent), h('span', { class: a.outcome === 'merged' ? 't-ok' : 't-crit' }, a.outcome.replace(/_/g, ' ')), h('span', { class: 'muted ell' }, a.note ?? ''), h('span', { class: 'grow' }), h('span', { class: 'muted' }, F.when(a.at))))),
          h('div', { class: 'row wrap' },
            HX.btn('Ask Helix for a split', HX.act(() => HX.askHelix([t.id], `Split ${t.id}`)), 'btn-primary'),
            HX.btn('Hand back with a note', HX.act(async () => {
              const note = await HX.prompt(`Hand back ${t.id}`, 'Your note goes into its notes for the next builder.', 'Hand back');
              if (note === null) return;
              const r = await HX.post('/api/task/action', { id: t.id, action: 'hand_back', note });
              HX.toast(`${t.id} handed back.`, { undo: r.change?.id });
            })),
            HX.btn('Park', HX.act(async () => { await HX.post('/api/task/action', { id: t.id, action: 'park' }); HX.toast(`${t.id} parked.`); }), 'btn-ghost'))))));
  }

  // ---- stopped tasks: why each stopped, and handing them back ----
  function stopped(d) {
    const ts = d.tasks ?? d.group.members.map((m) => ({ id: m.id, title: m.title, attempts: [] }));
    const sel = (X.sel && X.sel instanceof Set) ? X.sel : (X.sel = new Set(ts.map((t) => t.id)));
    return h('section', { class: 'screen scroll', style: { overflow: 'auto' } }, crumb(d.group.title, ts.length),
      h('div', { class: 'stack lg', style: { maxWidth: '1000px' } },
        h('div', { class: 'batchbar' }, h('span', { class: 'soft grow' }, d.group.cause), h('span', { class: 'small muted' }, `${sel.size} selected`),
          HX.btn('Hand back', HX.act(async () => {
            const note = await HX.prompt(`Hand back ${F.plural(sel.size, 'task')}`, 'They go back to ready, as one commit you can undo for a day. An optional note goes into each task’s notes.', 'Hand back');
            if (note === null) return;
            const r = await HX.post('/api/batch', { ids: [...sel], action: 'hand_back', note, group: d.group.id });
            HX.toast(`Handed back ${F.plural(r.tasks.length, 'task')}.`, { undo: r.change?.id });
          }), 'btn-ghost'),
          HX.btn('Park', HX.act(async () => { const r = await HX.post('/api/batch', { ids: [...sel], action: 'park', group: d.group.id }); HX.toast(`Parked ${F.plural(r.tasks.length, 'task')}.`, { undo: r.change?.id }); }), 'btn-ghost'),
          HX.btn('Ask Helix', HX.act(() => HX.askHelix([...sel], d.group.title)), 'btn-ghost')),
        ts.map((t) => h('div', { class: 'glass pad stack', 'data-jk': '', tabindex: '0' },
          h('div', { class: 'row' }, h('input', { type: 'checkbox', checked: sel.has(t.id), onchange: (e) => { e.target.checked ? sel.add(t.id) : sel.delete(t.id); } }), HX.taskLink(t.id, 'mono small muted'), h('b', { class: 'ell grow', style: { fontWeight: 500 } }, t.title), t.status ? HX.statusTag(t.status) : null),
          (t.attempts ?? []).map((a) => h('div', { class: 'row top small' }, HX.badge(a.agent), h('span', { class: ['merged'].includes(a.outcome) ? 't-ok' : 't-crit', style: { flex: 'none' } }, a.outcome.replace(/_/g, ' ')), h('span', { class: 'soft grow', style: { whiteSpace: 'pre-wrap' } }, a.note ?? ''), a.log ? h('a', { href: `#live/replay/${encodeURIComponent(a.log)}` }, 'Replay') : null))))));
  }

  // ---- 3d Review diffs: a release that touches production ----
  function diffs(d) {
    const rels = d.releases ?? [];
    if (!X.sel || !rels.some((r) => `${r.repo}@${r.tag}` === X.sel.rel)) X.sel = { rel: rels[0] ? `${rels[0].repo}@${rels[0].tag}` : null, file: null, read: false };
    const r = rels.find((x) => `${x.repo}@${x.tag}` === X.sel.rel);
    if (!r) return h('section', { class: 'screen' }, crumb(d.group.title, 0), h('div', { class: 'glass pad' }, 'Nothing is waiting for approval.'));
    if (!X.sel.file) X.sel.file = r.files[0]?.file;
    const diffBox = h('div', { class: 'diffbox', style: { flex: 1 } }, h('div', { class: 'muted', style: { padding: '12px' } }, 'Loading the diff…'));
    const file = r.files.find((f) => f.file === X.sel.file);
    HX.api('/api/release/file', { repo: r.repo, tag: r.tag, file: X.sel.file }).then((text) => fill(diffBox, diffLines(text))).catch((e) => fill(diffBox, h('div', { class: 't-crit', style: { padding: '12px' } }, e.message)));
    const reviewed = [...new Set(r.files.filter((f) => f.reviewed).map((f) => `${f.file.split('/')[0]}/`))];
    const read = h('input', { type: 'checkbox', checked: X.sel.read, onchange: (e) => { X.sel.read = e.target.checked; approve.disabled = !e.target.checked; } });
    const approve = HX.btn([HX.icon('warning'), ` Approve and tag ${r.tag}`], HX.act(async () => {
      await HX.post('/api/approve', { repo: r.repo, tag: r.tag, read: true });
      HX.toast(`Approving ${r.repo} ${r.tag}: the release command is running.`);
      HX.go('#home');
    }), 'btn-danger', { disabled: !X.sel.read });
    return h('section', { class: 'screen' }, crumb(d.group.title, rels.length),
      rels.length > 1 ? HX.seg(rels.map((x) => [`${x.repo}@${x.tag}`, `${x.repo} ${x.tag}`]), X.sel.rel, (v) => { X.sel = { rel: v, file: null, read: false }; fill(X.el, diffs(d)); HX.hydrateIcons(X.el); }) : null,
      h('div', { class: 'glass release' },
        h('aside', null,
          h('div', { class: 'cap t-crit' }, 'Deploys to production'),
          h('div', { style: { fontSize: '20px', fontWeight: 500 } }, `Approve ${r.repo} ${r.tag}`),
          h('div', { class: 'soft' }, `${F.plural(r.tasks.length, 'task')} since ${r.since.length === 40 ? 'the first commit' : r.since}${r.tasks.length ? ` · ${r.tasks.slice(0, 4).join(', ')}${r.tasks.length > 4 ? '…' : ''}` : ''}`),
          h('div', { class: 'prodwarn' }, `This release changes ${reviewed.join(' and ')}, which run with production’s secrets. The loop never tags these on its own, at any pilot level.`),
          h('h6', { class: 'cap', style: { marginTop: '6px' } }, 'Files · reviewed paths first'),
          h('div', { class: 'files' }, r.files.slice(0, 120).map((f) => h('button', { type: 'button', class: `${f.reviewed ? 'rev' : ''}${f.file === X.sel.file ? ' sel' : ''}`, onclick: () => { X.sel.file = f.file; fill(X.el, diffs(d)); HX.hydrateIcons(X.el); } }, h('span', { class: f.reviewed ? 'bang' : 'dim' }, f.reviewed ? '!' : '·'), h('span', { class: 'ell', title: f.file }, f.file), h('span', { class: 'dim' }, `+${f.added} −${f.deleted}`)))),
          r.total > 120 ? h('div', { class: 'small muted' }, `and ${r.total - 120} more files`) : null),
        h('section', null,
          h('div', { class: 'row', style: { padding: '10px 14px', boxShadow: 'inset 0 -1px 0 var(--color-divider)' } }, h('span', { class: 'mono' }, X.sel.file ?? ''), file?.reviewed ? HX.tag('reviewed path', 'tag-neutral') : null, h('span', { class: 'grow' }), file ? h('span', { class: 'mono small' }, h('span', { class: 't-ok' }, `+${file.added}`), ' ', h('span', { class: 't-crit' }, `−${file.deleted}`)) : null),
          diffBox,
          h('div', { class: 'row', style: { padding: '10px 14px', boxShadow: 'inset 0 1px 0 var(--color-divider)' } }, h('label', { class: 'check grow' }, read, `I've read the changes to ${reviewed.join(' and ')}`), HX.btn('Cancel', () => HX.go('#home')), approve))));
  }

  function diffLines(text) {
    const out = [];
    let n = 0;
    let inHunk = false;
    for (const l of text.split('\n').slice(0, 4000)) {
      const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(l);
      if (hunk) {
        n = Number(hunk[1]);
        inHunk = true;
        out.push(h('div', { class: 'l hunk' }, h('span', { class: 'no' }), h('span'), h('span', null, l)));
        continue;
      }
      // A file's header (and a commit's, from git show) until its first hunk.
      if (l.startsWith('diff --git')) inHunk = false;
      if (!inHunk || !/^[ +\-\\]/.test(l)) {
        out.push(h('div', { class: 'l meta' }, h('span', { class: 'no' }), h('span'), h('span', null, l)));
        continue;
      }
      const sign = l[0] === '+' ? '+' : l[0] === '-' ? '-' : ' ';
      out.push(h('div', { class: `l ${sign === '+' ? 'add' : sign === '-' ? 'del' : ''}` }, h('span', { class: 'no' }, sign === '-' ? '' : n), h('span', null, sign.trim()), h('span', null, l.slice(1))));
      if (sign !== '-') n++;
    }
    return out.length ? out : h('div', { class: 'muted', style: { padding: '12px' } }, 'No change in this file.');
  }
  HX.diffLines = diffLines;
  HX.changeList = changeList;
})();
