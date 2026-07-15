/**
 * Data model for the Navico USR v6 user database.
 *
 * Everything is kept in the file's native representation (mercator-meter
 * integer coordinates, julian-day timestamps, 16-byte UUIDs as hex strings)
 * so that parse → serialize round-trips are lossless. Unit conversion to
 * SignalK land happens in the Mapper.
 *
 * See docs/usr-v6-format.md for the byte-level layout.
 */

/** 16-byte record UUID, lowercase hex, as stored in the file (32 chars). */
export type UsrUuid = string;

/** Per-unit record identity: unit serial number + 64-bit sequence number. */
export interface UsrUid {
  unit: number;
  seqLow: number;
  seqHigh: number;
}

/** Julian day number + milliseconds since midnight UTC. */
export interface UsrTimestamp {
  julianDay: number;
  msOfDay: number;
}

export interface UsrWaypoint {
  uuid: UsrUuid;
  uid: UsrUid;
  /** Waypoint stream version; always 2 in observed Zeus3S data. */
  streamVersion: number;
  name: string;
  /** Second copy of the unit serial; equals uid.unit in observed data. */
  uidUnit2: number;
  /** Longitude/latitude in Lowrance mercator meters (int32). */
  lonMm: number;
  latMm: number;
  /** Observed values 1, 2, 4; meaning unknown. */
  flags: number;
  iconId: number;
  colorId: number;
  /** null = absent (length -1 in file); '' = present but empty. */
  description: string | null;
  alarmRadius: number;
  created: UsrTimestamp;
  /** Single byte between timestamp and depth; 0xff in observed data. */
  unusedByte: number;
  depthFeet: number;
  /** Loran GRI/Tda/Tdb; constant (0xffffffff, 0, 0) in observed data. */
  loran: [number, number, number];
}

export interface UsrRoute {
  uuid: UsrUuid;
  uid: UsrUid;
  /** Route stream version; always 1 in observed Zeus3S data. */
  streamVersion: number;
  name: string;
  uidUnit2: number;
  /** Ordered leg references to waypoint UUIDs. */
  legUuids: UsrUuid[];
  /** Byte before the timestamp; observed 0 or 1, meaning unknown. */
  unknownA: number;
  created: UsrTimestamp;
  /** Byte after the timestamp; 0xff in observed data. */
  unknownB: number;
}

/** Trails are parsed for validation/reporting only and never re-serialized. */
export interface UsrTrailSummary {
  uid: UsrUid;
  streamVersion: number;
  name: string;
  pointCount: number;
}

export interface UsrDatabase {
  /** File format version; must be 6. */
  formatVersion: number;
  /** Second header u16; 0 in observed data. */
  headerStreamVersion: number;
  /** Header u32 of unknown purpose; 10 in observed data. */
  unknownHeader: number;
  /** Magic title string: 'Navico export data file'. */
  title: string;
  /** Creation date as 'DD/MM/YYYY'. */
  dateString: string;
  created: UsrTimestamp;
  /** Header byte; 0xff in observed data. */
  unusedByte: number;
  /** Serial number of the unit that generated the file. */
  serialNumber: number;
  /** Content description: 'Waypoints, routes, and trails'. */
  description: string;
  waypoints: UsrWaypoint[];
  routes: UsrRoute[];
  trails: UsrTrailSummary[];
}

export const USR_FORMAT_VERSION = 6;
export const USR_TITLE = 'Navico export data file';
export const USR_DESCRIPTION = 'Waypoints, routes, and trails';

export const WAYPOINT_STREAM_VERSION = 2;
export const ROUTE_STREAM_VERSION = 1;

/** Defaults for records created on the SignalK side (values observed on Zeus3S). */
export const DEFAULT_WAYPOINT_FLAGS = 4;
export const DEFAULT_ICON_ID = 2;
export const DEFAULT_COLOR_ID = 0;
export const DEFAULT_UNUSED_BYTE = 0xff;
export const DEFAULT_LORAN: [number, number, number] = [0xffffffff, 0, 0];
export const DEFAULT_ROUTE_UNKNOWN_A = 0;
export const DEFAULT_ROUTE_UNKNOWN_B = 0xff;
