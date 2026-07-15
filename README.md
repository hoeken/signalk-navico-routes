# signalk-navico-routes

Mirror **routes** and **waypoints** from Navico MFDs (B&G Zeus, Simrad NSS,
Lowrance HDS, …) into [SignalK](https://signalk.org/).

The plugin registers as a SignalK v2 **resource provider** for `routes` and
`waypoints`. It reads the MFD's user database as a **USR v6** file over the
MFD's built-in GoFree HTTP file service — no NMEA 2000, no protocol
sniffing:

```
POST http://<mfd-ip>/cgi-bin/download.cgi   → full user DB (USR v6)
POST http://<mfd-ip>/cgi-bin/upload.cgi     → replace user DB (multipart, field file1)
```

Any single MFD works as the sync peer: after an upload it propagates the
database to all other MFDs via Navico's own UDB sync.

## Features

- MFD → SignalK: periodic mirror of all routes and waypoints into
  `/signalk/v2/api/resources/routes` and `/waypoints`.
- Full USR v6 codec (parser + serializer), reverse-engineered and tested
  against real Zeus3S databases — see [docs/usr-v6-format.md](docs/usr-v6-format.md).
- USR file generation from SignalK resources, with unchanged records
  round-tripping **byte-identically**.
- A bundled **webapp** for manual SignalK → MFD transfer (see below).

## Why no automatic SignalK → MFD sync?

Uploading a USR file only **adds** routes and waypoints on the MFD — it
neither overwrites nor deletes existing records. A bidirectional mirror
therefore cannot converge, so the provider is a **read-only mirror**:
writes through the resources API are rejected. Pushing selected routes to
the MFD is a manual, user-driven operation through the bundled webapp.

## Webapp

Open **Navico Routes** from the SignalK admin UI's _Webapps_ screen (served
at `/signalk-navico-routes`). It lists every SignalK route that is _not_
already mirrored from the MFD — i.e. routes from other providers — in a
sortable, searchable table, and lets you:

- **Sync MFD → SignalK** — trigger an immediate download and mirror.
- **Download MFD backup** — save the MFD's complete user database as a
  `.usr` file (do this before experimenting; uploads cannot be undone).
- **Download selected as USR** — export the selected SignalK routes as a
  USR v6 file, e.g. to import on another chartplotter.
- **Send selected to MFD** — upload the selected routes to the MFD. The
  plugin archives a fresh backup of the MFD database first (in the plugin
  data directory under `archive/`), and afterwards leaves the pushed routes
  to their owning provider instead of mirroring a duplicate back.

Route names are editable in the table and capped at 16 characters (the MFD
on-screen keyboard limit); the SignalK side keeps the full name. The page
follows a `?mode=day` / `?mode=night` query parameter, then the OS theme,
and has an in-page day/night toggle.

The API behind the webapp is mounted at `/plugins/signalk-navico-routes`
(`POST /api/sync`, `GET /api/backup`, `POST /api/usr`, `POST /api/upload`).

Remember that uploads are **additive**: re-sending an edited route adds a
record rather than replacing the old one; delete outdated copies on the MFD
itself.

## Configuration

| Setting               | Default | Description                                    |
| --------------------- | ------- | ---------------------------------------------- |
| `mfdAddress`          | —       | IP/hostname of the MFD to sync with (required) |
| `syncFromMfd`         | `true`  | Enable MFD → SignalK mirror                    |
| `pollIntervalSeconds` | `60`    | USR download cadence (min 15)                  |

## Sync semantics

- **The MFD is the truth.** Downloads mirror the MFD database into
  SignalK, including deletions.
- Waypoints that only serve as route legs are represented by the route's
  LineString alone; only free-standing waypoints are published as SignalK
  waypoints.
- The last good download is cached and served immediately on startup,
  before the first poll.

## Known limitations (v1)

1. One static MFD address; no GoFree auto-discovery, no multi-MFD failover.
2. Names longer than 32 characters are truncated when generating a USR
   file (`~1`, `~2`, … on collision). The SignalK side keeps the full name.
3. The id ↔ MFD-record mapping is persisted in the plugin data directory
   (`navico-id-map.json`).

## Development

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

### Hardware smoke test

With a real MFD on the network:

```
npm run build
node scripts/smoke-test.js <mfd-ip>            # download → parse → serialize → verify
node scripts/smoke-test.js <mfd-ip> --upload   # …then upload the regenerated file,
                                               # re-download and diff (destroys trails!)
```

## How it works

Findings from the protocol research (see `research/NOTES.md`): Navico MFDs
sync routes over a unicast "UDB" protocol that is invisible on a switched
network and unnecessary to reverse — every MFD serves its complete user
database over HTTP as a USR v6 file and accepts one back, propagating it to
the fleet. This plugin is therefore just a careful USR v6 codec plus sync
bookkeeping. The full byte-level format documentation lives in
[docs/usr-v6-format.md](docs/usr-v6-format.md).
