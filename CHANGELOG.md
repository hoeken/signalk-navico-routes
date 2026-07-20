# Changelog

## v1.0.0

Initial release of **Navico Route Sync** — keep the routes and waypoints on
your Navico chartplotter (B&G Zeus, Simrad NSS/NSX, Lowrance HDS, …) in sync
with [SignalK](https://signalk.org/), with no NMEA 2000 gateway or extra
hardware. Just the MFD and your SignalK server on the same network.

### Highlights

- **Automatic chartplotter discovery.** The plugin listens for Navico's
  GoFree announcements and finds every MFD on your network by itself — no
  IP addresses to look up. The config panel shows what it found (including
  master/slave roles); click one to use it, or leave the address empty and
  the plugin picks the master automatically.

- **MFD → SignalK mirror.** All routes and waypoints on the chartplotter
  appear in SignalK's standard resources API on a configurable schedule
  (every 10 minutes by default), so apps like Freeboard can display them.
  The chartplotter stays the source of truth — deletions are mirrored too.

- **Send routes back to the chartplotter.** A webapp in the SignalK admin
  UI lists routes you planned elsewhere in a sortable, searchable table.
  Select the ones you want and upload them straight to the MFD — Navico's
  own sync then spreads them to any other chartplotters on board.

- **Backups and exports.** Download the chartplotter's complete user
  database as a `.usr` backup, or export routes and waypoints as GPX. You
  can also export just your selected routes as `.usr` for SD-card import
  on another Navico chartplotter.

- **Fits your helm.** The webapp has a day/night toggle and follows your
  OS theme. Route names are editable in the table and kept within the
  MFD's 16-character on-screen limit, while SignalK keeps the full name.

### Good to know

- Uploads to the chartplotter are **additive** — sending an edited route
  again creates a second copy rather than replacing the original. Grab a
  `.usr` backup before uploading anything you're unsure about.
