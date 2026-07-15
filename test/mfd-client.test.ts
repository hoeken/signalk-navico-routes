import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MfdClient, MfdHttpError } from '../src/mfd-client';

type Handler = (req: IncomingMessage, body: Buffer, res: ServerResponse) => void;

let server: Server;
let handler: Handler;
let address: string;
const requests: { method: string; url: string; headers: Record<string, unknown>; body: Buffer }[] =
  [];

beforeEach(async () => {
  requests.length = 0;
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      requests.push({ method: req.method!, url: req.url!, headers: { ...req.headers }, body });
      handler(req, body, res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  address = `127.0.0.1:${port}`;
});

afterEach(async () => {
  await new Promise((resolve) => server.close(resolve));
});

describe('MfdClient.download', () => {
  it('POSTs to download.cgi and returns the body as a Buffer', async () => {
    const payload = Buffer.from([6, 0, 0, 0, 1, 2, 3]);
    handler = (_req, _body, res) => {
      res.setHeader('content-type', 'application/octet-stream');
      res.end(payload);
    };
    const client = new MfdClient(address);
    const buf = await client.download();
    expect(buf.equals(payload)).toBe(true);
    expect(requests[0]!.method).toBe('POST');
    expect(requests[0]!.url).toBe('/cgi-bin/download.cgi');
  });

  it('throws MfdHttpError on non-200', async () => {
    handler = (_req, _body, res) => {
      res.statusCode = 500;
      res.end('boom');
    };
    const client = new MfdClient(address);
    await expect(client.download()).rejects.toThrow(MfdHttpError);
    await expect(client.download()).rejects.toThrow(/HTTP 500/);
  });

  it('times out slow downloads', async () => {
    handler = () => {
      /* never respond */
    };
    const client = new MfdClient(address, { downloadTimeoutMs: 200 });
    await expect(client.download()).rejects.toThrow(MfdHttpError);
  });

  it('reports connection failures cleanly', async () => {
    const client = new MfdClient('127.0.0.1:1'); // nothing listens here
    await expect(client.download()).rejects.toThrow(MfdHttpError);
  });
});

describe('MfdClient.upload', () => {
  it('POSTs multipart/form-data with field file1', async () => {
    handler = (_req, _body, res) => res.end('OK');
    const client = new MfdClient(address);
    const usr = Buffer.from('fake usr contents');
    await client.upload(usr);

    const req = requests[0]!;
    expect(req.method).toBe('POST');
    expect(req.url).toBe('/cgi-bin/upload.cgi');
    const contentType = req.headers['content-type'] as string;
    expect(contentType).toMatch(/^multipart\/form-data; boundary=/);

    const body = req.body.toString('latin1');
    expect(body).toContain('name="file1"');
    expect(body).toContain('filename="signalk.usr"');
    expect(body).toContain('Content-Type: application/octet-stream');
    expect(body).toContain('fake usr contents');
  });

  it('throws MfdHttpError on upload rejection', async () => {
    handler = (_req, _body, res) => {
      res.statusCode = 403;
      res.end('no');
    };
    const client = new MfdClient(address);
    await expect(client.upload(Buffer.from('x'))).rejects.toThrow(/HTTP 403/);
  });
});
