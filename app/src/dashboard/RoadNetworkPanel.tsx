import { useEffect, useMemo, useState } from 'react';
import React from 'react';
import { getSupabase, isOnline, isSupabaseConfigured } from '../lib/supabase';
import type { Roadblock } from '../types';

type Filter = 'active' | 'reopened' | 'all';

type RoadblockRow = Roadblock;

interface RoadStatusRow {
  status?: string | null;
  road_name?: string | null;
}

function parseDate(v: string | null | undefined): Date | null {
  if (!v) return null;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
}

function hoursSince(d: Date): number {
  return (Date.now() - d.getTime()) / 3_600_000;
}

function isActive(row: RoadblockRow): boolean {
  const s = (row.status ?? '').toLowerCase();
  return s !== 'reopened' && !row.reopened_at;
}

function isReopened(row: RoadblockRow): boolean {
  const s = (row.status ?? '').toLowerCase();
  return s === 'reopened' || !!row.reopened_at;
}

function closureLabel(t: string | null | undefined): string {
  if (!t) return 'Closure';
  const map: Record<string, string> = {
    flood: 'Flooded road',
    landslide: 'Landslide',
    debris: 'Debris',
    washout: 'Washout',
    structure: 'Structural',
    other: 'Other',
  };
  const k = t.toLowerCase();
  return map[k] ?? t;
}

export default function RoadNetworkPanel(): React.JSX.Element {
  const [rows, setRows] = useState<RoadblockRow[]>([]);
  const [pinsCount, setPinsCount] = useState<number>(0);
  const [filter, setFilter] = useState<Filter>('active');
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load(): Promise<void> {
      setLoading(true);
      setError(null);
      if (!isSupabaseConfigured || !isOnline()) {
        setError('Offline or backend not configured. Showing cached data when available.');
        setLoading(false);
        return;
      }
      const sb = getSupabase();
      if (!sb) {
        setError('Supabase client unavailable.');
        setLoading(false);
        return;
      }
      try {
        const rb = await sb
          .from('emg_roadblocks')
          .select('*')
          .order('reported_at', { ascending: false })
          .limit(500);
        if (rb.error) throw rb.error;

        const rs = await sb.from('emg_road_statuses').select('status, road_name');
        if (rs.error && rs.error.code !== 'PGRST116') {
          // tolerate missing table
        }
        const statuses = (rs.data ?? []) as RoadStatusRow[];
        const pinTotal = statuses.length;

        if (!cancelled) {
          setRows((rb.data ?? []) as RoadblockRow[]);
          setPinsCount(pinTotal);
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  const staleThresholdHours = 12;

  const filtered = useMemo(() => {
    return rows.filter((r) => {
      if (filter === 'active') return isActive(r);
      if (filter === 'reopened') return isReopened(r);
      return true;
    });
  }, [rows, filter]);

  const summary = useMemo(() => {
    let active = 0;
    let reopened = 0;
    let stale = 0;
    for (const r of rows) {
      const a = isActive(r);
      const rp = isReopened(r);
      if (a) {
        active += 1;
        const d = parseDate(r.reported_at);
        if (d && hoursSince(d) > staleThresholdHours) stale += 1;
      }
      if (rp) reopened += 1;
    }
    return { active, reopened, stale };
  }, [rows]);

  const toggle = (id: string): void =>
    setExpanded((prev) => ({ ...prev, [id]: !prev[id] }));

  return (
    <div className="card">
      <h2 style={{ marginTop: 0 }}>Road network — what can we drive right now</h2>
      <p className="muted">
        {summary.active} active closures · {summary.reopened} reopened · {summary.stale} stale
        {pinsCount > 0 ? ` · ${pinsCount} status pins` : ''}
      </p>

      <div className="filters" role="tablist" aria-label="Closure filter">
        {(['active', 'reopened', 'all'] as Filter[]).map((f) => (
          <button
            key={f}
            type="button"
            role="tab"
            aria-selected={filter === f}
            className="btn"
            style={{ fontWeight: filter === f ? 700 : 400 }}
            onClick={() => setFilter(f)}
          >
            {f === 'active' ? 'Active only' : f === 'reopened' ? 'Reopened only' : 'All'}
          </button>
        ))}
      </div>

      {loading && <p className="muted">Loading roadblocks…</p>}
      {error && <div className="err-box">{error}</div>}
      {!loading && filtered.length === 0 && <p className="muted">No roadblocks match this filter.</p>}

      <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
        {filtered.map((r) => {
          const id = String((r as { id?: string | number }).id ?? `${r.road_name}-${r.reported_at}`);
          const active = isActive(r);
          const reopened = isReopened(r);
          const reportedDate = parseDate(r.reported_at);
          const stale = active && reportedDate && hoursSince(reportedDate) > staleThresholdHours;
          const isOpen = !!expanded[id];
          const closedLine =
            reopened && r.reopened_at
              ? `Closed ${parseDate(r.reported_at)?.toLocaleString() ?? r.reported_at} by ${
                  r.reporter ?? 'unknown'
                } → Reopened ${parseDate(r.reopened_at)?.toLocaleString() ?? r.reopened_at} by ${
                  r.reopened_by ?? 'unknown'
                }`
              : `Closed ${reportedDate?.toLocaleString() ?? r.reported_at} by ${r.reporter ?? 'unknown'}`;

          return (
            <li key={id} className="feed-item">
              <div
                style={{ display: 'flex', gap: 8, alignItems: 'center', cursor: 'pointer' }}
                onClick={() => toggle(id)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') toggle(id);
                }}
              >
                <strong style={{ flex: '1 1 auto' }}>{r.road_name ?? 'Unnamed road'}</strong>
                <span className="muted">{closureLabel(r.closure_type)}</span>
                {reopened ? (
                  <span className="pill" style={{ background: '#1f8f3d', color: '#fff' }}>
                    REOPENED
                  </span>
                ) : (
                  <span className="pill" style={{ background: '#c62828', color: '#fff' }}>
                    CLOSED
                  </span>
                )}
                {stale && (
                  <span className="pill" style={{ background: '#f2b300', color: '#111' }} title="Older than 12h">
                    verify
                  </span>
                )}
              </div>
              <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>
                {r.reporter ?? 'unknown'} · {reportedDate?.toLocaleString() ?? r.reported_at}
              </div>
              {isOpen && (
                <div style={{ marginTop: 6, paddingTop: 6, borderTop: '1px solid #eee' }}>
                  <div className="muted">{closedLine}</div>
                  {r.notes && (
                    <div style={{ marginTop: 4 }}>
                      <span className="muted">Notes: </span>
                      {r.notes}
                    </div>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
