/**
 * Persistent identity mapping between SignalK resource ids and Navico USR
 * record UUIDs.
 *
 * - MFD-originated records get a deterministic SignalK id (UUID v5 over the
 *   Navico record uuid in a fixed plugin namespace), so repeated downloads
 *   yield stable ids with no duplicates even if this file is lost.
 * - SignalK-originated resources get a random Navico uuid assigned once and
 *   persisted here; losing this mapping would duplicate those records after
 *   an upload/download cycle, so writes are atomic (temp file + rename).
 * - The map also records which USR waypoints exist only as legs of a
 *   SignalK-defined route (`suppressed` — never surfaced as waypoints).
 */

import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ResourceType } from './types';

/** Fixed namespace for UUIDv5 derivation of SignalK ids from Navico uuids. */
const PLUGIN_NAMESPACE = Buffer.from('3f0f2d1c9a4b4d0e8c7a5e6f1a2b3c4d', 'hex');

export interface IdMapEntry {
  uuid: string;
  type: ResourceType;
  suppressed?: boolean;
}

interface IdMapFile {
  version: 1;
  entries: Record<string, IdMapEntry>;
}

function formatUuid(bytes: Buffer): string {
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/** UUID v5 (SHA-1) over the Navico record uuid, in the plugin namespace. */
export function signalKIdForUsrUuid(usrUuid: string): string {
  const digest = createHash('sha1')
    .update(PLUGIN_NAMESPACE)
    .update(Buffer.from(usrUuid, 'hex'))
    .digest()
    .subarray(0, 16);
  digest[6] = (digest[6]! & 0x0f) | 0x50; // version 5
  digest[8] = (digest[8]! & 0x3f) | 0x80; // RFC 4122 variant
  return formatUuid(digest);
}

/** Random Navico record uuid (32 hex chars) for SignalK-originated resources. */
export function newUsrUuid(): string {
  return randomBytes(16).toString('hex');
}

export class IdMap {
  private entries = new Map<string, IdMapEntry>();
  private byUuid = new Map<string, string>();

  constructor(private readonly filePath?: string) {}

  static load(dataDir: string): IdMap {
    const map = new IdMap(join(dataDir, 'navico-id-map.json'));
    try {
      const raw = readFileSync(map.filePath!, 'utf8');
      const data = JSON.parse(raw) as IdMapFile;
      for (const [id, entry] of Object.entries(data.entries)) {
        map.entries.set(id, entry);
        map.byUuid.set(entry.uuid, id);
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw err;
      }
    }
    return map;
  }

  save(): void {
    if (!this.filePath) {
      return;
    }
    const data: IdMapFile = { version: 1, entries: Object.fromEntries(this.entries) };
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(data, null, 1));
    renameSync(tmp, this.filePath);
  }

  /** SignalK id for an MFD-originated record uuid; registers it if unknown. */
  idForUuid(uuid: string, type: ResourceType): string {
    const existing = this.byUuid.get(uuid);
    if (existing !== undefined) {
      return existing;
    }
    const id = signalKIdForUsrUuid(uuid);
    this.set(id, { uuid, type });
    return id;
  }

  /** Navico uuid for a SignalK id; assigns and persists a new one if absent. */
  ensureUuid(id: string, type: ResourceType): string {
    const entry = this.entries.get(id);
    if (entry) {
      return entry.uuid;
    }
    const uuid = newUsrUuid();
    this.set(id, { uuid, type });
    return uuid;
  }

  uuidFor(id: string): string | undefined {
    return this.entries.get(id)?.uuid;
  }

  idFor(uuid: string): string | undefined {
    return this.byUuid.get(uuid);
  }

  get(id: string): IdMapEntry | undefined {
    return this.entries.get(id);
  }

  markSuppressed(uuid: string, type: ResourceType): void {
    const id = this.idForUuid(uuid, type);
    const entry = this.entries.get(id)!;
    if (!entry.suppressed) {
      entry.suppressed = true;
      this.save();
    }
  }

  isSuppressedUuid(uuid: string): boolean {
    const id = this.byUuid.get(uuid);
    return id !== undefined && this.entries.get(id)?.suppressed === true;
  }

  delete(id: string): void {
    const entry = this.entries.get(id);
    if (entry) {
      this.entries.delete(id);
      this.byUuid.delete(entry.uuid);
      this.save();
    }
  }

  private set(id: string, entry: IdMapEntry): void {
    this.entries.set(id, entry);
    this.byUuid.set(entry.uuid, id);
    this.save();
  }
}
