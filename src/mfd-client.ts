/**
 * Thin HTTP client for the Navico GoFree file service.
 *
 *   POST /cgi-bin/download.cgi          → full user DB as a USR v6 file
 *   POST /cgi-bin/upload.cgi (multipart, field `file1`) → replace user DB
 *
 * Implemented on node:http with `insecureHTTPParser` because real MFDs
 * (Zeus3S, firmware 2024) answer with HTTP/1.0 responses whose header
 * lines end in bare LF — the strict parser behind `fetch` rejects them.
 *
 * Slave MFDs take ~7 s just to generate the file, hence the generous
 * default download timeout.
 */

import { randomBytes } from 'node:crypto';
import { request } from 'node:http';
import type { Logger } from './types';

export class MfdHttpError extends Error {
  constructor(
    readonly operation: 'download' | 'upload',
    message: string,
  ) {
    super(`MFD ${operation} failed: ${message}`);
    this.name = 'MfdHttpError';
  }
}

export interface MfdClientOptions {
  downloadTimeoutMs?: number;
  uploadTimeoutMs?: number;
}

export class MfdClient {
  private readonly base: string;
  private readonly downloadTimeoutMs: number;
  private readonly uploadTimeoutMs: number;

  constructor(address: string, options: MfdClientOptions = {}) {
    this.base = `http://${address}`;
    this.downloadTimeoutMs = options.downloadTimeoutMs ?? 120_000;
    this.uploadTimeoutMs = options.uploadTimeoutMs ?? 120_000;
  }

  async download(): Promise<Buffer> {
    return this.post('download', '/cgi-bin/download.cgi', undefined, this.downloadTimeoutMs);
  }

  async upload(usr: Buffer): Promise<void> {
    const boundary = `----signalk-navico-${randomBytes(12).toString('hex')}`;
    const body = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\n` +
          'Content-Disposition: form-data; name="file1"; filename="signalk.usr"\r\n' +
          'Content-Type: application/octet-stream\r\n\r\n',
      ),
      usr,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    await this.post('upload', '/cgi-bin/upload.cgi', {
      body,
      contentType: `multipart/form-data; boundary=${boundary}`,
      timeoutMs: this.uploadTimeoutMs,
    });
  }

  private post(
    operation: 'download' | 'upload',
    path: string,
    payload?: { body: Buffer; contentType: string; timeoutMs: number },
    timeoutMs = payload?.timeoutMs ?? 120_000,
  ): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const fail = (message: string) => reject(new MfdHttpError(operation, message));

      const req = request(
        `${this.base}${path}`,
        {
          method: 'POST',
          insecureHTTPParser: true,
          headers: payload
            ? { 'content-type': payload.contentType, 'content-length': payload.body.length }
            : { 'content-length': 0 },
        },
        (res) => {
          if (res.statusCode !== 200) {
            res.resume();
            fail(`HTTP ${res.statusCode ?? '?'} ${res.statusMessage ?? ''}`.trimEnd());
            return;
          }
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => resolve(Buffer.concat(chunks)));
          res.on('error', (err) => fail(err.message));
        },
      );

      // Absolute deadline for the whole exchange.
      const deadline = setTimeout(() => {
        req.destroy(new Error(`timed out after ${timeoutMs / 1000} seconds`));
      }, timeoutMs);
      req.on('close', () => clearTimeout(deadline));
      req.on('error', (err) => fail(err.message));

      req.end(payload?.body);
    });
  }
}

/** The MFD I/O surface SyncEngine consumes. */
export interface UsrTransport {
  download(): Promise<Buffer>;
  upload(usr: Buffer): Promise<void>;
}

export interface FailoverMfdClientOptions extends MfdClientOptions {
  log?: Logger;
  /**
   * How long to wait for discovery to produce at least one candidate before
   * failing an operation. Announcements arrive about once a second, so this
   * mostly matters for the first poll right after plugin start.
   */
  waitForCandidatesMs?: number;
}

/**
 * MFD client over a dynamic candidate list (GoFree auto-discovery): each
 * operation tries the candidates in order — UDB master first — and falls
 * back to the next on timeout or error. Also used with a fixed single-entry
 * list when the user configured an explicit address.
 */
export class FailoverMfdClient implements UsrTransport {
  private readonly waitForCandidatesMs: number;

  constructor(
    private readonly candidates: () => string[],
    private readonly options: FailoverMfdClientOptions = {},
    private readonly clientFactory: (address: string) => UsrTransport = (address) =>
      new MfdClient(address, options),
  ) {
    this.waitForCandidatesMs = options.waitForCandidatesMs ?? 10_000;
  }

  download(): Promise<Buffer> {
    return this.attempt('download', (client) => client.download());
  }

  async upload(usr: Buffer): Promise<void> {
    await this.attempt('upload', (client) => client.upload(usr));
  }

  private async attempt<T>(
    operation: 'download' | 'upload',
    fn: (client: UsrTransport) => Promise<T>,
  ): Promise<T> {
    const addresses = await this.awaitCandidates();
    if (addresses.length === 0) {
      throw new MfdHttpError(
        operation,
        `no MFD address configured and none discovered on the network ` +
          `(GoFree announcements on 239.2.1.1:2052)`,
      );
    }
    let lastError: unknown;
    for (const [i, address] of addresses.entries()) {
      try {
        return await fn(this.clientFactory(address));
      } catch (err) {
        lastError = err;
        const message = err instanceof Error ? err.message : String(err);
        if (i < addresses.length - 1) {
          this.options.log?.debug(`${message}; falling back to ${addresses[i + 1]}`);
        }
      }
    }
    throw lastError;
  }

  /** Candidate list, polling briefly if discovery hasn't seen anyone yet. */
  private async awaitCandidates(): Promise<string[]> {
    const deadline = Date.now() + this.waitForCandidatesMs;
    for (;;) {
      const addresses = this.candidates();
      if (addresses.length > 0 || Date.now() >= deadline) {
        return addresses;
      }
      await new Promise((r) => setTimeout(r, Math.min(250, deadline - Date.now())));
    }
  }
}
