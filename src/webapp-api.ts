/**
 * HTTP API behind the plugin's webapp, mounted by the SignalK server at
 * /plugins/signalk-navico-routes (via `registerWithRouter`).
 *
 * The webapp selects routes from the server's v2 resources API and sends
 * only `{id, name}` pairs; route geometry is re-read server-side so the
 * upload always reflects current SignalK state. All MFD traffic funnels
 * through the SyncEngine's operation chain, so manual operations never
 * overlap the poll loop.
 *
 * Express types are kept out on purpose: the router surface used here is
 * tiny, and narrow local interfaces keep the module testable with fakes.
 */

import { validateResource } from './mapper';
import { PLUGIN_ID } from './types';
import type { SyncEngine } from './sync-engine';
import type { Logger, RouteResource } from './types';

/** Name limit enforced for MFD-bound routes (Zeus3S on-screen keyboard cap). */
export const MFD_NAME_LIMIT = 16;

export interface ApiRequest {
  body?: unknown;
}

export interface ApiResponse {
  status(code: number): ApiResponse;
  setHeader(name: string, value: string): void;
  json(value: unknown): void;
  send(body: Buffer): void;
}

export interface ApiRouter {
  get(path: string, handler: (req: ApiRequest, res: ApiResponse) => void): void;
  post(path: string, handler: (req: ApiRequest, res: ApiResponse) => void): void;
}

export interface WebappApiDeps {
  /** Plugin version, from package.json. */
  version: string;
  /** Undefined while the plugin is not started/configured. */
  getEngine(): SyncEngine | undefined;
  /** All SignalK routes across providers (server resources API). */
  listRoutes(): Promise<Record<string, RouteResource>>;
  log: Logger;
  now?: () => Date;
}

/** Error with an HTTP status; anything else maps to 502 (MFD trouble). */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

interface RouteSelection {
  id: string;
  name?: string;
}

export function registerApiRoutes(router: ApiRouter, deps: WebappApiDeps): void {
  const now = deps.now ?? (() => new Date());

  const engine = (): SyncEngine => {
    const running = deps.getEngine();
    if (!running) {
      throw new ApiError(503, 'plugin is not running (configure an MFD address and enable it)');
    }
    return running;
  };

  const wrap =
    (fn: (req: ApiRequest, res: ApiResponse) => Promise<void>) =>
    (req: ApiRequest, res: ApiResponse): void => {
      fn(req, res).catch((err: unknown) => {
        const status = err instanceof ApiError ? err.status : 502;
        const message = err instanceof Error ? err.message : String(err);
        deps.log.error(`webapp api: ${message}`);
        res.status(status).json({ error: message });
      });
    };

  // Static plugin facts plus current sync state, so the webapp can shape
  // its UI. Unlike the operations below this answers while the plugin is
  // stopped too (running: false, no sync state).
  router.get('/api/ui-config', (_req, res) => {
    const running = deps.getEngine();
    res.json({
      name: PLUGIN_ID,
      version: deps.version,
      running: Boolean(running),
      ...(running ? running.uiState() : { sync: null, lastSync: null }),
    });
  });

  // Force an immediate MFD → SignalK sync.
  router.post(
    '/api/sync',
    wrap(async (_req, res) => {
      res.json(await engine().syncNow());
    }),
  );

  // The MFD's full user database, as a browser download. Served from the
  // last good download when cached; fetched fresh from the MFD otherwise.
  router.get(
    '/api/backup',
    wrap(async (_req, res) => {
      const buf = await engine().backupNow();
      sendUsr(res, buf, `navico-backup-${fileStamp(now())}.usr`);
    }),
  );

  // Build a USR file from the selected SignalK routes, as a browser download.
  router.post(
    '/api/usr',
    wrap(async (req, res) => {
      const routes = await resolveSelection(deps, req.body);
      const { bytes, nameAdjustments } = engine().buildUsr(routes, now());
      logAdjustments(deps.log, nameAdjustments);
      sendUsr(res, bytes, `signalk-routes-${fileStamp(now())}.usr`);
    }),
  );

  // Push the selected SignalK routes to the MFD (archives a backup first).
  router.post(
    '/api/upload',
    wrap(async (req, res) => {
      const routes = await resolveSelection(deps, req.body);
      const result = await engine().uploadToMfd(routes);
      logAdjustments(deps.log, result.nameAdjustments);
      res.json(result);
    }),
  );
}

/**
 * Validate the `{routes: [{id, name?}]}` body and resolve it against the
 * server's resources API into the map `SyncEngine.buildUsr` consumes.
 */
async function resolveSelection(
  deps: WebappApiDeps,
  body: unknown,
): Promise<Map<string, RouteResource>> {
  const selections = parseSelections(body);
  const all = await deps.listRoutes();
  const routes = new Map<string, RouteResource>();
  for (const sel of selections) {
    const route = all[sel.id];
    if (!route) {
      throw new ApiError(404, `no such route: ${sel.id}`);
    }
    if (route.$source === PLUGIN_ID) {
      throw new ApiError(400, `route ${sel.id} is already mirrored from the MFD`);
    }
    const problem = validateResource('routes', route);
    if (problem) {
      throw new ApiError(400, `route ${sel.id}: ${problem}`);
    }
    const name =
      cleanName(sel.name) ?? cleanName(route.name) ?? `ROUTE ${sel.id.slice(0, 8).toUpperCase()}`;
    routes.set(sel.id, { ...route, name });
  }
  return routes;
}

function parseSelections(body: unknown): RouteSelection[] {
  const routes =
    typeof body === 'object' && body !== null ? (body as { routes?: unknown }).routes : undefined;
  if (!Array.isArray(routes) || routes.length === 0) {
    throw new ApiError(400, 'request body must be {routes: [{id, name?}, …]} with ≥1 route');
  }
  return routes.map((entry: unknown): RouteSelection => {
    const { id, name } = (typeof entry === 'object' && entry !== null ? entry : {}) as {
      id?: unknown;
      name?: unknown;
    };
    if (typeof id !== 'string' || id === '') {
      throw new ApiError(400, 'each selected route needs a string id');
    }
    if (name !== undefined && typeof name !== 'string') {
      throw new ApiError(400, `route ${id}: name must be a string`);
    }
    return { id, name };
  });
}

/** Trimmed and capped at the MFD name limit; undefined if effectively empty. */
function cleanName(name: string | undefined): string | undefined {
  const cleaned = name?.trim().slice(0, MFD_NAME_LIMIT).trimEnd();
  return cleaned ? cleaned : undefined;
}

function logAdjustments(
  log: Logger,
  adjustments: { type: string; original: string; adjusted: string }[],
): void {
  for (const a of adjustments) {
    log.debug(`${a.type} name '${a.original}' adjusted to '${a.adjusted}' for the MFD`);
  }
}

function sendUsr(res: ApiResponse, bytes: Buffer, filename: string): void {
  res.setHeader('content-type', 'application/octet-stream');
  res.setHeader('content-disposition', `attachment; filename="${filename}"`);
  res.send(bytes);
}

function fileStamp(when: Date): string {
  return when.toISOString().replace(/[:.]/g, '-').slice(0, 19);
}
