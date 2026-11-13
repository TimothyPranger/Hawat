'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const tls = require('node:tls');
const http = require('node:http');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { setup, listen } = require('./helpers');
const { generateCerts } = require('../src/certs');

const SECRET = 'sk-ant-oat01-SECRETSECRETSECRETSECRET1234';
const hasOpenssl = (() => { try { execFileSync('openssl', ['version'], { stdio: 'ignore' }); return true; } catch (e) { return false; } })();
const opts = { skip: hasOpenssl ? false : 'openssl is not installed' };

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'hawat-certs-')); }

/** Send CONNECT and resolve with { status, head, socket } once the proxy answered. */
function connect(port, authority) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    let buf = Buffer.alloc(0);
    socket.on('error', reject);
    socket.on('data', function onData(c) {
      buf = Buffer.concat([buf, c]);
      const i = buf.indexOf('\r\n\r\n');
      if (i < 0) return;
      socket.removeListener('data', onData);
      const status = Number(/^HTTP\/1\.1 (\d+)/.exec(buf.toString('latin1'))[1]);
      resolve({ status, text: buf.subarray(i + 4).toString(), socket });
    });
    socket.write('CONNECT ' + authority + ' HTTP/1.1\r\nHost: ' + authority + '\r\n\r\n');
  });
}

/**
 * HTTPS request to api.anthropic.com through the proxy, trusting only Hawat's CA.
 * Never pass `agent: false` here: Node would then ignore createConnection and dial the real host.
 */
async function viaProxy(port, ca, body, headers = {}) {
  const c = await connect(port, 'api.anthropic.com:443');
  assert.equal(c.status, 200);
  const tlsSocket = tls.connect({ socket: c.socket, servername: 'api.anthropic.com', ca, ALPNProtocols: ['http/1.1'] });
  return new Promise((resolve, reject) => {
    const req = http.request({ createConnection: () => tlsSocket, host: 'api.anthropic.com', path: '/v1/messages?beta=true', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': body.length, ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end', () => { tlsSocket.destroy(); resolve({ status: res.statusCode, body: Buffer.concat(chunks) }); });
    });
    req.on('error', reject);
    req.end(body);
  });
}

test('generated CA is limited to the listed host and its key is gone', opts, () => {
  const d = tmpDir();
  const r = generateCerts({ dir: d, hosts: ['api.anthropic.com'] });
  assert.deepEqual(fs.readdirSync(d).sort(), ['ca.pem', 'leaf.key', 'leaf.pem']);
  assert.equal(fs.statSync(r.key).mode & 0o077, 0, 'leaf key must be private');
  const text = execFileSync('openssl', ['x509', '-in', r.ca, '-noout', '-text']).toString();
  assert.match(text, /Name Constraints: critical/);
  assert.match(text, /DNS:api\.anthropic\.com/);
  assert.throws(() => generateCerts({ dir: d, hosts: ['api.anthropic.com'] }), /already exist/);
  assert.throws(() => generateCerts({ dir: tmpDir(), hosts: ['bad host'] }), /not a valid host/);
});

test('HTTPS proxy: a normal model goes to Anthropic unchanged, credentials intact', opts, async () => {
  const d = tmpDir();
  const certs = generateCerts({ dir: d, hosts: ['api.anthropic.com'] });
  const t = await setup({ overrides: { intercept: { hosts: ['api.anthropic.com'], certDir: d, tunnel: true } } });
  try {
    assert.equal(t.hawat.state.intercept.ready, true);
    const body = Buffer.from('{"model" : "claude-sonnet-5-5", "max_tokens":5,\n "messages":[{"role":"user","content":"héllo ✓"}]}');
    const res = await viaProxy(t.port, fs.readFileSync(certs.ca), body, { authorization: 'Bearer ' + SECRET, 'anthropic-beta': 'oauth-2025-04-20', 'anthropic-version': '2023-06-01' });
    assert.equal(res.status, 200, res.body.toString());
    assert.equal(t.anth.received.length, 1);
    const got = t.anth.received[0];
    assert.equal(got.url, '/v1/messages?beta=true');
    assert.ok(got.body.equals(body), 'body must be byte-identical');
    assert.equal(got.headers.authorization, 'Bearer ' + SECRET);
    assert.equal(got.headers['anthropic-beta'], 'oauth-2025-04-20');
    assert.equal(t.lm.received.filter((r) => r.url.startsWith('/v1/messages')).length, 0);
    const recs = await t.done();
    assert.equal(recs[0].mode, 'passthrough');
    assert.ok(!JSON.stringify(recs).includes(SECRET));
  } finally { await t.cleanup(); }
});

test('HTTPS proxy: local-qwen goes to LM Studio and credentials never reach it', opts, async () => {
  const d = tmpDir();
  const certs = generateCerts({ dir: d, hosts: ['api.anthropic.com'] });
  const t = await setup({ overrides: { intercept: { hosts: ['api.anthropic.com'], certDir: d, tunnel: true } } });
  try {
    const body = Buffer.from(JSON.stringify({ model: 'local-qwen', max_tokens: 20, thinking: { type: 'adaptive' }, messages: [{ role: 'user', content: 'hi' }] }));
    const res = await viaProxy(t.port, fs.readFileSync(certs.ca), body, { authorization: 'Bearer ' + SECRET, 'anthropic-beta': 'oauth-2025-04-20', 'x-claude-code-agent-id': 'agent-1' });
    assert.equal(res.status, 200);
    assert.equal(t.anth.received.length, 0, 'nothing may go to Anthropic');
    const lmReq = t.lm.received.find((r) => r.url.startsWith('/v1/messages'));
    assert.ok(lmReq);
    assert.equal(lmReq.headers['x-api-key'], 'lm-token');
    assert.equal(lmReq.headers.authorization, undefined);
    assert.ok(!JSON.stringify(t.lm.received.map((r) => ({ h: r.headers, b: r.body.toString() }))).includes(SECRET));
    const recs = await t.done();
    assert.equal(recs[0].mode, 'redirect');
    assert.equal(recs[0].isSubagent, true);
  } finally { await t.cleanup(); }
});

test('HTTPS proxy: other hosts are blind tunnels, the inspector is not reachable inside the tunnel', opts, async () => {
  const d = tmpDir();
  const certs = generateCerts({ dir: d, hosts: ['api.anthropic.com'] });
  const echo = await listen((req, res) => res.end('unused'));
  const tcp = net.createServer((s) => s.on('data', (c) => s.write(Buffer.concat([Buffer.from('echo:'), c]))));
  await new Promise((r) => tcp.listen(0, '127.0.0.1', r));
  const t = await setup({ overrides: { intercept: { hosts: ['api.anthropic.com'], certDir: d, tunnel: true } } });
  try {
    const c = await connect(t.port, '127.0.0.1:' + tcp.address().port);
    assert.equal(c.status, 200);
    const reply = await new Promise((resolve) => { c.socket.once('data', resolve); c.socket.write('ping'); });
    assert.equal(reply.toString(), 'echo:ping');
    assert.equal(t.hawat.state.tunnels.total, 1);
    assert.equal(t.hawat.store.list().length, 0, 'tunnels are not decoded or recorded');
    c.socket.destroy();

    // inside an intercepted tunnel the inspector path is just another API path, forwarded to Anthropic
    const tlsC = await connect(t.port, 'api.anthropic.com:443');
    const s = tls.connect({ socket: tlsC.socket, servername: 'api.anthropic.com', ca: fs.readFileSync(certs.ca) });
    const status = await new Promise((resolve, reject) => {
      const req = http.request({ createConnection: () => s, host: 'api.anthropic.com', path: '/__hawat/api/records', method: 'GET' }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
      req.on('error', reject); req.end();
    });
    assert.equal(status, 200);
    assert.equal(t.anth.received.filter((r) => r.url === '/__hawat/api/records').length, 1, 'forwarded, not served by Hawat');
    s.destroy();
  } finally { await t.cleanup(); await echo.close(); await new Promise((r) => tcp.close(r)); }
});

test('HTTPS proxy: refuses cleanly when not set up, on the wrong port, or with tunnels off', async () => {
  const t = await setup({ overrides: { intercept: { hosts: ['api.anthropic.com'], certDir: tmpDir() + '/missing', tunnel: false } } });
  try {
    assert.equal(t.hawat.state.intercept.ready, false);
    const a = await connect(t.port, 'api.anthropic.com:443');
    assert.equal(a.status, 502);
    assert.match(a.text, /not set up/);
    const b = await connect(t.port, 'api.anthropic.com:8443');
    assert.equal(b.status, 403);
    const c = await connect(t.port, 'example.com:443');
    assert.equal(c.status, 403);
    assert.match(c.text, /tunnels are switched off/);
    const d = await connect(t.port, 'garbage');
    assert.equal(d.status, 400);
  } finally { await t.cleanup(); }
});
