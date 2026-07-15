import { describe, expect, it } from 'vitest';
import { IdMap, newUsrUuid, signalKIdForUsrUuid } from '../src/id-map';
import {
  MAX_NAME_LENGTH,
  buildUsrDatabase,
  canonicalRoute,
  canonicalUsrRoute,
  canonicalUsrWaypoint,
  canonicalWaypoint,
  routeLegUuid,
  truncateName,
  usrRouteToResource,
  usrWaypointToResource,
  validateResource,
} from '../src/mapper';
import { parseUsr, serializeUsr } from '../src/usr/codec';
import { latDegToMm, lonDegToMm } from '../src/usr/mercator';
import type { RouteResource, WaypointResource } from '../src/types';
import { buildUsr, synthUuid } from './helpers/build-usr';

const NOW = new Date('2026-07-15T10:00:00Z');

function fixtureDb() {
  const wpA = {
    uuid: synthUuid(0xa1),
    name: 'SAVUSAVU',
    lonMm: lonDegToMm(179.32534),
    latMm: latDegToMm(-16.7768),
  };
  const wpB = {
    uuid: synthUuid(0xb2),
    name: 'NANAK',
    lonMm: lonDegToMm(179.4),
    latMm: latDegToMm(-16.9),
    description: 'anchorage',
  };
  return parseUsr(
    buildUsr({
      waypoints: [wpA, wpB],
      routes: [{ uuid: synthUuid(0xc3), name: 'SAVUSAVU 2 NANAK', legUuids: [wpA.uuid, wpB.uuid] }],
      serial: 0x30756f09,
    }),
  );
}

describe('usr → SignalK conversion', () => {
  it('converts waypoints with position, name and description', () => {
    const db = fixtureDb();
    const [a, b] = db.waypoints;
    const resA = usrWaypointToResource(a!);
    expect(resA.name).toBe('SAVUSAVU');
    expect(resA.description).toBeUndefined();
    expect(resA.feature.geometry.type).toBe('Point');
    expect(resA.feature.geometry.coordinates[0]).toBeCloseTo(179.32534, 4);
    expect(resA.feature.geometry.coordinates[1]).toBeCloseTo(-16.7768, 4);

    const resB = usrWaypointToResource(b!);
    expect(resB.description).toBe('anchorage');
  });

  it('converts routes to LineStrings via leg resolution, with distance', () => {
    const db = fixtureDb();
    const byUuid = new Map(db.waypoints.map((w) => [w.uuid, w]));
    const route = usrRouteToResource(db.routes[0]!, byUuid);
    expect(route.name).toBe('SAVUSAVU 2 NANAK');
    expect(route.feature.geometry.coordinates).toHaveLength(2);
    // SAVUSAVU→NANAK is roughly 15-16 km.
    expect(route.distance!).toBeGreaterThan(10_000);
    expect(route.distance!).toBeLessThan(25_000);
  });

  it('throws on unresolvable legs', () => {
    const db = fixtureDb();
    expect(() => usrRouteToResource(db.routes[0]!, new Map())).toThrow(/unknown waypoint/);
  });
});

describe('id derivation', () => {
  it('derives stable RFC-4122 v5 ids from usr uuids', () => {
    const uuid = synthUuid(0xa1);
    const id1 = signalKIdForUsrUuid(uuid);
    const id2 = signalKIdForUsrUuid(uuid);
    expect(id1).toBe(id2);
    expect(id1).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(signalKIdForUsrUuid(synthUuid(0xb2))).not.toBe(id1);
  });
});

describe('canonicalization', () => {
  it('matches usr record and converted resource', () => {
    const db = fixtureDb();
    for (const wp of db.waypoints) {
      expect(canonicalWaypoint(usrWaypointToResource(wp))).toBe(canonicalUsrWaypoint(wp));
    }
    const byUuid = new Map(db.waypoints.map((w) => [w.uuid, w]));
    for (const rt of db.routes) {
      expect(canonicalRoute(usrRouteToResource(rt, byUuid))).toBe(canonicalUsrRoute(rt, byUuid));
    }
  });

  it('ignores sub-precision coordinate noise', () => {
    const mk = (lon: number): WaypointResource => ({
      name: 'X',
      feature: {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [lon, -16.8] },
        properties: {},
      },
    });
    expect(canonicalWaypoint(mk(179.3253429))).toBe(canonicalWaypoint(mk(179.32534291)));
    expect(canonicalWaypoint(mk(179.3))).not.toBe(canonicalWaypoint(mk(179.4)));
  });
});

describe('validateResource', () => {
  const goodWp: WaypointResource = {
    name: 'ok',
    feature: {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [179.3, -16.8] },
      properties: {},
    },
  };

  it('accepts valid resources', () => {
    expect(validateResource('waypoints', goodWp)).toBeNull();
    expect(
      validateResource('routes', {
        feature: {
          type: 'Feature',
          geometry: {
            type: 'LineString',
            coordinates: [
              [1, 2],
              [3, 4],
            ],
          },
          properties: {},
        },
      }),
    ).toBeNull();
  });

  it('rejects malformed input', () => {
    expect(validateResource('waypoints', null)).toMatch(/object/);
    expect(validateResource('waypoints', {})).toMatch(/feature/);
    expect(
      validateResource('waypoints', {
        feature: { geometry: { type: 'Point', coordinates: [200, 0] } },
      }),
    ).toMatch(/coordinates/);
    expect(
      validateResource('waypoints', {
        feature: { geometry: { type: 'Point', coordinates: [NaN, 0] } },
      }),
    ).toMatch(/coordinates/);
    expect(
      validateResource('routes', {
        feature: { geometry: { type: 'LineString', coordinates: [[1, 2]] } },
      }),
    ).toMatch(/at least 2/);
    expect(
      validateResource('routes', {
        feature: { geometry: { type: 'Point', coordinates: [1, 2] } },
      }),
    ).toMatch(/LineString/);
  });
});

describe('truncateName', () => {
  it('leaves short names alone', () => {
    expect(truncateName('SAVUSAVU', new Set())).toBe('SAVUSAVU');
  });

  it('truncates long names to the limit', () => {
    const long = 'X'.repeat(MAX_NAME_LENGTH + 10);
    expect(truncateName(long, new Set())).toBe('X'.repeat(MAX_NAME_LENGTH));
  });

  it('resolves truncation collisions with ~N suffixes', () => {
    const used = new Set<string>();
    const long1 = 'A'.repeat(40) + '1';
    const long2 = 'A'.repeat(40) + '2';
    const t1 = truncateName(long1, used);
    used.add(t1);
    const t2 = truncateName(long2, used);
    expect(t1).toBe('A'.repeat(MAX_NAME_LENGTH));
    expect(t2).toBe('A'.repeat(MAX_NAME_LENGTH - 2) + '~1');
  });
});

describe('buildUsrDatabase', () => {
  function resourcesFromDb(db = fixtureDb()) {
    const idMap = new IdMap();
    const byUuid = new Map(db.waypoints.map((w) => [w.uuid, w]));
    const waypoints = new Map(
      db.waypoints.map((w) => [idMap.idForUuid(w.uuid, 'waypoints'), usrWaypointToResource(w)]),
    );
    const routes = new Map(
      db.routes.map((r) => [idMap.idForUuid(r.uuid, 'routes'), usrRouteToResource(r, byUuid)]),
    );
    return { db, idMap, waypoints, routes };
  }

  it('emits unchanged records verbatim (byte-lossless round trip)', () => {
    const { db, idMap, waypoints, routes } = resourcesFromDb();
    const rebuilt = buildUsrDatabase({ waypoints, routes, previous: db, idMap, now: NOW });
    expect(rebuilt.waypoints).toEqual(db.waypoints);
    expect(rebuilt.routes).toEqual(db.routes);
    expect(rebuilt.serialNumber).toBe(db.serialNumber);
    // Full-file byte identity, given the same header timestamp (uploads
    // stamp a fresh creation date; record bytes must be untouched).
    const expected = serializeUsr({
      ...db,
      dateString: rebuilt.dateString,
      created: rebuilt.created,
    });
    expect(serializeUsr(rebuilt).equals(expected)).toBe(true);
  });

  it('preserves identity and cosmetic fields for edited waypoints', () => {
    const { db, idMap, waypoints, routes } = resourcesFromDb();
    const [id, wp] = [...waypoints.entries()][0]!;
    waypoints.set(id, { ...wp, name: 'RENAMED' });
    const rebuilt = buildUsrDatabase({ waypoints, routes, previous: db, idMap, now: NOW });
    const orig = db.waypoints[0]!;
    const edited = rebuilt.waypoints.find((w) => w.uuid === orig.uuid)!;
    expect(edited.name).toBe('RENAMED');
    expect(edited.uid).toEqual(orig.uid);
    expect(edited.iconId).toBe(orig.iconId);
    expect(edited.lonMm).toBe(orig.lonMm);
  });

  it('synthesizes suppressed leg waypoints for new routes, deterministically', () => {
    const idMap = new IdMap();
    const route: RouteResource = {
      name: 'NEW ROUTE',
      feature: {
        type: 'Feature',
        geometry: {
          type: 'LineString',
          coordinates: [
            [179.1, -17.0],
            [179.2, -17.1],
          ],
        },
        properties: {},
      },
    };
    const routes = new Map([['new-route-id', route]]);
    const build1 = buildUsrDatabase({ waypoints: new Map(), routes, idMap, now: NOW });
    expect(build1.routes).toHaveLength(1);
    expect(build1.waypoints).toHaveLength(2);
    expect(build1.routes[0]!.legUuids).toEqual(build1.waypoints.map((w) => w.uuid));
    for (const wp of build1.waypoints) {
      expect(idMap.isSuppressedUuid(wp.uuid)).toBe(true);
    }
    // Deterministic across rebuilds: same leg uuids.
    const build2 = buildUsrDatabase({ waypoints: new Map(), routes, idMap, now: NOW });
    expect(build2.routes[0]!.legUuids).toEqual(build1.routes[0]!.legUuids);
    // And the produced file parses.
    expect(parseUsr(serializeUsr(build1)).routes[0]!.name).toBe('NEW ROUTE');
  });

  it('reuses existing waypoints when route vertices coincide with them', () => {
    const { db, idMap, waypoints, routes } = resourcesFromDb();
    const wpResources = [...waypoints.values()];
    const route: RouteResource = {
      name: 'REUSE',
      feature: {
        type: 'Feature',
        geometry: {
          type: 'LineString',
          coordinates: [
            wpResources[0]!.feature.geometry.coordinates,
            wpResources[1]!.feature.geometry.coordinates,
          ],
        },
        properties: {},
      },
    };
    routes.set('reuse-route', route);
    const rebuilt = buildUsrDatabase({ waypoints, routes, previous: db, idMap, now: NOW });
    // No synthesized waypoints: both vertices matched existing records.
    expect(rebuilt.waypoints).toHaveLength(db.waypoints.length);
    const reuse = rebuilt.routes.find((r) => r.name === 'REUSE')!;
    expect(reuse.legUuids).toEqual([db.waypoints[0]!.uuid, db.waypoints[1]!.uuid]);
  });

  it('keeps verbatim routes intact when their legs are not standalone resources', () => {
    // A route whose leg waypoints are suppressed (not in the waypoints map)
    // must still emit those leg records.
    const idMap = new IdMap();
    const route: RouteResource = {
      name: 'LOOSE',
      feature: {
        type: 'Feature',
        geometry: {
          type: 'LineString',
          coordinates: [
            [10, 10],
            [11, 11],
          ],
        },
        properties: {},
      },
    };
    const routes = new Map([['loose-route', route]]);
    const first = buildUsrDatabase({ waypoints: new Map(), routes, idMap, now: NOW });
    // Simulate next cycle: previous = first, still no standalone waypoints.
    const second = buildUsrDatabase({
      waypoints: new Map(),
      routes,
      previous: first,
      idMap,
      now: new Date(NOW.getTime() + 60_000),
    });
    expect(second.routes).toEqual(first.routes);
    expect(second.waypoints).toEqual(first.waypoints);
  });

  it('reports adjusted names via onNameAdjusted', () => {
    const idMap = new IdMap();
    const adjusted: string[] = [];
    const longName = 'VERY LONG WAYPOINT NAME THAT EXCEEDS THE LIMIT';
    const waypoints = new Map<string, WaypointResource>([
      [
        'wp1',
        {
          name: longName,
          feature: {
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [1, 2] },
            properties: {},
          },
        },
      ],
    ]);
    buildUsrDatabase({
      waypoints,
      routes: new Map(),
      idMap,
      now: NOW,
      onNameAdjusted: (_type, original, name) => adjusted.push(`${original}→${name}`),
    });
    expect(adjusted).toHaveLength(1);
    expect(adjusted[0]).toBe(`${longName}→${longName.slice(0, MAX_NAME_LENGTH)}`);
  });

  it('routeLegUuid is a valid 32-hex uuid and varies with inputs', () => {
    const a = routeLegUuid(synthUuid(1), 100, 200);
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(routeLegUuid(synthUuid(1), 100, 201)).not.toBe(a);
    expect(routeLegUuid(synthUuid(2), 100, 200)).not.toBe(a);
  });
});

describe('IdMap persistence', () => {
  it('assigns each SignalK id a stable usr uuid', () => {
    const map = new IdMap();
    const u1 = map.ensureUuid('some-id', 'routes');
    expect(map.ensureUuid('some-id', 'routes')).toBe(u1);
    expect(map.idFor(u1)).toBe('some-id');
  });

  it('marks and reports foreign ids', () => {
    const map = new IdMap();
    map.markForeign('foreign-1', 'routes');
    expect(map.isForeign('foreign-1')).toBe(true);
    expect(map.foreignIds('routes')).toEqual(['foreign-1']);
    expect(map.foreignIds('waypoints')).toEqual([]);
  });

  it('newUsrUuid generates unique 32-hex uuids', () => {
    const a = newUsrUuid();
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(newUsrUuid()).not.toBe(a);
  });
});
