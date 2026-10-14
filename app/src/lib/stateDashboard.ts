// State operations dashboard data layer.
//
// Three-tier hierarchy:
//   State -> assigns bridge groups to Firms (firm_bridges)
//   Firm  -> assigns bridges to Inspectors (emg_assignments, firm dashboard)
//   Inspector -> inspects in the Field app
//
// This module aggregates cross-firm progress for state emergency managers:
// per-firm completion, condition rollups, and bridge-to-firm assignment.
import { getSupabase, isSupabaseConfigured, isOnline } from './supabase';
import { syncFirms, getCachedFirms, firmServesState } from './firm';
import type { EmgState, Firm } from '../types';

/**
 * A bridge's state is the prefix of its asset_id before '-'
 * (asset IDs are state-prefixed: 'SC-1892', 'NC-10001' — migration 015).
 */
export function stateOfAsset(assetId: string): string {
  const i = assetId.indexOf('-');
  return i > 0 ? assetId.slice(0, i).toUpperCase() : '';
}

/** States known before migration 015 / when offline. */
export const FALLBACK_STATES: EmgState[] = [
  { code: 'SC', name: 'South Carolina', created_at: '' },
  { code: 'NC', name: 'North Carolina', created_at: '' },
];

/** Load the state list from emg_states; falls back to SC/NC. */
export async function loadStates(): Promise<EmgState[]> {
  const sb = getSupabase();
  if (!sb || !isSupabaseConfigured() || !isOnline()) return FALLBACK_STATES;
  try {
    const { data, error } = await sb
      .from('emg_states')
      .select('code,name,created_at')
      .order('code');
    if (error || !data || data.length === 0) return FALLBACK_STATES;
    return (data as unknown as EmgState[]).map((s) => ({
      code: String(s.code),
      name: String(s.name ?? s.code),
      created_at: String(s.created_at ?? ''),
    }));
  } catch {
    return FALLBACK_STATES;
  }
}

/** Distinct firm colors for map + table chips. */
export const FIRM_PALETTE = [
  '#38bdf8', // sky
  '#f472b6', // pink
  '#a3e635', // lime
  '#fbbf24', // amber
  '#c084fc', // purple
  '#34d399', // emerald
  '#fb7185', // rose
  '#f97316', // orange
  '#22d3ee', // cyan
  '#e879f9', // fuchsia
  '#a8b3c7', // slate (overflow)
  '#facc15', // yellow (overflow)
];

/** Deterministic color per firm, stable across renders. */
export function buildFirmColorMap(firms: Firm[]): Map<string, string> {
  const map = new Map<string, string>();
  const sorted = [...firms].sort((a, b) => a.name.localeCompare(b.name));
  sorted.forEach((f, i) => {
    map.set(f.id, FIRM_PALETTE[i % FIRM_PALETTE.length]);
  });
  return map;
}

export interface InspectionLite {
  asset_id: string;
  firm_id: string | null;
  triage_list: string | null;
  remain_open: string | null;
  inspector_name: string | null;
  inspection_datetime: string | null;
}

export interface AssignmentLite {
  asset_id: string;
  firm_id: string | null;
  assigned_to: string | null;
  status: string | null;
}

export interface FirmProgress {
  firm_id: string;
  firm_name: string;
  assigned: number;
  inspected: number;
  pctComplete: number;
  destroyed: number;
  likelyDestroyed: number;
  revisit: number;
  groundFollowup: number;
  complete: number;
  open: number;
  restricted: number;
  closed: number;
}

export interface StateOverview {
  firmCount: number;
  totalAssigned: number;
  totalInspected: number;
  pctComplete: number;
  inventoryTotal: number;
  unassigned: number;
  byTriage: Record<string, number>;
  open: number;
  restricted: number;
  closed: number;
  openUnknown: number;
}

export interface StateBridgeRow {
  asset_id: string;
  firm_id: string | null;
  firm_name: string;
  county: string | null;
  facility: string | null;
  inspector: string | null;
  assignStatus: string | null;
  triage: string | null;
  openStatus: string | null;
  inspectedAt: string | null;
  lat: number | null;
  lon: number | null;
}

export interface BridgeDetail {
  asset_id: string;
  firm: Firm | null;
  county: string | null;
  facility: string | null;
  feature: string | null;
  inspector: string | null;
  assignStatus: string | null;
  triage: string | null;
  openStatus: string | null;
  inspectedAt: string | null;
  inspectedBy: string | null;
}

/** Paginated fetch of a whole table (PostgREST caps pages at 1000 rows). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function fetchAll<T>(table: string, select: string, orderCol: string): Promise<T[]> {
  const sb = getSupabase();
  if (!sb || !isSupabaseConfigured()) return [];
  const out: T[] = [];
  const PAGE = 1000;
  let from = 0;
  for (;;) {
    const { data, error } = await sb
      .from(table)
      .select(select)
      .order(orderCol, { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw error;
    const rows = (data ?? []) as unknown as T[];
    out.push(...rows);
    if (rows.length < PAGE) break;
    from += PAGE;
    if (from > 200000) break; // safety valve
  }
  return out;
}

export interface StateData {
  firms: Firm[];
  firmBridges: { firm_id: string; asset_id: string }[];
  inspections: InspectionLite[];
  assignments: AssignmentLite[];
}

/**
 * Load every firm + bridge mapping + inspection + assignment row.
 * When `stateCode` is given, the result is scoped to that state:
 * firms serving that state (firm_states, migration 016 — a multi-state
 * firm is in scope for EACH of its states), their bridge mappings
 * (additionally prefix-checked against asset_id), and
 * inspections/assignments for bridges in that state. Firms with no
 * states assigned appear only in the unscoped (super admin) view.
 */
export async function loadStateData(stateCode?: string | null): Promise<StateData> {
  const online = isOnline() && isSupabaseConfigured();
  const firms: Firm[] = online ? await syncFirms().catch(() => []) : [];
  const cached = firms.length > 0 ? firms : await getCachedFirms().catch(() => []);
  if (!online) {
    return {
      firms: stateCode ? cached.filter((f) => firmServesState(f, stateCode)) : cached,
      firmBridges: [],
      inspections: [],
      assignments: [],
    };
  }
  const [firmBridges, inspections, assignments] = await Promise.all([
    fetchAll<{ firm_id: string; asset_id: string }>(
      'firm_bridges',
      'firm_id,asset_id',
      'asset_id',
    ).catch(() => []),
    fetchAll<InspectionLite>(
      'emg_inspections',
      'asset_id,firm_id,triage_list,remain_open,inspector_name,inspection_datetime',
      'inspection_datetime',
    ).catch(() => []),
    fetchAll<AssignmentLite>(
      'emg_assignments',
      'asset_id,firm_id,assigned_to,status',
      'asset_id',
    ).catch(() => []),
  ]);
  const all: StateData = { firms: cached, firmBridges, inspections, assignments };
  if (!stateCode) return all;
  const scopedFirms = cached.filter((f) => firmServesState(f, stateCode));
  const scopedFirmIds = new Set(scopedFirms.map((f) => f.id));
  return {
    firms: scopedFirms,
    firmBridges: firmBridges.filter(
      (fb) => scopedFirmIds.has(fb.firm_id) && stateOfAsset(fb.asset_id) === stateCode,
    ),
    inspections: inspections.filter((i) => stateOfAsset(i.asset_id) === stateCode),
    assignments: assignments.filter((a) => stateOfAsset(a.asset_id) === stateCode),
  };
}

/** Latest inspection per bridge (by inspection_datetime). */
export function latestInspections(
  inspections: InspectionLite[],
): Map<string, InspectionLite> {
  const map = new Map<string, InspectionLite>();
  for (const insp of inspections) {
    if (!insp.asset_id) continue;
    const prev = map.get(insp.asset_id);
    if (!prev || (insp.inspection_datetime ?? '') >= (prev.inspection_datetime ?? '')) {
      map.set(insp.asset_id, insp);
    }
  }
  return map;
}

/** Latest assignment per bridge (last row wins after asset_id ordering). */
function latestAssignments(assignments: AssignmentLite[]): Map<string, AssignmentLite> {
  const map = new Map<string, AssignmentLite>();
  for (const a of assignments) {
    if (a.asset_id) map.set(a.asset_id, a);
  }
  return map;
}

/** asset_id -> firm_id from the firm_bridges mapping. */
export function firmBridgeMap(
  firmBridges: { firm_id: string; asset_id: string }[],
): Map<string, string> {
  const map = new Map<string, string>();
  for (const fb of firmBridges) {
    if (fb.asset_id && fb.firm_id && !map.has(fb.asset_id)) {
      map.set(fb.asset_id, fb.firm_id);
    }
  }
  return map;
}

function emptyProgress(firm_id: string, firm_name: string): FirmProgress {
  return {
    firm_id,
    firm_name,
    assigned: 0,
    inspected: 0,
    pctComplete: 0,
    destroyed: 0,
    likelyDestroyed: 0,
    revisit: 0,
    groundFollowup: 0,
    complete: 0,
    open: 0,
    restricted: 0,
    closed: 0,
  };
}

/** Per-firm progress computed from firm_bridges + latest inspections. */
export function computeFirmProgress(data: StateData): FirmProgress[] {
  const bridgeToFirm = firmBridgeMap(data.firmBridges);
  const latest = latestInspections(data.inspections);
  const byFirm = new Map<string, FirmProgress>();
  for (const f of data.firms) {
    byFirm.set(f.id, emptyProgress(f.id, f.name));
  }
  // Assigned counts from the mapping table.
  const seen = new Set<string>();
  for (const fb of data.firmBridges) {
    const key = `${fb.firm_id}|${fb.asset_id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const p = byFirm.get(fb.firm_id);
    if (p) p.assigned += 1;
  }
  // Inspection rollup per firm (via the bridge->firm mapping, so legacy
  // rows without firm_id still count).
  const inspectedAssets = new Map<string, Set<string>>();
  for (const [assetId, insp] of latest) {
    const fid = bridgeToFirm.get(assetId) ?? insp.firm_id ?? null;
    if (!fid) continue;
    const p = byFirm.get(fid);
    if (!p) continue;
    let set = inspectedAssets.get(fid);
    if (!set) {
      set = new Set<string>();
      inspectedAssets.set(fid, set);
    }
    set.add(assetId);
    switch (insp.triage_list) {
      case 'destroyed':
        p.destroyed += 1;
        break;
      case 'likely_destroyed':
        p.likelyDestroyed += 1;
        break;
      case 'revisit':
        p.revisit += 1;
        break;
      case 'ground_followup':
        p.groundFollowup += 1;
        break;
      case 'complete':
        p.complete += 1;
        break;
      default:
        break;
    }
    switch (insp.remain_open) {
      case 'yes':
        p.open += 1;
        break;
      case 'restricted_lanes':
        p.restricted += 1;
        break;
      case 'no':
        p.closed += 1;
        break;
      default:
        break;
    }
  }
  for (const [fid, set] of inspectedAssets) {
    const p = byFirm.get(fid);
    if (p) {
      p.inspected = set.size;
      p.pctComplete = p.assigned > 0 ? Math.round((set.size / p.assigned) * 100) : 0;
    }
  }
  return [...byFirm.values()].sort((a, b) => b.pctComplete - a.pctComplete);
}

/** Aggregate overview across all firms in `data` (already state-scoped
 *  by loadStateData when a scope was requested). `stateCode` only
 *  scopes the inventory-total count query. */
export async function computeStateOverview(
  data: StateData,
  stateCode?: string | null,
): Promise<StateOverview> {
  const progress = computeFirmProgress(data);
  const latest = latestInspections(data.inspections);
  const bridgeToFirm = firmBridgeMap(data.firmBridges);
  const byTriage: Record<string, number> = {};
  let open = 0;
  let restricted = 0;
  let closed = 0;
  let openUnknown = 0;
  let totalInspected = 0;
  const seenInspected = new Set<string>();
  for (const [assetId, insp] of latest) {
    const fid = bridgeToFirm.get(assetId) ?? insp.firm_id ?? null;
    if (!fid) continue; // only in-scope (firm-assigned) bridges count
    if (seenInspected.has(assetId)) continue;
    seenInspected.add(assetId);
    totalInspected += 1;
    const t = insp.triage_list ?? 'unknown';
    byTriage[t] = (byTriage[t] ?? 0) + 1;
    switch (insp.remain_open) {
      case 'yes':
        open += 1;
        break;
      case 'restricted_lanes':
        restricted += 1;
        break;
      case 'no':
        closed += 1;
        break;
      default:
        openUnknown += 1;
        break;
    }
  }
  const totalAssigned = progress.reduce((s, p) => s + p.assigned, 0);
  // Inventory total (cheap count query), scoped to the state's
  // asset_id prefix when a state scope is active.
  let inventoryTotal = 0;
  try {
    const sb = getSupabase();
    if (sb && isSupabaseConfigured() && isOnline()) {
      let q = sb
        .from('emg_bridges')
        .select('asset_id', { count: 'exact', head: true });
      if (stateCode) q = q.like('asset_id', `${stateCode}-%`);
      const { count } = await q;
      inventoryTotal = count ?? 0;
    }
  } catch {
    inventoryTotal = 0;
  }
  return {
    firmCount: data.firms.length,
    totalAssigned,
    totalInspected,
    pctComplete:
      totalAssigned > 0 ? Math.round((totalInspected / totalAssigned) * 100) : 0,
    inventoryTotal,
    unassigned: Math.max(0, inventoryTotal - totalAssigned),
    byTriage,
    open,
    restricted,
    closed,
    openUnknown,
  };
}

/**
 * Assign bridges to a firm (upsert into firm_bridges; existing rows kept).
 * Returns the number of rows written.
 */
export async function assignBridgesToFirm(
  assetIds: string[],
  firmId: string,
): Promise<{ inserted: number }> {
  const sb = getSupabase();
  if (!sb || !isSupabaseConfigured()) throw new Error('Supabase is not configured');
  const uniq = [...new Set(assetIds.map((a) => a.trim()).filter(Boolean))];
  if (uniq.length === 0) return { inserted: 0 };
  const rows = uniq.map((asset_id) => ({ firm_id: firmId, asset_id }));
  let inserted = 0;
  for (let i = 0; i < rows.length; i += 500) {
    const { error, count } = await sb
      .from('firm_bridges')
      .upsert(rows.slice(i, i + 500), {
        onConflict: 'firm_id,asset_id',
        ignoreDuplicates: true,
        count: 'exact',
      });
    if (error) throw error;
    inserted += count ?? 0;
  }
  return { inserted };
}

/** Remove bridges from a firm. */
export async function unassignBridgesFromFirm(
  assetIds: string[],
  firmId: string,
): Promise<void> {
  const sb = getSupabase();
  if (!sb || !isSupabaseConfigured()) throw new Error('Supabase is not configured');
  const uniq = [...new Set(assetIds.map((a) => a.trim()).filter(Boolean))];
  for (let i = 0; i < uniq.length; i += 500) {
    const { error } = await sb
      .from('firm_bridges')
      .delete()
      .eq('firm_id', firmId)
      .in('asset_id', uniq.slice(i, i + 500));
    if (error) throw error;
  }
}

/** Create a firm. When created from a state-scoped view, pass the
 *  state so the firm is born serving it (a firm_states row, migration
 *  016 — firms.state_code is deprecated and no longer written). */
export async function createFirm(
  name: string,
  stateCode?: string | null,
): Promise<Firm> {
  const sb = getSupabase();
  if (!sb || !isSupabaseConfigured()) throw new Error('Supabase is not configured');
  const clean = name.trim();
  if (!clean) throw new Error('Firm name is required');
  const { data, error } = await sb
    .from('firms')
    .insert({ name: clean })
    .select('id,name,created_at')
    .single();
  if (error) throw error;
  const f = data as unknown as Firm;
  const states: string[] = [];
  if (stateCode) {
    const { error: fsError } = await sb
      .from('firm_states')
      .insert({ firm_id: f.id, state_code: stateCode });
    if (fsError) throw fsError;
    states.push(stateCode);
  }
  return {
    id: String(f.id),
    name: String(f.name),
    created_at: String(f.created_at ?? ''),
    states,
  };
}

/** Which firm (if any) currently owns each of these bridges. */
export async function getExistingFirmAssignments(
  assetIds: string[],
): Promise<Map<string, string>> {
  const sb = getSupabase();
  const map = new Map<string, string>();
  if (!sb || !isSupabaseConfigured() || assetIds.length === 0) return map;
  const uniq = [...new Set(assetIds)];
  for (let i = 0; i < uniq.length; i += 500) {
    const { data, error } = await sb
      .from('firm_bridges')
      .select('firm_id,asset_id')
      .in('asset_id', uniq.slice(i, i + 500));
    if (error) throw error;
    for (const r of (data ?? []) as unknown as { firm_id: string; asset_id: string }[]) {
      if (!map.has(r.asset_id)) map.set(r.asset_id, r.firm_id);
    }
  }
  return map;
}

export interface BridgeMeta {
  asset_id: string;
  county: string | null;
  county_name: string | null;
  facility: string | null;
  feature: string | null;
  lat: number | null;
  lon: number | null;
}

/** County/facility/coordinate lookup for a set of bridges (chunked). */
export async function getBridgeMeta(assetIds: string[]): Promise<Map<string, BridgeMeta>> {
  const sb = getSupabase();
  const map = new Map<string, BridgeMeta>();
  if (!sb || !isSupabaseConfigured() || assetIds.length === 0) return map;
  const uniq = [...new Set(assetIds)];
  for (let i = 0; i < uniq.length; i += 500) {
    const { data, error } = await sb
      .from('emg_bridges')
      .select('asset_id,county,county_name,facility,feature,lat,lon')
      .in('asset_id', uniq.slice(i, i + 500));
    if (error) throw error;
    for (const r of (data ?? []) as unknown as BridgeMeta[]) {
      map.set(r.asset_id, {
        asset_id: r.asset_id,
        county: r.county ?? null,
        county_name: r.county_name ?? null,
        facility: r.facility ?? null,
        feature: r.feature ?? null,
        lat: typeof r.lat === 'number' ? r.lat : null,
        lon: typeof r.lon === 'number' ? r.lon : null,
      });
    }
  }
  return map;
}

/**
 * Flat bridge rows for the state table: every bridge in firm scope with
 * firm, latest assignment, latest inspection, and county/facility meta.
 */
export async function buildStateBridgeRows(data: StateData): Promise<StateBridgeRow[]> {
  const bridgeToFirm = firmBridgeMap(data.firmBridges);
  const firmName = new Map(data.firms.map((f) => [f.id, f.name]));
  const latest = latestInspections(data.inspections);
  const assignByAsset = latestAssignments(data.assignments);
  const assetIds = [...new Set(data.firmBridges.map((fb) => fb.asset_id))];
  const meta = await getBridgeMeta(assetIds).catch(() => new Map<string, BridgeMeta>());
  return assetIds
    .map((asset_id) => {
      const fid = bridgeToFirm.get(asset_id) ?? null;
      const insp = latest.get(asset_id) ?? null;
      const asg = assignByAsset.get(asset_id) ?? null;
      const m = meta.get(asset_id) ?? null;
      return {
        asset_id,
        firm_id: fid,
        firm_name: fid ? (firmName.get(fid) ?? '—') : '—',
        county: m?.county_name ?? m?.county ?? null,
        facility: m?.facility ?? null,
        inspector: asg?.assigned_to ?? insp?.inspector_name ?? null,
        assignStatus: asg?.status ?? null,
        triage: insp?.triage_list ?? null,
        openStatus: insp?.remain_open ?? null,
        inspectedAt: insp?.inspection_datetime ?? null,
        lat: m?.lat ?? null,
        lon: m?.lon ?? null,
      };
    })
    .sort((a, b) => a.asset_id.localeCompare(b.asset_id));
}

/** Detail for one bridge on the state map. */
export async function getBridgeDetail(assetId: string, data: StateData): Promise<BridgeDetail> {
  const bridgeToFirm = firmBridgeMap(data.firmBridges);
  const fid = bridgeToFirm.get(assetId) ?? null;
  const firm = fid ? (data.firms.find((f) => f.id === fid) ?? null) : null;
  const latest = latestInspections(data.inspections).get(assetId) ?? null;
  const asg =
    data.assignments.filter((a) => a.asset_id === assetId).slice(-1)[0] ?? null;
  let county: string | null = null;
  let facility: string | null = null;
  let feature: string | null = null;
  try {
    const meta = await getBridgeMeta([assetId]);
    const m = meta.get(assetId);
    county = m?.county_name ?? m?.county ?? null;
    facility = m?.facility ?? null;
    feature = m?.feature ?? null;
  } catch {
    // ignore
  }
  return {
    asset_id: assetId,
    firm,
    county,
    facility,
    feature,
    inspector: asg?.assigned_to ?? latest?.inspector_name ?? null,
    assignStatus: asg?.status ?? null,
    triage: latest?.triage_list ?? null,
    openStatus: latest?.remain_open ?? null,
    inspectedAt: latest?.inspection_datetime ?? null,
    inspectedBy: latest?.inspector_name ?? null,
  };
}
