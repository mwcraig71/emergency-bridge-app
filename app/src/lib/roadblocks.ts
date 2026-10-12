// Offline roadblock cache (onX Offroad model).
//
// Roadblocks are synced from Supabase to IndexedDB when online, then read
// from the local cache first so closure pins are visible on the map without
// network. The cache is refreshed in the background whenever online.
import { getSupabase, isOnline, isSupabaseConfigured } from './supabase';
import { idbBulkPut, idbGet, idbGetAll, idbPut } from './idb';
import type { Roadblock } from '../types';

const PAGE_SIZE = 1000;
const META_KEY = 'roadblocks_last_sync';

/** Fetch all roadblocks from Supabase and upsert to the local cache. */
export async function syncRoadblocks(): Promise<number> {
  if (!isOnline() || !isSupabaseConfigured()) return 0;
  const sb = getSupabase();
  if (!sb) return 0;

  let count = 0;
  let page = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { data, error } = await sb
      .from('emg_roadblocks')
      .select('*')
      .order('reported_at', { ascending: false })
      .range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1);
    if (error) throw new Error(`Roadblock sync failed: ${error.message}`);
    const rows = (data ?? []) as Roadblock[];
    if (rows.length === 0) break;
    await idbBulkPut('roadblocks', rows);
    count += rows.length;
    if (rows.length < PAGE_SIZE) break;
    page++;
  }

  // Record sync timestamp for "last updated" display.
  await idbPut('meta', {
    key: META_KEY,
    value: new Date().toISOString(),
  });
  return count;
}

/** Get all cached roadblocks (works offline). */
export async function getCachedRoadblocks(): Promise<Roadblock[]> {
  try {
    const all = await idbGetAll<Roadblock>('roadblocks');
    // Sort by reported_at descending (newest first).
    all.sort((a, b) => (b.reported_at ?? '').localeCompare(a.reported_at ?? ''));
    return all;
  } catch {
    return [];
  }
}

/** Get the last successful sync timestamp, or null if never synced. */
export async function getRoadblocksLastSync(): Promise<string | null> {
  try {
    const rec = await idbGet<{ key: string; value: string }>('meta', META_KEY);
    return rec?.value ?? null;
  } catch {
    return null;
  }
}

/** Upsert a single roadblock to the cache (e.g. after local report). */
export async function cacheRoadblock(rb: Roadblock): Promise<void> {
  await idbPut('roadblocks', rb);
}
