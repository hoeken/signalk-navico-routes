/**
 * Ground-truth tests against real Zeus3S captures. The capture files are
 * gitignored (large, device-specific); these tests skip cleanly when absent.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseUsr, serializeUsr } from '../../src/usr/codec';
import { latMmToDeg, lonMmToDeg } from '../../src/usr/mercator';

const capturesDir = join(__dirname, '..', '..', 'research', 'captures');
const captures = ['mfd113.usr', 'mfd110.usr']
  .map((f) => join(capturesDir, f))
  .filter((f) => existsSync(f));

describe.skipIf(captures.length === 0)('USR codec against real captures', () => {
  if (captures.length === 0) {
    return; // note: skipped because research/captures/*.usr are not present
  }

  it.each(captures)('parses %s completely', (file) => {
    const db = parseUsr(readFileSync(file));
    expect(db.formatVersion).toBe(6);
    expect(db.title).toBe('Navico export data file');
    expect(db.waypoints.length).toBeGreaterThan(100);
    expect(db.routes.length).toBeGreaterThan(10);

    // Every route leg must resolve to a waypoint uuid.
    const uuids = new Set(db.waypoints.map((w) => w.uuid));
    for (const rt of db.routes) {
      for (const leg of rt.legUuids) {
        expect(uuids.has(leg)).toBe(true);
      }
    }

    // All coordinates must be finite and in range.
    for (const wp of db.waypoints) {
      const lon = lonMmToDeg(wp.lonMm);
      const lat = latMmToDeg(wp.latMm);
      expect(lon).toBeGreaterThanOrEqual(-180);
      expect(lon).toBeLessThanOrEqual(180);
      expect(lat).toBeGreaterThanOrEqual(-90);
      expect(lat).toBeLessThanOrEqual(90);
    }
  });

  it.each(captures)('%s contains the known ground-truth routes', (file) => {
    const db = parseUsr(readFileSync(file));
    const names = db.routes.map((r) => r.name);
    expect(names).toContain('SAVUSAVU 2 NANAK');
    expect(names).toContain('TESTTEST');

    // SAVUSAVU 2 NANAK runs through Fiji waters (~179.3°E, ~-16.8°S).
    const savusavu = db.routes.find((r) => r.name === 'SAVUSAVU 2 NANAK')!;
    const byUuid = new Map(db.waypoints.map((w) => [w.uuid, w]));
    const legs = savusavu.legUuids.map((u) => byUuid.get(u)!);
    expect(legs.length).toBeGreaterThan(2);
    const nearFiji = legs.filter((w) => {
      const lon = lonMmToDeg(w.lonMm);
      const lat = latMmToDeg(w.latMm);
      return lon > 178.5 && lon <= 180 && lat > -18 && lat < -16;
    });
    expect(nearFiji.length).toBeGreaterThan(0);
  });

  it.each(captures)('serialize(parse(%s)) is byte-identical except dropped trails', (file) => {
    const buf = readFileSync(file);
    const db = parseUsr(buf);
    const out = serializeUsr(db);

    // Output = header + waypoints + routes byte-for-byte from the original,
    // then an empty trails section (u32 0) and the trailing u32 0.
    const preserved = out.length - 8;
    expect(out.subarray(0, preserved).equals(buf.subarray(0, preserved))).toBe(true);
    expect(out.readUInt32LE(preserved)).toBe(0);
    expect(out.readUInt32LE(preserved + 4)).toBe(0);

    // And the re-parse is semantically identical for waypoints/routes.
    const again = parseUsr(out);
    expect(again.waypoints).toEqual(db.waypoints);
    expect(again.routes).toEqual(db.routes);
  });
});
