# 1.0.0

- screenshots
- readme -> user facing
- readme -> split out developer stuff in to separate doc
- Confirm the true name-length limit on hardware (codec currently truncates at 32 chars; MFD files contain up to 24).


## Long Term

Webapp changes:
- admin UI -> React UI
  - MFD -> SK specific options nested
  - specific options should enable based on if the parent option is enabled.

- GoFree multicast auto-discovery (`239.2.1.1:2052`) instead of a static IP