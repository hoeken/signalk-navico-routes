import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { UsrCache } from '../src/usr-cache';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'usr-cache-test-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('UsrCache', () => {
  it('round-trips a saved buffer', async () => {
    const path = join(dir, 'last-sync.usr');
    await new UsrCache(path).save(Buffer.from('usr-content'));

    const loaded = await new UsrCache(path).load();
    expect(loaded?.toString()).toBe('usr-content');
  });

  it('returns undefined when no cache exists', async () => {
    const cache = new UsrCache(join(dir, 'missing.usr'));
    expect(await cache.load()).toBeUndefined();
  });

  it('skips the write when content is unchanged', async () => {
    const path = join(dir, 'last-sync.usr');
    const cache = new UsrCache(path);
    await cache.save(Buffer.from('same'));

    rmSync(path);
    await cache.save(Buffer.from('same'));
    expect(existsSync(path)).toBe(false);

    await cache.save(Buffer.from('different'));
    expect(existsSync(path)).toBe(true);
  });

  it('creates missing parent directories', async () => {
    const path = join(dir, 'nested', 'deeper', 'last-sync.usr');
    const cache = new UsrCache(path);
    await cache.save(Buffer.from('x'));
    expect((await cache.load())?.toString()).toBe('x');
  });
});
