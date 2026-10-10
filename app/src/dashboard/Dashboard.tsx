import { useCallback, useEffect, useState } from 'react';
import StatusBoard from './StatusBoard';
import RoadNetworkPanel from './RoadNetworkPanel';
import ActivityFeed from './ActivityFeed';
import DataIntake from './DataIntake';
import UploadNbi from './UploadNbi';
import TeamMap from '../components/TeamMap';
import { getSupabase, isOnline, isSupabaseConfigured } from '../lib/supabase';
import { idbGetAll } from '../lib/idb';
import type { Bridge } from '../types';

interface BridgeInspection {
  id: string;
  asset_id: string;
  triage_list: string | null;
  inspector_name: string | null;
  inspection_datetime: string | null;
  remain_open: string | null;
  safe_load: string | null;
}

function rating(v: unknown): string {
  if (v === null || v === undefined || v === '') return '—';
  return String(v);
}

export default function Dashboard() {
  const [selectedAssetId, setSelectedAssetId] = useState<string | null>(null);
  const [bridge, setBridge] = useState<Bridge | null>(null);
  const [inspections, setInspections] = useState<BridgeInspection[] | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [view, setView] = useState<'overview' | 'upload'>('overview');

  const handleSelectBridge = useCallback((assetId: string) => {
    setSelectedAssetId(assetId);
  }, []);

  useEffect(() => {
    if (!selectedAssetId) {
      setBridge(null);
      setInspections(null);
      return;
    }
    let cancelled = false;

    async function loadDetail() {
      setLoadingDetail(true);
      try {
        // Bridge from cache
        try {
          const cached = await idbGetAll<Bridge>('bridges');
          if (!cancelled) {
            const found = cached.find((b) => b.asset_id === selectedAssetId);
            if (found) setBridge(found);
          }
        } catch {
          /* ignore cache errors */
        }

        // Inspections
        const results: BridgeInspection[] = [];
        if (isOnline() && isSupabaseConfigured()) {
          const sb = getSupabase()!;
          const { data, error } = await sb
            .from('emg_inspections')
            .select(
              'id,asset_id,triage_list,inspector_name,inspection_datetime,remain_open,safe_load'
            )
            .eq('asset_id', selectedAssetId)
            .order('inspection_datetime', { ascending: false });
          if (error) throw error;
          if (data) {
            for (const row of data as BridgeInspection[]) results.push(row);
          }
        } else {
          try {
            const cached = await idbGetAll<BridgeInspection>('emg_inspections');
            for (const row of cached) {
              if (row.asset_id === selectedAssetId) results.push(row);
            }
            results.sort((a, b) => {
              const da = a.inspection_datetime ?? '';
              const db = b.inspection_datetime ?? '';
              return db.localeCompare(da);
            });
          } catch {
            /* ignore */
          }
        }

        if (!cancelled) setInspections(results);
      } catch {
        if (!cancelled) setInspections([]);
      } finally {
        if (!cancelled) setLoadingDetail(false);
      }
    }

    void loadDetail();
    return () => {
      cancelled = true;
    };
  }, [selectedAssetId]);

  return (
    <div className="dash">
      <header className="dash-header">
        <h1>Emergency Bridge Inspection — Operations Dashboard</h1>
        <nav className="dash-tabs" aria-label="Dashboard views">
          <button
            type="button"
            className={view === 'overview' ? 'active' : ''}
            onClick={() => setView('overview')}
          >
            Overview
          </button>
          <button
            type="button"
            className={view === 'upload' ? 'active' : ''}
            onClick={() => setView('upload')}
          >
            Upload NBI state file
          </button>
        </nav>
      </header>

      {view === 'upload' ? (
        <div className="dash-grid" style={{ gridTemplateColumns: '1fr' }}>
          <main className="dash-main">
            <UploadNbi />
          </main>
        </div>
      ) : (
      <div className="dash-grid">
        <main className="dash-main">
          <div className="card">
            <TeamMap showTeam height="62vh" onBridgeClick={handleSelectBridge} />
          </div>
          <div className="card">
            <StatusBoard onSelectBridge={handleSelectBridge} />
          </div>
        </main>

        <aside className="dash-sidebar">
          <div className="card">
            <DataIntake />
          </div>
          <div className="card">
            <RoadNetworkPanel />
          </div>
          <div className="card">
            <ActivityFeed />
          </div>
        </aside>
      </div>
      )}

      {selectedAssetId && (
        <div className="bridge-detail-overlay" role="dialog" aria-modal="true">
          <div className="card bridge-detail">
            <div className="bridge-detail-head">
              <h2>
                Bridge {selectedAssetId}
                {bridge ? ` — ${bridge.county_name ?? ''}` : ''}
              </h2>
              <button
                type="button"
                className="btn-close"
                onClick={() => setSelectedAssetId(null)}
                aria-label="Close bridge detail"
              >
                ×
              </button>
            </div>

            {!bridge && <p className="muted">Loading bridge inventory…</p>}

            {bridge && (
              <div className="bridge-fields">
                <dl className="field-grid">
                  <div>
                    <dt>Asset ID</dt>
                    <dd>{rating(bridge.asset_id)}</dd>
                  </div>
                  <div>
                    <dt>Struct No</dt>
                    <dd>{rating(bridge.struct_no)}</dd>
                  </div>
                  <div>
                    <dt>County</dt>
                    <dd>{rating(bridge.county_name)}</dd>
                  </div>
                  <div>
                    <dt>District</dt>
                    <dd>{rating(bridge.district)}</dd>
                  </div>
                  <div>
                    <dt>Facility Carried</dt>
                    <dd>{rating(bridge.facility)}</dd>
                  </div>
                  <div>
                    <dt>Feature Intersected</dt>
                    <dd>{rating(bridge.feature)}</dd>
                  </div>
                  <div>
                    <dt>Location</dt>
                    <dd>{rating(bridge.location)}</dd>
                  </div>
                  <div>
                    <dt>Deck Rating</dt>
                    <dd>{rating(bridge.deck)}</dd>
                  </div>
                  <div>
                    <dt>Superstructure Rating</dt>
                    <dd>{rating(bridge.super)}</dd>
                  </div>
                  <div>
                    <dt>Substructure Rating</dt>
                    <dd>{rating(bridge.sub)}</dd>
                  </div>
                  <div>
                    <dt>Channel Rating</dt>
                    <dd>{rating(bridge.channel)}</dd>
                  </div>
                  <div>
                    <dt>Culvert Rating</dt>
                    <dd>{rating(bridge.culvert)}</dd>
                  </div>
                  <div>
                    <dt>Scour</dt>
                    <dd>{rating(bridge.scour)}</dd>
                  </div>
                  <div>
                    <dt>Inventory Rating</dt>
                    <dd>{rating(bridge.inv_rating)}</dd>
                  </div>
                  <div>
                    <dt>Operating Rating</dt>
                    <dd>{rating(bridge.op_rating)}</dd>
                  </div>
                  <div>
                    <dt>Year Built</dt>
                    <dd>{rating(bridge.yr_built)}</dd>
                  </div>
                  <div>
                    <dt>Length</dt>
                    <dd>{rating(bridge.length_m)}</dd>
                  </div>
                  <div>
                    <dt>Spans</dt>
                    <dd>{rating(bridge.spans)}</dd>
                  </div>
                  <div>
                    <dt>Lanes</dt>
                    <dd>{rating(bridge.lanes)}</dd>
                  </div>
                  <div>
                    <dt>ADT</dt>
                    <dd>{rating(bridge.adt)}</dd>
                  </div>
                </dl>

                <h2>Inspections</h2>
                {loadingDetail && inspections === null && (
                  <p className="muted">Loading inspections…</p>
                )}
                {inspections && inspections.length === 0 && (
                  <p className="muted">No inspections recorded for this bridge.</p>
                )}
                {inspections && inspections.length > 0 && (
                  <table className="data">
                    <thead>
                      <tr>
                        <th>Triage</th>
                        <th>Inspector</th>
                        <th>Date / Time</th>
                        <th>Remain Open</th>
                        <th>Safe Load</th>
                      </tr>
                    </thead>
                    <tbody>
                      {inspections.map((insp) => {
                        const triage = insp.triage_list ?? 'unclassified';
                        return (
                          <tr key={insp.id}>
                            <td>
                              <span className={`pill pill-${triage}`}>{triage}</span>
                            </td>
                            <td>{insp.inspector_name ?? '—'}</td>
                            <td>
                              {insp.inspection_datetime
                                ? new Date(insp.inspection_datetime).toLocaleString()
                                : '—'}
                            </td>
                            <td>{insp.remain_open ?? '—'}</td>
                            <td>{insp.safe_load ?? '—'}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      <style>{`
        .dash {
          display: flex;
          flex-direction: column;
          min-height: 100vh;
          background: #0f172a;
          color: #e2e8f0;
          font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
        }
        .dash-header {
          padding: 16px 20px;
          border-bottom: 1px solid #1e293b;
          background: #111827;
        }
        .dash-header h1 {
          margin: 0;
          font-size: 18px;
          font-weight: 600;
          letter-spacing: 0.01em;
        }
        .dash-tabs {
          display: flex;
          gap: 8px;
          margin-top: 10px;
        }
        .dash-tabs button {
          background: transparent;
          color: #94a3b8;
          border: 1px solid #334155;
          border-radius: 6px;
          padding: 6px 14px;
          font-size: 13px;
          cursor: pointer;
        }
        .dash-tabs button.active {
          background: #1e3a5f;
          color: #e2e8f0;
          border-color: #38bdf8;
        }
        .dash-tabs button:hover {
          color: #e2e8f0;
        }
        .dash .btn {
          display: inline-block;
          width: auto;
          min-height: 0;
          font-size: 14px;
          padding: 8px 16px;
        }
        .dash .btn-primary {
          background: #2563eb;
        }
        .dash .btn-primary:hover {
          background: #1d4ed8;
        }
        .dash select, .dash input[type="text"] {
          background: #0f172a;
          color: #e2e8f0;
          border: 1px solid #475569;
          border-radius: 6px;
          padding: 6px 10px;
          font-size: 14px;
        }
        .dash code {
          background: #0f172a;
          padding: 1px 5px;
          border-radius: 4px;
          font-size: 12px;
        }
        .dash-grid {
          display: grid;
          grid-template-columns: 1fr 380px;
          gap: 16px;
          padding: 16px;
          flex: 1;
          align-items: start;
        }
        .dash-main {
          display: flex;
          flex-direction: column;
          gap: 16px;
          min-width: 0;
        }
        .dash-sidebar {
          display: flex;
          flex-direction: column;
          gap: 16px;
          min-width: 0;
        }
        .dash .card {
          background: #1e293b;
          border: 1px solid #334155;
          border-radius: 10px;
          padding: 14px;
          box-shadow: 0 1px 2px rgba(0, 0, 0, 0.3);
        }
        .dash .card h1 {
          margin: 0 0 8px;
          font-size: 16px;
          font-weight: 600;
        }
        .dash .card h2 {
          margin: 12px 0 8px;
          font-size: 14px;
          font-weight: 600;
          color: #cbd5e1;
        }
        .bridge-detail-overlay {
          position: fixed;
          inset: 0;
          background: rgba(2, 6, 23, 0.7);
          display: flex;
          align-items: center;
          justify-content: center;
          z-index: 50;
          padding: 24px;
        }
        .bridge-detail {
          max-width: 900px;
          width: 100%;
          max-height: 88vh;
          overflow-y: auto;
        }
        .bridge-detail-head {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
          margin-bottom: 12px;
        }
        .bridge-detail-head h2 {
          margin: 0;
          font-size: 16px;
        }
        .btn-close {
          background: transparent;
          color: #e2e8f0;
          border: 1px solid #475569;
          border-radius: 6px;
          font-size: 18px;
          line-height: 1;
          padding: 4px 10px;
          cursor: pointer;
        }
        .btn-close:hover {
          background: #334155;
        }
        .field-grid {
          display: grid;
          grid-template-columns: repeat(3, minmax(0, 1fr));
          gap: 10px 16px;
          margin: 0 0 16px;
        }
        .field-grid > div {
          min-width: 0;
        }
        .field-grid dt {
          font-size: 11px;
          text-transform: uppercase;
          letter-spacing: 0.05em;
          color: #94a3b8;
          margin-bottom: 2px;
        }
        .field-grid dd {
          margin: 0;
          font-size: 13px;
          color: #e2e8f0;
          word-break: break-word;
        }
        .muted {
          color: #94a3b8;
          font-size: 13px;
        }
        table.data {
          width: 100%;
          border-collapse: collapse;
          font-size: 13px;
        }
        table.data th,
        table.data td {
          text-align: left;
          padding: 6px 8px;
          border-bottom: 1px solid #334155;
        }
        table.data th {
          color: #94a3b8;
          font-weight: 600;
          font-size: 12px;
          text-transform: uppercase;
          letter-spacing: 0.04em;
        }
        .pill {
          display: inline-block;
          padding: 2px 8px;
          border-radius: 999px;
          font-size: 11px;
          font-weight: 600;
          background: #334155;
          color: #e2e8f0;
        }
      `}</style>
    </div>
  );
}
