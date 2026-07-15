import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IdMap } from '../src/id-map';
import { ResourceStore } from '../src/resource-store';
import { SyncEngine, SyncEngineConfig } from '../src/sync-engine';
import { latDegToMm, lonDegToMm } from '../src/usr/mercator';
import type { Resource, ResourceType, RouteResource } from '../src/types';
import { buildUsr, synthUuid } from './helpers/build-usr';

const CONFIG: SyncEngineConfig = {
  syncFromMfd: true,
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

  const client = {
    download: vi.fn(async () => mfd.buf),
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

  return { engine, store, idMap, mfd, deltas, errors, client, cached };
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

  it('syncFromMfd=false: no polls happen', async () => {
    const h = harness({ syncFromMfd: false });
    h.engine.start();
    await settle(600_000);
    await h.engine.flush();
    expect(h.client.download).not.toHaveBeenCalled();
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
