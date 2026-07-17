/**
 * MfdDiscovery: announcement parsing, role ordering, staleness expiry, and
 * one real-socket round trip (unicast to an ephemeral port — multicast
 * membership is best-effort and not required for delivery on loopback).
 */
import { createSocket } from 'node:dgram';
import { describe, expect, it } from 'vitest';
import { MfdDiscovery } from '../src/discovery';
import type { Logger } from '../src/types';

const LOG: Logger = { debug: () => undefined, error: () => undefined };

/** Trimmed-down real announcements (see research/NOTES.md). */
function announcement(overrides: Record<string, unknown>): Buffer {
  return Buffer.from(
    JSON.stringify({
      Brand: 'BandG',
      DeviceType: 'MFD',
      NavigationSupportDynamicRoutesWaypointsOverUDB: true,
      Services: [
        { Port: 80, Service: 'http', Version: '2' },
        { Port: 2053, Service: 'navico-nav-ws', Version: '1.0.30' },
      ],
      ...overrides,
    }),
  );
}

const MASTER = announcement({
  IP: '192.168.2.113',
  Model: 'Zeus3S 16',
  Name: 'Zeus3S 16',
  NetworkMaster: true,
  UDBMaster: true,
});
const SLAVE = announcement({
  IP: '192.168.2.110',
  Model: 'Zeus3S 9',
  Name: 'Zeus3S 9',
  NetworkMaster: false,
  UDBMaster: false,
});
// An H5000 CPU announces on the same group but has no http (GoFree file
// server) service — real payload shape from the pcaps.
const H5000 = Buffer.from(
  JSON.stringify({
    AppVersion: 'undefined',
    IP: '192.168.2.109',
    Model: 'H5000 CPU',
    Name: 'H5000',
    SerialNumber: '0',
    Services: [
      { Port: 2053, Service: 'navico-nav-ws', Version: 2 },
      { Port: 8086, Service: 'N2kCANoEServer', Version: 1 },
    ],
  }),
);

function discoveryAt(nowMs: { t: number }, staleAfterMs = 60_000): MfdDiscovery {
  return new MfdDiscovery(LOG, { staleAfterMs, now: () => new Date(nowMs.t) });
}

describe('MfdDiscovery announcements', () => {
  it('collects MFDs and orders the UDB master first', () => {
    const now = { t: 1_000_000 };
    const d = discoveryAt(now);
    d.handleAnnouncement(SLAVE, '192.168.2.110');
    d.handleAnnouncement(MASTER, '192.168.2.113');

    const mfds = d.list();
    expect(mfds.map((m) => m.address)).toEqual(['192.168.2.113', '192.168.2.110']);
    expect(mfds[0]).toMatchObject({
      address: '192.168.2.113',
      model: 'Zeus3S 16',
      name: 'Zeus3S 16',
      udbMaster: true,
      networkMaster: true,
    });
    expect(d.candidates()).toEqual(['192.168.2.113', '192.168.2.110']);
  });

  it('ignores devices without an http service (no GoFree file server)', () => {
    const d = discoveryAt({ t: 0 });
    d.handleAnnouncement(H5000, '192.168.2.109');
    expect(d.list()).toEqual([]);
  });

  it('ignores non-JSON and non-object datagrams', () => {
    const d = discoveryAt({ t: 0 });
    d.handleAnnouncement(Buffer.from('not json'), '192.168.2.50');
    d.handleAnnouncement(Buffer.from('"just a string"'), '192.168.2.50');
    d.handleAnnouncement(Buffer.from('42'), '192.168.2.50');
    expect(d.list()).toEqual([]);
  });

  it('expires MFDs that stop announcing, and revives them on re-announce', () => {
    const now = { t: 1_000_000 };
    const d = discoveryAt(now, 60_000);
    d.handleAnnouncement(MASTER, '192.168.2.113');
    d.handleAnnouncement(SLAVE, '192.168.2.110');

    // The master keeps announcing; the slave goes quiet.
    now.t += 45_000;
    d.handleAnnouncement(MASTER, '192.168.2.113');
    now.t += 45_000;
    expect(d.candidates()).toEqual(['192.168.2.113']);

    d.handleAnnouncement(SLAVE, '192.168.2.110');
    expect(d.candidates()).toEqual(['192.168.2.113', '192.168.2.110']);
  });

  it('tracks a role change on re-announcement', () => {
    const d = discoveryAt({ t: 0 });
    d.handleAnnouncement(SLAVE, '192.168.2.110');
    expect(d.list()[0]!.udbMaster).toBe(false);
    d.handleAnnouncement(
      announcement({ Model: 'Zeus3S 9', Name: 'Zeus3S 9', UDBMaster: true }),
      '192.168.2.110',
    );
    expect(d.list()[0]!.udbMaster).toBe(true);
  });
});

describe('MfdDiscovery socket', () => {
  it('receives announcements over UDP', async () => {
    const d = new MfdDiscovery(LOG, { port: 0 });
    d.start();
    try {
      await waitFor(() => d.port !== undefined);
      const sender = createSocket('udp4');
      try {
        await new Promise<void>((resolve, reject) =>
          sender.send(MASTER, d.port, '127.0.0.1', (err) => (err ? reject(err) : resolve())),
        );
        await waitFor(() => d.list().length === 1);
        expect(d.list()[0]).toMatchObject({ address: '127.0.0.1', udbMaster: true });
      } finally {
        sender.close();
      }
    } finally {
      d.stop();
    }
  });
});

async function waitFor(cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('timed out waiting for condition');
    }
    await new Promise((r) => setTimeout(r, 20));
  }
}
