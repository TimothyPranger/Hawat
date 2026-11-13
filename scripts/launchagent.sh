#!/bin/bash
# Run Hawat and its local model server at login (macOS launchd, user level, no admin rights needed).
#   scripts/launchagent.sh install     write both plists and start them now
#   scripts/launchagent.sh uninstall   stop them and remove the plists
#   scripts/launchagent.sh status
#
# Two jobs:
#   local.hawat         runs scripts/start-hawat.sh, restarted 10 s after a crash. Log: ~/.hawat/hawat.log
#   local.hawat-models  runs scripts/ensure-models.sh once at login: opens the model server app if it is
#                       not running and loads the main model with the context it needs. Log: ~/.hawat/models.log
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
LOGDIR="$HOME/.hawat"
AGENTS="$HOME/Library/LaunchAgents"
DOMAIN="gui/$(id -u)"
HAWAT="local.hawat"
MODELS="local.hawat-models"

plist() { # label script keepalive logfile
  cat <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$1</string>
  <key>ProgramArguments</key>
  <array><string>$REPO/scripts/$2</string></array>
  <key>WorkingDirectory</key><string>$REPO</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><$3/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$LOGDIR/$4</string>
  <key>StandardErrorPath</key><string>$LOGDIR/$4</string>
</dict>
</plist>
EOF
}

load() { # label
  launchctl bootout "$DOMAIN/$1" 2>/dev/null || true
  for _ in 1 2 3 4 5 6 7 8 9 10; do   # bootout is asynchronous: wait until the old job is gone
    launchctl print "$DOMAIN/$1" >/dev/null 2>&1 || break
    sleep 1
  done
  launchctl bootstrap "$DOMAIN" "$AGENTS/$1.plist"
}

case "${1:-}" in
  install)
    mkdir -p "$LOGDIR" "$AGENTS"
    plist "$HAWAT"  start-hawat.sh    true  hawat.log  > "$AGENTS/$HAWAT.plist"
    plist "$MODELS" ensure-models.sh  false models.log > "$AGENTS/$MODELS.plist"
    load "$HAWAT"
    load "$MODELS"
    echo "installed: $AGENTS/$HAWAT.plist and $AGENTS/$MODELS.plist"
    ;;
  uninstall)
    for l in "$HAWAT" "$MODELS"; do
      launchctl bootout "$DOMAIN/$l" 2>/dev/null || true
      rm -f "$AGENTS/$l.plist"
    done
    echo "removed"
    ;;
  status)
    for l in "$HAWAT" "$MODELS"; do
      echo "== $l"
      launchctl print "$DOMAIN/$l" 2>/dev/null | grep -E "^\s*(state|pid|last exit code) =" || echo "not loaded"
    done
    ;;
  *)
    echo "usage: launchagent.sh install|uninstall|status" >&2; exit 2 ;;
esac
