import { describe, expect, it } from 'vitest';
import {
  filterRows,
  formatLength,
  formatTimestamp,
  lineDistanceMeters,
  resolveTheme,
  routeRows,
  sortRows,
  truncateName,
} from '../webapp/src/lib';
import type { RouteRow } from '../webapp/src/lib';

const ROUTE = (name: string, coordinates: [number, number][], extra: object = {}) => ({
  name,
  feature: { type: 'Feature', geometry: { type: 'LineString', coordinates }, properties: {} },
  ...extra,
});

describe('resolveTheme', () => {
  it('honours the mode GET parameter first', () => {
    expect(resolveTheme('?mode=night', false)).toBe('night');
    expect(resolveTheme('?mode=day', true)).toBe('day');
    expect(resolveTheme('?zoom=2&mode=NIGHT', false)).toBe('night');
  });

  it('falls back to the OS preference', () => {
    expect(resolveTheme('', true)).toBe('night');
    expect(resolveTheme('', false)).toBe('day');
    expect(resolveTheme('?mode=disco', true)).toBe('night');
  });
});

describe('routeRows', () => {
  it('derives rows and filters out plugin-mirrored routes', () => {
    const rows = routeRows({
      'r-1': ROUTE(
        'PASSAGE',
        [
          [178.1, -17.1],
          [178.2, -17.2],
        ],
        { timestamp: '2026-07-01T00:00:00.000Z' },
      ),
      'r-mine': ROUTE('MIRRORED', [[178.1, -17.1]], { $source: 'signalk-navico-routes' }),
      'r-waypoint': { feature: { geometry: { type: 'Point', coordinates: [178, -17] } } },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: 'r-1',
      name: 'PASSAGE',
      timestamp: '2026-07-01T00:00:00.000Z',
      waypoints: 2,
    });
    expect(rows[0]!.lengthM).toBeGreaterThan(10_000);
  });

  it('tolerates missing names and timestamps', () => {
    const rows = routeRows({ r: ROUTE(undefined as unknown as string, []) });
    expect(rows[0]).toMatchObject({ name: '', timestamp: null, waypoints: 0, lengthM: 0 });
  });
});

describe('sorting and filtering', () => {
  const rows: RouteRow[] = [
    { id: 'a', name: 'bravo', timestamp: '2026-01-02T00:00:00Z', waypoints: 5, lengthM: 100 },
    { id: 'b', name: 'Alpha', timestamp: null, waypoints: 2, lengthM: 300 },
    { id: 'c', name: 'charlie', timestamp: '2026-01-01T00:00:00Z', waypoints: 9, lengthM: 200 },
  ];

  it('sorts by name case-insensitively', () => {
    expect(sortRows(rows, 'name', 1).map((r) => r.id)).toEqual(['b', 'a', 'c']);
    expect(sortRows(rows, 'name', -1).map((r) => r.id)).toEqual(['c', 'a', 'b']);
  });

  it('sorts numerically by waypoints and length', () => {
    expect(sortRows(rows, 'waypoints', 1).map((r) => r.id)).toEqual(['b', 'a', 'c']);
    expect(sortRows(rows, 'length', -1).map((r) => r.id)).toEqual(['b', 'c', 'a']);
  });

  it('sorts by timestamp with missing values last in either direction', () => {
    expect(sortRows(rows, 'timestamp', 1).map((r) => r.id)).toEqual(['c', 'a', 'b']);
    expect(sortRows(rows, 'timestamp', -1).map((r) => r.id)).toEqual(['a', 'c', 'b']);
  });

  it('filters by case-insensitive name substring', () => {
    expect(filterRows(rows, 'ALP').map((r) => r.id)).toEqual(['b']);
    expect(filterRows(rows, '  ')).toHaveLength(3);
    expect(filterRows(rows, 'zulu')).toHaveLength(0);
  });
});

describe('formatting', () => {
  it('formats lengths in nautical miles', () => {
    expect(formatLength(0)).toBe('—');
    expect(formatLength(1852)).toBe('1.0 nm');
    expect(formatLength(1852 * 123.4)).toBe('123 nm');
  });

  it('formats timestamps and tolerates junk', () => {
    expect(formatTimestamp(null)).toBe('—');
    expect(formatTimestamp('not a date')).toBe('—');
    // Rendered in local time, so only the shape is asserted.
    expect(formatTimestamp('2026-07-01T12:34:56Z')).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  });

  it('truncates names to the MFD keyboard limit', () => {
    expect(truncateName('SHORT')).toBe('SHORT');
    expect(truncateName('A ROUTE NAME FAR TOO LONG')).toHaveLength(16);
  });
});

describe('lineDistanceMeters', () => {
  it('matches the known scale of a degree', () => {
    // One degree of latitude ≈ 111 km.
    const m = lineDistanceMeters([
      [178, -17],
      [178, -18],
    ]);
    expect(m).toBeGreaterThan(110_000);
    expect(m).toBeLessThan(112_500);
  });
});
