#!/usr/bin/env python3
"""
UDP traffic capture for reverse-engineering Navico MFD route synchronization.

Sniffs an interface in promiscuous mode, prints/logs UDP traffic to or from
the target MFD (plus any multicast UDP on the segment), and highlights packets
containing a needle string (e.g. a route name) in ASCII or UTF-16LE.

Also watches IGMP membership reports to discover which multicast groups the
MFDs join, and joins them itself so IGMP-snooping switches forward the traffic
to this host.

Everything captured is also written to a pcap file for offline analysis in
Wireshark.

Must run as root (raw socket):

    sudo ./scripts/capture.py --host 192.168.2.110 --needle "SAVUSAVU"
"""

import argparse
import datetime
import ipaddress
import os
import signal
import socket
import struct
import sys
import time

ETH_P_ALL = 0x0003
SOL_PACKET = 263
PACKET_ADD_MEMBERSHIP = 1
PACKET_MR_PROMISC = 1

# Multicast groups Navico is known to use; joined at startup so the switch
# forwards them. IGMP reports seen on the wire add to this set at runtime.
DEFAULT_GROUPS = [
    "239.2.1.1",  # GoFree service/webapp announcements (JSON over UDP)
]


class PcapWriter:
    def __init__(self, path):
        self.f = open(path, "wb")
        # magic, v2.4, tz 0, sigfigs 0, snaplen 65535, linktype 1 (ethernet)
        self.f.write(struct.pack("<IHHiIII", 0xA1B2C3D4, 2, 4, 0, 0, 65535, 1))
        self.count = 0

    def write(self, ts, frame):
        sec = int(ts)
        usec = int((ts - sec) * 1_000_000)
        self.f.write(struct.pack("<IIII", sec, usec, len(frame), len(frame)))
        self.f.write(frame)
        self.count += 1

    def close(self):
        self.f.flush()
        self.f.close()


def hexdump(data, prefix="    "):
    lines = []
    for i in range(0, len(data), 16):
        chunk = data[i : i + 16]
        hexpart = " ".join(f"{b:02x}" for b in chunk)
        asciipart = "".join(chr(b) if 32 <= b < 127 else "." for b in chunk)
        lines.append(f"{prefix}{i:04x}  {hexpart:<47}  {asciipart}")
    return "\n".join(lines)


def contains_needle(payload, needle):
    """Return 'ascii' / 'utf16' / None depending on how the needle appears."""
    low = payload.lower()
    if needle.lower().encode("ascii") in low:
        return "ascii"
    if needle.lower().encode("utf-16-le") in low:
        return "utf16"
    return None


def parse_igmp_groups(payload):
    """Extract group addresses from IGMPv2/v3 membership reports."""
    groups = []
    if not payload:
        return groups
    t = payload[0]
    if t in (0x12, 0x16) and len(payload) >= 8:  # v1/v2 membership report
        groups.append(socket.inet_ntoa(payload[4:8]))
    elif t == 0x22 and len(payload) >= 8:  # v3 membership report
        nrecs = struct.unpack("!H", payload[6:8])[0]
        off = 8
        for _ in range(nrecs):
            if off + 8 > len(payload):
                break
            rtype, auxlen, nsrc = payload[off], payload[off + 1], struct.unpack(
                "!H", payload[off + 2 : off + 4]
            )[0]
            group = socket.inet_ntoa(payload[off + 4 : off + 8])
            # 3/5 = TO_IN{}/TO_EX{} leave-ish; report joins (1,2,4,6) only
            if rtype in (1, 2, 4, 6):
                groups.append(group)
            off += 8 + nsrc * 4 + auxlen * 4
    return groups


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[1])
    ap.add_argument("--iface", default="eth0")
    ap.add_argument("--host", default="192.168.2.110",
                    help="MFD IP to filter on (use --all to disable filter)")
    ap.add_argument("--all", action="store_true",
                    help="show all UDP traffic, not just --host and multicast")
    ap.add_argument("--needle", default="SAVUSAVU",
                    help="string to search payloads for (ascii + utf-16le)")
    ap.add_argument("--out", default=None, help="pcap output path")
    ap.add_argument("--join", action="append", default=[],
                    help="extra multicast group(s) to join")
    ap.add_argument("--quiet", action="store_true",
                    help="only print needle hits and new-flow lines")
    args = ap.parse_args()

    if os.geteuid() != 0:
        sys.exit("must run as root: sudo " + " ".join(sys.argv))

    out = args.out or datetime.datetime.now().strftime(
        "capture-%Y%m%d-%H%M%S.pcap"
    )
    pcap = PcapWriter(out)

    # Raw capture socket, promiscuous.
    sniff = socket.socket(socket.AF_PACKET, socket.SOCK_RAW, socket.htons(ETH_P_ALL))
    sniff.bind((args.iface, 0))
    ifindex = socket.if_nametoindex(args.iface)
    mreq = struct.pack("iHH8s", ifindex, PACKET_MR_PROMISC, 0, b"")
    sniff.setsockopt(SOL_PACKET, PACKET_ADD_MEMBERSHIP, mreq)

    # Membership socket: joining groups makes the kernel emit IGMP reports so
    # snooping switches forward the groups our way. Never read from.
    joiner = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    local_ip = socket.inet_aton(
        os.popen(f"ip -4 -o addr show {args.iface}").read().split()[3].split("/")[0]
    )
    joined = set()

    def join_group(group):
        if group in joined or group == "224.0.0.1":
            return
        try:
            joiner.setsockopt(
                socket.IPPROTO_IP, socket.IP_ADD_MEMBERSHIP,
                socket.inet_aton(group) + local_ip,
            )
            joined.add(group)
            print(f"*** joined multicast group {group}")
        except OSError as e:
            print(f"*** failed to join {group}: {e}")

    for g in DEFAULT_GROUPS + args.join:
        join_group(g)

    flows = {}  # (src, sport, dst, dport) -> [packets, bytes]
    hits = 0

    def summary(*_):
        print(f"\n=== capture summary ({pcap.count} packets -> {out}) ===")
        for (src, sp, dst, dp), (n, nbytes) in sorted(
            flows.items(), key=lambda kv: -kv[1][0]
        ):
            print(f"  {src}:{sp:<5} -> {dst}:{dp:<5}  {n:5} pkts  {nbytes:8} bytes")
        print(f"  needle hits: {hits}")
        pcap.close()
        sys.exit(0)

    signal.signal(signal.SIGINT, summary)
    signal.signal(signal.SIGTERM, summary)

    print(f"capturing on {args.iface}, pcap -> {out}")
    print(f"filter: host {args.host} + all multicast"
          if not args.all else "filter: all UDP")
    print(f"needle: {args.needle!r} (ascii + utf-16le)\n")

    while True:
        frame = sniff.recv(65535)
        ts = time.time()

        # Ethernet header (skip VLAN tag if present).
        if len(frame) < 34:
            continue
        ethertype = struct.unpack("!H", frame[12:14])[0]
        off = 14
        if ethertype == 0x8100:
            ethertype = struct.unpack("!H", frame[16:18])[0]
            off = 18
        if ethertype != 0x0800:
            continue

        ihl = (frame[off] & 0x0F) * 4
        proto = frame[off + 9]
        src = socket.inet_ntoa(frame[off + 12 : off + 16])
        dst = socket.inet_ntoa(frame[off + 16 : off + 20])
        l4 = off + ihl

        # IGMP: learn + auto-join groups the MFDs are members of.
        if proto == 2:
            pcap.write(ts, frame)
            for g in parse_igmp_groups(frame[l4:]):
                if g not in joined:
                    print(f"*** IGMP: {src} is a member of {g}")
                    join_group(g)
            continue

        if proto != 17 or len(frame) < l4 + 8:
            continue

        is_mcast = ipaddress.ip_address(dst).is_multicast
        if not args.all and args.host not in (src, dst) and not is_mcast:
            continue

        sport, dport, ulen = struct.unpack("!HHH", frame[l4 : l4 + 6])
        payload = frame[l4 + 8 : l4 + max(8, ulen)]
        pcap.write(ts, frame)

        key = (src, sport, dst, dport)
        new_flow = key not in flows
        st = flows.setdefault(key, [0, 0])
        st[0] += 1
        st[1] += len(payload)

        hit = contains_needle(payload, args.needle) if args.needle else None
        if hit:
            hits += 1

        if args.quiet and not hit and not new_flow:
            continue

        stamp = datetime.datetime.fromtimestamp(ts).strftime("%H:%M:%S.%f")[:-3]
        tag = f"  <<< NEEDLE HIT ({hit}) >>>" if hit else (
            "  [new flow]" if new_flow else "")
        print(f"{stamp}  {src}:{sport} -> {dst}:{dport}  "
              f"len={len(payload)}{tag}")
        if hit or not args.quiet:
            print(hexdump(payload[:512]))
            if len(payload) > 512:
                print(f"    ... {len(payload) - 512} more bytes (full in pcap)")
            print