'use strict';
const fs = require('node:fs');
const path = require('node:path');

const DEFAULTS = {
  host: '127.0.0.1',
  port: 8719,
  anthropic: { baseUrl: 'https://api.anthropic.com' },
  local: { baseUrl: 'http://127.0.0.1:1234', apiKey: 'lmstudio' },
  localEnabled: true,
  routes: [
    {
      name: 'local-worker',
      match: { model: 'local-qwen' },
      target: 'local',
      rewriteModel: 'auto',
      fallbackModel: 'claude-haiku-5-5',
      fallbackOnLocalDown: false,
      stripBodyFields: ['context_management', 'output_config'],
      thinking: 'strip',
      stripCacheControl: true,
      stripToolFields: ['defer_loading', 'strict', 'eager_input_streaming'],
      stripHeaders: [],
    },
  ],
  keepRecords: 300,
  maxBodyBytes: 1000000,
  maxTotalBytes: 300000000,
  maxRequestBytes: 100000000,
  allowBrowserOrigins: false,
  logToFile: false,
  logDir: 'logs',
};

function isObject(v) { return v && typeof v === 'object' && !Array.isArray(v); }

function merge(base, over) {
  const out = { ...base };
  for (const [k, v] of Object.entries(over || {})) {
    if (isObject(v) && isObject(base[k])) out[k] = merge(base[k], v);
    else out[k] = v;
  }
  return out;
}

function validate(cfg) {
  const problems = [];
  const url = (label, value) => {
    try { return new URL(value); } catch (e) { problems.push(label + ' is not a valid URL: ' + value); return null; }
  };
  url('anthropic.baseUrl', cfg.anthropic.baseUrl);
  url('local.baseUrl', cfg.local.baseUrl);
  if (!Number.isInteger(cfg.port) || cfg.port < 0 || cfg.port > 65535) problems.push('port must be 0-65535');
  if (!Array.isArray(cfg.routes)) problems.push('routes must be an array');
  for (const r of cfg.routes || []) {
    if (!r.name) problems.push('every route needs a name');
    if (!isObject(r.match) || !(r.match.model || r.match.modelPrefix || r.match.modelRegex || r.match.header)) {
      problems.push('route "' + r.name + '" needs a match (model, modelPrefix, modelRegex or header)');
    }
    if (r.target !== 'local') problems.push('route "' + r.name + '": only target "local" is supported');
    if (r.thinking && !['strip', 'keep'].includes(r.thinking)) problems.push('route "' + r.name + '": thinking must be "strip" or "keep"');
  }
  if (problems.length) throw new Error('Invalid Hawat config:\n - ' + problems.join('\n - '));
}

/** Load defaults, then hawat.config.json, then hawat.config.local.json (all optional). */
function loadConfig({ file, overrides, cwd } = {}) {
  const dir = cwd || process.cwd();
  let cfg = merge(DEFAULTS, {});
  const files = file ? [file] : [path.join(dir, 'hawat.config.json'), path.join(dir, 'hawat.config.local.json')];
  const loaded = [];
  for (const f of files) {
    if (!fs.existsSync(f)) {
      if (file) throw new Error('Config file not found: ' + f);
      continue;
    }
    let parsed;
    try { parsed = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { throw new Error('Cannot read ' + f + ': ' + e.message); }
    cfg = merge(cfg, parsed);
    loaded.push(f);
  }
  cfg = merge(cfg, overrides || {});
  validate(cfg);
  cfg._loadedFiles = loaded;
  return cfg;
}

module.exports = { DEFAULTS, loadConfig, merge, validate };
