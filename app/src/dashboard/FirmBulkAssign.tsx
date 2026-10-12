import { useCallback, useEffect, useRef, useState } from 'react';
import { isOnline, isSupabaseConfigured } from '../lib/supabase';
import {
  parseIdList,
  resolveBridgeIds,
  type BridgeState,
  type ResolveResult,
} from '../lib/bridgeLookup';
import {
  assignBridgesToFirm,
  getExistingFirmAssignments,
  createFirm,
} from '../lib/stateDashboard';
import { syncFirms } from '../lib/firm';
import type { Bridge, Firm } from '../types';

interface Props {
  firms: Firm[];
  onFirmsChanged: () => void;
}

/**
 * State dashboard: assign bridge groups to firms.
 * Paste IDs or upload CSV, resolve against inventory, pick a firm, assign.
 * Shows each bridge's current firm before assigning.
 */
export default function FirmBulkAssign({ firms, onFirmsChanged }: Props) {
  const [state, setState] = useState<BridgeState>('SC');
  const [pasteText, setPasteText] = useState('');
  const [firmId, setFirmId] = useState('');
  const [newFirmName, setNewFirmName] = useState('');
  const [creatingFirm, setCreatingFirm] = useState(false);
  const [resolved, setResolved] = useState<ResolveResult | null>(null);
  const [existingFirms, setExistingFirms] = useState<Map<string, string>>(new Map());
  const [resolving, setResolving] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const configured = isOnline() && isSupabaseConfigured();
  const firmName = useCallback(
    (id: string | undefined | null) =>
      firms.find((f) => f.id === id)?.name ?? '—',
    [firms],
  );

  useEffect(() => {
    if (!firmId && firms.length > 0) setFirmId(firms[0].id);
  }, [firms, firmId]);

  const handleResolve = async () => {
    const ids = parseIdList(pasteText);
    if (ids.length === 0) {
      setMessage('Paste bridge IDs (one per line) or upload a CSV first.');
      return;
    }
    if (!configured) {
      setMessage('Supabase is not configured or the device is offline.');
      return;
    }
    setResolving(true);
    setMessage(null);
    try {
      // No firm filter here: state users resolve the full inventory.
      const result = await resolveBridgeIds(ids, state, null);
      setResolved(result);
      const existing = await getExistingFirmAssignments(
        result.found.map((b) => b.asset_id),
      );
      setExistingFirms(existing);
      if (result.found.length === 0) {
        setMessage(`No bridges matched. ${result.notFound.length} ID(s) not found.`);
      } else if (result.notFound.length > 0) {
        setMessage(
          `Resolved ${result.found.length} of ${ids.length} IDs — ` +
            `${result.notFound.length} not found (see below).`,
        );
      } else {
        setMessage(`Resolved all ${result.found.length} bridges.`);
      }
    } catch (err) {
      setMessage(`Resolve failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setResolving(false);
    }
  };

  const handleCsvUpload = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      const text = String(reader.result ?? '');
      const ids = parseIdList(text);
      setPasteText((prev) =>
        prev.trim() ? `${prev.trim()}\n${ids.join('\n')}` : ids.join('\n'),
      );
      setMessage(
        ids.length > 0
          ? `Added ${ids.length} ID(s) from ${file.name}. Click Resolve.`
          : `No IDs found in ${file.name}.`,
      );
    };
    reader.onerror = () => setMessage(`Could not read ${file.name}.`);
    reader.readAsText(file);
  };

  const handleAssign = async () => {
    if (!resolved || resolved.found.length === 0) {
      setMessage('Resolve bridges first.');
      return;
    }
    if (!firmId) {
      setMessage('Select a firm first (or create one below).');
      return;
    }
    setSaving(true);
    setMessage(null);
    try {
      const { inserted } = await assignBridgesToFirm(
        resolved.found.map((b) => b.asset_id),
        firmId,
      );
      setMessage(
        `Assigned ${resolved.found.length} bridge(s) to ${firmName(firmId)}` +
          (inserted < resolved.found.length
            ? ` (${resolved.found.length - inserted} already assigned).`
            : '.'),
      );
      const existing = await getExistingFirmAssignments(
        resolved.found.map((b) => b.asset_id),
      );
      setExistingFirms(existing);
      onFirmsChanged();
    } catch (err) {
      setMessage(`Assign failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSaving(false);
    }
  };

  const handleCreateFirm = async () => {
    if (!newFirmName.trim()) {
      setMessage('Enter a firm name first.');
      return;
    }
    if (!configured) {
      setMessage('Supabase is not configured or the device is offline.');
      return;
    }
    setCreatingFirm(true);
    setMessage(null);
    try {
      const f = await createFirm(newFirmName.trim());
      await syncFirms().catch(() => undefined);
      setNewFirmName('');
      setFirmId(f.id);
      setMessage(`Created firm "${f.name}".`);
      onFirmsChanged();
    } catch (err) {
      setMessage(
        `Create failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setCreatingFirm(false);
    }
  };

  const found: Bridge[] = resolved?.found ?? [];
  const notFound: string[] = resolved?.notFound ?? [];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div className="card">
        <h2 style={{ marginTop: 0 }}>Firms</h2>
        {firms.length === 0 ? (
          <p className="muted">No firms yet — create the first one below.</p>
        ) : (
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
            {firms.map((f) => (
              <span key={f.id} className="pill" style={{ fontSize: 13 }}>
                {f.name}
              </span>
            ))}
          </div>
        )}
        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span className="muted">New firm name</span>
            <input
              type="text"
              value={newFirmName}
              onChange={(e) => setNewFirmName(e.target.value)}
              placeholder="e.g. Strinteg"
              disabled={creatingFirm}
            />
          </label>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => void handleCreateFirm()}
            disabled={creatingFirm || !newFirmName.trim()}
          >
            {creatingFirm ? 'Creating…' : 'Create firm'}
          </button>
        </div>
      </div>

      <div className="card">
        <h2 style={{ marginTop: 0 }}>Assign bridges to a firm</h2>
        <p className="muted" style={{ marginTop: 0 }}>
          Paste bridge IDs or upload a CSV, resolve them, then assign the group
          to a firm. Bridges already assigned show their current firm.
        </p>
        {message && (
          <p className="muted" style={{ color: '#e2e8f0' }}>
            {message}
          </p>
        )}
        <div
          style={{
            display: 'flex',
            gap: 8,
            flexWrap: 'wrap',
            alignItems: 'flex-end',
            marginBottom: 8,
          }}
        >
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span className="muted">State</span>
            <select
              value={state}
              onChange={(e) => setState(e.target.value as BridgeState)}
              disabled={resolving || saving}
            >
              <option value="SC">SC</option>
              <option value="NC">NC</option>
            </select>
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span className="muted">Firm</span>
            <select
              value={firmId}
              onChange={(e) => setFirmId(e.target.value)}
              disabled={resolving || saving || firms.length === 0}
              style={{ minWidth: 160 }}
            >
              {firms.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="btn"
            onClick={() => fileRef.current?.click()}
            disabled={resolving || saving}
          >
            Upload CSV
          </button>
          <input
            ref={fileRef}
            type="file"
            accept=".csv,.txt"
            style={{ display: 'none' }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) handleCsvUpload(f);
              e.target.value = '';
            }}
          />
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => void handleResolve()}
            disabled={resolving || saving || !pasteText.trim()}
          >
            {resolving ? 'Resolving…' : 'Resolve bridges'}
          </button>
        </div>
        <textarea
          value={pasteText}
          onChange={(e) => setPasteText(e.target.value)}
          placeholder={'One bridge ID per line, e.g.\n1892\nSC-1892\n000000000001892'}
          rows={8}
          style={{ width: '100%', fontFamily: 'monospace', fontSize: 13 }}
          disabled={resolving || saving}
        />
      </div>

      {resolved && (
        <div className="card">
          <h2 style={{ marginTop: 0 }}>
            Resolved bridges{' '}
            <span className="muted" style={{ fontWeight: 400, fontSize: 13 }}>
              {found.length} found
              {notFound.length > 0 ? ` / ${notFound.length} not found` : ''}
            </span>
          </h2>
          {found.length > 0 && (
            <>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => void handleAssign()}
                disabled={saving || !firmId}
                style={{ marginBottom: 8 }}
              >
                {saving
                  ? 'Assigning…'
                  : `Assign ${found.length} bridge(s) to ${firmName(firmId) || 'firm'}`}
              </button>
              <div style={{ overflowX: 'auto' }}>
                <table className="data">
                  <thead>
                    <tr>
                      <th>Bridge</th>
                      <th>Facility</th>
                      <th>County</th>
                      <th>Current firm</th>
                    </tr>
                  </thead>
                  <tbody>
                    {found.map((b) => {
                      const cur = existingFirms.get(b.asset_id);
                      return (
                        <tr key={b.asset_id}>
                          <td>
                            <code>{b.asset_id}</code>
                          </td>
                          <td>{b.facility ?? '—'}</td>
                          <td>{b.county_name ?? '—'}</td>
                          <td>{cur ? firmName(cur) : <span className="muted">unassigned</span>}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </>
          )}
          {notFound.length > 0 && (
            <div style={{ marginTop: 12 }}>
              <h3 style={{ marginBottom: 4 }}>Not found</h3>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {notFound.map((raw) => (
                  <span key={raw} className="pill" style={{ background: '#7A1F08', color: '#fff' }}>
                    {raw}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
