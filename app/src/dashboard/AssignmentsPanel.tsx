import { useCallback, useEffect, useState } from 'react';
import { getSupabase, isOnline, isSupabaseConfigured } from '../lib/supabase';
import type { Assignment } from '../types';
import BulkBridgeInput from './BulkBridgeInput';

interface DistrictRow {
  id: string;
  dist_label: string;
}

interface BridgeRow {
  asset_id: string;
  district: string | null;
  county_name: string | null;
}

const ASSIGNMENT_SELECT =
  'id,asset_id,assigned_to,assigned_by,assigned_at,status,' +
  'completed_by,completed_at,notes,created_at';

function statusPill(status: Assignment['status']): string {
  if (status === 'complete') return '#1b5e20';
  if (status === 'in_progress') return '#a66a00';
  return '#0b57d0';
}

export default function AssignmentsPanel() {
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [districts, setDistricts] = useState<DistrictRow[]>([]);
  const [counties, setCounties] = useState<string[]>([]);
  const [district, setDistrict] = useState('');
  const [county, setCounty] = useState('');
  const [bulkInspector, setBulkInspector] = useState('');
  const [singleAssetId, setSingleAssetId] = useState('');
  const [singleInspector, setSingleInspector] = useState('');
  const [filterInspector, setFilterInspector] = useState('');
  const [tab, setTab] = useState<'district' | 'bulk'>('district');
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const configured = isOnline() && isSupabaseConfigured();

  const reload = useCallback(async () => {
    if (!configured) return;
    setLoading(true);
    setMessage(null);
    try {
      const sb = getSupabase()!;
      const { data: asgData, error: asgError } = await sb
        .from('emg_assignments')
        .select(ASSIGNMENT_SELECT)
        .order('assigned_at', { ascending: false })
        .limit(2000);
      if (asgError) throw asgError;
      setAssignments((asgData ?? []) as unknown as Assignment[]);
      const { data: distData, error: distError } = await sb
        .from('emg_districts')
        .select('id,dist_label')
        .order('id');
      if (distError) throw distError;
      setDistricts((distData ?? []) as unknown as DistrictRow[]);
    } catch (err) {
      setMessage(
        `Load failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setLoading(false);
    }
  }, [configured]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // Populate county dropdown when a district is picked.
  useEffect(() => {
    if (!configured || !district) {
      setCounties([]);
      setCounty('');
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const sb = getSupabase()!;
        const { data, error } = await sb
          .from('emg_bridges')
          .select('county_name')
          .eq('district', district)
          .limit(5000);
        if (error) throw error;
        const names = Array.from(
          new Set(
            ((data ?? []) as { county_name: string | null }[])
              .map((r) => r.county_name)
              .filter((n): n is string => !!n),
          ),
        ).sort();
        if (!cancelled) setCounties(names);
      } catch {
        if (!cancelled) setCounties([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [district, configured]);

  /** Bridges in the current district/county filter with no active assignment. */
  const previewUnassigned = useCallback(async (): Promise<BridgeRow[]> => {
    const sb = getSupabase()!;
    let q = sb.from('emg_bridges').select('asset_id,district,county_name');
    if (district) q = q.eq('district', district);
    if (county) q = q.eq('county_name', county);
    const { data, error } = await q.limit(5000);
    if (error) throw error;
    const bridges = (data ?? []) as BridgeRow[];
    const active = new Set(
      assignments
        .filter((a) => a.status === 'assigned' || a.status === 'in_progress')
        .map((a) => a.asset_id),
    );
    return bridges.filter((b) => !active.has(b.asset_id));
  }, [district, county, assignments]);

  const handleBulkAssign = async () => {
    const name = bulkInspector.trim();
    if (!name) {
      setMessage('Enter an inspector name for the bulk assignment.');
      return;
    }
    if (!district && !county) {
      setMessage('Pick a district or county first.');
      return;
    }
    setLoading(true);
    setMessage(null);
    try {
      const targets = await previewUnassigned();
      if (targets.length === 0) {
        setMessage('No unassigned bridges in this selection.');
        return;
      }
      const sb = getSupabase()!;
      const rows = targets.map((b) => ({
        asset_id: b.asset_id,
        assigned_to: name,
        assigned_by: 'dashboard',
        status: 'assigned',
      }));
      // Insert in chunks to stay under payload limits.
      for (let i = 0; i < rows.length; i += 500) {
        const { error } = await sb
          .from('emg_assignments')
          .insert(rows.slice(i, i + 500));
        if (error) throw error;
      }
      setMessage(
        `Assigned ${targets.length} bridge${targets.length === 1 ? '' : 's'} to ${name}.`,
      );
      await reload();
    } catch (err) {
      setMessage(
        `Bulk assign failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setLoading(false);
    }
  };

  const handleSingleAssign = async () => {
    const assetId = singleAssetId.trim();
    const name = singleInspector.trim();
    if (!assetId || !name) {
      setMessage('Enter both a bridge asset ID and an inspector name.');
      return;
    }
    setLoading(true);
    setMessage(null);
    try {
      const sb = getSupabase()!;
      // Verify the bridge exists.
      const { data: bridge, error: bridgeError } = await sb
        .from('emg_bridges')
        .select('asset_id')
        .eq('asset_id', assetId)
        .maybeSingle();
      if (bridgeError) throw bridgeError;
      if (!bridge) {
        setMessage(`Bridge ${assetId} not found in inventory.`);
        return;
      }
      const { error } = await sb.from('emg_assignments').insert({
        asset_id: assetId,
        assigned_to: name,
        assigned_by: 'dashboard',
        status: 'assigned',
      });
      if (error) throw error;
      setMessage(`Assigned ${assetId} to ${name}.`);
      setSingleAssetId('');
      await reload();
    } catch (err) {
      setMessage(
        `Assign failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setLoading(false);
    }
  };

  const filtered = assignments.filter((a) => {
    const f = filterInspector.trim().toLowerCase();
    if (!f) return true;
    return (
      a.assigned_to.toLowerCase().includes(f) ||
      (a.completed_by ?? '').toLowerCase().includes(f) ||
      a.asset_id.toLowerCase().includes(f)
    );
  });

  const openCount = assignments.filter((a) => a.status !== 'complete').length;

  if (!configured) {
    return (
      <div className="card">
        <h1>Assignments</h1>
        <p className="muted">
          Supabase is not configured or the device is offline. Assignments
          require a connection.
        </p>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div className="card">
        <h1>
          Assignments{' '}
          <span className="muted" style={{ fontWeight: 400, fontSize: 13 }}>
            {openCount} open / {assignments.length} total
          </span>
        </h1>
        {message && (
          <p className="muted" style={{ color: '#e2e8f0' }}>
            {message}
          </p>
        )}
        <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
          <button
            type="button"
            className={tab === 'district' ? 'btn btn-primary' : 'btn'}
            onClick={() => setTab('district')}
          >
            District / County
          </button>
          <button
            type="button"
            className={tab === 'bulk' ? 'btn btn-primary' : 'btn'}
            onClick={() => setTab('bulk')}
          >
            Bulk Input
          </button>
        </div>
      </div>

      {tab === 'district' && (
        <>
          <div className="card">
            <h2 style={{ marginTop: 0 }}>Bulk assign by district / county</h2>
        <div
          style={{
            display: 'flex',
            gap: 8,
            flexWrap: 'wrap',
            alignItems: 'flex-end',
          }}
        >
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span className="muted">District</span>
            <select
              value={district}
              onChange={(e) => setDistrict(e.target.value)}
              disabled={loading}
            >
              <option value="">All districts</option>
              {districts.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.dist_label}
                </option>
              ))}
            </select>
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span className="muted">County</span>
            <select
              value={county}
              onChange={(e) => setCounty(e.target.value)}
              disabled={loading || counties.length === 0}
            >
              <option value="">All counties</option>
              {counties.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span className="muted">Inspector</span>
            <input
              type="text"
              value={bulkInspector}
              onChange={(e) => setBulkInspector(e.target.value)}
              placeholder="Inspector name"
              disabled={loading}
            />
          </label>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => void handleBulkAssign()}
            disabled={loading}
          >
            {loading ? 'Working…' : 'Assign all unassigned'}
          </button>
        </div>
        <p className="muted" style={{ marginBottom: 0 }}>
          Assigns every bridge in the selection that has no active assignment.
          Bridges already assigned or in progress are skipped.
        </p>
      </div>

      <div className="card">
        <h2 style={{ marginTop: 0 }}>Assign one bridge</h2>
        <div
          style={{
            display: 'flex',
            gap: 8,
            flexWrap: 'wrap',
            alignItems: 'flex-end',
          }}
        >
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span className="muted">Asset ID</span>
            <input
              type="text"
              value={singleAssetId}
              onChange={(e) => setSingleAssetId(e.target.value)}
              placeholder="e.g. SC-1892"
              disabled={loading}
            />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span className="muted">Inspector</span>
            <input
              type="text"
              value={singleInspector}
              onChange={(e) => setSingleInspector(e.target.value)}
              placeholder="Inspector name"
              disabled={loading}
            />
          </label>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => void handleSingleAssign()}
            disabled={loading}
          >
            Assign
          </button>
        </div>
      </div>
        </>
      )}

      {tab === 'bulk' && <BulkBridgeInput />}

      <div className="card">
        <h2 style={{ marginTop: 0 }}>Assignment status</h2>
        <div style={{ marginBottom: 8 }}>
          <input
            type="text"
            value={filterInspector}
            onChange={(e) => setFilterInspector(e.target.value)}
            placeholder="Filter by inspector or bridge…"
            style={{ width: '100%', maxWidth: 320 }}
          />
        </div>
        {filtered.length === 0 && (
          <p className="muted">No assignments found.</p>
        )}
        {filtered.length > 0 && (
          <div style={{ overflowX: 'auto' }}>
            <table className="data">
              <thead>
                <tr>
                  <th>Bridge</th>
                  <th>Assigned to</th>
                  <th>Status</th>
                  <th>Completed by</th>
                  <th>Assigned</th>
                </tr>
              </thead>
              <tbody>
                {filtered.slice(0, 500).map((a) => (
                  <tr key={a.id}>
                    <td>
                      <code>{a.asset_id}</code>
                    </td>
                    <td>{a.assigned_to}</td>
                    <td>
                      <span
                        className="pill"
                        style={{ background: statusPill(a.status) }}
                      >
                        {a.status.replace('_', ' ')}
                      </span>
                    </td>
                    <td>
                      {a.completed_by
                        ? a.completed_by +
                          (a.completed_by.toLowerCase() !==
                          a.assigned_to.toLowerCase()
                            ? ' (cross)'
                            : '')
                        : '—'}
                    </td>
                    <td>
                      {a.assigned_at
                        ? new Date(a.assigned_at).toLocaleDateString()
                        : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {filtered.length > 500 && (
              <p className="muted">
                Showing 500 of {filtered.length} — refine the filter.
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
