#!/usr/bin/env python3
"""
Live protocol beacon watcher.

Streams packets from tcpdump in real time and prints, with full flow metadata
and a hexdump, every UDP/TCP packet whose payload contains a target string
(searched as ASCII, UTF-16LE and UTF-16BE). Use this while editing the beacon
route 'SAVUSAVU 2 NANAK' on an MFD to see exactly which channel carries it.

It also writes everything to a pcap so you can re-analyze offline.

Usage (needs sudo for the capture):
  sudo python3 research/watch.py                       # default beacon + pcap
  sudo python3 research/watch.py --find NANAK
  sudo python3 research/watch.py --find NANAK --iface eth0 --save out.pcap

Stop with Ctrl-C; it prints a summary of which flows matched.
"""

import argparse
import os
import subprocess
import sys
import struct
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from analyze import decode, hexdump, is_multicast, search_targets  # noqa: E402


def stream_pcap(pipe, saver=None):
    """Yield (linktype, frame) from a live classic-pcap byte stream.

    If saver is an open binary file, faithfully re-write the pcap global header
    and every record so the live capture is preserved for offline analysis.
    """
    hdr = pipe.read(24)
    if len(hdr) < 24:
        return
    if saver:
        saver.write(hdr)
    magic = struct.unpack("<I", hdr[:4])[0]
    endian = "<" if magic in (0xA1B2C3D4, 0xA1B23C4D) else ">"
    linktype = struct.unpack(endian + "I", hdr[20:24])[0]
    rec = endian + "IIII"
    while True:
        rh = pipe.read(16)
        if len(rh) < 16:
            return
        _, _, caplen, _ = struct.unpack(rec, rh)
        frame = pipe.read(caplen)
        if len(frame) < caplen:
            return
        if saver:
            saver.write(rh)
            saver.write(frame)
            saver.flush()
        yield linktype, frame


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--find", default="SAVUSAVU 2 NANAK")
    ap.add_argument("--iface", default=os.environ.get("IFACE", "eth0"))
    ap.add_argument("--save", default=None, help="also write raw pcap here")
    ap.add_argument("--context", type=int, default=64)
    ap.add_argument("--filter",
                    default="udp or (tcp and (net 192.168.2.0/24 or net 169.254.0.0/16))")
    args = ap.parse_args()

    targets = search_targets(args.find)
    print("Watching %s for %r (ascii/utf16le/utf16be)" % (args.iface, args.find))
    print("Filter: %s" % args.filter)
    print(">>> Now edit + SAVE the route on an MFD. Ctrl-C to stop. <<<\n")

    cmd = ["tcpdump", "-i", args.iface, "-n", "-s", "0", "-U", "-w", "-", args.filter]
    if os.geteuid() != 0:
        cmd = ["sudo"] + cmd
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)

    if args.save:
        d = os.path.dirname(os.path.abspath(args.save))
        os.makedirs(d, exist_ok=True)
    saver = open(args.save, "wb") if args.save else None
    hits = 0
    matched_flows = {}
    try:
        for lt, frame in stream_pcap(proc.stdout, saver):
            d = decode(frame, lt)
            if not d:
                continue
            pl = d["payload"]
            if not pl:
                continue
            for enc, pat in targets:
                idx = pl.find(pat)
                if idx < 0:
                    continue
                hits += 1
                key = (d["proto"], d["src"], d["dst"], d["dport"])
                matched_flows[key] = matched_flows.get(key, 0) + 1
                mc = "  (multicast)" if is_multicast(d["dst"]) else ""
                print("=" * 70)
                print("HIT #%d  [%s @ offset %d]  %s" %
                      (hits, enc, idx, time.strftime("%H:%M:%S")))
                print("  %s  %s:%d -> %s:%d  payload=%d bytes%s" %
                      (d["proto"], d["src"], d["sport"], d["dst"],
                       d["dport"], len(pl), mc))
                lo = max(0, idx - args.context)
                hi = min(len(pl), idx + len(pat) + args.context)
                print(hexdump(pl[lo:hi], base=lo))
                print()
                break
    except KeyboardInterrupt:
        pass
    finally:
        proc.terminate()
        if saver:
            saver.close()

    print("\n--- summary: %d matching packets ---" % hits)
    for key, c in sorted(matched_flows.items(), key=lambda x: -x[1]):
        p, s, dd, dp = key
        print("  %s  %s -> %s:%d   x%d" % (p, s, dd, dp, c))
    if not hits:
        print("  (no matches — try a longer/wider filter, or the substring 'NANAK')")


if __name__ == "__main__":
    main()
