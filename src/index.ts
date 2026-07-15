/**
 * signalk-navico-routes — SignalK plugin entry point.
 *
 * Registers a v2 resource provider for `routes` and `waypoints`, backed by
 * an in-memory store that mirrors a Navico MFD's user database via GoFree
 * HTTP USR-file transfer (download.cgi / upload.cgi).
 */

import { join } from 'node:path';
import { IdMap } from './id-map';
import { validateResource } from './mapper';
import { MfdClient } from './mfd-client';
import { ResourceStore } from './resource-store';
import { ResourceWatcher } from './resource-watcher';
import { SyncEngine } from './sync-engine';
import { UsrArchive } from './usr-archive';
import type { Delta, PluginConfig, Resource, ResourceType, SignalKApp } from './types';

const PLUGIN_ID = 'signalk-navico-routes';

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
    syncToMfd: {
      type: 'boolean',
      title: 'Sync SignalK → MFD',
      description:
        'Upload SignalK route/waypoint changes back to the MFD. ' +
        'WARNING: uploads replace the whole user database and erase trails ' +
        '(timestamped backups are kept in the plugin data directory).',
      default: false,
    },
    pollIntervalSeconds: {
      type: 'number',
      title: 'Poll interval (seconds)',
      description: 'How often to download the USR file from the MFD. Minimum 15.',
      default: 60,
      minimum: 15,
    },
    uploadQuietSeconds: {
      type: 'number',
      title: 'Upload debounce (seconds)',
      description:
        'Wait for this many seconds of no further changes before uploading, so a burst of edits coalesces into one upload.',
      default: 10,
      minimum: 1,
    },
    uploadMinIntervalSeconds: {
      type: 'number',
      title: 'Minimum upload interval (seconds)',
      description:
        'Hard floor between consecutive uploads. Changes are never lost — they coalesce into the next permitted upload.',
      default: 60,
      minimum: 10,
    },
  },
} as const;

interface Plugin {
  id: string;
  name: string;
  description: string;
  schema: typeof CONFIG_SCHEMA;
  start(options: Partial<PluginConfig>): void;
  stop(): void | Promise<void>;
}

export = function createPlugin(app: SignalKApp): Plugin {
  let engine: SyncEngine | undefined;
  let watcher: ResourceWatcher | undefined;

  const plugin: Plugin = {
    id: PLUGIN_ID,
    name: 'Navico routes & waypoints',
    description:
      'Synchronize routes and waypoints between Navico MFDs (B&G/Simrad/Lowrance) and SignalK via GoFree USR file transfer',
    schema: CONFIG_SCHEMA,

    start(options: Partial<PluginConfig>): void {
      const config: PluginConfig = {
        mfdAddress: options.mfdAddress ?? '',
        syncFromMfd: options.syncFromMfd ?? true,
        syncToMfd: options.syncToMfd ?? false,
        pollIntervalSeconds: Math.max(15, options.pollIntervalSeconds ?? 60),
        uploadQuietSeconds: Math.max(1, options.uploadQuietSeconds ?? 10),
        uploadMinIntervalSeconds: Math.max(10, options.uploadMinIntervalSeconds ?? 60),
      };

      if (!config.mfdAddress) {
        app.setPluginError('mfdAddress is not configured');
        return;
      }
      if (!config.syncFromMfd && !config.syncToMfd) {
        app.error('both syncFromMfd and syncToMfd are disabled: the plugin will do nothing');
        app.setPluginStatus('idle (no sync direction enabled)');
      }
      if (config.syncToMfd && !config.syncFromMfd) {
        app.error(
          'syncToMfd without syncFromMfd is discouraged: uploads cannot be confirmed against downloads',
        );
      }

      const dataDir = app.getDataDirPath();
      const store = new ResourceStore();
      const idMap = IdMap.load(dataDir);
      const client = new MfdClient(config.mfdAddress);
      const archive = new UsrArchive(join(dataDir, 'usr-archive'));

      engine = new SyncEngine(config, {
        client,
        store,
        idMap,
        archive,
        emitDelta: (type, id, value) => {
          const delta: Delta = {
            updates: [{ values: [{ path: `resources.${type}.${id}`, value }] }],
          };
          app.handleMessage(PLUGIN_ID, delta, 'v2');
        },
        listAllResources: async (type) => {
          const out = new Map<string, Resource>();
          if (!app.resourcesApi) {
            return out;
          }
          try {
            const listed = await app.resourcesApi.listResources(type, {});
            for (const [id, value] of Object.entries(listed ?? {})) {
              if (validateResource(type, value) === null) {
                out.set(id, value as Resource);
              }
            }
          } catch (err) {
            app.debug(`listResources(${type}) failed: ${String(err)}`);
          }
          // Known-foreign ids may be served by providers that listResources
          // does not cover; fetch them individually.
          for (const id of idMap.foreignIds(type)) {
            if (out.has(id)) {
              continue;
            }
            try {
              const value = await app.resourcesApi.getResource(type, id);
              if (validateResource(type, value) === null) {
                out.set(id, value as Resource);
              }
            } catch {
              // Gone: it simply drops out of the next upload.
            }
          }
          return out;
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
            setResource: async (id, value) => {
              const problem = validateResource(type, value);
              if (problem) {
                throw new Error(`invalid ${type} resource: ${problem}`);
              }
              engine!.localSet(type, id, value);
            },
            deleteResource: async (id) => {
              engine!.localDelete(type, id);
            },
          },
        });
      }

      if (config.syncToMfd) {
        watcher = new ResourceWatcher({
          store,
          idMap,
          markForeignDirty: (type, id) => engine!.markForeignDirty(type, id),
          log: { debug: (msg) => app.debug(msg), error: (msg) => app.error(msg) },
        });
        app.signalk?.on('delta', watcher.onDelta);
      }

      engine.start();
      app.setPluginStatus(
        config.syncFromMfd ? `waiting for first sync with ${config.mfdAddress}` : 'started',
      );
    },

    stop(): Promise<void> | void {
      if (watcher) {
        app.signalk?.removeListener('delta', watcher.onDelta);
        watcher = undefined;
      }
      const running = engine;
      engine = undefined;
      return running?.stop();
    },
  };

  return plugin;
};
