#!/bin/bash
# Make sure the local model server is up and the main model is loaded with the context Hawat's workers need.
# Run once at login by the launch agent (scripts/launchagent.sh), or by hand any time. Safe to repeat.
#
#  1. If nothing answers on the LM Studio API port, open the app hidden (default: Bionic, which serves it here).
#  2. If the main model is not loaded, or is loaded with a smaller context, (re)load it.
#  The coder model is not preloaded: LM Studio loads it on first use (just-in-time).
#
# Settings by environment variable:
#   HAWAT_LMS_APP=Bionic            app to open (the one that runs the local server)
#   HAWAT_MAIN_MODEL=qwen/qwen3.8-27b
#   HAWAT_MAIN_CONTEXT=100000       tokens
#   HAWAT_MAIN_PARALLEL=2           concurrent predictions
#   HAWAT_API=http://127.0.0.1:1234
set -uo pipefail

APP="${HAWAT_LMS_APP:-Bionic}"
MODEL="${HAWAT_MAIN_MODEL:-qwen/qwen3.8-27b}"
CTX="${HAWAT_MAIN_CONTEXT:-100000}"
PAR="${HAWAT_MAIN_PARALLEL:-2}"
API="${HAWAT_API:-http://127.0.0.1:1234}"
LMS="$HOME/.lmstudio/bin/lms"
log() { echo "$(date '+%F %T') ensure-models: $*"; }

[ -x "$LMS" ] || { log "lms CLI not found at $LMS"; exit 1; }

if ! curl -sf -m 3 "$API/v1/models" >/dev/null; then
  log "server not answering, opening $APP hidden"
  open -g -j -a "$APP" || { log "could not open $APP"; exit 1; }
  up=0
  for _ in $(seq 1 90); do
    sleep 2
    curl -sf -m 3 "$API/v1/models" >/dev/null && { up=1; break; }
  done
  [ "$up" = 1 ] || { log "server still not answering after 3 minutes"; exit 1; }
  log "server is up"
fi

loaded_ctx="$(curl -sf -m 5 "$API/api/v0/models" | /usr/bin/python3 -c '
import sys, json
want = sys.argv[1]
for m in json.load(sys.stdin).get("data", []):
    if m.get("id") == want and m.get("state") == "loaded":
        print(m.get("loaded_context_length") or 0)
        break
else:
    print(0)' "$MODEL" 2>/dev/null || echo 0)"

if [ "${loaded_ctx:-0}" -ge "$CTX" ]; then
  log "$MODEL already loaded with context $loaded_ctx, nothing to do"
  exit 0
fi

if [ "${loaded_ctx:-0}" -gt 0 ]; then
  log "$MODEL loaded with context $loaded_ctx (< $CTX), reloading"
  "$LMS" unload "$MODEL" >/dev/null 2>&1
fi
log "loading $MODEL, context $CTX, parallel $PAR"
if "$LMS" load "$MODEL" -c "$CTX" --parallel "$PAR" --identifier "$MODEL" -y >/dev/null 2>&1; then
  log "loaded"
else
  log "load failed"; exit 1
fi
