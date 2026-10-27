// Helix Loop's page core (spec §6): the shared pieces every view uses. One state object (HX.S) filled from the
// server's JSON; the server's change stream says what moved, and each view fetches only what it needs and
// redraws in place, keeping its scroll, selection and any text being written. Every string from the server goes
// into the page as text, never as markup. Views register in HX.views and are mounted by the router (the hash).
(() => {
  'use strict';
  const HX = (window.HX = { views: {} });
  HX.TOKEN = document.querySelector('meta[name="helix-token"]').content;
  const $ = (HX.$ = (id) => document.getElementById(id));

  // ---- DOM ----
  const isNode = (x) => typeof x === 'object' && x !== null && typeof x.nodeType === 'number';
  // h('div', { class, text, onclick, style, ...attrs }, ...children)
  const h = (HX.h = (tag, props, ...kids) => {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(props ?? {})) {
      if (v == null || v === false) continue;
      if (k === 'text') e.textContent = String(v);
      else if (k === 'class') e.className = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(e.style, v);
      else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
      else if (k in e && typeof v !== 'string') e[k] = v;
      else e.setAttribute(k, v === true ? '' : String(v));
    }
    for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false && kid !== '') e.append(isNode(kid) ? kid : document.createTextNode(String(kid)));
    return e;
  });
  HX.fill = (el, ...kids) => el.replaceChildren(...kids.flat(Infinity).filter((k) => k != null && k !== false && k !== '').map((k) => (isNode(k) ? k : document.createTextNode(String(k)))));
  // A Phosphor icon, drawn inline so it takes the text's colour.
  HX.icon = (name, cls = '') => {
    const i = h('i', { class: `ico ${cls}`, 'aria-hidden': 'true' });
    const inner = window.HELIX_ICONS?.[name];
    if (inner) i.innerHTML = `<svg viewBox="0 0 256 256" fill="currentColor">${inner}</svg>`;
    return i;
  };
  HX.hydrateIcons = (root = document) => {
    for (const el of root.querySelectorAll('i[data-icon]')) {
      const inner = window.HELIX_ICONS?.[el.dataset.icon];
      el.classList.add('ico');
      el.setAttribute('aria-hidden', 'true');
      if (inner) el.innerHTML = `<svg viewBox="0 0 256 256" fill="currentColor">${inner}</svg>`;
      el.removeAttribute('data-icon');
    }
  };
  HX.btn = (label, onclick, cls = 'btn-secondary', extra = {}) => h('button', { type: 'button', class: `btn ${cls}`, onclick, ...extra }, label);
  HX.seg = (options, value, onpick, cls = '') => h('div', { class: `seg ${cls}`, role: 'group' }, ...options.map(([v, label]) => h('button', { type: 'button', 'aria-pressed': String(v === value), onclick: () => onpick(v) }, label)));
  HX.tag = (text, cls = 'tag-neutral') => h('span', { class: `tag ${cls}` }, text);

  // ---- formatting ----
  const F = (HX.F = {});
  F.time = (iso) => (iso ? new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false }) : '');
  F.clock = (iso) => (iso ? new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }) : '');
  F.day = (ms) => new Date(ms).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
  F.dayTime = (ms) => `${new Date(ms).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })} ${new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false })}`;
  F.when = (iso) => {
    if (!iso) return '';
    const t = Date.parse(iso);
    const d = new Date(t);
    const today = new Date();
    return d.toDateString() === today.toDateString() ? F.time(iso) : `${d.toLocaleDateString(undefined, { weekday: 'short' })} ${F.time(iso)}`;
  };
  F.dur = (ms) => {
    if (!isFinite(ms) || ms < 0) return '–';
    const s = Math.round(ms / 1000);
    if (s < 60) return `${s} s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m} min ${String(s % 60).padStart(2, '0')} s`;
    const hh = Math.floor(m / 60);
    if (hh < 48) return `${hh} h ${String(m % 60).padStart(2, '0')} min`;
    return `${Math.floor(hh / 24)} d ${hh % 24} h`;
  };
  F.clockDur = (ms) => {
    const s = Math.max(0, Math.round(ms / 1000));
    const m = Math.floor(s / 60);
    return m >= 60 ? `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}` : `${m}:${String(s % 60).padStart(2, '0')}`;
  };
  F.days = (ms) => {
    const d = ms / 86_400_000;
    return d >= 1 ? `${Math.round(d)} d` : `${Math.max(1, Math.round(ms / 3_600_000))} h`;
  };
  F.since = (iso) => F.dur(Date.now() - Date.parse(iso));
  F.usd = (x) => `$${(x ?? 0).toLocaleString(undefined, { maximumFractionDigits: x >= 100 ? 0 : 2, minimumFractionDigits: x >= 100 ? 0 : 2 })}`;
  F.plural = (n, one, many = `${one}s`) => `${Number(n).toLocaleString()} ${n === 1 ? one : many}`;
  F.n = (n) => Number(n).toLocaleString();
  F.pct = (x) => `${Math.round(x * 100)}%`;
  F.cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : '');
  HX.AGENT = { claude: 'Claude Code', codex: 'Codex' };
  HX.BADGE = { claude: 'C', codex: 'X' };
  HX.PHASE = { setup: 'setting up', agent: 'working', gate: 'gating', merge: 'merging' };
  HX.LEVEL = { cautious: 'Cautious', prudent: 'Prudent', intrepid: 'Intrepid', yolo: 'YOLO' };
  HX.LANE_COLOR = { 'mushy-social-media': 'var(--lane-social)', 'mushy-website': 'var(--lane-website)', 'mushy-docs': 'var(--lane-docs)', 'mushy-support-n-engineering': 'var(--lane-support)' };
  HX.laneShort = (l) => (l ?? '').replace(/^mushy-/, '');
  HX.badge = (agent, big = false) => h('b', { class: `badge${big ? ' big' : ''}`, title: HX.AGENT[agent] ?? agent }, HX.BADGE[agent] ?? '?');
  // Times that tick: any element with data-since shows how long ago, refreshed every second.
  setInterval(() => {
    for (const el of document.querySelectorAll('[data-since]')) el.textContent = (el.dataset.fmt === 'clock' ? F.clockDur : F.dur)(Date.now() - Date.parse(el.dataset.since));
  }, 1000);
  HX.ticker = (iso, fmt) => h('span', { 'data-since': iso, 'data-fmt': fmt }, (fmt === 'clock' ? F.clockDur : F.dur)(Date.now() - Date.parse(iso)));

  // ---- storage: this viewer's conveniences in localStorage; the layout Daniel leaves in runs/app.yaml ----
  HX.store = {
    get: (k) => {
      try {
        return localStorage.getItem(`helix:${k}`);
      } catch {
        return null;
      }
    },
    set: (k, v) => {
      try {
        localStorage.setItem(`helix:${k}`, v);
      } catch {
        /* storage unavailable */
      }
    },
  };
  let uiTimer;
  const uiPending = {};
  HX.ui = (k, fallback) => HX.S.state?.ui?.[k] ?? fallback;
  HX.setUi = (k, v) => {
    if (HX.S.state) HX.S.state.ui = { ...(HX.S.state.ui ?? {}), [k]: v };
    uiPending[k] = v;
    clearTimeout(uiTimer);
    uiTimer = setTimeout(() => {
      const body = { ...uiPending };
      for (const key of Object.keys(uiPending)) delete uiPending[key];
      HX.post('/api/ui', body).catch(() => undefined);
    }, 400);
  };

  // ---- state ----
  const S = (HX.S = {
    root: HX.store.get('root') === 'dry' ? 'dry' : 'real',
    state: null,
    route: { tab: 'home', parts: [] },
    jobs: new Map(),
  });

  // ---- server ----
  HX.api = async (path, params = {}) => {
    const q = new URLSearchParams({ root: S.root, ...params });
    const r = await fetch(`${path}?${q}`);
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `${r.status}`);
    return (r.headers.get('content-type') ?? '').includes('json') ? r.json() : r.text();
  };
  HX.post = async (path, body = {}) => {
    const r = await fetch(`${path}?root=${S.root}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-helix-token': HX.TOKEN }, body: JSON.stringify(body) });
    const out = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(out.error ?? `${r.status}`);
    return out;
  };
  // Runs an action and says so when it fails: a refusal from the server is shown as it was given. The button
  // that started it is marked busy until it ends.
  HX.act = (fn) => async (ev, ...a) => {
    const b = ev?.currentTarget instanceof HTMLElement ? ev.currentTarget : null;
    b?.classList.add('busy');
    try {
      return await fn(ev, ...a);
    } catch (e) {
      HX.toast(e.message, { bad: true });
    } finally {
      b?.classList.remove('busy');
    }
  };

  let toastTimer;
  HX.toast = (msg, opts = {}) => {
    const t = $('toast');
    HX.fill(t, msg, opts.undo ? h('button', { type: 'button', class: 'link undo', onclick: HX.act(async () => { t.hidden = true; await HX.post('/api/undo', { id: opts.undo }); HX.toast('Undone.'); }) }, 'Undo') : null);
    t.classList.toggle('bad', !!opts.bad);
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.hidden = true), opts.bad ? 8000 : opts.undo ? 9000 : 3500);
  };
  // After a change that can be undone, say what changed and offer Undo.
  HX.changed = (r, what) => HX.toast(`${what}${r?.change ? '' : ''}`, { undo: r?.change?.id });

  // A dialog: content, and buttons that resolve with their value.
  HX.dialog = (title, body, buttons = []) => {
    const d = $('dialog');
    $('dlg-title').textContent = title;
    HX.fill($('dlg-body'), body);
    HX.fill($('dlg-foot'), ...buttons.map((b) => h('button', { class: `btn ${b.class ?? 'btn-secondary'}`, value: b.value }, b.label)));
    d.returnValue = '';
    d.showModal();
    return new Promise((resolve) => d.addEventListener('close', () => resolve(d.returnValue), { once: true }));
  };
  HX.confirm = async (title, body, label, danger = false) => (await HX.dialog(title, body, [{ label: 'Cancel', value: 'cancel' }, { label, value: 'ok', class: danger ? 'btn-danger' : 'btn-primary' }])) === 'ok';
  // A dialog asking for text, such as a note; resolves with it, or null when cancelled.
  HX.prompt = async (title, intro, label, opts = {}) => {
    const ta = h('textarea', { class: 'input', rows: opts.rows ?? 4, placeholder: opts.placeholder ?? '' });
    ta.value = opts.value ?? '';
    const ok = await HX.dialog(title, [intro ? h('p', { class: 'soft', style: { margin: 0 } }, intro) : null, ta], [{ label: 'Cancel', value: 'cancel' }, { label, value: 'ok', class: 'btn-primary' }]);
    return ok === 'ok' ? ta.value.trim() : null;
  };

  // ---- the top bar ----
  HX.renderTop = () => {
    const s = S.state;
    if (!s) return;
    $('n-home').textContent = s.counts?.home ? F.n(s.counts.home) : '';
    $('n-live').textContent = s.counts?.live ? String(s.counts.live) : '';
    $('n-helix').textContent = s.counts?.helix ? String(s.counts.helix) : '';
    $('loopname').textContent = s.dryRun ? `${s.name} · dry run` : s.name;
    const p = s.pilot;
    $('pilot').textContent = p ? (p.mode === 'auto' ? `Auto-pilot · ${HX.LEVEL[p.auto_level]}` : `Active pilot · ${HX.LEVEL[p.active_level]}`) : '';
    const l = s.loop;
    const both = s.agents.filter((a) => a.enabled).length === 2;
    const text = !l.running ? 'Stopped' : l.stopping ? 'Stopping' : s.paused ? 'Paused · passes finishing' : l.mode === 'paused' ? 'Waiting · both agents at their limits' : l.mode.startsWith('single') ? `Running · ${HX.AGENT[l.mode.split(':')[1]]} only` : `Running · ${both ? 'both agents' : HX.AGENT[s.agents.find((a) => a.enabled)?.name] ?? ''}`;
    const st = $('loopstate');
    st.querySelector('.dot').className = `dot ${l.running && !l.stopping && !s.paused && l.mode !== 'paused' ? 'on' : l.running ? 'warn' : ''}`;
    st.querySelector('span').textContent = text;
    for (const b of $('roots').children) b.setAttribute('aria-pressed', String(b.dataset.root === S.root));
    document.title = `${s.counts?.home ? `(${s.counts.home}) ` : ''}Helix Loop${s.dryRun ? ' · dry run' : ''}`;
  };

  // ---- the router: #tab/part/part ----
  let mounted = null;
  HX.go = (hash) => {
    if (location.hash === hash) route();
    else location.hash = hash;
  };
  function route() {
    const [tab = 'home', ...parts] = location.hash.replace(/^#\/?/, '').split('/').map(decodeURIComponent);
    const name = HX.views[tab] ? tab : 'home';
    for (const a of $('tabs').querySelectorAll('a')) a.toggleAttribute('aria-current', a.dataset.tab === name) && a.setAttribute('aria-current', 'page');
    $('tabs').classList.remove('open');
    const same = mounted && mounted.name === name;
    S.route = { tab: name, parts };
    if (same && mounted.view.route) return mounted.view.route(parts);
    mounted?.view.unmount?.();
    const el = h('div', { class: 'view' });
    $('main').replaceChildren(el);
    mounted = { name, view: HX.views[name], el };
    mounted.view.mount(el, parts);
  }
  window.addEventListener('hashchange', route);
  HX.route = route;
  HX.current = () => mounted;

  // ---- live updates ----
  const want = { state: false, what: new Set() };
  let refreshTimer;
  HX.refresh = (what = []) => {
    want.state = true;
    for (const w of what) want.what.add(w);
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(run, 120);
  };
  async function run() {
    const what = new Set(want.what);
    want.what.clear();
    want.state = false;
    try {
      S.state = await HX.api('/api/state');
      for (const j of S.state.jobs ?? []) S.jobs.set(j.id, j);
      HX.renderTop();
    } catch (e) {
      console.error(e);
    }
    try {
      await mounted?.view.update?.(what);
    } catch (e) {
      console.error(e);
    }
  }
  HX.connect = () => {
    const es = new EventSource('/events');
    es.addEventListener('hello', () => {
      $('conn').hidden = true;
      HX.refresh(['all']);
    });
    es.addEventListener('changed', (ev) => {
      const d = JSON.parse(ev.data);
      if (d.root !== S.root) return;
      HX.refresh(d.what);
    });
    es.addEventListener('job', (ev) => {
      const j = JSON.parse(ev.data);
      S.jobs.set(j.id, j);
      mounted?.view.job?.(j);
      if (j.status !== 'running') HX.toast(`${j.title}: ${j.status === 'done' ? 'done' : `failed${j.code != null ? ` (exit ${j.code})` : ''}`}`, { bad: j.status === 'failed' });
    });
    es.addEventListener('helix', () => HX.refresh(['helix']));
    es.onerror = () => {
      $('conn').hidden = false;
    };
  };

  // ---- the keyboard: J / K move between items, Enter opens, Esc goes back, ⌘↩ sends ----
  document.addEventListener('keydown', (e) => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable;
    if (e.key === 'Escape' && !$('dialog').open) {
      if (typing) return e.target.blur();
      if (mounted?.view.back?.()) e.preventDefault();
      return;
    }
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      const form = e.target.closest?.('[data-send]');
      const b = form?.querySelector('[data-send-button]');
      if (b && !b.disabled) {
        e.preventDefault();
        b.click();
      }
      return;
    }
    if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === 'j' || e.key === 'k') {
      const items = [...(mounted?.el.querySelectorAll('[data-jk]') ?? [])].filter((x) => x.offsetParent);
      if (!items.length) return;
      const at = items.indexOf(document.activeElement?.closest('[data-jk]'));
      const next = items[Math.max(0, Math.min(items.length - 1, at < 0 ? 0 : at + (e.key === 'j' ? 1 : -1)))];
      next.focus();
      next.scrollIntoView({ block: 'nearest' });
      e.preventDefault();
    }
  });

  // ---- the roots and the menu ----
  for (const b of $('roots').children) {
    b.onclick = () => {
      if (b.dataset.root === S.root) return;
      S.root = b.dataset.root;
      HX.store.set('root', S.root);
      mounted?.view.unmount?.();
      mounted = null;
      route();
      HX.refresh(['all']);
    };
  }
  $('menu').onclick = () => {
    const open = !$('tabs').classList.contains('open');
    $('tabs').classList.toggle('open', open);
    $('menu').setAttribute('aria-expanded', String(open));
  };

  // ---- small shared widgets ----
  // A cost-of-delay bar: what an item holds up, against the largest on the page.
  HX.costBar = (held, max, critical, label) => {
    const frac = max ? held / max : 0;
    return h('div', { class: 'cost' }, h('div', { class: 'meter' }, h('i', { class: critical || frac > 0.5 ? 'crit' : frac > 0.08 ? 'warn' : '', style: { width: `${Math.max(2, frac * 100)}%` } })), h('div', { class: 'l' }, label));
  };
  // A task id that opens the task on the Map.
  HX.taskLink = (id, cls = 'mono id') => h('a', { class: cls, href: `#map/${id}`, onclick: (e) => e.stopPropagation() }, id);
  HX.statusTag = (status) => {
    const m = { done: ['✓ Merged', 'tag-ok'], claimed: ['Building', 'tag-accent'], ready: ['Ready', 'tag-neutral'], needs_human: ['Needs you', 'tag-crit'], parked: ['Parked', 'tag-warn'], todo: ['To do', 'tag-warn'], in_progress: ['In progress', 'tag-accent'] }[status] ?? [status, 'tag-neutral'];
    return HX.tag(m[0], m[1]);
  };
  // A pass's phase and how long it has been in it.
  HX.phaseLine = (p) => [`${HX.PHASE[p.phase] ?? p.phase} `, HX.ticker(p.inferred ? p.startedAt : p.phaseAt)];
  HX.loopPill = () => {
    const s = S.state;
    return s?.loop.running ? (s.loop.stopping ? 'Stopping' : s.paused ? 'Paused' : 'Running') : 'Stopped';
  };
})();
