import { useCallback, useEffect, useMemo, useState } from 'react';
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
import {
  getFirmBridges,
  syncFirms,
  getCachedFirms,
  firmServesState,
} from '../lib/firm';
import {
  loadStates,
  loadSharedFirmData,
  computeFirmProgress,
  buildFirmColorMap,
  stateOfAsset,
  type SharedFirmData,
  type FirmProgress,
} from '../lib/stateDashboard';
import type { AdminProfile, Bridge, EmgState, Firm } from '../types';

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

/** Cross-firm sharing view model (migration 017) for the firm ops
 *  overview: the sharing states this firm serves, its own firm record,
 *  and the other firms' shared data. Null in Dashboard state = off. */
interface SharingView {
  states: EmgState[];
  ownFirm: Firm;
  data: SharedFirmData;
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

  // Cross-firm progress sharing (migration 017): when a state this
  // firm serves has sharing ON, the overview ALSO shows the other
  // firms serving that state — their bridge groups (that state's
  // bridges only) and progress, view-only. Null = sharing off for
  // every state this firm serves, and the overview is exactly the
  // firm-scoped view it has always been.
  const [sharing, setSharing] = useState<SharingView | null>(null);
  useEffect(() => {
    let cancelled = false;
    if (!firmLocked || !effectiveFirmId) {
      setSharing(null);
      return;
    }
    (async () => {
      try {
        const states = await loadStates();
        const sharingOn = states.filter((s) => s.share_firm_progress);
        if (sharingOn.length === 0) {
          if (!cancelled) setSharing(null);
          return;
        }
        const synced = await syncFirms().catch(() => [] as Firm[]);
        const allFirms =
          synced.length > 0
            ? synced
            : await getCachedFirms().catch(() => [] as Firm[]);
        const ownFirm = allFirms.find((f) => f.id === effectiveFirmId) ?? null;
        if (!ownFirm) {
          if (!cancelled) setSharing(null);
          return;
        }
        const myStates = sharingOn.filter((s) => firmServesState(ownFirm, s.code));
        if (myStates.length === 0) {
          if (!cancelled) setSharing(null);
          return;
        }
        const data = await loadSharedFirmData(
          effectiveFirmId,
          myStates.map((s) => s.code),
        );
        if (cancelled) return;
        setSharing(
          data.firms.length > 0 ? { states: myStates, ownFirm, data } : null,
        );
      } catch {
        if (!cancelled) setSharing(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [firmLocked, effectiveFirmId]);

  // Shared (other firms') bridge ids, sharing states only.
  const sharedAssetIds = useMemo(
    () =>
      sharing
        ? [...new Set(sharing.data.firmBridges.map((fb) => fb.asset_id))]
        : [],
    [sharing],
  );
  const sharedAssetSet = useMemo(
    () => new Set(sharedAssetIds),
    [sharedAssetIds],
  );

  // Bridge set for the overview map + status board: the firm's own
  // group, plus shared bridges when sharing is active. When sharing
  // is off this is exactly firmAssetIds, unchanged.
  const overviewAssetIds = useMemo(() => {
    if (!firmLocked || firmAssetIds === null) return null;
    if (!sharing) return firmAssetIds;
    const own = new Set(firmAssetIds);
    return [...firmAssetIds, ...sharedAssetIds.filter((id) => !own.has(id))];
  }, [firmLocked, firmAssetIds, sharing, sharedAssetIds]);

  // Per-firm progress for the shared firms (sharing states only).
  const sharedProgress: FirmProgress[] = useMemo(
    () =>
      sharing
        ? computeFirmProgress({
            firms: sharing.data.firms,
            firmBridges: sharing.data.firmBridges,
            inspections: sharing.data.inspections,
            assignments: [],
          })
        : [],
    [sharing],
  );

  // asset_id -> firm name for every bridge in the overview (own +
  // shared). Only built when sharing is active; StatusBoard renders
  // its Firm column only when this is passed.
  const assetFirmName = useMemo(() => {
    if (!sharing) return null;
    const m = new Map<string, string>();
    if (firmAssetIds) {
      for (const id of firmAssetIds) m.set(id, sharing.ownFirm.name);
    }
    const names = new Map(sharing.data.firms.map((f) => [f.id, f.name]));
    for (const fb of sharing.data.firmBridges) {
      const n = names.get(fb.firm_id);
      if (n && !m.has(fb.asset_id)) m.set(fb.asset_id, n);
    }
    return m;
  }, [sharing, firmAssetIds]);

  // asset_id -> firm color for the overview map when sharing is on.
  const firmColorByAsset = useMemo(() => {
    if (!sharing) return undefined;
    const colorMap = buildFirmColorMap([sharing.ownFirm, ...sharing.data.firms]);
    const out: Record<string, string> = {};
    const ownColor = colorMap.get(sharing.ownFirm.id);
    if (ownColor && firmAssetIds) {
      for (const id of firmAssetIds) out[id] = ownColor;
    }
    for (const fb of sharing.data.firmBridges) {
      const c = colorMap.get(fb.firm_id);
      if (c && !out[fb.asset_id]) out[fb.asset_id] = c;
    }
    return out;
  }, [sharing, firmAssetIds]);

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
    // selection — EXCEPT bridges a sharing state has made visible
    // (migration 017), which open read-only like the firm's own.
    // Wait for the firm's bridge group before deciding.
    if (firmLocked) {
      if (firmAssetIds === null) {
        setLoadingDetail(true);
        return;
      }
      if (
        !firmAssetIds.includes(selectedAssetId) &&
        !sharedAssetSet.has(selectedAssetId)
      ) {
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
  }, [selectedAssetId, firmLocked, firmAssetIds, sharedAssetSet]);

  // Firm attribution for the selected bridge while sharing is on:
  // which firm owns it, and (for another firm's bridge) which state's
  // sharing made it visible.
  const selectedFirmInfo = useMemo(() => {
    if (!sharing || !selectedAssetId) return null;
    if (firmAssetIds?.includes(selectedAssetId)) {
      return { firm: sharing.ownFirm, shared: false, stateName: '' };
    }
    const fb = sharing.data.firmBridges.find(
      (x) => x.asset_id === selectedAssetId,
    );
    if (!fb) return null;
    const firm = sharing.data.firms.find((f) => f.id === fb.firm_id) ?? null;
    if (!firm) return null;
    const st = sharing.states.find(
      (s) => s.code === stateOfAsset(selectedAssetId),
    );
    return { firm, shared: true, stateName: st?.name ?? '' };
  }, [sharing, selectedAssetId, firmAssetIds]);

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
              filterAssetIds={firmLocked ? overviewAssetIds : null}
              colorBy={sharing ? 'firm' : undefined}
              firmColorByAsset={firmColorByAsset}
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
              firmAssetIds={firmLocked ? overviewAssetIds : null}
              assetFirmName={assetFirmName}
            />
          </div>
        </main>

        <aside className="dash-sidebar">
          {sharing && (
            <div className="card">
              <h2 style={{ marginTop: 0 }}>
                Shared by {sharing.states.map((s) => s.name).join(' & ')}
              </h2>
              <p className="muted" style={{ marginTop: 0 }}>
                {sharing.states.map((s) => s.name).join(' and ')} turned on
                cross-firm sharing, so you can also see where the other
                firms are working in{' '}
                {sharing.states.length === 1 ? 'that state' : 'those states'}{' '}
                and how far they have progressed. Shared bridges are
                view-only here.
              </p>
              {(() => {
                const colorMap = buildFirmColorMap([
                  sharing.ownFirm,
                  ...sharing.data.firms,
                ]);
                const row = (
                  firm: Firm,
                  progress: FirmProgress | null,
                  own: boolean,
                ) => (
                  <div
                    key={firm.id}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      padding: '6px 0',
                    }}
                  >
                    <span
                      style={{
                        display: 'inline-block',
                        width: 10,
                        height: 10,
                        borderRadius: '50%',
                        background: colorMap.get(firm.id) ?? '#64748b',
                        flexShrink: 0,
                      }}
                    />
                    <span style={{ flex: 1 }}>
                      {firm.name}
                      {own && <span className="muted"> (your firm)</span>}
                    </span>
                    {progress && (
                      <span className="muted">
                        {progress.inspected.toLocaleString()}/
                        {progress.assigned.toLocaleString()} inspected ·{' '}
                        {progress.pctComplete}%
                      </span>
                    )}
                  </div>
                );
                return (
                  <>
                    {row(sharing.ownFirm, null, true)}
                    {sharedProgress.map((p) => {
                      const firm = sharing.data.firms.find(
                        (f) => f.id === p.firm_id,
                      );
                      return firm ? row(firm, p, false) : null;
                    })}
                  </>
                );
              })()}
            </div>
          )}
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

            {selectedFirmInfo && (
              <p className="muted" style={{ marginTop: 0 }}>
                Firm: {selectedFirmInfo.firm.name}
                {selectedFirmInfo.shared &&
                  ` — shared by ${selectedFirmInfo.stateName} (view only)`}
              </p>
            )}

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
                  <div className="table-scroll">
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
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}
</div>
  );
}
