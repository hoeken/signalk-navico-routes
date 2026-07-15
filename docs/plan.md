# signalk-navico-routes

This is a plugin for SignalK. It is intended to synchronize routes and waypoints between Navico MFDs and SignalK. The plugin should register as a resource provider for both routes and waypoints. Follow the SignalK documentation on resource providers: https://demo.signalk.org/documentation/Developing/Plugins/Resource_Providers.html

Plugin development should be test driven and every major features should be tested. The plugin should be in typescript and support a minimum of node 20. Use modern development practices to produce a high quality plugin. The plugin should be linted with eslint and/or prettify. There will not be a web app associated with this plugin.

Based on our research/NOTES.md, we can both read and write the entire route DB on the MFD. We will need to fully reverse engineer the USR v6 format.

For plugin configuration, we should have boolean options to enable syncing from MFD -> SignalK and from SignalK -> MFD. We should also have an input for the IP address of the MFD to sync with.

For syncing to SignalK we need to load from the MFD periodically and keep the routes in memory. MFD routes should always overwrite our own local copies of the MFD routes.

For syncing from SignalK to the MFD, we should probably subscribe to the resources stream to get changes dynamically. On change, we should generate and upload the new database to the MFD. We need to be aware of the limitations of the MFD, such as route names having a max length of 16 characters.

The same concept applies to waypoints.
