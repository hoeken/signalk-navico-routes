import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IdMap } from '../src/id-map';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'id-map-test-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('IdMap persistence', () => {
  it('survives a save/load round trip', () => {
    const map = IdMap.load(dir);
    const uuid = map.ensureUuid('sk-1', 'routes');
    map.markForeign('foreign-1', 'waypoints');
    map.markSuppressed('a'.repeat(32), 'waypoints');

    const reloaded = IdMap.load(dir);
    expect(reloaded.uuidFor('sk-1')).toBe(uuid);
    expect(reloaded.idFor(uuid)).toBe('sk-1');
    expect(reloaded.isForeign('foreign-1')).toBe(true);
    expect(reloaded.isSuppressedUuid('a'.repeat(32))).toBe(true);
  });

  it('writes atomically (no leftover temp file)', () => {
    const map = IdMap.load(dir);
    map.ensureUuid('sk-1', 'routes');
    const files = readdirSync(dir);
    expect(files).toEqual(['navico-id-map.json']);
    expect(existsSync(join(dir, 'navico-id-map.json.tmp'))).toBe(false);
  });

  it('starts empty when no file exists', () => {
    const map = IdMap.load(dir);
    expect(map.uuidFor('anything')).toBeUndefined();
  });

  it('deletion removes both directions', () => {
    const map = IdMap.load(dir);
    const uuid = map.ensureUuid('sk-1', 'routes');
    map.delete('sk-1');
    expect(map.uuidFor('sk-1')).toBeUndefined();
    expect(map.idFor(uuid)).toBeUndefined();
    const reloaded = IdMap.load(dir);
    expect(reloaded.uuidFor('sk-1')).toBeUndefined();
  });
});
