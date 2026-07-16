/**
 * signalk-navico-routes — SignalK plugin entry point.
 *
 * Registers a v2 resource provider for `routes` and `waypoints`, backed by
 * an in-memory store that mirrors a Navico MFD's user database via GoFree
 * HTTP USR-file transfer (download.cgi / upload.cgi).
 *
 * The provider is read-only: uploading a USR file only adds records on the
 * MFD, so automatic SignalK → MFD sync cannot work. Pushing resources to
 * the MFD is a manual, user-driven operation through the bundled webapp
 * (served at /signalk-navico-routes, API at /plugins/signalk-navico-routes).
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { IdMap } from './id-map';
import { MfdClient } from './mfd-client';
import { ResourceStore } from './resource-store';
import { SyncEngine } from './sync-engine';
import { UsrCache } from './usr-cache';
import { registerApiRoutes } from './webapp-api';
import { PLUGIN_ID } from './types';
import type { ApiRouter } from './webapp-api';
import type { Delta, PluginConfig, ResourceType, RouteResource, SignalKApp } from './types';

const CONFIG_SCHEMA = {
  type: 'object',
  required: ['mfdAddress'],
  properties: {
    mfdAddress: {
      type: 'string',
      title: 'MFD address',
      description:
        'IP address or hostname of the Navico MFD (B&G Zeus, Simrad NSS, Lowrance HDS, …) to sync with. ' +
        'Any MFD on the network works; it propagates changes to the rest via UDB.',
    },
    syncFromMfd: {
      type: 'boolean',
      title: 'Sync MFD → SignalK',
      description: 'Periodically download the user database and mirror it into SignalK.',
      default: true,
    },
    syncRoutes: {
      type: 'boolean',
      title: 'Sync routes',
      description: 'Mirror MFD routes into SignalK.',
      default: true,
    },
    syncVisibleRoutesOnly: {
      type: 'boolean',
      title: 'Sync visible routes only',
      description: 'Skip routes that are hidden on the MFD.',
      default: true,
    },
    syncWaypoints: {
      type: 'boolean',
      title: 'Sync waypoints',
      description: 'Mirror free-standing MFD waypoints into SignalK.',
      default: true,
    },
    pollIntervalSeconds: {
      type: 'number',
      title: 'Poll interval (seconds)',
      description: 'How often to download the USR file from the MFD. Minimum 15.',
      default: 300,
      minimum: 15,
    },
  },
} as const;

/** Plugin version from package.json (one level above both src/ and dist/). */
function pluginVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8')) as {
      version?: string;
    };
    return pkg.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

interface Plugin {
  id: string;
  name: string;
  description: string;
  schema: typeof CONFIG_SCHEMA;
  start(options: Partial<PluginConfig>): void;
  stop(): void | Promise<void>;
  registerWithRouter(router: ApiRouter): void;
}

export = function createPlugin(app: SignalKApp): Plugin {
  let engine: SyncEngine | undefined;

  const plugin: Plugin = {
    id: PLUGIN_ID,
    name: 'Navico Route Sync',
    description:
      'Mirror routes and waypoints from Navico MFDs (B&G/Simrad/Lowrance) into SignalK via GoFree USR file transfer',
    schema: CONFIG_SCHEMA,

    start(options: Partial<PluginConfig>): void {
      const config: PluginConfig = {
        mfdAddress: options.mfdAddress ?? '',
        syncFromMfd: options.syncFromMfd ?? true,
        syncRoutes: options.syncRoutes ?? true,
        syncVisibleRoutesOnly: options.syncVisibleRoutesOnly ?? true,
        syncWaypoints: options.syncWaypoints ?? true,
        pollIntervalSeconds: Math.max(15, options.pollIntervalSeconds ?? 300),
      };

      if (!config.mfdAddress) {
        app.setPluginError('mfdAddress is not configured');
        return;
      }
      if (!config.syncFromMfd) {
        app.error('syncFromMfd is disabled: the plugin will do nothing');
        app.setPluginStatus('idle (sync disabled)');
      }

      const dataDir = app.getDataDirPath();
      const store = new ResourceStore();
      const idMap = IdMap.load(dataDir);
      const client = new MfdClient(config.mfdAddress);
      const cache = new UsrCache(join(dataDir, 'last-sync.usr'));

      engine = new SyncEngine(config, {
        client,
        store,
        idMap,
        cache,
        emitDelta: (type, id, value) => {
          const delta: Delta = {
            updates: [{ values: [{ path: `resources.${type}.${id}`, value }] }],
          };
          app.handleMessage(PLUGIN_ID, delta, 'v2');
        },
        log: { debug: (msg) => app.debug(msg), error: (msg) => app.error(msg) },
        setStatus: (msg) => app.setPluginStatus(msg),
        setError: (msg) => app.setPluginError(msg),
      });

      for (const type of ['routes', 'waypoints'] as ResourceType[]) {
        app.registerResourceProvider({
          type,
          methods: {
            listResources: async (_params) => store.list(type),
            getResource: async (id) => {
              const resource = store.get(type, id);
              if (!resource) {
                throw new Error(`no such ${type} resource: ${id}`);
              }
              return resource;
            },
            setResource: async () => {
              throw new Error(
                `${type} mirrored from the MFD are read-only; ` +
                  'transfer to the MFD is a manual USR upload',
              );
            },
            deleteResource: async () => {
              throw new Error(
                `${type} mirrored from the MFD are read-only; ` +
                  'delete the record on the MFD instead',
              );
            },
          },
        });
      }

      engine.start();
      app.setPluginStatus(
        config.syncFromMfd
          ? `waiting for first sync with ${config.mfdAddress}`
          : 'idle (sync disabled)',
      );
    },

    stop(): Promise<void> | void {
      const running = engine;
      engine = undefined;
      return running?.stop();
    },

    // Webapp API, mounted at /plugins/signalk-navico-routes. Registered once
    // at server startup; handlers answer 503 while the plugin is stopped.
    registerWithRouter(router: ApiRouter): void {
      registerApiRoutes(router, {
        version: pluginVersion(),
        getEngine: () => engine,
        listRoutes: async () => {
          if (!app.resourcesApi) {
            throw new Error('this SignalK server does not expose the resources API to plugins');
          }
          const routes = await app.resourcesApi.listResources('routes', {});
          return routes as Record<string, RouteResource>;
        },
        log: { debug: (msg) => app.debug(msg), error: (msg) => app.error(msg) },
      });
    },
  };

  return plugin;
};
