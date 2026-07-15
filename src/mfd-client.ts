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
    this.downloadTimeoutMs = options.downloadTimeoutMs ?? 45_000;
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
    timeoutMs = payload?.timeoutMs ?? 45_000,
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
        req.destroy(new Error(`timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      req.on('close', () => clearTimeout(deadline));
      req.on('error', (err) => fail(err.message));

      req.end(payload?.body);
    });
  }
}
