/**
 * Fetch wrappers for the SignalK server and the plugin API. Same-origin
 * requests with cookies so the server's authentication applies.
 */

import { PLUGIN_ID } from './lib';

const API_BASE = '/plugins/' + PLUGIN_ID;

export interface SelectionPayload {
  routes: { id: string; name: string }[];
}

/** GET /api/ui-config response: plugin facts and sync state shaping the UI. */
export interface UiConfig {
  name: string;
  version: string;
  /** False while the plugin is stopped/unconfigured; sync state is null then. */
  running: boolean;
  sync: {
    syncFromMfd: boolean;
    syncRoutes: boolean;
    syncVisibleRoutesOnly: boolean;
    syncWaypoints: boolean;
  } | null;
  /** ISO-8601 time of the last successful MFD → SignalK sync, if any. */
  lastSync: string | null;
}

async function raise(res: Response): Promise<never> {
  let message = res.status + ' ' + res.statusText;
  try {
    const body = (await res.json()) as { error?: string };
    if (body && typeof body.error === 'string') {
      message = body.error;
    }
  } catch {
    // non-JSON error body; keep the status line
  }
  throw new Error(message);
}

/** All routes from the v2 resources API (unfiltered; lib.routeRows filters). */
export async function fetchRoutes(): Promise<Record<string, unknown>> {
  const res = await fetch('/signalk/v2/api/resources/routes', { credentials: 'same-origin' });
  if (!res.ok) {
    return raise(res);
  }
  return (await res.json()) as Record<string, unknown>;
}

export async function fetchUiConfig(): Promise<UiConfig> {
  const res = await fetch(API_BASE + '/api/ui-config', { credentials: 'same-origin' });
  if (!res.ok) {
    return raise(res);
  }
  return (await res.json()) as UiConfig;
}

export async function postJson<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(API_BASE + path, {
    method: 'POST',
    credentials: 'same-origin',
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    return raise(res);
  }
  return (await res.json()) as T;
}

/**
 * Fetch a file from the plugin API and hand it to the browser as a download,
 * using the server's content-disposition filename.
 */
export async function downloadFile(path: string, body?: unknown): Promise<string> {
  const res = await fetch(API_BASE + path, {
    method: body !== undefined ? 'POST' : 'GET',
    credentials: 'same-origin',
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    return raise(res);
  }
  const filename = dispositionFilename(res.headers.get('content-disposition')) || 'routes.usr';
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return filename;
}

export function dispositionFilename(header: string | null): string | null {
  const match = header && /filename="([^"]+)"/.exec(header);
  return match ? match[1]! : null;
}
