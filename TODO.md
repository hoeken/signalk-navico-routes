# signalk-navico-routes — status

- update default times to be a bit longer - 1m might be a bit aggressive.

## Remaining hardware validation

- [ ] Confirm the true name-length limit on hardware (codec currently truncates at 32 chars; MFD files contain up to 24).

## Possible later enhancements (non-goals for v1, see SPEC §2)

- GoFree multicast auto-discovery (`239.2.1.1:2052`) instead of a static IP
