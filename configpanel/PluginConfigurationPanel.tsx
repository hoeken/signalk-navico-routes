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
  pollIntervalSeconds: 300,
};

const MIN_POLL_SECONDS = 15;

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

  const addressMissing = mfdAddress.trim() === '';
  const pollSeconds = Number(pollInterval);
  const pollInvalid =
    syncFromMfd &&
    (pollInterval.trim() === '' || !Number.isFinite(pollSeconds) || pollSeconds < MIN_POLL_SECONDS);
  const canSave = !saving && !addressMissing && !pollInvalid;

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
          pollIntervalSeconds: Math.max(MIN_POLL_SECONDS, Math.round(pollSeconds)),
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
          <input
            style={{ ...S.input, ...(addressMissing ? S.inputInvalid : {}) }}
            type="text"
            value={mfdAddress}
            placeholder="e.g. 192.168.1.35"
            onChange={(e) => setMfdAddress(e.target.value)}
          />
          <span style={addressMissing ? S.hintError : S.hint}>
            {addressMissing
              ? 'Required — the plugin does nothing without an MFD to talk to.'
              : 'IP address or hostname of a Navico MFD (B&G Zeus, Simrad NSS, Lowrance HDS, …). ' +
                'Any MFD on the network works; it propagates changes to the rest via UDB.'}
          </span>
        </div>
      </div>

      <div style={S.sectionTitle}>MFD → SignalK</div>
      <Toggle
        label="Sync MFD → SignalK"
        hint="Periodically download the user database and mirror it into SignalK."
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
              min={MIN_POLL_SECONDS}
              value={pollInterval}
              disabled={!syncFromMfd}
              onChange={(e) => setPollInterval(e.target.value)}
            />
            <span style={pollInvalid ? S.hintError : S.hint}>
              {pollInvalid
                ? `Minimum ${MIN_POLL_SECONDS} seconds.`
                : 'How often to download the USR file from the MFD.'}
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
