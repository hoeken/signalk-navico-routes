# signalk-navico-routes — status

- update default times to be a bit longer - 1m might be a bit aggressive.

update route object ordering to match resources provider:

{
  "f7c67fa4-f0be-406d-9abb-382255536be6": {
    "name": "AAA SK TEST",
    "description": "",
    "distance": 2433,
    "feature": {
      "type": "Feature",
      "geometry": {
        "type": "LineString",
        "coordinates": [
          [178.224666380646, -17.3122949059827],
          [178.22786892537, -17.3144185270411],
          [178.224158981839, -17.3189464956369],
          [178.219310270423, -17.316318781149],
          [178.223770227909, -17.3118926673278],
          [178.224600989733, -17.3114307184393]
        ]
      },
      "properties": {

      },
      "id": ""
    },
    "timestamp": "2026-07-15T20:50:38.260Z",
    "$source": "resources-provider"
  }
}

update waypoint object ordering to match resources provider:




- [x] automatic SignalK -> MFD sync removed (2026-07-16)
      - uploading a USR file only adds new routes/waypoints; it does not
        overwrite or delete existing records, so a 2-way mirror can't converge
      - the provider is now a read-only MFD -> SignalK mirror
        (syncToMfd/upload throttle options, pending-edit ledger,
        ResourceWatcher and foreign-resource tracking are gone)
      - kept for the manual sync path: buildUsrDatabase, serializeUsr,
        MfdClient.upload, UsrArchive
      
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