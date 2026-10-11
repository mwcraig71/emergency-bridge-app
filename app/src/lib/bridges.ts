// Bridge inventory data access: Supabase (online) with IndexedDB cache.
// PostGIS points are read via st_x/st_y so no WKB parsing is needed client-side.
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
  'span_type,lon:st_x(geom),lat:st_y(geom)';

/** Download the full inventory into the IndexedDB cache. Shows progress. */
export async function syncBridgeCache(
  onProgress?: (done: number, total: number) => void,
): Promise<number> {
  const sb = getSupabase();
  if (!sb) throw new Error('Supabase is not configured');
  let offset = 0;
  let total = 0;
  for (;;) {
    const { data, error } = await sb
      .from('emg_bridges')
      .select(BRIDGE_SELECT)
      .order('asset_id', { ascending: true })
      .range(offset, offset + PAGE - 1);
    if (error) throw error;
    const rows = ((data ?? []) as unknown as Record<string, unknown>[]).map(rowToBridge);
    if (rows.length === 0) break;
    await idbBulkPut('bridges', rows);
    total += rows.length;
    onProgress?.(total, 9503);
    if (rows.length < PAGE) break;
    offset += PAGE;
  }
  await idbPut('meta', { key: 'bridges_synced_at', value: new Date().toISOString() });
  await idbPut('meta', { key: 'bridges_count', value: total });
  return total;
}

/** Look up one bridge by Asset ID. Tries cache first, then network. */
export async function findBridge(rawInput: string): Promise<Bridge | null> {
  const q = normalizeAssetId(rawInput);
  const cached = await idbGet<Bridge>('bridges', q);
  if (cached) return cached;
  // Fallback: case-insensitive scan of cache for struct_no matches
  const all = await idbGetAll<Bridge>('bridges');
  const hit = all.find(
    (b) => b.asset_id === q || b.struct_no.replace(/^0+/, '') === q,
  );
  if (hit) return hit;
  if (!isOnline() || !isSupabaseConfigured()) return null;
  const sb = getSupabase()!;
  const { data, error } = await sb
    .from('emg_bridges')
    .select(BRIDGE_SELECT)
    .eq('asset_id', q)
    .limit(1)
    .maybeSingle();
  if (error || !data) return null;
  const b = rowToBridge(data as unknown as Record<string, unknown>);
  await idbPut('bridges', b);
  return b;
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
    .select('id,dist_label,geojson:st_asgeojson(geom)');
  if (error || !data) return [];
  const dists: District[] = (data as Array<Record<string, unknown>>).map((r) => ({
    id: String(r.id),
    dist_label: String(r.dist_label),
    geojson: JSON.parse(r.geojson as string) as GeoJSON.MultiPolygon,
  }));
  await idbBulkPut('districts', dists);
  return dists;
}
