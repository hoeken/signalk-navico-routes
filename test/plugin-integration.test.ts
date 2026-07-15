/**
 * End-to-end provider integration: the real plugin entry registered against
 * a minimal fake of the SignalK `app` API, talking to a local HTTP server
 * that emulates a Navico MFD's GoFree file service.
 */
import { createServer, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import createPlugin from '../src/index';
import { parseUsr } from '../src/usr/codec';
import { latDegToMm, lonDegToMm } from '../src/usr/mercator';
import type { Delta, Resource, ResourceProvider, SignalKApp, WaypointResource } from '../src/types';
import { buildUsr, synthUuid } from './helpers/build-usr';

const WP = {
  uuid: synthUuid(0xa1),
  name: 'SAVUSAVU',
  lonMm: lonDegToMm(179.32534),
  latMm: latDegToMm(-16.7768),
};

function extractMultipartFile(body: Buffer): Buffer {
  const headerEnd = body.indexOf('\r\n\r\n');
  const firstLineEnd = body.indexOf('\r\n');
  const boundary = body.subarray(0, firstLineEnd);
  const closing = body.indexOf(boundary, headerEnd);
  return body.subarray(headerEnd + 4, closing - 2); // strip trailing \r\n
}

async function waitFor(cond: () => boolean | Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!(await cond())) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('timed out waiting for condition');
    }
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('plugin integration', () => {
  let server: Server;
  let dataDir: string;
  let mfd: { buf: Buffer; uploads: Buffer[] };
  let app: SignalKApp & {
    providers: Map<string, ResourceProvider>;
    deltas: Delta[];
    listeners: ((d: Delta) => void)[];
  };
  let plugin: ReturnType<typeof createPlugin>;

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'navico-plugin-test-'));
    mfd = { buf: buildUsr({ waypoints: [WP], routes: [] }), uploads: [] };

    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        if (req.url === '/cgi-bin/download.cgi') {
          res.setHeader('content-type', 'application/octet-stream');
          res.end(mfd.buf);
        } else if (req.url === '/cgi-bin/upload.cgi') {
          const file = extractMultipartFile(body);
          mfd.uploads.push(file);
          mfd.buf = file;
          res.end('OK');
        } else {
          res.statusCode = 404;
          res.end();
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;

    const providers = new Map<string, ResourceProvider>();
    const deltas: Delta[] = [];
    const listeners: ((d: Delta) => void)[] = [];
    app = {
      providers,
      deltas,
      listeners,
      debug: () => undefined,
      error: () => undefined,
      setPluginStatus: () => undefined,
      setPluginError: () => undefined,
      getDataDirPath: () => dataDir,
      handleMessage: (_id, delta) => {
        deltas.push(delta);
        for (const l of listeners) {
          l(delta); // the server echoes provider deltas back on the stream
        }
      },
      registerResourceProvider: (p) => providers.set(p.type, p),
      resourcesApi: {
        listResources: async (type) => {
          const provider = providers.get(type);
          return provider ? await provider.methods.listResources({}) : {};
        },
        getResource: async (type, id) => providers.get(type)!.methods.getResource(id),
        setResource: async () => undefined,
        deleteResource: async () => undefined,
      },
      signalk: {
        on: (_e, cb) => listeners.push(cb),
        removeListener: (_e, cb) => listeners.splice(listeners.indexOf(cb), 1),
      },
    };

    plugin = createPlugin(app);
    plugin.start({
      mfdAddress: `127.0.0.1:${port}`,
      syncFromMfd: true,
      syncToMfd: true,
      pollIntervalSeconds: 15, // min; the immediate first poll is what we use
      uploadQuietSeconds: 1,
      uploadMinIntervalSeconds: 10,
    });
  });

  afterEach(async () => {
    await plugin.stop();
    await new Promise((resolve) => server.close(resolve));
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('serves MFD content through the provider and round-trips a new waypoint', async () => {
    const waypoints = app.providers.get('waypoints')!;
    const routes = app.providers.get('routes')!;

    // First poll mirrors the MFD database.
    await waitFor(async () => Object.keys(await waypoints.methods.listResources({})).length === 1);
    const listed = await waypoints.methods.listResources({});
    const [id, resource] = Object.entries(listed)[0]! as [string, WaypointResource];
    expect(resource.name).toBe('SAVUSAVU');
    expect(await waypoints.methods.getResource(id)).toEqual(resource);
    expect(await routes.methods.listResources({})).toEqual({});

    // set → debounce → upload → MFD now holds the new waypoint.
    const newWp: Resource = {
      name: 'NEW MARK',
      feature: {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [179.5, -17.2] },
        properties: {},
      },
    };
    await waypoints.methods.setResource('11111111-2222-4333-8444-555555555555', newWp);
    await waitFor(() => mfd.uploads.length === 1, 10_000);

    const uploaded = parseUsr(mfd.uploads[0]!);
    expect(uploaded.waypoints.map((w) => w.name)).toEqual(
      expect.arrayContaining(['SAVUSAVU', 'NEW MARK']),
    );
    // The original MFD record is preserved byte-losslessly.
    const orig = uploaded.waypoints.find((w) => w.name === 'SAVUSAVU')!;
    expect(orig.uuid).toBe(WP.uuid);
    expect(orig.lonMm).toBe(WP.lonMm);

    // get still answers from memory.
    const got = (await waypoints.methods.getResource(
      '11111111-2222-4333-8444-555555555555',
    )) as WaypointResource;
    expect(got.name).toBe('NEW MARK');
  });

  it('rejects invalid resources and unknown deletes', async () => {
    const waypoints = app.providers.get('waypoints')!;
    await expect(waypoints.methods.setResource('bad', { nope: true } as never)).rejects.toThrow(
      /invalid waypoints resource/,
    );
    await expect(waypoints.methods.getResource('missing')).rejects.toThrow(/no such/);
    await expect(waypoints.methods.deleteResource('missing')).rejects.toThrow(/no such/);
  });

  it('deleting a mirrored waypoint uploads a database without it', async () => {
    const waypoints = app.providers.get('waypoints')!;
    await waitFor(async () => Object.keys(await waypoints.methods.listResources({})).length === 1);
    const [id] = Object.keys(await waypoints.methods.listResources({}));

    await waypoints.methods.deleteResource(id!);
    expect(await waypoints.methods.listResources({})).toEqual({});
    await waitFor(() => mfd.uploads.length === 1, 10_000);
    expect(parseUsr(mfd.uploads[0]!).waypoints).toHaveLength(0);

    // The waypoint must stay deleted across subsequent polls (confirmation).
    await new Promise((r) => setTimeout(r, 500));
    expect(await waypoints.methods.listResources({})).toEqual({});
  });
});
