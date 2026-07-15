/**
 * Pure conversion between the USR codec model and SignalK v2 resources,
 * plus the canonicalization used everywhere for change detection and the
 * builder that regenerates a complete USR database for upload.
 */

import { createHash } from 'node:crypto';
import { dateFromTimestamp, timestampFromDate, usrDateString } from './usr/codec';
import { latDegToMm, latMmToDeg, lonDegToMm, lonMmToDeg } from './usr/mercator';
import {
  DEFAULT_COLOR_ID,
  DEFAULT_ICON_ID,
  DEFAULT_LORAN,
  DEFAULT_ROUTE_UNKNOWN_B,
  DEFAULT_ROUTE_VISIBLE,
  DEFAULT_UNUSED_BYTE,
  DEFAULT_WAYPOINT_FLAGS,
  ROUTE_STREAM_VERSION,
  USR_DESCRIPTION,
  USR_FORMAT_VERSION,
  USR_TITLE,
  UsrDatabase,
  UsrRoute,
  UsrWaypoint,
  WAYPOINT_STREAM_VERSION,
} from './usr/model';
import type { IdMap } from './id-map';
import { PLUGIN_ID } from './types';
import type { Position, Resource, ResourceType, RouteResource, WaypointResource } from './types';

/**
 * Maximum name length enforced on upload. The Zeus3S on-screen keyboard
 * caps names at 16 characters, but real MFD-generated USR files contain
 * route names up to 24 characters (imported data), so the file format
 * itself accepts longer strings; 32 is a conservative ceiling.
 */
export const MAX_NAME_LENGTH = 32;

// ─── USR → SignalK ───────────────────────────────────────────────────────────

export function usrWaypointToResource(wp: UsrWaypoint): WaypointResource {
  const coordinates: Position = [round8(lonMmToDeg(wp.lonMm)), round8(latMmToDeg(wp.latMm))];
  const resource: WaypointResource = {
    name: wp.name,
    description: wp.description ?? '',
    feature: {
      type: 'Feature',
      geometry: { type: 'Point', coordinates },
      properties: { uuid: wp.uuid },
      id: '',
    },
    timestamp: dateFromTimestamp(wp.created).toISOString(),
    $source: PLUGIN_ID,
  };
  if (wp.description !== null && wp.description !== '') {
    resource.feature.properties.description = wp.description;
  }
  return resource;
}

/** Route conversion; legs resolve through the file's own waypoint records. */
export function usrRouteToResource(
  rt: UsrRoute,
  waypointsByUuid: Map<string, UsrWaypoint>,
): RouteResource {
  const coordinates: Position[] = [];
  for (const uuid of rt.legUuids) {
    const wp = waypointsByUuid.get(uuid);
    if (!wp) {
      throw new Error(`route '${rt.name}' references unknown waypoint uuid ${uuid}`);
    }
    coordinates.push([round8(lonMmToDeg(wp.lonMm)), round8(latMmToDeg(wp.latMm))]);
  }
  return {
    name: rt.name,
    description: '',
    distance: Math.round(lineDistanceMeters(coordinates)),
    feature: {
      type: 'Feature',
      geometry: { type: 'LineString', coordinates },
      properties: { uuid: rt.uuid, visible: rt.visible !== 0 },
      id: '',
    },
    timestamp: dateFromTimestamp(rt.created).toISOString(),
    $source: PLUGIN_ID,
  };
}

// ─── Canonicalization ────────────────────────────────────────────────────────
//
// Canonical content is what "same resource" means for echo suppression,
// pending-edit confirmation and mirror change detection. Coordinates are
// reduced to the mercator-meter integers the USR file actually stores, so a
// value that merely gained float noise in transit compares equal.

export function canonicalWaypoint(resource: WaypointResource): string {
  const [lon, lat] = resource.feature.geometry.coordinates;
  return JSON.stringify({
    name: resource.name ?? '',
    description: resource.description ?? '',
    lon: lonDegToMm(lon),
    lat: latDegToMm(lat),
  });
}

export function canonicalRoute(resource: RouteResource): string {
  return JSON.stringify({
    name: resource.name ?? '',
    description: resource.description ?? '',
    points: resource.feature.geometry.coordinates.map(([lon, lat]) => [
      lonDegToMm(lon),
      latDegToMm(lat),
    ]),
  });
}

export function canonicalize(type: ResourceType, resource: Resource): string {
  return type === 'routes'
    ? canonicalRoute(resource as RouteResource)
    : canonicalWaypoint(resource as WaypointResource);
}

// ─── Validation ──────────────────────────────────────────────────────────────

export function validateResource(type: ResourceType, value: unknown): string | null {
  if (typeof value !== 'object' || value === null) {
    return 'resource must be an object';
  }
  const feature = (value as { feature?: unknown }).feature;
  if (typeof feature !== 'object' || feature === null) {
    return 'resource.feature is required';
  }
  const geometry = (feature as { geometry?: unknown }).geometry;
  if (typeof geometry !== 'object' || geometry === null) {
    return 'resource.feature.geometry is required';
  }
  const { type: gtype, coordinates } = geometry as { type?: unknown; coordinates?: unknown };
  if (type === 'waypoints') {
    if (gtype !== 'Point') {
      return `waypoint geometry must be a Point (got ${String(gtype)})`;
    }
    if (!isPosition(coordinates)) {
      return 'waypoint coordinates must be [longitude, latitude] finite numbers in range';
    }
  } else {
    if (gtype !== 'LineString') {
      return `route geometry must be a LineString (got ${String(gtype)})`;
    }
    if (!Array.isArray(coordinates) || coordinates.length < 2) {
      return 'route coordinates must contain at least 2 positions';
    }
    for (const pos of coordinates) {
      if (!isPosition(pos)) {
        return 'route coordinates must be [longitude, latitude] finite numbers in range';
      }
    }
  }
  return null;
}

function isPosition(v: unknown): v is Position {
  return (
    Array.isArray(v) &&
    v.length >= 2 &&
    typeof v[0] === 'number' &&
    typeof v[1] === 'number' &&
    Number.isFinite(v[0]) &&
    Number.isFinite(v[1]) &&
    Math.abs(v[0]) <= 180 &&
    Math.abs(v[1]) <= 90
  );
}

// ─── SignalK → USR (database builder) ────────────────────────────────────────

export interface BuildInput {
  waypoints: Map<string, WaypointResource>;
  routes: Map<string, RouteResource>;
  /** Most recent successfully parsed download; source of verbatim records. */
  previous?: UsrDatabase;
  idMap: IdMap;
  serialNumber?: number;
  now: Date;
  /** Called once per name that had to be truncated or deduplicated. */
  onNameAdjusted?: (type: ResourceType, original: string, adjusted: string) => void;
}

/**
 * Regenerate a complete USR v6 database from SignalK resources.
 *
 * Records whose canonical content is unchanged from `previous` are emitted
 * byte-losslessly (uuid, uid, icon, color, timestamps all preserved), so an
 * upload of an unchanged database is exactly what the MFD last sent us.
 * Edited records keep their identity (uuid/uid) and cosmetic fields but take
 * new content; new records get observed Zeus3S defaults.
 */
export function buildUsrDatabase(input: BuildInput): UsrDatabase {
  const { idMap, previous, now } = input;
  const serialNumber = input.serialNumber ?? previous?.serialNumber ?? 0;
  const created = timestampFromDate(now);

  const prevWaypoints = new Map((previous?.waypoints ?? []).map((w) => [w.uuid, w]));
  const prevRoutes = new Map((previous?.routes ?? []).map((r) => [r.uuid, r]));
  const prevWaypointsByUuid = prevWaypoints;

  let nextSeq =
    Math.max(
      0,
      ...(previous?.waypoints ?? []).map((w) => w.uid.seqLow),
      ...(previous?.routes ?? []).map((r) => r.uid.seqLow),
    ) + 1;
  const nextUid = () => ({ unit: serialNumber, seqLow: nextSeq++, seqHigh: 0 });

  const waypoints: UsrWaypoint[] = [];
  const waypointsByUuid = new Map<string, UsrWaypoint>();
  const waypointsByCoord = new Map<string, UsrWaypoint>();
  const usedNames = new Set<string>();

  const emitWaypoint = (wp: UsrWaypoint): UsrWaypoint => {
    waypoints.push(wp);
    waypointsByUuid.set(wp.uuid, wp);
    const key = `${wp.lonMm},${wp.latMm}`;
    if (!waypointsByCoord.has(key)) {
      waypointsByCoord.set(key, wp);
    }
    usedNames.add(wp.name);
    return wp;
  };

  const fitName = (name: string, type: ResourceType): string => {
    const adjusted = truncateName(name, usedNames);
    if (adjusted !== name) {
      input.onNameAdjusted?.(type, name, adjusted);
    }
    return adjusted;
  };

  // Waypoints first: routes reference them.
  for (const [id, resource] of input.waypoints) {
    const uuid = idMap.ensureUuid(id, 'waypoints');
    const prev = prevWaypointsByUuid.get(uuid);
    if (prev && canonicalUsrWaypoint(prev) === canonicalWaypoint(resource)) {
      emitWaypoint(prev);
      continue;
    }
    const [lon, lat] = resource.feature.geometry.coordinates;
    emitWaypoint({
      uuid,
      uid: prev?.uid ?? nextUid(),
      streamVersion: prev?.streamVersion ?? WAYPOINT_STREAM_VERSION,
      name: fitName(resource.name ?? '', 'waypoints'),
      uidUnit2: prev?.uidUnit2 ?? serialNumber,
      lonMm: lonDegToMm(lon),
      latMm: latDegToMm(lat),
      flags: prev?.flags ?? DEFAULT_WAYPOINT_FLAGS,
      iconId: prev?.iconId ?? DEFAULT_ICON_ID,
      colorId: prev?.colorId ?? DEFAULT_COLOR_ID,
      description: resource.description ?? prev?.description ?? null,
      alarmRadius: prev?.alarmRadius ?? 0,
      created: prev?.created ?? created,
      unusedByte: prev?.unusedByte ?? DEFAULT_UNUSED_BYTE,
      depthFeet: prev?.depthFeet ?? 0,
      loran: prev?.loran ?? DEFAULT_LORAN,
    });
  }

  const routes: UsrRoute[] = [];
  for (const [id, resource] of input.routes) {
    const uuid = idMap.ensureUuid(id, 'routes');
    const prev = prevRoutes.get(uuid);

    if (prev && usrRouteCanonicalMatches(prev, resource, prevWaypointsByUuid)) {
      // Unchanged: emit verbatim, ensuring all referenced legs are present.
      for (const leg of prev.legUuids) {
        if (!waypointsByUuid.has(leg)) {
          const legWp = prevWaypointsByUuid.get(leg);
          if (legWp) {
            emitWaypoint(legWp);
          }
        }
      }
      routes.push(prev);
      continue;
    }

    // New or edited: build legs, reusing waypoints at identical coordinates
    // and synthesizing (suppressed) leg waypoints for loose vertices.
    const legUuids: string[] = [];
    resource.feature.geometry.coordinates.forEach(([lon, lat]) => {
      const lonMm = lonDegToMm(lon);
      const latMm = latDegToMm(lat);
      const existing =
        waypointsByCoord.get(`${lonMm},${latMm}`) ?? findByCoord(prevWaypoints, lonMm, latMm);
      if (existing) {
        if (!waypointsByUuid.has(existing.uuid)) {
          emitWaypoint(existing);
        }
        legUuids.push(existing.uuid);
        return;
      }
      const legUuid = routeLegUuid(uuid, lonMm, latMm);
      idMap.markSuppressed(legUuid, 'waypoints');
      const legWp = emitWaypoint({
        uuid: legUuid,
        uid: nextUid(),
        streamVersion: WAYPOINT_STREAM_VERSION,
        name: fitName(legPointName(resource.name ?? 'RPT', legUuids.length), 'waypoints'),
        uidUnit2: serialNumber,
        lonMm,
        latMm,
        flags: DEFAULT_WAYPOINT_FLAGS,
        iconId: DEFAULT_ICON_ID,
        colorId: DEFAULT_COLOR_ID,
        description: null,
        alarmRadius: 0,
        created,
        unusedByte: DEFAULT_UNUSED_BYTE,
        depthFeet: 0,
        loran: DEFAULT_LORAN,
      });
      legUuids.push(legWp.uuid);
    });

    routes.push({
      uuid,
      uid: prev?.uid ?? nextUid(),
      streamVersion: prev?.streamVersion ?? ROUTE_STREAM_VERSION,
      name: fitName(resource.name ?? '', 'routes'),
      uidUnit2: prev?.uidUnit2 ?? serialNumber,
      legUuids,
      visible: prev?.visible ?? DEFAULT_ROUTE_VISIBLE,
      created: prev?.created ?? created,
      unknownB: prev?.unknownB ?? DEFAULT_ROUTE_UNKNOWN_B,
    });
  }

  return {
    formatVersion: USR_FORMAT_VERSION,
    headerStreamVersion: previous?.headerStreamVersion ?? 0,
    unknownHeader: previous?.unknownHeader ?? 10,
    title: USR_TITLE,
    dateString: usrDateString(now),
    created,
    unusedByte: previous?.unusedByte ?? DEFAULT_UNUSED_BYTE,
    serialNumber,
    description: USR_DESCRIPTION,
    waypoints,
    routes,
    trails: [],
  };
}

/** Canonical form of a USR waypoint record, comparable to canonicalWaypoint(). */
export function canonicalUsrWaypoint(wp: UsrWaypoint): string {
  return JSON.stringify({
    name: wp.name,
    description: wp.description ?? '',
    lon: wp.lonMm,
    lat: wp.latMm,
  });
}

/** Canonical form of a USR route record, comparable to canonicalRoute(). */
export function canonicalUsrRoute(rt: UsrRoute, waypointsByUuid: Map<string, UsrWaypoint>): string {
  return JSON.stringify({
    name: rt.name,
    description: '',
    points: rt.legUuids.map((uuid) => {
      const wp = waypointsByUuid.get(uuid);
      return wp ? [wp.lonMm, wp.latMm] : [NaN, NaN];
    }),
  });
}

function usrRouteCanonicalMatches(
  prev: UsrRoute,
  resource: RouteResource,
  waypointsByUuid: Map<string, UsrWaypoint>,
): boolean {
  return canonicalUsrRoute(prev, waypointsByUuid) === canonicalRoute(resource);
}

function findByCoord(
  prev: Map<string, UsrWaypoint>,
  lonMm: number,
  latMm: number,
): UsrWaypoint | undefined {
  for (const wp of prev.values()) {
    if (wp.lonMm === lonMm && wp.latMm === latMm) {
      return wp;
    }
  }
  return undefined;
}

/**
 * Deterministic uuid for a synthesized route-leg waypoint, derived from the
 * owning route's uuid and the vertex position: repeated uploads of the same
 * route reference identical waypoint records instead of minting new ones.
 */
export function routeLegUuid(routeUuid: string, lonMm: number, latMm: number): string {
  return createHash('sha1')
    .update(`leg:${routeUuid}:${lonMm}:${latMm}`)
    .digest()
    .subarray(0, 16)
    .toString('hex');
}

function legPointName(routeName: string, index: number): string {
  const base = routeName.slice(0, MAX_NAME_LENGTH - 4).trimEnd();
  return `${base} ${String(index + 1).padStart(2, '0')}`;
}

/**
 * Truncate to MAX_NAME_LENGTH and resolve collisions with `~1`, `~2`, …
 * (only names that were altered participate in collision handling; the
 * caller keeps the original full name on the SignalK side).
 */
export function truncateName(name: string, used: Set<string>): string {
  if (name.length <= MAX_NAME_LENGTH && !used.has(name)) {
    return name;
  }
  if (name.length <= MAX_NAME_LENGTH) {
    // Duplicate of an existing name: allowed on the MFD, keep as-is.
    return name;
  }
  let candidate = name.slice(0, MAX_NAME_LENGTH);
  for (let n = 1; used.has(candidate); n++) {
    const suffix = `~${n}`;
    candidate = name.slice(0, MAX_NAME_LENGTH - suffix.length) + suffix;
  }
  return candidate;
}

// ─── Geometry ────────────────────────────────────────────────────────────────

const EARTH_RADIUS_M = 6371000;

export function lineDistanceMeters(coordinates: Position[]): number {
  let total = 0;
  for (let i = 1; i < coordinates.length; i++) {
    total += haversineMeters(coordinates[i - 1]!, coordinates[i]!);
  }
  return total;
}

function haversineMeters([lon1, lat1]: Position, [lon2, lat2]: Position): number {
  const toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad;
  const dLon = (lon2 - lon1) * toRad;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(a));
}

function round8(v: number): number {
  return Math.round(v * 1e8) / 1e8;
}
