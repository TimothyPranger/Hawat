'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, send } = require('./helpers');

const SECRET = 'sk-ant-oat01-SECRETSECRETSECRETSECRET1234';
const clientHeaders = () => ({
  'content-type': 'application/json',
  authorization: 'Bearer ' + SECRET,
  'x-api-key': 'sk-ant-api03-ANOTHERSECRETVALUE0000',
  'anthropic-version': '2023-06-01',
  'anthropic-beta': 'oauth-2025-04-20,interleaved-thinking-2025-05-14',
  'x-claude-code-session-id': 'sess-1',
  'user-agent': 'claude-cli/test',
});

test('passthrough: bytes and headers reach Anthropic unchanged, response comes back unchanged', async () => {
  const t = await setup({ anthBehaviour: 'gzip-json' });
  try {
    const body = Buffer.from('{"model" :  "claude-sonnet-5-5",  "max_tokens":5,\n "messages":[{"role":"user","content":"héllo wörld ✓"}]}');
    const res = await send(t.port, { path: '/v1/messages?beta=true', headers: { ...clientHeaders(), 'content-length': body.length }, body });
    assert.equal(res.status, 200);

    assert.equal(t.anth.received.length, 1);
    const got = t.anth.received[0];
    assert.equal(got.url, '/v1/messages?beta=true');
    assert.ok(got.body.equals(body), 'request body must be byte-identical');
    assert.equal(got.headers.authorization, 'Bearer ' + SECRET);
    assert.equal(got.headers['x-api-key'], 'sk-ant-api03-ANOTHERSECRETVALUE0000');
    assert.equal(got.headers['anthropic-beta'], 'oauth-2025-04-20,interleaved-thinking-2025-05-14');
    assert.equal(got.headers['user-agent'], 'claude-cli/test');
    assert.equal(got.headers['x-claude-code-session-id'], 'sess-1');
    assert.equal(got.headers.host, '127.0.0.1:' + t.anth.port);

    assert.equal(res.headers['content-encoding'], 'gzip');
    assert.equal(res.headers['x-custom'], 'abc');
    assert.ok(res.body.equals(t.anth.gzBodies[0]), 'response bytes must be identical (still gzipped)');
    assert.equal(t.lm.received.filter((r) => r.url.startsWith('/v1/messages')).length, 0);
  } finally { await t.cleanup(); }
});

test('passthrough: record shows decoded response, usage, and never contains the secrets', async () => {
  const t = await setup({ anthBehaviour: 'gzip-json' });
  try {
    const body = Buffer.from(JSON.stringify({ model: 'claude-sonnet-5-5', max_tokens: 5, messages: [{ role: 'user', content: 'ping' }] }));
    await send(t.port, { headers: { ...clientHeaders(), 'content-length': body.length }, body });
    const [s] = (await t.done());
    assert.equal(s.target, 'anthropic');
    assert.equal(s.mode, 'passthrough');
    assert.equal(s.status, 200);
    assert.deepEqual(s.tokens, { input: 10, output: 5, cacheRead: 7, cacheCreate: 0 });
    const rec = t.hawat.store.get(s.id);
    assert.equal(rec.response.assembled.content[0].text, 'hi there');
    assert.equal(rec.upstream.identical, true);
    const dump = JSON.stringify(rec);
    assert.ok(!dump.includes(SECRET), 'OAuth token must not be stored');
    assert.ok(!dump.includes('ANOTHERSECRETVALUE'), 'API key must not be stored');
    const auth = rec.clientHeaders.find((h) => h.name === 'authorization');
    assert.equal(auth.masked, true);
    assert.match(auth.value, /masked/);
  } finally { await t.cleanup(); }
});

test('local route: goes to LM Studio, rewritten, and your Claude credentials never leave', async () => {
  const t = await setup();
  try {
    const body = Buffer.from(JSON.stringify({
      model: 'local-qwen', max_tokens: 100, stream: false,
      thinking: { type: 'adaptive' },
      context_management: { edits: [] },
      output_config: { effort: 'high' },
      system: [{ type: 'text', text: 'You are a worker', cache_control: { type: 'ephemeral' } }],
      tools: [{ name: 'Read', description: 'd', input_schema: { type: 'object' }, defer_loading: true, strict: true }],
      messages: [{ role: 'user', content: [{ type: 'text', text: 'do the thing', cache_control: { type: 'ephemeral' } }] }],
    }));
    const res = await send(t.port, {
      path: '/v1/messages?beta=true',
      headers: { ...clientHeaders(), 'x-claude-code-agent-id': 'agent-9', 'content-length': body.length }, body,
    });
    assert.equal(res.status, 200);

    assert.equal(t.anth.received.length, 0, 'nothing may go to Anthropic');
    const lmReq = t.lm.received.find((r) => r.url.startsWith('/v1/messages'));
    assert.ok(lmReq, 'LM Studio must get the request');
    assert.equal(lmReq.url, '/v1/messages', 'beta query param removed');
    assert.equal(lmReq.headers['x-api-key'], 'lm-token', 'only the local token is sent');
    assert.equal(lmReq.headers.authorization, undefined);
    assert.equal(lmReq.headers['anthropic-beta'], undefined);
    const everything = JSON.stringify(t.lm.received.map((r) => ({ h: r.headers, b: r.body.toString() })));
    assert.ok(!everything.includes(SECRET), 'Claude OAuth token leaked to LM Studio');
    assert.ok(!everything.includes('ANOTHERSECRETVALUE'), 'Claude API key leaked to LM Studio');

    const sent = JSON.parse(lmReq.body.toString());
    assert.equal(sent.model, 'qwen-test');
    assert.equal(sent.thinking, undefined);
    assert.equal(sent.context_management, undefined);
    assert.equal(sent.output_config, undefined);
    assert.equal(sent.tools[0].defer_loading, undefined);
    assert.equal(sent.tools[0].strict, undefined);
    assert.equal(sent.system[0].cache_control, undefined);
    assert.equal(sent.messages[0].content[0].cache_control, undefined);
    assert.equal(sent.messages[0].content[0].text, 'do the thing');
    assert.equal(Number(lmReq.headers['content-length']), lmReq.body.length);

    const [s] = (await t.done());
    assert.equal(s.mode, 'redirect');
    assert.equal(s.target, 'local');
    assert.equal(s.modelIn, 'local-qwen');
    assert.equal(s.modelOut, 'qwen-test');
    assert.equal(s.isSubagent, true);
    const rec = t.hawat.store.get(s.id);
    assert.ok(rec.route.strippedHeaders.map((h) => h.toLowerCase()).includes('authorization'));
    assert.ok(rec.route.strippedHeaders.map((h) => h.toLowerCase()).includes('anthropic-beta'));
    assert.ok(rec.route.strippedBodyFields.includes('thinking'));
    assert.deepEqual(rec.route.rewrites[0], { field: 'model', from: 'local-qwen', to: 'qwen-test' });
    assert.ok(!JSON.stringify(rec).includes(SECRET));
  } finally { await t.cleanup(); }
});

test('streaming: chunks are forwarded as they arrive and the stream is reassembled for the GUI', async () => {
  const t = await setup({ anthBehaviour: 'sse' });
  try {
    const body = Buffer.from(JSON.stringify({ model: 'claude-sonnet-5-5', max_tokens: 20, stream: true, messages: [{ role: 'user', content: 'hi' }] }));
    const res = await send(t.port, { headers: { ...clientHeaders(), 'content-length': body.length }, body });
    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'], /text\/event-stream/);
    assert.ok(res.chunks.length >= 2, 'must arrive in several chunks, not buffered');
    assert.ok(res.times[res.times.length - 1] - res.times[0] >= 200, 'first chunk must arrive well before the last');
    assert.match(res.body.toString(), /message_stop/);

    const [s] = (await t.done());
    assert.equal(s.streamed, true);
    assert.deepEqual(s.tokens, { input: 12, output: 4, cacheRead: 5, cacheCreate: 2 });
    const rec = t.hawat.store.get(s.id);
    assert.equal(rec.response.assembled.content[0].text, 'Hello world');
    assert.equal(rec.response.assembled.stop_reason, 'end_turn');
    assert.equal(rec.response.assembled.complete, true);
    assert.ok(rec.timing.ttfbMs < rec.timing.totalMs);
  } finally { await t.cleanup(); }
});

test('local route streaming works the same way', async () => {
  const t = await setup({ lmBehaviour: 'sse' });
  try {
    const body = Buffer.from(JSON.stringify({ model: 'local-qwen', max_tokens: 20, stream: true, messages: [{ role: 'user', content: 'hi' }] }));
    const res = await send(t.port, { headers: { ...clientHeaders(), 'content-length': body.length }, body });
    assert.equal(res.status, 200);
    assert.ok(res.chunks.length >= 2);
    const [s] = (await t.done());
    assert.equal(s.target, 'local');
    assert.equal(t.hawat.store.get(s.id).response.assembled.content[0].text, 'Hello world');
  } finally { await t.cleanup(); }
});

test('GET requests without a body are forwarded', async () => {
  const t = await setup();
  try {
    const res = await send(t.port, { method: 'GET', path: '/v1/models', headers: clientHeaders() });
    assert.equal(res.status, 200);
    const got = t.anth.received.find((r) => r.url === '/v1/models');
    assert.ok(got);
    assert.equal(got.headers.authorization, 'Bearer ' + SECRET);
    assert.equal((await t.done())[0].mode, 'passthrough');
  } finally { await t.cleanup(); }
});

test('non-JSON and unmatched models pass straight through', async () => {
  const t = await setup();
  try {
    const raw = Buffer.from('not json at all');
    await send(t.port, { path: '/v1/messages', headers: { 'content-type': 'text/plain', 'content-length': raw.length }, body: raw });
    const body2 = Buffer.from(JSON.stringify({ model: 'claude-opus-5-5', messages: [] }));
    await send(t.port, { headers: { 'content-type': 'application/json', 'content-length': body2.length }, body: body2 });
    assert.equal(t.anth.received.length, 2);
    assert.ok(t.anth.received[0].body.equals(raw));
    assert.ok(t.anth.received[1].body.equals(body2));
    assert.equal(t.lm.received.filter((r) => r.url.startsWith('/v1/messages')).length, 0);
  } finally { await t.cleanup(); }
});

test('local routing switched off: model is swapped for the fallback and sent to Anthropic with credentials intact', async () => {
  const t = await setup({ overrides: { localEnabled: false } });
  try {
    const body = Buffer.from(JSON.stringify({ model: 'local-qwen', max_tokens: 5, messages: [{ role: 'user', content: 'hi' }] }));
    const res = await send(t.port, { headers: { ...clientHeaders(), 'content-length': body.length }, body });
    assert.equal(res.status, 200);
    const got = t.anth.received[0];
    assert.equal(JSON.parse(got.body.toString()).model, 'claude-haiku-5-5');
    assert.equal(got.headers.authorization, 'Bearer ' + SECRET);
    assert.equal(Number(got.headers['content-length']), got.body.length);
    const [s] = (await t.done());
    assert.equal(s.mode, 'fallback');
    assert.equal(s.modelOut, 'claude-haiku-5-5');
  } finally { await t.cleanup(); }
});

test('LM Studio down: clear 502 in Anthropic error shape, recorded as an error', async () => {
  const t = await setup({ lmDown: true });
  try {
    const body = Buffer.from(JSON.stringify({ model: 'local-qwen', max_tokens: 5, messages: [{ role: 'user', content: 'hi' }] }));
    const res = await send(t.port, { headers: { ...clientHeaders(), 'content-length': body.length }, body });
    assert.equal(res.status, 502);
    const parsed = JSON.parse(res.body.toString());
    assert.equal(parsed.type, 'error');
    assert.match(parsed.error.message, /LM Studio/);
    assert.equal(t.anth.received.length, 0, 'must not silently spend Claude tokens');
    const [s] = (await t.done());
    assert.equal(s.state, 'error');
    assert.match(s.error, /LM Studio/);
  } finally { await t.cleanup(); }
});

test('LM Studio down with fallbackOnLocalDown: retried on Anthropic with the fallback model', async () => {
  const route = {
    name: 'local-worker', match: { model: 'local-qwen' }, target: 'local', rewriteModel: 'auto',
    fallbackModel: 'claude-haiku-5-5', fallbackOnLocalDown: true,
  };
  const t = await setup({ lmDown: true, overrides: { routes: [route] } });
  try {
    const body = Buffer.from(JSON.stringify({ model: 'local-qwen', max_tokens: 5, messages: [{ role: 'user', content: 'hi' }] }));
    const res = await send(t.port, { headers: { ...clientHeaders(), 'content-length': body.length }, body });
    assert.equal(res.status, 200);
    assert.equal(JSON.parse(t.anth.received[0].body.toString()).model, 'claude-haiku-5-5');
    assert.equal(t.anth.received[0].headers.authorization, 'Bearer ' + SECRET);
    const [s] = (await t.done());
    assert.equal(s.mode, 'fallback');
    assert.equal(s.fellBack, true);
  } finally { await t.cleanup(); }
});

test('client disconnect mid-stream is recorded and does not crash the proxy', async () => {
  const t = await setup({ anthBehaviour: 'sse' });
  try {
    const http = require('node:http');
    const body = Buffer.from(JSON.stringify({ model: 'claude-sonnet-5-5', max_tokens: 20, stream: true, messages: [{ role: 'user', content: 'hi' }] }));
    await new Promise((resolve) => {
      const req = http.request({ host: '127.0.0.1', port: t.port, method: 'POST', path: '/v1/messages', headers: { host: '127.0.0.1:' + t.port, 'content-type': 'application/json', 'content-length': body.length }, agent: false }, (res) => {
        res.once('data', () => { req.destroy(); setTimeout(resolve, 400); });
      });
      req.on('error', () => {});
      req.end(body);
    });
    const [s] = (await t.done());
    assert.equal(s.state, 'aborted');
    const res = await send(t.port, { method: 'GET', path: '/v1/models' });
    assert.equal(res.status, 200, 'proxy still alive');
  } finally { await t.cleanup(); }
});

test('guards: bad Host header, browser Origin, and unauthenticated GUI writes are refused', async () => {
  const t = await setup();
  try {
    const bad = await send(t.port, { method: 'GET', path: '/v1/models', headers: { host: 'evil.example:' + t.port } });
    assert.equal(bad.status, 403);
    const origin = await send(t.port, { method: 'GET', path: '/v1/models', headers: { origin: 'https://evil.example' } });
    assert.equal(origin.status, 403);
    assert.equal(t.anth.received.length, 0);
    const noHeader = await send(t.port, { method: 'POST', path: '/__hawat/api/clear', headers: {} });
    assert.equal(noHeader.status, 403);
    const wrongOrigin = await send(t.port, { method: 'POST', path: '/__hawat/api/clear', headers: { 'x-hawat-ui': '1', origin: 'https://evil.example' } });
    assert.equal(wrongOrigin.status, 403);
    const ok = await send(t.port, { method: 'POST', path: '/__hawat/api/clear', headers: { 'x-hawat-ui': '1' } });
    assert.equal(ok.status, 200);
  } finally { await t.cleanup(); }
});

test('GUI API: list, detail, state, toggle and clear', async () => {
  const t = await setup();
  try {
    const body = Buffer.from(JSON.stringify({ model: 'claude-sonnet-5-5', max_tokens: 5, messages: [{ role: 'user', content: 'ping' }] }));
    await send(t.port, { headers: { ...clientHeaders(), 'content-length': body.length }, body });
    const list = JSON.parse((await send(t.port, { method: 'GET', path: '/__hawat/api/records' })).body.toString());
    assert.equal(list.length, 1);
    const detail = JSON.parse((await send(t.port, { method: 'GET', path: '/__hawat/api/records/' + list[0].id })).body.toString());
    assert.equal(detail.request.bodyText, body.toString());
    assert.ok(!JSON.stringify(detail).includes(SECRET));
    const state = JSON.parse((await send(t.port, { method: 'GET', path: '/__hawat/api/state' })).body.toString());
    assert.equal(state.localEnabled, true);
    assert.equal(state.local.ok, true);
    assert.deepEqual(state.local.models, ['qwen-test']);
    const toggled = JSON.parse((await send(t.port, { method: 'POST', path: '/__hawat/api/local-enabled', headers: { 'x-hawat-ui': '1', 'content-type': 'application/json' }, body: Buffer.from('{"enabled":false}') })).body.toString());
    assert.equal(toggled.localEnabled, false);
    await send(t.port, { method: 'POST', path: '/__hawat/api/clear', headers: { 'x-hawat-ui': '1' } });
    assert.equal(JSON.parse((await send(t.port, { method: 'GET', path: '/__hawat/api/records' })).body.toString()).length, 0);
  } finally { await t.cleanup(); }
});

test('a browser opening / is sent to the inspector; other requests for / are still forwarded', async () => {
  const t = await setup();
  try {
    const page = await send(t.port, { method: 'GET', path: '/', headers: { accept: 'text/html,application/xhtml+xml' } });
    assert.equal(page.status, 302);
    assert.equal(page.headers.location, '/__hawat/');
    assert.equal(t.anth.received.filter((r) => r.url === '/').length, 0);
    const api = await send(t.port, { method: 'GET', path: '/', headers: { accept: 'application/json', ...clientHeaders() } });
    assert.equal(api.status, 200);
    const got = t.anth.received.find((r) => r.url === '/');
    assert.ok(got);
    assert.equal(got.headers.authorization, 'Bearer ' + SECRET);
  } finally { await t.cleanup(); }
});
