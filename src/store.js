'use strict';
const { EventEmitter } = require('node:events');

function summary(rec) {
  const u = (rec.response && rec.response.assembled && rec.response.assembled.usage) || {};
  const r = rec.route || {};
  return {
    id: rec.id,
    seq: rec.seq,
    ts: rec.ts,
    method: rec.method,
    path: rec.path,
    state: rec.state,
    status: rec.response ? rec.response.status : null,
    mode: r.mode || null,
    target: r.target || null,
    rule: r.rule || null,
    modelIn: r.modelIn || null,
    modelOut: r.modelOut || null,
    isSubagent: !!rec.agentId,
    agentId: rec.agentId || null,
    streamed: !!(rec.response && rec.response.streamed),
    ttfbMs: rec.timing ? rec.timing.ttfbMs : null,
    totalMs: rec.timing ? rec.timing.totalMs : null,
    tokens: {
      input: u.input_tokens || 0,
      output: u.output_tokens || 0,
      cacheRead: u.cache_read_input_tokens || 0,
      cacheCreate: u.cache_creation_input_tokens || 0,
    },
    preview: rec.requestInfo ? rec.requestInfo.preview : '',
    error: rec.error || null,
    fellBack: !!(rec.attempts && rec.attempts.length),
  };
}

class Store extends EventEmitter {
  constructor({ keepRecords = 300, maxTotalBytes = 300000000 } = {}) {
    super();
    this.keepRecords = keepRecords;
    this.maxTotalBytes = maxTotalBytes;
    this.map = new Map();
    this.order = [];
    this.seq = 0;
    this.totalBytes = 0;
    this.timers = new Map();
  }

  create(init) {
    this.seq++;
    const rec = {
      id: this.seq.toString(36) + Math.random().toString(36).slice(2, 6),
      seq: this.seq,
      ts: Date.now(),
      state: 'pending',
      attempts: [],
      ...init,
    };
    this.map.set(rec.id, rec);
    this.order.push(rec.id);
    this._evict();
    this.emit('upsert', summary(rec));
    return rec;
  }

  /** Throttled update while a response is streaming. */
  touch(rec) {
    if (this.timers.has(rec.id)) return;
    const t = setTimeout(() => {
      this.timers.delete(rec.id);
      if (this.map.has(rec.id)) this.emit('upsert', summary(rec));
    }, 250);
    t.unref();
    this.timers.set(rec.id, t);
  }

  finish(rec) {
    const t = this.timers.get(rec.id);
    if (t) { clearTimeout(t); this.timers.delete(rec.id); }
    rec.bytes = this._size(rec);
    this.totalBytes = 0;
    for (const id of this.order) { const r = this.map.get(id); if (r) this.totalBytes += r.bytes || 0; }
    this._evict();
    if (this.map.has(rec.id)) this.emit('upsert', summary(rec));
    this.emit('finished', rec);
  }

  _size(rec) {
    let n = 0;
    if (rec.request && rec.request.bodyText) n += rec.request.bodyText.length;
    if (rec.upstream && rec.upstream.bodyText) n += rec.upstream.bodyText.length;
    if (rec.response && rec.response.bodyText) n += rec.response.bodyText.length;
    return n;
  }

  _evict() {
    while (this.order.length > this.keepRecords || (this.totalBytes > this.maxTotalBytes && this.order.length > 1)) {
      const id = this.order.shift();
      const r = this.map.get(id);
      if (r) this.totalBytes -= r.bytes || 0;
      this.map.delete(id);
      this.emit('evicted', id);
    }
  }

  get(id) { return this.map.get(id); }
  list() { return this.order.map((id) => summary(this.map.get(id))).filter(Boolean); }

  clear() {
    this.map.clear();
    this.order = [];
    this.totalBytes = 0;
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    this.emit('cleared');
  }

  stats() {
    const blank = () => ({ count: 0, input: 0, output: 0, cacheRead: 0, cacheCreate: 0, errors: 0 });
    const s = { anthropic: blank(), local: blank(), total: 0 };
    for (const id of this.order) {
      const rec = this.map.get(id);
      if (!rec) continue;
      const sm = summary(rec);
      const bucket = s[sm.target === 'local' ? 'local' : 'anthropic'];
      s.total++;
      bucket.count++;
      bucket.input += sm.tokens.input;
      bucket.output += sm.tokens.output;
      bucket.cacheRead += sm.tokens.cacheRead;
      bucket.cacheCreate += sm.tokens.cacheCreate;
      if (sm.state === 'error' || (sm.status && sm.status >= 400)) bucket.errors++;
    }
    return s;
  }
}

module.exports = { Store, summary };
