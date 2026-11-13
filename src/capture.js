'use strict';
const zlib = require('node:zlib');
const { SseAssembler, summarizeJson } = require('./sse');

function makeDecoder(encoding) {
  const e = (encoding || '').toLowerCase().trim();
  if (!e || e === 'identity') return { decoder: null, supported: true };
  if (e === 'gzip' || e === 'x-gzip') return { decoder: zlib.createGunzip({ finishFlush: zlib.constants.Z_SYNC_FLUSH }), supported: true };
  if (e === 'deflate') return { decoder: zlib.createInflate({ finishFlush: zlib.constants.Z_SYNC_FLUSH }), supported: true };
  if (e === 'br') return { decoder: zlib.createBrotliDecompress({ finishFlush: zlib.constants.BROTLI_OPERATION_FLUSH }), supported: true };
  if (e === 'zstd' && typeof zlib.createZstdDecompress === 'function') return { decoder: zlib.createZstdDecompress(), supported: true };
  return { decoder: null, supported: false };
}

/**
 * Observes a response body without touching it: counts raw bytes, decodes a copy
 * (gzip/br/deflate/zstd), keeps a capped text copy, and reassembles SSE streams.
 * The bytes sent to Claude Code are never taken from here.
 */
class BodyCapture {
  constructor({ encoding, contentType, maxBytes, onUpdate }) {
    this.encoding = encoding || '';
    this.contentType = contentType || '';
    this.maxBytes = maxBytes;
    this.onUpdate = onUpdate || (() => {});
    this.rawBytes = 0;
    this.decodedBytes = 0;
    this.stored = 0;
    this.chunks = [];
    this.truncated = false;
    this.decodeError = null;
    this.undecoded = false;
    this.isSse = /text\/event-stream/i.test(this.contentType);
    this.sse = this.isSse ? new SseAssembler() : null;
    this.td = new TextDecoder('utf-8');
    this.finished = false;
    this.done = new Promise((resolve) => { this._resolve = resolve; });

    const { decoder, supported } = makeDecoder(this.encoding);
    this.decoder = decoder;
    if (!supported) this.undecoded = true;
    if (this.decoder) {
      this.decoder.on('data', (d) => this._decoded(d));
      this.decoder.on('end', () => this._finish());
      this.decoder.on('error', (e) => { this.decodeError = e.message; this._finish(); });
    }
  }

  write(chunk) {
    this.rawBytes += chunk.length;
    if (this.undecoded) { this._store(chunk); return; }
    if (this.decoder) { if (!this.decoder.destroyed) this.decoder.write(chunk); } else this._decoded(chunk);
  }

  end() {
    if (this.decoder && !this.decoder.destroyed) this.decoder.end();
    else this._finish();
  }

  _store(buf) {
    if (this.stored >= this.maxBytes) { this.truncated = true; return; }
    const room = this.maxBytes - this.stored;
    const piece = buf.length > room ? buf.subarray(0, room) : buf;
    if (piece.length < buf.length) this.truncated = true;
    this.chunks.push(piece);
    this.stored += piece.length;
  }

  _decoded(buf) {
    this.decodedBytes += buf.length;
    this._store(buf);
    if (this.sse) this.sse.push(this.td.decode(buf, { stream: true }));
    this.onUpdate();
  }

  _finish() {
    if (this.finished) return;
    this.finished = true;
    this._resolve();
  }

  text() {
    if (this.undecoded) return '';
    return Buffer.concat(this.chunks).toString('utf8');
  }

  assembled() {
    if (this.sse) return this.sse.snapshot();
    if (/json/i.test(this.contentType) && !this.truncated && !this.undecoded) {
      try { return summarizeJson(JSON.parse(this.text())); } catch (e) { return null; }
    }
    return null;
  }
}

module.exports = { BodyCapture };
