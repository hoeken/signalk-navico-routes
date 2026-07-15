# signalk-navico-routes — status

- update default times to be a bit longer - 1m might be a bit aggressive.

- webapp specs:
  - the webapp should pull all non signalk-navico-routes routes from the v2 api
  - present them to the user as a sortable and searchable table, no pagination
  - use the preact framework with a minimum target of chromium 69
  - global select/deselect all
  - columns:
    - checkbox w/ no label to choose which routes to send
    - timestamp
    - name (editable, max length 16 chars, truncated if needed)
    - waypoints
    - length
  
  - control buttons at top and bottom to:
    - trigger MFD -> SK Sync
    - download MFD routes backup
    - download selected routes as USR
    - Sync selected routes SK -> MFD

## Remaining hardware validation

- [ ] Confirm the true name-length limit on hardware (codec currently truncates at 32 chars; MFD files contain up to 24).

## Possible later enhancements (non-goals for v1, see SPEC §2)

- GoFree multicast auto-discovery (`239.2.1.1:2052`) instead of a static IP