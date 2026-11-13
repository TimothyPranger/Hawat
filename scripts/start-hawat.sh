#!/bin/bash
# Start Hawat with the Node version in .nvmrc (nvm is not loaded at login, so find the binary directly).
# Used by the login launch agent (scripts/launchagent.sh). You can also run it by hand.
set -euo pipefail
cd "$(dirname "$0")/.."

WANT="$(tr -d '[:space:]v' < .nvmrc 2>/dev/null || echo 22)"
NODE=""
for cand in "$HOME/.nvm/versions/node/v${WANT}"*/bin/node /opt/homebrew/bin/node /usr/local/bin/node; do
  [ -x "$cand" ] || continue
  major="$("$cand" -p 'process.versions.node.split(".")[0]')"
  if [ "$major" -ge 20 ]; then NODE="$cand"; break; fi
done
[ -n "$NODE" ] || { echo "hawat: no Node 20 or newer found" >&2; exit 1; }

exec "$NODE" bin/hawat.js "$@"
