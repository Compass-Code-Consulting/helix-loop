// The Metrics tab, and the start: icons in the shell, the first state, the router and the change stream.
(() => {
  'use strict';
  const { h, fill, S } = HX;

  // Metrics (spec §6.7): the metrics page, as before, in a frame; it updates in place when the ledger changes.
  HX.views.metrics = {
    mount(el) {
      this.frame = h('iframe', { class: 'metricsframe', title: 'Build metrics', src: `/view/metrics?root=${S.root}` });
      // The metrics page has a light and a dark theme of its own: here it is always dark, without its own switch.
      this.frame.addEventListener('load', () => {
        const doc = this.frame.contentDocument;
        doc?.documentElement.setAttribute('data-theme', 'dark');
        doc?.head.append(Object.assign(doc.createElement('style'), { textContent: '.theme{display:none} body{background:transparent}' }));
      });
      const save = HX.btn('Save metrics version', HX.act(async () => {
        await HX.post('/api/export', { what: 'metrics' });
        HX.toast('Saving a version of the metrics page in runs/metrics/…');
      }), 'btn-secondary sm');
      fill(el, h('div', { style: { flex: 1, display: 'flex', flexDirection: 'column', background: 'var(--ground)' } },
        h('div', { class: 'row', style: { padding: '8px 20px', boxShadow: 'inset 0 -1px 0 var(--color-divider)' } }, HX.tag('Live', 'tag-ok'), h('span', { class: 'small muted grow' }, 'The metrics page, updated as the ledger grows. The loop also keeps a version every 100 passes.'), save),
        this.frame));
    },
    async update(what) {
      if (!what.has('ledger') && !what.has('plan') && !what.has('all')) return;
      const w = this.frame?.contentWindow;
      if (w?.helixMetrics) w.helixMetrics.update(await HX.api('/api/metrics'));
    },
  };

  HX.hydrateIcons();
  HX.route();
  HX.connect();
})();
