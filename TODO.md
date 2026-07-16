# signalk-navico-routes — status

- icon
- screenshots
- readme -> user facing
- readme -> split out developer stuff in to separate doc

- route names should show as a text input at all times so the user knows it is editable.

Webapp changes:
- admin UI -> React UI
  - MFD -> SK specific options nested
  - specific options should enable based on if the parent option is enabled.

## Remaining hardware validation

- [ ] Confirm the true name-length limit on hardware (codec currently truncates at 32 chars; MFD files contain up to 24).

## Possible later enhancements (non-goals for v1, see SPEC §2)

- GoFree multicast auto-discovery (`239.2.1.1:2052`) instead of a static IP
