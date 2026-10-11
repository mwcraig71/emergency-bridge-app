import { useCallback, useEffect, useRef, useState } from 'react';
import { getSupabase, isOnline, isSupabaseConfigured } from '../lib/supabase';
import { idbDelete, idbGetAll, idbPut } from '../lib/idb';
import {
  parseIdList,
  resolveBridgeIds,
  type BridgeState,
  type ResolveResult,
} from '../lib/bridgeLookup';
import type { Bridge, Bucket } from '../types';

function newBucketId(): string {
  return `bucket-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export default function BulkBridgeInput() {
  const [state, setState] = useState<BridgeState>('SC');
  const [pasteText, setPasteText] = useState('');
  const [bucketName, setBucketName] = useState('');
  const [resolved, setResolved] = useState<ResolveResult | null>(null);
  const [resolving, setResolving] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [bulkInspector, setBulkInspector] = useState('');
  const [perBridgeInspector, setPerBridgeInspector] = useState<
    Record<string, string>
  >({});
  const [buckets, setBuckets] = useState<Bucket[]>([]);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const configured = isOnline() && isSupabaseConfigured();

  const reloadBuckets = useCallback(async () => {
    try {
      const all = await idbGetAll<Bucket>('buckets');
      all.sort((a, b) => b.created_at.localeCompare(a.created_at));
      setBuckets(all);
    } catch {
      setBuckets([]);
    }
  }, []);

  useEffect(() => {
    void reloadBuckets();
  }, [reloadBuckets]);

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
      const result = await resolveBridgeIds(ids, state);
      setResolved(result);
      setPerBridgeInspector({});
      if (result.found.length === 0) {
        setMessage(
          `No bridges matched. ${result.notFound.length} ID(s) not found.`,
        );
      } else if (result.notFound.length > 0) {
        setMessage(
          `Resolved ${result.found.length} of ${ids.length} IDs — ` +
            `${result.notFound.length} not found (see below).`,
        );
      } else {
        setMessage(`Resolved all ${result.found.length} bridges.`);
      }
    } catch (err) {
      setMessage(
        `Resolve failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setResolving(false);
    }
  };

  const handleCsvUpload = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      const text = String(reader.result ?? '');
      const ids = parseIdList(text);
      setPasteText((prev) => {
        const combined = prev.trim()
          ? `${prev.trim()}\n${ids.join('\n')}`
          : ids.join('\n');
        return combined;
      });
      setMessage(
        ids.length > 0
          ? `Added ${ids.length} ID(s) from ${file.name}. Click Resolve.`
          : `No IDs found in ${file.name}.`,
      );
    };
    reader.onerror = () => setMessage(`Could not read ${file.name}.`);
    reader.readAsText(file);
  };

  /** Effective inspector for a bridge: per-bridge override, else bulk. */
  const inspectorFor = (assetId: string): string =>
    (perBridgeInspector[assetId] ?? '').trim() || bulkInspector.trim();

  const handleSaveAndAssign = async () => {
    if (!resolved || resolved.found.length === 0) {
      setMessage('Resolve bridges first.');
      return;
    }
    const name =
      bucketName.trim() ||
      `${state} batch ${new Date().toLocaleDateString()}`;
    setSaving(true);
    setMessage(null);
    try {
      const inspectorMap: Record<string, string> = {};
      for (const b of resolved.found) {
        const insp = inspectorFor(b.asset_id);
        if (insp) inspectorMap[b.asset_id] = insp;
      }
      const bucket: Bucket = {
        id: newBucketId(),
        name,
        state,
        asset_ids: resolved.found.map((b) => b.asset_id),
        inspector_map: inspectorMap,
        created_at: new Date().toISOString(),
      };
      await idbPut('buckets', bucket);

      // Create assignments for every bridge with an inspector.
      const assignedIds = Object.keys(inspectorMap);
      if (assignedIds.length > 0) {
        if (!configured) throw new Error('Supabase is not available.');
        const sb = getSupabase()!;
        const rows = assignedIds.map((assetId) => ({
          asset_id: assetId,
          assigned_to: inspectorMap[assetId],
          assigned_by: 'dashboard',
          status: 'assigned',
        }));
        for (let i = 0; i < rows.length; i += 500) {
          const { error } = await sb
            .from('emg_assignments')
            .insert(rows.slice(i, i + 500));
          if (error) throw error;
        }
      }
      setMessage(
        `Saved bucket "${name}" (${bucket.asset_ids.length} bridges)` +
          (assignedIds.length > 0
            ? ` and assigned ${assignedIds.length} to inspector(s).`
            : ' with no inspector assignments.'),
      );
      setPasteText('');
      setResolved(null);
      setBucketName('');
      setBulkInspector('');
      setPerBridgeInspector({});
      await reloadBuckets();
    } catch (err) {
      setMessage(
        `Save failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteBucket = async (id: string) => {
    await idbDelete('buckets', id);
    await reloadBuckets();
  };

  const handleLoadBucket = async (bucket: Bucket) => {
    if (!configured) {
      setMessage('Supabase is not configured or the device is offline.');
      return;
    }
    setResolving(true);
    setMessage(null);
    try {
      const result = await resolveBridgeIds(bucket.asset_ids, bucket.state);
      setResolved(result);
      setPerBridgeInspector({ ...bucket.inspector_map });
      setBulkInspector('');
      setBucketName(`${bucket.name} (copy)`);
      setState(bucket.state);
      setMessage(
        `Loaded bucket "${bucket.name}" — ${result.found.length} bridges resolved.`,
      );
    } catch (err) {
      setMessage(
        `Load failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setResolving(false);
    }
  };

  const found: Bridge[] = resolved?.found ?? [];
  const notFound: string[] = resolved?.notFound ?? [];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div className="card">
        <h2 style={{ marginTop: 0 }}>Bulk bridge input</h2>
        <p className="muted" style={{ marginTop: 0 }}>
          Paste a list of bridge IDs or upload a CSV, resolve them against the
          inventory, then save as a named bucket and assign inspectors.
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
          placeholder={
            'One bridge ID per line, e.g.\n1892\nSC-1892\n000000000001892'
          }
          rows={8}
          style={{ width: '100%', fontFamily: 'monospace', fontSize: 13 }}
          disabled={resolving || saving}
        />
        <p className="muted" style={{ marginBottom: 0 }}>
          Accepts asset IDs (1892, SC-1892) and SC structure numbers
          (000000000001892). CSV: single column, header optional.
        </p>
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
              <div
                style={{
                  display: 'flex',
                  gap: 8,
                  flexWrap: 'wrap',
                  alignItems: 'flex-end',
                  marginBottom: 8,
                }}
              >
                <label
                  style={{ display: 'flex', flexDirection: 'column', gap: 4 }}
                >
                  <span className="muted">Bucket name</span>
                  <input
                    type="text"
                    value={bucketName}
                    onChange={(e) => setBucketName(e.target.value)}
                    placeholder={`${state} batch ${new Date().toLocaleDateString()}`}
                    disabled={saving}
                  />
                </label>
                <label
                  style={{ display: 'flex', flexDirection: 'column', gap: 4 }}
                >
                  <span className="muted">Inspector for all</span>
                  <input
                    type="text"
                    value={bulkInspector}
                    onChange={(e) => setBulkInspector(e.target.value)}
                    placeholder="Optional — applies to all"
                    disabled={saving}
                  />
                </label>
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => void handleSaveAndAssign()}
                  disabled={saving}
                >
                  {saving ? 'Saving…' : 'Save bucket & assign'}
                </button>
              </div>
              <div style={{ overflowX: 'auto' }}>
                <table className="data">
                  <thead>
                    <tr>
                      <th>Bridge</th>
                      <th>Facility</th>
                      <th>County</th>
                      <th>Inspector</th>
                    </tr>
                  </thead>
                  <tbody>
                    {found.map((b) => (
                      <tr key={b.asset_id}>
                        <td>
                          <code>{b.asset_id}</code>
                        </td>
                        <td>{b.facility ?? '—'}</td>
                        <td>{b.county_name ?? '—'}</td>
                        <td>
                          <input
                            type="text"
                            value={perBridgeInspector[b.asset_id] ?? ''}
                            onChange={(e) =>
                              setPerBridgeInspector((prev) => ({
                                ...prev,
                                [b.asset_id]: e.target.value,
                              }))
                            }
                            placeholder={bulkInspector || 'Inspector'}
                            disabled={saving}
                            style={{ minWidth: 120 }}
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}

          {notFound.length > 0 && (
            <div style={{ marginTop: 12 }}>
              <h3 style={{ marginBottom: 4 }}>Not found</h3>
              <p className="muted" style={{ marginTop: 0 }}>
                These IDs did not match any bridge in the {state} inventory:
              </p>
              <div
                style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}
              >
                {notFound.map((raw) => (
                  <span
                    key={raw}
                    className="pill"
                    style={{ background: '#7f1d1d' }}
                  >
                    {raw}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {buckets.length > 0 && (
        <div className="card">
          <h2 style={{ marginTop: 0 }}>Saved buckets</h2>
          <div style={{ overflowX: 'auto' }}>
            <table className="data">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>State</th>
                  <th>Bridges</th>
                  <th>Created</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {buckets.map((b) => (
                  <tr key={b.id}>
                    <td>{b.name}</td>
                    <td>{b.state}</td>
                    <td>{b.asset_ids.length}</td>
                    <td>
                      {b.created_at
                        ? new Date(b.created_at).toLocaleDateString()
                        : '—'}
                    </td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      <button
                        type="button"
                        className="btn"
                        onClick={() => void handleLoadBucket(b)}
                        disabled={resolving || saving}
                        style={{ marginRight: 6 }}
                      >
                        Load
                      </button>
                      <button
                        type="button"
                        className="btn"
                        onClick={() => void handleDeleteBucket(b.id)}
                        disabled={resolving || saving}
                      >
                        Delete
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
