import { useCallback, useEffect, useMemo, useState } from 'react';
import TeamMap from '../components/TeamMap';
import FirmBulkAssign from './FirmBulkAssign';
import {
  loadStateData,
  loadStates,
  computeFirmProgress,
  computeStateOverview,
  buildStateBridgeRows,
  getBridgeDetail,
  buildFirmColorMap,
  type StateData,
  type FirmProgress,
  type StateOverview,
  type StateBridgeRow,
  type BridgeDetail,
} from '../lib/stateDashboard';
import type { EmgState, Firm } from '../types';

type View = 'overview' | 'assign' | 'map';

const STATUS_OPTIONS = [
  { value: 'all', label: 'All statuses' },
  { value: 'not-started', label: 'Not started' },
  { value: 'destroyed', label: 'Destroyed' },
  { value: 'likely_destroyed', label: 'Likely destroyed' },
  { value: 'revisit', label: 'Revisit' },
  { value: 'ground_followup', label: 'Ground follow-up' },
  { value: 'complete', label: 'Complete' },
  { value: 'in_progress', label: 'In progress' },
];

function triageLabel(t: string | null): string {
  switch (t) {
    case 'destroyed':
      return 'Destroyed';
    case 'likely_destroyed':
      return 'Likely destroyed';
    case 'revisit':
      return 'Revisit';
    case 'ground_followup':
      return 'Ground follow-up';
    case 'complete':
      return 'Complete';
    case 'in_progress':
      return 'In progress';
    default:
      return 'Not started';
  }
}

function openLabel(o: string | null): string {
  switch (o) {
    case 'yes':
      return 'Open';
    case 'restricted_lanes':
      return 'Restricted';
    case 'no':
      return 'Closed';
    default:
      return '—';
  }
}

function StatCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="card stat-card">
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {sub && <div className="muted" style={{ fontSize: 12 }}>{sub}</div>}
    </div>
  );
}

interface StateDashboardProps {
  /** Fixed state scope (state_admin sessions). Null/undefined = all
   *  states, with a state filter dropdown (super_admin). */
  stateScope?: string | null;
}

export default function StateDashboard({ stateScope }: StateDashboardProps) {
  const [view, setView] = useState<View>('overview');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<StateData | null>(null);
  const [overview, setOverview] = useState<StateOverview | null>(null);

  // State scope: a state_admin is locked to `stateScope`; a super_admin
  // picks via the state filter ('all' = every state).
  const [states, setStates] = useState<EmgState[]>([]);
  const [stateFilter, setStateFilter] = useState<string>('all');
  const effectiveScope: string | null =
    stateScope ?? (stateFilter === 'all' ? null : stateFilter);
  const scopeName =
    states.find((s) => s.code === effectiveScope)?.name ?? effectiveScope;

  useEffect(() => {
    let cancelled = false;
    loadStates()
      .then((list) => {
        if (!cancelled) setStates(list);
      })
      .catch(() => {
        // fallback list already applied inside loadStates on failure
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Filters
  const [firmFilter, setFirmFilter] = useState<string>('all');
  const [countyFilter, setCountyFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');

  // Bridges table
  const [rows, setRows] = useState<StateBridgeRow[]>([]);
  const [rowsLoading, setRowsLoading] = useState(false);
  const [page, setPage] = useState(0);
  const PAGE_SIZE = 50;

  // Map
  const [mapColorBy, setMapColorBy] = useState<'firm' | 'status'>('firm');
  const [selectedAssetId, setSelectedAssetId] = useState<string | null>(null);
  const [bridgeDetail, setBridgeDetail] = useState<BridgeDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const loadAll = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const d = await loadStateData(effectiveScope);
      setData(d);
      setOverview(await computeStateOverview(d, effectiveScope));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [effectiveScope]);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  // Rebuild the bridge rows when data arrives (county/facility lookup).
  useEffect(() => {
    if (!data) return;
    let cancelled = false;
    setRowsLoading(true);
    buildStateBridgeRows(data)
      .then((r) => {
        if (!cancelled) {
          setRows(r);
          setPage(0);
        }
      })
      .catch(() => {
        if (!cancelled) setRows([]);
      })
      .finally(() => {
        if (!cancelled) setRowsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [data]);

  const progress: FirmProgress[] = useMemo(
    () => (data ? computeFirmProgress(data) : []),
    [data],
  );

  const firmColorMap = useMemo(
    () => buildFirmColorMap(data?.firms ?? []),
    [data],
  );

  const firmColorByAsset: Record<string, string> = useMemo(() => {
    if (!data) return {};
    const out: Record<string, string> = {};
    for (const fb of data.firmBridges) {
      const c = firmColorMap.get(fb.firm_id);
      if (c && !out[fb.asset_id]) out[fb.asset_id] = c;
    }
    return out;
  }, [data, firmColorMap]);

  // County options come only from bridges already in scope (the loaded
  // rows are state-scoped), so picking NC can never list SC counties.
  const countyOptions = useMemo(() => {
    const names = new Set<string>();
    for (const r of rows) {
      if (r.county) names.add(r.county);
    }
    return [...names].sort((a, b) => a.localeCompare(b));
  }, [rows]);

  // Filtered bridge rows (drives the table and the map filter).
  const filteredRows = useMemo(() => {
    return rows.filter((r) => {
      if (firmFilter !== 'all' && r.firm_id !== firmFilter) return false;
      if (countyFilter && (r.county ?? '') !== countyFilter) return false;
      if (statusFilter !== 'all') {
        if (statusFilter === 'not-started') {
          if (r.triage) return false;
        } else if (r.triage !== statusFilter) {
          return false;
        }
      }
      return true;
    });
  }, [rows, firmFilter, countyFilter, statusFilter]);

  const pageCount = Math.max(1, Math.ceil(filteredRows.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount - 1);
  const pageRows = filteredRows.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE);

  // Map filter: cap at 8000 assets so the GeoJSON stays responsive.
  const mapFilterIds = useMemo<string[] | null>(() => {
    const anyFilter = firmFilter !== 'all' || countyFilter || statusFilter !== 'all';
    if (!anyFilter) return null;
    return filteredRows.slice(0, 8000).map((r) => r.asset_id);
  }, [filteredRows, firmFilter, countyFilter, statusFilter]);

  // Region the map should frame: the bridges currently in view (which
  // are the selected state's bridges whenever a state is selected).
  // The key changes only when the scope/filters change.
  const mapFit = useMemo(() => {
    let minLon = Infinity;
    let minLat = Infinity;
    let maxLon = -Infinity;
    let maxLat = -Infinity;
    let n = 0;
    for (const r of filteredRows) {
      if (typeof r.lon !== 'number' || typeof r.lat !== 'number') continue;
      if (r.lon < minLon) minLon = r.lon;
      if (r.lon > maxLon) maxLon = r.lon;
      if (r.lat < minLat) minLat = r.lat;
      if (r.lat > maxLat) maxLat = r.lat;
      n += 1;
    }
    if (n === 0) return null;
    // Single point / degenerate bounds: pad so fitBounds has an area.
    const padLon = maxLon - minLon < 0.01 ? 0.01 : 0;
    const padLat = maxLat - minLat < 0.01 ? 0.01 : 0;
    return {
      key: `${effectiveScope ?? 'all'}|${firmFilter}|${countyFilter}|${statusFilter}`,
      bounds: [
        [minLon - padLon, minLat - padLat],
        [maxLon + padLon, maxLat + padLat],
      ] as [[number, number], [number, number]],
    };
  }, [filteredRows, effectiveScope, firmFilter, countyFilter, statusFilter]);

  // Firm-scoped overview cards when a firm is selected.
  const scopedProgress: FirmProgress | null = useMemo(() => {
    if (firmFilter === 'all') return null;
    return progress.find((p) => p.firm_id === firmFilter) ?? null;
  }, [progress, firmFilter]);

  const handleSelectBridge = useCallback(
    (assetId: string) => {
      setSelectedAssetId(assetId);
      if (!data) return;
      setDetailLoading(true);
      getBridgeDetail(assetId, data)
        .then(setBridgeDetail)
        .catch(() =>
          setBridgeDetail({
            asset_id: assetId,
            firm: null,
            county: null,
            facility: null,
            feature: null,
            inspector: null,
            assignStatus: null,
            triage: null,
            openStatus: null,
            inspectedAt: null,
            inspectedBy: null,
          }),
        )
        .finally(() => setDetailLoading(false));
    },
    [data],
  );

  const firms: Firm[] = data?.firms ?? [];

  return (
    <div className="dash">
      <header className="dash-header">
        <div className="eyebrow">State operations</div>
        <h1>Emergency Bridge Inspection</h1>
        {stateScope ? (
          <p className="muted" style={{ margin: '4px 0 0' }}>
            {scopeName ?? stateScope} — showing only this state&rsquo;s firms
            and bridges.
          </p>
        ) : null}
        <div className="state-tabs-row">
          <nav className="dash-tabs" aria-label="State dashboard views">
            <button
              type="button"
              className={view === 'overview' ? 'active' : ''}
              onClick={() => setView('overview')}
            >
              Overview
            </button>
            <button
              type="button"
              className={view === 'assign' ? 'active' : ''}
              onClick={() => setView('assign')}
            >
              Assign to firms
            </button>
            <button
              type="button"
              className={view === 'map' ? 'active' : ''}
              onClick={() => setView('map')}
            >
              Map
            </button>
          </nav>
          {/* State selector lives IN the tabs row, right-aligned — a
              state_admin (stateScope set) never sees it at all. */}
          {!stateScope && (
            <label className="state-select">
              <span className="muted">State</span>
              <select
                value={stateFilter}
                onChange={(e) => setStateFilter(e.target.value)}
              >
                <option value="all">All states</option>
                {states.map((s) => (
                  <option key={s.code} value={s.code}>
                    {s.name} ({s.code})
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
      </header>

      {loading && (
        <div style={{ padding: 24 }}>
          <p className="muted">Loading state data…</p>
        </div>
      )}
      {error && (
        <div style={{ padding: 24 }}>
          <p style={{ color: '#f87171' }}>Failed to load: {error}</p>
          <button type="button" className="btn" onClick={() => void loadAll()}>
            Retry
          </button>
        </div>
      )}

      {!loading && !error && view === 'overview' && (
        <div className="dash-grid" style={{ gridTemplateColumns: '1fr' }}>
          <main className="dash-main">
            {/* Stat cards */}
            <div className="stat-grid">
              <StatCard
                label="Bridges in scope"
                value={String(overview?.totalAssigned ?? 0)}
                sub={
                  overview && overview.inventoryTotal > 0
                    ? `${overview.unassigned.toLocaleString()} unassigned of ${overview.inventoryTotal.toLocaleString()} in inventory`
                    : undefined
                }
              />
              <StatCard
                label="Inspected"
                value={`${overview?.totalInspected ?? 0} (${overview?.pctComplete ?? 0}%)`}
                sub={`${overview?.firmCount ?? 0} firms participating`}
              />
              <StatCard label="Destroyed" value={String(overview?.byTriage['destroyed'] ?? 0)} />
              <StatCard
                label="Likely destroyed"
                value={String(overview?.byTriage['likely_destroyed'] ?? 0)}
              />
              <StatCard label="Revisit" value={String(overview?.byTriage['revisit'] ?? 0)} />
              <StatCard label="Complete" value={String(overview?.byTriage['complete'] ?? 0)} />
              <StatCard label="Open" value={String(overview?.open ?? 0)} />
              <StatCard label="Restricted" value={String(overview?.restricted ?? 0)} />
              <StatCard label="Closed" value={String(overview?.closed ?? 0)} />
            </div>

            {scopedProgress && (
              <div className="card">
                <h2 style={{ marginTop: 0 }}>
                  {scopedProgress.firm_name}{' '}
                  <button
                    type="button"
                    className="btn"
                    onClick={() => setFirmFilter('all')}
                    style={{ marginLeft: 8 }}
                  >
                    Clear firm filter
                  </button>
                </h2>
                <div className="stat-grid">
                  <StatCard label="Assigned" value={String(scopedProgress.assigned)} />
                  <StatCard
                    label="Inspected"
                    value={`${scopedProgress.inspected} (${scopedProgress.pctComplete}%)`}
                  />
                  <StatCard label="Destroyed" value={String(scopedProgress.destroyed)} />
                  <StatCard label="Revisit" value={String(scopedProgress.revisit)} />
                </div>
              </div>
            )}

            {/* Firm progress table */}
            <div className="card">
              <h2 style={{ marginTop: 0 }}>Firm progress</h2>
              {progress.length === 0 ? (
                <p className="muted">
                  No firms yet. Use the “Assign to firms” tab to create firms and
                  assign bridge groups.
                </p>
              ) : (
                <div style={{ overflowX: 'auto' }}>
                  <table className="data">
                    <thead>
                      <tr>
                        <th>Firm</th>
                        <th>Assigned</th>
                        <th>Inspected</th>
                        <th>% Complete</th>
                        <th>Destroyed</th>
                        <th>Revisit</th>
                        <th>Open / Restr. / Closed</th>
                      </tr>
                    </thead>
                    <tbody>
                      {progress.map((p) => {
                        const color = firmColorMap.get(p.firm_id) ?? '#64748b';
                        const selected = firmFilter === p.firm_id;
                        return (
                          <tr
                            key={p.firm_id}
                            onClick={() => setFirmFilter(selected ? 'all' : p.firm_id)}
                            style={{
                              cursor: 'pointer',
                              background: selected ? '#1e3a5f' : undefined,
                            }}
                            title="Click to filter to this firm"
                          >
                            <td>
                              <span
                                style={{
                                  display: 'inline-block',
                                  width: 10,
                                  height: 10,
                                  borderRadius: '50%',
                                  background: color,
                                  marginRight: 8,
                                }}
                              />
                              {p.firm_name}
                            </td>
                            <td>{p.assigned.toLocaleString()}</td>
                            <td>{p.inspected.toLocaleString()}</td>
                            <td>
                              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                <div
                                  style={{
                                    width: 90,
                                    height: 8,
                                    borderRadius: 4,
                                    background: '#334155',
                                    overflow: 'hidden',
                                  }}
                                >
                                  <div
                                    style={{
                                      width: `${p.pctComplete}%`,
                                      height: '100%',
                                      background: '#CF3910',
                                    }}
                                  />
                                </div>
                                {p.pctComplete}%
                              </div>
                            </td>
                            <td>{p.destroyed}</td>
                            <td>{p.revisit}</td>
                            <td>
                              {p.open} / {p.restricted} / {p.closed}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            {/* Bridges table with filters */}
            <div className="card">
              <h2 style={{ marginTop: 0 }}>
                Bridges{' '}
                <span className="muted" style={{ fontWeight: 400, fontSize: 13 }}>
                  {filteredRows.length.toLocaleString()} in scope
                </span>
              </h2>
              <div
                style={{
                  display: 'flex',
                  gap: 8,
                  flexWrap: 'wrap',
                  alignItems: 'flex-end',
                  marginBottom: 12,
                }}
              >
                <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <span className="muted">Firm</span>
                  <select value={firmFilter} onChange={(e) => setFirmFilter(e.target.value)}>
                    <option value="all">All firms</option>
                    {firms.map((f) => (
                      <option key={f.id} value={f.id}>
                        {f.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <span className="muted">County</span>
                  <select
                    value={countyFilter}
                    onChange={(e) => {
                      setCountyFilter(e.target.value);
                      setPage(0);
                    }}
                  >
                    <option value="">All counties</option>
                    {countyOptions.map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                </label>
                <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <span className="muted">Status</span>
                  <select
                    value={statusFilter}
                    onChange={(e) => {
                      setStatusFilter(e.target.value);
                      setPage(0);
                    }}
                  >
                    {STATUS_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              {rowsLoading ? (
                <p className="muted">Loading bridges…</p>
              ) : filteredRows.length === 0 ? (
                <p className="muted">No bridges match the current filters.</p>
              ) : (
                <>
                  <div style={{ overflowX: 'auto' }}>
                    <table className="data">
                      <thead>
                        <tr>
                          <th>Bridge</th>
                          <th>Firm</th>
                          <th>County</th>
                          <th>Inspector</th>
                          <th>Triage</th>
                          <th>Open</th>
                        </tr>
                      </thead>
                      <tbody>
                        {pageRows.map((r) => (
                          <tr key={r.asset_id}>
                            <td>
                              <code>{r.asset_id}</code>
                            </td>
                            <td>{r.firm_name}</td>
                            <td>{r.county ?? '—'}</td>
                            <td>{r.inspector ?? '—'}</td>
                            <td>
                              <span className={`pill pill-${r.triage ?? 'none'}`}>
                                {triageLabel(r.triage)}
                              </span>
                            </td>
                            <td>{openLabel(r.openStatus)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <div
                    style={{
                      display: 'flex',
                      gap: 8,
                      alignItems: 'center',
                      marginTop: 12,
                    }}
                  >
                    <button
                      type="button"
                      className="btn"
                      disabled={safePage === 0}
                      onClick={() => setPage(safePage - 1)}
                    >
                      ← Prev
                    </button>
                    <span className="muted">
                      Page {safePage + 1} of {pageCount}
                    </span>
                    <button
                      type="button"
                      className="btn"
                      disabled={safePage >= pageCount - 1}
                      onClick={() => setPage(safePage + 1)}
                    >
                      Next →
                    </button>
                  </div>
                </>
              )}
            </div>
          </main>
        </div>
      )}

      {!loading && !error && view === 'assign' && (
        <div className="dash-grid" style={{ gridTemplateColumns: '1fr' }}>
          <main className="dash-main">
            <FirmBulkAssign
              firms={firms}
              onFirmsChanged={() => void loadAll()}
              stateCode={effectiveScope}
            />
          </main>
        </div>
      )}

      {!loading && !error && view === 'map' && (
        <div className="state-map-layout">
          <main className="dash-main">
            <div className="card" style={{ padding: 8 }}>
              <div
                style={{
                  display: 'flex',
                  gap: 8,
                  alignItems: 'center',
                  padding: '4px 8px 8px',
                  flexWrap: 'wrap',
                }}
              >
                <span className="muted">Color by:</span>
                <button
                  type="button"
                  className={mapColorBy === 'firm' ? 'btn btn-primary' : 'btn'}
                  onClick={() => setMapColorBy('firm')}
                >
                  Firm
                </button>
                <button
                  type="button"
                  className={mapColorBy === 'status' ? 'btn btn-primary' : 'btn'}
                  onClick={() => setMapColorBy('status')}
                >
                  Status
                </button>
                {mapFilterIds && (
                  <span className="muted">
                    {mapFilterIds.length.toLocaleString()} bridges shown (filtered)
                  </span>
                )}
              </div>
              <div style={{ position: 'relative' }}>
                <TeamMap
                  height="62vh"
                  colorBy={mapColorBy}
                  firmColorByAsset={firmColorByAsset}
                  filterAssetIds={mapFilterIds}
                  fitRegion={mapFit}
                  onBridgeClick={handleSelectBridge}
                />
                {mapColorBy === 'firm' && (
                  <div
                    style={{
                      position: 'absolute',
                      left: 10,
                      bottom: 10,
                      background: 'rgba(15,23,42,0.92)',
                      border: '1px solid #334155',
                      borderRadius: 8,
                      padding: '8px 10px',
                      fontSize: 12,
                      maxHeight: 180,
                      overflowY: 'auto',
                    }}
                  >
                    {firms.map((f) => (
                      <div
                        key={f.id}
                        style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}
                      >
                        <span
                          style={{
                            display: 'inline-block',
                            width: 10,
                            height: 10,
                            borderRadius: '50%',
                            background: firmColorMap.get(f.id) ?? '#64748b',
                          }}
                        />
                        <span style={{ color: '#e2e8f0' }}>{f.name}</span>
                      </div>
                    ))}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span
                        style={{
                          display: 'inline-block',
                          width: 10,
                          height: 10,
                          borderRadius: '50%',
                          background: '#64748b',
                        }}
                      />
                      <span style={{ color: '#e2e8f0' }}>Unassigned</span>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </main>
          <div className="state-map-side">
            <div className="card">
              <h2 style={{ marginTop: 0 }}>Bridge detail</h2>
              {!selectedAssetId && (
                <p className="muted">Click a bridge on the map to see details.</p>
              )}
              {selectedAssetId && detailLoading && (
                <p className="muted">Loading {selectedAssetId}…</p>
              )}
              {selectedAssetId && !detailLoading && bridgeDetail && (
                <dl className="field-grid" style={{ gridTemplateColumns: '1fr' }}>
                  <div>
                    <dt>Asset ID</dt>
                    <dd>
                      <code>{bridgeDetail.asset_id}</code>
                    </dd>
                  </div>
                  <div>
                    <dt>Firm</dt>
                    <dd>{bridgeDetail.firm?.name ?? 'Unassigned'}</dd>
                  </div>
                  <div>
                    <dt>Location</dt>
                    <dd>
                      {[bridgeDetail.facility, bridgeDetail.feature]
                        .filter(Boolean)
                        .join(' over ') || '—'}
                      {bridgeDetail.county ? ` · ${bridgeDetail.county}` : ''}
                    </dd>
                  </div>
                  <div>
                    <dt>Inspector</dt>
                    <dd>{bridgeDetail.inspector ?? '—'}</dd>
                  </div>
                  <div>
                    <dt>Triage</dt>
                    <dd>
                      <span className={`pill pill-${bridgeDetail.triage ?? 'none'}`}>
                        {triageLabel(bridgeDetail.triage)}
                      </span>
                    </dd>
                  </div>
                  <div>
                    <dt>Open status</dt>
                    <dd>{openLabel(bridgeDetail.openStatus)}</dd>
                  </div>
                  <div>
                    <dt>Inspected</dt>
                    <dd>
                      {bridgeDetail.inspectedAt
                        ? new Date(bridgeDetail.inspectedAt).toLocaleString()
                        : '—'}
                      {bridgeDetail.inspectedBy ? ` by ${bridgeDetail.inspectedBy}` : ''}
                    </dd>
                  </div>
                </dl>
              )}
            </div>
            <div className="card">
              <h2 style={{ marginTop: 0 }}>Firms</h2>
              {firms.length === 0 ? (
                <p className="muted">No firms yet.</p>
              ) : (
                firms.map((f) => (
                  <button
                    key={f.id}
                    type="button"
                    className="btn"
                    onClick={() =>
                      setFirmFilter(firmFilter === f.id ? 'all' : f.id)
                    }
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      width: '100%',
                      marginBottom: 6,
                      textAlign: 'left',
                      background: firmFilter === f.id ? '#1e3a5f' : undefined,
                    }}
                  >
                    <span
                      style={{
                        display: 'inline-block',
                        width: 10,
                        height: 10,
                        borderRadius: '50%',
                        background: firmColorMap.get(f.id) ?? '#64748b',
                        flexShrink: 0,
                      }}
                    />
                    {f.name}
                  </button>
                ))
              )}
              <p className="muted" style={{ fontSize: 12, marginBottom: 0 }}>
                Click a firm to filter the map. Click again to clear.
              </p>
            </div>
          </div>
        </div>
      )}
</div>
  );
}
