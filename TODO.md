# signalk-navico-routes — status

- update default times to be a bit longer - 1m might be a bit aggressive.

- add plugin options under MFD -> SK sync:
  - sync routes (boolean, default true)
  - sync visible routes only (boolean, default true)
  - sync waypoints (boolean, default true)

## Remaining hardware validation

- [ ] Confirm the true name-length limit on hardware (codec currently truncates at 32 chars; MFD files contain up to 24).

## Possible later enhancements (non-goals for v1, see SPEC §2)

- GoFree multicast auto-discovery (`239.2.1.1:2052`) instead of a static IP
