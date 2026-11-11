import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildManifest, EXTENSION_ID, plotterExtensionProvider } from '../src/freeboard';
import { PLUGIN_ID } from '../src/types';
import {
  failureMessage,
  hasUnsavedEdits,
  mfdName,
  NAME_LIMIT,
  routeSummary,
  routeTarget,
  sentMessage,
  UPLOAD_URL,
} from '../webapp/src/freeboard/send-lib';

describe('Freeboard-SK manifest', () => {
  const manifest = buildManifest('1.2.3');

  it('declares the send window and the route action', () => {
    expect(manifest).toMatchObject({ apiVersion: '1', version: '1.2.3' });
    expect(manifest.requires).toEqual(['panels.iframe', 'actions']);
    expect(manifest.actions).toHaveLength(1);
    const action = manifest.actions[0]!;
    expect(action).toMatchObject({
      id: 'send-to-mfd',
      title: 'Send to MFD',
      action: { type: 'openWindow', panel: 'send' },
    });
    expect(manifest.panels.map((p) => p.id)).toContain('send');
  });

  it('offers the action on routes only', () => {
    expect(manifest.actions[0]!.targets).toEqual(['route']);
  });

  it('points the window at a page the plugin ships', () => {
    const url = manifest.panels[0]!.url;
    expect(url).toBe(`/${PLUGIN_ID}/fb-send.html`);
    expect(existsSync(join(__dirname, '..', 'public', 'fb-send.html'))).toBe(true);
  });
});

describe('plotterExtensions provider', () => {
  const provider = plotterExtensionProvider('1.2.3');

  it('lists and serves the manifest under the plugin id', async () => {
    expect(provider.type).toBe('plotterExtensions');
    const all = await provider.methods.listResources({});
    expect(Object.keys(all)).toEqual([EXTENSION_ID]);
    await expect(provider.methods.getResource(EXTENSION_ID)).resolves.toEqual(
      buildManifest('1.2.3'),
    );
    await expect(provider.methods.getResource('other')).rejects.toThrow(/no such/);
  });

  it('is read-only', async () => {
    await expect(provider.methods.setResource(EXTENSION_ID, {})).rejects.toThrow(/read-only/);
    await expect(provider.methods.deleteResource(EXTENSION_ID)).rejects.toThrow(/read-only/);
  });
});

describe('send window logic', () => {
  it('reads a stored route from the action invocation', () => {
    expect(
      routeTarget({
        actionId: 'send-to-mfd',
        target: { kind: 'route', id: 'abc', href: '/resources/routes/abc', name: 'Passage' },
      }),
    ).toEqual({ id: 'abc', url: '/signalk/v2/api/resources/routes/abc', name: 'Passage' });
  });

  it('keeps the live-route handle when Freeboard sends one', () => {
    expect(
      routeTarget({ target: { kind: 'route', id: 'abc', routeId: 'live-7', name: 'P' } }),
    ).toMatchObject({ id: 'abc', routeId: 'live-7' });
    expect(routeTarget({ target: { kind: 'route', id: 'abc' } })).not.toHaveProperty('routeId');
  });

  it('detects unsaved edits in the live route', () => {
    expect(hasUnsavedEdits({ routeId: 'live-7', saved: true, dirty: true })).toBe(true);
    expect(hasUnsavedEdits({ routeId: 'live-7', saved: true, dirty: false })).toBe(false);
    expect(hasUnsavedEdits(undefined)).toBe(false);
  });

  it('builds the route URL when href is missing or not a route', () => {
    expect(routeTarget({ target: { kind: 'route', id: 'a b' } })).toEqual({
      id: 'a b',
      url: '/signalk/v2/api/resources/routes/a%20b',
      name: '',
    });
    expect(
      routeTarget({ target: { kind: 'route', id: 'x', href: '/resources/waypoints/x' } }),
    ).toMatchObject({ url: '/signalk/v2/api/resources/routes/x' });
  });

  it('explains what cannot be sent', () => {
    expect(routeTarget(undefined)).toEqual({ problem: expect.stringMatching(/route/) });
    expect(routeTarget({ target: { kind: 'waypoint', id: 'w' } })).toEqual({
      problem: 'Only routes can be sent to the MFD.',
    });
    // An unsaved draft route has no id yet.
    expect(routeTarget({ target: { kind: 'route', routeId: 'draft-1' } })).toEqual({
      problem: 'Save the route first, then send it.',
    });
  });

  it('summarises the loaded route', () => {
    const route = {
      name: 'Passage to Savusavu Bay',
      feature: {
        geometry: {
          type: 'LineString',
          coordinates: [
            [178.1, -17.1],
            [178.2, -17.2],
            [178.3, -17.3],
          ],
        },
      },
    };
    expect(routeSummary(route, 'fallback')).toEqual({
      name: 'Passage to Savusavu Bay',
      points: 3,
      fromMfd: false,
    });
    expect(routeSummary({ ...route, name: ' ', $source: PLUGIN_ID }, 'fallback')).toEqual({
      name: 'fallback',
      points: 3,
      fromMfd: true,
    });
    expect(routeSummary(null, 'fallback')).toEqual({ name: 'fallback', points: 0, fromMfd: false });
  });

  it('proposes a name within the MFD limit', () => {
    expect(NAME_LIMIT).toBe(16);
    expect(mfdName('  Passage to Savusavu Bay ')).toBe('Passage to Savus');
    expect(mfdName('Short ')).toBe('Short');
    expect(mfdName('Passage to Savu Bay')).toBe('Passage to Savu');
  });

  it('turns failed requests into messages', () => {
    expect(failureMessage(401, undefined)).toMatch(/Log in/);
    expect(failureMessage(403, { error: 'x' })).toMatch(/read\/write.*2\.35.*admin/);
    expect(failureMessage(503, { error: 'plugin is not running' })).toBe('plugin is not running');
    expect(failureMessage(500, 'oops')).toBe('Request failed (HTTP 500).');
  });

  it('posts to the plugin upload API and warns about copies', () => {
    expect(UPLOAD_URL).toBe(`/plugins/${PLUGIN_ID}/api/upload`);
    expect(sentMessage('SAVU')).toMatch(/"SAVU".*second copy/);
  });
});
