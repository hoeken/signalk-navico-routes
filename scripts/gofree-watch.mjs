#!/usr/bin/env node
/**
 * Live GoFree discovery monitor — diagnostic companion to src/discovery.ts.
 *
 * Binds UDP 2052, joins multicast 239.2.1.1 on every IPv4 interface (same as
 * the plugin), and prints every datagram it receives: source, raw JSON, and
 * whether the plugin's discovery would keep it (needs an `http` service) or
 * filter it out. Run it on the same box as SignalK to see what — if anything —
 * is arriving on the wire.
 *
 *   node scripts/gofree-watch.mjs [--raw] [--port 2052]
 *
 *   --raw   also dump the full datagram payload, not just the parsed summary
 */

import { createSocket } from 'node:dgram';
import { networkInterfaces } from 'node:os';

const GOFREE_GROUP = '239.2.1.1';

const args = process.argv.slice(2);
const showRaw = args.includes('--raw');
const portIdx = args.indexOf('--port');
const port = portIdx >= 0 ? Number(args[portIdx + 1]) : 2052;

const ts = () => new Date().toISOString().slice(11, 23);
const log = (msg) => console.log(`${ts()}  ${msg}`);

// ── Interfaces ──────────────────────────────────────────────────────────────

log(`interfaces on this machine:`);
const ifaceAddrs = [];
for (const [name, addrs] of Object.entries(networkInterfaces())) {
  for (const a of addrs ?? []) {
    if (a.family === 'IPv4') {
      console.log(`           ${name}: ${a.address}${a.internal ? ' (internal, skipped)' : ''}`);
      if (!a.internal) ifaceAddrs.push(a.address);
    }
  }
}
if (ifaceAddrs.length === 0) {
  log(`WARNING: no external IPv4 interfaces — nothing to join the group on`);
}

// ── Socket ──────────────────────────────────────────────────────────────────

const socket = createSocket({ type: 'udp4', reuseAddr: true });

socket.on('error', (err) => {
  log(`socket error: ${err.message}`);
  process.exit(1);
});

let datagrams = 0;
const seen = new Map(); // address → { name, count, lastSeen }

socket.on('message', (msg, rinfo) => {
  datagrams++;
  const from = `${rinfo.address}:${rinfo.port}`;

  let parsed;
  try {
    parsed = JSON.parse(msg.toString('utf8'));
  } catch {
    log(`${from}  ${msg.length}B  NOT JSON — plugin would ignore`);
    if (showRaw) console.log(msg.toString('latin1'));
    return;
  }

  const services = Array.isArray(parsed.Services)
    ? parsed.Services.map((s) => s?.Service).filter(Boolean)
    : [];
  const hasHttp = services.includes('http');
  const flags = [
    parsed.UDBMaster === true ? 'UDBMaster' : null,
    parsed.NetworkMaster === true ? 'NetworkMaster' : null,
  ].filter(Boolean);

  const entry = seen.get(rinfo.address) ?? { count: 0 };
  entry.count++;
  entry.name = parsed.Name ?? parsed.Model ?? '?';
  entry.lastSeen = Date.now();
  seen.set(rinfo.address, entry);

  log(
    `${from}  ${msg.length}B  ` +
      `Name="${parsed.Name ?? ''}" Model="${parsed.Model ?? ''}" IP=${parsed.IP ?? '?'}  ` +
      `services=[${services.join(', ')}]  ${flags.join(' ') || '-'}  ` +
      (hasHttp ? 'KEPT by plugin' : 'FILTERED (no http service)'),
  );
  if (showRaw) console.log(JSON.stringify(parsed, null, 2));
});

socket.bind(port, () => {
  const bound = socket.address();
  log(`listening on 0.0.0.0:${bound.port} (reuseAddr)`);

  // Join on the default interface plus every external IPv4 interface,
  // exactly like the plugin does.
  for (const iface of [undefined, ...ifaceAddrs]) {
    const label = iface ?? 'default interface';
    try {
      socket.addMembership(GOFREE_GROUP, iface);
      log(`joined ${GOFREE_GROUP} on ${label}`);
    } catch (err) {
      log(`FAILED to join ${GOFREE_GROUP} on ${label}: ${err.message}`);
    }
  }
  log(`waiting for GoFree announcements (MFDs send ~1/s)… Ctrl-C to stop`);
});

// Periodic heartbeat so silence is visibly "no packets" rather than a hung script.
setInterval(() => {
  if (datagrams === 0) {
    log(`still no datagrams received — check the MFD is on, on the same L2 network, and GoFree is enabled`);
    return;
  }
  const now = Date.now();
  const summary = [...seen.entries()]
    .map(([addr, e]) => `${e.name}@${addr} ×${e.count}${now - e.lastSeen > 10_000 ? ' (quiet)' : ''}`)
    .join(', ');
  log(`totals: ${datagrams} datagrams from ${seen.size} device(s): ${summary}`);
}, 15_000);
