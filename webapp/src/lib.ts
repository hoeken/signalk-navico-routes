/**
 * Pure webapp logic: theme resolution, table row derivation, sorting,
 * filtering and formatting. No DOM access, so it unit-tests with plain
 * vitest. Keep it that way — the Preact layer in app.tsx stays thin.
 */

export const PLUGIN_ID = 'signalk-navico-routes';

/** Names sent to the MFD are capped at 16 chars (confirmed Zeus3S limit). */
export const NAME_LIMIT = 16;

export type Theme = 'day' | 'night';

export interface RouteRow {
  id: string;
  name: string;
  /** ISO-8601 or null when the provider supplied no timestamp. */
  timestamp: string | null;
  /** Number of legs (points − 1) in the route's LineString; MFD terminology. */
  legs: number;
  /** Route length in meters, computed from the geometry. */
  lengthM: number;
}

export type SortKey = 'timestamp' | 'name' | 'legs' | 'length';
export type SortDir = 1 | -1;

// ── Theme ────────────────────────────────────────────────────────────────────

/**
 * Initial theme, by priority: the `mode` GET parameter (day/night), then the
 * OS preference. The in-page switcher overrides this afterwards without
 * persisting anything.
 */
export function resolveTheme(search: string, prefersDark: boolean): Theme {
  const match = /[?&]mode=(day|night)\b/i.exec(search);
  if (match) {
    return match[1]!.toLowerCase() as Theme;
  }
  return prefersDark ? 'night' : 'day';
}

// ── Rows ─────────────────────────────────────────────────────────────────────

/**
 * Derive table rows from the v2 resources API response, dropping resources
 * mirrored from the MFD by this plugin and anything without a usable
 * LineString.
 */
export function routeRows(resources: Record<string, unknown>): RouteRow[] {
  const rows: RouteRow[] = [];
  for (const id of Object.keys(resources)) {
    const route = resources[id] as {
      name?: unknown;
      timestamp?: unknown;
      $source?: unknown;
      feature?: { geometry?: { type?: unknown; coordinates?: unknown } };
    };
    if (!route || typeof route !== 'object') {
      continue;
    }
    if (route.$source === PLUGIN_ID) {
      continue; // already on the MFD; this table lists what could be sent
    }
    const geometry = route.feature && route.feature.geometry;
    const coordinates = geometry && geometry.type === 'LineString' ? geometry.coordinates : null;
    if (!Array.isArray(coordinates)) {
      continue;
    }
    const points = coordinates.filter(isPosition);
    rows.push({
      id,
      name: typeof route.name === 'string' ? route.name : '',
      timestamp: typeof route.timestamp === 'string' ? route.timestamp : null,
      legs: Math.max(0, points.length - 1),
      lengthM: lineDistanceMeters(points),
    });
  }
  return rows;
}

function isPosition(v: unknown): v is [number, number] {
  return (
    Array.isArray(v) &&
    v.length >= 2 &&
    typeof v[0] === 'number' &&
    typeof v[1] === 'number' &&
    isFinite(v[0]) &&
    isFinite(v[1])
  );
}

// ── Sort & filter ────────────────────────────────────────────────────────────

export function sortRows(rows: RouteRow[], key: SortKey, dir: SortDir): RouteRow[] {
  const sorted = rows.slice();
  sorted.sort((a, b) => {
    // Rows without a timestamp sort after real ones in either direction.
    if (key === 'timestamp') {
      const missing = missingTimestamp(a) - missingTimestamp(b);
      if (missing !== 0) {
        return missing;
      }
    }
    return dir * compareRows(a, b, key) || a.id.localeCompare(b.id);
  });
  return sorted;
}

function missingTimestamp(row: RouteRow): number {
  return row.timestamp === null || isNaN(Date.parse(row.timestamp)) ? 1 : 0;
}

function compareRows(a: RouteRow, b: RouteRow, key: SortKey): number {
  switch (key) {
    case 'name':
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    case 'legs':
      return a.legs - b.legs;
    case 'length':
      return a.lengthM - b.lengthM;
    case 'timestamp':
      return Date.parse(a.timestamp!) - Date.parse(b.timestamp!);
  }
}

/** Case-insensitive substring match on the route name. */
export function filterRows(rows: RouteRow[], query: string): RouteRow[] {
  const needle = query.trim().toLowerCase();
  if (!needle) {
    return rows;
  }
  return rows.filter((row) => row.name.toLowerCase().indexOf(needle) !== -1);
}

// ── Formatting ───────────────────────────────────────────────────────────────

export function truncateName(name: string): string {
  return name.slice(0, NAME_LIMIT);
}

/** Route length in nautical miles, e.g. '12.4 nm'; '—' for empty routes. */
export function formatLength(meters: number): string {
  if (!(meters > 0)) {
    return '—';
  }
  const nm = meters / 1852;
  return (nm >= 100 ? nm.toFixed(0) : nm.toFixed(1)) + ' nm';
}

export function formatTimestamp(iso: string | null): string {
  if (iso === null) {
    return '—';
  }
  const ms = Date.parse(iso);
  if (isNaN(ms)) {
    return '—';
  }
  const d = new Date(ms);
  const pad = (n: number) => (n < 10 ? '0' : '') + n;
  return (
    d.getFullYear() +
    '-' +
    pad(d.getMonth() + 1) +
    '-' +
    pad(d.getDate()) +
    ' ' +
    pad(d.getHours()) +
    ':' +
    pad(d.getMinutes())
  );
}

/**
 * 'Last synced …' phrasing: 'just now', '5 minutes ago', '3 hours ago',
 * '2 days ago'. Null for a missing or unparseable timestamp.
 */
export function formatRelativeTime(iso: string | null, nowMs: number): string | null {
  if (iso === null) {
    return null;
  }
  const ms = Date.parse(iso);
  if (isNaN(ms)) {
    return null;
  }
  // Clock skew can put the server timestamp slightly in the future.
  const seconds = Math.max(0, Math.floor((nowMs - ms) / 1000));
  if (seconds < 60) {
    return 'just now';
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return agoPhrase(minutes, 'minute');
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return agoPhrase(hours, 'hour');
  }
  return agoPhrase(Math.floor(hours / 24), 'day');
}

function agoPhrase(n: number, unit: string): string {
  return n + ' ' + unit + (n === 1 ? '' : 's') + ' ago';
}

// ── Geometry ─────────────────────────────────────────────────────────────────
//
// Same haversine as the server's mapper; duplicated because the webapp
// bundle cannot pull in server code (node imports).

const EARTH_RADIUS_M = 6371000;

export function lineDistanceMeters(coordinates: [number, number][]): number {
  let total = 0;
  for (let i = 1; i < coordinates.length; i++) {
    total += haversineMeters(coordinates[i - 1]!, coordinates[i]!);
  }
  return total;
}

function haversineMeters([lon1, lat1]: [number, number], [lon2, lat2]: [number, number]): number {
  const toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad;
  const dLon = (lon2 - lon1) * toRad;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(a));
}
