import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { UsrArchive } from '../src/usr-archive';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'usr-archive-test-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('UsrArchive', () => {
  it('writes timestamped copies', async () => {
    const archive = new UsrArchive(join(dir, 'archive'));
    const path = await archive.archive(Buffer.from('abc'), new Date('2026-07-15T10:00:00Z'));
    expect(path).toMatch(/usr-2026-07-15T10-00-00-000Z\.usr$/);
    expect(readFileSync(path, 'utf8')).toBe('abc');
  });

  it('prunes old archives beyond the keep limit', async () => {
    const archive = new UsrArchive(join(dir, 'archive'), 3);
    for (let i = 0; i < 6; i++) {
      await archive.archive(Buffer.from(`v${i}`), new Date(Date.UTC(2026, 0, 1 + i)));
    }
    const files = await archive.listArchives();
    expect(files).toHaveLength(3);
    // The newest three survive.
    expect(readFileSync(files[0]!, 'utf8')).toBe('v3');
    expect(readFileSync(files[2]!, 'utf8')).toBe('v5');
  });

  it('lists nothing when the directory does not exist yet', async () => {
    const archive = new UsrArchive(join(dir, 'never-created'));
    expect(await archive.listArchives()).toEqual([]);
  });
});
