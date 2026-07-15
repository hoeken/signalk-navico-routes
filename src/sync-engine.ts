/**
 * SyncEngine: owns the poll timer, the pending-edit ledger, the upload
 * throttle (debounce + rate floor), and serialization of MFD operations
 * (a download never overlaps an upload).
 *
 * Conflict model — "SignalK edits protected": the MFD wins by default
 * (mirror semantics), except resources with unconfirmed pending edits.
 * Pending edits are confirmed when a subsequent download's canonical
 * content matches; until then the plugin re-uploads with backoff.
 *
 * Loop prevention: a download that merely reflects what we uploaded
 * produces no deltas (canonical-content comparison in the store) and no
 * new upload (uploads are only scheduled by provider writes or foreign
 * changes, never by mirror application).
 */

import {
  buildUsrDatabase,
  canonicalize,
  usrRouteToResource,
  usrWaypointToResource,
} from './mapper';
import { parseUsr, serializeUsr } from './usr/codec';
import type { UsrDatabase } from './usr/model';
import type { IdMap } from './id-map';
import type { ResourceStore } from './resource-store';
import type { Logger, Resource, ResourceType, RouteResource, WaypointResource } from './types';

const RESOURCE_TYPES: ResourceType[] = ['waypoints', 'routes'];
const UPLOAD_RETRY_BACKOFF_MS = [5_000, 30_000, 120_000];

export interface SyncEngineConfig {
  syncFromMfd: boolean;
  syncToMfd: boolean;
  pollIntervalSeconds: number;
  uploadQuietSeconds: number;
  uploadMinIntervalSeconds: number;
}

export interface SyncEngineDeps {
  client: {
    download(): Promise<Buffer>;
    upload(usr: Buffer): Promise<void>;
  };
  store: ResourceStore;
  idMap: IdMap;
  archive: { archive(usr: Buffer): Promise<string> };
  /** Last-good-download cache, served on start before the first poll. */
  cache: { load(): Promise<Buffer | undefined>; save(usr: Buffer): Promise<void> };
  /** Emit a SignalK resource delta (value null = deleted). */
  emitDelta(type: ResourceType, id: string, value: Resource | null): void;
  /** All resources of a type visible through the server's resources API. */
  listAllResources(type: ResourceType): Promise<Map<string, Resource>>;
  log: Logger;
  setStatus(msg: string): void;
  setError(msg: string): void;
}

interface PendingEdit {
  op: 'set' | 'delete';
  /** Canonical content for 'set'; undefined for 'delete'. */
  canonical?: string;
  /** Upload attempts made since this edit was recorded. */
  attempts: number;
}

export class SyncEngine {
  private lastDb?: UsrDatabase;
  private pending = new Map<string, PendingEdit>();
  private chain: Promise<void> = Promise.resolve();
  private pollTimer?: NodeJS.Timeout;
  private uploadTimer?: NodeJS.Timeout;
  private lastUploadStartedAt = -Infinity;
  private uploadScheduledFor?: number;
  /** Time of the first not-yet-uploaded change; bounds debounce postponement. */
  private dirtySince?: number;
  private stopped = false;
  private mfdUnreachable = false;
  private warnedTransient = false;

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
    if (this.uploadTimer) {
      clearTimeout(this.uploadTimer);
      this.uploadTimer = undefined;
    }
    return this.flush();
  }

  /** Wait for any in-flight MFD operation to finish (test/shutdown hook). */
  flush(): Promise<void> {
    return this.chain;
  }

  hasPendingEdits(): boolean {
    return this.pending.size > 0;
  }

  // ── Provider-side writes (own resources) ─────────────────────────────────

  localSet(type: ResourceType, id: string, resource: Resource): void {
    this.deps.store.set(type, id, resource);
    this.deps.idMap.ensureUuid(id, type);
    if (this.config.syncToMfd) {
      this.pending.set(key(type, id), {
        op: 'set',
        canonical: canonicalize(type, resource),
        attempts: 0,
      });
    } else if (!this.warnedTransient) {
      this.warnedTransient = true;
      this.deps.log.error(
        'syncToMfd is disabled: resources written to this provider are held in memory only ' +
          'and will be removed by the next MFD mirror',
      );
    }
    this.deps.emitDelta(type, id, resource);
    this.scheduleUpload('local edit');
  }

  localDelete(type: ResourceType, id: string): void {
    const existed = this.deps.store.delete(type, id);
    if (!existed) {
      throw new Error(`no such ${type} resource: ${id}`);
    }
    if (this.config.syncToMfd) {
      this.pending.set(key(type, id), { op: 'delete', attempts: 0 });
    }
    this.deps.emitDelta(type, id, null);
    this.scheduleUpload('local delete');
  }

  // ── Foreign resources (owned by other providers) ─────────────────────────

  markForeignDirty(type: ResourceType, id: string): void {
    this.deps.idMap.markForeign(id, type);
    this.scheduleUpload(`foreign ${type} change`);
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
      this.mirror(db);
      this.deps.setStatus(
        `serving ${db.waypoints.length} waypoints, ${db.routes.length} routes from cache; waiting for MFD sync`,
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
        this.lastDb = db;
        this.reportReachable();
        await this.saveToCache(buf);
        this.mirror(db);
        this.deps.setStatus(
          `synced ${db.waypoints.length} waypoints, ${db.routes.length} routes from MFD`,
        );
      } catch (err) {
        // Failed or malformed download: keep serving the previous state.
        this.reportUnreachable('download', err);
      } finally {
        if (!this.stopped && this.config.syncFromMfd) {
          this.schedulePoll(this.config.pollIntervalSeconds * 1000);
        }
        this.retryUnconfirmedEdits();
      }
    });
  }

  /** Full-mirror semantics: the file is the truth, except pending edits. */
  private mirror(db: UsrDatabase): void {
    const waypointsByUuid = new Map(db.waypoints.map((w) => [w.uuid, w]));

    for (const type of RESOURCE_TYPES) {
      const fileContent = new Map<string, Resource>();
      if (type === 'waypoints') {
        for (const wp of db.waypoints) {
          if (this.deps.idMap.isSuppressedUuid(wp.uuid)) {
            continue; // synthesized route-leg waypoint, not a standalone resource
          }
          const id = this.deps.idMap.idForUuid(wp.uuid, 'waypoints');
          if (this.deps.idMap.isForeign(id)) {
            continue; // lives in SignalK under another provider
          }
          fileContent.set(id, usrWaypointToResource(wp));
        }
      } else {
        for (const rt of db.routes) {
          const id = this.deps.idMap.idForUuid(rt.uuid, 'routes');
          if (this.deps.idMap.isForeign(id)) {
            continue;
          }
          try {
            fileContent.set(id, usrRouteToResource(rt, waypointsByUuid));
          } catch (err) {
            this.deps.log.error(`skipping route '${rt.name}': ${String(err)}`);
          }
        }
      }

      // Confirm pending edits whose content the MFD now reflects.
      for (const [k, edit] of this.pending) {
        const [ktype, id] = splitKey(k);
        if (ktype !== type) {
          continue;
        }
        if (edit.op === 'set') {
          const fileRes = fileContent.get(id);
          if (fileRes && canonicalize(type, fileRes) === edit.canonical) {
            this.pending.delete(k);
            this.deps.log.debug(`pending edit confirmed for ${k}`);
          }
        } else if (!fileContent.has(id)) {
          this.pending.delete(k);
          this.deps.log.debug(`pending delete confirmed for ${k}`);
        }
      }

      // Create/overwrite from the file (protected: pending edits).
      for (const [id, resource] of fileContent) {
        if (this.pending.has(key(type, id))) {
          continue;
        }
        if (this.deps.store.set(type, id, resource)) {
          this.deps.emitDelta(type, id, resource);
        }
      }

      // Full-mirror deletion: gone from the file → gone from SignalK.
      for (const id of this.deps.store.ids(type)) {
        if (!fileContent.has(id) && !this.pending.has(key(type, id))) {
          this.deps.store.delete(type, id);
          this.deps.emitDelta(type, id, null);
        }
      }
    }
  }

  // ── SignalK → MFD (throttled upload) ─────────────────────────────────────

  /**
   * Debounce + rate floor: fire `uploadQuietSeconds` after the most recent
   * change, but never sooner than `uploadMinIntervalSeconds` after the
   * previous upload started. Changes always coalesce into the next
   * permitted upload; nothing is lost.
   */
  private scheduleUpload(reason: string, backoffMs = 0): void {
    if (!this.config.syncToMfd || this.stopped) {
      return;
    }
    const now = Date.now();
    if (backoffMs === 0 && this.dirtySince === undefined) {
      this.dirtySince = now;
    }
    const minIntervalMs = this.config.uploadMinIntervalSeconds * 1000;
    const quietTarget = now + Math.max(this.config.uploadQuietSeconds * 1000, backoffMs);
    const floorTarget = this.lastUploadStartedAt + minIntervalMs;
    // Debounce pushed out by each change, but capped so sustained edits
    // still ship in the next permitted upload instead of starving forever.
    const maxWaitTarget = Math.max(floorTarget, (this.dirtySince ?? now) + minIntervalMs);
    const fireAt = Math.min(Math.max(quietTarget, floorTarget), maxWaitTarget);
    // A backoff retry must not push an already-scheduled earlier upload out.
    if (this.uploadTimer && this.uploadScheduledFor !== undefined && backoffMs > 0) {
      if (this.uploadScheduledFor <= fireAt) {
        return;
      }
    }
    if (this.uploadTimer) {
      clearTimeout(this.uploadTimer);
    }
    this.deps.log.debug(`upload scheduled in ${fireAt - now} ms (${reason})`);
    this.uploadScheduledFor = fireAt;
    this.uploadTimer = setTimeout(() => {
      this.uploadTimer = undefined;
      this.uploadScheduledFor = undefined;
      void this.runUpload();
    }, fireAt - now);
  }

  private runUpload(): Promise<void> {
    return this.enqueue(async () => {
      this.lastUploadStartedAt = Date.now();
      this.dirtySince = undefined;
      try {
        // 1. Fresh download, archived: uploads destroy trails, and this is
        //    the recovery copy. Also refreshes the record-preservation base.
        const buf = await this.deps.client.download();
        const db = parseUsr(buf);
        this.lastDb = db;
        await this.deps.archive.archive(buf);
        this.reportReachable();
        await this.saveToCache(buf);

        // Bring the store up to date with any MFD-side changes first, so
        // the build below never overwrites them with stale mirror content
        // (pending edits stay protected as usual).
        if (this.config.syncFromMfd) {
          this.mirror(db);
        }

        // 2. Union of our store and all foreign routes/waypoints.
        const waypoints = this.deps.store.waypoints();
        const routes = this.deps.store.routes();
        for (const type of RESOURCE_TYPES) {
          const foreign = await this.collectForeign(type);
          for (const [id, resource] of foreign) {
            (type === 'waypoints' ? waypoints : routes).set(
              id,
              resource as WaypointResource & RouteResource,
            );
          }
        }

        // Drop pending deletes from the outgoing set (they may still be
        // present via listAllResources caching or foreign staleness).
        for (const [k, edit] of this.pending) {
          if (edit.op === 'delete') {
            const [ktype, id] = splitKey(k);
            (ktype === 'waypoints' ? waypoints : routes).delete(id);
          }
        }

        const out = buildUsrDatabase({
          waypoints,
          routes,
          previous: this.lastDb,
          idMap: this.deps.idMap,
          serialNumber: this.lastDb?.serialNumber,
          now: new Date(),
          onNameAdjusted: (type, original, adjusted) =>
            this.deps.log.error(
              `${type} name '${original}' exceeds the MFD limit; uploading as '${adjusted}'`,
            ),
        });

        // A deleted waypoint that survives in the build because a route
        // still references it as a leg cannot be removed from the file;
        // demote it to a suppressed leg record instead so the mirror never
        // resurrects it as a standalone SignalK waypoint.
        for (const [k, edit] of this.pending) {
          if (edit.op !== 'delete') {
            continue;
          }
          const [ktype, id] = splitKey(k);
          if (ktype !== 'waypoints') {
            continue;
          }
          const uuid = this.deps.idMap.uuidFor(id);
          if (uuid && out.waypoints.some((w) => w.uuid === uuid)) {
            this.deps.idMap.markSuppressed(uuid, 'waypoints');
            this.deps.log.debug(
              `waypoint ${id} is still a route leg; keeping its record hidden instead of deleting`,
            );
          }
        }

        // A record-identical upload would accomplish nothing but still
        // erase the MFD's trails — skip it. This is also the last line of
        // defense against upload loops.
        if (recordsEqual(out, db)) {
          for (const k of this.pending.keys()) {
            this.deps.log.debug(`pending edit ${k} already reflected on the MFD`);
          }
          this.pending.clear();
          this.deps.setStatus('MFD already up to date, upload skipped');
          return;
        }

        // 3. Never write a USR file we cannot re-parse ourselves.
        const serialized = serializeUsr(out);
        parseUsr(serialized);

        await this.deps.client.upload(serialized);
        for (const edit of this.pending.values()) {
          edit.attempts++;
        }
        this.deps.setStatus(
          `uploaded ${out.waypoints.length} waypoints, ${out.routes.length} routes to MFD`,
        );
        // Confirm promptly rather than waiting a full poll interval.
        if (this.config.syncFromMfd && this.pending.size > 0) {
          this.schedulePoll(UPLOAD_RETRY_BACKOFF_MS[0]!);
        }
      } catch (err) {
        this.reportUnreachable('upload', err);
        this.scheduleUpload('upload failed, retrying', UPLOAD_RETRY_BACKOFF_MS[0]);
      }
    });
  }

  /** Foreign resources visible through the server's resources API. */
  private async collectForeign(type: ResourceType): Promise<Map<string, Resource>> {
    const out = new Map<string, Resource>();
    let listed: Map<string, Resource>;
    try {
      listed = await this.deps.listAllResources(type);
    } catch (err) {
      this.deps.log.error(`could not list ${type} from the resources API: ${String(err)}`);
      listed = new Map();
    }
    for (const [id, resource] of listed) {
      if (this.deps.store.owns(id)) {
        continue; // ours
      }
      this.deps.idMap.markForeign(id, type);
      out.set(id, resource);
    }
    return out;
  }

  /** Unconfirmed pending edits re-upload with backoff, then every poll. */
  private retryUnconfirmedEdits(): void {
    if (!this.config.syncToMfd || this.pending.size === 0) {
      return;
    }
    const uploaded = [...this.pending.values()].filter((e) => e.attempts > 0);
    if (uploaded.length === 0) {
      return; // first upload not attempted yet; the normal schedule handles it
    }
    const minAttempts = Math.min(...uploaded.map((e) => e.attempts));
    const backoff =
      UPLOAD_RETRY_BACKOFF_MS[Math.min(minAttempts - 1, UPLOAD_RETRY_BACKOFF_MS.length - 1)]!;
    this.scheduleUpload(`retrying ${this.pending.size} unconfirmed edit(s)`, backoff);
  }

  // ── Plumbing ─────────────────────────────────────────────────────────────

  /** All MFD operations are serialized: no download ever overlaps an upload. */
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

/** Same waypoint/route records regardless of section ordering. */
function recordsEqual(a: UsrDatabase, b: UsrDatabase): boolean {
  const dump = (db: UsrDatabase) =>
    JSON.stringify({
      waypoints: [...db.waypoints].sort((x, y) => x.uuid.localeCompare(y.uuid)),
      routes: [...db.routes].sort((x, y) => x.uuid.localeCompare(y.uuid)),
    });
  return dump(a) === dump(b);
}

function key(type: ResourceType, id: string): string {
  return `${type}:${id}`;
}

function splitKey(k: string): [ResourceType, string] {
  const idx = k.indexOf(':');
  return [k.slice(0, idx) as ResourceType, k.slice(idx + 1)];
}
