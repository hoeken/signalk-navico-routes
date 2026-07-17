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
import { latDegToMm, lonDegToMm } from '../src/usr/mercator';
import type { Delta, Resource, ResourceProvider, SignalKApp, WaypointResource } from '../src/types';
import { buildUsr, synthUuid } from './helpers/build-usr';

const WP = {
  uuid: synthUuid(0xa1),
  name: 'SAVUSAVU',
  lonMm: lonDegToMm(179.32534),
  latMm: latDegToMm(-16.7768),
};

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
  let mfd: { buf: Buffer };
  let app: SignalKApp & {
    providers: Map<string, ResourceProvider>;
    deltas: Delta[];
  };
  let plugin: ReturnType<typeof createPlugin>;

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'navico-plugin-test-'));
    mfd = { buf: buildUsr({ waypoints: [WP], routes: [] }) };

    server = createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        if (req.url === '/cgi-bin/download.cgi') {
          res.setHeader('content-type', 'application/octet-stream');
          res.end(mfd.buf);
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
    app = {
      providers,
      deltas,
      debug: () => undefined,
      error: () => undefined,
      setPluginStatus: () => undefined,
      setPluginError: () => undefined,
      getDataDirPath: () => dataDir,
      handleMessage: (_id, delta) => {
        deltas.push(delta);
      },
      registerResourceProvider: (p) => providers.set(p.type, p),
    };

    plugin = createPlugin(app);
    plugin.start({
      mfdAddress: `127.0.0.1:${port}`,
      syncFromMfd: true,
      pollIntervalSeconds: 30, // min; the immediate first poll is what we use
    });
  });

  afterEach(async () => {
    await plugin.stop();
    await new Promise((resolve) => server.close(resolve));
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('serves MFD content through the provider', async () => {
    const waypoints = app.providers.get('waypoints')!;
    const routes = app.providers.get('routes')!;

    // First poll mirrors the MFD database.
    await waitFor(async () => Object.keys(await waypoints.methods.listResources({})).length === 1);
    const listed = await waypoints.methods.listResources({});
    const [id, resource] = Object.entries(listed)[0]! as [string, WaypointResource];
    expect(resource.name).toBe('SAVUSAVU');
    expect(await waypoints.methods.getResource(id)).toEqual(resource);
    expect(await routes.methods.listResources({})).toEqual({});
  });

  it('rejects writes: the provider is a read-only mirror', async () => {
    const waypoints = app.providers.get('waypoints')!;
    await waitFor(async () => Object.keys(await waypoints.methods.listResources({})).length === 1);
    const [id] = Object.keys(await waypoints.methods.listResources({}));

    const newWp: Resource = {
      name: 'NEW MARK',
      feature: {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [179.5, -17.2] },
        properties: {},
      },
    };
    await expect(waypoints.methods.setResource(id!, newWp)).rejects.toThrow(/read-only/);
    await expect(waypoints.methods.deleteResource(id!)).rejects.toThrow(/read-only/);
    await expect(waypoints.methods.getResource('missing')).rejects.toThrow(/no such/);

    // The mirrored content is untouched.
    const kept = (await waypoints.methods.getResource(id!)) as WaypointResource;
    expect(kept.name).toBe('SAVUSAVU');
  });
});
