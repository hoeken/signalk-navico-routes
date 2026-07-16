/**
 * Navico Routes webapp: pick SignalK routes (from other providers) and send
 * them to the MFD, download them as a USR or GPX file, trigger a manual MFD
 * sync, or download the MFD's routes. Served by the SignalK server at
 * /signalk-navico-routes; talks to the plugin API under
 * /plugins/signalk-navico-routes.
 *
 * Target: Chromium 69 (embedded MFD browsers) — esbuild transpiles syntax,
 * but stick to APIs that exist there (no flex `gap`, no
 * `prefers-color-scheme` guarantee).
 */

import { render } from 'preact';
import { useEffect, useMemo, useState } from 'preact/hooks';
import { downloadFile, fetchRoutes, fetchUiConfig, postJson } from './api';
import {
  NAME_LIMIT,
  PLUGIN_ID,
  filterRows,
  formatLength,
  formatRelativeTime,
  formatTimestamp,
  resolveTheme,
  routeRows,
  sortRows,
  truncateName,
} from './lib';
import type { RouteRow, SortDir, SortKey, Theme } from './lib';
import type { UiConfig } from './api';

interface SyncResult {
  waypoints: number;
  routes: number;
}

interface UploadResult {
  routes: number;
  nameAdjustments: { type: string; original: string; adjusted: string }[];
}

interface Status {
  kind: 'ok' | 'error' | 'busy';
  text: string;
}

type ExportFormat = 'usr' | 'gpx';

/** Which download button opened the format modal; null = closed. */
type FormatTarget = 'mfd' | 'selected' | null;

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
  const [uiConfig, setUiConfig] = useState<UiConfig | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [formatTarget, setFormatTarget] = useState<FormatTarget>(null);

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
    // Refreshed alongside the routes so 'Last synced' tracks manual syncs.
    // On failure the UI just keeps its defaults (everything shown).
    fetchUiConfig().then(setUiConfig, () => undefined);
  };
  useEffect(reload, []);

  // Keep the relative 'Last synced …' phrasing from going stale.
  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  const visible = useMemo(
    () => sortRows(filterRows(rows || [], query), sortKey, sortDir),
    [rows, query, sortKey, sortDir],
  );
  const selectedRows = (rows || []).filter((r) => selected[r.id]);
  const allVisibleSelected = visible.length > 0 && visible.every((r) => selected[r.id]);

  const nameFor = (row: RouteRow) => names[row.id] ?? truncateName(row.name);

  // MFD → SignalK sync UI is hidden when the plugin has it disabled;
  // an unknown config (endpoint unreachable) shows everything, as before.
  const syncEnabled = !uiConfig || !uiConfig.sync || uiConfig.sync.syncFromMfd;
  const lastSynced = syncEnabled
    ? formatRelativeTime(uiConfig ? uiConfig.lastSync : null, nowMs)
    : null;

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

  // GPX keeps the full SignalK name unless the user renamed the route in
  // the table; USR/upload names go through the MFD-capped name inputs.
  const selectionPayload = (format: ExportFormat = 'usr') => ({
    routes: selectedRows.map((row) => ({
      id: row.id,
      name: format === 'gpx' ? (names[row.id] ?? row.name) : nameFor(row),
    })),
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

  const downloadMfdRoutes = (format: ExportFormat) =>
    run('Downloading MFD routes', async () => {
      const filename = await downloadFile('/api/backup?format=' + format);
      return 'MFD routes saved as ' + filename + '.';
    });

  const downloadSelected = (format: ExportFormat) =>
    run('Building ' + format.toUpperCase() + ' file', async () => {
      const filename = await downloadFile('/api/export', {
        ...selectionPayload(format),
        format,
      });
      return selectedRows.length + ' route(s) saved as ' + filename + '.';
    });

  const pickFormat = (format: ExportFormat) => {
    const target = formatTarget;
    setFormatTarget(null);
    if (target === 'mfd') {
      downloadMfdRoutes(format);
    } else if (target === 'selected') {
      downloadSelected(format);
    }
  };

  const uploadToMfd = () => {
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
      showSync={syncEnabled}
      selectedCount={selectedRows.length}
      onSync={syncFromMfd}
      onMfdRoutes={() => setFormatTarget('mfd')}
      onSelected={() => setFormatTarget('selected')}
      onUpload={uploadToMfd}
    />
  );

  return (
    <div class="app">
      <header class="header">
        <div>
          <h1>Navico Route Sync</h1>
          <p class="subtitle">
            Syncing MFD → SignalK keeps your MFD routes separate and won't affect your existing
            SignalK routes. Syncing SignalK → MFD is additive only — to modify an existing route,
            delete it from the MFD first.
          </p>
        </div>
        <button
          type="button"
          class="btn btn-ghost theme-toggle"
          onClick={() => setTheme(theme === 'day' ? 'night' : 'day')}
          title="Switch theme (this page only)"
        >
          {theme === 'day' ? <MoonIcon /> : <SunIcon />}
          {theme === 'day' ? ' Night' : ' Day'}
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
                label="Legs"
                k="legs"
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
                <td class="col-num">{row.legs}</td>
                <td class="col-num">{formatLength(row.lengthM)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {toolbar}

      {status && <div class={'status status-' + status.kind}>{status.text}</div>}

      {formatTarget && (
        <FormatModal
          title={
            formatTarget === 'mfd'
              ? 'Download MFD Routes'
              : 'Download ' + selectedRows.length + ' selected route(s)'
          }
          onPick={pickFormat}
          onCancel={() => setFormatTarget(null)}
        />
      )}

      <footer class="footer">
        <a href={'https://www.npmjs.com/package/' + PLUGIN_ID} target="_blank" rel="noreferrer">
          {PLUGIN_ID + (uiConfig ? ' v' + uiConfig.version : '')}
        </a>
        {lastSynced && <span> — Last synced {lastSynced}</span>}
      </footer>
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

function MoonIcon() {
  return (
    <svg
      class="theme-icon"
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
  );
}

function SunIcon() {
  return (
    <svg
      class="theme-icon"
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="5" />
      <line x1="12" y1="1" x2="12" y2="3" />
      <line x1="12" y1="21" x2="12" y2="23" />
      <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
      <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
      <line x1="1" y1="12" x2="3" y2="12" />
      <line x1="21" y1="12" x2="23" y2="12" />
      <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
      <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
    </svg>
  );
}

function Toolbar(props: {
  busy: boolean;
  /** False when MFD → SignalK sync is disabled in the plugin config. */
  showSync: boolean;
  selectedCount: number;
  onSync: () => void;
  onMfdRoutes: () => void;
  onSelected: () => void;
  onUpload: () => void;
}) {
  const none = props.selectedCount === 0;
  return (
    <div class="toolbar">
      {props.showSync && (
        <button type="button" class="btn" disabled={props.busy} onClick={props.onSync}>
          Sync MFD → SignalK
        </button>
      )}
      <button type="button" class="btn" disabled={props.busy} onClick={props.onMfdRoutes}>
        Download MFD Routes
      </button>
      <span class="toolbar-spacer" />
      <button type="button" class="btn" disabled={props.busy || none} onClick={props.onSelected}>
        Download Selected
      </button>
      <button
        type="button"
        class="btn btn-primary"
        disabled={props.busy || none}
        onClick={props.onUpload}
      >
        Sync Selected → MFD
      </button>
    </div>
  );
}

function FormatModal(props: {
  title: string;
  onPick: (format: ExportFormat) => void;
  onCancel: () => void;
}) {
  return (
    <div class="modal-overlay" onClick={props.onCancel}>
      <div class="modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <h2 class="modal-title">{props.title}</h2>
        <p class="modal-text">Choose a file format:</p>
        <div class="modal-formats">
          <button type="button" class="btn modal-format" onClick={() => props.onPick('usr')}>
            <span class="modal-format-name">USR</span>
            <span class="modal-format-hint">Navico MFD import/backup</span>
          </button>
          <button type="button" class="btn modal-format" onClick={() => props.onPick('gpx')}>
            <span class="modal-format-name">GPX</span>
            <span class="modal-format-hint">Works with most chart software</span>
          </button>
        </div>
        <div class="modal-actions">
          <button type="button" class="btn btn-ghost" onClick={props.onCancel}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

render(<App />, document.getElementById('app')!);
