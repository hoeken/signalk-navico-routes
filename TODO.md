# 1.0.0

- screenshots
- Confirm the true name-length limit on hardware (codec currently truncates at 32 chars; MFD files contain up to 24).

- add discovered MFD ip addresses to the ip address section
  - use GoFree multicast auto-discovery (`239.2.1.1:2052`) to show ip addresses and role (master/slave) (see research/NOTES.md)
  - we need to listen continuously as mfds can be turned on and off while plugin is running
  - if ip address is empty, use auto-discovered ip MFD addresses
  - start with master, fall back to slaves on timeout