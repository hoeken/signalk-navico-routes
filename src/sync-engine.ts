/**
 * SyncEngine: owns the poll timer and mirrors the MFD's user database into
 * SignalK, one way (MFD → SignalK). The file is the truth: every poll
 * replaces the published resources with the file's content, including
 * deletions.
 *
 * SignalK → MFD transfer is deliberately NOT automatic. Uploading a USR
 * file only *adds* records on the MFD (it neither overwrites nor deletes
 * existing ones), so a bidirectional mirror cannot converge. Uploads are a
 * manual, user-driven operation instead (web app, planned); the building
 * blocks — buildUsrDatabase, serializeUsr, MfdClient.upload — live in
 * mapper.ts, usr/codec.ts and mfd-client.ts.
 */

import { usrRouteToResource, usrWaypointToResource } from './mapper';
import { parseUsr } from './usr/codec';
import type { UsrDatabase } from './usr/model';
import type { IdMap } from './id-map';
import type { ResourceStore } from './resource-store';
import type { Logger, Resource, ResourceType } from './types';

const RESOURCE_TYPES: ResourceType[] = ['waypoints', 'routes'];

export interface SyncEngineConfig {
  syncFromMfd: boolean;
  pollIntervalSeconds: number;
}

export interface SyncEngineDeps {
  client: {
    download(): Promise<Buffer>;
  };
  store: ResourceStore;
  idMap: IdMap;
  /** Last-good-download cache, served on start before the first poll. */
  cache: { load(): Promise<Buffer | undefined>; save(usr: Buffer): Promise<void> };
  /** Emit a SignalK resource delta (value null = deleted). */
  emitDelta(type: ResourceType, id: string, value: Resource | null): void;
  log: Logger;
  setStatus(msg: string): void;
  setError(msg: string): void;
}

export class SyncEngine {
  private chain: Promise<void> = Promise.resolve();
  private pollTimer?: NodeJS.Timeout;
  private stopped = false;
  private mfdUnreachable = false;

  constructor(
    private readonly config: SyncEngineConfig,
    private readonly deps: SyncEngineDeps,
  ) {}

  start(): void {
    this.stopped = false;
    if (this.config.syncFromMfd) {
      // Enqueued before the first poll: the provider serves the last good
      // sync immediately, and the poll then corrects any drift.
      void this.enqueue(() => this.loadFromCache());
      this.schedulePoll(0);
    }
  }

  stop(): Promise<void> {
    this.stopped = true;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = undefined;
    }
    return this.flush();
  }

  /** Wait for any in-flight MFD operation to finish (test/shutdown hook). */
  flush(): Promise<void> {
    return this.chain;
  }

  // ── MFD → SignalK (poll + mirror) ────────────────────────────────────────

  private schedulePoll(delayMs: number): void {
    if (this.stopped) {
      return;
    }
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
    }
    this.pollTimer = setTimeout(() => {
      this.pollTimer = undefined;
      void this.runPoll();
    }, delayMs);
  }

  /** Mirror the cached last-good download, if any, so startup is instant. */
  private async loadFromCache(): Promise<void> {
    let buf: Buffer | undefined;
    try {
      buf = await this.deps.cache.load();
    } catch (err) {
      this.deps.log.error(`could not read sync cache: ${String(err)}`);
      return;
    }
    if (!buf || this.stopped) {
      return;
    }
    try {
      const db = parseUsr(buf);
      const counts = this.mirror(db);
      this.deps.setStatus(
        `serving ${counts.waypoints} waypoints, ${counts.routes} routes from cache; waiting for MFD sync`,
      );
    } catch (err) {
      this.deps.log.error(`ignoring unparseable sync cache: ${String(err)}`);
    }
  }

  private async saveToCache(buf: Buffer): Promise<void> {
    try {
      await this.deps.cache.save(buf);
    } catch (err) {
      this.deps.log.error(`could not write sync cache: ${String(err)}`);
    }
  }

  private runPoll(): Promise<void> {
    return this.enqueue(async () => {
      try {
        const buf = await this.deps.client.download();
        const db = parseUsr(buf);
        this.reportReachable();
        await this.saveToCache(buf);
        const counts = this.mirror(db);
        this.deps.setStatus(
          `synced ${counts.waypoints} waypoints, ${counts.routes} routes from MFD`,
        );
      } catch (err) {
        // Failed or malformed download: keep serving the previous state.
        this.reportUnreachable('download', err);
      } finally {
        if (!this.stopped) {
          this.schedulePoll(this.config.pollIntervalSeconds * 1000);
        }
      }
    });
  }

  /**
   * Full-mirror semantics: the file is the truth.
   * Returns the number of resources mirrored per type.
   */
  private mirror(db: UsrDatabase): { waypoints: number; routes: number } {
    const waypointsByUuid = new Map(db.waypoints.map((w) => [w.uuid, w]));
    // The MFD builds routes out of waypoint records; SignalK routes carry
    // their own geometry. A waypoint serving as a route leg is represented
    // by the route's LineString alone — only free-standing waypoints are
    // published as SignalK waypoints.
    const legUuids = new Set<string>(db.routes.flatMap((rt) => rt.legUuids));
    const counts = { waypoints: 0, routes: 0 };

    for (const type of RESOURCE_TYPES) {
      const fileContent = new Map<string, Resource>();
      if (type === 'waypoints') {
        for (const wp of db.waypoints) {
          if (legUuids.has(wp.uuid)) {
            continue; // route leg, represented by the route resource
          }
          if (this.deps.idMap.isSuppressedUuid(wp.uuid)) {
            continue; // synthesized route-leg waypoint, not a standalone resource
          }
          const id = this.deps.idMap.idForUuid(wp.uuid, 'waypoints');
          fileContent.set(id, usrWaypointToResource(wp));
        }
      } else {
        for (const rt of db.routes) {
          const id = this.deps.idMap.idForUuid(rt.uuid, 'routes');
          try {
            fileContent.set(id, usrRouteToResource(rt, waypointsByUuid));
          } catch (err) {
            this.deps.log.error(`skipping route '${rt.name}': ${String(err)}`);
          }
        }
      }

      // Create/overwrite from the file.
      for (const [id, resource] of fileContent) {
        if (this.deps.store.set(type, id, resource)) {
          this.deps.emitDelta(type, id, resource);
        }
      }

      // Full-mirror deletion: gone from the file → gone from SignalK.
      for (const id of this.deps.store.ids(type)) {
        if (!fileContent.has(id)) {
          this.deps.store.delete(type, id);
          this.deps.emitDelta(type, id, null);
        }
      }

      counts[type] = fileContent.size;
    }
    return counts;
  }

  // ── Plumbing ─────────────────────────────────────────────────────────────

  /** MFD operations are serialized: polls never overlap. */
  private enqueue(fn: () => Promise<void>): Promise<void> {
    const next = this.chain.then(fn, fn);
    this.chain = next.catch((err) => {
      this.deps.log.error(`internal sync error: ${String(err)}`);
    });
    return this.chain;
  }

  private reportReachable(): void {
    if (this.mfdUnreachable) {
      this.mfdUnreachable = false;
      this.deps.log.debug('MFD reachable again');
    }
  }

  private reportUnreachable(operation: string, err: unknown): void {
    const msg = `MFD ${operation} failed: ${err instanceof Error ? err.message : String(err)}`;
    // Log at error once, then debug on repeats; resume silently on recovery.
    if (!this.mfdUnreachable) {
      this.mfdUnreachable = true;
      this.deps.log.error(msg);
    } else {
      this.deps.log.debug(msg);
    }
    this.deps.setError(msg);
  }
}
