#!/usr/bin/env node
'use strict';
const { spawn } = require('node:child_process');
const { loadConfig } = require('../src/config');
const { createHawat } = require('../src/hawat');

function usage() {
  console.log(`Hawat: local Claude Code proxy with a request inspector

Usage: hawat [options]
       hawat certs [--force] [--dir <folder>]   create the local certificate for HTTPS proxy mode
  --port <n>       listen port (default from config, 8719)
  --config <file>  use this config file instead of ./hawat.config.json
  --open           open the GUI in your browser
  --help           show this help
`);
}

const args = process.argv.slice(2);
const opts = {};

if (args[0] === 'certs') {
  const { generateCerts } = require('../src/certs');
  let dir; let force = false;
  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--force') force = true;
    else if (args[i] === '--dir') dir = args[++i];
    else { console.error('Unknown option: ' + args[i]); process.exit(2); }
  }
  try {
    const cfg = loadConfig({});
    const r = generateCerts({ dir: dir || cfg.intercept.certDir, hosts: cfg.intercept.hosts, force });
    console.log('Created a local certificate for: ' + r.hosts.join(', '));
    console.log('  CA file (give this to Claude Code): ' + r.ca);
    console.log('  Hawat\'s own certificate and key:    ' + r.cert + ' , ' + r.key);
    console.log('The CA is limited to those host names and its private key was deleted. Nothing was added to your keychain.');
    console.log('\nAdd to the Claude Code settings (for example a project\'s .claude/settings.local.json):');
    console.log(JSON.stringify({ env: { HTTPS_PROXY: 'http://127.0.0.1:' + cfg.port, NODE_EXTRA_CA_CERTS: r.ca } }, null, 2));
    process.exit(0);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
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
  const ic = hawat.state.intercept;
  console.log('  HTTPS proxy:  ' + (ic.ready ? 'ready for ' + ic.hosts.join(', ') + ' (HTTPS_PROXY=' + base + ', NODE_EXTRA_CA_CERTS=' + ic.caFile + ')' : 'not set up: ' + ic.reason));
  console.log('  Routes:       ' + cfg.routes.map((r) => r.name + ' [' + JSON.stringify(r.match) + ']').join(', '));
  if (cfg._loadedFiles && cfg._loadedFiles.length) console.log('  Config:       ' + cfg._loadedFiles.join(', '));
  if (opts.open) spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [base + '/__hawat/'], { stdio: 'ignore', detached: true }).unref();

  const stop = async () => { await hawat.close(); process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
})();
