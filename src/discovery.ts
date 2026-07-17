/**
 * GoFree multicast auto-discovery.
 *
 * Navico MFDs announce themselves about once a second as a JSON datagram on
 * multicast 239.2.1.1:2052 (`IP`, `Model`, `Name`, `UDBMaster`,
 * `NetworkMaster`, `Services[]`, …). This listener runs for the whole plugin
 * lifetime — MFDs come and go while the plugin is running — and keeps a map
 * of the devices currently announcing, expiring entries that have gone
 * quiet.
 *
 * Only devices advertising an `http` service are kept: that is the GoFree
 * file server (download.cgi / upload.cgi) the plugin talks to. Other Navico
 * gear announces on the same group without it (e.g. an H5000 CPU) and is of
 * no use here.
 */

import { createSocket } from 'node:dgram';
import { networkInterfaces } from 'node:os';
import type { Socket } from 'node:dgram';
import type { Logger } from './types';

export const GOFREE_GROUP = '239.2.1.1';
export const GOFREE_PORT = 2052;

/** How long an MFD may stay silent before it is considered gone. */
const DEFAULT_STALE_AFTER_MS = 60_000;

/** Delay before re-opening the socket after an error. */
const RETRY_AFTER_MS = 30_000;

/** An MFD currently announcing itself on the GoFree multicast group. */
export interface DiscoveredMfd {
  /** Source address of the announcement — known to be reachable from here. */
  address: string;
  model: string;
  name: string;
  /** Owns the Unified DataBase (routes/waypoints) — the preferred sync peer. */
  udbMaster: boolean;
  networkMaster: boolean;
  lastSeen: Date;
}

export interface MfdDiscoveryOptions {
  /** Listen port; 0 picks an ephemeral port (tests). Default 2052. */
  port?: number;
  staleAfterMs?: number;
  now?: () => Date;
}

export class MfdDiscovery {
  private readonly listenPort: number;
  private readonly staleAfterMs: number;
  private readonly now: () => Date;
  private readonly mfds = new Map<string, DiscoveredMfd>();
  private socket?: Socket;
  private retryTimer?: NodeJS.Timeout;
  private stopped = false;

  constructor(
    private readonly log: Logger,
    options: MfdDiscoveryOptions = {},
  ) {
    this.listenPort = options.port ?? GOFREE_PORT;
    this.staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
    this.now = options.now ?? (() => new Date());
  }

  start(): void {
    this.stopped = false;
    this.openSocket();
  }

  stop(): void {
    this.stopped = true;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
    }
    this.closeSocket();
  }

  /** Bound UDP port, once listening (tests bind port 0). */
  get port(): number | undefined {
    try {
      return this.socket?.address().port;
    } catch {
      return undefined; // not bound yet
    }
  }

  /** MFDs announcing right now, UDB master first. */
  list(): DiscoveredMfd[] {
    this.prune();
    return [...this.mfds.values()].sort(
      (a, b) =>
        Number(b.udbMaster) - Number(a.udbMaster) ||
        Number(b.networkMaster) - Number(a.networkMaster) ||
        a.address.localeCompare(b.address, undefined, { numeric: true }),
    );
  }

  /** Addresses to try for MFD I/O, in preference order (master first). */
  candidates(): string[] {
    return this.list().map((m) => m.address);
  }

  /**
   * Digest one announcement datagram. Public so tests can feed messages
   * without a socket. Malformed or irrelevant datagrams are ignored.
   */
  handleAnnouncement(msg: Buffer, fromAddress: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(msg.toString('utf8'));
    } catch {
      return;
    }
    if (typeof parsed !== 'object' || parsed === null) {
      return;
    }
    const ann = parsed as {
      Model?: unknown;
      Name?: unknown;
      UDBMaster?: unknown;
      NetworkMaster?: unknown;
      Services?: unknown;
    };
    // No http service → no GoFree file server → nothing to sync with.
    const services = Array.isArray(ann.Services) ? ann.Services : [];
    const hasHttp = services.some(
      (s: unknown) =>
        typeof s === 'object' && s !== null && (s as { Service?: unknown }).Service === 'http',
    );
    if (!hasHttp) {
      return;
    }

    const model = typeof ann.Model === 'string' ? ann.Model : '';
    const mfd: DiscoveredMfd = {
      address: fromAddress,
      model,
      name: typeof ann.Name === 'string' ? ann.Name : model,
      udbMaster: ann.UDBMaster === true,
      networkMaster: ann.NetworkMaster === true,
      lastSeen: this.now(),
    };

    const known = this.mfds.get(fromAddress);
    if (!known) {
      this.log.debug(
        `discovered MFD ${mfd.name || fromAddress} at ${fromAddress}` +
          (mfd.udbMaster ? ' (UDB master)' : ''),
      );
    } else if (known.udbMaster !== mfd.udbMaster) {
      this.log.debug(
        `MFD at ${fromAddress} is ${mfd.udbMaster ? 'now' : 'no longer'} the UDB master`,
      );
    }
    this.mfds.set(fromAddress, mfd);
  }

  // ── Socket plumbing ──────────────────────────────────────────────────────

  private openSocket(): void {
    // reuseAddr so we can share port 2052 with other GoFree-aware software.
    const socket = createSocket({ type: 'udp4', reuseAddr: true });
    this.socket = socket;

    socket.on('error', (err) => {
      this.log.error(`GoFree discovery socket error: ${err.message}`);
      this.closeSocket();
      this.scheduleRetry();
    });
    socket.on('message', (msg, rinfo) => this.handleAnnouncement(msg, rinfo.address));
    socket.bind(this.listenPort, () => this.joinGroup(socket));
  }

  private joinGroup(socket: Socket): void {
    // Join on the default interface and on every external IPv4 interface:
    // the boat network is often not the default route. Duplicate or
    // unsupported joins are fine to ignore.
    const interfaces = new Set<string | undefined>([undefined]);
    for (const addrs of Object.values(networkInterfaces())) {
      for (const a of addrs ?? []) {
        if (a.family === 'IPv4' && !a.internal) {
          interfaces.add(a.address);
        }
      }
    }
    let joined = 0;
    for (const iface of interfaces) {
      try {
        socket.addMembership(GOFREE_GROUP, iface);
        joined++;
      } catch (err) {
        this.log.debug(
          `could not join ${GOFREE_GROUP} on ${iface ?? 'default interface'}: ${String(err)}`,
        );
      }
    }
    if (joined === 0) {
      this.log.error(`could not join GoFree multicast group ${GOFREE_GROUP} on any interface`);
    }
  }

  private closeSocket(): void {
    const socket = this.socket;
    this.socket = undefined;
    if (socket) {
      try {
        socket.close();
      } catch {
        // already closed
      }
    }
  }

  private scheduleRetry(): void {
    if (this.stopped || this.retryTimer) {
      return;
    }
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      if (!this.stopped) {
        this.openSocket();
      }
    }, RETRY_AFTER_MS);
  }

  private prune(): void {
    const cutoff = this.now().getTime() - this.staleAfterMs;
    for (const [address, mfd] of this.mfds) {
      if (mfd.lastSeen.getTime() < cutoff) {
        this.mfds.delete(address);
        this.log.debug(`MFD at ${address} stopped announcing; dropped from discovery`);
      }
    }
  }
}
