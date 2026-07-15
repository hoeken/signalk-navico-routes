/**
 * Navico Routes webapp: pick SignalK routes (from other providers) and send
 * them to the MFD, download them as a USR file, trigger a manual MFD sync,
 * or download a full MFD backup. Served by the SignalK server at
 * /signalk-navico-routes; talks to the plugin API under
 * /plugins/signalk-navico-routes.
 *
 * Target: Chromium 69 (embedded MFD browsers) — esbuild transpiles syntax,
 * but stick to APIs that exist there (no flex `gap`, no
 * `prefers-color-scheme` guarantee).
 */

import { render } from 'preact';
import { useEffect, useMemo, useState } from 'preact/hooks';
import { downloadFile, fetchRoutes, postJson } from './api';
import {
  NAME_LIMIT,
  filterRows,
  formatLength,
  formatTimestamp,
  resolveTheme,
  routeRows,
  sortRows,
  truncateName,
} from './lib';
import type { RouteRow, SortDir, SortKey, Theme } from './lib';

interface SyncResult {
  waypoints: number;
  routes: number;
}

interface UploadResult {
  routes: number;
  archivedTo: string;
  nameAdjustments: { type: string; original: string; adjusted: string }[];
}

interface Status {
  kind: 'ok' | 'error' | 'busy';
  text: string;
}

function initialTheme(): Theme {
  const prefersDark = Boolean(
    window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches,
  );
  return resolveTheme(window.location.search, prefersDark);
}

function App() {
  const [theme, setTheme] = useState<Theme>(initialTheme);
  const [rows, setRows] = useState<RouteRow[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [names, setNames] = useState<Record<string, string>>({});
  const [query, setQuery] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('timestamp');
  const [sortDir, setSortDir] = useState<SortDir>(-1);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<Status | null>(null);

  useEffect(() => {
    document.documentElement.className = theme === 'night' ? 'theme-night' : 'theme-day';
  }, [theme]);

  const reload = () => {
    setLoadError(null);
    fetchRoutes().then(
      (resources) => setRows(routeRows(resources)),
      (err: Error) => {
        setRows([]);
        setLoadError('Could not load routes: ' + err.message);
      },
    );
  };
  useEffect(reload, []);

  const visible = useMemo(
    () => sortRows(filterRows(rows || [], query), sortKey, sortDir),
    [rows, query, sortKey, sortDir],
  );
  const selectedRows = (rows || []).filter((r) => selected[r.id]);
  const allVisibleSelected = visible.length > 0 && visible.every((r) => selected[r.id]);

  const nameFor = (row: RouteRow) => names[row.id] ?? truncateName(row.name);

  const setSort = (key: SortKey) => {
    if (key === sortKey) {
      setSortDir((dir) => (dir === 1 ? -1 : 1));
    } else {
      setSortKey(key);
      setSortDir(key === 'name' ? 1 : -1);
    }
  };

  const toggleAll = () => {
    const next = { ...selected };
    for (const row of visible) {
      next[row.id] = !allVisibleSelected;
    }
    setSelected(next);
  };

  const selectionPayload = () => ({
    routes: selectedRows.map((row) => ({ id: row.id, name: nameFor(row) })),
  });

  const run = (label: string, op: () => Promise<string>, reloadAfter = false) => {
    if (busy) {
      return;
    }
    setBusy(true);
    setStatus({ kind: 'busy', text: label + '…' });
    op().then(
      (text) => {
        setBusy(false);
        setStatus({ kind: 'ok', text });
        if (reloadAfter) {
          reload();
        }
      },
      (err: Error) => {
        setBusy(false);
        setStatus({ kind: 'error', text: label + ' failed: ' + err.message });
      },
    );
  };

  const syncFromMfd = () =>
    run(
      'Syncing from MFD',
      async () => {
        const counts = await postJson<SyncResult>('/api/sync');
        return (
          'Synced ' + counts.routes + ' routes and ' + counts.waypoints + ' waypoints from the MFD.'
        );
      },
      true,
    );

  const downloadBackup = () =>
    run('Downloading MFD backup', async () => {
      const filename = await downloadFile('/api/backup');
      return 'MFD backup saved as ' + filename + '.';
    });

  const downloadUsr = () =>
    run('Building USR file', async () => {
      const filename = await downloadFile('/api/usr', selectionPayload());
      return selectedRows.length + ' route(s) saved as ' + filename + '.';
    });

  const uploadToMfd = () => {
    const ok = window.confirm(
      'Send ' +
        selectedRows.length +
        ' route(s) to the MFD?\n\n' +
        'Uploads only add records on the MFD — they never overwrite or delete. ' +
        'A backup of the current MFD database is archived first.',
    );
    if (!ok) {
      return;
    }
    run(
      'Sending routes to MFD',
      async () => {
        const result = await postJson<UploadResult>('/api/upload', selectionPayload());
        let text = 'Sent ' + result.routes + ' route(s) to the MFD.';
        if (result.nameAdjustments.length > 0) {
          text +=
            ' Renamed on the MFD: ' +
            result.nameAdjustments
              .map((a) => "'" + a.original + "' → '" + a.adjusted + "'")
              .join(', ') +
            '.';
        }
        return text;
      },
      true,
    );
  };

  const toolbar = (
    <Toolbar
      busy={busy}
      selectedCount={selectedRows.length}
      onSync={syncFromMfd}
      onBackup={downloadBackup}
      onUsr={downloadUsr}
      onUpload={uploadToMfd}
    />
  );

  return (
    <div class="app">
      <header class="header">
        <div>
          <h1>Navico Routes</h1>
          <p class="subtitle">
            SignalK routes that are not yet mirrored from the MFD. Select routes to send them to the
            MFD or export them as a USR file.
          </p>
        </div>
        <button
          type="button"
          class="btn btn-ghost theme-toggle"
          onClick={() => setTheme(theme === 'day' ? 'night' : 'day')}
          title="Switch theme (this page only)"
        >
          {theme === 'day' ? '☾ Night' : '☀ Day'}
        </button>
      </header>

      {toolbar}

      <div class="search-row">
        <input
          type="search"
          class="search"
          placeholder="Search routes by name…"
          value={query}
          onInput={(e) => setQuery((e.target as HTMLInputElement).value)}
        />
        <span class="count">
          {rows === null
            ? 'Loading…'
            : visible.length +
              ' of ' +
              rows.length +
              ' routes · ' +
              selectedRows.length +
              ' selected'}
        </span>
      </div>

      {loadError && <div class="status status-error">{loadError}</div>}

      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th class="col-check">
                <input
                  type="checkbox"
                  aria-label="Select all routes"
                  checked={allVisibleSelected}
                  disabled={visible.length === 0}
                  onChange={toggleAll}
                />
              </th>
              <SortHeader
                label="Timestamp"
                k="timestamp"
                sortKey={sortKey}
                sortDir={sortDir}
                onSort={setSort}
              />
              <SortHeader
                label="Name"
                k="name"
                sortKey={sortKey}
                sortDir={sortDir}
                onSort={setSort}
              />
              <SortHeader
                label="Waypoints"
                k="waypoints"
                sortKey={sortKey}
                sortDir={sortDir}
                onSort={setSort}
                right
              />
              <SortHeader
                label="Length"
                k="length"
                sortKey={sortKey}
                sortDir={sortDir}
                onSort={setSort}
                right
              />
            </tr>
          </thead>
          <tbody>
            {rows !== null && visible.length === 0 && (
              <tr>
                <td class="empty" colSpan={5}>
                  {rows.length === 0
                    ? 'No SignalK routes available to send. Routes mirrored from the MFD are not listed.'
                    : 'No routes match the search.'}
                </td>
              </tr>
            )}
            {visible.map((row) => (
              <tr key={row.id} class={selected[row.id] ? 'row-selected' : ''}>
                <td class="col-check">
                  <input
                    type="checkbox"
                    aria-label={'Select ' + (row.name || row.id)}
                    checked={Boolean(selected[row.id])}
                    onChange={() => setSelected({ ...selected, [row.id]: !selected[row.id] })}
                  />
                </td>
                <td class="col-time">{formatTimestamp(row.timestamp)}</td>
                <td class="col-name">
                  <input
                    type="text"
                    class="name-input"
                    maxLength={NAME_LIMIT}
                    value={nameFor(row)}
                    title={row.name}
                    onInput={(e) =>
                      setNames({
                        ...names,
                        [row.id]: truncateName((e.target as HTMLInputElement).value),
                      })
                    }
                  />
                </td>
                <td class="col-num">{row.waypoints}</td>
                <td class="col-num">{formatLength(row.lengthM)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {toolbar}

      {status && <div class={'status status-' + status.kind}>{status.text}</div>}
    </div>
  );
}

function SortHeader(props: {
  label: string;
  k: SortKey;
  sortKey: SortKey;
  sortDir: SortDir;
  onSort: (key: SortKey) => void;
  right?: boolean;
}) {
  const active = props.sortKey === props.k;
  return (
    <th
      class={(props.right ? 'col-num ' : '') + 'sortable' + (active ? ' sorted' : '')}
      onClick={() => props.onSort(props.k)}
    >
      {props.label}
      <span class="sort-arrow">{active ? (props.sortDir === 1 ? ' ▲' : ' ▼') : ''}</span>
    </th>
  );
}

function Toolbar(props: {
  busy: boolean;
  selectedCount: number;
  onSync: () => void;
  onBackup: () => void;
  onUsr: () => void;
  onUpload: () => void;
}) {
  const none = props.selectedCount === 0;
  return (
    <div class="toolbar">
      <button type="button" class="btn" disabled={props.busy} onClick={props.onSync}>
        Sync MFD → SignalK
      </button>
      <button type="button" class="btn" disabled={props.busy} onClick={props.onBackup}>
        Download MFD backup
      </button>
      <span class="toolbar-spacer" />
      <button type="button" class="btn" disabled={props.busy || none} onClick={props.onUsr}>
        Download selected as USR
      </button>
      <button
        type="button"
        class="btn btn-primary"
        disabled={props.busy || none}
        onClick={props.onUpload}
      >
        Send selected to MFD
      </button>
    </div>
  );
}

render(<App />, document.getElementById('app')!);
