import { useCallback, useEffect, useMemo, useState } from 'react';
import { getSupabase, isOnline, isSupabaseConfigured } from '../lib/supabase';
import { haversineMeters } from '../lib/geo';
import {
  firmServesState,
  getCachedFirms,
  getFirmBridges,
  getFirmInspectors,
  syncFirms,
  syncInspectors,
} from '../lib/firm';
import {
  parseIdList,
  resolveBridgeIds,
  type BridgeState,
} from '../lib/bridgeLookup';
import type { AdminProfile, Assignment, Firm } from '../types';
import BulkBridgeInput from './BulkBridgeInput';
import InspectorSelect from './InspectorSelect';

interface DistrictRow {
  id: string;
  dist_label: string;
}

/** One district dropdown entry: `value` is the value stored in
 *  emg_bridges.district; `label` is what the user sees. */
interface DistrictOption {
  value: string;
  label: string;
}

interface BridgeRow {
  asset_id: string;
  district: string | null;
  county: string | null;
  county_name: string | null;
  facility: string | null;
  lat: number | null;
  lon: number | null;
}

const ASSIGNMENT_SELECT =
  'id,asset_id,assigned_to,assigned_by,assigned_at,status,' +
  'completed_by,completed_at,notes,created_at,firm_id';

const PREVIEW_LIMIT = 500;

function statusPill(status: Assignment['status']): string {
  if (status === 'complete') return '#1b5e20';
  if (status === 'in_progress') return '#a66a00';
  return '#0b57d0';
}

/**
 * Nearest-neighbor chain ordering: start at the northernmost bridge
 * (or at `seedId` when given — e.g. the first checked bridge), then
 * repeatedly jump to the closest unvisited bridge. Bridges without
 * coordinates keep their relative order at the end.
 */
export function sortByProximity(
  bridges: BridgeRow[],
  seedId?: string | null,
): BridgeRow[] {
  const withCoords = bridges.filter(
    (b) => typeof b.lat === 'number' && typeof b.lon === 'number',
  );
  const withoutCoords = bridges.filter(
    (b) => typeof b.lat !== 'number' || typeof b.lon !== 'number',
  );
  if (withCoords.length === 0) return [...bridges];
  let startIdx = 0;
  if (seedId) {
    const i = withCoords.findIndex((b) => b.asset_id === seedId);
    if (i >= 0) startIdx = i;
  }
  if (!seedId) {
    // Northernmost = greatest latitude.
    let best = -Infinity;
    withCoords.forEach((b, i) => {
      if ((b.lat as number) > best) {
        best = b.lat as number;
        startIdx = i;
      }
    });
  }
  const remaining = [...withCoords];
  const [first] = remaining.splice(startIdx, 1);
  const ordered: BridgeRow[] = [first];
  while (remaining.length > 0) {
    const last = ordered[ordered.length - 1];
    let bestIdx = 0;
    let bestDist = Infinity;
    remaining.forEach((b, i) => {
      const d = haversineMeters(
        last.lat as number,
        last.lon as number,
        b.lat as number,
        b.lon as number,
      );
      if (d < bestDist) {
        bestDist = d;
        bestIdx = i;
      }
    });
    ordered.push(remaining.splice(bestIdx, 1)[0]);
  }
  return [...ordered, ...withoutCoords];
}

interface AssignmentsPanelProps {
  /** Firm from the admin session (bound firm_admin). */
  firmId?: string;
  /** True when the session is a firm_admin bound to `firmId`: the firm
   *  picker is hidden and every query is scoped to that firm. */
  firmLocked?: boolean;
  /** Signed-in admin profile — drives firm/state scoping of pickers. */
  adminProfile?: AdminProfile | null;
}

export default function AssignmentsPanel({
  firmId,
  firmLocked = false,
  adminProfile,
}: AssignmentsPanelProps) {
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [districtOptions, setDistrictOptions] = useState<DistrictOption[]>([]);
  const [counties, setCounties] = useState<string[]>([]);
  const [bridgeState, setBridgeState] = useState<BridgeState>(
    adminProfile?.role === 'state_admin' && adminProfile.stateCode === 'NC'
      ? 'NC'
      : 'SC',
  );
  const stateLocked =
    adminProfile?.role === 'state_admin' &&
    (adminProfile.stateCode === 'SC' || adminProfile.stateCode === 'NC');
  const [district, setDistrict] = useState('');
  const [county, setCounty] = useState('');

  // Firm scoping (task: firm ops are firm-specific).
  const [firms, setFirms] = useState<Firm[]>([]);
  const [selectedFirmId, setSelectedFirmId] = useState<string>(firmId ?? '');
  const [firmAssets, setFirmAssets] = useState<Set<string> | null>(null);

  // Bridge results list (district/county preview) with multi-select.
  const [preview, setPreview] = useState<BridgeRow[] | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [locationSort, setLocationSort] = useState(false);

  // ONE inspector for every assign action in the merged card.
  const [inspector, setInspector] = useState('');
  const [pasteIds, setPasteIds] = useState('');
  // Assignment-status filters: dropdowns, not free text.
  const [filterInspector, setFilterInspector] = useState('');
  const [filterBridge, setFilterBridge] = useState('');
  const [rosterNames, setRosterNames] = useState<string[]>([]);
  const [tab, setTab] = useState<'assign' | 'bulk'>('assign');
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const configured = isOnline() && isSupabaseConfigured();

  // A bound firm_admin is pinned to their firm — no picker, ever.
  useEffect(() => {
    if (firmLocked && firmId) setSelectedFirmId(firmId);
  }, [firmLocked, firmId]);

  // Firm list for the picker (super_admin: all; state_admin: only firms
  // serving their state; bound firm_admin: just their firm).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (configured) {
        try {
          await syncFirms();
        } catch {
          // use the cache
        }
      }
      const all = await getCachedFirms().catch(() => [] as Firm[]);
      if (cancelled) return;
      let list = all;
      if (firmLocked && firmId) {
        list = all.filter((f) => f.id === firmId);
      } else if (adminProfile?.role === 'state_admin' && adminProfile.stateCode) {
        list = all.filter((f) => firmServesState(f, adminProfile.stateCode!));
      }
      setFirms(list);
      if (!firmLocked && !selectedFirmId && list.length === 1) {
        setSelectedFirmId(list[0].id);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [configured, firmLocked, firmId, adminProfile?.role, adminProfile?.stateCode]);

  // The selected firm's bridge group (scopes previews + assignment list).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!selectedFirmId) {
        if (!cancelled) setFirmAssets(null);
        return;
      }
      try {
        const ids = await getFirmBridges(selectedFirmId);
        if (!cancelled) setFirmAssets(new Set(ids));
      } catch {
        if (!cancelled) setFirmAssets(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedFirmId]);

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
      let rows = (asgData ?? []) as unknown as Assignment[];
      if (selectedFirmId) {
        // Firm scope: this firm's rows, plus legacy firm_id-NULL rows
        // for bridges in this firm's group (NULL rows are never dropped
        // silently — but another firm's rows are never shown).
        rows = rows.filter(
          (a) =>
            a.firm_id === selectedFirmId ||
            (a.firm_id == null &&
              firmAssets != null &&
              firmAssets.has(a.asset_id)),
        );
      }
      setAssignments(rows);
    } catch (err) {
      setMessage(
        `Load failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setLoading(false);
    }
  }, [configured, selectedFirmId, firmAssets]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // District options for the selected state = emg_districts rows for
  // that state UNION the distinct district values actually present on
  // that state's bridges. emg_districts only has SC rows ('1'..'7') and
  // its id is a PK shared across states, so NC's 14 NCDOT divisions can
  // only come from bridge data. Labels: the emg_districts label when one
  // exists, else "Division N" (NC) / "District N" (SC).
  useEffect(() => {
    if (!configured) {
      setDistrictOptions([]);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const sb = getSupabase()!;
        const labels = new Map<string, string>();
        const { data: distData, error: distError } = await sb
          .from('emg_districts')
          .select('id,dist_label')
          .eq('state', bridgeState)
          .order('id');
        if (!distError) {
          for (const d of (distData ?? []) as unknown as DistrictRow[]) {
            labels.set(String(d.id), d.dist_label);
          }
        }
        const values = new Set<string>(labels.keys());
        const PAGE = 1000;
        for (let from = 0; from < 30000; from += PAGE) {
          const { data, error } = await sb
            .from('emg_bridges')
            .select('district')
            .like('asset_id', `${bridgeState}-%`)
            .range(from, from + PAGE - 1);
          if (error) throw error;
          const rows = (data ?? []) as { district: string | null }[];
          for (const r of rows) {
            if (r.district) values.add(String(r.district));
          }
          if (rows.length < PAGE) break;
        }
        if (!cancelled) {
          const opts: DistrictOption[] = [...values]
            .sort(
              (a, b) =>
                (parseInt(a, 10) || 0) - (parseInt(b, 10) || 0) ||
                a.localeCompare(b),
            )
            .map((v) => ({
              value: v,
              label:
                labels.get(v) ??
                (bridgeState === 'NC' ? `Division ${v}` : `District ${v}`),
            }));
          setDistrictOptions(opts);
          setDistrict((prev) =>
            opts.some((o) => o.value === prev) ? prev : '',
          );
        }
      } catch {
        if (!cancelled) setDistrictOptions([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [bridgeState, configured]);

  // Counties derive ONLY from bridges in the selected state (and the
  // selected district, when one is picked).
  useEffect(() => {
    if (!configured) {
      setCounties([]);
      setCounty('');
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const sb = getSupabase()!;
        const names = new Set<string>();
        const PAGE = 1000;
        for (let from = 0; from < 30000; from += PAGE) {
          let q = sb
            .from('emg_bridges')
            .select('county_name')
            .like('asset_id', `${bridgeState}-%`);
          if (district) q = q.eq('district', district);
          const { data, error } = await q.range(from, from + PAGE - 1);
          if (error) throw error;
          const rows = (data ?? []) as { county_name: string | null }[];
          for (const r of rows) {
            if (r.county_name) names.add(r.county_name);
          }
          if (rows.length < PAGE) break;
        }
        if (!cancelled) {
          setCounties([...names].sort());
          setCounty((prev) => (names.has(prev) ? prev : ''));
        }
      } catch {
        if (!cancelled) setCounties([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [bridgeState, district, configured]);

  // Roster names for the selected firm — fills the assignment-status
  // Inspector filter dropdown (same source as InspectorSelect/TeamRoster).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!selectedFirmId) {
        if (!cancelled) setRosterNames([]);
        return;
      }
      if (configured) {
        try {
          await syncInspectors(selectedFirmId);
        } catch {
          // fall through to the local cache
        }
      }
      try {
        const list = await getFirmInspectors(selectedFirmId);
        if (!cancelled) setRosterNames(list.map((i) => i.name));
      } catch {
        if (!cancelled) setRosterNames([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedFirmId, configured]);

  /** Bridges matching state/district/county with no active assignment. */
  const fetchUnassigned = useCallback(async (): Promise<BridgeRow[]> => {
    const sb = getSupabase()!;
    let q = sb
      .from('emg_bridges')
      .select('asset_id,district,county,county_name,facility,lat,lon')
      .like('asset_id', `${bridgeState}-%`);
    if (district) q = q.eq('district', district);
    if (county) q = q.eq('county_name', county);
    const { data, error } = await q.limit(5000);
    if (error) throw error;
    let bridges = (data ?? []) as unknown as BridgeRow[];
    if (selectedFirmId && firmAssets) {
      bridges = bridges.filter((b) => firmAssets.has(b.asset_id));
    }
    const active = new Set(
      assignments
        .filter((a) => a.status === 'assigned' || a.status === 'in_progress')
        .map((a) => a.asset_id),
    );
    return bridges.filter((b) => !active.has(b.asset_id));
  }, [bridgeState, district, county, assignments, selectedFirmId, firmAssets]);

  const handlePreview = async () => {
    setLoading(true);
    setMessage(null);
    try {
      const targets = await fetchUnassigned();
      setPreview(targets);
      setSelectedIds(new Set());
      if (targets.length === 0) {
        setMessage('No unassigned bridges in this selection.');
      }
    } catch (err) {
      setMessage(
        `Load failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setLoading(false);
    }
  };

  const insertAssignments = useCallback(
    async (assetIds: string[], inspector: string) => {
      const sb = getSupabase()!;
      const rows = assetIds.map((asset_id) => ({
        asset_id,
        assigned_to: inspector,
        assigned_by: 'dashboard',
        status: 'assigned',
        firm_id: selectedFirmId || null,
      }));
      for (let i = 0; i < rows.length; i += 500) {
        const { error } = await sb
          .from('emg_assignments')
          .insert(rows.slice(i, i + 500));
        if (error) throw error;
      }
    },
    [selectedFirmId],
  );

  const handleBulkAssign = async () => {
    const name = inspector.trim();
    if (!name) {
      setMessage('Choose an inspector for the assignment.');
      return;
    }
    if (!district && !county) {
      setMessage('Pick a district or county first.');
      return;
    }
    setLoading(true);
    setMessage(null);
    try {
      const targets = await fetchUnassigned();
      if (targets.length === 0) {
        setMessage('No unassigned bridges in this selection.');
        return;
      }
      await insertAssignments(
        targets.map((b) => b.asset_id),
        name,
      );
      setMessage(
        `Assigned ${targets.length} bridge${targets.length === 1 ? '' : 's'} to ${name}.`,
      );
      setPreview(null);
      await reload();
    } catch (err) {
      setMessage(
        `Bulk assign failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setLoading(false);
    }
  };

  /** Assign every CHECKED bridge in the results list to one inspector. */
  const handleAssignSelected = async () => {
    const name = inspector.trim();
    if (selectedIds.size === 0) {
      setMessage('Check at least one bridge in the results list first.');
      return;
    }
    if (!name) {
      setMessage('Choose an inspector for the selected bridges.');
      return;
    }
    setLoading(true);
    setMessage(null);
    try {
      await insertAssignments([...selectedIds], name);
      setMessage(
        `Assigned ${selectedIds.size} bridge${selectedIds.size === 1 ? '' : 's'} to ${name}.`,
      );
      setSelectedIds(new Set());
      setPreview(null);
      await reload();
    } catch (err) {
      setMessage(
        `Assign failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setLoading(false);
    }
  };

  /** Paste-list assign: asset IDs separated by commas, spaces, or
   *  newlines are resolved and all assigned to one inspector at once. */
  const handlePasteAssign = async () => {
    const name = inspector.trim();
    const ids = parseIdList(pasteIds);
    if (ids.length === 0) {
      setMessage(
        'Paste bridge numbers first (separated by commas, spaces, or newlines).',
      );
      return;
    }
    if (!name) {
      setMessage('Choose an inspector for the pasted bridges.');
      return;
    }
    setLoading(true);
    setMessage(null);
    try {
      const result = await resolveBridgeIds(
        ids,
        bridgeState,
        selectedFirmId || null,
      );
      if (result.found.length === 0) {
        setMessage(
          `No bridges matched. ${result.notFound.length} ID(s) not found in ${bridgeState}.`,
        );
        return;
      }
      await insertAssignments(
        result.found.map((b) => b.asset_id),
        name,
      );
      setMessage(
        `Assigned ${result.found.length} bridge${result.found.length === 1 ? '' : 's'} to ${name}.` +
          (result.notFound.length > 0
            ? ` ${result.notFound.length} ID(s) not found: ${result.notFound.slice(0, 8).join(', ')}${result.notFound.length > 8 ? '…' : ''}`
            : ''),
      );
      setPasteIds('');
      await reload();
    } catch (err) {
      setMessage(
        `Assign failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setLoading(false);
    }
  };

  const toggleSelected = (assetId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(assetId)) next.delete(assetId);
      else next.add(assetId);
      return next;
    });
  };

  const displayedPreview = useMemo(() => {
    if (!preview) return null;
    if (!locationSort) return preview;
    const firstSelected = preview.find((b) => selectedIds.has(b.asset_id));
    return sortByProximity(preview, firstSelected?.asset_id ?? null);
  }, [preview, locationSort, selectedIds]);

  // Assignment-status filters: Inspector dropdown (firm roster plus any
  // assignee already on the list) and Bridge dropdown (bridges in the
  // current assignments list). '' = all.
  const inspectorFilterOptions = useMemo(() => {
    const names = new Set<string>(rosterNames);
    for (const a of assignments) {
      if (a.assigned_to) names.add(a.assigned_to);
    }
    return [...names].sort((a, b) => a.localeCompare(b));
  }, [rosterNames, assignments]);

  const bridgeFilterOptions = useMemo(
    () => [...new Set(assignments.map((a) => a.asset_id))].sort(),
    [assignments],
  );

  const filtered = assignments.filter((a) => {
    if (filterInspector && a.assigned_to !== filterInspector) return false;
    if (filterBridge && a.asset_id !== filterBridge) return false;
    return true;
  });

  const openCount = assignments.filter((a) => a.status !== 'complete').length;
  const selectedFirmName =
    firms.find((f) => f.id === selectedFirmId)?.name ?? null;

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
            {selectedFirmName ? ` · ${selectedFirmName}` : ''}
          </span>
        </h1>
        {message && (
          <p className="muted" style={{ color: '#e2e8f0' }}>
            {message}
          </p>
        )}
        {/* Firm picker — NEVER rendered for a bound firm_admin. */}
        {!firmLocked && firms.length > 0 && (
          <div
            style={{
              display: 'flex',
              gap: 8,
              flexWrap: 'wrap',
              alignItems: 'flex-end',
              marginTop: 8,
            }}
          >
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span className="muted">Firm</span>
              <select
                value={selectedFirmId}
                onChange={(e) => {
                  setSelectedFirmId(e.target.value);
                  setPreview(null);
                  setSelectedIds(new Set());
                }}
                disabled={loading}
                style={{ minWidth: 180 }}
              >
                <option value="">All firms</option>
                {firms.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name}
                    {f.states.length > 0 ? ` (${f.states.join(', ')})` : ''}
                  </option>
                ))}
              </select>
            </label>
          </div>
        )}
        <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
          <button
            type="button"
            className={tab === 'assign' ? 'btn btn-primary' : 'btn'}
            onClick={() => setTab('assign')}
          >
            Assign Bridges
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

      {tab === 'assign' && (
        <div className="card">
          <h2 style={{ marginTop: 0 }}>Assign Bridges</h2>
            <div
              style={{
                display: 'flex',
                gap: 8,
                flexWrap: 'wrap',
                alignItems: 'flex-end',
              }}
            >
              <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <span className="muted">State</span>
                <select
                  value={bridgeState}
                  onChange={(e) => {
                    setBridgeState(e.target.value as BridgeState);
                    setDistrict('');
                    setCounty('');
                    setPreview(null);
                    setSelectedIds(new Set());
                  }}
                  disabled={loading || stateLocked}
                >
                  <option value="SC">SC — South Carolina</option>
                  <option value="NC">NC — North Carolina</option>
                </select>
              </label>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <span className="muted">
                  {bridgeState === 'NC' ? 'Division' : 'District'}
                </span>
                <select
                  value={district}
                  onChange={(e) => setDistrict(e.target.value)}
                  disabled={loading}
                >
                  <option value="">All</option>
                  {districtOptions.map((d) => (
                    <option key={d.value} value={d.value}>
                      {d.label}
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
              <button
                type="button"
                className="btn"
                onClick={() => void handlePreview()}
                disabled={loading}
              >
                {loading ? 'Working…' : 'Show bridges'}
              </button>
            </div>
            <p className="muted">
              {bridgeState === 'NC' ? 'Division' : 'District'} and county
              lists come only from {bridgeState} bridges. Results show
              unassigned bridges
              {selectedFirmName ? ` in ${selectedFirmName}'s group` : ''}.
            </p>
            <div
              style={{
                display: 'flex',
                gap: 8,
                flexWrap: 'wrap',
                alignItems: 'flex-end',
                borderTop: '1px solid #334155',
                paddingTop: 12,
              }}
            >
              <label
                style={{ display: 'flex', flexDirection: 'column', gap: 4 }}
              >
                <span className="muted">Assign to (inspector)</span>
                <InspectorSelect
                  firmId={selectedFirmId || null}
                  value={inspector}
                  onChange={setInspector}
                  disabled={loading}
                />
              </label>
              <button
                type="button"
                className="btn"
                onClick={() => void handleBulkAssign()}
                disabled={loading || (!district && !county)}
              >
                {loading ? 'Working…' : 'Assign all unassigned in selection'}
              </button>
            </div>
            <p className="muted" style={{ marginBottom: 0 }}>
              “Assign all unassigned” gives every bridge in the current
              state/{bridgeState === 'NC' ? 'division' : 'district'}/county
              selection to the inspector above — bridges already assigned or
              in progress are skipped. Or show the bridges, check the ones
              you want, and assign just those.
            </p>

          {displayedPreview && (
            <div style={{ marginTop: 16 }}>
              <h3 style={{ marginTop: 0 }}>
                Bridge results{' '}
                <span className="muted" style={{ fontWeight: 400, fontSize: 13 }}>
                  {displayedPreview.length} unassigned · {selectedIds.size}{' '}
                  checked
                </span>
              </h3>
              <div
                style={{
                  display: 'flex',
                  gap: 8,
                  flexWrap: 'wrap',
                  alignItems: 'flex-end',
                  marginBottom: 10,
                }}
              >
                <label
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    cursor: 'pointer',
                    minHeight: 40,
                  }}
                >
                  <input
                    type="checkbox"
                    checked={locationSort}
                    onChange={(e) => setLocationSort(e.target.checked)}
                    style={{ width: 18, height: 18, accentColor: '#CF3910' }}
                  />
                  <span>Sort by location (nearest-neighbor)</span>
                </label>
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => void handleAssignSelected()}
                  disabled={loading || selectedIds.size === 0}
                >
                  Assign checked ({selectedIds.size})
                </button>
                <button
                  type="button"
                  className="btn"
                  onClick={() =>
                    setSelectedIds(
                      new Set(
                        displayedPreview
                          .slice(0, PREVIEW_LIMIT)
                          .map((b) => b.asset_id),
                      ),
                    )
                  }
                  disabled={loading}
                >
                  Check all shown
                </button>
                <button
                  type="button"
                  className="btn"
                  onClick={() => setSelectedIds(new Set())}
                  disabled={loading || selectedIds.size === 0}
                >
                  Clear checks
                </button>
              </div>
              <div style={{ overflowX: 'auto', maxHeight: 480, overflowY: 'auto' }}>
                <table className="data">
                  <thead>
                    <tr>
                      <th></th>
                      <th>Bridge</th>
                      <th>Facility</th>
                      <th>County</th>
                      <th>{bridgeState === 'NC' ? 'Division' : 'District'}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {displayedPreview.slice(0, PREVIEW_LIMIT).map((b) => (
                      <tr key={b.asset_id}>
                        <td>
                          <input
                            type="checkbox"
                            aria-label={`Select ${b.asset_id}`}
                            checked={selectedIds.has(b.asset_id)}
                            onChange={() => toggleSelected(b.asset_id)}
                            style={{
                              width: 20,
                              height: 20,
                              accentColor: '#CF3910',
                            }}
                          />
                        </td>
                        <td>
                          <code>{b.asset_id}</code>
                        </td>
                        <td>{b.facility ?? '—'}</td>
                        <td>{b.county_name ?? b.county ?? '—'}</td>
                        <td>{b.district ?? '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {displayedPreview.length > PREVIEW_LIMIT && (
                <p className="muted">
                  Showing {PREVIEW_LIMIT} of {displayedPreview.length} —
                  narrow the district/county to see the rest.
                </p>
              )}
            </div>
          )}

          <div
            style={{
              borderTop: '1px solid #334155',
              marginTop: 16,
              paddingTop: 12,
            }}
          >
            <h3 style={{ marginTop: 0 }}>Assign by bridge list</h3>
            <p className="muted" style={{ marginTop: 0 }}>
              Paste bridge numbers — separated by commas, spaces, or
              newlines (Import CSV lists work too) — and assign them all to
              the inspector chosen above.
            </p>
            <textarea
              value={pasteIds}
              onChange={(e) => setPasteIds(e.target.value)}
              placeholder={'e.g. SC-1892, SC-1893 SC-1901\nNC-10001'}
              rows={4}
              style={{ width: '100%', fontFamily: 'monospace', fontSize: 13 }}
              disabled={loading}
            />
            <div
              style={{
                display: 'flex',
                gap: 8,
                flexWrap: 'wrap',
                alignItems: 'flex-end',
                marginTop: 8,
              }}
            >
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => void handlePasteAssign()}
                disabled={loading || !pasteIds.trim()}
              >
                Assign listed bridges
              </button>
            </div>
          </div>
        </div>
      )}

      {tab === 'bulk' && <BulkBridgeInput firmId={selectedFirmId || null} />}

      <div className="card">
        <h2 style={{ marginTop: 0 }}>Assignment status</h2>
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
            <span className="muted">Inspector</span>
            <select
              value={filterInspector}
              onChange={(e) => setFilterInspector(e.target.value)}
              style={{ minWidth: 180 }}
            >
              <option value="">All inspectors</option>
              {inspectorFilterOptions.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span className="muted">Bridge</span>
            <select
              value={filterBridge}
              onChange={(e) => setFilterBridge(e.target.value)}
              style={{ minWidth: 180 }}
            >
              <option value="">All bridges</option>
              {bridgeFilterOptions.map((id) => (
                <option key={id} value={id}>
                  {id}
                </option>
              ))}
            </select>
          </label>
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
