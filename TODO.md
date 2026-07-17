# 1.0.0

- screenshots
- Confirm the true name-length limit on hardware (codec currently truncates at 32 chars; MFD files contain up to 24).

- allow poll interval to be zero = automatic syncing disabled.
  - we still want to enable manual syncing MFD -> SK
  - change the description verbiage on the top level option
  - keep the minimum 15s for >0 values

- add discovered MFD ip addresses to the ip address section
  - use GoFree multicast auto-discovery (`239.2.1.1:2052`) to show ip addresses and role (master/slave)
  - if ip address is empty, use auto-discovered ip MFD addresses