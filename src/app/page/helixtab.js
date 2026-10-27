// The Helix tab (spec §6.6): where Daniel reviews Helix's work. What it resolved on his behalf, the fixes waiting
// for him, the incidents and every change that can still be undone, and his conversations with it.
(() => {
  'use strict';
  const { h, fill, F, S } = HX;
  const X = { el: null, page: 'resolved', key: null, data: null, sort: 'unsure', filter: null, drafts: {} };
  const PAGES = [['resolved', 'Resolved for you'], ['fixes', 'Fixes to approve'], ['incidents', 'Incidents'], ['conversations', 'Conversations'], ['ask', 'Ask Helix']];

  HX.views.helix = {
    mount(el, parts) {
      X.el = el;
      take(parts);
      build();
      load();
    },
    route(parts) {
      take(parts);
      renderSide();
      render();
      if (X.key) loadThread();
    },
    async update(what) {
      if (what.has('logs') && what.size === 1) return;
      await load();
    },
    back() {
      if (X.key) {
        HX.go('#helix/conversations');
        return true;
      }
      return false;
    },
  };

  function take(parts) {
    X.page = PAGES.some(([p]) => p === parts[0]) ? parts[0] : 'resolved';
    X.key = X.page === 'conversations' && parts[1] ? parts[1] : null;
  }

  let B;
  function build() {
    B = { side: h('nav', { class: 'sidelist', 'aria-label': 'Helix' }), main: h('div', { class: 'pagewrap' }) };
    fill(X.el, B.side, B.main);
    renderSide();
  }

  async function load() {
    const since = X.since ?? undefined;
    X.data = await HX.api('/api/helix', since ? { since } : {});
    renderSide();
    render();
    if (X.key) loadThread();
  }

  function renderSide() {
    const d = X.data;
    const n = { resolved: d?.resolved.items.length, fixes: (d?.fixes.length ?? 0) + (d?.raised.length ?? 0), incidents: d?.incidents.filter((i) => i.open).length, conversations: d?.conversations.length };
    fill(B.side, PAGES.map(([p, label]) => h('a', { href: `#helix/${p}`, 'aria-current': X.page === p ? 'page' : null }, label, n[p] ? h('span', { class: 'n' }, F.n(n[p])) : null)));
  }

  function render() {
    if (!X.data) return fill(B.main, h('div', { class: 'page muted' }, 'Loading…'));
    const draw = { resolved, fixes, incidents, conversations, ask }[X.page];
    const keep = B.main.scrollTop;
    fill(B.main, draw(X.data));
    B.main.scrollTop = keep;
    HX.hydrateIcons(B.main);
  }

  // ---- Resolved for you (spec §7.4) ----
  const ACTIONS = { retry: 'Retries', park: 'Parks', quarantine: 'Quarantines', spec_answer: 'Spec answers', note: 'Notes', split: 'Splits', other: 'Other' };
  function resolved(d) {
    const r = d.resolved;
    const since = X.since ?? d.lastHome;
    let items = r.items.filter((i) => !X.filter || i.action === X.filter);
    items = [...items].sort((a, b) => X.sort === 'time' ? b.at.localeCompare(a.at) : X.sort === 'impact' ? (b.tasks?.length ?? 1) - (a.tasks?.length ?? 1) : a.confidence - b.confidence);
    const held = r.items.filter((i) => i.outcome.tone === 'ok' && !i.rating);
    const counts = {};
    for (const i of r.items) counts[i.action] = (counts[i.action] ?? 0) + 1;
    return h('div', { class: 'page stack lg' },
      h('div', { class: 'row top' },
        h('div', { class: 'pagehead grow' },
          h('h1', null, `Resolved for you${since ? ` · ${F.dayTime(Date.parse(since))} to now` : ''}`),
          h('p', null, r.items.length ? `${F.plural(r.items.length, 'HITL request')} that Active pilot · ${HX.LEVEL[S.state?.resolved.compared ?? 'prudent']} would have brought to you, recorded with how Helix resolved each. ${r.held} held up; ${r.undid} undid themselves; ${r.unsure} it marked unsure.` : 'Nothing yet: what Helix resolves on your behalf is recorded here, with what it would have asked you.')),
        held.length ? HX.btn(`Agree with the ${held.length} that held`, HX.act(async () => { await HX.post('/api/resolved', { ids: held.map((i) => i.id), rating: 'agree' }); HX.toast(`Agreed with ${held.length}.`); })) : null),
      h('div', { class: 'row wrap' },
        HX.seg([['unsure', 'Unsure first'], ['impact', 'By impact'], ['time', 'By time']], X.sort, (v) => { X.sort = v; render(); }),
        Object.entries(counts).map(([a, n]) => h('button', { type: 'button', class: `tag ${X.filter === a ? 'tag-accent' : 'tag-neutral'}`, style: { border: 0, cursor: 'pointer' }, onclick: () => { X.filter = X.filter === a ? null : a; render(); } }, `${ACTIONS[a] ?? a} ${n}`)),
        h('span', { class: 'grow' }),
        h('label', { class: 'small muted row' }, 'Since', h('input', { type: 'date', class: 'input', style: { width: 'auto' }, value: since ? since.slice(0, 10) : '', onchange: (e) => { X.since = e.target.value ? new Date(e.target.value).toISOString() : undefined; load(); } }))),
      items.length ? items.map(record) : h('div', { class: 'glass pad muted' }, 'No record matches.'));
  }

  function record(i) {
    const c = i.confidence;
    return h('div', { class: 'glass rec', 'data-jk': '', tabindex: '0' },
      h('div', { class: 'stack', style: { gap: '4px' } }, HX.tag(`${c >= 0.7 ? 'Sure' : 'Unsure'} · ${F.pct(c)}`, c >= 0.9 ? 'tag-ok' : c >= 0.7 ? 'tag-warn' : 'tag-crit'), h('span', { class: 'small muted' }, F.when(i.at))),
      h('div', { class: 'stack', style: { gap: '3px' } },
        h('b', { style: { fontWeight: 500 } }, i.chose),
        h('div', { class: 'soft' }, i.why),
        h('div', { class: 'would' }, h('b', null, 'Would have asked you: '), h('span', null, i.question)),
        i.tasks?.length ? h('div', { class: 'small' }, i.tasks.slice(0, 8).map((t, n) => [n ? ', ' : '', HX.taskLink(t, 'mono muted')])) : null),
      h('div', { class: i.outcome.tone === 'ok' ? 't-ok' : i.outcome.tone === 'warn' ? 't-warn' : 't-crit' }, i.outcome.text),
      i.rating ? h('span', { class: 'muted' }, { agree: 'You agreed', undo: 'You undid it', always_ask: 'Helix will ask' }[i.rating] ?? i.rating) : h('div', { class: 'row' },
        HX.btn('Agree', HX.act(async () => { await HX.post('/api/resolved', { id: i.id, rating: 'agree' }); }), 'btn-primary'),
        HX.btn('Undo', HX.act(async () => {
          if (!(await HX.confirm('Undo what Helix did?', h('p', null, `${i.chose}. Undoing reverses its plan change as a new commit, and the request comes back to you.`), 'Undo'))) return;
          await HX.post('/api/resolved', { id: i.id, rating: 'undo' });
          HX.toast('Undone; it waits for you on Home.');
        })),
        h('button', { type: 'button', class: 'link', onclick: HX.act(async () => { await HX.post('/api/resolved', { id: i.id, rating: 'always_ask' }); HX.toast(`Helix will always ask about "${i.name ?? i.request}".`); }) }, 'Always ask')));
  }

  // ---- Fixes to approve ----
  function fixes(d) {
    return h('div', { class: 'page stack lg' },
      h('div', { class: 'pagehead' }, h('h1', null, 'Fixes to approve'), h('p', null, 'Every fix Helix proposed and every request it brought you, as on Home, without the human tasks. Each applies as one commit you can undo for a day.')),
      d.raised.length ? h('div', { class: 'stack' }, h('h6', { class: 'cap' }, 'Helix asks you'), d.raised.map((r) => h('a', { class: 'glass pad row', href: `#home/${encodeURIComponent(`ask:${r.name}`)}`, style: { color: 'inherit' } }, HX.tag(r.name, 'tag-accent'), h('span', { class: 'grow ell' }, r.question), h('span', { class: 'small muted' }, `${r.options.length} options`)))) : null,
      d.fixes.length ? d.fixes.map((f) => h('div', { class: 'glass pad stack', 'data-jk': '', tabindex: '0' },
        h('div', { class: 'row' }, HX.tag(f.kind.replace('_', ' '), 'tag-neutral'), h('b', { class: 'grow ell', style: { fontWeight: 500, fontSize: '14px' } }, f.title), HX.tag(`${F.pct(f.fix.confidence)}`, f.fix.confidence >= 0.85 ? 'tag-ok' : f.fix.confidence >= 0.7 ? 'tag-warn' : 'tag-crit')),
        h('div', { class: 'soft' }, f.fix.summary, h('span', { class: 'muted' }, ` · ${F.plural(f.members, 'task')}`)),
        HX.changeList(f.fix.changes.slice(0, 6)),
        h('div', { class: 'row' },
          h('a', { class: 'btn btn-primary', href: `#home/${encodeURIComponent(`fix:${f.key}`)}` }, 'Review the evidence'),
          HX.btn('Accept and apply', HX.act(async () => { const r = await HX.post('/api/fix', { key: f.key, decision: 'accepted' }); HX.toast(`Applied: ${f.fix.summary}`, { undo: r.change?.id }); })),
          HX.btn('Decline', HX.act(async () => { await HX.post('/api/fix', { key: f.key, decision: 'declined' }); }), 'btn-ghost'))))
        : h('div', { class: 'glass pad muted' }, S.state?.helix.monitor.enabled ? 'No fix is waiting.' : "No fix is waiting. Helix's monitor proposes them, and it is off: turn it on in Settings › Helix."));
  }

  // ---- Incidents and the undo list ----
  function incidents(d) {
    const open = d.incidents.filter((i) => i.open);
    const closed = d.incidents.filter((i) => !i.open);
    const inc = (i) => h('div', { class: 'glass pad stack', style: { gap: '4px' }, 'data-jk': '', tabindex: '0' },
      h('div', { class: 'row' }, HX.tag(i.kind.replace('_', ' '), i.kind === 'flaky_test' || i.kind === 'gate_failure' ? 'tag-crit' : 'tag-neutral'), h('b', { class: 'grow ell', style: { fontWeight: 500 } }, i.title ?? i.cause), h('span', { class: 'small muted' }, `${F.plural(i.members.length, 'task')} · ${F.plural(i.failures, 'time')} · last ${F.when(i.last)}`)),
      i.title ? h('div', { class: 'small soft ell' }, i.cause) : null,
      h('div', { class: 'small' }, i.members.slice(0, 10).map((m, n) => [n ? ', ' : '', HX.taskLink(m.task, 'mono muted'), m.count > 1 ? h('span', { class: 'muted' }, ` ×${m.count}`) : null]), i.members.length > 10 ? h('span', { class: 'muted' }, ` and ${i.members.length - 10} more`) : null),
      h('div', { class: 'small' },
        i.filed ? ['The loop filed ', HX.taskLink(i.filed, 'mono'), ' to fix it. '] : null,
        i.fix ? [`Helix's fix ${i.fix.id}: ${i.fix.summary}`, i.decision ? h('span', { class: i.decision.decision === 'accepted' ? 't-ok' : 'muted' }, ` · ${i.decision.decision}`) : h('a', { href: `#home/${encodeURIComponent(`fix:${i.key}`)}` }, ' · review')] : !i.filed ? h('span', { class: 'muted' }, i.groupedBy === 'helix' ? 'Grouped by Helix.' : 'Grouped by its exact cause.') : null));
    return h('div', { class: 'page stack lg' },
      h('div', { class: 'pagehead' }, h('h1', null, 'Incidents'), h('p', null, 'Builder feedback with one cause, grouped: the same failing test or step, the same missing secret, the same requirement in question. Every change the app or Helix applied can be undone here for 24 hours.')),
      h('div', { class: 'stack' }, h('h6', { class: 'cap' }, `Changes you can undo · ${d.changes.length}`),
        d.changes.length ? h('div', { class: 'glass', style: { padding: '6px 14px' } }, d.changes.map((c) => h('div', { class: 'row', style: { padding: '6px 0', boxShadow: 'inset 0 -1px 0 var(--rule)' } },
          h('span', { class: 'mono small muted' }, c.id), h('span', { class: 'grow ell' }, c.what), h('span', { class: 'small muted' }, `${c.by} · ${F.when(c.at)}`), h('span', { class: 'mono small muted' }, c.commit.slice(0, 7)),
          c.undone ? h('span', { class: 'small muted' }, 'undone') : HX.btn('Undo', HX.act(async () => {
            if (!(await HX.confirm(`Undo ${c.id}?`, h('p', null, `${c.what}. Its tasks go back to what they were before, as a new commit. Refused if a later change touched them.`), 'Undo'))) return;
            await HX.post('/api/undo', { id: c.id });
            HX.toast('Undone.');
          }), 'btn-ghost sm'))))
          : h('div', { class: 'muted' }, 'Nothing applied in the last 24 hours.')),
      h('div', { class: 'stack' }, h('h6', { class: 'cap' }, `Open · ${open.length}`), open.length ? open.map(inc) : h('div', { class: 'muted' }, 'No open incident.')),
      closed.length ? h('div', { class: 'stack' }, h('h6', { class: 'cap' }, `Resolved this week · ${closed.length}`), closed.slice(0, 30).map(inc)) : null);
  }

  // ---- Conversations ----
  const label = (target) => {
    const [a, b] = target.split('~');
    return a.startsWith('S-') ? `Conversation ${a}` : b ? `${a} waits on ${b}` : a;
  };
  function conversations(d) {
    if (X.key) return threadView();
    const order = { daniel: 0, helix: 1 };
    const cs = [...d.conversations].sort((a, b) => (a.state === 'resolved') - (b.state === 'resolved') || (order[a.waitingOn] ?? 2) - (order[b.waitingOn] ?? 2) || b.at.localeCompare(a.at));
    const by = new Map();
    for (const c of cs) by.set(c.target, [...(by.get(c.target) ?? []), c]);
    return h('div', { class: 'page stack lg' },
      h('div', { class: 'row top' }, h('div', { class: 'pagehead grow' }, h('h1', null, 'Conversations'), h('p', null, 'Your threads with Helix, by what they are about: comments on tasks, and what you asked from Home, Live or here.')), h('a', { class: 'btn btn-primary', href: '#helix/ask' }, 'Ask Helix')),
      cs.length ? [...by].map(([target, list]) => h('div', { class: 'stack', style: { gap: '4px' } },
        h('h6', { class: 'cap' }, /^(T|HT)-/.test(target) ? HX.taskLink(target.split('~')[0], 'mono') : null, ' ', label(target)),
        list.map((c) => h('a', { class: 'glass row', href: `#helix/conversations/${encodeURIComponent(c.key)}`, style: { padding: '10px 14px', color: 'inherit' }, 'data-jk': '' },
          h('span', { class: `dot ${c.waitingOn === 'daniel' ? 'warn' : c.busy ? 'on' : ''}` }), h('span', { class: 'grow ell' }, c.first),
          h('span', { class: 'small muted' }, c.state === 'resolved' ? 'resolved' : c.busy ? 'answering' : c.waitingOn === 'daniel' ? 'your turn' : 'open'), h('span', { class: 'small muted' }, F.when(c.at))))))
        : h('div', { class: 'glass pad muted' }, 'No conversation yet. Comment on a task on the Map, or ask Helix anything from here.'));
  }

  async function loadThread() {
    const key = X.key;
    try {
      const t = await HX.api('/api/thread', { key });
      if (X.key !== key) return;
      X.thread = t;
    } catch (e) {
      X.thread = { error: e.message };
    }
    render();
  }

  function threadView() {
    const t = X.thread;
    if (!t || (t.key && t.key !== X.key)) return h('div', { class: 'page muted' }, 'Loading…');
    if (t.error) return h('div', { class: 'page t-crit' }, t.error);
    const busy = X.data.status.busy === t.key || X.data.status.queued.includes(t.key);
    const key = `thread:${t.key}`;
    const ta = h('textarea', { class: 'input', rows: 3, placeholder: 'Reply to Helix' });
    ta.value = X.drafts[key] ?? '';
    ta.oninput = () => (X.drafts[key] = ta.value);
    const send = HX.btn('Send', HX.act(async () => {
      if (!ta.value.trim()) return;
      await HX.post('/api/message', { key: t.key, text: ta.value });
      delete X.drafts[key];
      loadThread();
    }), 'btn-primary', { 'data-send-button': '' });
    const summary = t.replies.filter((r) => r.kind === 'summary').at(-1);
    return h('div', { class: 'page stack lg', style: { maxWidth: '860px' } },
      h('div', { class: 'crumb' }, h('a', { href: '#helix/conversations' }, HX.icon('arrow-left'), 'Conversations'), h('span', { class: 'sep' }, '/'), h('span', null, label(t.target)), HX.tag(t.state, t.state === 'resolved' ? 'tag-ok' : 'tag-accent'), /^(T|HT)-/.test(t.target) ? h('a', { href: `#map/${t.target.split('~')[0]}`, class: 'small' }, 'Open on the Map') : null),
      h('div', { class: 'thread stack' },
        h('div', { class: 'msg daniel' }, h('div', { class: 'small muted' }, `Daniel · ${F.when(t.root.at)}`), h('div', { style: { whiteSpace: 'pre-wrap' } }, t.root.text)),
        t.messages.map((m) => {
          if (m.kind === 'decision') return h('div', { class: 'small muted' }, `Daniel ${m.decision} the proposal${m.text ? `: ${m.text}` : '.'}`);
          if (m.kind === 'proposal') {
            const decided = t.messages.some((x) => x.kind === 'decision' && x.proposal === m.id);
            const task = m.task ?? {};
            return h('div', { class: 'msg helix stack' }, h('div', null, h('b', { style: { fontWeight: 500 } }, 'Proposed task: '), task.title ?? ''), h('div', { class: 'small soft' }, m.text),
              h('details', null, h('summary', { class: 'small' }, 'The task as proposed'), h('pre', { class: 'codebox' }, JSON.stringify(task, null, 2))),
              decided ? null : h('div', { class: 'row' }, HX.btn('Accept and create', HX.act(async () => { await HX.post('/api/proposal', { key: t.key, proposal: m.id, decision: 'accepted' }); loadThread(); }), 'btn-primary'), HX.btn('Decline', HX.act(async () => { await HX.post('/api/proposal', { key: t.key, proposal: m.id, decision: 'declined' }); loadThread(); }))));
          }
          return h('div', { class: `msg ${m.author}` }, h('div', { class: 'small muted' }, `${m.author === 'daniel' ? 'Daniel' : 'Helix'} · ${F.when(m.at)}`), h('div', { style: { whiteSpace: 'pre-wrap' } }, m.text));
        }),
        busy ? h('div', { class: 'muted row' }, h('span', { class: 'dot on' }), 'Helix is answering…') : null,
        t.state === 'resolved' && summary ? h('div', { class: 'glass pad' }, h('h6', { class: 'cap' }, 'Resolution'), summary.text) : null),
      h('div', { class: 'glass pad stack', 'data-send': '' }, ta, h('div', { class: 'row' }, h('span', { class: 'kbd grow' }, '⌘↩ sends'),
        t.state !== 'resolved' ? HX.btn('Resolve', HX.act(async () => { await HX.post('/api/resolve', { key: t.key }); loadThread(); }), 'btn-ghost', { title: 'Ask Helix to close the thread with a summary' }) : null, send)));
  }

  // ---- Ask Helix ----
  function ask() {
    const ta = h('textarea', { class: 'input', rows: 6, placeholder: '“Why is T-1200 blocked?” · “T-1200 shouldn’t wait on T-1180” · “Split T-0063 into tasks that fit one pass”' });
    ta.value = X.drafts.ask ?? '';
    ta.oninput = () => (X.drafts.ask = ta.value);
    const about = h('input', { class: 'input mono', placeholder: 'T-1200, HT-10 (optional)' });
    const send = HX.btn([HX.icon('paper-plane-tilt'), ' Ask'], HX.act(async () => {
      const t = await HX.post('/api/converse', { text: ta.value, about: about.value.split(/[\s,]+/).filter(Boolean) });
      delete X.drafts.ask;
      HX.go(`#helix/conversations/${encodeURIComponent(t.key)}`);
    }), 'btn-primary', { 'data-send-button': '' });
    return h('div', { class: 'page stack lg', style: { maxWidth: '760px' } },
      h('div', { class: 'pagehead' }, h('h1', null, 'Ask Helix'), h('p', null, `Anything about the loop. Helix reads the plan, the spec and the logs, and changes only what its tools allow, checked by the app. It runs as ${HX.AGENT[S.state?.helix.assistant] ?? 'Claude Code'}; a new task only exists once you accept it.`)),
      h('div', { class: 'glass pad stack', 'data-send': '' }, ta, h('div', { class: 'row' }, h('span', { class: 'small muted' }, 'About'), about, h('span', { class: 'grow' }), h('span', { class: 'kbd' }, '⌘↩ sends'), send)));
  }

  // ---- comments on a task, a human task or a dependency (spec §9.4), for the Map's panel ----
  HX.comments = (id, threads, deps) => {
    const targets = [id, ...(deps ?? []).map((d) => `${id}~${d}`)];
    const all = targets.flatMap((t) => (threads?.[t] ?? []).map((th) => ({ ...th, target: t })));
    const ta = h('textarea', { class: 'input', rows: 2, placeholder: `Comment on ${id}; Helix answers in a conversation` });
    const key = `comment:${id}`;
    ta.value = X.drafts[key] ?? '';
    ta.oninput = () => (X.drafts[key] = ta.value);
    const target = h('select', { class: 'input', style: { width: 'auto' } }, targets.map((t) => h('option', { value: t }, t.includes('~') ? `the dependency on ${t.split('~')[1]}` : id)));
    const send = HX.btn('Comment', HX.act(async () => {
      if (!ta.value.trim()) return;
      await HX.post('/api/comment', { target: target.value, text: ta.value });
      delete X.drafts[key];
      ta.value = '';
      HX.toast('Helix is answering in Helix › Conversations.');
    }), 'btn-secondary sm', { 'data-send-button': '' });
    return h('div', { class: 'stack' },
      h('h6', { class: 'cap' }, `Comments${all.length ? ` · ${all.length}` : ''}`),
      all.map((th) => h('div', { class: 'boxed stack', style: { gap: '4px' } },
        h('div', { class: 'small muted' }, `Daniel${th.target.includes('~') ? ` on the dependency on ${th.target.split('~')[1]}` : ''} · ${F.when(th.root.at)}`),
        h('div', { style: { whiteSpace: 'pre-wrap' } }, th.root.text),
        th.replies.map((r) => h('div', { class: `small ${r.kind === 'summary' ? 't-acc' : 'soft'}`, style: { paddingLeft: '10px', boxShadow: 'inset 2px 0 0 var(--color-divider)' } }, `${r.author === 'daniel' ? 'Daniel' : 'Helix'}: ${r.text}`)),
        h('a', { class: 'small', href: `#helix/conversations/${encodeURIComponent(th.key)}` }, `Full conversation → ${th.state === 'resolved' ? '(resolved)' : th.waitingOn === 'daniel' ? '(your turn)' : ''}`))),
      h('div', { class: 'stack', style: { gap: '4px' }, 'data-send': '' }, ta, h('div', { class: 'row' }, deps?.length ? target : null, h('span', { class: 'grow' }), send)));
  };
})();
