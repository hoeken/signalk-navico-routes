#!/usr/bin/env python3
"""Strict USR v6 parser prototype — validates the format hypothesis against
real captures by consuming every byte and failing loudly on any mismatch.

Layout hypothesis from GPSBabel lowranceusr (read path, formats 4/5/6),
verified empirically against Zeus3S-generated files.
"""
import math
import struct
import sys

SEMIMINOR = 6356752.3142
DEG2RAD = math.pi / 180.0


def lon_mm_to_deg(x):
    return x / (DEG2RAD * SEMIMINOR)


def lat_mm_to_deg(x):
    return (2.0 * math.atan(math.exp(x / SEMIMINOR)) - math.pi / 2.0) / DEG2RAD


class Reader:
    def __init__(self, buf):
        self.buf = buf
        self.off = 0

    def u8(self):
        v = self.buf[self.off]
        self.off += 1
        return v

    def u16(self):
        v = struct.unpack_from('<H', self.buf, self.off)[0]
        self.off += 2
        return v

    def i32(self):
        v = struct.unpack_from('<i', self.buf, self.off)[0]
        self.off += 4
        return v

    def u32(self):
        v = struct.unpack_from('<I', self.buf, self.off)[0]
        self.off += 4
        return v

    def f32(self):
        v = struct.unpack_from('<f', self.buf, self.off)[0]
        self.off += 4
        return v

    def f64(self):
        v = struct.unpack_from('<d', self.buf, self.off)[0]
        self.off += 8
        return v

    def raw(self, n):
        v = self.buf[self.off:self.off + n]
        assert len(v) == n, f'short read at {self.off}'
        self.off += n
        return v

    def string(self, bytes_per_char):
        n = self.i32()
        if n < 0:
            assert n == -1, f'unexpected negative strlen {n} at {self.off - 4}'
            return None
        b = self.raw(n)
        return b.decode('ascii' if bytes_per_char == 1 else 'utf-16-le')


def parse_waypoint(r):
    w = {}
    w['uuid'] = r.raw(16).hex()
    w['uid_unit'] = r.u32()
    w['uid_seq_low'] = r.u32()
    w['uid_seq_high'] = r.u32()
    w['stream_version'] = r.u16()
    w['name'] = r.string(2)
    w['uid_unit2'] = r.u32()
    w['lon'] = lon_mm_to_deg(r.i32())
    w['lat'] = lat_mm_to_deg(r.i32())
    w['flags'] = r.u32()
    w['icon'] = r.u16()
    w['color'] = r.u16()
    w['desc'] = r.string(2)
    w['alarm_radius'] = r.f32()
    w['create_date'] = r.u32()
    w['create_time'] = r.u32()
    w['unused'] = r.u8()
    w['depth_ft'] = r.f32()
    w['loran'] = (r.u32(), r.u32(), r.u32())
    return w


def parse_route(r):
    rt = {}
    rt['uuid'] = r.raw(16).hex()
    rt['uid_unit'] = r.u32()
    rt['uid_seq_low'] = r.u32()
    rt['uid_seq_high'] = r.u32()
    rt['stream_version'] = r.u16()
    rt['name'] = r.string(2)
    rt['uid_unit2'] = r.u32()
    n = r.u32()
    rt['leg_uuids'] = [r.raw(16).hex() for _ in range(n)]
    # trailer: u8 unknown (1..4 observed), u32 julian date, u32 ms-of-day, u8 0xff
    rt['visible'] = r.u8()
    rt['create_date'] = r.u32()
    rt['create_time'] = r.u32()
    rt['unknown_b'] = r.u8()
    return rt


def parse_trail(r):
    """Trail stream version 6 (Zeus3S). Differs from GPSBabel's v3-5 doc:
    no attr-count block between the flag bytes and the point count."""
    t = {}
    t['uid_unit'] = r.u32()
    t['uid_seq_low'] = r.u32()
    t['uid_seq_high'] = r.u32()
    t['stream_version'] = r.u16()
    assert t['stream_version'] == 6, f"trail version {t['stream_version']} at {r.off}"
    t['name'] = r.string(2)
    t['flags'] = r.u32()
    t['color'] = r.u32()
    t['desc'] = r.string(2)
    t['create_date'] = r.u32()
    t['create_time'] = r.u32()
    t['flag_bytes'] = (r.u8(), r.u8(), r.u8())
    npts = r.u32()
    t['num_points'] = npts
    pts = []
    for _ in range(npts):
        p = {}
        p['unk16'] = r.u16()
        p['unk8'] = r.u8()
        p['time'] = r.u32()
        p['lon'] = r.f64() / DEG2RAD
        p['lat'] = r.f64() / DEG2RAD
        m = r.u32()
        p['attrs'] = [(r.u8(), r.f32()) for _ in range(m)]
        pts.append(p)
    t['points'] = pts
    return t


def parse(path):
    buf = open(path, 'rb').read()
    r = Reader(buf)
    hdr = {}
    hdr['format'] = r.u16()
    hdr['stream_version'] = r.u16()
    assert hdr['format'] == 6, hdr
    hdr['unknown'] = r.u32()
    hdr['title'] = r.string(1)
    hdr['date_str'] = r.string(1)
    hdr['create_date'] = r.u32()
    hdr['create_time'] = r.u32()
    hdr['unused'] = r.u8()
    hdr['serial'] = r.u32()
    hdr['comment'] = r.string(1)
    print(f'header: {hdr}')

    nw = r.u32()
    print(f'waypoints: {nw}')
    wpts = [parse_waypoint(r) for _ in range(nw)]
    print(f'  ... parsed all {len(wpts)}, offset now {r.off}/{len(buf)}')
    for w in wpts[:5]:
        print(f"  {w['name']!r:24} lon={w['lon']:.6f} lat={w['lat']:.6f} uuid={w['uuid']} unit={w['uid_unit']:#x} seq={w['uid_seq_low']} sv={w['stream_version']} flags={w['flags']:#x} icon={w['icon']} desc={w['desc']!r}")

    nr = r.u32()
    print(f'routes: {nr}')
    routes = [parse_route(r) for _ in range(nr)]
    uuid_map = {w['uuid']: w for w in wpts}
    for rt in routes:
        resolved = sum(1 for u in rt['leg_uuids'] if u in uuid_map)
        print(f"  {rt['name']!r:24} legs={len(rt['leg_uuids'])} resolved={resolved} sv={rt['stream_version']} vis={rt['visible']} date={rt['create_date']} b={rt['unknown_b']:#x}")
    print(f'  ... offset now {r.off}/{len(buf)}')

    nt = r.u32()
    print(f'trails: {nt}')
    for _ in range(nt):
        t = parse_trail(r)
        print(f"  {t['name']!r:24} pts={t['num_points']} sv={t['stream_version']} flags={t['flags']:#x} color={t['color']}")

    trailing = r.u32()
    assert trailing == 0, f'expected trailing u32 0, got {trailing}'
    remaining = len(buf) - r.off
    print(f'END: offset {r.off} / {len(buf)} — {remaining} bytes remaining')
    if remaining:
        print('TRAILING:', buf[r.off:r.off + 64].hex())
        raise SystemExit(1)
    return wpts, routes


if __name__ == '__main__':
    parse(sys.argv[1])
