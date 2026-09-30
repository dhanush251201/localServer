#!/bin/bash
# Remove the port-80 forwarding installed by setup-pf.sh.
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "Run with sudo: sudo $0" >&2
  exit 1
fi

launchctl bootout system/com.localserver.pf 2>/dev/null || true
rm -f /Library/LaunchDaemons/com.localserver.pf.plist
pfctl -a com.apple/localserver -F all 2>/dev/null || true
rm -f /etc/pf.anchors/localserver
echo "Removed localserver pf rules."
