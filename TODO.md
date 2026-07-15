# signalk-navico-routes — status

- route source should be listed as 'signalk-navico-routes'
- dont put the name in the descripion field.
- populate the timestamp field

- update default times to be a bit longer - 1m might be a bit aggressive.

- is there a way to enable routes by default?

- keep last good sync from MFD stored in local plugin storage in order to immediately serve routes and waypoints until first sync

- sync from SK -> MFD needs a lot of work
      - it seems that uploading the new file does not overwrite the entire DB, it only adds new routes.
      - it also does not overwrite existing routes
      - because of this, i think it is better to drop the automatic SignalK -> MFD sync
      - instead, we should build a web app to allow the user to select which routes to sync to the plotter
      - this will eliminate all of the circular logic problems, timeouts for editing, etc.
      
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
            - download MFD routes backup
            - download selected routes
            - upload routes to MFD

## Remaining hardware validation

- [ ] Confirm the true name-length limit on hardware (codec currently
      truncates at 32 chars; MFD files contain up to 24).

## Possible later enhancements (non-goals for v1, see SPEC §2)

- GoFree multicast auto-discovery (`239.2.1.1:2052`) instead of a static IP