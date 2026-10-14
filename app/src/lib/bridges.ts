// Bridge inventory data access: Supabase (online) with IndexedDB cache.
// lon/lat/geojson are generated columns on the emg_* tables (migration 006),
// so plain column selects work — PostgREST rejects function calls like
// st_x(geom) inside the select parameter (HTTP 400).
import { getSupabase, isSupabaseConfigured, isOnline } from './supabase';
import { idbBulkPut, idbGet, idbGetAll, idbPut } from './idb';
import { normalizeAssetId, haversineMeters } from './geo';
import type { Bridge, District } from '../types';

const PAGE = 1000;

function rowToBridge(r: Record<string, unknown>): Bridge {
  return {
    asset_id: String(r.asset_id),
    struct_no: String(r.struct_no ?? ''),
    county: (r.county as string) ?? null,
    county_name: (r.county_name as string) ?? null,
    district: r.district != null ? String(r.district) : null,
    facility: (r.facility as string) ?? null,
    feature: (r.feature as string) ?? null,
    location: (r.location as string) ?? null,
    deck: (r.deck as string) ?? null,
    super: (r.super as string) ?? null,
    sub: (r.sub as string) ?? null,
    channel: (r.channel as string) ?? null,
    culvert: (r.culvert as string) ?? null,
    struct_eval: (r.struct_eval as string) ?? null,
    deck_geom: (r.deck_geom as string) ?? null,
    scour: (r.scour as string) ?? null,
    inv_rating: (r.inv_rating as string) ?? null,
    op_rating: (r.op_rating as string) ?? null,
    posting: (r.posting as string) ?? null,
    design_load: (r.design_load as string) ?? null,
    yr_built: (r.yr_built as number) ?? null,
    yr_recon: (r.yr_recon as number) ?? null,
    length_m: (r.length_m as number) ?? null,
    max_span_m: (r.max_span_m as number) ?? null,
    spans: (r.spans as number) ?? null,
    lanes: (r.lanes as number) ?? null,
    skew: (r.skew as number) ?? null,
    adt: (r.adt as number) ?? null,
    truck_pct: (r.truck_pct as number) ?? null,
    insp_freq: (r.insp_freq as number) ?? null,
    last_inspect: (r.last_inspect as string) ?? null,
    maint: (r.maint as string) ?? null,
    owner: (r.owner as string) ?? null,
    status: (r.status as string) ?? null,
    bridge_cond: (r.bridge_cond as string) ?? null,
    lowest: (r.lowest as string) ?? null,
    span_mat: (r.span_mat as string) ?? null,
    span_type: (r.span_type as string) ?? null,
    lon: Number(r.lon),
    lat: Number(r.lat),
  };
}

const BRIDGE_SELECT =
  'asset_id,struct_no,county,county_name,district,facility,feature,location,' +
  'deck,super,sub,channel,culvert,struct_eval,deck_geom,scour,inv_rating,op_rating,' +
  'posting,design_load,yr_built,yr_recon,length_m,max_span_m,spans,lanes,skew,adt,' +
  'truck_pct,insp_freq,last_inspect,maint,owner,status,bridge_cond,lowest,span_mat,' +
  'span_type,lon,lat';

export interface SyncBridgeCacheOptions {
  /** Restrict the download to these state codes ('SC', 'NC'): only
   *  bridges whose asset_id starts with `<state>-` are fetched. */
  states?: string[];
  /** Download ONLY these bridges (e.g. the inspector's assignments).
   *  Takes precedence over `states` when non-empty. */
  assetIds?: string[];
}

/**
 * Download bridge inventory into the IndexedDB cache, with progress.
 * With no options this downloads the ENTIRE inventory; callers that
 * offer a choice (BridgeLookup's chooser) pass `states` or `assetIds`
 * to scope the download.
 */
export async function syncBridgeCache(
  onProgress?: (done: number, total: number) => void,
  options?: SyncBridgeCacheOptions,
): Promise<number> {
  const sb = getSupabase();
  if (!sb) throw new Error('Supabase is not configured');
  let total = 0;

  const putRows = async (rows: Record<string, unknown>[]) => {
    if (rows.length === 0) return;
    await idbBulkPut('bridges', rows.map(rowToBridge));
    total += rows.length;
  };

  if (options?.assetIds && options.assetIds.length > 0) {
    // Scoped download: page through the requested id list with .in().
    const ids = [...new Set(options.assetIds)];
    for (let i = 0; i < ids.length; i += 500) {
      const { data, error } = await sb
        .from('emg_bridges')
        .select(BRIDGE_SELECT)
        .in('asset_id', ids.slice(i, i + 500));
      if (error) throw error;
      await putRows((data ?? []) as unknown as Record<string, unknown>[]);
      onProgress?.(total, ids.length);
    }
  } else {
    const prefixes = (options?.states ?? []).map((s) => `${s}-`);
    let expected = 0;
    try {
      let countQuery = sb
        .from('emg_bridges')
        .select('asset_id', { count: 'exact', head: true });
      if (prefixes.length === 1) {
        countQuery = countQuery.like('asset_id', `${prefixes[0]}%`);
      } else if (prefixes.length > 1) {
        countQuery = countQuery.or(
          prefixes.map((p) => `asset_id.like.${p}%`).join(','),
        );
      }
      const { count } = await countQuery;
      if (typeof count === 'number') expected = count;
    } catch {
      // Progress total is cosmetic; the page loops below still run.
    }

    const pagePrefix = async (prefix: string | null) => {
      let offset = 0;
      for (;;) {
        let q = sb
          .from('emg_bridges')
          .select(BRIDGE_SELECT)
          .order('asset_id', { ascending: true })
          .range(offset, offset + PAGE - 1);
        if (prefix) q = q.like('asset_id', `${prefix}%`);
        const { data, error } = await q;
        if (error) throw error;
        const rows = (data ?? []) as unknown as Record<string, unknown>[];
        if (rows.length === 0) break;
        await putRows(rows);
        onProgress?.(total, expected || total);
        if (rows.length < PAGE) break;
        offset += PAGE;
      }
    };

    if (prefixes.length === 0) {
      await pagePrefix(null);
    } else {
      for (const prefix of prefixes) {
        await pagePrefix(prefix);
      }
    }
  }

  await idbPut('meta', { key: 'bridges_synced_at', value: new Date().toISOString() });
  await idbPut('meta', { key: 'bridges_count', value: total });
  return total;
}

/** Look up one bridge by Asset ID. Tries cache first, then network. */
/**
 * Find bridges by any number a user might type:
 * - state-prefixed asset id ("SC-1892", "NC 10001")
 * - the DOT short number (SC Asset ID / NC bridge number: "1892")
 * - the full FHWA structure number ("000000000001892")
 * Short and long digit forms need no length detection: in this inventory
 * the DOT short number IS the structure number without leading zeros, so
 * both resolve to the same bridges. The same number can exist in more
 * than one state, so ALL matches are returned and the caller lets the
 * user pick when there is more than one.
 */
export async function findBridges(rawInput: string): Promise<Bridge[]> {
  const input = rawInput.trim().toUpperCase();
  if (!input) return [];
  const matches = new Map<string, Bridge>();
  const add = (b: Bridge | null | undefined) => {
    if (b) matches.set(b.asset_id, b);
  };

  const prefixed = input.match(/^([A-Z]{2})[-\s]?(\d+)$/);
  const bareDigits = /^\d+$/.test(input) ? String(parseInt(input, 10)) : null;

  // Exact asset id lookups against the device cache.
  if (prefixed) {
    add(
      await idbGet<Bridge>(
        'bridges',
        `${prefixed[1]}-${String(parseInt(prefixed[2], 10))}`,
      ),
    );
  }
  add(await idbGet<Bridge>('bridges', input));

  // Cache scan: a digit query matches the zero-stripped structure number
  // (the DOT short number); anything else matches struct_no / asset_id
  // verbatim (covers alphanumeric structure numbers).
  const all = await idbGetAll<Bridge>('bridges').catch(() => [] as Bridge[]);
  for (const b of all) {
    if (bareDigits !== null) {
      if (b.struct_no.replace(/^0+/, '') === bareDigits) add(b);
    } else if (b.asset_id === input || b.struct_no.toUpperCase() === input) {
      add(b);
    }
  }
  if (matches.size > 0) return [...matches.values()];

  // Server fallback (online only).
  if (!isOnline() || !isSupabaseConfigured()) return [];
  const sb = getSupabase()!;
  const runQuery = async (
    column: 'asset_id' | 'struct_no',
    value: string,
  ): Promise<void> => {
    const { data, error } = await sb
      .from('emg_bridges')
      .select(BRIDGE_SELECT)
      .eq(column, value)
      .limit(10);
    if (error || !data) return;
    for (const row of data) {
      const b = rowToBridge(row as unknown as Record<string, unknown>);
      await idbPut('bridges', b);
      add(b);
    }
  };
  if (prefixed) {
    await runQuery(
      'asset_id',
      `${prefixed[1]}-${String(parseInt(prefixed[2], 10))}`,
    );
  } else if (bareDigits !== null) {
    // Try the number as typed, then zero-padded to the 15-digit FHWA form.
    await runQuery('struct_no', input);
    if (matches.size === 0) await runQuery('struct_no', input.padStart(15, '0'));
  } else {
    await runQuery('asset_id', input);
    if (matches.size === 0) await runQuery('struct_no', input);
  }
  return [...matches.values()];
}

export async function findBridge(rawInput: string): Promise<Bridge | null> {
  const results = await findBridges(rawInput);
  return results[0] ?? null;
}

/** Uninspected bridges nearest to a GPS fix (uses cached inventory). */
export async function nearestUninspected(
  lat: number,
  lon: number,
  inspectedAssetIds: Set<string>,
  limit = 25,
): Promise<Array<Bridge & { distanceM: number }>> {
  const all = await idbGetAll<Bridge>('bridges');
  return all
    .filter((b) => !inspectedAssetIds.has(b.asset_id))
    .map((b) => ({ ...b, distanceM: haversineMeters(lat, lon, b.lat, b.lon) }))
    .sort((a, b) => a.distanceM - b.distanceM)
    .slice(0, limit);
}

export async function getDistricts(): Promise<District[]> {
  const cached = await idbGetAll<District>('districts');
  if (cached.length > 0) return cached;
  if (!isOnline() || !isSupabaseConfigured()) return [];
  const sb = getSupabase()!;
  const { data, error } = await sb
    .from('emg_districts')
    .select('id,dist_label,geojson');
  if (error || !data) return [];
  const dists: District[] = (data as Array<Record<string, unknown>>).map((r) => ({
    id: String(r.id),
    dist_label: String(r.dist_label),
    geojson: JSON.parse(r.geojson as string) as GeoJSON.MultiPolygon,
  }));
  await idbBulkPut('districts', dists);
  return dists;
}
