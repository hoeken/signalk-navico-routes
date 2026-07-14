#!/usr/bin/env python3
"""
Zero-dependency pcap analyzer for reverse-engineering the Navico route-sync
protocol.

Parses a classic libpcap file (as written by tcpdump), decodes Ethernet/IPv4/UDP
(and TCP) headers, and lets us:

  * summarize every UDP multicast flow (src -> group:port, packet/byte counts)
  * search all payloads for a target string in ASCII, UTF-16LE and UTF-16BE
  * hexdump the packets that match, with full flow metadata

Usage:
  python3 analyze.py capture.pcap                      # flow summary
  python3 analyze.py capture.pcap --find 'SAVUSAVU 2 NANAK'
  python3 analyze.py capture.pcap --find NANAK --context 64
  python3 analyze.py capture.pcap --group 236.6.7.20 --dump   # dump a flow
"""

import argparse
import struct
import sys

# ---- pcap global/record header formats -------------------------------------
PCAP_MAGIC_LE = 0xA1B2C3D4        # microsecond, little-endian
PCAP_MAGIC_LE_NS = 0xA1B23C4D     # nanosecond, little-endian


def read_pcap(path):
    """Yield (ts_float, linktype, raw_frame_bytes) for each packet."""
    with open(path, "rb") as f:
        data = f.read()
    if len(data) < 24:
        raise ValueError("file too short to be a pcap")

    magic = struct.unpack("<I", data[:4])[0]
    if magic in (PCAP_MAGIC_LE, PCAP_MAGIC_LE_NS):
        endian = "<"
        nano = magic == PCAP_MAGIC_LE_NS
    else:
        magic_be = struct.unpack(">I", data[:4])[0]
        if magic_be in (PCAP_MAGIC_LE, PCAP_MAGIC_LE_NS):
            endian = ">"
            nano = magic_be == PCAP_MAGIC_LE_NS
        else:
            raise ValueError("not a libpcap file (bad magic 0x%08x)" % magic)

    linktype = struct.unpack(endian + "I", data[20:24])[0]
    off = 24
    rec_fmt = endian + "IIII"
    while off + 16 <= len(data):
        ts_sec, ts_frac, caplen, origlen = struct.unpack(rec_fmt, data[off:off + 16])
        off += 16
        frame = data[off:off + caplen]
        off += caplen
        ts = ts_sec + ts_frac / (1e9 if nano else 1e6)
        yield ts, linktype, frame


# ---- header decoding --------------------------------------------------------
def decode(frame, linktype):
    """Return dict with l4 proto, src/dst ip:port, and payload, or None."""
    # LINKTYPE_ETHERNET = 1
    if linktype != 1 or len(frame) < 14:
        return None
    eth_type = struct.unpack("!H", frame[12:14])[0]
    off = 14
    # VLAN tag(s)
    while eth_type == 0x8100 and len(frame) >= off + 4:
        eth_type = struct.unpack("!H", frame[off + 2:off + 4])[0]
        off += 4
    if eth_type != 0x0800:  # not IPv4
        return None
    if len(frame) < off + 20:
        return None
    ihl = (frame[off] & 0x0F) * 4
    proto = frame[off + 9]
    src = ".".join(str(b) for b in frame[off + 12:off + 16])
    dst = ".".join(str(b) for b in frame[off + 16:off + 20])
    l4 = off + ihl
    if proto == 17 and len(frame) >= l4 + 8:      # UDP
        sport, dport, ulen = struct.unpack("!HHH", frame[l4:l4 + 6])
        payload = frame[l4 + 8:]
        return dict(proto="UDP", src=src, dst=dst, sport=sport,
                    dport=dport, payload=payload)
    if proto == 6 and len(frame) >= l4 + 20:       # TCP
        sport, dport = struct.unpack("!HH", frame[l4:l4 + 4])
        doff = (frame[l4 + 12] >> 4) * 4
        payload = frame[l4 + doff:]
        return dict(proto="TCP", src=src, dst=dst, sport=sport,
                    dport=dport, payload=payload)
    return None


def is_multicast(ip):
    try:
        first = int(ip.split(".")[0])
    except ValueError:
        return False
    return 224 <= first <= 239


def hexdump(data, base=0, limit=None):
    out = []
    if limit is not None:
        data = data[:limit]
    for i in range(0, len(data), 16):
        chunk = data[i:i + 16]
        hexs = " ".join("%02x" % b for b in chunk)
        hexs = "%-47s" % hexs
        asc = "".join(chr(b) if 32 <= b < 127 else "." for b in chunk)
        out.append("  %08x  %s  |%s|" % (base + i, hexs, asc))
    return "\n".join(out)


def search_targets(target):
    """Byte patterns to search for: ascii + utf16 variants (case as given)."""
    variants = []
    variants.append(("ascii", target.encode("ascii", "replace")))
    variants.append(("utf16le", target.encode("utf-16-le")))
    variants.append(("utf16be", target.encode("utf-16-be")))
    return variants


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("pcap")
    ap.add_argument("--find", help="string to search for in payloads")
    ap.add_argument("--context", type=int, default=48,
                    help="hexdump N bytes around each match (default 48)")
    ap.add_argument("--group", help="only show flows to this dst ip (prefix ok)")
    ap.add_argument("--dump", action="store_true",
                    help="hexdump full payloads of matching/selected packets")
    ap.add_argument("--max", type=int, default=20,
                    help="max packets to hexdump (default 20)")
    args = ap.parse_args()

    pkts = list(read_pcap(args.pcap))
    decoded = []
    for ts, lt, frame in pkts:
        d = decode(frame, lt)
        if d:
            d["ts"] = ts
            decoded.append(d)

    print("Total frames: %d, decoded IPv4 UDP/TCP: %d" % (len(pkts), len(decoded)))

    if args.find:
        targets = search_targets(args.find)
        print("\nSearching for %r (ascii/utf16le/utf16be)..." % args.find)
        shown = 0
        hits = 0
        for d in decoded:
            pl = d["payload"]
            matched_enc = None
            matched_at = None
            for enc, pat in targets:
                idx = pl.find(pat)
                if idx >= 0:
                    matched_enc, matched_at = enc, idx
                    break
            if matched_enc is None:
                continue
            hits += 1
            if shown >= args.max:
                continue
            shown += 1
            print("\n=== MATCH #%d [%s @ offset %d] ============================"
                  % (hits, matched_enc, matched_at))
            print("  %.6f  %s  %s:%d -> %s:%d  len=%d%s"
                  % (d["ts"], d["proto"], d["src"], d["sport"], d["dst"],
                     d["dport"], len(pl),
                     "  (multicast)" if is_multicast(d["dst"]) else ""))
            if args.dump:
                print(hexdump(pl))
            else:
                lo = max(0, matched_at - args.context)
                hi = min(len(pl), matched_at + len(targets[0][1]) + args.context)
                print(hexdump(pl[lo:hi], base=lo))
        print("\nTotal matching packets: %d" % hits)
        return

    # No --find: summarize flows.
    flows = {}
    for d in decoded:
        if args.group and not d["dst"].startswith(args.group):
            continue
        key = (d["proto"], d["src"], d["dst"], d["dport"])
        f = flows.setdefault(key, dict(pkts=0, bytes=0, lens=set()))
        f["pkts"] += 1
        f["bytes"] += len(d["payload"])
        f["lens"].add(len(d["payload"]))

    print("\n%-4s %-22s %-22s %8s %10s  payload-lens"
          % ("PROT", "SRC", "DST:PORT", "PKTS", "BYTES"))
    for key in sorted(flows, key=lambda k: -flows[k]["pkts"]):
        proto, src, dst, dport = key
        f = flows[key]
        mc = "*" if is_multicast(dst) else " "
        lens = sorted(f["lens"])
        lens_s = ",".join(str(x) for x in lens[:8]) + ("..." if len(lens) > 8 else "")
        print("%-4s %-22s %s%-21s %8d %10d  %s"
              % (proto, src, mc, "%s:%d" % (dst, dport), f["pkts"], f["bytes"], lens_s))

    if args.group and args.dump:
        print("\n--- payload hexdumps for group %s ---" % args.group)
        n = 0
        for d in decoded:
            if not d["dst"].startswith(args.group):
                continue
            if n >= args.max:
                break
            n += 1
            print("\n%.6f  %s:%d -> %s:%d  len=%d"
                  % (d["ts"], d["src"], d["sport"], d["dst"], d["dport"], len(d["payload"])))
            print(hexdump(d["payload"]))


if __name__ == "__main__":
    main()
