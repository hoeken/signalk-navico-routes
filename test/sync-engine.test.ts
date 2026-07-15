import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IdMap } from '../src/id-map';
import { ResourceStore } from '../src/resource-store';
import { SyncEngine, SyncEngineConfig } from '../src/sync-engine';
import { parseUsr } from '../src/usr/codec';
import { latDegToMm, lonDegToMm } from '../src/usr/mercator';
import type { Resource, ResourceType, WaypointResource } from '../src/types';
import { buildUsr, synthUuid } from './helpers/build-usr';

const CONFIG: SyncEngineConfig = {
  syncFromMfd: true,
  syncToMfd: true,
  pollIntervalSeconds: 60,
  uploadQuietSeconds: 10,
  uploadMinIntervalSeconds: 60,
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

function makeWaypoint(name: string, lon: number, lat: number): WaypointResource {
  return {
    name,
    feature: {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [lon, lat] },
      properties: {},
    },
  };
}

function harness(configOverrides: Partial<SyncEngineConfig> = {}, cachedUsr?: Buffer) {
  const store = new ResourceStore();
  const idMap = new IdMap();
  const mfd = { buf: buildUsr({ waypoints: [WP_A, WP_B], routes: [ROUTE] }) };
  const cached = { buf: cachedUsr };
  const uploads: Buffer[] = [];
  const deltas: { type: ResourceType; id: string; value: Resource | null }[] = [];
  const archived: Buffer[] = [];
  const errors: string[] = [];
  const foreign = { routes: new Map<string, Resource>(), waypoints: new Map<string, Resource>() };

  const client = {
    download: vi.fn(async () => mfd.buf),
    upload: vi.fn(async (buf: Buffer) => {
      uploads.push(buf);
      mfd.buf = buf; // the MFD now serves what we uploaded
    }),
  };

  const engine = new SyncEngine(
    { ...CONFIG, ...configOverrides },
    {
      client,
      store,
      idMap,
      archive: {
        archive: async (buf: Buffer) => {
          archived.push(buf);
          return '/tmp/fake';
        },
      },
      cache: {
        load: async () => cached.buf,
        save: async (buf: Buffer) => {
          cached.buf = buf;
        },
      },
      emitDelta: (type, id, value) => deltas.push({ type, id, value }),
      listAllResources: async (type) => {
        // Server view: everything in our store plus foreign resources.
        const all = new Map<string, Resource>(Object.entries(store.list(type)));
        for (const [id, res] of foreign[type]) {
          all.set(id, res);
        }
        return all;
      },
      log: { debug: () => undefined, error: (msg) => errors.push(msg) },
      setStatus: () => undefined,
      setError: () => undefined,
    },
  );

  return { engine, store, idMap, mfd, uploads, deltas, archived, errors, client, foreign, cached };
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

    expect(h.store.ids('waypoints')).toHaveLength(2);
    expect(h.store.ids('routes')).toHaveLength(1);
    expect(h.deltas.filter((d) => d.value !== null)).toHaveLength(3);

    const route = Object.values(h.store.list('routes'))[0]!;
    expect(route.name).toBe('SAVUSAVU 2 NANAK');
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
    h.engine.start();
    await settle(0);
    await h.engine.flush();
    const wpIds = h.store.ids('waypoints');

    // MFD: waypoint A renamed, waypoint B deleted (route now only refs A).
    h.mfd.buf = buildUsr({
      waypoints: [{ ...WP_A, name: 'RENAMED' }],
      routes: [{ ...ROUTE, legUuids: [WP_A.uuid] }],
    });
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
    expect(h.store.ids('waypoints')).toHaveLength(2);
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
    expect(h.store.ids('waypoints')).toHaveLength(2);

    // Recovery: valid file again, still consistent.
    h.mfd.buf = buildUsr({ waypoints: [WP_A], routes: [] });
    await settle(60_000);
    await h.engine.flush();
    expect(h.store.ids('waypoints')).toHaveLength(1);
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
    // Cache: only waypoint A. MFD: A, B and the route.
    const h = harness({}, buildUsr({ waypoints: [WP_A], routes: [] }));
    h.engine.start();
    await settle(0);
    await h.engine.flush();

    expect(h.store.ids('waypoints')).toHaveLength(2);
    expect(h.store.ids('routes')).toHaveLength(1);
    await h.engine.stop();
  });

  it('ignores an unparseable cache and still syncs from the MFD', async () => {
    const h = harness({}, Buffer.from('this is not a usr file at all............'));
    h.engine.start();
    await settle(0);
    await h.engine.flush();

    expect(h.errors.some((e) => e.includes('sync cache'))).toBe(true);
    expect(h.store.ids('waypoints')).toHaveLength(2);
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

describe('SignalK → MFD upload throttle', () => {
  it('coalesces a burst of edits into exactly one upload', async () => {
    const h = harness();
    h.engine.start();
    await settle(0);
    await h.engine.flush();

    for (let i = 0; i < 50; i++) {
      h.engine.localSet('waypoints', `new-wp-${i % 5}`, makeWaypoint(`WP${i % 5}`, 10 + i, 20));
      await settle(100); // edits 100 ms apart, well inside the quiet window
    }
    expect(h.uploads).toHaveLength(0); // still debouncing

    await settle(10_000); // quiet period elapses
    await h.engine.flush();
    expect(h.uploads).toHaveLength(1);

    const uploaded = parseUsr(h.uploads[0]!);
    expect(uploaded.waypoints.map((w) => w.name)).toEqual(
      expect.arrayContaining(['WP0', 'WP4', 'SAVUSAVU', 'NANAK']),
    );
    await h.engine.stop();
  });

  it('enforces the rate floor under sustained edits without losing changes', async () => {
    const h = harness({ pollIntervalSeconds: 3600 }); // isolate from polls
    h.engine.start();
    await settle(0);
    await h.engine.flush();

    // A new edit every 5 s for 5 minutes: quiet window (10 s) never elapses
    // between them, but the floor (60 s) must not be exceeded either.
    for (let i = 0; i < 60; i++) {
      h.engine.localSet('waypoints', 'busy-wp', makeWaypoint('BUSY', 10 + i * 0.01, 20));
      await settle(5_000);
      await h.engine.flush();
    }
    await settle(70_000);
    await h.engine.flush();

    expect(h.uploads.length).toBeGreaterThanOrEqual(2);
    expect(h.uploads.length).toBeLessThanOrEqual(7); // ≈ 300s/60s + first + final
    // Nothing lost: the last upload carries the final position.
    const last = parseUsr(h.uploads[h.uploads.length - 1]!);
    const busy = last.waypoints.find((w) => w.name === 'BUSY')!;
    expect(busy.lonMm).toBe(lonDegToMm(10 + 59 * 0.01));
    await h.engine.stop();
  });

  it('archives a fresh download before every upload', async () => {
    const h = harness();
    h.engine.start();
    await settle(0);
    await h.engine.flush();

    h.engine.localSet('waypoints', 'wp-new', makeWaypoint('NEW', 11, 22));
    await settle(10_000);
    await h.engine.flush();

    expect(h.uploads).toHaveLength(1);
    expect(h.archived).toHaveLength(1);
    // The archive is the pre-upload MFD state, not our upload.
    expect(parseUsr(h.archived[0]!).waypoints.map((w) => w.name)).not.toContain('NEW');
    await h.engine.stop();
  });

  it('skips record-identical uploads (they would only erase trails)', async () => {
    const h = harness();
    h.engine.start();
    await settle(0);
    await h.engine.flush();

    // Rewrite an existing waypoint with identical content.
    const id = h.store.ids('waypoints')[0]!;
    h.engine.localSet('waypoints', id, h.store.get('waypoints', id) as WaypointResource);
    await settle(10_000);
    await h.engine.flush();

    expect(h.uploads).toHaveLength(0);
    expect(h.engine.hasPendingEdits()).toBe(false);
    await h.engine.stop();
  });

  it('retries a failed upload with backoff', async () => {
    const h = harness({ pollIntervalSeconds: 3600 });
    h.engine.start();
    await settle(0);
    await h.engine.flush();

    h.client.upload.mockRejectedValueOnce(new Error('boom'));
    h.engine.localSet('waypoints', 'wp-new', makeWaypoint('NEW', 11, 22));
    await settle(10_000);
    await h.engine.flush();
    expect(h.uploads).toHaveLength(0); // first attempt failed

    await settle(70_000); // backoff + floor
    await h.engine.flush();
    expect(h.uploads).toHaveLength(1);
    expect(parseUsr(h.uploads[0]!).waypoints.map((w) => w.name)).toContain('NEW');
    await h.engine.stop();
  });
});

describe('pending-edit protection and confirmation', () => {
  it('protects a pending edit from the mirror until confirmed, then resumes MFD-wins', async () => {
    const h = harness({ pollIntervalSeconds: 3600 });
    h.engine.start();
    await settle(0);
    await h.engine.flush();

    const id = h.store
      .ids('waypoints')
      .find((i) => h.store.get('waypoints', i)!.name === 'SAVUSAVU')!;
    h.engine.localSet('waypoints', id, makeWaypoint('EDITED', 100, 10));
    expect(h.engine.hasPendingEdits()).toBe(true);

    // A poll before the upload lands must not clobber the pending edit.
    await settle(1_000);
    // (manually poll by advancing to the huge poll interval is unwieldy;
    // the upload path itself downloads and mirrors — rely on that.)
    await settle(9_000); // upload fires at quiet=10 s
    await h.engine.flush();
    expect(h.uploads).toHaveLength(1);
    expect(h.store.get('waypoints', id)!.name).toBe('EDITED');

    // Confirmation poll was scheduled (5 s after upload).
    await settle(5_000);
    await h.engine.flush();
    expect(h.engine.hasPendingEdits()).toBe(false);

    // MFD-wins resumes: an MFD-side rename now overwrites.
    const parsed = parseUsr(h.mfd.buf);
    const edited = parsed.waypoints.find((w) => w.name === 'EDITED')!;
    h.mfd.buf = buildUsr({
      waypoints: [
        { uuid: edited.uuid, name: 'MFD-WINS', lonMm: edited.lonMm, latMm: edited.latMm },
      ],
      routes: [],
    });
    await settle(3_600_000);
    await h.engine.flush();
    expect(h.store.get('waypoints', id)!.name).toBe('MFD-WINS');
    await h.engine.stop();
  });

  it('protects a pending delete and confirms it once the MFD drops the record', async () => {
    const h = harness();
    h.engine.start();
    await settle(0);
    await h.engine.flush();

    const id = h.store.ids('waypoints').find((i) => h.store.get('waypoints', i)!.name === 'NANAK')!;
    h.engine.localDelete('waypoints', id);
    expect(h.store.owns(id)).toBe(false);

    // NANAK is still a leg of the route, so its record cannot leave the
    // file: the build is record-identical, the upload is skipped, and the
    // waypoint is demoted to a suppressed (hidden) leg record.
    await settle(10_000);
    await h.engine.flush();
    expect(h.uploads).toHaveLength(0);
    expect(h.engine.hasPendingEdits()).toBe(false);

    // It must never be resurrected by subsequent mirrors.
    await settle(180_000);
    await h.engine.flush();
    expect(h.store.owns(id)).toBe(false);
    expect(h.store.ids('waypoints')).toHaveLength(1);
    // The route itself is untouched.
    expect(h.store.ids('routes')).toHaveLength(1);
    await h.engine.stop();
  });

  it('deleting a route removes it from the MFD on the next upload', async () => {
    const h = harness();
    h.engine.start();
    await settle(0);
    await h.engine.flush();

    const id = h.store.ids('routes')[0]!;
    h.engine.localDelete('routes', id);
    await settle(10_000);
    await h.engine.flush();

    expect(h.uploads).toHaveLength(1);
    expect(parseUsr(h.uploads[0]!).routes).toHaveLength(0);
    await settle(5_000);
    await h.engine.flush();
    expect(h.engine.hasPendingEdits()).toBe(false);
    expect(h.store.ids('routes')).toHaveLength(0);
    await h.engine.stop();
  });
});

describe('loop prevention (the worst failure mode)', () => {
  it('download → no change → no upload; a full poll cycle schedules zero uploads', async () => {
    const h = harness();
    h.engine.start();
    // Many full poll cycles with no local changes.
    await settle(0);
    for (let i = 0; i < 10; i++) {
      await settle(60_000);
      await h.engine.flush();
    }
    expect(h.uploads).toHaveLength(0);
    expect(h.client.upload).not.toHaveBeenCalled();
    await h.engine.stop();
  });

  it('an upload’s own echo produces no deltas and no further upload', async () => {
    const h = harness();
    h.engine.start();
    await settle(0);
    await h.engine.flush();

    h.engine.localSet('waypoints', 'wp-new', makeWaypoint('NEW', 11, 22));
    await settle(10_000);
    await h.engine.flush();
    expect(h.uploads).toHaveLength(1);

    await settle(5_000); // confirmation poll sees our own upload
    await h.engine.flush();
    const deltaCount = h.deltas.length;

    // Ten more full cycles: nothing may change, nothing may upload.
    for (let i = 0; i < 10; i++) {
      await settle(60_000);
      await h.engine.flush();
    }
    expect(h.uploads).toHaveLength(1);
    expect(h.deltas.length).toBe(deltaCount);
    await h.engine.stop();
  });
});

describe('foreign resources', () => {
  it('includes foreign resources in uploads and never surfaces them from downloads', async () => {
    const h = harness();
    h.engine.start();
    await settle(0);
    await h.engine.flush();

    // Another provider owns this waypoint.
    h.foreign.waypoints.set('foreign-wp', makeWaypoint('FOREIGN', 150, -20));
    h.engine.markForeignDirty('waypoints', 'foreign-wp');
    await settle(10_000);
    await h.engine.flush();

    expect(h.uploads).toHaveLength(1);
    const uploaded = parseUsr(h.uploads[0]!);
    expect(uploaded.waypoints.map((w) => w.name)).toContain('FOREIGN');

    // The MFD now serves the foreign record back; it must not enter our store.
    const before = h.store.ids('waypoints').length;
    await settle(60_000);
    await h.engine.flush();
    expect(h.store.ids('waypoints')).toHaveLength(before);
    expect(h.store.owns('foreign-wp')).toBe(false);
    // And no repeat upload (echo suppressed).
    expect(h.uploads).toHaveLength(1);
    await h.engine.stop();
  });

  it('deleting a foreign resource removes it from the next upload', async () => {
    const h = harness();
    h.engine.start();
    await settle(0);
    await h.engine.flush();

    h.foreign.waypoints.set('foreign-wp', makeWaypoint('FOREIGN', 150, -20));
    h.engine.markForeignDirty('waypoints', 'foreign-wp');
    await settle(10_000);
    await h.engine.flush();
    expect(parseUsr(h.uploads[0]!).waypoints.map((w) => w.name)).toContain('FOREIGN');

    // Foreign provider deletes it.
    h.foreign.waypoints.delete('foreign-wp');
    h.engine.markForeignDirty('waypoints', 'foreign-wp');
    await settle(60_000); // floor
    await h.engine.flush();
    expect(h.uploads.length).toBe(2);
    expect(parseUsr(h.uploads[1]!).waypoints.map((w) => w.name)).not.toContain('FOREIGN');
    await h.engine.stop();
  });
});

describe('sync direction switches', () => {
  it('syncToMfd=false: provider writes work but are transient, with a warning', async () => {
    const h = harness({ syncToMfd: false });
    h.engine.start();
    await settle(0);
    await h.engine.flush();

    h.engine.localSet('waypoints', 'transient', makeWaypoint('TRANSIENT', 1, 2));
    expect(h.store.owns('transient')).toBe(true);
    expect(h.errors.some((e) => e.includes('memory only'))).toBe(true);

    await settle(120_000); // polls mirror it away
    await h.engine.flush();
    expect(h.store.owns('transient')).toBe(false);
    expect(h.uploads).toHaveLength(0);
    await h.engine.stop();
  });

  it('syncFromMfd=false: no polls happen', async () => {
    const h = harness({ syncFromMfd: false, syncToMfd: false });
    h.engine.start();
    await settle(600_000);
    await h.engine.flush();
    expect(h.client.download).not.toHaveBeenCalled();
    await h.engine.stop();
  });
});
