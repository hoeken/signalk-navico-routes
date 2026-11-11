/**
 * Pure logic of the "Send to MFD" window that Freeboard-SK opens from a
 * route's menu (see src/freeboard.ts): reading the action target, the route
 * summary, and turning API answers into messages.
 */

import { NAME_LIMIT, PLUGIN_ID, truncateName } from '../lib';

export const UPLOAD_URL = '/plugins/' + PLUGIN_ID + '/api/upload';

/** A route the window can send, from the action's target. */
export interface RouteTarget {
  id: string;
  /** Where to read the route, relative to the server root. */
  url: string;
  /** The name Freeboard showed, until the route itself is loaded. */
  name: string;
  /** Freeboard's live-route handle, when the route is on the chart. */
  routeId?: string;
}

/**
 * The route an action invocation (`{ actionId, target }`) points at, or a
 * message saying why there is nothing to send. Freeboard offers route
 * actions on unsaved drafts too; those have no `id` yet.
 */
export function routeTarget(invocation: unknown): RouteTarget | { problem: string } {
  const target =
    typeof invocation === 'object' && invocation !== null
      ? (invocation as { target?: unknown }).target
      : undefined;
  if (typeof target !== 'object' || target === null) {
    return { problem: 'Choose "Send to MFD" on a route in Freeboard.' };
  }
  const { kind, id, href, name, routeId } = target as {
    kind?: unknown;
    id?: unknown;
    href?: unknown;
    name?: unknown;
    routeId?: unknown;
  };
  if (kind !== 'route') {
    return { problem: 'Only routes can be sent to the MFD.' };
  }
  if (typeof id !== 'string' || id === '') {
    return { problem: 'Save the route first, then send it.' };
  }
  // `href` is relative to /signalk/v2/api; only follow it to a route.
  const path =
    typeof href === 'string' && href.indexOf('/resources/routes/') === 0
      ? href
      : '/resources/routes/' + encodeURIComponent(id);
  return {
    id,
    url: '/signalk/v2/api' + path,
    name: typeof name === 'string' ? name : '',
    ...(typeof routeId === 'string' && routeId ? { routeId } : {}),
  };
}

/**
 * Whether Freeboard's live copy of the route (a `route.get` result) has
 * edits that are not saved yet. The upload reads the stored route, so it
 * would send the older version.
 */
export function hasUnsavedEdits(live: unknown): boolean {
  return typeof live === 'object' && live !== null && (live as { dirty?: unknown }).dirty === true;
}

export interface RouteSummary {
  name: string;
  points: number;
  /** Mirrored from the MFD by this plugin: already on the chartplotter. */
  fromMfd: boolean;
}

export function routeSummary(resource: unknown, fallbackName: string): RouteSummary {
  const route = (typeof resource === 'object' && resource !== null ? resource : {}) as {
    name?: unknown;
    $source?: unknown;
    feature?: { geometry?: { coordinates?: unknown } };
  };
  const coordinates = route.feature && route.feature.geometry && route.feature.geometry.coordinates;
  return {
    name: typeof route.name === 'string' && route.name.trim() ? route.name : fallbackName,
    points: Array.isArray(coordinates) ? coordinates.length : 0,
    fromMfd: route.$source === PLUGIN_ID,
  };
}

/** The name proposed for the MFD: trimmed and cut to the MFD's limit. */
export function mfdName(name: string): string {
  return truncateName(name.trim()).trim();
}

export { NAME_LIMIT };

/** Message for a failed request, from its status and (JSON) body. */
export function failureMessage(status: number, body: unknown): string {
  if (status === 401 || status === 403) {
    return 'Not allowed. Log in to Signal K with read/write access (before Signal K 2.35: as admin).';
  }
  const error =
    typeof body === 'object' && body !== null ? (body as { error?: unknown }).error : undefined;
  return typeof error === 'string' && error ? error : 'Request failed (HTTP ' + status + ').';
}

/** Message after a successful upload of one route. */
export function sentMessage(name: string): string {
  return 'Sent "' + name + '" to the MFD. Sending it again adds a second copy there.';
}

export const ALREADY_SENT =
  'Already sent to the MFD from this window. Sending it again would add a second copy there.';

export const UNSAVED_EDITS = 'This route has unsaved changes. Save it first, then send it.';
