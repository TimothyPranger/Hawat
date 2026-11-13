'use strict';
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const tls = require('node:tls');
const fs = require('node:fs');
const path = require('node:path');
const pkg = require('../package.json');
const { pairsFromRaw, flatten, getHeader, stripHopByHop, removeHeaders, httpGetJson } = require('./util');
const { maskPairs } = require('./redact');
const { decide, transformBodyForLocal, ALWAYS_STRIP_HEADERS } = require('./router');
const { Store } = require('./store');
const { BodyCapture } = require('./capture');
const { loadLeaf } = require('./certs');

const UI_DIR = path.join(__dirname, '..', 'ui');
const NS = '/__hawat';
const GUI_CSP = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

function clip(s, n = 160) { return String(s).replace(/\s+/g, ' ').trim().slice(0, n); }

function userText(msgs, fromStart) {
  const list = fromStart ? msgs : [...msgs].reverse();
  for (const m of list) {
    if (!m || m.role !== 'user') continue;
    if (typeof m.content === 'string') return clip(m.content);
    if (Array.isArray(m.content)) {
      for (const b of m.content) {
        if (b && b.type === 'text' && typeof b.text === 'string' && !b.text.trimStart().startsWith('<system-reminder>')) return clip(b.text);
      }
    }
  }
  return '';
}

function requestInfo(b, isSubagent) {
  const msgs = Array.isArray(b.messages) ? b.messages : [];
  let systemChars = 0;
  if (typeof b.system === 'string') systemChars = b.system.length;
  else if (Array.isArray(b.system)) systemChars = JSON.stringify(b.system).length;
  return {
    model: b.model,
    stream: !!b.stream,
    maxTokens: b.max_tokens,
    messages: msgs.length,
    tools: Array.isArray(b.tools) ? b.tools.length : 0,
    systemChars,
    thinking: b.thinking ? (b.thinking.type || 'on') : null,
    preview: userText(msgs, isSubagent),
  };
}

function capText(buf, max) {
  const truncated = buf.length > max;
  return { bodyText: buf.subarray(0, max).toString('utf8'), bodyBytes: buf.length, truncated };
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let n = 0;
    req.on('data', (c) => {
      n += c.length;
      if (n > limit) { reject(Object.assign(new Error('request body too large'), { code: 'E2BIG' })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
    req.on('aborted', () => reject(new Error('client aborted the request')));
  });
}

function joinBase(base, p) {
  let prefix = base.pathname.replace(/\/+$/, '');
  if (prefix === '/v1' && p.startsWith('/v1/')) prefix = '';
  return prefix + p;
}

function plain(res, status, text) {
  if (res.headersSent) { res.destroy(); return; }
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

function json(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

function createHawat(cfg) {
  const store = new Store(cfg);
  const state = {
    startedAt: Date.now(),
    localEnabled: !!cfg.localEnabled,
    local: { ok: null, models: [], checkedAt: null, error: null },
    intercept: { ready: false, hosts: [], reason: null },
    tunnels: { total: 0, open: 0, hosts: {} },
  };
  const agents = {
    'http:': new http.Agent({ keepAlive: true }),
    'https:': new https.Agent({ keepAlive: true }),
  };
  const guiClients = new Set();
  const timers = [];
  let listeningPort = cfg.port;

  const loopback = ['127.0.0.1', 'localhost', '::1'].includes(cfg.host);

  function allowedHost(host) {
    if (!loopback) return true;
    const h = String(host || '').toLowerCase();
    return h === '127.0.0.1:' + listeningPort || h === 'localhost:' + listeningPort || h === '[::1]:' + listeningPort;
  }

  function broadcast(msg) {
    const line = 'data: ' + JSON.stringify(msg) + '\n\n';
    for (const c of guiClients) c.write(line);
  }

  function publicState() {
    return {
      version: pkg.version,
      host: cfg.host,
      port: listeningPort,
      startedAt: state.startedAt,
      localEnabled: state.localEnabled,
      local: state.local,
      anthropicBase: cfg.anthropic.baseUrl,
      intercept: state.intercept,
      tunnels: { total: state.tunnels.total, open: state.tunnels.open, hosts: Object.entries(state.tunnels.hosts).sort((a, b) => b[1] - a[1]).slice(0, 20) },
      localBase: cfg.local.baseUrl,
      keepRecords: cfg.keepRecords,
      logToFile: !!cfg.logToFile,
      configFiles: cfg._loadedFiles || [],
      routes: cfg.routes.map((r) => ({
        name: r.name,
        match: r.match,
        rewriteModel: r.rewriteModel || null,
        fallbackModel: r.fallbackModel || null,
        fallbackOnLocalDown: !!r.fallbackOnLocalDown,
        thinking: r.thinking || 'strip',
        stripBodyFields: r.stripBodyFields || [],
        stripToolFields: r.stripToolFields || [],
        stripCacheControl: r.stripCacheControl !== false,
      })),
    };
  }

  store.on('upsert', (s) => broadcast({ type: 'upsert', record: s }));
  store.on('cleared', () => broadcast({ type: 'cleared' }));
  store.on('evicted', (id) => broadcast({ type: 'evicted', id }));
  store.on('finished', (rec) => {
    if (!cfg.logToFile) return;
    try {
      const dir = path.resolve(cfg.logDir);
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, new Date().toISOString().slice(0, 10) + '.jsonl');
      fs.appendFileSync(file, JSON.stringify(rec) + '\n');
    } catch (e) { /* logging must never break the proxy */ }
  });

  async function checkLocal() {
    try {
      const base = new URL(cfg.local.baseUrl);
      const headers = cfg.local.apiKey ? { 'x-api-key': cfg.local.apiKey, authorization: 'Bearer ' + cfg.local.apiKey } : {};
      const data = await httpGetJson(base.origin + '/v1/models', headers, 2000);
      const models = Array.isArray(data.data) ? data.data.map((m) => m.id).filter(Boolean) : [];
      state.local = { ok: true, models, checkedAt: Date.now(), error: null };
    } catch (e) {
      state.local = { ok: false, models: [], checkedAt: Date.now(), error: e.message };
    }
    broadcast({ type: 'state', state: publicState() });
    return state.local;
  }

  async function resolveLocalModel(rule, requested) {
    const spec = rule.rewriteModel;
    if (!spec) return requested;
    if (spec !== 'auto') return spec;
    if (!state.local.models.length) await checkLocal();
    const pick = state.local.models.find((m) => !/embed|rerank/i.test(m));
    if (!pick) throw Object.assign(new Error('LM Studio has no model available (is the server running with a model loaded?)'), { code: 'ELOCAL' });
    return pick;
  }

  /** Work out exactly what to send upstream for one routing decision. */
  async function buildUpstream(decision, c) {
    const route = {
      mode: decision.mode,
      target: decision.target,
      rule: decision.rule ? decision.rule.name : null,
      reason: decision.reason,
      modelIn: c.bodyObj && c.bodyObj.model ? c.bodyObj.model : null,
      modelOut: c.bodyObj && c.bodyObj.model ? c.bodyObj.model : null,
      strippedHeaders: [],
      strippedBodyFields: [],
      rewrites: [],
    };

    if (decision.mode === 'redirect') {
      const rule = decision.rule;
      const resolved = await resolveLocalModel(rule, c.bodyObj.model);
      const { body, changes } = transformBodyForLocal(c.bodyObj, rule, resolved);
      const bodyBuf = Buffer.from(JSON.stringify(body));
      const base = new URL(cfg.local.baseUrl);
      const u = new URL(c.req.url, 'http://x');
      u.searchParams.delete('beta');
      const extra = new Set((rule.stripHeaders || []).map((h) => h.toLowerCase()));
      const { kept, removed } = removeHeaders(stripHopByHop(c.rawPairs), new Set([...ALWAYS_STRIP_HEADERS, ...extra]));
      const headers = [['Host', base.host], ...kept, ['Content-Length', String(bodyBuf.length)], ['Accept-Encoding', 'identity']];
      if (cfg.local.apiKey) headers.push(['x-api-key', cfg.local.apiKey]);
      route.modelOut = resolved;
      route.rewrites = changes.rewrites;
      route.strippedBodyFields = changes.strippedBodyFields;
      route.strippedHeaders = removed
        .map(([n]) => n)
        .filter((n) => !['host', 'content-length', 'expect'].includes(n.toLowerCase()));
      return { route, url: base, path: joinBase(base, u.pathname + u.search), method: c.req.method, headers, body: bodyBuf, identical: false };
    }

    const base = new URL(cfg.anthropic.baseUrl);
    let outBody = c.bodyBuf;
    if (decision.mode === 'fallback') {
      const obj = JSON.parse(JSON.stringify(c.bodyObj));
      route.rewrites.push({ field: 'model', from: obj.model, to: decision.rule.fallbackModel });
      route.modelOut = decision.rule.fallbackModel;
      obj.model = decision.rule.fallbackModel;
      outBody = Buffer.from(JSON.stringify(obj));
    }
    let headers = stripHopByHop(c.rawPairs).filter(([n]) => !['host', 'expect'].includes(n.toLowerCase()));
    const hadLength = getHeader(headers, 'content-length') !== undefined;
    if (outBody !== c.bodyBuf) headers = headers.filter(([n]) => n.toLowerCase() !== 'content-length');
    if (outBody.length && (outBody !== c.bodyBuf || !hadLength)) headers.push(['Content-Length', String(outBody.length)]);
    headers = [['Host', base.host], ...headers];
    return { route, url: base, path: joinBase(base, c.req.url), method: c.req.method, headers, body: outBody, identical: outBody === c.bodyBuf };
  }

  function sendProxyError(rec, res, status, message) {
    const body = JSON.stringify({ type: 'error', error: { type: 'api_error', message: '[hawat] ' + message } });
    rec.response = {
      status, statusText: 'Hawat error', synthetic: true, streamed: false,
      headers: [{ name: 'content-type', value: 'application/json', masked: false }],
      bodyText: body, bodyBytes: Buffer.byteLength(body),
      assembled: { kind: 'error', error: { type: 'api_error', message: '[hawat] ' + message }, content: [], usage: {} },
    };
    if (!res.headersSent) {
      res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
      res.end(body);
    } else res.destroy();
  }

  /** Send one prepared request upstream and stream the answer back. Rejects only if nothing was sent to the client yet. */
  function transmit(up, rec, res, tStart) {
    return new Promise((resolve, reject) => {
      const lib = up.url.protocol === 'https:' ? https : http;
      let responded = false;
      const hostname = up.url.hostname.replace(/^\[|\]$/g, '');
      const ureq = lib.request({
        protocol: up.url.protocol,
        hostname,
        port: up.url.port || (up.url.protocol === 'https:' ? 443 : 80),
        path: up.path,
        method: up.method,
        headers: flatten(up.headers),
        agent: agents[up.url.protocol],
      }, (ures) => {
        responded = true;
        const hdrs = pairsFromRaw(ures.rawHeaders);
        const out = stripHopByHop(hdrs);
        const encoding = getHeader(hdrs, 'content-encoding');
        const ctype = getHeader(hdrs, 'content-type');
        const capture = new BodyCapture({
          encoding, contentType: ctype, maxBytes: cfg.maxBodyBytes,
          onUpdate: () => {
            if (capture.sse) rec.response.assembled = capture.sse.snapshot();
            rec.response.bodyBytes = capture.rawBytes;
            store.touch(rec);
          },
        });
        rec.response = {
          status: ures.statusCode,
          statusText: ures.statusMessage || '',
          headers: maskPairs(hdrs),
          contentEncoding: encoding || '',
          contentType: ctype || '',
          streamed: capture.isSse,
          bodyBytes: 0,
        };
        rec.timing.ttfbMs = Number((process.hrtime.bigint() - tStart) / 1000000n);
        rec.state = 'streaming';
        store.touch(rec);

        res.writeHead(ures.statusCode, ures.statusMessage || undefined, flatten(out));
        res.flushHeaders();
        if (res.socket) res.socket.setNoDelay(true);
        ures.pipe(res);
        ures.on('data', (c) => capture.write(c));

        let settled = false;
        const settle = async (state, error) => {
          if (settled) return;
          settled = true;
          capture.end();
          await capture.done;
          rec.response.bodyText = capture.text();
          rec.response.bodyBytes = capture.rawBytes;
          rec.response.decodedBytes = capture.decodedBytes;
          rec.response.truncated = capture.truncated;
          rec.response.undecoded = capture.undecoded;
          rec.response.decodeError = capture.decodeError;
          rec.response.assembled = capture.assembled();
          rec.timing.totalMs = Number((process.hrtime.bigint() - tStart) / 1000000n);
          rec.state = state;
          if (error) rec.error = error;
          resolve();
        };
        ures.on('end', () => settle('done'));
        ures.on('error', (e) => { res.destroy(); settle('error', 'upstream connection broke mid-response: ' + e.message); });
        ures.on('aborted', () => { res.destroy(); settle('error', 'upstream closed the connection mid-response'); });
        res.on('close', () => {
          if (!ures.complete) { ureq.destroy(); settle('aborted', 'client disconnected before the response finished'); }
        });
      });
      ureq.on('error', (err) => { if (!responded) reject(err); });
      ureq.end(up.body);
    });
  }

  async function dispatch(decision, c, rec, res, tStart) {
    let up;
    try {
      up = await buildUpstream(decision, c);
    } catch (err) {
      return { failed: err };
    }
    rec.route = up.route;
    rec.upstream = {
      method: up.method,
      url: up.url.protocol + '//' + up.url.host + up.path,
      headers: maskPairs(up.headers),
      identical: up.identical,
      bodyBytes: up.body.length,
      ...(up.identical ? {} : { bodyText: up.body.subarray(0, cfg.maxBodyBytes).toString('utf8'), truncated: up.body.length > cfg.maxBodyBytes }),
    };
    rec.state = 'pending';
    store.touch(rec);
    try {
      await transmit(up, rec, res, tStart);
      return { failed: null };
    } catch (err) {
      return { failed: err };
    }
  }

  async function handleProxy(req, res) {
    if (!cfg.allowBrowserOrigins && req.headers.origin) return plain(res, 403, 'hawat: requests from browser origins are refused');
    if (!req.url || !req.url.startsWith('/')) return plain(res, 400, 'hawat: expected a path such as /v1/messages');

    let bodyBuf;
    try { bodyBuf = await readBody(req, cfg.maxRequestBytes); } catch (e) {
      return plain(res, e.code === 'E2BIG' ? 413 : 400, 'hawat: ' + e.message);
    }
    const tStart = process.hrtime.bigint();
    const rawPairs = pairsFromRaw(req.rawHeaders);
    const urlObj = new URL(req.url, 'http://x');
    const pathname = urlObj.pathname.replace(/\/+$/, '') || '/';
    const ctype = (getHeader(rawPairs, 'content-type') || '').toLowerCase();
    let bodyObj = null;
    if (req.method === 'POST' && bodyBuf.length && /json/.test(ctype) && getHeader(rawPairs, 'content-encoding') === undefined) {
      try { bodyObj = JSON.parse(bodyBuf.toString('utf8')); } catch (e) { bodyObj = null; }
    }
    const agentId = getHeader(rawPairs, 'x-claude-code-agent-id') || null;
    const rec = store.create({
      method: req.method,
      path: req.url,
      pathname,
      query: [...urlObj.searchParams.entries()],
      clientHeaders: maskPairs(rawPairs),
      agentId,
      parentAgentId: getHeader(rawPairs, 'x-claude-code-parent-agent-id') || null,
      sessionId: getHeader(rawPairs, 'x-claude-code-session-id') || null,
      requestInfo: bodyObj && typeof bodyObj === 'object' ? requestInfo(bodyObj, !!agentId) : { preview: '' },
      request: capText(bodyBuf, cfg.maxBodyBytes),
      timing: { startedAt: Date.now() },
    });

    const c = { req, rawPairs, bodyBuf, bodyObj };
    let decision = decide({ method: req.method, pathname, headers: rawPairs, bodyObj }, cfg, state);
    let result = await dispatch(decision, c, rec, res, tStart);

    if (result.failed && decision.mode === 'redirect' && decision.rule.fallbackOnLocalDown && decision.rule.fallbackModel && !res.headersSent) {
      rec.attempts.push({ target: 'local', error: result.failed.message });
      decision = {
        mode: 'fallback', target: 'anthropic', rule: decision.rule,
        reason: 'LM Studio failed (' + result.failed.message + '): sent to Anthropic as ' + decision.rule.fallbackModel,
      };
      result = await dispatch(decision, c, rec, res, tStart);
    }

    if (result.failed) {
      const where = decision.target === 'local' ? 'LM Studio' : 'Anthropic';
      const msg = 'could not reach ' + where + ': ' + result.failed.message;
      if (!rec.route) {
        rec.route = {
          mode: decision.mode, target: decision.target, rule: decision.rule ? decision.rule.name : null, reason: decision.reason,
          modelIn: bodyObj && bodyObj.model || null, modelOut: bodyObj && bodyObj.model || null, strippedHeaders: [], strippedBodyFields: [], rewrites: [],
        };
      }
      sendProxyError(rec, res, 502, msg);
      rec.state = 'error';
      rec.error = msg;
      rec.timing.totalMs = Number((process.hrtime.bigint() - tStart) / 1000000n);
    }
    store.finish(rec);
  }

  // ---------- GUI and its API ----------

  function serveStatic(res, file, type) {
    let data;
    try { data = fs.readFileSync(path.join(UI_DIR, file)); } catch (e) { return plain(res, 404, 'not found'); }
    res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store', 'content-security-policy': GUI_CSP, 'x-content-type-options': 'nosniff', 'content-length': data.length });
    res.end(data);
  }

  async function readJsonBody(req) {
    const buf = await readBody(req, 100000);
    if (!buf.length) return {};
    return JSON.parse(buf.toString('utf8'));
  }

  async function handleApi(req, res, u) {
    const p = u.pathname.slice((NS + '/api').length);
    if (req.headers['sec-fetch-site'] === 'cross-site') return plain(res, 403, 'hawat: cross-site request refused');
    if (req.method !== 'GET') {
      const origin = req.headers.origin;
      if (req.headers['x-hawat-ui'] !== '1' || (origin && origin !== 'http://' + req.headers.host)) return plain(res, 403, 'hawat: refused');
    }

    if (req.method === 'GET' && p === '/events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no',
        'content-security-policy': GUI_CSP,
      });
      res.write('retry: 2000\n\n');
      guiClients.add(res);
      req.on('close', () => guiClients.delete(res));
      return undefined;
    }
    if (req.method === 'GET' && p === '/state') return json(res, 200, { ...publicState(), stats: store.stats() });
    if (req.method === 'GET' && p === '/records') return json(res, 200, store.list());
    const m = /^\/records\/([a-z0-9]+)$/.exec(p);
    if (req.method === 'GET' && m) {
      const rec = store.get(m[1]);
      if (!rec) return json(res, 404, { error: 'record not found (it may have been evicted)' });
      return json(res, 200, rec);
    }
    if (req.method === 'POST' && p === '/clear') { store.clear(); return json(res, 200, { ok: true }); }
    if (req.method === 'POST' && p === '/local-enabled') {
      let body;
      try { body = await readJsonBody(req); } catch (e) { return json(res, 400, { error: 'invalid JSON' }); }
      state.localEnabled = !!body.enabled;
      broadcast({ type: 'state', state: publicState() });
      return json(res, 200, publicState());
    }
    if (req.method === 'POST' && p === '/recheck-local') { await checkLocal(); return json(res, 200, publicState()); }
    return json(res, 404, { error: 'unknown endpoint' });
  }

  async function handleGui(req, res) {
    const u = new URL(req.url, 'http://x');
    const p = u.pathname;
    if (p === NS) { res.writeHead(302, { location: NS + '/' }); return res.end(); }
    if (p === NS + '/' && req.method === 'GET') return serveStatic(res, 'index.html', 'text/html; charset=utf-8');
    if (p === NS + '/app.js' && req.method === 'GET') return serveStatic(res, 'app.js', 'text/javascript; charset=utf-8');
    if (p === NS + '/style.css' && req.method === 'GET') return serveStatic(res, 'style.css', 'text/css; charset=utf-8');
    if (p.startsWith(NS + '/api/')) return handleApi(req, res, u);
    return plain(res, 404, 'not found');
  }

  const server = http.createServer((req, res) => {
    const run = async () => {
      if (!allowedHost(req.headers.host)) return plain(res, 403, 'hawat: unexpected Host header');
      const target = req.url || '/';
      if (target === NS || target.startsWith(NS + '/')) return handleGui(req, res);
      // A browser opening the bare address lands on the inspector. Only a page request for exactly "/";
      // anything else (including API clients that do not ask for HTML) is proxied as usual.
      if (target === '/' && (req.method === 'GET' || req.method === 'HEAD') && /text\/html/i.test(req.headers.accept || '')) {
        res.writeHead(302, { location: NS + '/', 'cache-control': 'no-store' });
        return res.end();
      }
      return handleProxy(req, res);
    };
    run().catch((err) => {
      try { plain(res, 500, 'hawat internal error: ' + err.message); } catch (e) { /* socket already gone */ }
    });
  });
  server.keepAliveTimeout = 65000;

  // ---------- HTTPS proxy mode (CONNECT) ----------
  // Claude Code is pointed here with HTTPS_PROXY. Hosts in cfg.intercept.hosts get TLS terminated with our own
  // name-constrained certificate so the model field can be read and routed. Every other host is a blind tunnel.

  const interceptHosts = new Set((cfg.intercept.hosts || []).map((h) => h.toLowerCase()));
  let secureContext = null;
  const tunnelSockets = new Set();

  function loadIntercept() {
    const leaf = loadLeaf(cfg.intercept.certDir);
    if (!interceptHosts.size) { state.intercept = { ready: false, hosts: [], reason: 'no intercept hosts configured' }; return; }
    if (!leaf) {
      state.intercept = { ready: false, hosts: [...interceptHosts], reason: 'no certificate yet: run `node bin/hawat.js certs`' };
      return;
    }
    try {
      secureContext = tls.createSecureContext({ key: leaf.keyPem, cert: leaf.certPem });
      state.intercept = { ready: true, hosts: [...interceptHosts], reason: null, certDir: leaf.dir, caFile: leaf.ca };
    } catch (e) {
      state.intercept = { ready: false, hosts: [...interceptHosts], reason: 'certificate not usable: ' + e.message };
    }
  }

  function parseAuthority(a) {
    const m = /^\[([^\]]+)\]:(\d+)$/.exec(a) || /^([^:]+):(\d+)$/.exec(a);
    if (!m) return null;
    const port = Number(m[2]);
    if (!(port > 0 && port < 65536)) return null;
    return { host: m[1].toLowerCase(), port };
  }

  // Requests that arrive inside an intercepted tunnel: same proxy logic, never the inspector.
  const interceptServer = http.createServer((req, res) => {
    handleProxy(req, res).catch((err) => {
      try { plain(res, 500, 'hawat internal error: ' + err.message); } catch (e) { /* socket already gone */ }
    });
  });
  interceptServer.keepAliveTimeout = 65000;

  function refuseConnect(socket, status, text) {
    try { socket.end('HTTP/1.1 ' + status + '\r\ncontent-type: text/plain\r\nconnection: close\r\ncontent-length: ' + Buffer.byteLength(text) + '\r\n\r\n' + text); } catch (e) { socket.destroy(); }
  }

  server.on('connect', (req, clientSocket, head) => {
    clientSocket.on('error', () => {});
    const target = parseAuthority(req.url || '');
    if (!target) return refuseConnect(clientSocket, '400 Bad Request', 'hawat: expected CONNECT host:port');

    if (interceptHosts.has(target.host)) {
      if (target.port !== 443) return refuseConnect(clientSocket, '403 Forbidden', 'hawat: only port 443 is intercepted for ' + target.host);
      if (!state.intercept.ready) return refuseConnect(clientSocket, '502 Bad Gateway', 'hawat: HTTPS interception is not set up (' + state.intercept.reason + ')');
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head && head.length) clientSocket.unshift(head);
      const tlsSocket = new tls.TLSSocket(clientSocket, { isServer: true, secureContext, ALPNProtocols: ['http/1.1'] });
      tlsSocket.on('error', () => { tlsSocket.destroy(); });
      interceptServer.emit('connection', tlsSocket);
      return undefined;
    }

    if (cfg.intercept.tunnel === false) return refuseConnect(clientSocket, '403 Forbidden', 'hawat: tunnels are switched off');
    const upstream = net.connect({ host: target.host, port: target.port });
    tunnelSockets.add(clientSocket); tunnelSockets.add(upstream);
    state.tunnels.total++; state.tunnels.open++;
    state.tunnels.hosts[target.host] = (state.tunnels.hosts[target.host] || 0) + 1;
    let counted = true;
    const done = () => {
      if (counted) { counted = false; state.tunnels.open--; }
      tunnelSockets.delete(clientSocket); tunnelSockets.delete(upstream);
      clientSocket.destroy(); upstream.destroy();
    };
    let established = false;
    upstream.on('error', (e) => {
      if (!established && !clientSocket.destroyed) refuseConnect(clientSocket, '502 Bad Gateway', 'hawat: could not reach ' + target.host + ': ' + e.message);
      done();
    });
    upstream.on('connect', () => {
      established = true;
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head && head.length) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    upstream.on('close', done);
    clientSocket.on('close', done);
    return undefined;
  });

  async function start() {
    loadIntercept();
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(cfg.port, cfg.host, resolve);
    });
    listeningPort = server.address().port;
    await checkLocal();
    timers.push(setInterval(checkLocal, 10000));
    timers.push(setInterval(() => { for (const c of guiClients) c.write(': ping\n\n'); }, 15000));
    for (const t of timers) t.unref();
    return { port: listeningPort, host: cfg.host };
  }

  async function close() {
    for (const t of timers) clearInterval(t);
    for (const c of guiClients) c.end();
    guiClients.clear();
    agents['http:'].destroy();
    agents['https:'].destroy();
    for (const sock of tunnelSockets) sock.destroy();
    tunnelSockets.clear();
    await new Promise((resolve) => { interceptServer.close(() => resolve()); interceptServer.closeAllConnections(); });
    await new Promise((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
  }

  return { server, store, state, start, close, publicState };
}

module.exports = { createHawat };
