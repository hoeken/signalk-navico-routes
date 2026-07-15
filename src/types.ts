/**
 * SignalK v2 resource shapes and the (minimal) subset of the SignalK server
 * plugin `app` API this plugin uses. Kept local and narrow so the whole
 * plugin is testable against small fakes.
 */

export const PLUGIN_ID = 'signalk-navico-routes';

export type Position = [longitude: number, latitude: number];

export interface WaypointResource {
  name?: string;
  description?: string;
  /** ISO-8601 creation time of the MFD record (mirrored resources only). */
  timestamp?: string;
  /** Providing plugin id (mirrored resources only). */
  $source?: string;
  feature: {
    type: 'Feature';
    geometry: {
      type: 'Point';
      coordinates: Position;
    };
    /** Mirrored resources carry the Navico USR record uuid (32 hex chars) here. */
    properties: Record<string, unknown>;
  };
}

export interface RouteResource {
  name?: string;
  description?: string;
  /** Total route length in meters (computed, not stored on the MFD). */
  distance?: number;
  /** ISO-8601 creation time of the MFD record (mirrored resources only). */
  timestamp?: string;
  /** Providing plugin id (mirrored resources only). */
  $source?: string;
  feature: {
    type: 'Feature';
    geometry: {
      type: 'LineString';
      coordinates: Position[];
    };
    /** Mirrored resources carry the Navico USR record uuid (32 hex chars) here. */
    properties: Record<string, unknown>;
  };
}

export type ResourceType = 'routes' | 'waypoints';
export type Resource = RouteResource | WaypointResource;

export interface ResourceProviderMethods {
  listResources(params: Record<string, unknown>): Promise<Record<string, Resource>>;
  getResource(id: string, property?: string): Promise<Resource>;
  setResource(id: string, value: Resource): Promise<void>;
  deleteResource(id: string): Promise<void>;
}

export interface ResourceProvider {
  type: ResourceType;
  methods: ResourceProviderMethods;
}

/** SignalK delta as emitted/consumed for resource updates. */
export interface Delta {
  context?: string;
  updates?: {
    source?: unknown;
    $source?: string;
    timestamp?: string;
    values?: { path: string; value: unknown }[];
  }[];
}

export interface SignalKApp {
  debug(msg: string): void;
  error(msg: string): void;
  setPluginStatus(msg: string): void;
  setPluginError(msg: string): void;
  getDataDirPath(): string;
  handleMessage(pluginId: string, delta: Delta, version?: string): void;
  registerResourceProvider(provider: ResourceProvider): void;
}

export interface PluginConfig {
  mfdAddress: string;
  syncFromMfd: boolean;
  pollIntervalSeconds: number;
}

export interface Logger {
  debug(msg: string): void;
  error(msg: string): void;
}
