import { describe, expect, it } from 'vitest';
import { buildGpx, gpxFromRouteResources, gpxFromUsrDatabase } from '../src/gpx';
import { timestampFromDate } from '../src/usr/codec';
import { latDegToMm, latMmToDeg, lonDegToMm, lonMmToDeg } from '../src/usr/mercator';
import type { UsrDatabase, UsrRoute, UsrWaypoint } from '../src/usr/model';
import type { RouteResource } from '../src/types';

const NOW = new Date('2026-07-16T10:30:00.000Z');
const CREATED_ISO = '2026-07-15T08:00:00.000Z';
const CREATED = timestampFromDate(new Date(CREATED_ISO));

function waypoint(
  uuid: string,
  name: string,
  lonDeg: number,
  latDeg: number,
  description: string | null = null,
): UsrWaypoint {
  return {
    uuid,
    uid: { unit: 1, seqLow: 1, seqHigh: 0 },
    streamVersion: 2,
    name,
    uidUnit2: 1,
    lonMm: lonDegToMm(lonDeg),
    latMm: latDegToMm(latDeg),
    flags: 4,
    iconId: 2,
    colorId: 0,
    description,
    alarmRadius: 0,
    created: CREATED,
    unusedByte: 0xff,
    depthFeet: 0,
    loran: [0xffffffff, 0, 0],
  };
}

function route(uuid: string, name: string, legUuids: string[]): UsrRoute {
  return {
    uuid,
    uid: { unit: 1, seqLow: 2, seqHigh: 0 },
    streamVersion: 1,
    name,
    uidUnit2: 1,
    legUuids,
    visible: 1,
    created: CREATED,
    unknownB: 0xff,
  };
}

function database(waypoints: UsrWaypoint[], routes: UsrRoute[]): UsrDatabase {
  return {
    formatVersion: 6,
    headerStreamVersion: 0,
    unknownHeader: 10,
    title: 'Navico export data file',
    dateString: '16/07/2026',
    created: CREATED,
    unusedByte: 0xff,
    serialNumber: 1,
    description: 'Waypoints, routes, and trails',
    waypoints,
    routes,
    trails: [],
  };
}

/** Degrees as the file stores them (mercator-meter rounded), GPX-formatted. */
function lonAttr(deg: number): string {
  return lonMmToDeg(lonDegToMm(deg)).toFixed(8);
}
function latAttr(deg: number): string {
  return latMmToDeg(latDegToMm(deg)).toFixed(8);
}

describe('gpxFromUsrDatabase', () => {
  it('emits free-standing waypoints as <wpt> and routes with named <rtept> legs', () => {
    const db = database(
      [
        waypoint('aa'.repeat(16), 'ANCHORAGE', 178.5, -17.5, 'Good holding'),
        waypoint('bb'.repeat(16), 'PASSAGE 01', 178.1, -17.1),
        waypoint('cc'.repeat(16), 'PASSAGE 02', 178.2, -17.2),
      ],
      [route('dd'.repeat(16), 'PASSAGE', ['bb'.repeat(16), 'cc'.repeat(16)])],
    );
    const gpx = gpxFromUsrDatabase(db, NOW);

    expect(gpx).toContain('<gpx version="1.1" creator="signalk-navico-routes"');
    expect(gpx).toContain('<time>2026-07-16T10:30:00.000Z</time>');

    // Free-standing waypoint, with description and creation time.
    expect(gpx).toContain(`<wpt lat="${latAttr(-17.5)}" lon="${lonAttr(178.5)}">`);
    expect(gpx).toContain('<name>ANCHORAGE</name>');
    expect(gpx).toContain('<desc>Good holding</desc>');
    expect(gpx).toContain(`<time>${CREATED_ISO}</time>`);

    // Route with named legs; leg waypoints do not appear as <wpt>.
    expect(gpx).toContain('<name>PASSAGE</name>');
    expect(gpx).toContain(`<rtept lat="${latAttr(-17.1)}" lon="${lonAttr(178.1)}">`);
    expect(gpx).toContain('<name>PASSAGE 01</name>');
    expect(gpx).toContain('<name>PASSAGE 02</name>');
    expect(gpx).not.toContain(`<wpt lat="${latAttr(-17.1)}"`);
  });

  it('skips route legs whose waypoint record is missing', () => {
    const db = database(
      [waypoint('bb'.repeat(16), 'PASSAGE 01', 178.1, -17.1)],
      [route('dd'.repeat(16), 'PASSAGE', ['bb'.repeat(16), 'ee'.repeat(16)])],
    );
    const gpx = gpxFromUsrDatabase(db, NOW);
    expect(gpx.match(/<rtept /g)).toHaveLength(1);
  });
});

describe('gpxFromRouteResources', () => {
  const resource: RouteResource = {
    name: 'Passage <to> "Savusavu" & back',
    description: 'Reef & pass notes',
    feature: {
      type: 'Feature',
      geometry: {
        type: 'LineString',
        coordinates: [
          [178.1, -17.1],
          [178.2, -17.2],
        ],
      },
      properties: {},
    },
  };

  it('emits one <rte> per route with escaped names and plain points', () => {
    const gpx = gpxFromRouteResources(new Map([['r1', resource]]), NOW);
    expect(gpx).toContain('<name>Passage &lt;to&gt; &quot;Savusavu&quot; &amp; back</name>');
    expect(gpx).toContain('<desc>Reef &amp; pass notes</desc>');
    expect(gpx).toContain('<rtept lat="-17.10000000" lon="178.10000000"/>');
    expect(gpx).toContain('<rtept lat="-17.20000000" lon="178.20000000"/>');
    expect(gpx).not.toContain('<wpt');
  });
});

describe('buildGpx', () => {
  it('produces a well-formed empty document', () => {
    const gpx = buildGpx({ waypoints: [], routes: [], time: NOW.toISOString() });
    expect(gpx).toBe(
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
        '<gpx version="1.1" creator="signalk-navico-routes" xmlns="http://www.topografix.com/GPX/1/1">\n' +
        '  <metadata>\n' +
        '    <time>2026-07-16T10:30:00.000Z</time>\n' +
        '  </metadata>\n' +
        '</gpx>\n',
    );
  });
});
