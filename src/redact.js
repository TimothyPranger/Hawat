'use strict';

const SENSITIVE_EXACT = /^(authorization|proxy-authorization|x-api-key|api-key|cookie|set-cookie|x-goog-api-key)$/i;
const SENSITIVE_LOOSE = /(token|secret|password|api[-_]?key)/i;

function isSensitive(name) {
  return SENSITIVE_EXACT.test(name) || SENSITIVE_LOOSE.test(name);
}

/** Show only a short prefix of a secret (never more than a quarter of it). */
function maskValue(value) {
  const s = String(value);
  if (s.length <= 12) return '[masked]';
  const keep = Math.min(14, Math.floor(s.length / 4));
  return s.slice(0, keep) + '…[masked, ' + s.length + ' chars]';
}

/** [[name, value]] -> [{ name, value, masked }] safe to store and show. */
function maskPairs(pairs) {
  return pairs.map(([name, value]) => {
    const masked = isSensitive(name);
    return { name, value: masked ? maskValue(value) : String(value), masked };
  });
}

module.exports = { isSensitive, maskValue, maskPairs };
