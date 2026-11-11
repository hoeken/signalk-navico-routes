/**
 * Freeboard-SK integration through its Plotter Extensions API
 * (https://github.com/SignalK/freeboard-sk, docs/api/plotter-extensions-api.md).
 *
 * The plugin offers an extension manifest as a `plotterExtensions` resource.
 * Freeboard reads the collection when it loads and adds "Send to MFD" to the
 * menu of every stored route. Choosing it opens a small window
 * (public/fb-send.html) that uploads the route through the plugin's own
 * API, with the user's session.
 */

import { PLUGIN_ID } from './types';
import type { PlotterExtensionProvider } from './types';

/** Resource id of the manifest in the `plotterExtensions` collection. */
export const EXTENSION_ID = PLUGIN_ID;

/** Where the server serves the plugin's `public/` directory. */
const ASSETS = `/${PLUGIN_ID}`;

export interface PlotterExtensionManifest {
  name: string;
  description: string;
  version: string;
  apiVersion: '1';
  requires: string[];
  optional: string[];
  panels: { id: string; title: string; type: 'iframe'; url: string }[];
  actions: {
    id: string;
    title: string;
    icon: string;
    targets: unknown[];
    action: Record<string, unknown>;
  }[];
}

export function buildManifest(version: string): PlotterExtensionManifest {
  return {
    name: 'Navico Route Sync',
    description: 'Sends routes from the chart to a Navico chartplotter (B&G, Simrad, Lowrance).',
    version,
    apiVersion: '1',
    // The action is the whole extension: a host without actions has nothing
    // to show for it.
    requires: ['panels.iframe', 'actions'],
    // Without windows the host opens the same page as a side panel; with
    // nightMode the page follows the chart's night display.
    optional: ['windows', 'nightMode'],
    panels: [{ id: 'send', title: 'Send to MFD', type: 'iframe', url: `${ASSETS}/fb-send.html` }],
    actions: [
      {
        id: 'send-to-mfd',
        title: 'Send to MFD',
        icon: 'send',
        // Every route, including those mirrored from the MFD: Freeboard
        // (3.4) keeps no `$source` on the routes it loads, so a `match` cannot
        // tell them apart. The window says when a route is already there, and
        // the upload API rejects it.
        targets: ['route'],
        action: {
          type: 'openWindow',
          panel: 'send',
          title: 'Send to MFD',
          geometry: { anchor: 'center', width: 360, height: 340 },
        },
      },
    ],
  };
}

/** Read-only `plotterExtensions` provider holding this plugin's manifest. */
export function plotterExtensionProvider(version: string): PlotterExtensionProvider {
  const manifest = buildManifest(version);
  const readOnly = async (): Promise<never> => {
    throw new Error(`${EXTENSION_ID} is a read-only plotterExtensions provider`);
  };
  return {
    type: 'plotterExtensions',
    methods: {
      listResources: async () => ({ [EXTENSION_ID]: manifest }),
      getResource: async (id) => {
        if (id !== EXTENSION_ID) {
          throw new Error(`no such plotterExtensions resource: ${id}`);
        }
        return manifest;
      },
      setResource: readOnly,
      deleteResource: readOnly,
    },
  };
}
