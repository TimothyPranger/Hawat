'use strict';
const { getHeader } = require('./util');

const DEFAULT_PATHS = ['/v1/messages', '/v1/messages/count_tokens'];

function matchRule(rule, ctx) {
  if (ctx.method !== 'POST' || !ctx.bodyObj || typeof ctx.bodyObj !== 'object') return false;
  const paths = rule.paths || DEFAULT_PATHS;
  if (!paths.includes(ctx.pathname)) return false;
  const m = rule.match || {};
  const model = ctx.bodyObj.model;
  let conditions = 0;
  if (m.model !== undefined) { conditions++; if (model !== m.model) return false; }
  if (m.modelPrefix !== undefined) { conditions++; if (typeof model !== 'string' || !model.startsWith(m.modelPrefix)) return false; }
  if (m.modelRegex !== undefined) {
    conditions++;
    let re;
    try { re = new RegExp(m.modelRegex); } catch (e) { return false; }
    if (typeof model !== 'string' || !re.test(model)) return false;
  }
  if (m.header) {
    conditions++;
    const v = getHeader(ctx.headers, m.header.name);
    if (v === undefined) return false;
    if (m.header.value !== undefined && v !== m.header.value) return false;
  }
  return conditions > 0;
}

/**
 * Decide where one request goes.
 *   passthrough: Anthropic, bytes untouched
 *   redirect:    LM Studio (rewritten)
 *   fallback:    Anthropic, only the model name replaced (local routing is off or LM Studio is down)
 */
function decide(ctx, cfg, state) {
  const rule = (cfg.routes || []).find((r) => matchRule(r, ctx));
  if (!rule) {
    return { mode: 'passthrough', target: 'anthropic', rule: null, reason: ctx.bodyObj ? 'no routing rule matched' : 'not a JSON request (forwarded as is)' };
  }
  if (!state.localEnabled) {
    if (rule.fallbackModel) {
      return { mode: 'fallback', target: 'anthropic', rule, reason: 'local routing is switched off: sent to Anthropic as ' + rule.fallbackModel };
    }
    return { mode: 'passthrough', target: 'anthropic', rule, reason: 'rule "' + rule.name + '" matched but local routing is off and no fallbackModel is set' };
  }
  return { mode: 'redirect', target: 'local', rule, reason: 'rule "' + rule.name + '" matched' };
}

const ALWAYS_STRIP_HEADERS = new Set([
  'authorization', 'x-api-key', 'api-key', 'cookie', 'proxy-authorization',
  'anthropic-beta', 'host', 'content-length', 'accept-encoding', 'expect',
]);

function stripCacheControlFromBlock(block, counter) {
  if (!block || typeof block !== 'object') return;
  if ('cache_control' in block) { delete block.cache_control; counter.n++; }
  if (Array.isArray(block.content)) for (const c of block.content) stripCacheControlFromBlock(c, counter);
}

/**
 * Build the body for LM Studio. Returns { body (object), changes } where changes
 * lists exactly what was rewritten or removed, for the GUI.
 */
function transformBodyForLocal(bodyObj, rule, resolvedModel) {
  const body = JSON.parse(JSON.stringify(bodyObj));
  const changes = { rewrites: [], strippedBodyFields: [] };

  if (resolvedModel && body.model !== resolvedModel) {
    changes.rewrites.push({ field: 'model', from: body.model, to: resolvedModel });
    body.model = resolvedModel;
  }
  for (const f of rule.stripBodyFields || []) {
    if (f in body) { delete body[f]; changes.strippedBodyFields.push(f); }
  }
  if ((rule.thinking || 'strip') === 'strip' && 'thinking' in body) {
    delete body.thinking;
    changes.strippedBodyFields.push('thinking');
  }
  if (Array.isArray(body.tools) && (rule.stripToolFields || []).length) {
    const counts = {};
    for (const tool of body.tools) {
      if (!tool || typeof tool !== 'object') continue;
      for (const f of rule.stripToolFields) {
        if (f in tool) { delete tool[f]; counts[f] = (counts[f] || 0) + 1; }
      }
    }
    for (const [f, n] of Object.entries(counts)) changes.strippedBodyFields.push('tools[].' + f + ' (' + n + ')');
  }
  if (rule.stripCacheControl !== false) {
    const counter = { n: 0 };
    if (Array.isArray(body.system)) for (const b of body.system) stripCacheControlFromBlock(b, counter);
    if (Array.isArray(body.messages)) {
      for (const m of body.messages) {
        if (Array.isArray(m && m.content)) for (const b of m.content) stripCacheControlFromBlock(b, counter);
      }
    }
    if (Array.isArray(body.tools)) for (const t of body.tools) stripCacheControlFromBlock(t, counter);
    if (counter.n) changes.strippedBodyFields.push('cache_control (' + counter.n + ' blocks)');
  }
  return { body, changes };
}

module.exports = { decide, matchRule, transformBodyForLocal, ALWAYS_STRIP_HEADERS };
