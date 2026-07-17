# Development guide

Technical documentation for people working on the plugin itself. For
installation and usage, see the [README](../README.md).

## How it works

The plugin registers as a SignalK v2 **resource provider** for `routes` and
`waypoints`. It reads the MFD's user database as a **USR v6** file over the
MFD's built-in GoFree HTTP file service — no NMEA 2000, no protocol
sniffing:

```
POST http://<mfd-ip>/cgi-bin/download.cgi   → full user DB (USR v6)
POST http://<mfd-ip>/cgi-bin/upload.cgi     → add records to user DB (multipart, field file1)
```

Any single MFD works as the sync peer: after an upload it propagates the
database to all other MFDs via Navico's own UDB sync.

Findings from the protocol research (see `research/NOTES.md`): Navico MFDs
sync routes over a unicast "UDB" protocol that is invisible on a switched
network and unnecessary to reverse — every MFD serves its complete user
database over HTTP as a USR v6 file and accepts one back, propagating it to
the fleet. This plugin is therefore just a careful USR v6 codec plus sync
bookkeeping.

### USR v6 codec

The plugin contains a full USR v6 parser and serializer, reverse-engineered
and tested against real Zeus3S databases. Unchanged records round-trip
**byte-identically**. The byte-level format documentation lives in
[usr-v6-format.md](usr-v6-format.md).

### Why the resource provider is read-only

Uploading a USR file only **adds** routes and waypoints on the MFD — it
neither overwrites nor deletes existing records. A bidirectional mirror
therefore cannot converge, so writes through the resources API are
rejected, and SignalK → MFD transfer is a manual, user-driven operation
through the webapp.

### Sync internals

- Waypoints that only serve as route legs are represented by the route's
  LineString alone; only free-standing waypoints are published as SignalK
  waypoints. This holds even when a route itself is filtered out (hidden,
  or route sync disabled): its legs stay unpublished.
- The last good download is cached and served immediately on startup,
  before the first poll.
- The id ↔ MFD-record mapping is persisted in the plugin data directory
  (`navico-id-map.json`).
- Names longer than 32 characters are truncated when generating a USR file
  (`~1`, `~2`, … on collision). The SignalK side keeps the full name.

## Plugin HTTP API

The API behind the webapp is mounted at `/plugins/signalk-navico-routes`:

| Endpoint                       | Description                                    |
| ------------------------------ | ---------------------------------------------- |
| `POST /api/sync`               | Trigger an immediate MFD download and mirror   |
| `GET /api/backup?format=usr\|gpx` | Download the MFD user DB as `.usr` or `.gpx` |
| `POST /api/export`             | Export selected SignalK routes as USR/GPX      |
| `POST /api/upload`             | Upload selected routes to the MFD              |

## Building and testing

```
npm install
npm run ci        # lint + webapp typecheck + test + build
```

The webapp lives in `webapp/` (Preact + TypeScript) and is bundled by
esbuild into `public/` (`npm run build:webapp`), targeting **Chromium 69**
so it runs on embedded MFD browsers.

Tests that depend on captured MFD databases (`research/captures/*.usr`,
gitignored) skip automatically when the files are absent; everything else
runs from synthetic fixtures.

## Hardware smoke test

With a real MFD on the network:

```
npm run build
node scripts/smoke-test.js <mfd-ip>            # download → parse → serialize → verify
node scripts/smoke-test.js <mfd-ip> --upload   # …then upload the regenerated file,
                                               # re-download and diff (destroys trails!)
```
