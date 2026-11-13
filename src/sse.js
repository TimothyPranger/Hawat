'use strict';

/**
 * Incremental parser for Anthropic Messages streaming (server-sent events).
 * Rebuilds the final message (text, thinking, tool calls, usage) from the events.
 */
class SseAssembler {
  constructor() {
    this.buf = '';
    this.blocks = [];
    this.byIndex = new Map();
    this.usage = {};
    this.stopReason = null;
    this.model = null;
    this.id = null;
    this.events = 0;
    this.error = null;
    this.complete = false;
  }

  push(text) {
    this.buf = (this.buf + text).replace(/\r\n/g, '\n');
    let idx;
    while ((idx = this.buf.indexOf('\n\n')) >= 0) {
      const raw = this.buf.slice(0, idx);
      this.buf = this.buf.slice(idx + 2);
      this._event(raw);
    }
  }

  _event(raw) {
    let name = null;
    const data = [];
    for (const line of raw.split('\n')) {
      if (!line || line.startsWith(':')) continue;
      const i = line.indexOf(':');
      const field = i < 0 ? line : line.slice(0, i);
      let value = i < 0 ? '' : line.slice(i + 1);
      if (value.startsWith(' ')) value = value.slice(1);
      if (field === 'event') name = value;
      else if (field === 'data') data.push(value);
    }
    if (!data.length) return;
    let d;
    try { d = JSON.parse(data.join('\n')); } catch (e) { return; }
    this.events++;
    const type = d.type || name;
    switch (type) {
      case 'message_start': {
        const m = d.message || {};
        this.model = m.model || this.model;
        this.id = m.id || this.id;
        this._usage(m.usage);
        break;
      }
      case 'content_block_start': {
        const cb = d.content_block || {};
        const block = { type: cb.type };
        if (cb.type === 'text') block.text = cb.text || '';
        else if (cb.type === 'thinking') block.thinking = cb.thinking || '';
        else if (cb.type === 'tool_use' || cb.type === 'server_tool_use') {
          block.id = cb.id; block.name = cb.name; block.input_json = '';
        } else Object.assign(block, cb);
        this.byIndex.set(d.index, block);
        this.blocks.push(block);
        break;
      }
      case 'content_block_delta': {
        const b = this.byIndex.get(d.index);
        const delta = d.delta || {};
        if (!b) break;
        if (delta.type === 'text_delta') b.text = (b.text || '') + (delta.text || '');
        else if (delta.type === 'thinking_delta') b.thinking = (b.thinking || '') + (delta.thinking || '');
        else if (delta.type === 'input_json_delta') b.input_json = (b.input_json || '') + (delta.partial_json || '');
        else if (delta.type === 'signature_delta') b.signature_chars = (b.signature_chars || 0) + (delta.signature || '').length;
        break;
      }
      case 'content_block_stop': {
        const b = this.byIndex.get(d.index);
        if (b && typeof b.input_json === 'string') {
          try { b.input = b.input_json ? JSON.parse(b.input_json) : {}; delete b.input_json; } catch (e) { /* keep partial */ }
        }
        break;
      }
      case 'message_delta':
        if (d.delta && d.delta.stop_reason) this.stopReason = d.delta.stop_reason;
        this._usage(d.usage);
        break;
      case 'message_stop':
        this.complete = true;
        break;
      case 'error':
        this.error = d.error || d;
        break;
      default: break;
    }
  }

  _usage(u) {
    if (!u || typeof u !== 'object') return;
    for (const k of ['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens']) {
      if (typeof u[k] === 'number') this.usage[k] = u[k];
    }
  }

  snapshot() {
    return {
      kind: 'stream',
      id: this.id,
      model: this.model,
      content: this.blocks.map((b) => ({ ...b })),
      usage: { ...this.usage },
      stop_reason: this.stopReason,
      events: this.events,
      error: this.error,
      complete: this.complete,
    };
  }
}

/** Summarise a non-streaming Messages response (or an error body). */
function summarizeJson(obj) {
  if (!obj || typeof obj !== 'object') return null;
  if (obj.type === 'error' || obj.error) {
    return { kind: 'error', error: obj.error || obj, content: [], usage: {} };
  }
  const content = Array.isArray(obj.content)
    ? obj.content.map((b) => {
      if (b && b.type === 'thinking') { const c = { ...b }; delete c.signature; return c; }
      return b;
    })
    : [];
  return {
    kind: 'message',
    id: obj.id || null,
    model: obj.model || null,
    content,
    usage: obj.usage && typeof obj.usage === 'object' ? obj.usage : {},
    stop_reason: obj.stop_reason || null,
    error: null,
    complete: true,
  };
}

module.exports = { SseAssembler, summarizeJson };
