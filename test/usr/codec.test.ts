import { describe, expect, it } from 'vitest';
import {
  dateFromTimestamp,
  parseUsr,
  serializeUsr,
  timestampFromDate,
  usrDateString,
} from '../../src/usr/codec';
import { UsrParseError } from '../../src/usr/binary';
import { latDegToMm, latMmToDeg, lonDegToMm, lonMmToDeg } from '../../src/usr/mercator';
import { buildUsr, synthUuid } from '../helpers/build-usr';

describe('mercator conversion', () => {
  it('round-trips degrees through mercator meters at ~1e-5 degree precision', () => {
    const cases = [
      [179.32534291, -16.7768],
      [-178.564392, -19.144554],
      [0, 0],
      [-179.99999, 89.0],
      [179.99999, -89.0],
      [18.4233, -33.9188],
    ];
    for (const [lon, lat] of cases) {
      expect(Math.abs(lonMmToDeg(lonDegToMm(lon!)) - lon!)).toBeLessThan(1e-5);
      expect(Math.abs(latMmToDeg(latDegToMm(lat!)) - lat!)).toBeLessThan(1e-5);
    }
  });

  it('matches values verified against the Zeus3S capture', () => {
    // Waypoint NM002 in mfd113.usr stores lonMm=-19811051, latMm=-2164680.
    expect(lonMmToDeg(-19811051)).toBeCloseTo(-178.564392, 5);
    expect(latMmToDeg(-2164680)).toBeCloseTo(-19.144554, 5);
  });
});

describe('parseUsr (synthetic fixtures)', () => {
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
    description: 'a comment',
  };

  it('parses header, waypoints, routes and trails', () => {
    const buf = buildUsr({
      waypoints: [wpA, wpB],
      routes: [{ uuid: synthUuid(0xc3), name: 'SAVUSAVU 2 NANAK', legUuids: [wpA.uuid, wpB.uuid] }],
      trails: [
        {
          name: 'a trail',
          points: [
            { time: 1685240887, lonRad: -1.23, latRad: 0.22 },
            { time: 1685240888, lonRad: -1.24, latRad: 0.23, attrs: [] },
          ],
        },
      ],
      serial: 12345,
    });
    const db = parseUsr(buf);

    expect(db.formatVersion).toBe(6);
    expect(db.title).toBe('Navico export data file');
    expect(db.dateString).toBe('15/07/2026');
    expect(db.serialNumber).toBe(12345);
    expect(db.description).toBe('Waypoints, routes, and trails');

    expect(db.waypoints).toHaveLength(2);
    const [a, b] = db.waypoints;
    expect(a!.name).toBe('SAVUSAVU');
    expect(a!.uuid).toBe(wpA.uuid);
    expect(lonMmToDeg(a!.lonMm)).toBeCloseTo(179.32534, 4);
    expect(latMmToDeg(a!.latMm)).toBeCloseTo(-16.7768, 4);
    expect(a!.description).toBeNull();
    expect(b!.description).toBe('a comment');

    expect(db.routes).toHaveLength(1);
    expect(db.routes[0]!.name).toBe('SAVUSAVU 2 NANAK');
    expect(db.routes[0]!.legUuids).toEqual([wpA.uuid, wpB.uuid]);

    expect(db.trails).toHaveLength(1);
    expect(db.trails[0]!.name).toBe('a trail');
    expect(db.trails[0]!.pointCount).toBe(2);
  });

  it('parses non-ASCII UTF-16 names', () => {
    const wp = { ...wpA, name: 'Ōtāhuhu ⚓ 錨地' };
    const db = parseUsr(buildUsr({ waypoints: [wp] }));
    expect(db.waypoints[0]!.name).toBe('Ōtāhuhu ⚓ 錨地');
  });

  it('parses empty names and empty vs absent descriptions distinctly', () => {
    const db = parseUsr(
      buildUsr({
        waypoints: [
          { ...wpA, name: '', description: '' },
          { ...wpB, description: null },
        ],
      }),
    );
    expect(db.waypoints[0]!.name).toBe('');
    expect(db.waypoints[0]!.description).toBe('');
    expect(db.waypoints[1]!.description).toBeNull();
  });

  it('tolerates a missing trailing zero section', () => {
    const db = parseUsr(buildUsr({ waypoints: [wpA], omitTrailingZero: true }));
    expect(db.waypoints).toHaveLength(1);
  });

  it('rejects wrong format version', () => {
    const buf = buildUsr({});
    buf.writeUInt16LE(5, 0);
    expect(() => parseUsr(buf)).toThrow(UsrParseError);
    expect(() => parseUsr(buf)).toThrow(/format version 5/);
  });

  it('rejects bad magic', () => {
    const buf = buildUsr({});
    buf.write('Xavico', 12, 'ascii');
    expect(() => parseUsr(buf)).toThrow(/magic/);
  });

  it('rejects truncated files', () => {
    const buf = buildUsr({ waypoints: [wpA, wpB] });
    expect(() => parseUsr(buf.subarray(0, buf.length - 30))).toThrow(UsrParseError);
  });

  it('rejects trailing garbage', () => {
    const buf = Buffer.concat([buildUsr({ waypoints: [wpA] }), Buffer.from([1, 2, 3, 4])]);
    expect(() => parseUsr(buf)).toThrow(/trailing/);
  });
});

describe('serializeUsr', () => {
  const wp = {
    uuid: synthUuid(0xa1),
    name: 'TEST',
    lonMm: lonDegToMm(179.3),
    latMm: latDegToMm(-16.8),
  };

  it('round-trips a synthetic database byte-identically (modulo dropped trails)', () => {
    const noTrails = buildUsr({
      waypoints: [wp, { ...wp, uuid: synthUuid(0xb2), name: 'TEST2' }],
      routes: [
        { uuid: synthUuid(0xc3), name: 'TESTTEST', legUuids: [synthUuid(0xa1), synthUuid(0xb2)] },
      ],
    });
    const out = serializeUsr(parseUsr(noTrails));
    expect(out.equals(noTrails)).toBe(true);
  });

  it('drops trails but preserves everything else byte-identically', () => {
    const withTrails = buildUsr({
      waypoints: [wp],
      trails: [{ name: 't', points: [{ time: 1, lonRad: 0.5, latRad: 0.5 }] }],
    });
    const withoutTrails = buildUsr({ waypoints: [wp] });
    expect(serializeUsr(parseUsr(withTrails)).equals(withoutTrails)).toBe(true);
  });

  it('round-trips edge-case strings and coordinates through parse(serialize(db))', () => {
    const cases = [
      { name: '', lon: 0, lat: 0 },
      { name: 'x'.repeat(64), lon: -179.99999, lat: 85 },
      { name: '16 chars exactly', lon: 179.99999, lat: -85 },
      { name: 'ünïcødé ⚓', lon: 179.99999, lat: -0.00001 },
    ];
    const db = parseUsr(
      buildUsr({
        waypoints: cases.map((c, i) => ({
          uuid: synthUuid(i + 1),
          name: c.name,
          lonMm: lonDegToMm(c.lon),
          latMm: latDegToMm(c.lat),
        })),
      }),
    );
    const again = parseUsr(serializeUsr(db));
    expect(again.waypoints).toEqual(db.waypoints);
    expect(again.routes).toEqual(db.routes);
  });

  it('refuses to serialize a route with unresolved leg uuids', () => {
    const db = parseUsr(buildUsr({ waypoints: [wp] }));
    db.routes.push({
      uuid: synthUuid(0xdd),
      uid: { unit: 0, seqLow: 0, seqHigh: 0 },
      streamVersion: 1,
      name: 'BROKEN',
      uidUnit2: 0,
      legUuids: [synthUuid(0xee)],
      visible: 0,
      created: { julianDay: 2461237, msOfDay: 0 },
      unknownB: 0xff,
    });
    expect(() => serializeUsr(db)).toThrow(/missing waypoint/);
  });
});

describe('timestamp helpers', () => {
  it('computes julian day and ms-of-day for known dates', () => {
    // 1970-01-01T00:00:00Z is julian day 2440588.
    expect(timestampFromDate(new Date(0))).toEqual({ julianDay: 2440588, msOfDay: 0 });
    // Value observed in the capture header: julian 2461237 = 2026-07-15.
    const t = timestampFromDate(new Date('2026-07-15T09:56:11.547Z'));
    expect(t.julianDay).toBe(2461237);
    expect(t.msOfDay).toBe(35771547);
  });

  it('round-trips through dateFromTimestamp', () => {
    expect(dateFromTimestamp({ julianDay: 2440588, msOfDay: 0 }).getTime()).toBe(0);
    const date = new Date('2026-07-15T09:56:11.547Z');
    expect(dateFromTimestamp(timestampFromDate(date)).toISOString()).toBe(date.toISOString());
  });

  it('formats DD/MM/YYYY', () => {
    expect(usrDateString(new Date('2026-07-15T09:56:11Z'))).toBe('15/07/2026');
  });
});
