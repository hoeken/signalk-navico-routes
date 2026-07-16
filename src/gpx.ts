/**
 * GPX 1.1 export: an alternative download format next to the native USR
 * file. Two sources feed it — the parsed MFD database (backup download)
 * and selected SignalK route resources (selection download). Output is
 * plain XML built by hand; the document is small and flat enough that a
 * dependency would be overkill.
 */

import { dateFromTimestamp } from './usr/codec';
import { latMmToDeg, lonMmToDeg } from './usr/mercator';
import { PLUGIN_ID } from './types';
import type { UsrDatabase } from './usr/model';
import type { RouteResource } from './types';

export const GPX_CONTENT_TYPE = 'application/gpx+xml';

export interface GpxPoint {
  /** Decimal degrees. */
  lon: number;
  lat: number;
  name?: string;
  description?: string;
  /** ISO-8601 creation time. */
  time?: string;
}

export interface GpxRoute {
  name?: string;
  description?: string;
  points: GpxPoint[];
}

export interface GpxDocument {
  waypoints: GpxPoint[];
  routes: GpxRoute[];
  /** ISO-8601 metadata time (file creation). */
  time: string;
}

/**
 * GPX for the MFD's user database: routes become <rte> with named <rtept>
 * legs, and only free-standing waypoints become <wpt> — waypoints serving
 * as route legs already appear inside their route, mirroring how the sync
 * publishes resources. Legs referencing a missing waypoint record are
 * skipped rather than failing the whole export.
 */
export function gpxFromUsrDatabase(db: UsrDatabase, now: Date): string {
  const waypointsByUuid = new Map(db.waypoints.map((wp) => [wp.uuid, wp]));
  const legUuids = new Set<string>(db.routes.flatMap((rt) => rt.legUuids));

  const waypoints: GpxPoint[] = [];
  for (const wp of db.waypoints) {
    if (legUuids.has(wp.uuid)) {
      continue;
    }
    waypoints.push({
      lon: lonMmToDeg(wp.lonMm),
      lat: latMmToDeg(wp.latMm),
      name: wp.name,
      description: wp.description ?? undefined,
      time: dateFromTimestamp(wp.created).toISOString(),
    });
  }

  const routes: GpxRoute[] = db.routes.map((rt) => ({
    name: rt.name,
    points: rt.legUuids.flatMap((uuid): GpxPoint[] => {
      const wp = waypointsByUuid.get(uuid);
      if (!wp) {
        return [];
      }
      return [{ lon: lonMmToDeg(wp.lonMm), lat: latMmToDeg(wp.latMm), name: wp.name }];
    }),
  }));

  return buildGpx({ waypoints, routes, time: now.toISOString() });
}

/** GPX for selected SignalK routes: one <rte> per route, unnamed <rtept>s. */
export function gpxFromRouteResources(routes: Map<string, RouteResource>, now: Date): string {
  return buildGpx({
    waypoints: [],
    routes: [...routes.values()].map((route) => ({
      name: route.name,
      description: route.description || undefined,
      points: route.feature.geometry.coordinates.map(([lon, lat]) => ({ lon, lat })),
    })),
    time: now.toISOString(),
  });
}

export function buildGpx(doc: GpxDocument): string {
  const lines: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<gpx version="1.1" creator="${PLUGIN_ID}" xmlns="http://www.topografix.com/GPX/1/1">`,
    '  <metadata>',
    `    <time>${escapeXml(doc.time)}</time>`,
    '  </metadata>',
  ];
  for (const wp of doc.waypoints) {
    lines.push(...pointLines('wpt', wp, '  '));
  }
  for (const rt of doc.routes) {
    lines.push('  <rte>');
    if (rt.name) {
      lines.push(`    <name>${escapeXml(rt.name)}</name>`);
    }
    if (rt.description) {
      lines.push(`    <desc>${escapeXml(rt.description)}</desc>`);
    }
    for (const pt of rt.points) {
      lines.push(...pointLines('rtept', pt, '    '));
    }
    lines.push('  </rte>');
  }
  lines.push('</gpx>');
  return lines.join('\n') + '\n';
}

/** A wpt/rtept element; child order (time before name) follows the GPX XSD. */
function pointLines(tag: string, pt: GpxPoint, indent: string): string[] {
  const open = `${indent}<${tag} lat="${coord(pt.lat)}" lon="${coord(pt.lon)}">`;
  const children: string[] = [];
  if (pt.time) {
    children.push(`${indent}  <time>${escapeXml(pt.time)}</time>`);
  }
  if (pt.name) {
    children.push(`${indent}  <name>${escapeXml(pt.name)}</name>`);
  }
  if (pt.description) {
    children.push(`${indent}  <desc>${escapeXml(pt.description)}</desc>`);
  }
  if (children.length === 0) {
    return [`${indent}<${tag} lat="${coord(pt.lat)}" lon="${coord(pt.lon)}"/>`];
  }
  return [open, ...children, `${indent}</${tag}>`];
}

/** Fixed-point degrees (~1 mm resolution); XSD decimal forbids exponents. */
function coord(deg: number): string {
  return deg.toFixed(8);
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
