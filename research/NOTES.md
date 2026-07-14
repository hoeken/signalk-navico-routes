# Navico route-sync — findings

## TL;DR (solved)

Navico MFDs sync routes/waypoints/trails over ethernet via a **unicast UDB
protocol** coordinated by the **UDBMaster**. That traffic is unicast, so a Pi on
a **switched** network never sees it (confirmed: zero MFD↔MFD unicast reaches
us) — and the names are **UTF-16LE**, so ASCII sniffing would miss them anyway.

**We do not need to reverse the sync protocol.** Every MFD exposes an HTTP file
server that serves its entire user database as a **USR v6** file, and accepts
one back. That is the plugin's read/write path, and it works against *any* MFD.

## Evidence chain

1. Passive sniff → only broadcast/multicast reaches the Pi: GoFree discovery
   (`239.2.1.1:2052` JSON), N2K-over-eth databus (`236.6.7.x`, `169.254.x`
   `255.255.255.255:1075x` binary), sonar (`:10754`). No route names, ever.
2. GoFree announcement advertises `NavigationSupportDynamicRoutesWaypointsOverUDB:true`
   and a `UDBMaster` flag → routes ride Navico's Unified DataBase (UDB).
3. Beacon test: editing `TESTTEST`/`SAVUSAVU 2 NANAK` on the MFDs produced **no**
   ethernet hits (the one SAVUSAVU hit was a manual upload to SignalK — a red
   herring served by SignalK's own resources API to the MFD browser).
4. User test: disconnect an MFD's ethernet → edits stop propagating; reconnect →
   sync resumes. So sync **is** ethernet, not N2K. (can0 carries live nav PGNs
   but not the route-service PGNs during edits.)
5. Pi sees **zero unicast between MFDs** → sync is unicast, hidden by the switch.
6. MFD `http://<mfd>/` = GoFree "File Download/Upload" page with
   `cgi-bin/download.cgi` (**Download USR File**) and `cgi-bin/upload.cgi`.
7. `POST cgi-bin/download.cgi` → 3.3 MB `application/octet-stream`, magic
   "Navico export data file", **format version 6**, "Waypoints, routes, and
   trails". Contains `SAVUSAVU`, `NANAK`, `TESTTEST`, `TEST` — all **UTF-16LE**.
8. Both master (192.168.2.113) and slave (192.168.2.110) serve their USR and
   both contain the same routes → in sync, and readable from any MFD.

## Devices

| LAN IP        | Zeroconf        | Model     | NetworkMaster | UDBMaster |
|---------------|-----------------|-----------|---------------|-----------|
| 192.168.2.113 | 169.254.144.69  | Zeus3S 16 | true          | **true**  |
| 192.168.2.110 | 169.254.212.71  | Zeus3S 9  | false         | false     |
| 192.168.2.109 | —               | H5000 CPU | —             | —         |

Discover MFDs by listening to `239.2.1.1:2052` (GoFree announcement JSON:
`IP`, `Model`, `UDBMaster`, `Services[]`, and the UDB flag).

## MFD service surface (per MFD, all TCP)

21 ftp · 80 http (GoFree file server) · 111 rpcbind · 271 · 288 · 298 ·
554 rtsp · 2053 navico-nav-ws · 6633 navico-mfd-rp · 10110 nmea-0183.
(6633/271/288/298 are the likely unicast UDB channels — not needed.)

## Access API (the plugin's foundation)

Read every MFD's user DB:
```
curl -m 45 -X POST http://<mfd-ip>/cgi-bin/download.cgi -o mfd.usr    # USR v6
```
Write it back (MFD then propagates via its own UDB sync):
```
curl -F file1=@mfd.usr http://<mfd-ip>/cgi-bin/upload.cgi
```
Slave `download.cgi` can take ~7 s to generate — use a generous timeout.

## USR v6 format (in progress)

Little-endian throughout. Header:
`u32 version(=6)` · `u32 (=10?)` · `u32 len + "Navico export data file"` ·
`u32 len + "DD/MM/YYYY"` · then a UID/serial block · `u32 len + "Waypoints,
routes, and trails"` · then waypoint / route / trail sections.
Names are `u32 byteLen + UTF-16LE`. A recurring 4-byte tag `09 6f 75 30`
("ou0") marks records/UIDs. Reference: GPSBabel `lowranceusr` (usr formats 2-6).

## Recommended plugin architecture

- **Discover**: listen on `239.2.1.1:2052`, collect MFDs + `UDBMaster`.
- **Read**: `POST download.cgi` on each MFD, parse USR v6 → SignalK resources
  (`/signalk/v2/api/resources/routes`, `/waypoints`).
- **Write**: build USR v6 from SignalK resources, `POST upload.cgi` to the
  UDBMaster (or any MFD); it syncs to the rest.
- **Coords sanity**: SAVUSAVU/NANAK are in Fiji (~179.3°E, ~16.8°S) — the
  SignalK copy showed `[179.32534291, -16.x]`, so v6 stores real lat/lon.

## Research tooling (research/)

- `watch.py` / `capture.sh` / `analyze.py` — ethernet pcap capture + search
  (searches ASCII + UTF-16LE/BE). Useful for discovery, not for the sync data.
- `captures/` — pcaps + `mfd113.usr`, `mfd110.usr` sample databases (gitignored).
