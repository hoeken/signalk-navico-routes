/**
 * Custom plugin configuration panel, rendered by the SignalK admin UI in
 * place of the schema-generated form (see webpack.config.js for how it is
 * exposed). Runs on the admin UI's shared React 19.
 *
 * Dependent options are disabled (dimmed but value-preserving) when their
 * parent option is off: everything under "Sync MFD → SignalK" requires that
 * toggle, and "Sync visible routes only" additionally requires "Sync routes".
 */

import { useEffect, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';

/** Mirrors PluginConfig in src/types.ts (and the fallback schema in src/index.ts). */
interface PluginConfig {
  mfdAddress: string;
  syncFromMfd: boolean;
  syncRoutes: boolean;
  syncVisibleRoutesOnly: boolean;
  syncWaypoints: boolean;
  pollIntervalSeconds: number;
}

const DEFAULTS: PluginConfig = {
  mfdAddress: '',
  syncFromMfd: true,
  syncRoutes: true,
  syncVisibleRoutesOnly: true,
  syncWaypoints: true,
  pollIntervalSeconds: 600,
};

/** Wire shape of GET /api/discovered (see src/webapp-api.ts). */
interface DiscoveredMfd {
  address: string;
  model: string;
  name: string;
  udbMaster: boolean;
  lastSeen: string;
}

const DISCOVERED_URL = '/plugins/signalk-navico-routes/api/discovered';
/** MFDs announce ~1/s; refreshing every few seconds keeps the list live. */
const DISCOVERED_POLL_MS = 5000;

/** Floor for non-zero intervals; 0 is also valid and disables automatic polling. */
const MIN_POLL_SECONDS = 30;

interface PanelProps {
  /** Saved plugin configuration; null/undefined on a fresh install. */
  configuration: Partial<PluginConfig> | null;
  /** Persists the configuration through the admin UI; may return a promise. */
  save: (configuration: PluginConfig) => unknown;
}

const ACCENT = '#3b82f6';
const DANGER = '#ef4444';
const OK = '#10b981';

const S: Record<string, CSSProperties> = {
  root: {
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    color: '#333',
    padding: '16px 0',
    maxWidth: 640,
  },
  sectionTitle: {
    fontSize: 13,
    fontWeight: 600,
    color: '#888',
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
    margin: '24px 0 10px',
  },
  fieldRow: { display: 'flex', alignItems: 'flex-start', gap: 12, marginBottom: 12 },
  label: { fontSize: 13, fontWeight: 500, color: '#555', width: 170, flexShrink: 0, paddingTop: 7 },
  fieldBody: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4 },
  input: {
    padding: '6px 10px',
    borderRadius: 6,
    border: '1px solid #ccc',
    fontSize: 13,
    background: '#fff',
    color: '#333',
  },
  inputInvalid: { borderColor: DANGER },
  hint: { fontSize: 11, color: '#999' },
  hintError: { fontSize: 11, color: DANGER },
  toggleRow: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: 10,
    padding: '8px 0',
    cursor: 'pointer',
    userSelect: 'none',
  },
  toggleText: { display: 'flex', flexDirection: 'column', gap: 2 },
  toggleLabel: { fontSize: 13, fontWeight: 600, color: '#444' },
  toggleHint: { fontSize: 11, color: '#999' },
  track: {
    position: 'relative',
    width: 36,
    height: 20,
    borderRadius: 10,
    flexShrink: 0,
    marginTop: 1,
    transition: 'background 0.15s',
  },
  knob: {
    position: 'absolute',
    top: 2,
    left: 2,
    width: 16,
    height: 16,
    borderRadius: '50%',
    background: '#fff',
    boxShadow: '0 1px 2px rgba(0,0,0,0.25)',
    transition: 'transform 0.15s',
  },
  // Children of a toggle: dimmed and inert when the parent is off.
  children: {
    transition: 'opacity 0.15s',
  },
  discoveredList: { display: 'flex', flexDirection: 'column', gap: 4, marginTop: 6 },
  discoveredRow: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 8,
    padding: '5px 10px',
    borderRadius: 6,
    border: '1px solid #ccc',
    background: '#f8fafc',
    fontSize: 12,
    color: '#333',
    cursor: 'pointer',
    textAlign: 'left',
    width: 'fit-content',
  },
  discoveredAddr: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontWeight: 600 },
  roleBadge: {
    fontSize: 10,
    fontWeight: 700,
    textTransform: 'uppercase',
    letterSpacing: '0.04em',
    padding: '1px 6px',
    borderRadius: 8,
  },
  actions: { display: 'flex', gap: 12, alignItems: 'center', marginTop: 20 },
  saveBtn: {
    display: 'inline-flex',
    alignItems: 'center',
    padding: '8px 18px',
    border: 'none',
    borderRadius: 6,
    fontSize: 13,
    fontWeight: 600,
    cursor: 'pointer',
    background: OK,
    color: '#fff',
  },
  status: { fontSize: 12 },
};

function Toggle(props: {
  label: string;
  hint?: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  const { label, hint, checked, disabled, onChange } = props;
  return (
    <label style={{ ...S.toggleRow, ...(disabled ? { cursor: 'default' } : {}) }}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        style={{ position: 'absolute', opacity: 0, width: 0, height: 0 }}
      />
      <span
        style={{
          ...S.track,
          background: checked ? ACCENT : '#cbd5e1',
        }}
      >
        <span style={{ ...S.knob, transform: checked ? 'translateX(16px)' : 'none' }} />
      </span>
      <span style={S.toggleText}>
        <span style={S.toggleLabel}>{label}</span>
        {hint && <span style={S.toggleHint}>{hint}</span>}
      </span>
    </label>
  );
}

/** Child-option group, dimmed and inert while the parent is off. */
function Children(props: { enabled: boolean; children: ReactNode }) {
  return (
    <div
      style={{
        ...S.children,
        opacity: props.enabled ? 1 : 0.45,
        pointerEvents: props.enabled ? 'auto' : 'none',
      }}
    >
      {props.children}
    </div>
  );
}

export default function PluginConfigurationPanel({ configuration, save }: PanelProps) {
  const cfg = { ...DEFAULTS, ...(configuration ?? {}) };

  const [mfdAddress, setMfdAddress] = useState(cfg.mfdAddress);
  const [syncFromMfd, setSyncFromMfd] = useState(cfg.syncFromMfd);
  const [syncRoutes, setSyncRoutes] = useState(cfg.syncRoutes);
  const [syncVisibleRoutesOnly, setSyncVisibleRoutesOnly] = useState(cfg.syncVisibleRoutesOnly);
  const [syncWaypoints, setSyncWaypoints] = useState(cfg.syncWaypoints);
  // Kept as a string so the field can be emptied while typing.
  const [pollInterval, setPollInterval] = useState(String(cfg.pollIntervalSeconds));

  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState('');
  const [statusError, setStatusError] = useState(false);
  const statusTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    return () => {
      if (statusTimeoutRef.current) clearTimeout(statusTimeoutRef.current);
    };
  }, []);

  // MFDs the plugin currently sees announcing via GoFree multicast; the rows
  // are click-to-fill for the address field. Empty while the plugin is
  // stopped (discovery runs inside the plugin) or nothing is announcing.
  const [discovered, setDiscovered] = useState<DiscoveredMfd[]>([]);
  const [discoveredLoaded, setDiscoveredLoaded] = useState(false);
  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const res = await fetch(DISCOVERED_URL, { credentials: 'include' });
        if (!res.ok) return;
        const data = (await res.json()) as { mfds?: DiscoveredMfd[] };
        if (!cancelled && Array.isArray(data.mfds)) setDiscovered(data.mfds);
      } catch {
        // plugin stopped or server unreachable — keep whatever we had
      } finally {
        if (!cancelled) setDiscoveredLoaded(true);
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), DISCOVERED_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);
  const pollSeconds = Number(pollInterval);
  const pollInvalid =
    syncFromMfd &&
    (pollInterval.trim() === '' ||
      !Number.isFinite(pollSeconds) ||
      pollSeconds < 0 ||
      (pollSeconds > 0 && pollSeconds < MIN_POLL_SECONDS));
  const canSave = !saving && !pollInvalid;

  const doSave = async () => {
    if (statusTimeoutRef.current) clearTimeout(statusTimeoutRef.current);
    setSaving(true);
    setStatus('Saving…');
    setStatusError(false);
    try {
      // save() may or may not return a promise; Promise.resolve handles both.
      await Promise.resolve(
        save({
          mfdAddress: mfdAddress.trim(),
          syncFromMfd,
          syncRoutes,
          syncVisibleRoutesOnly,
          syncWaypoints,
          pollIntervalSeconds:
            pollSeconds <= 0 ? 0 : Math.max(MIN_POLL_SECONDS, Math.round(pollSeconds)),
        }),
      );
      setStatus('Configuration saved. The plugin will restart.');
      statusTimeoutRef.current = setTimeout(() => setStatus(''), 5000);
    } catch (e) {
      setStatus('Save failed: ' + (e instanceof Error ? e.message : String(e)));
      setStatusError(true);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={S.root}>
      <div style={{ ...S.sectionTitle, marginTop: 0 }}>Connection</div>
      <div style={S.fieldRow}>
        <span style={S.label}>MFD address</span>
        <div style={S.fieldBody}>
          <div style={{ ...S.discoveredList, marginTop: 0, marginBottom: 6 }}>
            <span style={S.hint}>
              {!discoveredLoaded
                ? 'Discovered MFDs on the network: searching…'
                : discovered.length > 0
                  ? 'Discovered MFDs on the network:'
                  : 'No MFDs discovered on the network.  See README for troubleshooting.'}
            </span>
            {discovered.map((m) => (
              <button
                key={m.address}
                type="button"
                style={{
                  ...S.discoveredRow,
                  ...(mfdAddress.trim() === m.address ? { borderColor: ACCENT } : {}),
                }}
                onClick={() => setMfdAddress(m.address)}
              >
                <span style={S.discoveredAddr}>{m.address}</span>
                <span>{m.name || m.model}</span>
                <span
                  style={{
                    ...S.roleBadge,
                    background: m.udbMaster ? '#dbeafe' : '#e2e8f0',
                    color: m.udbMaster ? '#1d4ed8' : '#475569',
                  }}
                >
                  {m.udbMaster ? 'master' : 'slave'}
                </span>
              </button>
            ))}
          </div>
          <input
            style={S.input}
            type="text"
            value={mfdAddress}
            placeholder="empty = use auto-discovered above"
            onChange={(e) => setMfdAddress(e.target.value)}
          />
          <span style={S.hint}>
            IP address or hostname of master Navico MFD.
            Uploads must sync to master and then it propagates changes to the rest via UDB.
          </span>
        </div>
      </div>

      <div style={S.sectionTitle}>MFD → SignalK</div>
      <Toggle
        label="Sync MFD → SignalK"
        hint="Allow syncing of routes from MFD → SignalK"
        checked={syncFromMfd}
        onChange={setSyncFromMfd}
      />
      <Children enabled={syncFromMfd}>
        <Toggle
          label="Sync routes"
          hint="Mirror MFD routes into SignalK."
          checked={syncRoutes}
          disabled={!syncFromMfd}
          onChange={setSyncRoutes}
        />
        <Children enabled={syncFromMfd && syncRoutes}>
          <Toggle
            label="Sync visible routes only"
            hint="Skip routes that are hidden on the MFD."
            checked={syncVisibleRoutesOnly}
            disabled={!syncFromMfd || !syncRoutes}
            onChange={setSyncVisibleRoutesOnly}
          />
        </Children>
        <Toggle
          label="Sync waypoints"
          hint="Mirror free-standing MFD waypoints into SignalK."
          checked={syncWaypoints}
          disabled={!syncFromMfd}
          onChange={setSyncWaypoints}
        />
        <div style={{ ...S.fieldRow, marginTop: 4 }}>
          <span style={S.label}>Poll interval (seconds)</span>
          <div style={S.fieldBody}>
            <input
              style={{
                ...S.input,
                width: 120,
                ...(pollInvalid ? S.inputInvalid : {}),
              }}
              type="number"
              min={0}
              value={pollInterval}
              disabled={!syncFromMfd}
              onChange={(e) => setPollInterval(e.target.value)}
            />
            <span style={pollInvalid ? S.hintError : S.hint}>
              {pollInvalid
                ? `Must be 0 (automatic polling off) or at least ${MIN_POLL_SECONDS} seconds.  Recommended 300s or more.`
                : 'How often to download the USR file from the MFD. 0 turns automatic polling off; manual sync still works.'}
            </span>
          </div>
        </div>
      </Children>

      <div style={S.actions}>
        <button
          style={{ ...S.saveBtn, ...(canSave ? {} : { opacity: 0.5, cursor: 'default' }) }}
          onClick={() => void doSave()}
          disabled={!canSave}
        >
          {saving ? 'Saving…' : 'Save Configuration'}
        </button>
        {status && <span style={{ ...S.status, color: statusError ? DANGER : OK }}>{status}</span>}
      </div>
    </div>
  );
}
