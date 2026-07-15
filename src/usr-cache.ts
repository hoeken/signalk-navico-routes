/**
 * Cache of the most recent successfully parsed USR download. Loaded on
 * plugin start so the resource provider serves the last known MFD state
 * immediately instead of waiting for the first (possibly slow) download.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export class UsrCache {
  /** Last buffer written (or loaded), to skip redundant writes. */
  private lastWritten?: Buffer;

  constructor(private readonly filePath: string) {}

  async load(): Promise<Buffer | undefined> {
    try {
      const buf = await readFile(this.filePath);
      this.lastWritten = buf;
      return buf;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return undefined;
      }
      throw err;
    }
  }

  /** Atomic write (temp file + rename); no-op if the content is unchanged. */
  async save(usr: Buffer): Promise<void> {
    if (this.lastWritten?.equals(usr)) {
      return;
    }
    await mkdir(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    await writeFile(tmp, usr);
    await rename(tmp, this.filePath);
    this.lastWritten = usr;
  }
}
