/**
 * Independent synthetic USR v6 fixture builder for tests.
 *
 * Deliberately does NOT reuse src/usr — it hand-writes bytes straight from
 * the format documentation (docs/usr-v6-format.md), so parser tests exercise
 * the codec against independently constructed input.
 */

export interface SynthWaypoint {
  uuid: string; // 32 hex chars
  unit?: number;
  seq?: number;
  name: string;
  lonMm: number;
  latMm: number;
  flags?: number;
  icon?: number;
  color?: number;
  description?: string | null;
  julianDay?: number;
  msOfDay?: number;
  depthFeet?: number;
}

export interface SynthRoute {
  uuid: string;
  unit?: number;
  seq?: number;
  name: string;
  legUuids: string[];
  visible?: number;
  julianDay?: number;
  msOfDay?: number;
}

export interface SynthTrailPoint {
  time: number;
  lonRad: number;
  latRad: number;
  attrs?: [number, number][];
}

export interface SynthTrail {
  unit?: number;
  seq?: number;
  name: string;
  points: SynthTrailPoint[];
}

class W {
  bufs: Buffer[] = [];
  u8(v: number) {
    this.bufs.push(Buffer.from([v]));
  }
  u16(v: number) {
    const b = Buffer.alloc(2);
    b.writeUInt16LE(v);
    this.bufs.push(b);
  }
  i32(v: number) {
    const b = Buffer.alloc(4);
    b.writeInt32LE(v);
    this.bufs.push(b);
  }
  u32(v: number) {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(v >>> 0);
    this.bufs.push(b);
  }
  f32(v: number) {
    const b = Buffer.alloc(4);
    b.writeFloatLE(v);
    this.bufs.push(b);
  }
  f64(v: number) {
    const b = Buffer.alloc(8);
    b.writeDoubleLE(v);
    this.bufs.push(b);
  }
  hex(h: string) {
    this.bufs.push(Buffer.from(h, 'hex'));
  }
  ascii(s: string) {
    this.i32(s.length);
    this.bufs.push(Buffer.from(s, 'ascii'));
  }
  utf16(s: string | null) {
    if (s === null) {
      this.i32(-1);
      return;
    }
    const raw = Buffer.from(s, 'utf16le');
    this.i32(raw.length);
    this.bufs.push(raw);
  }
  out(): Buffer {
    return Buffer.concat(this.bufs);
  }
}

export function buildUsr(opts: {
  waypoints?: SynthWaypoint[];
  routes?: SynthRoute[];
  trails?: SynthTrail[];
  serial?: number;
  dateString?: string;
  julianDay?: number;
  msOfDay?: number;
  omitTrailingZero?: boolean;
}): Buffer {
  const w = new W();
  // header
  w.u16(6); // format version
  w.u16(0); // stream version
  w.u32(10); // unknown
  w.ascii('Navico export data file');
  w.ascii(opts.dateString ?? '15/07/2026');
  w.u32(opts.julianDay ?? 2461237);
  w.u32(opts.msOfDay ?? 35771547);
  w.u8(0xff);
  w.u32(opts.serial ?? 0x30756f09);
  w.ascii('Waypoints, routes, and trails');

  const wpts = opts.waypoints ?? [];
  w.u32(wpts.length);
  for (const wp of wpts) {
    w.hex(wp.uuid);
    w.u32(wp.unit ?? 0x30756f09);
    w.u32(wp.seq ?? 1);
    w.u32(0);
    w.u16(2); // waypoint stream version
    w.utf16(wp.name);
    w.u32(wp.unit ?? 0x30756f09); // uid_unit2
    w.i32(wp.lonMm);
    w.i32(wp.latMm);
    w.u32(wp.flags ?? 4);
    w.u16(wp.icon ?? 2);
    w.u16(wp.color ?? 0);
    w.utf16(wp.description === undefined ? null : wp.description);
    w.f32(0); // alarm radius
    w.u32(wp.julianDay ?? 2461237);
    w.u32(wp.msOfDay ?? 1000);
    w.u8(0xff);
    w.f32(wp.depthFeet ?? 0);
    w.u32(0xffffffff); // loran
    w.u32(0);
    w.u32(0);
  }

  const routes = opts.routes ?? [];
  w.u32(routes.length);
  for (const rt of routes) {
    w.hex(rt.uuid);
    w.u32(rt.unit ?? 0x30756f09);
    w.u32(rt.seq ?? 1);
    w.u32(0);
    w.u16(1); // route stream version
    w.utf16(rt.name);
    w.u32(rt.unit ?? 0x30756f09);
    w.u32(rt.legUuids.length);
    for (const leg of rt.legUuids) {
      w.hex(leg);
    }
    w.u8(rt.visible ?? 1); // visible flag (1 = visible, 0 = hidden)
    w.u32(rt.julianDay ?? 2461237);
    w.u32(rt.msOfDay ?? 2000);
    w.u8(0xff); // unknown B
  }

  const trails = opts.trails ?? [];
  w.u32(trails.length);
  for (const tr of trails) {
    w.u32(tr.unit ?? 0x30756f09);
    w.u32(tr.seq ?? 1);
    w.u32(0);
    w.u16(6); // trail stream version
    w.utf16(tr.name);
    w.u32(2); // flags
    w.u32(0); // color
    w.utf16(''); // description
    w.u32(2461237);
    w.u32(3000);
    w.u8(2);
    w.u8(0);
    w.u8(0);
    w.u32(tr.points.length);
    for (const p of tr.points) {
      w.u16(3);
      w.u8(1);
      w.u32(p.time);
      w.f64(p.lonRad);
      w.f64(p.latRad);
      const attrs = p.attrs ?? [[1, 5.5]];
      w.u32(attrs.length);
      for (const [id, val] of attrs) {
        w.u8(id);
        w.f32(val);
      }
    }
  }

  if (!opts.omitTrailingZero) {
    w.u32(0);
  }
  return w.out();
}

/** Deterministic pseudo-uuid helper for fixtures: 32 hex chars from a seed. */
export function synthUuid(seed: number): string {
  return seed.toString(16).padStart(8, '0').repeat(4);
}
