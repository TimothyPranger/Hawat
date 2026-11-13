#!/usr/bin/env node
'use strict';
/**
 * Demo mode: starts Hawat with a pretend Anthropic and a pretend LM Studio, then sends
 * sample traffic so you can explore the inspector without Claude Code. Nothing leaves this machine.
 */
const http = require('node:http');
const zlib = require('node:zlib');
const { loadConfig } = require('../src/config');
const { createHawat } = require('../src/hawat');

const ev = (name, data) => 'event: ' + name + '\ndata: ' + JSON.stringify(data) + '\n\n';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function streamReply(model, usage) {
  return async (res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    res.write(ev('message_start', { type: 'message_start', message: { id: 'msg_demo', model, usage: { input_tokens: usage.in, output_tokens: 1, cache_read_input_tokens: usage.cr || 0, cache_creation_input_tokens: usage.cc || 0 } } }));
    res.write(ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }));
    res.write(ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'The task is to rename the helper in three files. I should read them first.' } }));
    res.write(ev('content_block_stop', { type: 'content_block_stop', index: 0 }));
    await sleep(300);
    res.write(ev('content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }));
    res.write(ev('content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: "I'll start by reading the three files that use the helper." } }));
    res.write(ev('content_block_stop', { type: 'content_block_stop', index: 1 }));
    res.write(ev('content_block_start', { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'toolu_1', name: 'Read', input: {} } }));
    res.write(ev('content_block_delta', { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"file_path":' } }));
    await sleep(300);
    res.write(ev('content_block_delta', { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: ' "/work/app/Helper.swift"}' } }));
    res.write(ev('content_block_stop', { type: 'content_block_stop', index: 2 }));
    res.write(ev('message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: usage.out } }));
    res.end(ev('message_stop', { type: 'message_stop' }));
  };
}

function fakeServer(kind) {
  return http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      if (req.url === '/v1/models') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ data: [{ id: 'qwen3.8-27b-mlx-4bit' }, { id: 'text-embedding-nomic' }] }));
      }
      let body = {};
      try { body = JSON.parse(Buffer.concat(chunks).toString()); } catch (e) { /* ignore */ }
      if (body.stream) return streamReply(body.model || kind, kind === 'local' ? { in: 5200, out: 310 } : { in: 900, out: 180, cr: 41000, cc: 600 })(res);
      const payload = JSON.stringify({
        id: 'msg_demo2', type: 'message', role: 'assistant', model: body.model,
        content: [{ type: 'text', text: 'Done. All three call sites now use the new name.' }], stop_reason: 'end_turn',
        usage: { input_tokens: 1200, output_tokens: 95, cache_read_input_tokens: 38000, cache_creation_input_tokens: 0 },
      });
      const gz = zlib.gzipSync(payload);
      res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip', 'content-length': gz.length, 'request-id': 'req_demo123' });
      return res.end(gz);
    });
  });
}

function post(port, headers, obj) {
  const body = Buffer.from(JSON.stringify(obj));
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/v1/messages?beta=true', agent: false,
      headers: { host: '127.0.0.1:' + port, 'content-type': 'application/json', 'content-length': body.length, authorization: 'Bearer sk-ant-oat01-demo-token-not-real-0000000000', 'anthropic-version': '2023-06-01', 'anthropic-beta': 'oauth-2025-04-20', 'user-agent': 'claude-cli/demo', ...headers } },
    (res) => { res.resume(); res.on('end', resolve); });
    req.on('error', resolve);
    req.end(body);
  });
}

async function main() {
  const anth = fakeServer('anthropic');
  const lm = fakeServer('local');
  await new Promise((r) => anth.listen(0, '127.0.0.1', r));
  await new Promise((r) => lm.listen(0, '127.0.0.1', r));
  const port = Number(process.env.PORT || 8719);
  const cfg = loadConfig({ cwd: '/nonexistent', overrides: { port, anthropic: { baseUrl: 'http://127.0.0.1:' + anth.address().port }, local: { baseUrl: 'http://127.0.0.1:' + lm.address().port } } });
  const hawat = createHawat(cfg);
  const info = await hawat.start();
  console.log('Hawat demo is running: http://127.0.0.1:' + info.port + '/__hawat/');
  console.log('Everything here is pretend traffic. Press Ctrl+C to stop.');

  const sys = [{ type: 'text', text: 'You are Claude Code, an interactive CLI for software engineering. ' + 'Follow the project conventions. '.repeat(30), cache_control: { type: 'ephemeral' } }];
  const tools = [{ name: 'Read', description: 'Reads a file', input_schema: { type: 'object' }, defer_loading: false }, { name: 'Edit', description: 'Edits a file', input_schema: { type: 'object' } }, { name: 'Bash', description: 'Runs a command', input_schema: { type: 'object' } }];
  const main = (text, model) => ({ model: model || 'claude-sonnet-5-5', max_tokens: 32000, stream: true, thinking: { type: 'adaptive' }, system: sys, tools, messages: [{ role: 'user', content: [{ type: 'text', text: '<system-reminder>Today is a good day.</system-reminder>' }, { type: 'text', text }] }] });

  await post(info.port, { 'x-claude-code-session-id': 'sess-demo' }, main('Rename the loadUser helper to fetchUser everywhere and make sure the tests still pass.'));
  await sleep(500);
  await post(info.port, { 'x-claude-code-session-id': 'sess-demo', 'x-claude-code-agent-id': 'agent-a1' },
    { ...main('Rename loadUser to fetchUser in Helper.swift, UserStore.swift and UserView.swift. Do not touch tests. Report only the list of changed files.', 'local-qwen'), tools: [...tools, { name: 'Glob', description: 'Find files', input_schema: { type: 'object' }, defer_loading: true }] });
  await sleep(400);
  await post(info.port, { 'x-claude-code-session-id': 'sess-demo', 'x-claude-code-agent-id': 'agent-b2' },
    main('Write unit tests for the new fetchUser function, covering the empty and error cases.', 'local-qwen'));
  await sleep(400);
  await post(info.port, { 'x-claude-code-session-id': 'sess-demo', 'x-claude-code-agent-id': 'agent-c3' }, { ...main('Summarise the build log.', 'claude-haiku-5-5'), stream: false });
  await sleep(300);
  await post(info.port, { 'x-claude-code-session-id': 'sess-demo' }, main('Great, now run the whole test suite and tell me the result.'));

  process.on('SIGINT', async () => { await hawat.close(); anth.close(); lm.close(); process.exit(0); });
}
main();
