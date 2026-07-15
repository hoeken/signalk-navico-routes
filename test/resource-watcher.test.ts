import { describe, expect, it } from 'vitest';
import { IdMap } from '../src/id-map';
import { ResourceStore } from '../src/resource-store';
import { ResourceWatcher } from '../src/resource-watcher';
import type { Delta, ResourceType, WaypointResource } from '../src/types';

function makeWaypoint(name: string, lon = 10, lat = 20): WaypointResource {
  return {
    name,
    feature: {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [lon, lat] },
      properties: {},
    },
  };
}

function delta(path: string, value: unknown): Delta {
  return { updates: [{ values: [{ path, value }] }] };
}

function harness() {
  const store = new ResourceStore();
  const idMap = new IdMap();
  const dirty: string[] = [];
  const watcher = new ResourceWatcher({
    store,
    idMap,
    markForeignDirty: (type: ResourceType, id: string) => dirty.push(`${type}:${id}`),
    log: { debug: () => undefined, error: () => undefined },
  });
  return { store, idMap, dirty, watcher };
}

describe('ResourceWatcher', () => {
  it('marks genuinely foreign changes dirty', () => {
    const h = harness();
    h.watcher.onDelta(delta('resources.waypoints.foreign-1', makeWaypoint('F')));
    expect(h.dirty).toEqual(['waypoints:foreign-1']);
  });

  it('drops echoes of our own store writes (identical canonical content)', () => {
    const h = harness();
    h.store.set('waypoints', 'own-1', makeWaypoint('MINE'));
    // Same content, but with float noise below USR precision.
    const echoed = makeWaypoint('MINE', 10.0000000001, 20);
    h.watcher.onDelta(delta('resources.waypoints.own-1', echoed));
    expect(h.dirty).toEqual([]);
  });

  it('drops deltas for own ids even if content differs (provider callback is authoritative)', () => {
    const h = harness();
    h.store.set('waypoints', 'own-1', makeWaypoint('MINE'));
    h.watcher.onDelta(delta('resources.waypoints.own-1', makeWaypoint('CHANGED')));
    expect(h.dirty).toEqual([]);
  });

  it('marks foreign deletions dirty, ignores our own deletion echoes', () => {
    const h = harness();
    h.idMap.markForeign('foreign-1', 'routes');
    h.watcher.onDelta(delta('resources.routes.foreign-1', null));
    expect(h.dirty).toEqual(['routes:foreign-1']);

    // Our own (mirror) deletions: id known but not foreign.
    h.idMap.ensureUuid('own-2', 'waypoints');
    h.watcher.onDelta(delta('resources.waypoints.own-2', null));
    // Unknown ids: nothing to do either.
    h.watcher.onDelta(delta('resources.waypoints.never-seen', null));
    expect(h.dirty).toEqual(['routes:foreign-1']);
  });

  it('ignores non-resource paths and malformed values', () => {
    const h = harness();
    h.watcher.onDelta(delta('navigation.position', { latitude: 1, longitude: 2 }));
    h.watcher.onDelta(delta('resources.charts.some-id', { anything: true }));
    h.watcher.onDelta(delta('resources.waypoints.bad-1', { not: 'a waypoint' }));
    h.watcher.onDelta({ updates: [{}] });
    h.watcher.onDelta({});
    expect(h.dirty).toEqual([]);
  });

  it('a simulated full MFD poll cycle produces zero watcher-initiated uploads', () => {
    const h = harness();
    // Mirror applies MFD content to the store, then emits deltas; the
    // watcher sees exactly those deltas back from the server.
    const resources: [string, WaypointResource][] = [
      ['wp-1', makeWaypoint('A', 179.1, -16.1)],
      ['wp-2', makeWaypoint('B', 179.2, -16.2)],
      ['wp-3', makeWaypoint('C', 179.3, -16.3)],
    ];
    for (const [id, res] of resources) {
      h.store.set('waypoints', id, res);
    }
    for (const [id, res] of resources) {
      h.watcher.onDelta(delta(`resources.waypoints.${id}`, structuredClone(res)));
    }
    // Deletion mirror: store.delete happens before the delta is emitted.
    h.idMap.ensureUuid('wp-3', 'waypoints');
    h.store.delete('waypoints', 'wp-3');
    h.watcher.onDelta(delta('resources.waypoints.wp-3', null));

    expect(h.dirty).toEqual([]);
  });
});
