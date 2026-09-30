#!/bin/bash
# Forward port 80 → the gateway's redirect port (default 8079) so URLs work without a port:
#   http://time.localhost        on this Mac   (lo0, IPv4 + IPv6)
#   http://time.local            from your phone (the default-route interface, LAN mode only)
#
# Rules live in the pf anchor "com.apple/localserver". macOS's stock /etc/pf.conf already
# evaluates com.apple/*, so /etc/pf.conf is not edited. A LaunchDaemon re-applies them at boot.
#
# The redirect targets the gateway's dedicated redirect port (8079), not its main port (8080):
# macOS pf breaks direct loopback connections to a port an rdr rule points at, and 8080 should
# stay reachable directly.
#
# Usage: sudo ./scripts/setup-pf.sh [redirect-port]
# Undo:  sudo ./scripts/teardown-pf.sh
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "Run with sudo: sudo $0 $*" >&2
  exit 1
fi

PORT="${1:-8079}"
ANCHOR_NAME="com.apple/localserver"
ANCHOR_FILE="/etc/pf.anchors/localserver"
PLIST="/Library/LaunchDaemons/com.localserver.pf.plist"
IFACE="$(route -n get default 2>/dev/null | awk '/interface:/{print $2}' || true)"

echo "Writing $ANCHOR_FILE (80 → $PORT)"
{
  echo "# localserver: forward :80 to the gateway on :$PORT"
  echo "rdr pass on lo0 inet proto tcp from any to any port 80 -> 127.0.0.1 port $PORT"
  echo "rdr pass on lo0 inet6 proto tcp from any to any port 80 -> ::1 port $PORT"
  if [ -n "$IFACE" ]; then
    # Only reaches the gateway when LAN mode is on (it listens on all interfaces only then).
    echo "rdr pass on $IFACE inet proto tcp from any to ($IFACE) port 80 -> ($IFACE) port $PORT"
  fi
} > "$ANCHOR_FILE"

echo "Installing $PLIST (re-applies the rules at boot)"
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.localserver.pf</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string>
    <string>-c</string>
    <string>/sbin/pfctl -E; /sbin/pfctl -a '$ANCHOR_NAME' -f '$ANCHOR_FILE'</string>
  </array>
  <key>RunAtLoad</key><true/>
</dict>
</plist>
EOF
chmod 644 "$PLIST"

launchctl bootout system/com.localserver.pf 2>/dev/null || true
launchctl bootstrap system "$PLIST"
sleep 1

echo
echo "Active rules:"
pfctl -a "$ANCHOR_NAME" -s nat 2>/dev/null || true
echo
echo "Done. Try: curl -I http://localserver.localhost/"
[ -n "$IFACE" ] && echo "LAN interface: $IFACE (re-run this script if you switch between Wi-Fi and Ethernet)."
