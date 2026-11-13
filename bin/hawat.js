#!/usr/bin/env node
'use strict';
const { spawn } = require('node:child_process');
const { loadConfig } = require('../src/config');
const { createHawat } = require('../src/hawat');

function usage() {
  console.log(`Hawat: local Claude Code proxy with a request inspector

Usage: hawat [options]
  --port <n>       listen port (default from config, 8719)
  --config <file>  use this config file instead of ./hawat.config.json
  --open           open the GUI in your browser
  --help           show this help
`);
}

const args = process.argv.slice(2);
const opts = {};
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--help' || a === '-h') { usage(); process.exit(0); }
  else if (a === '--port') opts.port = Number(args[++i]);
  else if (a === '--config') opts.file = args[++i];
  else if (a === '--open') opts.open = true;
  else { console.error('Unknown option: ' + a); usage(); process.exit(2); }
}

(async () => {
  let cfg;
  try {
    cfg = loadConfig({ file: opts.file, overrides: opts.port !== undefined ? { port: opts.port } : {} });
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  const hawat = createHawat(cfg);
  let info;
  try {
    info = await hawat.start();
  } catch (e) {
    if (e.code === 'EADDRINUSE') console.error('Port ' + cfg.port + ' is already in use. Is Hawat already running? Try --port <other>.');
    else console.error('Could not start: ' + e.message);
    process.exit(1);
  }
  const base = 'http://' + (info.host === '::1' ? '[::1]' : info.host) + ':' + info.port;
  const st = hawat.state.local;
  console.log('Hawat is watching on ' + base);
  console.log('  Inspector:    ' + base + '/__hawat/');
  console.log('  Claude Code:  ANTHROPIC_BASE_URL=' + base + ' claude');
  console.log('  Anthropic:    ' + cfg.anthropic.baseUrl + ' (untouched passthrough)');
  console.log('  LM Studio:    ' + cfg.local.baseUrl + (st.ok ? ' (reachable, ' + st.models.length + ' model(s))' : ' (not reachable yet: ' + st.error + ')'));
  console.log('  Routes:       ' + cfg.routes.map((r) => r.name + ' [' + JSON.stringify(r.match) + ']').join(', '));
  if (cfg._loadedFiles && cfg._loadedFiles.length) console.log('  Config:       ' + cfg._loadedFiles.join(', '));
  if (opts.open) spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [base + '/__hawat/'], { stdio: 'ignore', detached: true }).unref();

  const stop = async () => { await hawat.close(); process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
})();
