(() => {
  'use strict';

  // ---------- small helpers (everything is built with textContent: no HTML injection) ----------
  function h(tag, attrs, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === false || v == null) continue;
      if (k === 'class') e.className = v;
      else if (k === 'text') e.textContent = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else if (v === true) e.setAttribute(k, '');
      else e.setAttribute(k, String(v));
    }
    for (const kid of kids.flat(Infinity)) {
      if (kid == null || kid === false) continue;
      e.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    }
    return e;
  }
  const fmt = {
    n: (x) => (x == null ? '–' : Number(x).toLocaleString()),
    k: (x) => {
      if (x == null) return '–';
      if (x >= 1e6) return (x / 1e6).toFixed(1) + 'M';
      if (x >= 1e3) return (x / 1e3).toFixed(x >= 1e4 ? 0 : 1) + 'k';
      return String(x);
    },
    ms: (x) => {
      if (x == null) return '–';
      if (x < 1000) return Math.round(x) + ' ms';
      if (x < 60000) return (x / 1000).toFixed(1) + ' s';
      return Math.floor(x / 60000) + 'm ' + Math.round((x % 60000) / 1000) + 's';
    },
    time: (ts) => new Date(ts).toLocaleTimeString([], { hour12: false }),
    bytes: (n) => {
      if (n == null) return '–';
      if (n < 1024) return n + ' B';
      if (n < 1048576) return (n / 1024).toFixed(1) + ' kB';
      return (n / 1048576).toFixed(1) + ' MB';
    },
  };
  async function api(path, opts) {
    const o = { ...(opts || {}) };
    if (o.method && o.method !== 'GET') {
      o.headers = { 'x-hawat-ui': '1', 'content-type': 'application/json', ...(o.headers || {}) };
    }
    const res = await fetch('/__hawat/api' + path, o);
    if (!res.ok) throw Object.assign(new Error('HTTP ' + res.status), { status: res.status });
    return res.json();
  }
  function copyButton(getText, label) {
    const b = h('button', { class: 'btn small', type: 'button', text: label || 'Copy' });
    b.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(getText()); b.textContent = 'Copied'; } catch (e) { b.textContent = 'Copy failed'; }
      setTimeout(() => { b.textContent = label || 'Copy'; }, 1200);
    });
    return b;
  }

  // ---------- state ----------
  const S = {
    recs: new Map(), order: [], sel: null, detail: null, detailError: null,
    tab: 'decision', st: null,
    f: { text: '', route: 'all', status: 'all', sub: false },
    view: { req: 'messages', up: 'messages', res: 'assembled' },
    open: new Set(), fresh: new Set(), showAll: new Set(),
  };

  // ---------- skeleton ----------
  const root = document.getElementById('app');
  const el = {};
  el.eye = h('span', { class: 'eye', 'aria-hidden': 'true' });
  el.flowBar = h('div', { class: 'flow-bar', role: 'img' });
  el.flowText = h('div', { class: 'flow-text' });
  el.lmPill = h('button', { class: 'pill', type: 'button', onclick: () => api('/recheck-local', { method: 'POST', body: '{}' }).then(applyState).catch(() => {}) });
  el.proxyPill = h('span', { class: 'pill' });
  el.switchInput = h('input', { type: 'checkbox', role: 'switch', onchange: onToggleLocal });
  el.switchNote = h('span', { class: 'none' });
  el.rulesBtn = h('button', { class: 'btn', type: 'button', text: 'Rules', onclick: () => openRules() });
  el.search = h('input', { type: 'search', placeholder: 'Search requests', 'aria-label': 'Filter requests', oninput: (e) => { S.f.text = e.target.value.toLowerCase(); scheduleList(); } });
  el.routeSel = h('select', { 'aria-label': 'Route', onchange: (e) => { S.f.route = e.target.value; scheduleList(); } },
    h('option', { value: 'all', text: 'All routes' }), h('option', { value: 'anthropic', text: 'Anthropic' }), h('option', { value: 'local', text: 'LM Studio' }));
  el.statusSel = h('select', { 'aria-label': 'Outcome', onchange: (e) => { S.f.status = e.target.value; scheduleList(); } },
    h('option', { value: 'all', text: 'Any outcome' }), h('option', { value: 'bad', text: 'Errors only' }));
  el.subBox = h('input', { type: 'checkbox', onchange: (e) => { S.f.sub = e.target.checked; scheduleList(); } });
  el.count = h('span', { class: 'count' });
  el.clearBtn = h('button', { class: 'btn small', type: 'button', text: 'Clear', onclick: onClear });
  el.rows = h('ul', { class: 'rows', role: 'listbox', 'aria-label': 'Requests', tabindex: '0', onkeydown: onRowsKey });
  el.dossier = h('main', { class: 'dossier', 'aria-live': 'polite' });
  el.dialog = h('dialog', { 'aria-label': 'Routing rules' });

  root.append(
    h('div', { class: 'shell' },
      h('header', { class: 'top' },
        h('div', { class: 'brand' }, el.eye, h('div', {}, h('h1', { text: 'Hawat' }), h('p', { text: 'Mentat of the request stream' }))),
        h('div', { class: 'flow' }, el.flowBar, el.flowText),
        h('div', { class: 'controls' },
          el.proxyPill, el.lmPill,
          h('label', { class: 'switch' }, el.switchInput, h('span', { class: 'track' }), h('span', { text: 'Use LM Studio for matching requests' })),
          el.switchNote, el.rulesBtn)),
      h('div', { class: 'cols' },
        h('section', { class: 'ledger', 'aria-label': 'Request ledger' },
          h('div', { class: 'toolbar' }, el.search, el.routeSel, el.statusSel,
            h('label', {}, el.subBox, 'Subagents only'), el.count, el.clearBtn),
          el.rows),
        el.dossier)),
    el.dialog);

  // ---------- rendering: header ----------
  function applyState(st) {
    S.st = st;
    renderHeader();
    renderDossierSoon();
  }

  function renderHeader() {
    const st = S.st;
    if (!st) return;
    el.proxyPill.replaceChildren(h('span', { class: 'dot up' }), 'Listening on ' + st.host + ':' + st.port);
    const up = st.local && st.local.ok;
    el.lmPill.replaceChildren(h('span', { class: 'dot ' + (up ? 'up' : 'down') }),
      up ? 'LM Studio is up (' + st.local.models.length + (st.local.models.length === 1 ? ' model' : ' models') + ')' : 'LM Studio is not reachable');
    el.lmPill.title = up ? 'Models: ' + st.local.models.join(', ') + '\nClick to check again' : (st.local && st.local.error ? st.local.error + '\nClick to check again' : '');
    el.switchInput.checked = !!st.localEnabled;
    const r = st.routes && st.routes[0];
    el.switchNote.textContent = !st.localEnabled && r && r.fallbackModel ? 'Off: sent to Claude as ' + r.fallbackModel : '';
  }

  function renderFlow() {
    let loc = 0; let ant = 0; let cached = 0;
    for (const s of S.recs.values()) {
      const t = s.tokens.input + s.tokens.output + s.tokens.cacheCreate;
      if (s.target === 'local') loc += t; else { ant += t; cached += s.tokens.cacheRead; }
    }
    const total = loc + ant;
    const pct = total ? Math.round((loc / total) * 100) : 0;
    const locBar = h('i', { class: 'loc' });
    const antBar = h('i', { class: 'ant' });
    locBar.style.width = (total ? (loc / total) * 100 : 0) + '%';
    antBar.style.width = (total ? (ant / total) * 100 : 100) + '%';
    el.flowBar.replaceChildren(locBar, antBar);
    el.flowBar.setAttribute('aria-label', pct + ' percent of tokens handled by LM Studio');
    el.flowText.replaceChildren(
      h('span', {}, h('b', { class: 'loc-t', text: fmt.n(loc) }), ' tokens by LM Studio (', pct, '%)'),
      h('span', {}, h('b', { class: 'ant-t', text: fmt.n(ant) }), ' by Anthropic' + (cached ? ' (+' + fmt.k(cached) + ' cached)' : '')));
  }

  // ---------- rendering: ledger ----------
  function visible() {
    const f = S.f;
    return S.order.map((id) => S.recs.get(id)).filter((s) => {
      if (!s) return false;
      if (f.route === 'local' && s.target !== 'local') return false;
      if (f.route === 'anthropic' && s.target === 'local') return false;
      if (f.status === 'bad' && !(s.state === 'error' || (s.status && s.status >= 400))) return false;
      if (f.sub && !s.isSubagent) return false;
      if (f.text) {
        const hay = (s.path + ' ' + (s.modelIn || '') + ' ' + (s.modelOut || '') + ' ' + (s.preview || '') + ' ' + (s.status || '')).toLowerCase();
        if (!hay.includes(f.text)) return false;
      }
      return true;
    });
  }

  function statusChip(s) {
    if (s.state === 'pending') return h('span', { class: 'chip wait', text: 'waiting' });
    if (s.state === 'streaming') return h('span', { class: 'chip live', text: 'streaming' });
    if (s.state === 'error') return h('span', { class: 'chip bad', text: 'failed' });
    if (s.state === 'aborted') return h('span', { class: 'chip warn', text: 'cut off' });
    return h('span', { class: 'chip ' + (s.status >= 400 ? 'bad' : 'ok'), text: String(s.status) });
  }

  function routeClass(s) { return s.mode === 'redirect' ? 'local' : (s.mode === 'fallback' ? 'fallback' : 'anth'); }
  function routeName(s) { return s.mode === 'redirect' ? 'LM Studio' : (s.mode === 'fallback' ? 'Anthropic (fallback)' : 'Anthropic'); }

  function renderRows() {
    const list = visible();
    el.count.textContent = list.length + (list.length === 1 ? ' request' : ' requests');
    const nodes = list.slice().reverse().map((s) => {
      const tok = s.tokens;
      const model = s.modelIn && s.modelOut && s.modelIn !== s.modelOut ? s.modelIn + ' became ' + s.modelOut : (s.modelOut || s.modelIn || '');
      const li = h('li', {
        class: 'row ' + routeClass(s) + (S.fresh.has(s.id) ? ' fresh' : ''), role: 'option', 'data-id': s.id,
        'aria-selected': String(s.id === S.sel), onclick: () => select(s.id),
      },
      h('div', { class: 'stripe', 'aria-hidden': 'true' }),
      h('div', { class: 'row-body' },
        h('div', { class: 'row-line' },
          h('span', { class: 't', text: fmt.time(s.ts) }),
          h('span', { class: 'path', text: s.method + ' ' + s.path.split('?')[0] }),
          h('span', { class: 'spacer' }),
          s.isSubagent ? h('span', { class: 'tag', text: 'subagent' }) : null,
          h('span', { class: 'tag', text: routeName(s) }),
          statusChip(s)),
        h('div', { class: 'row-line' },
          h('span', { class: 'model', text: model }),
          h('span', { class: 'spacer' }),
          tok.input + tok.output ? h('span', { class: 'num', text: fmt.k(tok.input + tok.cacheCreate) + ' in, ' + (tok.cacheRead ? fmt.k(tok.cacheRead) + ' cached, ' : '') + fmt.k(tok.output) + ' out' }) : null,
          h('span', { class: 'num', text: fmt.ms(s.totalMs) })),
        s.preview ? h('div', { class: 'row-line' }, h('span', { class: 'preview', text: s.preview })) : null,
        s.error ? h('div', { class: 'row-line' }, h('span', { class: 'preview', text: s.error })) : null));
      return li;
    });
    el.rows.replaceChildren(...nodes);
    if (!nodes.length) {
      el.rows.append(h('li', { class: 'empty' }, S.recs.size ? 'No requests match these filters.' : 'Waiting for the first request.'));
    }
    renderFlow();
  }

  function onRowsKey(e) {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Escape') return;
    e.preventDefault();
    const list = visible().slice().reverse();
    if (e.key === 'Escape') { S.sel = null; S.detail = null; renderRows(); renderDossier(); return; }
    let i = list.findIndex((s) => s.id === S.sel);
    i = e.key === 'ArrowDown' ? Math.min(list.length - 1, i + 1) : Math.max(0, i - 1);
    if (list[i]) { select(list[i].id); const node = el.rows.querySelector('[data-id="' + list[i].id + '"]'); if (node) node.scrollIntoView({ block: 'nearest' }); }
  }

  // ---------- rendering: dossier ----------
  function key(k) { return k; }
  function details(k, summary, ...body) {
    const d = h('details', { 'data-key': k }, h('summary', { text: summary }), ...body);
    if (S.open.has(k)) d.open = true;
    d.addEventListener('toggle', () => { if (d.open) S.open.add(k); else S.open.delete(k); });
    return d;
  }

  function kv(rows) {
    return h('table', { class: 'kv' }, h('tbody', {}, rows.filter(Boolean).map(([label, value, cls]) =>
      h('tr', { class: cls || '' }, h('th', { text: label }), h('td', {}, value)))));
  }

  const HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']);
  function headersTable(list, compare, removed, markHop) {
    const other = compare ? new Map(compare.map((x) => [x.name.toLowerCase(), x.value])) : null;
    const rows = list.map((x) => {
      let cls = '';
      let flag = null;
      if (other) {
        if (!other.has(x.name.toLowerCase())) { cls = 'added'; flag = 'added'; } else if (other.get(x.name.toLowerCase()) !== x.value) { cls = 'changed'; flag = 'changed'; }
      }
      return h('tr', { class: cls }, h('th', { text: x.name }), h('td', {}, x.value,
        x.masked ? h('span', { class: 'flag masked', text: 'masked' }) : null,
        markHop && HOP.has(x.name.toLowerCase()) ? h('span', { class: 'flag', text: 'connection-level, not forwarded' }) : null,
        flag ? h('span', { class: 'flag ' + flag, text: flag }) : null));
    });
    for (const name of removed || []) {
      const orig = compare ? compare.find((x) => x.name.toLowerCase() === name.toLowerCase()) : null;
      rows.push(h('tr', { class: 'removed' }, h('th', { text: name }), h('td', {}, orig ? orig.value : '', h('span', { class: 'flag removed', text: 'removed' }))));
    }
    if (!rows.length) return h('p', { class: 'none', text: 'No headers.' });
    return h('table', { class: 'kv' }, h('tbody', {}, rows));
  }

  function tryJson(text, truncated) {
    if (truncated || !text) return null;
    try { return JSON.parse(text); } catch (e) { return null; }
  }

  function bodyBlock(k, text, opts) {
    const o = opts || {};
    const LIMIT = 200000;
    const all = S.showAll.has(k);
    const obj = o.raw ? null : tryJson(text, o.truncated);
    const shown = obj !== null ? JSON.stringify(obj, null, 2) : (text || '');
    const out = h('div', {});
    const long = shown.length > LIMIT && !all;
    out.append(h('div', { class: 'bodybar' }, copyButton(() => text || '', 'Copy body')));
    out.append(h('pre', { class: 'body', text: long ? shown.slice(0, LIMIT) : shown }));
    if (long) out.append(h('p', { class: 'note' }, 'Showing the first ' + fmt.n(LIMIT) + ' characters of ' + fmt.n(shown.length) + '. ',
      h('button', { class: 'btn small', type: 'button', text: 'Show everything', onclick: () => { S.showAll.add(k); renderDossier(); } })));
    if (o.truncated) out.append(h('p', { class: 'note warn', text: 'Hawat only keeps the first ' + fmt.bytes(shown.length) + ' of this body, so the rest is not shown here. What was forwarded was complete.' }));
    return out;
  }

  function blockText(b) {
    if (typeof b === 'string') return b;
    if (Array.isArray(b)) return b.map(blockText).join('\n');
    if (b && typeof b === 'object') {
      if (typeof b.text === 'string') return b.text;
      if (b.content !== undefined) return blockText(b.content);
      return JSON.stringify(b, null, 2);
    }
    return String(b);
  }

  function longText(k, label, text, kind) {
    const pre = (t) => h('pre', { text: t });
    if (text.length <= 700) return h('div', { class: 'blk' }, h('div', { class: 'kind', text: kind || label }), pre(text));
    return h('div', { class: 'blk' }, h('div', { class: 'kind', text: kind || label }),
      details(k, text.slice(0, 120).replace(/\s+/g, ' ') + '… (' + fmt.n(text.length) + ' characters)', pre(text)));
  }

  function messagesView(prefix, body) {
    const out = h('div', {});
    const sys = body.system;
    if (sys) {
      const t = blockText(sys);
      out.append(h('div', { class: 'msg' }, h('header', { text: 'System prompt, ' + fmt.n(t.length) + ' characters' }), longText(prefix + ':sys', 'system', t, 'system')));
    }
    (Array.isArray(body.messages) ? body.messages : []).forEach((m, i) => {
      const blocks = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : (Array.isArray(m.content) ? m.content : []);
      out.append(h('div', { class: 'msg ' + m.role }, h('header', { text: 'Message ' + (i + 1) + ' from ' + m.role }),
        blocks.map((b, j) => {
          const k = prefix + ':m' + i + ':' + j;
          if (b.type === 'text') return longText(k, 'text', b.text || '');
          if (b.type === 'thinking') return longText(k, 'thinking', b.thinking || '', 'thinking');
          if (b.type === 'tool_use') return longText(k, 'tool_use', JSON.stringify(b.input, null, 2), 'tool call: ' + b.name);
          if (b.type === 'tool_result') return longText(k, 'tool_result', blockText(b.content), 'tool result' + (b.is_error ? ' (error)' : ''));
          if (b.type === 'image') return h('div', { class: 'blk' }, h('div', { class: 'kind', text: 'image' }), h('span', { class: 'none', text: 'Image data is not shown.' }));
          return longText(k, b.type, JSON.stringify(b, null, 2), b.type || 'block');
        })));
    });
    if (Array.isArray(body.tools) && body.tools.length) {
      out.append(details(prefix + ':tools', 'Tools offered (' + body.tools.length + ')',
        h('div', { class: 'chips' }, body.tools.map((t) => h('span', { class: 'c', text: t.name || t.type || 'tool' })))));
    }
    return out;
  }

  function requestFacts(info) {
    if (!info || !info.model) return null;
    return kv([
      ['Model', info.model], ['Streaming', info.stream ? 'yes' : 'no'], ['Max tokens', fmt.n(info.maxTokens)],
      ['Thinking', info.thinking || 'off'], ['Messages', fmt.n(info.messages)], ['Tools', fmt.n(info.tools)],
      ['System prompt', fmt.n(info.systemChars) + ' characters'],
    ]);
  }

  function bodyViewer(viewKey, prefix, text, truncated, info) {
    const obj = tryJson(text, truncated);
    const structured = obj && typeof obj === 'object' && (Array.isArray(obj.messages) || obj.system);
    const wrap = h('div', {});
    if (info) wrap.append(requestFacts(info));
    if (!structured) { wrap.append(h('h4', { class: 'sec', text: 'Body' }), bodyBlock(prefix + ':json', text, { truncated })); return wrap; }
    const mode = S.view[viewKey];
    const seg = h('div', { class: 'seg' },
      h('button', { type: 'button', 'aria-pressed': String(mode === 'messages'), text: 'Conversation', onclick: () => { S.view[viewKey] = 'messages'; renderDossier(); } }),
      h('button', { type: 'button', 'aria-pressed': String(mode === 'json'), text: 'JSON', onclick: () => { S.view[viewKey] = 'json'; renderDossier(); } }));
    wrap.append(h('h4', { class: 'sec', text: 'Body' }), seg, mode === 'json' ? bodyBlock(prefix + ':json', text, { truncated }) : messagesView(prefix, obj));
    return wrap;
  }

  function usageView(a) {
    const u = a.usage || {};
    const inp = u.input_tokens || 0; const cr = u.cache_read_input_tokens || 0; const cc = u.cache_creation_input_tokens || 0;
    const denom = inp + cr + cc;
    const item = (label, value) => h('div', {}, h('b', { text: value }), h('span', { text: label }));
    return h('div', { class: 'usage' },
      item('input', fmt.n(inp)), item('output', fmt.n(u.output_tokens || 0)),
      item('read from cache', fmt.n(cr)), item('written to cache', fmt.n(cc)),
      item('cache hit rate', denom ? Math.round((cr / denom) * 100) + '%' : '–'));
  }

  function assembledView(a, prefix) {
    const out = h('div', {});
    out.append(usageView(a));
    out.append(kv([['Model', a.model || '–'], ['Stop reason', a.stop_reason || '–'], a.kind === 'stream' ? ['Stream events', fmt.n(a.events) + (a.complete ? '' : ' (not finished)')] : null]));
    if (a.error) out.append(h('h4', { class: 'sec', text: 'Error' }), h('pre', { class: 'body', text: JSON.stringify(a.error, null, 2) }));
    (a.content || []).forEach((b, i) => {
      const k = prefix + ':c' + i;
      if (b.type === 'thinking') out.append(h('div', { class: 'msg' }, h('header', { text: 'Thinking' }), longText(k, 'thinking', b.thinking || '', 'thinking')));
      else if (b.type === 'text') out.append(h('div', { class: 'msg assistant' }, h('header', { text: 'Reply' }), longText(k, 'text', b.text || '', 'text')));
      else if (b.type === 'tool_use' || b.type === 'server_tool_use') {
        const input = b.input !== undefined ? JSON.stringify(b.input, null, 2) : (b.input_json || '');
        out.append(h('div', { class: 'msg assistant' }, h('header', { text: 'Tool call: ' + b.name }), longText(k, 'tool_use', input, 'arguments')));
      } else out.append(h('div', { class: 'msg' }, h('header', { text: b.type || 'block' }), longText(k, 'block', JSON.stringify(b, null, 2), b.type)));
    });
    if (!(a.content || []).length && !a.error) out.append(h('p', { class: 'none', text: 'No content blocks yet.' }));
    return out;
  }

  // ----- tabs -----
  function verdict(rec) {
    const r = rec.route;
    if (!r) return h('div', { class: 'verdict' }, h('h3', { text: 'Waiting for a routing decision' }));
    const cls = r.mode === 'redirect' ? 'local' : (r.mode === 'fallback' ? 'fallback' : 'anth');
    let title; let sub;
    if (r.mode === 'redirect') {
      title = 'Redirected to LM Studio';
      sub = 'The model name ' + (r.modelIn || '?') + ' matched rule "' + r.rule + '". Hawat rewrote it to ' + (r.modelOut || '?') + ' and removed your Claude credentials before sending.';
    } else if (r.mode === 'fallback') {
      title = 'Sent to Anthropic with a different model';
      sub = r.reason + '. Your credentials went along unchanged.';
    } else {
      title = 'Sent to Anthropic untouched';
      sub = r.reason + '. The request and the response were forwarded byte for byte.';
    }
    const status = rec.response ? rec.response.status + ' ' + (rec.response.statusText || '') + ' in ' + fmt.ms(rec.timing && rec.timing.totalMs) : 'no response yet';
    return h('div', { class: 'verdict ' + cls },
      h('h3', { text: title }), h('p', { text: sub }),
      h('div', { class: 'arrowline' },
        h('div', {}, h('span', { text: 'Claude Code asked' }), rec.method + ' ' + location.origin + rec.path),
        h('div', {}, h('span', { text: 'Hawat sent to' }), rec.upstream ? rec.upstream.method + ' ' + rec.upstream.url : 'nothing'),
        h('div', {}, h('span', { text: 'Answer' }), status)));
  }

  function decisionTab(rec) {
    const r = rec.route || {};
    const a = rec.response && rec.response.assembled;
    const u = (a && a.usage) || {};
    const out = h('div', {}, verdict(rec));
    out.append(kv([
      ['Rule', r.rule || 'none matched'],
      ['Why', r.reason || '–'],
      ['Model asked for', r.modelIn || '–'],
      ['Model used', r.modelOut || '–', r.modelIn !== r.modelOut ? 'changed' : ''],
      ['Who asked', rec.agentId ? 'a subagent (' + rec.agentId + ')' : 'the main conversation'],
      rec.parentAgentId ? ['Spawned by', rec.parentAgentId] : null,
      ['Session', rec.sessionId || '–'],
      ['Time to first byte', fmt.ms(rec.timing && rec.timing.ttfbMs)],
      ['Total time', fmt.ms(rec.timing && rec.timing.totalMs)],
      ['Tokens', a ? fmt.n(u.input_tokens || 0) + ' in, ' + fmt.n(u.output_tokens || 0) + ' out, ' + fmt.n(u.cache_read_input_tokens || 0) + ' cache read, ' + fmt.n(u.cache_creation_input_tokens || 0) + ' cache write' : '–'],
      rec.error ? ['Problem', rec.error, 'changed'] : null,
    ]));

    out.append(h('h4', { class: 'sec', text: 'What Hawat changed' }));
    if (r.mode === 'passthrough') {
      out.append(h('p', { class: 'none', text: 'Nothing. Hawat only read a copy of this exchange for this display.' }));
    } else {
      const chips = (arr, cls) => (arr.length ? h('div', { class: 'chips' }, arr.map((x) => h('span', { class: 'c ' + (cls || ''), text: x }))) : h('p', { class: 'none', text: 'None.' }));
      out.append(h('p', { class: 'note', text: 'Headers removed' }), chips(r.strippedHeaders || [], 'rm'));
      out.append(h('p', { class: 'note', text: 'Body fields removed' }), chips(r.strippedBodyFields || [], 'rm'));
      out.append(h('p', { class: 'note', text: 'Values rewritten' }),
        (r.rewrites || []).length ? h('div', { class: 'chips' }, r.rewrites.map((w) => h('span', { class: 'c', text: w.field + ': ' + w.from + ' became ' + w.to }))) : h('p', { class: 'none', text: 'None.' }));
    }
    if (rec.attempts && rec.attempts.length) {
      out.append(h('h4', { class: 'sec', text: 'Earlier attempts' }),
        kv(rec.attempts.map((x, i) => ['Attempt ' + (i + 1) + ' on ' + x.target, x.error])));
    }
    return out;
  }

  function requestTab(rec) {
    const q = rec.query || [];
    const out = h('div', {});
    out.append(kv([['Method', rec.method], ['URL', location.origin + rec.path.split('?')[0]], ['Size', fmt.bytes(rec.request.bodyBytes)]]));
    out.append(h('h4', { class: 'sec', text: 'Query parameters' }));
    out.append(q.length ? kv(q.map(([k, v]) => [k, v])) : h('p', { class: 'none', text: 'None.' }));
    out.append(h('h4', { class: 'sec', text: 'Headers from Claude Code', }), headersTable(rec.clientHeaders));
    out.append(bodyViewer('req', 'req', rec.request.bodyText, rec.request.truncated, rec.requestInfo));
    return out;
  }

  function sentTab(rec) {
    const up = rec.upstream;
    if (!up) return h('p', { class: 'none', text: 'Nothing was sent upstream.' });
    const out = h('div', {});
    out.append(kv([['Method', up.method], ['URL', up.url], ['Size', fmt.bytes(up.bodyBytes)]]));
    const removed = (rec.route && rec.route.strippedHeaders) || [];
    out.append(h('h4', { class: 'sec' }, 'Headers sent', h('small', { text: 'compared with what Claude Code sent' })));
    out.append(headersTable(up.headers, rec.clientHeaders, removed));
    if (up.identical) {
      out.append(h('h4', { class: 'sec', text: 'Body' }), h('p', { class: 'note', text: 'Identical to the body Claude Code sent, byte for byte. See the Request tab.' }));
    } else {
      out.append(bodyViewer('up', 'up', up.bodyText, up.truncated, null));
    }
    return out;
  }

  function responseTab(rec) {
    const r = rec.response;
    if (!r) return h('p', { class: 'none', text: rec.state === 'pending' ? 'Waiting for the first byte.' : 'No response.' });
    const out = h('div', {});
    const wire = r.contentEncoding ? r.contentEncoding + ', ' + fmt.bytes(r.bodyBytes) + ' on the wire' + (r.decodedBytes != null ? ', ' + fmt.bytes(r.decodedBytes) + ' decoded' : '') : fmt.bytes(r.bodyBytes);
    out.append(kv([
      ['Status', r.status + ' ' + (r.statusText || '')], ['Content type', r.contentType || '–'], ['Size', wire],
      r.synthetic ? ['Note', 'Generated by Hawat because the upstream could not be reached.'] : null,
    ]));
    if (rec.state === 'streaming') out.append(h('p', { class: 'note', text: 'Still streaming. This view updates as data arrives.' }));
    if (r.undecoded) out.append(h('p', { class: 'note warn', text: 'The response uses an encoding Hawat cannot decode for display (' + r.contentEncoding + '). It was forwarded correctly.' }));
    if (r.decodeError) out.append(h('p', { class: 'note warn', text: 'Decoding for display stopped early: ' + r.decodeError }));
    out.append(h('h4', { class: 'sec' }, 'Headers', h('small', { text: 'as received from the upstream server' })), headersTable(r.headers, null, null, true));
    const a = r.assembled;
    out.append(h('h4', { class: 'sec', text: 'Body' }));
    const mode = a ? S.view.res : 'raw';
    if (a) {
      out.append(h('div', { class: 'seg' },
        h('button', { type: 'button', 'aria-pressed': String(mode === 'assembled'), text: r.streamed ? 'Reassembled stream' : 'Message', onclick: () => { S.view.res = 'assembled'; renderDossier(); } }),
        h('button', { type: 'button', 'aria-pressed': String(mode === 'raw'), text: 'Raw', onclick: () => { S.view.res = 'raw'; renderDossier(); } })));
    }
    if (mode === 'assembled' && a) out.append(assembledView(a, 'res'));
    else if (r.undecoded) out.append(h('p', { class: 'none', text: 'No readable body to show.' }));
    else out.append(bodyBlock('res:raw', r.bodyText || '', { truncated: r.truncated, raw: r.streamed }));
    return out;
  }

  function renderDossier() {
    const prevScroll = el.dossier.scrollTop;
    el.dossier.replaceChildren(buildDossier());
    el.dossier.scrollTop = prevScroll;
  }
  let dossierTimer = null;
  function renderDossierSoon() { if (dossierTimer) return; dossierTimer = setTimeout(() => { dossierTimer = null; renderDossier(); }, 120); }

  function buildDossier() {
    const box = h('div', { class: 'dossier-in' });
    if (!S.sel) {
      if (!S.recs.size) {
        const port = S.st ? S.st.port : 8719;
        const cmd = 'ANTHROPIC_BASE_URL=http://127.0.0.1:' + port + ' claude';
        box.append(h('div', { class: 'empty' },
          h('h2', { text: 'Nothing has passed through yet' }),
          h('p', { text: 'Start Claude Code through Hawat and every request will appear in the ledger.' }),
          h('pre', { text: cmd }), copyButton(() => cmd, 'Copy command'),
          h('p', { text: 'For one project only, put the same value in .claude/settings.local.json under env. Use no auth token, so your Claude login stays active.' })));
      } else box.append(h('div', { class: 'empty' }, h('h2', { text: 'Pick a request' }), h('p', { text: 'Choose one from the ledger to see its headers, parameters, routing decision and response. Arrow keys move through the list.' })));
      return box;
    }
    if (S.detailError) { box.append(h('div', { class: 'empty' }, h('h2', { text: 'Not available' }), h('p', { text: S.detailError }))); return box; }
    const rec = S.detail;
    if (!rec || rec.id !== S.sel) { box.append(h('p', { class: 'note', text: 'Loading…' })); return box; }
    const s = S.recs.get(rec.id) || {};
    const r = rec.route || {};
    box.append(h('div', { class: 'd-title' },
      h('h2', { text: rec.method + ' ' + rec.pathname }),
      h('span', { class: 'badge ' + routeClass({ mode: r.mode }), text: routeName({ mode: r.mode }) }),
      s.isSubagent ? h('span', { class: 'tag', text: 'subagent' }) : null,
      statusChip({ state: rec.state, status: rec.response && rec.response.status })));
    box.append(h('p', { class: 'd-sub', text: fmt.time(rec.ts) + '  ' + (r.modelIn || '') + (r.modelOut && r.modelOut !== r.modelIn ? ' became ' + r.modelOut : '') }));
    const tabs = [['decision', 'Decision'], ['request', 'Request'], ['sent', 'Sent upstream'], ['response', 'Response']];
    box.append(h('div', { class: 'tabs', role: 'tablist' }, tabs.map(([id, label]) =>
      h('button', { type: 'button', role: 'tab', 'aria-selected': String(S.tab === id), text: label, onclick: () => { S.tab = id; renderDossier(); } }))));
    box.append(S.tab === 'decision' ? decisionTab(rec) : S.tab === 'request' ? requestTab(rec) : S.tab === 'sent' ? sentTab(rec) : responseTab(rec));
    return box;
  }

  // ---------- rules dialog ----------
  function openRules() {
    const st = S.st;
    if (!st) return;
    const rules = (st.routes || []).map((r) => h('div', { class: 'rule' },
      h('h4', { text: r.name }),
      kv([
        ['Matches', JSON.stringify(r.match)],
        ['Model sent to LM Studio', r.rewriteModel === 'auto' ? 'the first model LM Studio reports' : (r.rewriteModel || 'unchanged')],
        ['When switched off', r.fallbackModel ? 'sent to Anthropic as ' + r.fallbackModel : 'passed through unchanged'],
        ['When LM Studio is down', r.fallbackOnLocalDown ? 'retried on Anthropic as ' + r.fallbackModel : 'returns an error, spends no Claude tokens'],
        ['Thinking field', r.thinking], ['Body fields removed', (r.stripBodyFields || []).join(', ') || 'none'],
        ['Tool fields removed', (r.stripToolFields || []).join(', ') || 'none'], ['Cache markers removed', r.stripCacheControl ? 'yes' : 'no'],
      ])));
    el.dialog.replaceChildren(
      h('h3', { text: 'Routing rules' }),
      h('p', { class: 'note', text: 'Everything that matches no rule goes to ' + st.anthropicBase + ' untouched. Your Claude credentials are never sent to ' + st.localBase + ', whatever the rules say.' }),
      ...rules,
      h('p', { class: 'note', text: 'To change rules, edit ' + (st.configFiles.length ? st.configFiles.join(' and ') : 'hawat.config.json') + ' and restart Hawat.' }),
      h('button', { class: 'btn', type: 'button', text: 'Close', onclick: () => el.dialog.close() }));
    if (typeof el.dialog.showModal === 'function') el.dialog.showModal();
  }

  // ---------- actions ----------
  async function onToggleLocal(e) {
    try { applyState(await api('/local-enabled', { method: 'POST', body: JSON.stringify({ enabled: e.target.checked }) })); } catch (err) { e.target.checked = !e.target.checked; }
  }
  async function onClear() {
    try { await api('/clear', { method: 'POST', body: '{}' }); } catch (e) { /* ignore */ }
  }
  async function select(id) {
    S.sel = id; S.detail = null; S.detailError = null;
    renderRows(); renderDossier();
    await loadDetail();
  }
  let detailBusy = false;
  async function loadDetail() {
    if (!S.sel || detailBusy) return;
    detailBusy = true;
    const id = S.sel;
    try {
      const rec = await api('/records/' + id);
      if (S.sel === id) { S.detail = rec; S.detailError = null; }
    } catch (e) {
      if (S.sel === id) S.detailError = e.status === 404 ? 'This request is no longer in memory. Hawat keeps the most recent ones only.' : 'Could not load this request.';
    }
    detailBusy = false;
    if (S.sel === id) renderDossier();
  }
  let detailTimer = null;
  function refreshDetailSoon() { if (detailTimer) return; detailTimer = setTimeout(() => { detailTimer = null; loadDetail(); }, 400); }

  // ---------- live data ----------
  let listQueued = false;
  function scheduleList() { if (listQueued) return; listQueued = true; requestAnimationFrame(() => { listQueued = false; renderRows(); }); }

  function upsert(s) {
    const isNew = !S.recs.has(s.id);
    S.recs.set(s.id, s);
    if (isNew) {
      S.order.push(s.id);
      S.fresh.add(s.id);
      setTimeout(() => { S.fresh.delete(s.id); }, 1600);
    }
    scheduleList();
    if (s.id === S.sel) refreshDetailSoon();
  }

  async function loadAll() {
    const [st, list] = await Promise.all([api('/state'), api('/records')]);
    S.recs.clear(); S.order = [];
    for (const s of list) { S.recs.set(s.id, s); S.order.push(s.id); }
    applyState(st);
    renderRows(); renderDossier();
  }

  function connect() {
    const es = new EventSource('/__hawat/api/events');
    es.onmessage = (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (m.type === 'upsert') upsert(m.record);
      else if (m.type === 'state') applyState(m.state);
      else if (m.type === 'cleared') { S.recs.clear(); S.order = []; S.sel = null; S.detail = null; renderRows(); renderDossier(); }
      else if (m.type === 'evicted') { S.recs.delete(m.id); S.order = S.order.filter((x) => x !== m.id); scheduleList(); }
    };
    let wasDown = false;
    es.onerror = () => { wasDown = true; };
    es.onopen = () => { if (wasDown) { wasDown = false; loadAll().catch(() => {}); } };
  }

  loadAll().then(connect).catch((e) => {
    el.dossier.replaceChildren(h('div', { class: 'dossier-in' }, h('div', { class: 'empty' }, h('h2', { text: 'Cannot reach Hawat' }), h('p', { text: String(e.message || e) }))));
  });
})();
