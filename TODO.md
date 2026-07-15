# signalk-navico-routes — status

The plugin described in [SPEC.md](SPEC.md) is implemented (M1–M6):

- [x] USR v6 codec (parse + serialize), byte-exact against real Zeus3S captures
- [x] SignalK v2 resource provider for routes and waypoints
- [x] MFD → SignalK mirror sync (poll, full-mirror deletion, error resilience)
- [x] SignalK → MFD upload (pending-edit ledger, debounce + rate floor,
      confirmation, echo suppression / loop prevention, USR archive)
- [x] Foreign-provider resource handling (ResourceWatcher)
- [x] 84 tests green (`npm run ci`), format documented in docs/usr-v6-format.md
- [x] Read-only hardware smoke test passed against Zeus3S 192.168.2.110
      (808 waypoints / 60 routes, serialize round-trip byte-identical)

## Remaining hardware validation

- [ ] `node scripts/smoke-test.js <mfd-ip> --upload` — full upload round trip.
      **Erases trails** (a backup .usr is written first). Verifies the MFD
      accepts a regenerated file and preserves all records.
- [ ] Verify UDB propagation: upload to one MFD, confirm the other shows the
      change.
- [ ] Create a route/waypoint in SignalK, confirm it appears on both MFDs and
      survives an MFD-side edit cycle.
- [ ] Confirm the true name-length limit on hardware (codec currently
      truncates at 32 chars; MFD files contain up to 24).

## Possible later enhancements (non-goals for v1, see SPEC §2)

- GoFree multicast auto-discovery (`239.2.1.1:2052`) instead of a static IP
- Trail → SignalK track import (read-only would avoid the erase problem)
- Persist the pending-edit ledger across restarts
