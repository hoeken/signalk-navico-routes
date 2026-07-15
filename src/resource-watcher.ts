/**
 * Watches the server's delta stream for `resources.routes.*` and
 * `resources.waypoints.*` so changes made through *other* resource
 * providers are seen in real time (writes addressed to our provider hit
 * the provider callbacks instead; only foreign changes matter here).
 *
 * Echo suppression (belt and suspenders — delta provenance may not
 * identify the provider):
 *  1. deltas for ids owned by our store whose canonical content matches
 *     what we already hold are our own echoes → dropped;
 *  2. null-value deltas for ids we know as our own are our deletion
 *     echoes → dropped;
 *  3. everything else is a genuinely foreign change → marked dirty.
 */

import { canonicalize, validateResource } from './mapper';
import type { Delta, Logger, Resource, ResourceType } from './types';

const PATH_RE = /^resources\.(routes|waypoints)\.(.+)$/;

export interface ResourceWatcherDeps {
  store: {
    owns(id: string): boolean;
    get(type: ResourceType, id: string): Resource | undefined;
  };
  idMap: { isForeign(id: string): boolean; get(id: string): unknown };
  markForeignDirty(type: ResourceType, id: string): void;
  log: Logger;
}

export class ResourceWatcher {
  constructor(private readonly deps: ResourceWatcherDeps) {}

  /** Handle one delta from the server stream. */
  readonly onDelta = (delta: Delta): void => {
    for (const update of delta.updates ?? []) {
      for (const { path, value } of update.values ?? []) {
        const match = PATH_RE.exec(path);
        if (!match) {
          continue;
        }
        const type = match[1] as ResourceType;
        const id = match[2]!;
        this.handle(type, id, value);
      }
    }
  };

  private handle(type: ResourceType, id: string, value: unknown): void {
    if (value === null || value === undefined) {
      // Deletion. Ours (mirror or provider) → echo; foreign → dirty;
      // unknown id → nothing to do (it was never in our upload set).
      if (this.deps.idMap.isForeign(id)) {
        this.deps.log.debug(`foreign ${type} ${id} deleted`);
        this.deps.markForeignDirty(type, id);
      }
      return;
    }

    if (this.deps.store.owns(id)) {
      const held = this.deps.store.get(type, id);
      if (
        held &&
        validateResource(type, value) === null &&
        canonicalize(type, value as Resource) === canonicalize(type, held)
      ) {
        return; // echo of our own store's write
      }
      // Content differs from what we hold: still our id, so a competing
      // write through the server landed on our provider; the provider
      // callback is the authoritative channel for that. Drop here.
      return;
    }

    if (validateResource(type, value) !== null) {
      this.deps.log.debug(`ignoring malformed ${type} delta for ${id}`);
      return;
    }

    this.deps.log.debug(`foreign ${type} ${id} changed`);
    this.deps.markForeignDirty(type, id);
  }
}
