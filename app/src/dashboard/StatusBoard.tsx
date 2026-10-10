import { useEffect, useMemo, useState } from 'react';
import { getSupabase, isOnline, isSupabaseConfigured } from '../lib/supabase';
import { idbGetAll } from '../lib/idb';
import type { Bridge, InspectionDraft } from '../types';

interface StatusBoardProps {
  onSelectBridge: (assetId: string) => void;
}

type DisplayStatus =
  | 'not_started'
  | 'open'
  | 'restricted_lanes'
  | 'reduced_load'
  | 'closed'
  | 'destroyed'
  | 'likely_destroyed'
  | 'revisit'
  | 'ground_followup';

interface InspectionRow {
  asset_id: string;
  triage_list: string | null;
  inspector_name: string | null;
  inspection_datetime: string | null;
  remain_open: string | null;
  safe_load: string | null;
}

interface LatestRow extends InspectionRow {}

const STATUS_ORDER: DisplayStatus[] = [
  'closed',
  'destroyed',
  'likely_destroyed',
  'ground_followup',
  'revisit',
  'reduced_load',
  'restricted_lanes',
  'open',
  'not_started',
];

const STATUS_LABEL: Record<DisplayStatus, string> = {
  not_started: 'Not Started',
  open: 'Open',
  restricted_lanes: 'Restricted Lanes',
  reduced_load: 'Reduced Load',
  closed: 'Closed',
  destroyed: 'Destroyed',
  likely_destroyed: 'Likely Destroyed',
  revisit: 'Revisit',
  ground_followup: 'Ground Follow-up',
};

function classify(row: InspectionRow): DisplayStatus {
  const triage = (row.triage_list ?? '').toLowerCase().trim();
  if (triage === 'destroyed') return 'destroyed';
  if (triage === 'likely_destroyed' || triage === 'likely destroyed') return 'likely_destroyed';
  if (triage === 'revisit') return 'revisit';
  if (triage === 'ground_followup' || triage === 'ground followup') return 'ground_followup';
  if (triage === 'complete') {
    const remain = (row.remain_open ?? '').toLowerCase().trim();
    const load = (row.safe_load ?? '').toLowerCase().trim();
    if (remain === 'no') return 'closed';
    if (remain === 'restricted_lanes' || remain === 'restricted lanes') return 'restricted_lanes';
    if (load === 'reduced_load' || load === 'reduced load') return 'reduced_load';
    return 'open';
  }
  // Any other triage value → treat as pending classification
  return 'not_started';
}

function hoursSince(iso: string | null): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return (Date.now() - t) / 3_600_000;
}

export default function StatusBoard({ onSelectBridge }: StatusBoardProps) {
  const [bridges, setBridges] = useState<Bridge[]>([]);
  const [latestByAsset, setLatestByAsset] = useState<Map<string, LatestRow>>(new Map());
  const [loading, setLoading] = useState(true);

  const [districtFilter, setDistrictFilter] = useState<string>('all');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [inspectorFilter, setInspectorFilter] = useState<string>('');
  const [timeWindow, setTimeWindow] = useState<string>('all');

  const [sortKey, setSortKey] = useState<'asset_id' | 'updated'>('asset_id');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      try {
        // Load bridges from cache
        let cachedBridges: Bridge[] = [];
        try {
          cachedBridges = await idbGetAll<Bridge>('bridges');
        } catch {
          cachedBridges = [];
        }
        if (!cancelled) setBridges(cachedBridges);

        // Load inspections
        let rows: InspectionRow[] = [];
        if (isOnline() && isSupabaseConfigured()) {
          const sb = getSupabase()!;
          const { data, error } = await sb
            .from('emg_inspections')
            .select(
              'asset_id,triage_list,inspector_name,inspection_datetime,remain_open,safe_load'
            )
            .order('inspection_datetime', { ascending: false })
            .limit(10000);
          if (error) throw error;
          rows = (data as InspectionRow[]) ?? [];
        } else {
          try {
            const cached = await idbGetAll<InspectionDraft>('emg_inspections');
            rows = cached.map((c) => ({
              asset_id: c.asset_id,
              triage_list: (c as unknown as { triage_list?: string | null }).triage_list ?? null,
              inspector_name:
                (c as unknown as { inspector_name?: string | null }).inspector_name ?? null,
              inspection_datetime:
                (c as unknown as { inspection_datetime?: string | null }).inspection_datetime ??
                null,
              remain_open:
                (c as unknown as { remain_open?: string | null }).remain_open ?? null,
              safe_load: (c as unknown as { safe_load?: string | null }).safe_load ?? null,
            }));
            rows.sort((a, b) => {
              const da = a.inspection_datetime ?? '';
              const db = b.inspection_datetime ?? '';
              return db.localeCompare(da);
            });
          } catch {
            rows = [];
          }
        }

        const map = new Map<string, LatestRow>();
        for (const row of rows) {
          if (!row.asset_id) continue;
          if (!map.has(row.asset_id)) map.set(row.asset_id, row);
        }
        if (!cancelled) setLatestByAsset(map);
      } catch {
        if (!cancelled) setLatestByAsset(new Map());
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  const enriched = useMemo(() => {
    return bridges.map((b) => {
      const latest = latestByAsset.get(b.asset_id) ?? null;
      const status: DisplayStatus = latest ? classify(latest) : 'not_started';
      return { bridge: b, latest, status };
    });
  }, [bridges, latestByAsset]);

  const statusCounts = useMemo(() => {
    const counts: Record<DisplayStatus, number> = {
      not_started: 0,
      open: 0,
      restricted_lanes: 0,
      reduced_load: 0,
      closed: 0,
      destroyed: 0,
      likely_destroyed: 0,
      revisit: 0,
      ground_followup: 0,
    };
    for (const e of enriched) counts[e.status] += 1;
    return counts;
  }, [enriched]);

  const filtered = useMemo(() => {
    const now = Date.now();
    const inspectorNeedle = inspectorFilter.trim().toLowerCase();

    const result = enriched.filter((e) => {
      const b = e.bridge;

      if (districtFilter !== 'all') {
        if (String(b.district ?? '') !== districtFilter) return false;
      }
      if (statusFilter !== 'all') {
        if (e.status !== statusFilter) return false;
      }
      if (inspectorNeedle) {
        const name = (e.latest?.inspector_name ?? '').toLowerCase();
        if (!name.includes(inspectorNeedle)) return false;
      }
      if (timeWindow !== 'all') {
        const hrs = e.latest ? hoursSince(e.latest.inspection_datetime) : null;
        if (hrs === null) return false;
        if (timeWindow === '6h' && hrs > 6) return false;
        if (timeWindow === '24h' && hrs > 24) return false;
        if (timeWindow === '7d' && hrs > 24 * 7) return false;
      }
      return true;
    });

    result.sort((a, b) => {
      let cmp = 0;
      if (sortKey === 'asset_id') {
        cmp = String(a.bridge.asset_id).localeCompare(String(b.bridge.asset_id));
      } else {
        const ta = a.latest?.inspection_datetime
          ? Date.parse(a.latest.inspection_datetime)
          : 0;
        const tb = b.latest?.inspection_datetime
          ? Date.parse(b.latest.inspection_datetime)
          : 0;
        cmp = (ta || 0) - (tb || 0);
      }
      return sortDir === 'asc' ? cmp : -cmp;
    });

    return result;
  }, [enriched, districtFilter, statusFilter, inspectorFilter, timeWindow, sortKey, sortDir]);

  function toggleSort(key: 'asset_id' | 'updated') {
    if (sortKey === key) {
      setSortDir(sortDir === 'asc' ? 'desc' : 'asc');
    } else {
      setSortKey(key);
      setSortDir('asc');
    }
  }

  const districts = ['1', '2', '3', '4', '5', '6', '7'];

  return (
    <div className="status-board">
      <h2>Status Board</h2>

      {!loading && bridges.length === 0 && (
        <p className="muted">Sync bridge inventory from the field app first.</p>
      )}

      {bridges.length > 0 && (
        <>
          <div className="stat-row">
            {STATUS_ORDER.map((s) => (
              <div key={s} className={`stat stat-${s}`}>
                <span className="stat-count">{statusCounts[s]}</span>
                <span className="stat-label">{STATUS_LABEL[s]}</span>
              </div>
            ))}
          </div>

          <div className="filters">
            <label>
              District
              <select value={districtFilter} onChange={(e) => setDistrictFilter(e.target.value)}>
                <option value="all">All</option>
                {districts.map((d) => (
                  <option key={d} value={d}>
                    {d}
                  </option>
                ))}
              </select>
            </label>

            <label>
              Status
              <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
                <option value="all">All</option>
                {STATUS_ORDER.map((s) => (
                  <option key={s} value={s}>
                    {STATUS_LABEL[s]}
                  </option>
                ))}
              </select>
            </label>

            <label>
              Inspector
              <input
                type="text"
                value={inspectorFilter}
                onChange={(e) => setInspectorFilter(e.target.value)}
                placeholder="Search inspector"
              />
            </label>

            <label>
              Window
              <select value={timeWindow} onChange={(e) => setTimeWindow(e.target.value)}>
                <option value="all">All</option>
                <option value="6h">Last 6h</option>
                <option value="24h">Last 24h</option>
                <option value="7d">Last 7d</option>
              </select>
            </label>
          </div>

          <table className="data">
            <thead>
              <tr>
                <th
                  className="sortable"
                  onClick={() => toggleSort('asset_id')}
                  aria-sort={sortKey === 'asset_id' ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'}
                >
                  Asset ID
                  {sortKey === 'asset_id' ? (sortDir === 'asc' ? ' ▲' : ' ▼') : ''}
                </th>
                <th>County</th>
                <th>District</th>
                <th>Status</th>
                <th>Inspector</th>
                <th
                  className="sortable"
                  onClick={() => toggleSort('updated')}
                  aria-sort={sortKey === 'updated' ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'}
                >
                  Updated
                  {sortKey === 'updated' ? (sortDir === 'asc' ? ' ▲' : ' ▼') : ''}
                </th>
                <th>Open</th>
                <th>Load</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(({ bridge, latest, status }) => {
                const hrs = latest ? hoursSince(latest.inspection_datetime) : null;
                const stale = latest !== null && hrs !== null && hrs > 12;
                const label = latest ? latest.inspection_datetime : null;
                return (
                  <tr
                    key={bridge.asset_id}
                    onClick={() => onSelectBridge(bridge.asset_id)}
                    className="row-clickable"
                  >
                    <td>{bridge.asset_id}</td>
                    <td>{bridge.county_name ?? '—'}</td>
                    <td>{bridge.district ?? '—'}</td>
                    <td>
                      <span className={`pill pill-${status}`}>{STATUS_LABEL[status]}</span>
                      {stale && <span className="pill stale">stale</span>}
                    </td>
                    <td>{latest?.inspector_name ?? '—'}</td>
                    <td>{label ? new Date(label).toLocaleString() : '—'}</td>
                    <td>{latest?.remain_open ?? '—'}</td>
                    <td>{latest?.safe_load ?? '—'}</td>
                  </tr>
                );
              })}
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={8} className="muted">
                    No bridges match the current filters.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </>
      )}

      <style>{`
        .status-board {
          color: #e2e8f0;
          font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
        }
        .status-board h2 {
          margin: 0 0 10px;
          font-size: 15px;
          font-weight: 600;
        }
        .stat-row {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(96px, 1fr));
          gap: 8px;
          margin-bottom: 12px;
        }
        .stat {
          background: #0f172a;
          border: 1px solid #334155;
          border-radius: 8px;
          padding: 8px 10px;
          display: flex;
          flex-direction: column;
          gap: 2px;
        }
        .stat-count {
          font-size: 18px;
          font-weight: 700;
          line-height: 1;
        }
        .stat-label {
          font-size: 10px;
          text-transform: uppercase;
          letter-spacing: 0.05em;
          color: #94a3b8;
        }
        .stat-closed .stat-count { color: #ef4444; }
        .stat-destroyed .stat-count,
        .stat-likely_destroyed .stat-count { color: #dc2626; }
        .stat-ground_followup .stat-count { color: #f59e0b; }
        .stat-revisit .stat-count { color: #eab308; }
        .stat-reduced_load .stat-count { color: #f97316; }
        .stat-restricted_lanes .stat-count { color: #fb923c; }
        .stat-open .stat-count { color: #22c55e; }
        .stat-not_started .stat-count { color: #94a3b8; }

        .filters {
          display: flex;
          flex-wrap: wrap;
          gap: 10px;
          margin-bottom: 12px;
        }
        .filters label {
          display: flex;
          flex-direction: column;
          font-size: 11px;
          text-transform: uppercase;
          letter-spacing: 0.04em;
          color: #94a3b8;
          gap: 4px;
        }
        .filters select,
        .filters input {
          background: #0f172a;
          color: #e2e8f0;
          border: 1px solid #334155;
          border-radius: 6px;
          padding: 5px 8px;
          font-size: 13px;
          min-width: 110px;
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
          white-space: nowrap;
        }
        table.data th {
          color: #94a3b8;
          font-weight: 600;
          font-size: 11px;
          text-transform: uppercase;
          letter-spacing: 0.04em;
          background: #0f172a;
        }
        table.data th.sortable {
          cursor: pointer;
          user-select: none;
        }
        table.data th.sortable:hover {
          color: #e2e8f0;
        }
        table.data tbody tr.row-clickable {
          cursor: pointer;
        }
        table.data tbody tr.row-clickable:hover {
          background: #273449;
        }

        .pill {
          display: inline-block;
          padding: 2px 8px;
          border-radius: 999px;
          font-size: 11px;
          font-weight: 600;
          background: #334155;
          color: #e2e8f0;
          margin-right: 4px;
        }
        .pill-open { background: #14532d; color: #bbf7d0; }
        .pill-restricted_lanes { background: #7c2d12; color: #fed7aa; }
        .pill-reduced_load { background: #7c2d12; color: #fed7aa; }
        .pill-closed { background: #7f1d1d; color: #fecaca; }
        .pill-destroyed { background: #450a0a; color: #fecaca; }
        .pill-likely_destroyed { background: #450a0a; color: #fecaca; }
        .pill-revisit { background: #713f12; color: #fde68a; }
        .pill-ground_followup { background: #713f12; color: #fde68a; }
        .pill-not_started { background: #334155; color: #cbd5e1; }
        .pill.stale {
          background: #78350f;
          color: #fde68a;
          margin-left: 4px;
          font-size: 10px;
        }

        .muted {
          color: #94a3b8;
          font-size: 13px;
        }
      `}</style>
    </div>
  );
}
