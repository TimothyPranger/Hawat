'use strict';
const http = require('node:http');
const zlib = require('node:zlib');
const { loadConfig } = require('../src/config');
const { createHawat } = require('../src/hawat');

function listen(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve({
      server,
      port: server.address().port,
      close: () => new Promise((r) => { server.close(() => r()); server.closeAllConnections(); }),
    }));
  });
}

function readAll(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('close', () => resolve(Buffer.concat(chunks)));
  });
}

const sseEvents = (text, outTokens = 4) => [
  ['message_start', { type: 'message_start', message: { id: 'msg_1', model: 'fake-model', usage: { input_tokens: 12, output_tokens: 1, cache_read_input_tokens: 5, cache_creation_input_tokens: 2 } } }],
  ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
  ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: text.slice(0, 6) } }],
  ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: text.slice(6) } }],
  ['content_block_stop', { type: 'content_block_stop', index: 0 }],
  ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: outTokens } }],
  ['message_stop', { type: 'message_stop' }],
].map(([e, d]) => 'event: ' + e + '\ndata: ' + JSON.stringify(d) + '\n\n');

/**
 * A stand-in for Anthropic or LM Studio. Records every request it receives.
 * behaviour: 'json' | 'gzip-json' | 'sse'
 */
async function fakeUpstream({ behaviour = 'json', models = ['qwen-test'] } = {}) {
  const received = [];
  const gzBodies = [];
  const up = await listen(async (req, res) => {
    const body = await readAll(req);
    received.push({ method: req.method, url: req.url, headers: req.headers, rawHeaders: req.rawHeaders, body });
    if (req.method === 'GET' && req.url === '/v1/models') {
      const b = JSON.stringify({ data: models.map((id) => ({ id })) });
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(b);
    }
    if (req.url.startsWith('/v1/messages') && behaviour === 'sse') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      const ev = sseEvents('Hello world');
      res.write(ev[0] + ev[1]);
      await new Promise((r) => setTimeout(r, 250));
      res.write(ev[2] + ev[3]);
      await new Promise((r) => setTimeout(r, 100));
      res.end(ev[4] + ev[5] + ev[6]);
      return undefined;
    }
    const payload = JSON.stringify({
      id: 'msg_x', type: 'message', model: 'fake-model', role: 'assistant',
      content: [{ type: 'text', text: 'hi there' }], stop_reason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 7 },
    });
    if (behaviour === 'gzip-json') {
      const gz = zlib.gzipSync(payload);
      gzBodies.push(gz);
      res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip', 'content-length': gz.length, 'x-custom': 'abc' });
      return res.end(gz);
    }
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
    return res.end(payload);
  });
  return { ...up, received, gzBodies };
}

function send(port, { method = 'POST', path = '/v1/messages', headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const h = { host: '127.0.0.1:' + port, ...headers };
    const req = http.request({ host: '127.0.0.1', port, method, path, headers: h, agent: false }, (res) => {
      const chunks = [];
      const times = [];
      res.on('data', (c) => { chunks.push(c); times.push(Date.now()); });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, rawHeaders: res.rawHeaders, body: Buffer.concat(chunks), chunks, times }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function setup({ anthBehaviour = 'json', lmBehaviour = 'json', overrides = {}, lmDown = false } = {}) {
  const anth = await fakeUpstream({ behaviour: anthBehaviour });
  const lm = await fakeUpstream({ behaviour: lmBehaviour });
  let lmPort = lm.port;
  if (lmDown) { await lm.close(); lmPort = lm.port; }
  const cfg = loadConfig({
    cwd: '/nonexistent',
    overrides: {
      port: 0,
      anthropic: { baseUrl: 'http://127.0.0.1:' + anth.port },
      local: { baseUrl: 'http://127.0.0.1:' + lmPort, apiKey: 'lm-token' },
      ...overrides,
    },
  });
  const hawat = createHawat(cfg);
  const info = await hawat.start();
  return {
    hawat, anth, lm, cfg, port: info.port,
    /** Wait until every recorded request has finished being captured, then return the list. */
    async done() {
      const end = Date.now() + 3000;
      for (;;) {
        const list = hawat.store.list();
        if (list.length && list.every((r) => r.state !== 'pending' && r.state !== 'streaming')) return list;
        if (Date.now() > end) return list;
        await new Promise((r) => setTimeout(r, 10));
      }
    },
    async cleanup() { await hawat.close(); await anth.close(); if (!lmDown) await lm.close(); },
  };
}

module.exports = { setup, send, listen, fakeUpstream, sseEvents };
