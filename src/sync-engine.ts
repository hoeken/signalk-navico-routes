/**
 * SyncEngine: owns the poll timer and mirrors the MFD's user database into
 * SignalK, one way (MFD → SignalK). The file is the truth: every poll
 * replaces the published resources with the file's content, including
 * deletions. A poll interval of 0 disables the timer entirely: the mirror
 * then only updates through the manual operations (syncNow, downloadNow).
 *
 * SignalK → MFD transfer is deliberately NOT automatic. Uploading a USR
 * file only *adds* records on the MFD (it neither overwrites nor deletes
 * existing ones), so a bidirectional mirror cannot converge. Uploads are a
 * manual, user-driven operation through the webapp: `uploadToMfd` pushes
 * the selected routes directly — additive uploads are safe, so no prior
 * sync or backup is needed — and suppresses their mirrored copies so the
 * round trip does not duplicate them in SignalK.
 *
 * All MFD I/O — polls and manual operations alike — runs through a single
 * promise chain, so operations never overlap.
 */

import { buildUsrDatabase, usrRouteToResource, usrWaypointToResource } from './mapper';
import { parseUsr, serializeUsr } from './usr/codec';
import type { UsrDatabase } from './usr/model';
import type { IdMap } from './id-map';
import type { ResourceStore } from './resource-store';
import type { Logger, Resource, ResourceType, RouteResource } from './types';

const RESOURCE_TYPES: ResourceType[] = ['waypoints', 'routes'];

export interface SyncEngineConfig {
  syncFromMfd: boolean;
  syncRoutes: boolean;
  syncVisibleRoutesOnly: boolean;
  syncWaypoints: boolean;
  /** Seconds between automatic polls; 0 disables automatic polling. */
  pollIntervalSeconds: number;
}

export interface SyncEngineDeps {
  client: {
    download(): Promise<Buffer>;
    upload(usr: Buffer): Promise<void>;
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

export interface SyncCounts {
  waypoints: number;
  routes: number;
}

export interface NameAdjustment {
  type: ResourceType;
  original: string;
  adjusted: string;
}

export interface BuiltUsr {
  bytes: Buffer;
  nameAdjustments: NameAdjustment[];
}

export interface UploadResult {
  /** Number of routes pushed to the MFD. */
  routes: number;
  nameAdjustments: NameAdjustment[];
}

/** Snapshot served to the webapp via GET /api/ui-config. */
export interface UiState {
  sync: {
    syncFromMfd: boolean;
    syncRoutes: boolean;
    syncVisibleRoutesOnly: boolean;
    syncWaypoints: boolean;
  };
  /** ISO-8601 time of the last successful MFD → SignalK sync, if any. */
  lastSync: string | null;
}

export class SyncEngine {
  private chain: Promise<void> = Promise.resolve();
  private pollTimer?: NodeJS.Timeout;
  private stopped = false;
  private mfdUnreachable = false;
  /** Most recent successfully parsed MFD database (download or cache). */
  private lastDb?: UsrDatabase;
  /** Raw bytes behind lastDb, served for cached backups. */
  private lastBuf?: Buffer;
  /** Time of the last successful download from the MFD (not cache loads). */
  private lastSyncAt?: Date;

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
      if (this.config.pollIntervalSeconds > 0) {
        this.schedulePoll(0);
      }
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

  /** Queue the next automatic poll, unless polling is disabled (interval 0). */
  private scheduleNextPoll(): void {
    if (this.config.pollIntervalSeconds > 0) {
      this.schedulePoll(this.config.pollIntervalSeconds * 1000);
    }
  }

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
      this.lastDb = db;
      this.lastBuf = buf;
      const counts = this.mirror(db);
      this.deps.setStatus(
        `serving ${counts.waypoints} waypoints, ${counts.routes} routes from cache` +
          (this.config.pollIntervalSeconds > 0
            ? '; waiting for MFD sync'
            : ' (automatic polling off)'),
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
        const { counts } = await this.pollOnce();
        this.deps.setStatus(
          `synced ${counts.waypoints} waypoints, ${counts.routes} routes from MFD`,
        );
      } catch (err) {
        // Failed or malformed download: keep serving the previous state.
        this.reportUnreachable(err);
      } finally {
        if (!this.stopped) {
          this.scheduleNextPoll();
        }
      }
    });
  }

  /**
   * One download + mirror cycle. Must run inside the operation chain.
   * Throws on an unreachable MFD or a malformed file (state untouched).
   */
  private async pollOnce(): Promise<{ buf: Buffer; counts: SyncCounts }> {
    const buf = await this.deps.client.download();
    const db = parseUsr(buf);
    this.reportReachable();
    await this.saveToCache(buf);
    this.lastDb = db;
    this.lastBuf = buf;
    this.lastSyncAt = new Date();
    return { buf, counts: this.mirror(db) };
  }

  /** Config flags and last-sync time, for the webapp's GET /api/ui-config. */
  uiState(): UiState {
    const { syncFromMfd, syncRoutes, syncVisibleRoutesOnly, syncWaypoints } = this.config;
    return {
      sync: { syncFromMfd, syncRoutes, syncVisibleRoutesOnly, syncWaypoints },
      lastSync: this.lastSyncAt ? this.lastSyncAt.toISOString() : null,
    };
  }

  // ── Manual operations (webapp API) ───────────────────────────────────────

  /** Force an immediate download + mirror; rejects if the MFD is unreachable. */
  syncNow(): Promise<SyncCounts> {
    return this.enqueueResult(async () => {
      try {
        const { counts } = await this.pollOnce();
        this.deps.setStatus(
          `synced ${counts.waypoints} waypoints, ${counts.routes} routes from MFD`,
        );
        return counts;
      } catch (err) {
        this.reportUnreachable(err);
        throw err;
      } finally {
        if (!this.stopped && this.config.syncFromMfd) {
          this.scheduleNextPoll();
        }
      }
    });
  }

  /**
   * USR bytes for a user-facing backup: the last good download when one is
   * cached (instant), otherwise a fresh (slow) download from the MFD.
   */
  backupNow(): Promise<Buffer> {
    if (this.lastBuf) {
      return Promise.resolve(this.lastBuf);
    }
    return this.downloadNow();
  }

  /** Fresh USR download for a user-facing backup (also mirrored, as a poll). */
  downloadNow(): Promise<Buffer> {
    return this.enqueueResult(async () => {
      try {
        const { buf } = await this.pollOnce();
        return buf;
      } catch (err) {
        this.reportUnreachable(err);
        throw err;
      }
    });
  }

  /**
   * Build a USR file containing exactly the given SignalK routes (plus their
   * synthesized leg waypoints). Record identity comes from the persistent id
   * map and, where possible, from the last downloaded database, so repeated
   * builds of the same route reference the same uuids instead of minting new
   * ones. The built routes are marked suppressed in the id map: once the file
   * lands on the MFD, the mirror leaves them to their owning provider instead
   * of publishing a duplicate.
   */
  buildUsr(routes: Map<string, RouteResource>, now = new Date()): BuiltUsr {
    const nameAdjustments: NameAdjustment[] = [];
    const db = buildUsrDatabase({
      waypoints: new Map(),
      routes,
      previous: this.lastDb,
      idMap: this.deps.idMap,
      now,
      onNameAdjusted: (type, original, adjusted) =>
        nameAdjustments.push({ type, original, adjusted }),
    });
    const bytes = serializeUsr(db);
    parseUsr(bytes); // never emit a file we couldn't re-parse ourselves
    for (const rt of db.routes) {
      this.deps.idMap.markSuppressed(rt.uuid, 'routes');
    }
    return { bytes, nameAdjustments };
  }

  /**
   * Push the given SignalK routes to the MFD. Uploads are additive (they
   * never overwrite or delete records on the MFD), so the routes go up
   * directly with no surrounding sync: we already know what we uploaded,
   * and the routes are marked suppressed, so the next regular poll leaves
   * them to their owning provider.
   */
  uploadToMfd(routes: Map<string, RouteResource>): Promise<UploadResult> {
    return this.enqueueResult(async () => {
      try {
        this.deps.setStatus(`uploading ${routes.size} route(s) to MFD`);
        const { bytes, nameAdjustments } = this.buildUsr(routes);
        await this.deps.client.upload(bytes);
        this.deps.setStatus(`uploaded ${routes.size} route(s) to MFD`);
        return { routes: routes.size, nameAdjustments };
      } catch (err) {
        this.reportUnreachable(err);
        throw err;
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
    // published as SignalK waypoints. Legs stay unpublished even when their
    // route is filtered out (hidden, or route sync off): they are still
    // route legs on the MFD, not free-standing waypoints.
    const legUuids = new Set<string>(db.routes.flatMap((rt) => rt.legUuids));
    const counts = { waypoints: 0, routes: 0 };

    for (const type of RESOURCE_TYPES) {
      // A disabled type gets an empty fileContent: full-mirror deletion then
      // unpublishes anything mirrored before the option was turned off.
      const fileContent = new Map<string, Resource>();
      if (type === 'waypoints' && this.config.syncWaypoints) {
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
      } else if (type === 'routes' && this.config.syncRoutes) {
        for (const rt of db.routes) {
          if (this.config.syncVisibleRoutesOnly && rt.visible === 0) {
            continue; // hidden on the MFD
          }
          if (this.deps.idMap.isSuppressedUuid(rt.uuid)) {
            continue; // pushed from SignalK; its owning provider serves it
          }
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

  /** MFD operations are serialized: polls and manual operations never overlap. */
  private enqueueResult<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    // The chain itself never rejects; each caller handles its own errors.
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** Like enqueueResult, but any error is internal — log it and move on. */
  private enqueue(fn: () => Promise<void>): Promise<void> {
    return this.enqueueResult(fn).catch((err) => {
      this.deps.log.error(`internal sync error: ${String(err)}`);
    });
  }

  private reportReachable(): void {
    if (this.mfdUnreachable) {
      this.mfdUnreachable = false;
      this.deps.log.debug('MFD reachable again');
    }
  }

  private reportUnreachable(err: unknown): void {
    const msg = `${err instanceof Error ? err.message : String(err)} (${new Date().toISOString()})`;
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
