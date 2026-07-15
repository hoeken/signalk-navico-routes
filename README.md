# signalk-navico-routes

Synchronize **routes** and **waypoints** between Navico MFDs (B&G Zeus,
Simrad NSS, Lowrance HDS, …) and [SignalK](https://signalk.org/).

The plugin registers as a SignalK v2 **resource provider** for `routes` and
`waypoints`. It reads and writes the MFD's user database as a **USR v6**
file over the MFD's built-in GoFree HTTP file service — no NMEA 2000, no
protocol sniffing:

```
POST http://<mfd-ip>/cgi-bin/download.cgi   → full user DB (USR v6)
POST http://<mfd-ip>/cgi-bin/upload.cgi     → replace user DB (multipart, field file1)
```

Any single MFD works as the sync peer: after an upload it propagates the
database to all other MFDs via Navico's own UDB sync.

## Features

- MFD → SignalK: periodic mirror of all routes and waypoints into
  `/signalk/v2/api/resources/routes` and `/waypoints`.
- SignalK → MFD (optional): changes made through the resources API are
  uploaded back, debounced and rate-limited.
- Full USR v6 codec (parser + serializer), reverse-engineered and tested
  against real Zeus3S databases — see [docs/usr-v6-format.md](docs/usr-v6-format.md).
- Unchanged records round-trip **byte-identically**: an upload never
  rewrites what it doesn't have to.
- Timestamped backups of every downloaded database before any upload
  (plugin data directory, `usr-archive/`, last 20 kept).

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `mfdAddress` | — | IP/hostname of the MFD to sync with (required) |
| `syncFromMfd` | `true` | Enable MFD → SignalK mirror |
| `syncToMfd` | `false` | Enable SignalK → MFD upload |
| `pollIntervalSeconds` | `60` | USR download cadence (min 15) |
| `uploadQuietSeconds` | `10` | Debounce: wait for this much quiet before uploading |
| `uploadMinIntervalSeconds` | `60` | Hard floor between uploads; changes coalesce, never lost |

## Sync semantics

- **The MFD wins by default.** Downloads mirror the MFD database into
  SignalK, including deletions.
- **SignalK edits are protected** until confirmed: a change made through
  the resources API is held in a pending-edit ledger, uploaded, and only
  released once a subsequent download reflects it. Until then the mirror
  cannot overwrite it, and the plugin re-uploads with backoff (5 s / 30 s /
  2 min).
- **Resources owned by other providers** are included in uploads (so the
  MFD sees them) but never mirrored back into this provider (so they don't
  duplicate). For those resources SignalK is authoritative: MFD-side edits
  to them are overwritten by the next upload.
- Uploads are whole-database writes: they are debounced
  (`uploadQuietSeconds`) and rate-limited (`uploadMinIntervalSeconds`), and
  a record-identical upload is skipped entirely.

## Known limitations (v1)

1. **Uploads erase trails.** The regenerated USR file contains only routes
   and waypoints, and `upload.cgi` replaces the whole database. The plugin
   archives every downloaded database first (plugin data dir,
   `usr-archive/`); restore trails by re-uploading a backup through the
   MFD's own web page (`http://<mfd-ip>/`). Do not enable `syncToMfd` if
   your trails are precious and unexported.
2. The pending-edit ledger is in memory only: after a plugin/server
   restart, unconfirmed SignalK edits are lost and the MFD state wins.
3. One static MFD address; no GoFree auto-discovery, no multi-MFD failover.
4. With `syncToMfd` off, resources written to this provider live in memory
   only and are removed by the next MFD mirror.
5. Names longer than 32 characters are truncated on upload (`~1`, `~2`, …
   on collision). The SignalK side keeps the full name.
6. The id ↔ MFD-record mapping is persisted in the plugin data directory
   (`navico-id-map.json`); deleting it while `syncToMfd` is enabled can
   duplicate SignalK-originated records after the next upload/download
   cycle.

## Development

```
npm install
npm run ci        # lint + test + build
```

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
