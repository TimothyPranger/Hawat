'use strict';
// Local certificate authority for HTTPS interception of api.anthropic.com (and only the hosts you list).
// Needs the `openssl` command line tool, but only for `hawat certs`, never while proxying.
//
// Safety design:
//  - The CA is name-constrained: even if its key leaked, it could only vouch for the listed hosts.
//  - The CA private key is deleted right after the one leaf certificate is signed.
//  - Nothing is installed in the system keychain. Claude Code trusts the CA only through NODE_EXTRA_CA_CERTS.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

function expandDir(dir) {
  if (!dir) return path.join(os.homedir(), '.hawat', 'certs');
  if (dir === '~') return os.homedir();
  if (dir.startsWith('~/')) return path.join(os.homedir(), dir.slice(2));
  return path.resolve(dir);
}

function certPaths(dir) {
  const d = expandDir(dir);
  return { dir: d, ca: path.join(d, 'ca.pem'), cert: path.join(d, 'leaf.pem'), key: path.join(d, 'leaf.key') };
}

function validHost(h) {
  return typeof h === 'string' && /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(h);
}

function openssl(args, cwd) {
  try {
    return execFileSync('openssl', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
  } catch (e) {
    const why = e.code === 'ENOENT' ? 'the `openssl` command was not found' : String(e.stderr || e.message).trim().split('\n').slice(-3).join(' | ');
    throw new Error('openssl failed: ' + why);
  }
}

/** Create ca.pem (public, give this to Claude Code) and leaf.pem/leaf.key (Hawat's own). Returns the paths. */
function generateCerts({ dir, hosts, force = false } = {}) {
  const list = (hosts && hosts.length ? hosts : ['api.anthropic.com']).map((h) => String(h).toLowerCase());
  for (const h of list) if (!validHost(h)) throw new Error('not a valid host name: ' + h);
  const p = certPaths(dir);
  if (fs.existsSync(p.ca) && !force) throw new Error('certificates already exist in ' + p.dir + ' (use --force to replace them)');
  fs.mkdirSync(p.dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(p.dir, 0o700);

  const tmp = fs.mkdtempSync(path.join(p.dir, '.gen-'));
  try {
    const san = list.map((h) => 'DNS:' + h).join(',');
    const permitted = list.map((h) => 'permitted;DNS:' + h).join(',');
    fs.writeFileSync(path.join(tmp, 'ca.cnf'), [
      '[req]', 'distinguished_name=dn', 'prompt=no', '[dn]', 'CN=Hawat local CA (' + list.join(', ') + ' only)',
      '[v3_ca]', 'basicConstraints=critical,CA:TRUE,pathlen:0', 'keyUsage=critical,keyCertSign',
      'subjectKeyIdentifier=hash', 'nameConstraints=critical,' + permitted, '',
    ].join('\n'));
    fs.writeFileSync(path.join(tmp, 'leaf.cnf'), [
      'basicConstraints=CA:FALSE', 'keyUsage=critical,digitalSignature,keyEncipherment', 'extendedKeyUsage=serverAuth',
      'subjectAltName=' + san, 'authorityKeyIdentifier=keyid', '',
    ].join('\n'));

    openssl(['genrsa', '-out', 'ca.key', '2048'], tmp);
    openssl(['req', '-x509', '-new', '-key', 'ca.key', '-sha256', '-days', '3650', '-config', 'ca.cnf', '-extensions', 'v3_ca', '-out', 'ca.pem'], tmp);
    openssl(['genrsa', '-out', 'leaf.key', '2048'], tmp);
    openssl(['req', '-new', '-key', 'leaf.key', '-subj', '/CN=' + list[0], '-out', 'leaf.csr'], tmp);
    openssl(['x509', '-req', '-in', 'leaf.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial', '-days', '825', '-sha256', '-extfile', 'leaf.cnf', '-out', 'leaf.pem'], tmp);
    const verdict = openssl(['verify', '-CAfile', 'ca.pem', 'leaf.pem'], tmp);
    if (!/OK/.test(verdict)) throw new Error('generated certificate did not verify: ' + verdict.trim());

    fs.chmodSync(path.join(tmp, 'leaf.key'), 0o600);
    for (const f of ['ca.pem', 'leaf.pem', 'leaf.key']) fs.copyFileSync(path.join(tmp, f), path.join(p.dir, f));
    fs.chmodSync(p.key, 0o600);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true }); // removes ca.key: nobody can sign anything else later
  }
  return { ...p, hosts: list };
}

/** Read the leaf certificate for the proxy. Returns null when it has not been generated. */
function loadLeaf(dir) {
  const p = certPaths(dir);
  try { return { ...p, certPem: fs.readFileSync(p.cert), keyPem: fs.readFileSync(p.key) }; } catch (e) { return null; }
}

module.exports = { expandDir, certPaths, generateCerts, loadLeaf, validHost };
