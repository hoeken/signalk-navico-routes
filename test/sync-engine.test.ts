import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IdMap } from '../src/id-map';
import { ResourceStore } from '../src/resource-store';
import { SyncEngine, SyncEngineConfig } from '../src/sync-engine';
import { parseUsr, serializeUsr } from '../src/usr/codec';
import { latDegToMm, lonDegToMm } from '../src/usr/mercator';
import type { Resource, ResourceType, RouteResource } from '../src/types';
import { buildUsr, synthUuid } from './helpers/build-usr';

const CONFIG: SyncEngineConfig = {
  syncFromMfd: true,
  syncRoutes: true,
  syncVisibleRoutesOnly: true,
  syncWaypoints: true,
  pollIntervalSeconds: 60,
};

const WP_A = {
  uuid: synthUuid(0xa1),
  name: 'SAVUSAVU',
  lonMm: lonDegToMm(179.32534),
  latMm: latDegToMm(-16.7768),
};
const WP_B = {
  uuid: synthUuid(0xb2),
  name: 'NANAK',
  lonMm: lonDegToMm(179.4),
  latMm: latDegToMm(-16.9),
};
const ROUTE = { uuid: synthUuid(0xc3), name: 'SAVUSAVU 2 NANAK', legUuids: [WP_A.uuid, WP_B.uuid] };
// Free-standing waypoint, not a leg of any route.
const WP_C = {
  uuid: synthUuid(0xd4),
  name: 'VUDA',
  lonMm: lonDegToMm(177.386),
  latMm: latDegToMm(-17.681),
};

function harness(configOverrides: Partial<SyncEngineConfig> = {}, cachedUsr?: Buffer) {
  const store = new ResourceStore();
  const idMap = new IdMap();
  const mfd = { buf: buildUsr({ waypoints: [WP_A, WP_B, WP_C], routes: [ROUTE] }) };
  const cached = { buf: cachedUsr };
  const deltas: { type: ResourceType; id: string; value: Resource | null }[] = [];
  const errors: string[] = [];
  const uploads: Buffer[] = [];

  const client = {
    download: vi.fn(async () => mfd.buf),
    upload: vi.fn(async (buf: Buffer) => {
      uploads.push(buf);
    }),
  };

  const engine = new SyncEngine(
    { ...CONFIG, ...configOverrides },
    {
      client,
      store,
      idMap,
      cache: {
        load: async () => cached.buf,
        save: async (buf: Buffer) => {
          cached.buf = buf;
        },
      },
      emitDelta: (type, id, value) => deltas.push({ type, id, value }),
      log: { debug: () => undefined, error: (msg) => errors.push(msg) },
      setStatus: () => undefined,
      setError: () => undefined,
    },
  );

  return { engine, store, idMap, mfd, deltas, errors, client, cached, uploads };
}

async function settle(ms: number) {
  await vi.advanceTimersByTimeAsync(ms);
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(async () => {
  vi.useRealTimers();
});

describe('MFD → SignalK mirror', () => {
  it('populates the store and emits deltas on first poll', async () => {
    const h = harness();
    h.engine.start();
    await settle(0);
    await h.engine.flush();

    // WP_A and WP_B are legs of the route: represented by the route alone.
    expect(h.store.ids('waypoints')).toHaveLength(1);
    expect(h.store.ids('routes')).toHaveLength(1);
    expect(h.deltas.filter((d) => d.value !== null)).toHaveLength(2);

    expect(Object.values(h.store.list('waypoints'))[0]!.name).toBe('VUDA');
    const route = Object.values(h.store.list('routes'))[0]!;
    expect(route.name).toBe('SAVUSAVU 2 NANAK');
    expect((route as RouteResource).feature.geometry.coordinates).toHaveLength(2);
    await h.engine.stop();
  });

  it('republishes former route legs once the MFD deletes the route', async () => {
    const h = harness();
    h.engine.start();
    await settle(0);
    await h.engine.flush();

    h.mfd.buf = buildUsr({ waypoints: [WP_A, WP_B, WP_C], routes: [] });
    await settle(60_000);
    await h.engine.flush();

    expect(h.store.ids('routes')).toHaveLength(0);
    const names = Object.values(h.store.list('waypoints')).map((w) => w.name);
    expect(names.sort()).toEqual(['NANAK', 'SAVUSAVU', 'VUDA']);
    await h.engine.stop();
  });

  it('unpublishes a waypoint once the MFD makes it a route leg', async () => {
    const h = harness();
    h.engine.start();
    await settle(0);
    await h.engine.flush();
    const id = h.store.ids('waypoints')[0]!;

    h.mfd.buf = buildUsr({
      waypoints: [WP_A, WP_B, WP_C],
      routes: [{ ...ROUTE, legUuids: [WP_A.uuid, WP_B.uuid, WP_C.uuid] }],
    });
    await settle(60_000);
    await h.engine.flush();

    expect(h.store.ids('waypoints')).toHaveLength(0);
    expect(h.deltas.filter((d) => d.value === null).map((d) => d.id)).toContain(id);
    await h.engine.stop();
  });

  it('never publishes waypoints marked suppressed (synthesized route legs)', async () => {
    const h = harness();
    h.idMap.markSuppressed(WP_C.uuid, 'waypoints');
    h.engine.start();
    await settle(0);
    await h.engine.flush();

    expect(h.store.ids('waypoints')).toHaveLength(0);
    expect(h.store.ids('routes')).toHaveLength(1);
    await h.engine.stop();
  });

  it('emits no deltas when a poll reflects unchanged content', async () => {
    const h = harness();
    h.engine.start();
    await settle(0);
    await h.engine.flush();
    const count = h.deltas.length;

    await settle(60_000); // next poll, same file
    await h.engine.flush();
    expect(h.deltas.length).toBe(count);
    await h.engine.stop();
  });

  it('mirrors edits and deletions from the MFD', async () => {
    const h = harness();
    h.mfd.buf = buildUsr({ waypoints: [WP_A, WP_C], routes: [] });
    h.engine.start();
    await settle(0);
    await h.engine.flush();
    const wpIds = h.store.ids('waypoints');
    expect(wpIds).toHaveLength(2);

    // MFD: waypoint A renamed, waypoint C deleted.
    h.mfd.buf = buildUsr({ waypoints: [{ ...WP_A, name: 'RENAMED' }], routes: [] });
    await settle(60_000);
    await h.engine.flush();

    expect(h.store.ids('waypoints')).toHaveLength(1);
    const kept = Object.values(h.store.list('waypoints'))[0]!;
    expect(kept.name).toBe('RENAMED');
    const deletions = h.deltas.filter((d) => d.value === null);
    expect(deletions).toHaveLength(1);
    expect(wpIds).toContain(deletions[0]!.id);
    await h.engine.stop();
  });

  it('keeps previous state on download failure', async () => {
    const h = harness();
    h.engine.start();
    await settle(0);
    await h.engine.flush();

    h.client.download.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    await settle(60_000);
    await h.engine.flush();
    expect(h.store.ids('waypoints')).toHaveLength(1);
    expect(h.store.ids('routes')).toHaveLength(1);
    expect(h.errors.some((e) => e.includes('ECONNREFUSED'))).toBe(true);
    await h.engine.stop();
  });

  it('keeps previous state on malformed download', async () => {
    const h = harness();
    h.engine.start();
    await settle(0);
    await h.engine.flush();

    h.mfd.buf = Buffer.from('this is not a usr file at all............');
    await settle(60_000);
    await h.engine.flush();
    expect(h.store.ids('waypoints')).toHaveLength(1);
    expect(h.store.ids('routes')).toHaveLength(1);

    // Recovery: valid file again, still consistent.
    h.mfd.buf = buildUsr({ waypoints: [WP_A, WP_C], routes: [] });
    await settle(60_000);
    await h.engine.flush();
    expect(h.store.ids('waypoints')).toHaveLength(2);
    expect(h.store.ids('routes')).toHaveLength(0);
    await h.engine.stop();
  });

  it('syncRoutes=false: publishes no routes, still publishes waypoints', async () => {
    const h = harness({ syncRoutes: false });
    h.engine.start();
    await settle(0);
    await h.engine.flush();

    expect(h.store.ids('routes')).toHaveLength(0);
    // Route legs stay unpublished: the route still exists on the MFD.
    expect(Object.values(h.store.list('waypoints')).map((w) => w.name)).toEqual(['VUDA']);
    await h.engine.stop();
  });

  it('syncWaypoints=false: publishes no waypoints, still publishes routes', async () => {
    const h = harness({ syncWaypoints: false });
    h.engine.start();
    await settle(0);
    await h.engine.flush();

    expect(h.store.ids('waypoints')).toHaveLength(0);
    expect(h.store.ids('routes')).toHaveLength(1);
    await h.engine.stop();
  });

  it('syncVisibleRoutesOnly=true: skips routes hidden on the MFD', async () => {
    const h = harness();
    h.mfd.buf = buildUsr({
      waypoints: [WP_A, WP_B, WP_C],
      routes: [{ ...ROUTE, visible: 0 }],
    });
    h.engine.start();
    await settle(0);
    await h.engine.flush();
    expect(h.store.ids('routes')).toHaveLength(0);
    // Hidden-route legs stay unpublished too.
    expect(Object.values(h.store.list('waypoints')).map((w) => w.name)).toEqual(['VUDA']);

    // Route made visible on the MFD → published on the next poll.
    h.mfd.buf = buildUsr({ waypoints: [WP_A, WP_B, WP_C], routes: [ROUTE] });
    await settle(60_000);
    await h.engine.flush();
    expect(h.store.ids('routes')).toHaveLength(1);

    // Hidden again → unpublished.
    h.mfd.buf = buildUsr({
      waypoints: [WP_A, WP_B, WP_C],
      routes: [{ ...ROUTE, visible: 0 }],
    });
    await settle(60_000);
    await h.engine.flush();
    expect(h.store.ids('routes')).toHaveLength(0);
    await h.engine.stop();
  });

  it('syncVisibleRoutesOnly=false: publishes hidden routes too', async () => {
    const h = harness({ syncVisibleRoutesOnly: false });
    h.mfd.buf = buildUsr({
      waypoints: [WP_A, WP_B, WP_C],
      routes: [{ ...ROUTE, visible: 0 }],
    });
    h.engine.start();
    await settle(0);
    await h.engine.flush();

    expect(h.store.ids('routes')).toHaveLength(1);
    const route = Object.values(h.store.list('routes'))[0] as RouteResource;
    expect(route.feature.properties.visible).toBe(false);
    await h.engine.stop();
  });

  it('syncFromMfd=false: no polls happen', async () => {
    const h = harness({ syncFromMfd: false });
    h.engine.start();
    await settle(600_000);
    await h.engine.flush();
    expect(h.client.download).not.toHaveBeenCalled();
    await h.engine.stop();
  });

  it('pollIntervalSeconds=0: no automatic polls, but the cache still serves', async () => {
    const h = harness({ pollIntervalSeconds: 0 }, buildUsr({ waypoints: [WP_A], routes: [] }));
    h.engine.start();
    await settle(600_000);
    await h.engine.flush();

    expect(h.client.download).not.toHaveBeenCalled();
    expect(Object.values(h.store.list('waypoints'))[0]!.name).toBe('SAVUSAVU');
    await h.engine.stop();
  });

  it('pollIntervalSeconds=0: syncNow still works and starts no poll loop', async () => {
    const h = harness({ pollIntervalSeconds: 0 });
    h.engine.start();
    await settle(600_000);
    expect(h.client.download).not.toHaveBeenCalled();

    const counts = await h.engine.syncNow();
    expect(counts).toEqual({ waypoints: 1, routes: 1 });
    await settle(600_000);
    expect(h.client.download).toHaveBeenCalledTimes(1);
    await h.engine.stop();
  });
});

describe('startup sync cache', () => {
  it('serves cached content immediately when the MFD is unreachable', async () => {
    const h = harness({}, buildUsr({ waypoints: [WP_A], routes: [] }));
    h.client.download.mockRejectedValue(new Error('ECONNREFUSED'));
    h.engine.start();
    await settle(0);
    await h.engine.flush();

    expect(h.store.ids('waypoints')).toHaveLength(1);
    expect(Object.values(h.store.list('waypoints'))[0]!.name).toBe('SAVUSAVU');
    await h.engine.stop();
  });

  it('lets the first successful poll correct stale cached content', async () => {
    // Cache: only waypoint A. MFD: A, B, C and the route.
    const h = harness({}, buildUsr({ waypoints: [WP_A], routes: [] }));
    h.engine.start();
    await settle(0);
    await h.engine.flush();

    expect(Object.values(h.store.list('waypoints')).map((w) => w.name)).toEqual(['VUDA']);
    expect(h.store.ids('routes')).toHaveLength(1);
    await h.engine.stop();
  });

  it('ignores an unparseable cache and still syncs from the MFD', async () => {
    const h = harness({}, Buffer.from('this is not a usr file at all............'));
    h.engine.start();
    await settle(0);
    await h.engine.flush();

    expect(h.errors.some((e) => e.includes('sync cache'))).toBe(true);
    expect(h.store.ids('waypoints')).toHaveLength(1);
    expect(h.store.ids('routes')).toHaveLength(1);
    await h.engine.stop();
  });

  it('saves each successful download to the cache', async () => {
    const h = harness();
    expect(h.cached.buf).toBeUndefined();
    h.engine.start();
    await settle(0);
    await h.engine.flush();

    expect(h.cached.buf?.equals(h.mfd.buf)).toBe(true);
    await h.engine.stop();
  });
});

describe('manual operations (webapp)', () => {
  // A route as another SignalK provider would serve it.
  const FOREIGN_ROUTE: RouteResource = {
    name: 'PASSAGE',
    feature: {
      type: 'Feature',
      geometry: {
        type: 'LineString',
        coordinates: [
          [178.1, -17.1],
          [178.2, -17.2],
          [178.3, -17.15],
        ],
      },
      properties: {},
    },
  };

  it('syncNow mirrors immediately and resolves with counts', async () => {
    const h = harness({ syncFromMfd: false });
    h.engine.start();
    await settle(1000);
    expect(h.client.download).not.toHaveBeenCalled();

    const counts = await h.engine.syncNow();
    expect(counts).toEqual({ waypoints: 1, routes: 1 });
    expect(h.store.ids('routes')).toHaveLength(1);
    // Periodic sync is off: the manual sync must not start a poll loop.
    await settle(600_000);
    expect(h.client.download).toHaveBeenCalledTimes(1);
    await h.engine.stop();
  });

  it('syncNow rejects when the MFD is unreachable', async () => {
    const h = harness();
    h.client.download.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    await expect(h.engine.syncNow()).rejects.toThrow('ECONNREFUSED');
    await h.engine.stop();
  });

  it('downloadNow returns the raw USR file and mirrors it', async () => {
    const h = harness();
    const buf = await h.engine.downloadNow();
    expect(buf.equals(h.mfd.buf)).toBe(true);
    expect(h.store.ids('routes')).toHaveLength(1);
    await h.engine.stop();
  });

  it('backupNow serves the last good download without contacting the MFD', async () => {
    const h = harness();
    const downloaded = await h.engine.downloadNow();
    h.mfd.buf = buildUsr({ waypoints: [WP_C], routes: [] });

    const buf = await h.engine.backupNow();
    expect(buf.equals(downloaded)).toBe(true);
    expect(h.client.download).toHaveBeenCalledTimes(1);
    await h.engine.stop();
  });

  it('backupNow serves the startup cache before the first poll', async () => {
    const cached = buildUsr({ waypoints: [WP_C], routes: [] });
    const h = harness({}, cached);
    h.engine.start();
    await h.engine.flush();

    const buf = await h.engine.backupNow();
    expect(buf.equals(cached)).toBe(true);
    expect(h.client.download).not.toHaveBeenCalled();
    await h.engine.stop();
  });

  it('backupNow downloads from the MFD when nothing is cached', async () => {
    const h = harness({ syncFromMfd: false });
    const buf = await h.engine.backupNow();
    expect(buf.equals(h.mfd.buf)).toBe(true);
    expect(h.client.download).toHaveBeenCalledTimes(1);
    await h.engine.stop();
  });

  it('buildUsr emits exactly the selected routes, with stable identity', async () => {
    const h = harness();
    const routes = new Map([['sk-route-1', FOREIGN_ROUTE]]);

    const built = h.engine.buildUsr(routes);
    const db = parseUsr(built.bytes);
    expect(db.routes).toHaveLength(1);
    expect(db.routes[0]!.name).toBe('PASSAGE');
    // Loose vertices become synthesized leg waypoints referenced by the route.
    expect(db.waypoints).toHaveLength(3);
    expect(db.routes[0]!.legUuids).toEqual(db.waypoints.map((w) => w.uuid));

    // Rebuilding references the same uuids instead of minting new records.
    const again = parseUsr(h.engine.buildUsr(routes).bytes);
    expect(again.routes[0]!.uuid).toBe(db.routes[0]!.uuid);
    expect(again.waypoints.map((w) => w.uuid)).toEqual(db.waypoints.map((w) => w.uuid));
    await h.engine.stop();
  });

  it('buildUsr reports adjusted names', async () => {
    const h = harness();
    const longName = 'A ROUTE NAME FAR TOO LONG FOR ANY NAVICO DISPLAY';
    const routes = new Map([['sk-route-1', { ...FOREIGN_ROUTE, name: longName }]]);
    const built = h.engine.buildUsr(routes);
    expect(built.nameAdjustments.some((a) => a.original === longName)).toBe(true);
    await h.engine.stop();
  });

  it('uploadToMfd uploads directly and suppresses the mirrored copy', async () => {
    const h = harness();
    h.engine.start();
    await settle(0);
    await h.engine.flush();
    expect(h.store.ids('routes')).toHaveLength(1);
    expect(h.store.ids('waypoints')).toHaveLength(1);
    const downloadsBefore = h.client.download.mock.calls.length;

    // The MFD merges uploads additively into its database.
    h.client.upload.mockImplementation(async (buf: Buffer) => {
      h.uploads.push(buf);
      const current = parseUsr(h.mfd.buf);
      const added = parseUsr(buf);
      const have = new Set(current.waypoints.map((w) => w.uuid));
      h.mfd.buf = serializeUsr({
        ...current,
        waypoints: [...current.waypoints, ...added.waypoints.filter((w) => !have.has(w.uuid))],
        routes: [...current.routes, ...added.routes],
      });
    });

    const result = await h.engine.uploadToMfd(new Map([['sk-route-1', FOREIGN_ROUTE]]));
    expect(result.routes).toBe(1);
    expect(h.uploads).toHaveLength(1);
    // Uploads are additive and we already know what we sent: no download
    // happens before or after the upload.
    expect(h.client.download.mock.calls.length).toBe(downloadsBefore);

    // The next regular poll sees the pushed route on the MFD but leaves it
    // to its owning provider: no duplicate appears in our store.
    await settle(CONFIG.pollIntervalSeconds * 1000);
    await h.engine.flush();
    expect(parseUsr(h.mfd.buf).routes).toHaveLength(2);
    expect(h.store.ids('routes')).toHaveLength(1);
    expect(Object.values(h.store.list('routes'))[0]!.name).toBe('SAVUSAVU 2 NANAK');
    expect(h.store.ids('waypoints')).toHaveLength(1);
    await h.engine.stop();
  });

  it('uploadToMfd rejects when the upload fails', async () => {
    const h = harness();
    h.client.upload.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    await expect(h.engine.uploadToMfd(new Map([['sk-route-1', FOREIGN_ROUTE]]))).rejects.toThrow(
      'ECONNREFUSED',
    );
    expect(h.client.download).not.toHaveBeenCalled();
    await h.engine.stop();
  });
});

describe('uiState', () => {
  it('reflects the config flags and records the last successful sync', async () => {
    const h = harness({ syncWaypoints: false });
    expect(h.engine.uiState()).toEqual({
      sync: {
        syncFromMfd: true,
        syncRoutes: true,
        syncVisibleRoutesOnly: true,
        syncWaypoints: false,
      },
      lastSync: null,
    });

    h.engine.start();
    await settle(0);
    await h.engine.flush();
    expect(h.engine.uiState().lastSync).toBe(new Date().toISOString());
    await h.engine.stop();
  });

  it('does not count a cache load as a sync', async () => {
    const cached = buildUsr({ waypoints: [WP_C], routes: [] });
    const h = harness({}, cached);
    // Downloads fail: only the cache load succeeds.
    h.client.download.mockRejectedValue(new Error('ECONNREFUSED'));
    h.engine.start();
    await settle(0);
    await h.engine.flush();
    expect(h.store.ids('waypoints')).toHaveLength(1);
    expect(h.engine.uiState().lastSync).toBeNull();
    await h.engine.stop();
  });
});
