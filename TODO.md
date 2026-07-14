signalk-navico-routes

- signalk plugin to synchronize routes and waypoints between Navico MFDs (B&G, etc).
  - currently routes are synced between any number of Navico MFDs over the network.
  - they are connected by both ethernet and nmea2000
  - it appears that the routes are being synced over the ethernet network.
  - any mfd can update the other mfds, and multiple mfds can be on the network
  - they are likely using some sort of UDP multicast to publish route information.
    - a different feature uses JSON over UDP to announce available webapps, so they might re-use this pattern here.
  - to start, lets write a script to capture all UDP traffic from 192.168.2.110
  - during testing, I will update a route with the name 'SAVUSAVU 2 NANAK' which should help us find the appropriate data


- construct routes into signalk compliant data
- publish routes as signalk routes provider
- optionally re-publish routes back to navico
- also synchronize waypoints