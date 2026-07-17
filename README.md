# Navico Route Sync (signalk-navico-routes)

Sync the **routes** and **waypoints** from your Navico chartplotter — B&G
Zeus, Simrad NSS/NSX, Lowrance HDS, etc to [SignalK](https://signalk.org/),
and send routes from SignalK back to the chartplotter when you choose.

The plugin talks to the chartplotter over your boat's regular Ethernet/Wi-Fi
network using the MFD's built-in file service. No NMEA 2000 gateway or extra
hardware is needed — just the MFD and the SignalK server on the same network.

## Features

- **Automatic MFD → SignalK mirror.** All routes and waypoints on the
  chartplotter appear in SignalK's standard resources API
  (`/signalk/v2/api/resources/routes` and `/waypoints`), refreshed on a
  configurable schedule, so any SignalK app (Freeboard, etc.) can display them.
- **Multi-MFD friendly.** Point the plugin at any one chartplotter; Navico's
  own sync spreads uploads to the rest of the network.
- **A webapp for sending routes the other way.** Pick routes from SignalK
  and push them to the chartplotter, or download backups and GPX exports —
  all from the SignalK admin UI. With [signalk-navico-embedder](http://npmjs.com/signalk-navico-embedder) you can manage the sync from the MFD itself.

## Installation

Install **Navico Route Sync** from the SignalK Appstore (or `npm install
signalk-navico-routes` in your server directory), then enable it under
**Server → Plugin Config**. Chartplotters on the network are discovered
automatically; you can also pin one by IP address.

## Configuration

| Setting                 | Default | Description                                             |
| ----------------------- | ------- | ------------------------------------------------------- |
| `mfdAddress`            | —       | IP address or hostname of the chartplotter. Leave empty to auto-discover (see below) |
| `syncFromMfd`           | `true`  | Enable the MFD → SignalK mirror                         |
| `syncRoutes`            | `true`  | Mirror MFD routes into SignalK                          |
| `syncVisibleRoutesOnly` | `true`  | Skip routes that are hidden on the MFD                  |
| `syncWaypoints`         | `true`  | Mirror free-standing MFD waypoints                      |
| `pollIntervalSeconds`   | `600`   | How often to refresh from the MFD, in seconds (min 30; 0 turns polling off) |

### Auto-discovery

Navico chartplotters announce themselves on the network (GoFree multicast)
about once a second, and the plugin listens the whole time it runs. The
config panel lists every discovered chartplotter with its role
(master/slave) — click one to fill in the address field, or leave the field
empty and the plugin syncs with whatever it finds: the master first, falling
back to the others if it doesn't answer. Chartplotters that turn on or off
while the plugin is running appear and disappear from the list on their own.

With an empty address there is nothing to reconfigure when your boat
network hands out new DHCP leases. If you do pin an address, give the
chartplotter a static IP (or a DHCP reservation in your router) so it
stays valid.

**No chartplotters showing up?** Run `node scripts/gofree-watch.mjs` on the
SignalK machine — it listens the same way the plugin does and prints every
announcement it hears, so you can tell "nothing on the wire" apart from a
receive problem. One known receive problem: the Raspberry Pi 4's onboard
Ethernet can silently drop multicast even though everything is configured
correctly. If the watch script hears nothing while
`sudo tcpdump -i eth0 host 239.2.1.1` shows traffic, that's it — running
tcpdump itself (or `sudo ifconfig eth0 allmulti`) resets the network
interface's filter and discovery starts working.

## How syncing works

**The chartplotter is the source of truth.** The plugin periodically
downloads the MFD's user database and mirrors it into SignalK — including
deletions, so removing a route on the MFD removes it from SignalK too. The
routes and waypoints it mirrors are read-only in SignalK; you can't edit
them through the resources API.

Going the other direction is deliberately manual: Navico chartplotters only
ever **add** routes from an upload — they never overwrite or delete existing
ones — so a fully automatic two-way sync isn't possible. Instead, you choose
which routes to send using the webapp.

## The webapp

Open **Navico Routes** from the _Webapps_ screen in the SignalK admin UI. It
lists every SignalK route that didn't come from the chartplotter (e.g.
routes you planned in another app) in a sortable, searchable table, and lets
you:

- **Sync MFD → SignalK** — refresh from the chartplotter right now instead
  of waiting for the next scheduled poll.
- **Download MFD routes** — save the chartplotter's complete user database
  as a `.usr` backup, or its routes and waypoints as a `.gpx` file.
- **Download selected** — export the routes you've selected as a `.usr`
  file (to import on another Navico chartplotter via SD card) or as GPX.
- **Send selected to MFD** — upload the selected routes straight to the
  chartplotter.

A few things worth knowing:

- **Uploads are additive.** Sending an edited route again creates a second
  copy on the chartplotter rather than replacing the first — delete the
  outdated copy on the MFD itself.
- **Back up first.** Uploads can't be undone, so grab a `.usr` backup
  before sending anything you're unsure about.
- **Route names** are editable in the table and capped at 16 characters
  (the MFD's on-screen keyboard limit). SignalK keeps the full name, and
  GPX exports use it unless you renamed the route in the table.
- The page has a day/night toggle and also follows your OS theme (or a
  `?mode=day` / `?mode=night` URL parameter).

## Known limitations

1. Route and waypoint names longer than 32 characters are shortened when
   sent to the chartplotter; SignalK keeps the full name.

## For developers

Build instructions, the plugin's HTTP API, protocol research notes, and the
reverse-engineered USR v6 file format are documented in
[docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) and
[docs/usr-v6-format.md](docs/usr-v6-format.md).

## License

See [LICENSE](LICENSE).
