# SPEC — signalk-navico-routes

> **Revision note (2026-07):** hardware testing showed that `upload.cgi`
> only **adds** routes/waypoints to the MFD database — it neither
> overwrites nor deletes existing records — so a bidirectional mirror
> cannot converge. Automatic SignalK → MFD sync has been **removed**: the
> resource provider is now a read-only MFD → SignalK mirror, and pushing
> resources to the MFD is a manual, user-driven operation through the
> bundled webapp (`webapp/`, served from `public/`; API in
> `src/webapp-api.ts`). The sections below on
> `syncToMfd`, upload throttling, foreign resources, the pending-edit
> conflict model, echo suppression and the `ResourceWatcher` describe the
> superseded design and are kept for reference; the USR codec and
> `buildUsrDatabase` remain current and will power the manual upload path.

A SignalK server plugin that synchronizes **routes** and **waypoints** between
Navico MFDs (B&G Zeus, Simrad NSS, Lowrance HDS, …) and SignalK. The plugin
registers as a SignalK **resource provider** for `routes` and `waypoints`, and
uses each MFD's built-in GoFree HTTP file service to read and write the MFD's
user database as a **USR v6** file.

Grounded in the findings of [research/NOTES.md](research/NOTES.md):

- `POST http://<mfd-ip>/cgi-bin/download.cgi` → full user DB as USR v6
  (`application/octet-stream`, magic `"Navico export data file"`, version 6).
- `POST http://<mfd-ip>/cgi-bin/upload.cgi` (multipart, field `file1`) →
  replaces the MFD's user DB; the MFD then propagates it to all other MFDs via
  its own UDB sync.
- No sniffing or UDB protocol work is needed; HTTP file transfer is the entire
  transport.

## 1. Goals

1. Expose the MFD's routes and waypoints as SignalK resources
   (`/signalk/v2/api/resources/routes`, `/signalk/v2/api/resources/waypoints`).
2. Optionally push SignalK route/waypoint changes back to the MFD.
3. Fully implement a USR v6 **codec** (parser + serializer) for waypoints and
   routes, developed test-first against captured fixture files.
4. Be a high-quality, modern TypeScript plugin: typed, linted, formatted,
   thoroughly tested, no runtime surprises.

## 2. Non-goals

- **Trails** are not synchronized (see §7 Known limitations — they are _lost_
  on upload; a backup mechanism mitigates this).
- No MFD auto-discovery in v1 (GoFree multicast discovery is a possible later
  enhancement); the MFD is addressed by a single configured IP.
- No web app / UI beyond the standard SignalK plugin config screen.
- No NMEA 2000 involvement; sync is HTTP-over-ethernet only.

## 3. Requirements

- **Language**: TypeScript (strict mode), compiled to Node-compatible JS.
- **Runtime**: Node.js ≥ 20 (`engines.node: ">=20"`).
- **SignalK**: implements the v2 Resource Provider API per the
  [SignalK resource provider docs](https://demo.signalk.org/documentation/Developing/Plugins/Resource_Providers.html).
- **Quality**: ESLint + Prettier, CI-runnable `lint`, `test`, `build` scripts.
- **Testing**: test-driven development; every major feature has tests (§10).

## 4. Configuration

Plugin config schema (JSON Schema, rendered by the SignalK admin UI):

| Key                        | Type    | Default | Description                                                                                                                                             |
| -------------------------- | ------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mfdAddress`               | string  | —       | IP address (or hostname) of the MFD to sync with. Required. Any MFD works; it propagates changes to the rest via UDB.                                   |
| `syncFromMfd`              | boolean | `true`  | Enable MFD → SignalK sync (periodic USR download).                                                                                                      |
| `syncToMfd`                | boolean | `false` | Enable SignalK → MFD sync (USR upload on resource change).                                                                                              |
| `pollIntervalSeconds`      | number  | `300`   | How often to download the USR file from the MFD. Minimum 15.                                                                                            |
| `uploadQuietSeconds`       | number  | `10`    | Debounce: wait for this many seconds of no further resource changes before uploading, so a burst of small edits coalesces into one upload.              |
| `uploadMinIntervalSeconds` | number  | `60`    | Throttle: hard floor between consecutive uploads, even if changes keep arriving. Changes are never lost — they coalesce into the next permitted upload. |

Notes:

- If both booleans are false the plugin starts but does nothing except log a
  warning.
- `syncToMfd` without `syncFromMfd` is allowed but discouraged (the plugin
  cannot confirm uploads landed); log a warning.

## 5. Architecture

```
┌──────────────────────────── plugin ────────────────────────────┐
│                                                                │
│  ResourceProvider (routes, waypoints)                          │
│    list/get ──► ResourceStore (in-memory, MFD-originated)      │
│    set/delete ─► ResourceStore + PendingEdits ─► SyncEngine    │
│                                                                │
│  ResourceWatcher (delta stream: resources.routes.*,            │
│                   resources.waypoints.*)                       │
│    change to a resource we don't own ─► mark dirty ─► SyncEngine│
│    (own-store echoes filtered out — loop prevention)           │
│                                                                │
│  SyncEngine                                                    │
│    poll timer ─► MfdClient.download() ─► UsrCodec.parse()      │
│                   └► merge into ResourceStore (MFD wins,       │
│                      except pending edits & foreign resources) │
│    throttled upload ─► UsrCodec.serialize(store ∪ foreign)     │
│                   └► MfdClient.upload()                        │
│                                                                │
│  MfdClient (HTTP: download.cgi / upload.cgi)                   │
│  UsrCodec  (USR v6 parse/serialize, pure, no I/O)              │
│  UsrArchive (backs up downloaded USR files before uploads)     │
└────────────────────────────────────────────────────────────────┘
```

### Modules

- **`UsrCodec`** — pure functions over `Buffer`/`Uint8Array`:
  `parseUsr(buf): UsrDatabase` and `serializeUsr(db): Buffer`. No I/O, no
  SignalK types; operates on its own `UsrWaypoint` / `UsrRoute` model. This is
  the reverse-engineering core (§6) and the most heavily tested module.
- **`Mapper`** — pure conversion between the codec model and SignalK resource
  types (§8), including name-length enforcement and ID mapping.
- **`MfdClient`** — thin HTTP client around the two CGI endpoints. Download
  timeout ≥ 45 s (slave MFDs take ~7 s just to generate the file). Upload as
  `multipart/form-data`, field name `file1`.
- **`ResourceStore`** — in-memory maps `id → route` and `id → waypoint`, the
  backing store for the resource provider. Holds MFD-originated resources plus
  any created directly through our provider.
- **`ResourceWatcher`** — subscribes to the server's delta stream for
  `resources.routes.*` and `resources.waypoints.*` so changes made through
  _other_ resource providers are seen in real time (multiple plugins can
  register as providers; only writes addressed to us reach our provider
  callbacks). Filters out echoes of our own store's writes (§7), and marks
  genuinely foreign changes dirty on the `SyncEngine`.
- **`SyncEngine`** — owns the poll timer, the pending-edit ledger, the upload
  throttle, and serialization of operations (never overlap a download with an
  upload).
- **`UsrArchive`** — writes timestamped copies of downloaded USR files into the
  plugin's data directory before any upload, and prunes old ones (keep last 20).

## 6. USR v6 codec (reverse engineering)

The format must be fully reverse engineered for waypoints and routes. Known so
far (little-endian throughout):

- Header: `u32 version(=6)` · `u32 (=10?)` · length-prefixed ASCII
  `"Navico export data file"` · length-prefixed `"DD/MM/YYYY"` · UID/serial
  block · length-prefixed `"Waypoints, routes, and trails"`.
- Strings inside records: `u32 byteLen` + **UTF-16LE** payload.
- Recurring 4-byte tag `09 6f 75 30` appears to mark records/UIDs.
- Coordinates are real lat/lon (verified against known Fiji waypoints).
- Primary external reference: **GPSBabel `lowranceusr`** (supports USR
  formats 2–6) — use as documentation, do not copy code (GPL).

Method:

1. Work from the captured fixtures `research/captures/mfd113.usr` and
   `mfd110.usr` (gitignored — tests that need them must skip cleanly when
   absent; check in small synthetic fixtures where possible).
2. Decode field-by-field with unit tests asserting known ground truth (route
   names `SAVUSAVU 2 NANAK`, `TESTTEST`; Fiji coordinates ≈ 179.3°E, −16.8°S).
3. **Round-trip invariant**: `serializeUsr(parseUsr(buf))` must produce a file
   the MFD accepts. Byte-identity is the ideal test target; where the format
   contains fields we choose to regenerate (dates, counts), assert semantic
   equality of a re-parse instead.
4. Document every decoded structure in `docs/usr-v6-format.md` as it is
   learned, including unknowns.
5. Validate on real hardware at each milestone: upload a generated file, then
   download and diff to confirm the MFD preserved our records.

The serializer builds a complete USR v6 **from scratch** containing only the
waypoints and routes in the `ResourceStore` (decision: regenerate, not
read-modify-write). It must emit whatever header/trailer/section scaffolding
the MFD requires, including an empty trails section if the format demands one.

## 7. Sync semantics

### MFD → SignalK (`syncFromMfd`)

- Every `pollIntervalSeconds`, download the USR file, parse it, and **mirror**
  it into the `ResourceStore`:
  - Routes/waypoints present in the file are created or overwritten in SignalK.
  - Routes/waypoints absent from the file are **deleted** from SignalK
    (full-mirror deletion semantics).
  - Exception: resources with **pending SignalK edits** (below) are not
    overwritten or deleted.
  - Exception: records whose UID maps to a **foreign resource** (one owned by
    another provider, see below) are not surfaced through our provider at all.
- Emit the appropriate SignalK resource deltas so subscribers see changes.
- A failed or timed-out download leaves the store untouched and logs the error;
  the previous state remains served.

### SignalK → MFD (`syncToMfd`)

SignalK changes reach the plugin through **two channels**, because multiple
plugins can register as resource providers and only writes addressed to _our_
provider hit our callbacks:

1. **Own-provider writes** — `setResource` / `deleteResource` on our provider.
   Applied to the `ResourceStore` and recorded in the **pending-edit ledger**.
2. **Foreign resources** — the `ResourceWatcher` observes the delta stream for
   `resources.routes.*` / `resources.waypoints.*` and catches real-time changes
   to routes/waypoints served by other providers. A foreign change marks that
   resource dirty; the full foreign set is re-read from the server's resources
   API (`listResources` across providers) at upload time.

Either channel schedules an upload through the **throttle**:

- **Debounce**: wait `uploadQuietSeconds` (default 10 s) after the last change,
  so a user dragging waypoints around a route produces one upload, not fifty.
- **Rate floor**: never upload more often than `uploadMinIntervalSeconds`
  (default 60 s). If changes keep arriving, they coalesce and ship in the next
  permitted upload. Uploads are whole-DB writes (~MBs) and the MFD must
  re-propagate each one over UDB — hammering it is the failure mode this
  prevents.
- A change arriving mid-upload schedules a follow-up; uploads never overlap
  each other or a download.

Upload procedure:

1. Ensure a fresh USR download has been archived by `UsrArchive` (safety
   backup — uploads destroy trails, §Known limitations).
2. Serialize **the union of the `ResourceStore` and all foreign
   routes/waypoints** to USR v6 and `POST upload.cgi`.
3. On HTTP success, keep pending-edit ledger entries until **confirmed**: a
   subsequent download whose content matches the pending edit clears its entry.

If `syncToMfd` is disabled, the `ResourceWatcher` is not started;
`setResource`/`deleteResource` still work — SignalK-only resources live in
memory — but they are subject to being removed by the next MFD mirror
(documented behavior; a warning is logged the first time this happens).

### Foreign resources (owned by other providers)

- The `id ↔ Navico UID` mapping (§8) covers foreign resources too. On
  download, a USR record whose UID maps to a foreign SignalK resource is **not
  surfaced through our provider** — it already exists in SignalK under its own
  provider. This is what prevents an upload → download round trip from
  duplicating every foreign route.
- For foreign resources, **SignalK is authoritative**: we cannot write into
  another provider's store, so an MFD-side edit or deletion of a foreign
  record is overwritten/re-created by the next upload. Documented limitation
  (§13).
- Deleting a foreign resource in SignalK removes it from the next upload,
  which deletes it on the MFD (full-mirror semantics).

### Conflict model: _SignalK edits protected_

- MFD is the default source of truth; downloads overwrite the local store.
- **Except**: a resource with an unconfirmed pending edit (including a pending
  delete) is protected from the mirror. The plugin keeps re-uploading (with
  backoff: 5 s, 30 s, 2 min, then every poll) until a downloaded USR file
  confirms the edit, at which point protection lifts and MFD-wins resumes for
  that resource.
- Pending edits are held in memory only; a plugin/server restart drops the
  ledger and the MFD state wins again. This is accepted v1 behavior and must be
  documented in the README.

### Echo suppression & loop prevention

Two loops must be provably impossible; both are broken by comparing
**canonical content** (sorted keys, coordinates rounded to the precision the
USR format actually stores) rather than trusting event provenance alone:

1. **Download loop** — a download that merely reflects what we uploaded must
   produce no resource deltas and no new upload. Confirmation-by-download
   (above) provides this: matching canonical content clears ledger entries and
   changes nothing.
2. **Watcher loop** — writing MFD-mirrored resources into our own store emits
   deltas on the very stream the `ResourceWatcher` subscribes to. The watcher
   ignores deltas for IDs owned by our store, and additionally drops any delta
   whose canonical content matches the state we already hold (belt and
   suspenders, since delta provenance may not identify the provider).

**An upload loop is the worst failure mode — tests must prove that
download → (no change) → no upload holds, and that a full MFD poll cycle
triggers zero watcher-initiated uploads.**

## 8. Data mapping

### Identity

- Navico record UIDs are the primary identity. SignalK resource IDs are derived
  deterministically from them (UUID v5 over the Navico UID with a fixed plugin
  namespace), so repeated downloads yield stable SignalK IDs and no duplicates.
- Resources created on the SignalK side first — through our provider or any
  other provider — get a generated Navico UID at serialization time; the
  `id ↔ uid` mapping (including which resources are foreign, i.e. owned by
  another provider) is persisted as JSON in the plugin data directory so it
  survives restarts. Losing this mapping is what would cause foreign resources
  to duplicate after an upload/download cycle, so it is written atomically
  (write-temp-then-rename) after every change.

### Waypoints

| SignalK (v2 waypoint)          | USR v6                               |
| ------------------------------ | ------------------------------------ |
| `feature.geometry.coordinates` | lat/lon                              |
| `name`                         | name (UTF-16LE)                      |
| `description`                  | comment/description field if present |

### Routes

| SignalK (v2 route)                          | USR v6                     |
| ------------------------------------------- | -------------------------- |
| `name`                                      | route name (UTF-16LE)      |
| `feature.geometry.coordinates` (LineString) | route legs / waypoint refs |
| `distance`                                  | computed, not stored       |

USR routes reference waypoint records by uuid rather than embedding
coordinates (confirmed during §6): the mapper creates the referenced waypoint
records when serializing a SignalK route, and resolves references into a
LineString when parsing. **Outcome:** the format has no flag distinguishing
route-leg waypoints, so the mirror treats _any_ waypoint referenced as a leg
of _any_ route as part of that route — it is represented by the route's
LineString alone and is not published as a standalone SignalK waypoint. Only
free-standing waypoints (referenced by no route) become SignalK waypoints; a
waypoint is (re-)published automatically when the last route referencing it
disappears. Leg records still round-trip byte-losslessly through uploads.

### Constraints

- **Name length**: MFD route names max **16 characters** (waypoint limit TBD —
  verify on hardware). On upload, longer SignalK names are truncated; if
  truncation collides with an existing name, the tail is replaced with `~1`,
  `~2`, … . The original SignalK resource keeps its full name; a warning is
  logged per truncation.
- Coordinates round-trip at the precision the USR format stores; the mapper
  defines a single `canonicalize()` used by both echo suppression and tests.

## 9. Resource provider registration

Register one provider handling both types:

```ts
app.registerResourceProvider({
  type: 'routes', // and a second registration for 'waypoints'
  methods: {
    listResources: (params) => store.list('routes', params),
    getResource: (id) => store.get('routes', id),
    setResource: (id, value) => syncEngine.localSet('routes', id, value),
    deleteResource: (id) => syncEngine.localDelete('routes', id),
  },
});
```

- `setResource` validates incoming resources (GeoJSON shape, finite
  coordinates) and rejects invalid input with a descriptive error.
- The provider must respond from memory immediately; it never blocks on MFD
  I/O.

## 10. Testing strategy

TDD throughout; the test runner is **Vitest** (fast, TS-native). Layers:

1. **Codec unit tests** (the bulk): parse fixtures, assert known ground truth;
   round-trip invariants; serializer golden files; property-style fuzz of
   string/coordinate edge cases (empty names, 16-char names, non-ASCII UTF-16,
   negative coords, antimeridian ±180°).
2. **Mapper unit tests**: SignalK ↔ USR model conversion, ID stability,
   truncation/collision rules, canonicalization.
3. **SyncEngine tests** with fake timers and a mocked `MfdClient`: mirror
   semantics, deletion propagation, pending-edit protection, confirmation
   clearing, debounce + rate-floor throttle (burst of N edits → exactly one
   upload; sustained edits → uploads no closer than the floor), backoff,
   **no-upload-loop**, no overlapping operations, download-failure leaves
   state intact.
4. **ResourceWatcher tests** with a fake delta stream: foreign change marks
   dirty and triggers a throttled upload; own-store echoes and
   canonical-content matches are dropped; a simulated MFD poll cycle produces
   zero watcher-initiated uploads; foreign records round-trip through
   upload/download without duplicating in our provider.
5. **MfdClient tests** against a local HTTP stub server: multipart upload
   shape, timeout behavior, non-200 handling.
6. **Provider integration tests**: register against a minimal fake of the
   SignalK plugin `app` API; exercise list/get/set/delete end-to-end through
   the sync engine.
7. **Hardware smoke script** (`scripts/`, manual, not CI): download → parse →
   serialize → upload → re-download → semantic diff against a live MFD.

CI-safe rule: tests depending on gitignored captures (`research/captures/*.usr`)
skip with a clear message when the files are absent; everything else runs from
checked-in synthetic fixtures.

## 11. Project layout & tooling

```
src/
  index.ts          # plugin entry: config schema, start/stop, registrations
  usr/              # UsrCodec (+ format constants, binary reader/writer utils)
  mapper.ts
  mfd-client.ts
  resource-store.ts
  sync-engine.ts
  usr-archive.ts
test/               # mirrors src/, plus fixtures/
docs/usr-v6-format.md
scripts/            # hardware smoke test
```

- `package.json`: `name: signalk-navico-routes`, keywords incl.
  `signalk-node-server-plugin`, `signalk-category-navigation`;
  scripts `build`, `test`, `lint`, `format`, `ci` (lint + test + build).
- ESLint (typescript-eslint, recommended-type-checked) + Prettier.
- `tsconfig`: `strict: true`, `target ES2022`, `module Node16`.
- Runtime dependencies: as close to zero as possible (Node 20 built-in `fetch`
  and `FormData` cover `MfdClient`).

## 12. Error handling & resilience

- MFD unreachable: log at `error` once, then `debug` on repeats; keep serving
  the in-memory store; resume silently on recovery. Set plugin status message
  (`app.setPluginStatus` / `setPluginError`) to reflect sync health.
- Malformed USR download (bad magic/version/truncated): discard, keep previous
  state, log with enough detail to attach the file to a bug report.
- Never write a USR file we couldn't re-parse ourselves: `serializeUsr` output
  is verified by `parseUsr` before upload (cheap invariant, prevents bricking
  the route DB with garbage).
- All timers/inflight requests cleaned up in plugin `stop()`.

## 13. Known limitations (v1, documented in README)

1. **Uploads erase trails** — the regenerated USR contains only routes and
   waypoints, and `upload.cgi` replaces the whole DB. Mitigation: `UsrArchive`
   keeps timestamped backups of downloaded USR files that can be re-uploaded
   via the MFD's own web page to restore trails.
2. Pending-edit ledger is in-memory; a restart re-asserts MFD state.
3. Single static MFD IP; no auto-discovery, no multi-MFD failover.
4. SignalK-only resources (with `syncToMfd` off) are transient and subject to
   removal by the MFD mirror.
5. For resources owned by **other providers**, SignalK is authoritative:
   MFD-side edits or deletions of those records are overwritten or re-created
   by the next upload, because the plugin cannot write into another provider's
   store.

## 14. Milestones

1. **M1 — Scaffold**: TS project, lint/format/test toolchain, plugin skeleton
   that registers providers over an empty in-memory store. Tests green.
2. **M2 — USR parse**: `parseUsr` decodes waypoints and routes from fixture
   files with verified ground truth. `docs/usr-v6-format.md` drafted.
3. **M3 — MFD → SignalK**: `MfdClient.download`, mapper, mirror sync, poll
   loop. Plugin usably serves MFD routes/waypoints read-only.
4. **M4 — USR serialize**: `serializeUsr` with round-trip tests; hardware
   validation that an uploaded generated file is accepted and survives
   re-download.
5. **M5 — SignalK → MFD**: pending-edit ledger, `ResourceWatcher` (foreign
   resources), throttled upload (debounce + rate floor), confirmation, echo
   suppression / loop prevention, `UsrArchive`. Full bidirectional sync.
6. **M6 — Hardening & release**: name-limit edge cases, error paths, README,
   npm publish metadata.
