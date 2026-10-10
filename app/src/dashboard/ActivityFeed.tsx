import { useEffect, useMemo, useState } from 'react';
import React from 'react';
import { getSupabase, isOnline, isSupabaseConfigured } from '../lib/supabase';

type Kind = 'inspection' | 'roadblock_report' | 'roadblock_reopen' | 'path';

interface FeedEvent {
  id: string;
  kind: Kind;
  time: string;
  inspector: string;
  sentence: string;
}

interface InspectionRow {
  id?: string | number;
  inspector_name?: string | null;
  asset_id?: string | null;
  triage_list?: string | null;
  inspection_datetime?: string | null;
}

interface RoadblockRow {
  id?: string | number;
  road_name?: string | null;
  status?: string | null;
  reporter?: string | null;
  reported_at?: string | null;
  reopened_by?: string | null;
  reopened_at?: string | null;
}

interface PathRow {
  id?: string | number;
  inspector?: string | null;
  started_at?: string | null;
}

function safeDate(v: string | null | undefined): number {
  if (!v) return 0;
  const t = new Date(v).getTime();
  return isNaN(t) ? 0 : t;
}

function fmtTime(v: string | null | undefined): string {
  if (!v) return '';
  const d = new Date(v);
  return isNaN(d.getTime()) ? String(v) : d.toLocaleString();
}

function shortName(n: string | null | undefined): string {
  if (!n) return 'Unknown';
  const parts = n.trim().split(/\s+/);
  if (parts.length === 1) return parts[0];
  return `${parts[0][0]}. ${parts[parts.length - 1]}`;
}

export default function ActivityFeed(): React.JSX.Element {
  const [events, setEvents] = useState<FeedEvent[]>([]);
  const [inspectorFilter, setInspectorFilter] = useState<string>('all');
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load(): Promise<void> {
      setLoading(true);
      setError(null);
      if (!isSupabaseConfigured || !isOnline()) {
        setError('Offline or backend not configured.');
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
        const [insp, rb, path] = await Promise.all([
          sb
            .from('emg_inspections')
            .select('id, inspector_name, asset_id, triage_list, inspection_datetime')
            .order('inspection_datetime', { ascending: false })
            .limit(100),
          sb
            .from('emg_roadblocks')
            .select('id, road_name, status, reporter, reported_at, reopened_by, reopened_at')
            .order('reported_at', { ascending: false })
            .limit(100),
          sb
            .from('emg_path_tracks')
            .select('id, inspector, started_at')
            .order('started_at', { ascending: false })
            .limit(100),
        ]);

        const merged: FeedEvent[] = [];
        for (const r of (insp.data ?? []) as InspectionRow[]) {
          const t = r.inspection_datetime ?? null;
          const who = shortName(r.inspector_name);
          const triage = r.triage_list ? ` — ${r.triage_list}` : '';
          merged.push({
            id: `insp-${r.id ?? `${r.asset_id}-${t}`}`,
            kind: 'inspection',
            time: t ?? '',
            inspector: who,
            sentence: `${who} completed triage on bridge ${r.asset_id ?? '?'}${triage}`,
          });
        }
        for (const r of (rb.data ?? []) as RoadblockRow[]) {
          const who = shortName(r.reporter);
          const reopened = (r.status ?? '').toLowerCase() === 'reopened' || !!r.reopened_at;
          if (reopened && r.reopened_at) {
            const who2 = shortName(r.reopened_by ?? r.reporter);
            merged.push({
              id: `rb-reopen-${r.id ?? `${r.road_name}-${r.reopened_at}`}`,
              kind: 'roadblock_reopen',
              time: r.reopened_at,
              inspector: who2,
              sentence: `${who2} reopened ${r.road_name ?? 'a road'}`,
            });
          }
          merged.push({
            id: `rb-${r.id ?? `${r.road_name}-${r.reported_at}`}`,
            kind: 'roadblock_report',
            time: r.reported_at ?? '',
            inspector: who,
            sentence: `${who} reported closure on ${r.road_name ?? 'a road'}`,
          });
        }
        for (const r of (path.data ?? []) as PathRow[]) {
          const who = shortName(r.inspector);
          merged.push({
            id: `path-${r.id ?? `${r.inspector}-${r.started_at}`}`,
            kind: 'path',
            time: r.started_at ?? '',
            inspector: who,
            sentence: `${who} traveled a path`,
          });
        }

        merged.sort((a, b) => safeDate(b.time) - safeDate(a.time));
        if (!cancelled) setEvents(merged.slice(0, 300));
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

  const inspectors = useMemo(() => {
    const set = new Set<string>();
    for (const e of events) if (e.inspector && e.inspector !== 'Unknown') set.add(e.inspector);
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [events]);

  const bridgesCompleted = useMemo(
    () => events.filter((e) => e.kind === 'inspection').length,
    [events],
  );

  const visible = useMemo(() => {
    if (inspectorFilter === 'all') return events;
    return events.filter((e) => e.inspector === inspectorFilter);
  }, [events, inspectorFilter]);

  return (
    <div className="card">
      <h2 style={{ marginTop: 0 }}>Activity feed</h2>
      <p className="muted">
        {inspectors.length} inspector{inspectors.length === 1 ? '' : 's'} active · {bridgesCompleted}{' '}
        bridge triage{bridgesCompleted === 1 ? '' : 's'} completed
      </p>

      <div className="filters">
        <label className="muted" htmlFor="inspector-filter" style={{ marginRight: 6 }}>
          Inspector
        </label>
        <select
          id="inspector-filter"
          className="field"
          value={inspectorFilter}
          onChange={(e) => setInspectorFilter(e.target.value)}
        >
          <option value="all">All</option>
          {inspectors.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
      </div>

      {loading && <p className="muted">Loading feed…</p>}
      {error && <div className="err-box">{error}</div>}
      {!loading && visible.length === 0 && <p className="muted">No activity yet.</p>}

      <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
        {visible.map((e) => (
          <li key={e.id} className="feed-item">
            <span className="muted" style={{ fontSize: 12, marginRight: 8 }}>
              {fmtTime(e.time)}
            </span>
            {e.sentence}
          </li>
        ))}
      </ul>
    </div>
  );
}
