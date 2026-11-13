'use strict';
const http = require('node:http');
const https = require('node:https');

const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
]);

/** [name, value, name, value, ...] -> [[name, value], ...] (keeps original case and order). */
function pairsFromRaw(raw) {
  const out = [];
  for (let i = 0; i + 1 < raw.length; i += 2) out.push([raw[i], raw[i + 1]]);
  return out;
}

function flatten(pairs) {
  const flat = [];
  for (const [n, v] of pairs) flat.push(n, v);
  return flat;
}

function getHeader(pairs, name) {
  const l = name.toLowerCase();
  for (const [n, v] of pairs) if (n.toLowerCase() === l) return v;
  return undefined;
}

function connectionTokens(pairs) {
  const tokens = new Set();
  for (const [n, v] of pairs) {
    if (n.toLowerCase() !== 'connection') continue;
    for (const part of String(v).split(',')) {
      const t = part.trim().toLowerCase();
      if (t) tokens.add(t);
    }
  }
  return tokens;
}

/** Remove hop-by-hop headers (and any header named by Connection). */
function stripHopByHop(pairs) {
  const extra = connectionTokens(pairs);
  return pairs.filter(([n]) => {
    const l = n.toLowerCase();
    return !HOP_BY_HOP.has(l) && !extra.has(l);
  });
}

/** Remove headers whose lowercase name is in the given Set. Returns { kept, removed }. */
function removeHeaders(pairs, names) {
  const kept = [];
  const removed = [];
  for (const p of pairs) {
    if (names.has(p[0].toLowerCase())) removed.push(p);
    else kept.push(p);
  }
  return { kept, removed };
}

function httpGetJson(urlStr, headers, timeoutMs) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(urlStr); } catch (e) { reject(e); return; }
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.get(u, { headers, timeout: timeoutMs }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error('HTTP ' + res.statusCode));
          return;
        }
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch (e) { reject(new Error('response was not JSON')); }
      });
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', reject);
  });
}

module.exports = {
  HOP_BY_HOP, pairsFromRaw, flatten, getHeader, stripHopByHop,
  removeHeaders, httpGetJson, connectionTokens,
};
