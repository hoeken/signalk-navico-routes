/**
 * Timestamped backups of downloaded USR files in the plugin data directory.
 * Uploads destroy trails on the MFD (the regenerated file contains only
 * routes and waypoints), so a pre-upload archive of the last-known-good
 * database is the recovery path: re-upload it via the MFD's own web page.
 */

import { mkdir, readdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export class UsrArchive {
  constructor(
    private readonly dir: string,
    private readonly keep = 20,
  ) {}

  /** Write a timestamped copy and prune old ones. Returns the file path. */
  async archive(usr: Buffer, when = new Date()): Promise<string> {
    await mkdir(this.dir, { recursive: true });
    const stamp = when.toISOString().replace(/[:.]/g, '-');
    const path = join(this.dir, `usr-${stamp}.usr`);
    await writeFile(path, usr);
    await this.prune();
    return path;
  }

  async listArchives(): Promise<string[]> {
    try {
      const files = await readdir(this.dir);
      return files
        .filter((f) => /^usr-.*\.usr$/.test(f))
        .sort()
        .map((f) => join(this.dir, f));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw err;
    }
  }

  private async prune(): Promise<void> {
    const files = await this.listArchives();
    const excess = files.length - this.keep;
    for (let i = 0; i < excess; i++) {
      await unlink(files[i]!);
    }
  }
}
