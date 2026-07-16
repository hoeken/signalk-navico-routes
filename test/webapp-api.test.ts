import { describe, expect, it, vi } from 'vitest';
import { ApiError, MFD_NAME_LIMIT, registerApiRoutes } from '../src/webapp-api';
import { PLUGIN_ID } from '../src/types';
import type { ApiRequest, ApiResponse, ApiRouter, WebappApiDeps } from '../src/webapp-api';
import type { SyncEngine } from '../src/sync-engine';
import type { RouteResource } from '../src/types';

const NOW = new Date('2026-07-16T10:30:00.000Z');

const FOREIGN_ROUTE: RouteResource = {
  name: 'Passage to Savusavu Bay',
  feature: {
    type: 'Feature',
    geometry: {
      type: 'LineString',
      coordinates: [
        [178.1, -17.1],
        [178.2, -17.2],
      ],
    },
    properties: {},
  },
};

const MIRRORED_ROUTE: RouteResource = {
  ...FOREIGN_ROUTE,
  name: 'FROM MFD',
  $source: PLUGIN_ID,
};

const INVALID_ROUTE = {
  name: 'BROKEN',
  feature: { type: 'Feature', geometry: { type: 'LineString', coordinates: [] }, properties: {} },
} as unknown as RouteResource;

interface Reply {
  status: number;
  json?: unknown;
  body?: Buffer;
  headers: Record<string, string>;
}

function harness(overrides: Partial<WebappApiDeps> = {}) {
  const engine = {
    uiState: vi.fn(() => ({
      sync: {
        syncFromMfd: true,
        syncRoutes: true,
        syncVisibleRoutesOnly: false,
        syncWaypoints: true,
      },
      lastSync: '2026-07-16T10:00:00.000Z',
    })),
    syncNow: vi.fn(async () => ({ waypoints: 2, routes: 1 })),
    backupNow: vi.fn(async () => Buffer.from('USR-BACKUP')),
    buildUsr: vi.fn(() => ({ bytes: Buffer.from('USR-BUILT'), nameAdjustments: [] })),
    uploadToMfd: vi.fn(async (routes: Map<string, RouteResource>) => ({
      routes: routes.size,
      archivedTo: '/data/archive/usr-1.usr',
      nameAdjustments: [],
    })),
  };

  const handlers = new Map<string, (req: ApiRequest, res: ApiResponse) => void>();
  const router: ApiRouter = {
    get: (path, handler) => handlers.set(`GET ${path}`, handler),
    post: (path, handler) => handlers.set(`POST ${path}`, handler),
  };

  registerApiRoutes(router, {
    version: '1.2.3',
    getEngine: () => engine as unknown as SyncEngine,
    listRoutes: async () => ({
      'r-foreign': FOREIGN_ROUTE,
      'r-mirrored': MIRRORED_ROUTE,
      'r-invalid': INVALID_ROUTE,
    }),
    log: { debug: () => undefined, error: () => undefined },
    now: () => NOW,
    ...overrides,
  });

  async function call(method: string, path: string, body?: unknown): Promise<Reply> {
    const handler = handlers.get(`${method} ${path}`);
    if (!handler) {
      throw new Error(`no handler for ${method} ${path}`);
    }
    return new Promise<Reply>((resolve) => {
      const reply: Reply = { status: 200, headers: {} };
      const res: ApiResponse = {
        status(code) {
          reply.status = code;
          return res;
        },
        setHeader(name, value) {
          reply.headers[name.toLowerCase()] = value;
        },
        json(value) {
          reply.json = value;
          resolve(reply);
        },
        send(buf) {
          reply.body = buf;
          resolve(reply);
        },
      };
      handler({ body }, res);
    });
  }

  return { engine, call };
}

describe('webapp api', () => {
  it('GET /api/ui-config reports version, sync flags, and last sync time', async () => {
    const h = harness();
    const reply = await h.call('GET', '/api/ui-config');
    expect(reply.status).toBe(200);
    expect(reply.json).toEqual({
      name: PLUGIN_ID,
      version: '1.2.3',
      running: true,
      sync: {
        syncFromMfd: true,
        syncRoutes: true,
        syncVisibleRoutesOnly: false,
        syncWaypoints: true,
      },
      lastSync: '2026-07-16T10:00:00.000Z',
    });
  });

  it('GET /api/ui-config answers while the plugin is not running', async () => {
    const h = harness({ getEngine: () => undefined });
    const reply = await h.call('GET', '/api/ui-config');
    expect(reply.status).toBe(200);
    expect(reply.json).toEqual({
      name: PLUGIN_ID,
      version: '1.2.3',
      running: false,
      sync: null,
      lastSync: null,
    });
  });

  it('POST /api/sync triggers a sync and returns counts', async () => {
    const h = harness();
    const reply = await h.call('POST', '/api/sync');
    expect(reply.status).toBe(200);
    expect(reply.json).toEqual({ waypoints: 2, routes: 1 });
  });

  it('maps MFD failures to 502', async () => {
    const h = harness();
    h.engine.syncNow.mockRejectedValueOnce(new Error('MFD download failed: ECONNREFUSED'));
    const reply = await h.call('POST', '/api/sync');
    expect(reply.status).toBe(502);
    expect(reply.json).toEqual({ error: 'MFD download failed: ECONNREFUSED' });
  });

  it('answers 503 while the plugin is not running', async () => {
    const h = harness({ getEngine: () => undefined });
    const reply = await h.call('POST', '/api/sync');
    expect(reply.status).toBe(503);
  });

  it('GET /api/backup streams a fresh download as an attachment', async () => {
    const h = harness();
    const reply = await h.call('GET', '/api/backup');
    expect(reply.body?.toString()).toBe('USR-BACKUP');
    expect(reply.headers['content-type']).toBe('application/octet-stream');
    expect(reply.headers['content-disposition']).toBe(
      'attachment; filename="navico-backup-2026-07-16T10-30-00.usr"',
    );
  });

  it('POST /api/usr builds a file from the selection, applying name overrides', async () => {
    const h = harness();
    const reply = await h.call('POST', '/api/usr', {
      routes: [{ id: 'r-foreign', name: '  Savusavu Leg 1  ' }],
    });
    expect(reply.body?.toString()).toBe('USR-BUILT');
    expect(reply.headers['content-disposition']).toContain('signalk-routes-');

    const routes = h.engine.buildUsr.mock.calls[0]![0] as Map<string, RouteResource>;
    expect(routes.get('r-foreign')!.name).toBe('Savusavu Leg 1');
  });

  it('caps names at the MFD limit and falls back to the route name', async () => {
    const h = harness();
    await h.call('POST', '/api/usr', { routes: [{ id: 'r-foreign' }] });
    const routes = h.engine.buildUsr.mock.calls[0]![0] as Map<string, RouteResource>;
    const name = routes.get('r-foreign')!.name!;
    expect(name).toBe(FOREIGN_ROUTE.name!.slice(0, MFD_NAME_LIMIT).trimEnd());
    expect(name.length).toBeLessThanOrEqual(MFD_NAME_LIMIT);
  });

  it('rejects malformed selections with 400', async () => {
    const h = harness();
    expect((await h.call('POST', '/api/usr', undefined)).status).toBe(400);
    expect((await h.call('POST', '/api/usr', { routes: [] })).status).toBe(400);
    expect((await h.call('POST', '/api/usr', { routes: [{ id: 42 }] })).status).toBe(400);
    expect((await h.call('POST', '/api/usr', { routes: [{ id: 'x', name: 5 }] })).status).toBe(400);
    expect(h.engine.buildUsr).not.toHaveBeenCalled();
  });

  it('rejects unknown, mirrored, and invalid routes', async () => {
    const h = harness();
    expect((await h.call('POST', '/api/usr', { routes: [{ id: 'nope' }] })).status).toBe(404);
    expect((await h.call('POST', '/api/usr', { routes: [{ id: 'r-mirrored' }] })).status).toBe(400);
    expect((await h.call('POST', '/api/usr', { routes: [{ id: 'r-invalid' }] })).status).toBe(400);
    expect(h.engine.buildUsr).not.toHaveBeenCalled();
  });

  it('POST /api/upload pushes the selection through the engine', async () => {
    const h = harness();
    const reply = await h.call('POST', '/api/upload', {
      routes: [{ id: 'r-foreign', name: 'SAVU RUN' }],
    });
    expect(reply.status).toBe(200);
    expect(reply.json).toEqual({
      routes: 1,
      archivedTo: '/data/archive/usr-1.usr',
      nameAdjustments: [],
    });
    const routes = h.engine.uploadToMfd.mock.calls[0]![0];
    expect(routes.get('r-foreign')!.name).toBe('SAVU RUN');
  });

  it('ApiError carries its HTTP status', () => {
    const err = new ApiError(418, 'teapot');
    expect(err.status).toBe(418);
    expect(err.message).toBe('teapot');
  });
});
