/**
 * USR v6 codec: pure parse/serialize over Buffers. No I/O, no SignalK types.
 *
 * Layout reverse-engineered from Zeus3S-generated files (verified byte-exact
 * against full-database captures) with GPSBabel's lowranceusr reader as
 * documentation. See docs/usr-v6-format.md.
 */

import { BinaryReader, BinaryWriter, UsrParseError } from './binary';
import {
  ROUTE_STREAM_VERSION,
  USR_FORMAT_VERSION,
  USR_TITLE,
  UsrDatabase,
  UsrRoute,
  UsrTimestamp,
  UsrTrailSummary,
  UsrUid,
  UsrWaypoint,
  WAYPOINT_STREAM_VERSION,
} from './model';

export { UsrParseError };

const UUID_BYTES = 16;
/** Sanity cap; real databases hold hundreds of records, not millions. */
const MAX_RECORD_COUNT = 1_000_000;

function readUid(r: BinaryReader): UsrUid {
  return { unit: r.u32(), seqLow: r.u32(), seqHigh: r.u32() };
}

function writeUid(w: BinaryWriter, uid: UsrUid): void {
  w.u32(uid.unit);
  w.u32(uid.seqLow);
  w.u32(uid.seqHigh);
}

function readTimestamp(r: BinaryReader): UsrTimestamp {
  return { julianDay: r.u32(), msOfDay: r.u32() };
}

function writeTimestamp(w: BinaryWriter, t: UsrTimestamp): void {
  w.u32(t.julianDay);
  w.u32(t.msOfDay);
}

function readCount(r: BinaryReader, what: string): number {
  const n = r.u32();
  if (n > MAX_RECORD_COUNT) {
    throw new UsrParseError(`implausible ${what} count ${n}`, r.offset - 4);
  }
  return n;
}

function requireString(v: string | null, what: string, r: BinaryReader): string {
  if (v === null) {
    throw new UsrParseError(`missing ${what} string`, r.offset);
  }
  return v;
}

function parseWaypoint(r: BinaryReader): UsrWaypoint {
  const uuid = r.bytes(UUID_BYTES).toString('hex');
  const uid = readUid(r);
  const streamVersion = r.u16();
  const name = requireString(r.string(2), 'waypoint name', r);
  const uidUnit2 = r.u32();
  const lonMm = r.i32();
  const latMm = r.i32();
  const flags = r.u32();
  const iconId = r.u16();
  const colorId = r.u16();
  const description = r.string(2);
  const alarmRadius = r.f32();
  const created = readTimestamp(r);
  const unusedByte = r.u8();
  const depthFeet = r.f32();
  const loran: [number, number, number] = [r.u32(), r.u32(), r.u32()];
  return {
    uuid,
    uid,
    streamVersion,
    name,
    uidUnit2,
    lonMm,
    latMm,
    flags,
    iconId,
    colorId,
    description,
    alarmRadius,
    created,
    unusedByte,
    depthFeet,
    loran,
  };
}

function serializeWaypoint(w: BinaryWriter, wp: UsrWaypoint): void {
  w.bytes(uuidToBytes(wp.uuid));
  writeUid(w, wp.uid);
  w.u16(wp.streamVersion);
  w.string(wp.name, 2);
  w.u32(wp.uidUnit2);
  w.i32(wp.lonMm);
  w.i32(wp.latMm);
  w.u32(wp.flags);
  w.u16(wp.iconId);
  w.u16(wp.colorId);
  w.string(wp.description, 2);
  w.f32(wp.alarmRadius);
  writeTimestamp(w, wp.created);
  w.u8(wp.unusedByte);
  w.f32(wp.depthFeet);
  w.u32(wp.loran[0]);
  w.u32(wp.loran[1]);
  w.u32(wp.loran[2]);
}

function parseRoute(r: BinaryReader): UsrRoute {
  const uuid = r.bytes(UUID_BYTES).toString('hex');
  const uid = readUid(r);
  const streamVersion = r.u16();
  const name = requireString(r.string(2), 'route name', r);
  const uidUnit2 = r.u32();
  const numLegs = readCount(r, 'route leg');
  const legUuids: string[] = [];
  for (let i = 0; i < numLegs; i++) {
    legUuids.push(r.bytes(UUID_BYTES).toString('hex'));
  }
  const unknownA = r.u8();
  const created = readTimestamp(r);
  const unknownB = r.u8();
  return { uuid, uid, streamVersion, name, uidUnit2, legUuids, unknownA, created, unknownB };
}

function serializeRoute(w: BinaryWriter, rt: UsrRoute): void {
  w.bytes(uuidToBytes(rt.uuid));
  writeUid(w, rt.uid);
  w.u16(rt.streamVersion);
  w.string(rt.name, 2);
  w.u32(rt.uidUnit2);
  w.u32(rt.legUuids.length);
  for (const leg of rt.legUuids) {
    w.bytes(uuidToBytes(leg));
  }
  w.u8(rt.unknownA);
  writeTimestamp(w, rt.created);
  w.u8(rt.unknownB);
}

/**
 * Trail records (stream version 6) are walked to validate overall file
 * structure but only summarized: the plugin never re-serializes trails.
 */
function parseTrail(r: BinaryReader): UsrTrailSummary {
  const uid = readUid(r);
  const streamVersion = r.u16();
  if (streamVersion !== 6) {
    throw new UsrParseError(`unsupported trail stream version ${streamVersion}`, r.offset - 2);
  }
  const name = requireString(r.string(2), 'trail name', r);
  r.u32(); // flags
  r.u32(); // color id
  r.string(2); // description
  readTimestamp(r);
  r.bytes(3); // flag bytes
  const pointCount = readCount(r, 'trail point');
  for (let i = 0; i < pointCount; i++) {
    r.bytes(2 + 1); // unknown u16 + u8
    r.u32(); // POSIX timestamp
    r.f64(); // longitude, radians
    r.f64(); // latitude, radians
    const attrCount = r.u32();
    if (attrCount > 64) {
      throw new UsrParseError(`implausible trail point attribute count ${attrCount}`, r.offset - 4);
    }
    r.bytes(attrCount * 5); // (u8 id, f32 value) pairs
  }
  return { uid, streamVersion, name, pointCount };
}

function uuidToBytes(uuid: string): Buffer {
  if (!/^[0-9a-f]{32}$/.test(uuid)) {
    throw new Error(`invalid USR record uuid '${uuid}'`);
  }
  return Buffer.from(uuid, 'hex');
}

export function parseUsr(buf: Buffer): UsrDatabase {
  const r = new BinaryReader(buf);

  const formatVersion = r.u16();
  const headerStreamVersion = r.u16();
  if (formatVersion !== USR_FORMAT_VERSION) {
    throw new UsrParseError(
      `unsupported USR format version ${formatVersion} (only v${USR_FORMAT_VERSION} is supported)`,
      0,
    );
  }
  const unknownHeader = r.u32();
  const title = requireString(r.string(1), 'title', r);
  if (title !== USR_TITLE) {
    throw new UsrParseError(`bad magic title '${title}'`);
  }
  const dateString = requireString(r.string(1), 'date', r);
  const created = readTimestamp(r);
  const unusedByte = r.u8();
  const serialNumber = r.u32();
  const description = requireString(r.string(1), 'content description', r);

  const numWaypoints = readCount(r, 'waypoint');
  const waypoints: UsrWaypoint[] = [];
  for (let i = 0; i < numWaypoints; i++) {
    waypoints.push(parseWaypoint(r));
  }

  const numRoutes = readCount(r, 'route');
  const routes: UsrRoute[] = [];
  for (let i = 0; i < numRoutes; i++) {
    routes.push(parseRoute(r));
  }

  const numTrails = readCount(r, 'trail');
  const trails: UsrTrailSummary[] = [];
  for (let i = 0; i < numTrails; i++) {
    trails.push(parseTrail(r));
  }

  // Trailing empty-section count (always 0 in observed files). Tolerate its
  // absence in case other firmware omits it, but nothing may follow it.
  if (r.remaining > 0) {
    const trailing = r.u32();
    if (trailing !== 0 || r.remaining > 0) {
      throw new UsrParseError(
        `unexpected trailing data (${r.remaining + 4} bytes after trails)`,
        r.offset - 4,
      );
    }
  }

  return {
    formatVersion,
    headerStreamVersion,
    unknownHeader,
    title,
    dateString,
    created,
    unusedByte,
    serialNumber,
    description,
    waypoints,
    routes,
    trails,
  };
}

/**
 * Serialize a complete USR v6 file. Trails are always written as an empty
 * section regardless of `db.trails` (uploads drop trails; documented).
 */
export function serializeUsr(db: UsrDatabase): Buffer {
  const w = new BinaryWriter();

  w.u16(db.formatVersion);
  w.u16(db.headerStreamVersion);
  w.u32(db.unknownHeader);
  w.string(db.title, 1);
  w.string(db.dateString, 1);
  writeTimestamp(w, db.created);
  w.u8(db.unusedByte);
  w.u32(db.serialNumber);
  w.string(db.description, 1);

  const waypointUuids = new Set(db.waypoints.map((wp) => wp.uuid));
  w.u32(db.waypoints.length);
  for (const wp of db.waypoints) {
    serializeWaypoint(w, wp);
  }

  w.u32(db.routes.length);
  for (const rt of db.routes) {
    for (const leg of rt.legUuids) {
      if (!waypointUuids.has(leg)) {
        throw new Error(`route '${rt.name}' references missing waypoint uuid ${leg}`);
      }
    }
    serializeRoute(w, rt);
  }

  w.u32(0); // trails
  w.u32(0); // trailing empty section

  return w.toBuffer();
}

/** Millisecond-epoch → USR timestamp (julian day + ms of UTC day). */
export function timestampFromDate(date: Date): UsrTimestamp {
  const ms = date.getTime();
  const dayMs = 86_400_000;
  const daysSinceEpoch = Math.floor(ms / dayMs);
  return {
    julianDay: daysSinceEpoch + 2_440_588, // JD of 1970-01-01
    msOfDay: ms - daysSinceEpoch * dayMs,
  };
}

/** 'DD/MM/YYYY' header date string for a given time. */
export function usrDateString(date: Date): string {
  const dd = String(date.getUTCDate()).padStart(2, '0');
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${dd}/${mm}/${date.getUTCFullYear()}`;
}

export { WAYPOINT_STREAM_VERSION, ROUTE_STREAM_VERSION };
