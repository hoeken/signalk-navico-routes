#!/usr/bin/env bash
#
# Capture all UDP + inter-MFD TCP traffic on the boat network to a pcap file,
# so we can hunt for the Navico route-sync protocol offline.
#
# Usage:
#   ./capture.sh [seconds] [output.pcap]
#
# Defaults: capture until Ctrl-C, writing research/captures/nav-<timestamp>.pcap
#
# During a capture, go to an MFD and edit/save the route named
# 'SAVUSAVU 2 NANAK'. That string becomes our beacon for finding the packets.

set -euo pipefail

IFACE="${IFACE:-eth0}"
DURATION="${1:-0}"           # 0 = run until Ctrl-C
DIR="$(cd "$(dirname "$0")" && pwd)/captures"
mkdir -p "$DIR"

if [[ "${2:-}" != "" ]]; then
  OUT="$2"
else
  # avoid subshell date-in-name issues on odd shells
  TS="$(date +%Y%m%d-%H%M%S)"
  OUT="$DIR/nav-$TS.pcap"
fi

# Full packet payloads (-s 0), no name resolution (-n), write raw pcap (-w).
# Filter: all UDP, plus any TCP inside the boat LAN (192.168.2.0/24) in case
# route sync uses a TCP channel rather than UDP multicast.
FILTER='udp or (tcp and (net 192.168.2.0/24 or net 169.254.0.0/16))'

echo "Interface : $IFACE"
echo "Output    : $OUT"
echo "Filter    : $FILTER"
if [[ "$DURATION" -gt 0 ]]; then
  echo "Duration  : ${DURATION}s"
  echo ">>> Now edit + SAVE the 'SAVUSAVU 2 NANAK' route on an MFD <<<"
  sudo timeout "$DURATION" tcpdump -i "$IFACE" -n -s 0 -w "$OUT" "$FILTER"
else
  echo "Duration  : until Ctrl-C"
  echo ">>> Now edit + SAVE the 'SAVUSAVU 2 NANAK' route on an MFD <<<"
  sudo tcpdump -i "$IFACE" -n -s 0 -w "$OUT" "$FILTER"
fi

echo
echo "Wrote: $OUT"
echo "Analyze with: python3 research/analyze.py '$OUT' --find 'SAVUSAVU 2 NANAK'"
