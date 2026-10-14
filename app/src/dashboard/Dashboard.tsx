import { useCallback, useEffect, useState } from 'react';
import StatusBoard from './StatusBoard';
import RoadNetworkPanel from './RoadNetworkPanel';
import ActivityFeed from './ActivityFeed';
import DataIntake from './DataIntake';
import AssignmentsPanel from './AssignmentsPanel';
import TeamMap from '../components/TeamMap';
import TeamRoster from './TeamRoster';
import AdminManager from './AdminManager';
import { getSupabase, isOnline, isSupabaseConfigured } from '../lib/supabase';
import { idbGetAll } from '../lib/idb';
import { getFirmBridges } from '../lib/firm';
import type { AdminProfile, Bridge } from '../types';

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

export default function Dashboard({
  firmId,
  firmName,
  adminProfile,
}: {
  firmId?: string;
  firmName?: string;
  /** Signed-in admin's role profile (migration 015). Drives the Admins
   *  tab and state scoping of firm pickers. */
  adminProfile?: AdminProfile | null;
}) {
  const canManageAdmins =
    adminProfile?.role === 'super_admin' ||
    adminProfile?.role === 'state_admin';
  const rosterStateCode =
    adminProfile?.role === 'state_admin'
      ? (adminProfile.stateCode ?? null)
      : null;

  // Firm lock: a firm_admin whose profile (or session) is bound to one
  // firm is pinned to it — no firm switcher anywhere, and every panel
  // below is scoped to that firm. super_admin / state_admin are unbound.
  const boundFirmId =
    adminProfile?.role === 'firm_admin'
      ? (adminProfile.firmId ?? firmId ?? null)
      : null;
  const firmLocked = boundFirmId != null;
  const effectiveFirmId = boundFirmId ?? firmId ?? null;
  // The locked firm's bridge group (asset ids) — scopes the map, the
  // status board, the activity feed, and bridge-detail access.
  const [firmAssetIds, setFirmAssetIds] = useState<string[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    if (!firmLocked || !effectiveFirmId) {
      setFirmAssetIds(null);
      return;
    }
    getFirmBridges(effectiveFirmId)
      .then((ids) => {
        if (!cancelled) setFirmAssetIds(ids);
      })
      .catch(() => {
        if (!cancelled) setFirmAssetIds([]);
      });
    return () => {
      cancelled = true;
    };
  }, [firmLocked, effectiveFirmId]);
  const [selectedAssetId, setSelectedAssetId] = useState<string | null>(null);
  const [bridge, setBridge] = useState<Bridge | null>(null);
  const [inspections, setInspections] = useState<BridgeInspection[] | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  /** True when a locked firm_admin selected a bridge outside their firm. */
  const [detailBlocked, setDetailBlocked] = useState(false);
  const [view, setView] = useState<'overview' | 'assignments' | 'team' | 'admins'>('overview');

  const handleSelectBridge = useCallback((assetId: string) => {
    setSelectedAssetId(assetId);
  }, []);

  useEffect(() => {
    if (!selectedAssetId) {
      setBridge(null);
      setInspections(null);
      setDetailBlocked(false);
      return;
    }
    // Firm lock: never surface another firm's bridge, even by direct
    // selection. Wait for the firm's bridge group before deciding.
    if (firmLocked) {
      if (firmAssetIds === null) {
        setLoadingDetail(true);
        return;
      }
      if (!firmAssetIds.includes(selectedAssetId)) {
        setBridge(null);
        setInspections([]);
        setDetailBlocked(true);
        setLoadingDetail(false);
        return;
      }
    }
    setDetailBlocked(false);
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
  }, [selectedAssetId, firmLocked, firmAssetIds]);

  return (
    <div className="dash">
      <header className="dash-header">
        <div className="eyebrow">Firm operations</div>
        <h1>Emergency Bridge Inspection</h1>
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
            className={view === 'assignments' ? 'active' : ''}
            onClick={() => setView('assignments')}
          >
            Assignments
          </button>
          <button
            type="button"
            className={view === 'team' ? 'active' : ''}
            onClick={() => setView('team')}
          >
            Team roster
          </button>
          {canManageAdmins && (
            <button
              type="button"
              className={view === 'admins' ? 'active' : ''}
              onClick={() => setView('admins')}
            >
              Admins
            </button>
          )}
        </nav>
      </header>

      {view === 'assignments' ? (
        <div className="dash-grid" style={{ gridTemplateColumns: '1fr' }}>
          <main className="dash-main">
            <AssignmentsPanel
              firmId={effectiveFirmId ?? undefined}
              firmLocked={firmLocked}
              adminProfile={adminProfile}
            />
          </main>
        </div>
      ) : view === 'team' ? (
        <div className="dash-grid" style={{ gridTemplateColumns: '1fr' }}>
          <main className="dash-main">
            <TeamRoster
              firmId={effectiveFirmId ?? undefined}
              firmName={firmName}
              stateCode={rosterStateCode}
            />
          </main>
        </div>
      ) : view === 'admins' && canManageAdmins && adminProfile ? (
        <div className="dash-grid" style={{ gridTemplateColumns: '1fr' }}>
          <main className="dash-main">
            <AdminManager profile={adminProfile} />
          </main>
        </div>
      ) : (
      <>
      {/* Operations map — full content width so progress is readable. */}
      <div className="dash-grid" style={{ gridTemplateColumns: '1fr' }}>
        <main className="dash-main">
          <div className="card" style={{ marginBottom: 0 }}>
            <TeamMap
              showTeam
              height="62vh"
              onBridgeClick={handleSelectBridge}
              filterAssetIds={firmLocked ? firmAssetIds : null}
            />
          </div>
        </main>
      </div>
      <div className="dash-grid">
        <main className="dash-main">
          <div className="card">
            <StatusBoard
              onSelectBridge={handleSelectBridge}
              stateCode={rosterStateCode}
              firmAssetIds={firmLocked ? firmAssetIds : null}
            />
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
            <ActivityFeed firmAssetIds={firmLocked ? firmAssetIds : null} />
          </div>
        </aside>
      </div>
      </>
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

            {detailBlocked && (
              <p className="muted">
                This bridge is not in your firm&rsquo;s group, so its details
                are not available in firm operations.
              </p>
            )}

            {!bridge && !detailBlocked && (
              <p className="muted">Loading bridge inventory…</p>
            )}

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
</div>
  );
}
