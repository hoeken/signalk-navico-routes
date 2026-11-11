/**
 * "Send to MFD" window, opened by Freeboard-SK when the user chooses the
 * action on a route (see src/freeboard.ts). Freeboard loads it from this
 * server, so it calls the plugin's upload API with the user's own session.
 */

import { resolveTheme } from '../lib';
import { connectBus } from './bus';
import {
  ALREADY_SENT,
  NAME_LIMIT,
  UNSAVED_EDITS,
  UPLOAD_URL,
  failureMessage,
  hasUnsavedEdits,
  mfdName,
  routeSummary,
  routeTarget,
  sentMessage,
} from './send-lib';
import type { Theme } from '../lib';
import type { BusClient } from './bus';
import type { RouteTarget } from './send-lib';

function el<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

const what = el<HTMLDivElement>('what');
const nameInput = el<HTMLInputElement>('name');
const sendButton = el<HTMLButtonElement>('send');
const message = el<HTMLParagraphElement>('message');

let bus: BusClient | undefined;
let route: RouteTarget | undefined;
/**
 * Routes uploaded from this window. Freeboard reuses an open window for
 * later choices, so a route may come back after it was sent.
 */
const sent = new Set<string>();
/** The route's own name, which the MFD gets when the name field is empty. */
let routeName = '';
/** Bumped per target, so a late answer for an earlier route is ignored. */
let generation = 0;
let sending = false;

function setTheme(theme: Theme): void {
  document.documentElement.className = theme === 'night' ? 'theme-night' : 'theme-day';
}

function say(text: string, kind?: 'ok' | 'error' | 'busy'): void {
  message.textContent = text;
  message.className = 'message' + (kind ? ' message-' + kind : '');
}

function update(): void {
  sendButton.disabled = !route || sending || sent.has(route.id);
}

async function getJson(url: string, init?: RequestInit): Promise<unknown> {
  const res = await fetch(url, { credentials: 'same-origin', ...init });
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    body = undefined;
  }
  if (!res.ok) {
    throw new Error(failureMessage(res.status, body));
  }
  return body;
}

function show(invocation: unknown): void {
  const run = ++generation;
  const target = routeTarget(invocation);
  route = undefined;
  routeName = '';
  say('');
  if ('problem' in target) {
    what.textContent = target.problem;
    nameInput.value = '';
    nameInput.disabled = true;
    update();
    return;
  }
  what.textContent = 'Route: ' + (target.name || target.id);
  const proposed = mfdName(target.name);
  nameInput.value = proposed;
  nameInput.disabled = false;
  update();
  void load(target, run, proposed);
}

/** Whether Freeboard holds unsaved edits of the route; false if it cannot tell. */
async function unsavedEdits(target: RouteTarget): Promise<boolean> {
  if (!bus || !target.routeId || !bus.has('routes')) {
    return false;
  }
  try {
    return hasUnsavedEdits(await bus.call('route.get', { routeId: target.routeId }));
  } catch {
    return false; // no longer on the chart: the stored route is all there is
  }
}

async function load(target: RouteTarget, run: number, proposed: string): Promise<void> {
  try {
    const dirty = await unsavedEdits(target);
    const resource = dirty ? undefined : await getJson(target.url);
    if (run !== generation) {
      return;
    }
    if (dirty) {
      say(UNSAVED_EDITS);
      nameInput.disabled = true;
      return;
    }
    const summary = routeSummary(resource, target.name);
    what.textContent = 'Route: ' + (summary.name || target.id) + ' (' + summary.points + ' points)';
    if (summary.fromMfd) {
      say('This route came from the MFD; it is already there.');
      nameInput.disabled = true;
      return;
    }
    // Keep a name the user typed while the route was loading.
    if (nameInput.value === proposed) {
      nameInput.value = mfdName(summary.name);
    }
    routeName = summary.name;
    if (sent.has(target.id)) {
      say(ALREADY_SENT, 'ok');
      return;
    }
    route = target;
    update();
  } catch (err) {
    if (run === generation) {
      say(err instanceof Error ? err.message : String(err), 'error');
    }
  }
}

async function send(): Promise<void> {
  const target = route;
  if (!target || sending || sent.has(target.id)) {
    return;
  }
  const run = generation;
  const name = mfdName(nameInput.value);
  sending = true;
  update();
  say('Sending…', 'busy');
  try {
    // The route may have been edited on the chart since the window loaded it.
    if (await unsavedEdits(target)) {
      if (run === generation) {
        say(UNSAVED_EDITS);
        nameInput.disabled = true;
        route = undefined;
      }
      return;
    }
    await getJson(UPLOAD_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ routes: [name ? { id: target.id, name } : { id: target.id }] }),
    });
    // Uploads only add on the MFD: a second click would make a copy, even
    // after the window has moved on to another route and back.
    sent.add(target.id);
    if (run === generation) {
      say(sentMessage(name || mfdName(routeName) || target.id), 'ok');
      route = undefined;
    } else if (route && route.id === target.id) {
      // The same route was chosen again while it was being sent.
      say(ALREADY_SENT, 'ok');
      route = undefined;
    }
  } catch (err) {
    if (run === generation) {
      say(err instanceof Error ? err.message : String(err), 'error');
    }
  } finally {
    sending = false;
    update();
  }
}

setTheme(
  resolveTheme(
    location.search,
    !!window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches,
  ),
);
nameInput.maxLength = NAME_LIMIT;
sendButton.addEventListener('click', () => void send());

/** Follows Freeboard's night display; the window keeps its own theme otherwise. */
async function followNightMode(client: BusClient): Promise<void> {
  const follow = (state: unknown) => {
    const enabled = (state as { enabled?: unknown } | null)?.enabled;
    setTheme(enabled === true ? 'night' : 'day');
  };
  await client.subscribe(['nightMode.changed'], (_event, state) => follow(state));
  follow(await client.call('nightMode.get'));
}

connectBus().then(
  (client) => {
    bus = client;
    show(client.handshake.context && client.handshake.context.invocation);
    // A window that stays open hears later choices as events. Without them
    // the window still works for the route it was opened for.
    client
      .subscribe(['action.invoked'], (_event, invocation) => show(invocation))
      .catch(() => undefined);
    if (client.has('nightMode')) {
      followNightMode(client).catch(() => undefined);
    }
  },
  () => {
    what.textContent = 'Open this window from a route in Freeboard-SK.';
  },
);
