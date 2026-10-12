// DriveNC (NCDOT) secondary data — offline cache (onX Offroad model).
//
// DriveNC is a SECONDARY source. Inspector ground-truth pins always take
// visual precedence on the map. DriveNC events/signs/work zones render
// dimmed underneath.
//
// Data flow (the frontend NEVER calls the DriveNC API directly and never
// holds the API key):
//   1. A backend sync job (scripts/sync-drivedata.mjs, run via cron) calls
//      the drivenc-* CLIs and upserts into Supabase emg_drivedata_* tables.
//   2. This module syncs those tables to IndexedDB when online (same pattern
//      as lib/roadblocks.ts), so the map overlay works fully offline.
//   3. TeamMap renders the cached data dimmed, with layer toggles.

import { getSupabase, isOnline, isSupabaseConfigured } from './supabase';
import { idbBulkPut, idbGet, idbGetAll, idbPut } from './idb';
import type { DriveNCEvent, DriveNCSign, DriveNCWorkZone } from '../types';

const PAGE_SIZE = 1000;

// Min interval between background refreshes (API throttles at 10 calls/60s;
// three feeds = 3 calls per refresh, so 15 min is comfortably safe).
export const DRIVEDATA_REFRESH_MS = 15 * 60 * 1000;

const META_KEYS = {
  events: 'drivedata_events_last_sync',
  signs: 'drivedata_signs_last_sync',
  workzones: 'drivedata_workzones_last_sync',
} as const;

type Feed = keyof typeof META_KEYS;

const TABLES: Record<Feed, string> = {
  events: 'emg_drivedata_events',
  signs: 'emg_drivedata_signs',
  workzones: 'emg_drivedata_workzones',
};

const STORES: Record<Feed, string> = {
  events: 'drivenc_events',
  signs: 'drivenc_signs',
  workzones: 'drivenc_workzones',
};

async function syncFeed<T>(feed: Feed): Promise<number> {
  if (!isOnline() || !isSupabaseConfigured()) return 0;
  const sb = getSupabase();
  if (!sb) return 0;

  let count = 0;
  let page = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { data, error } = await sb
      .from(TABLES[feed])
      .select('*')
      .order('last_updated', { ascending: false })
      .range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1);
    if (error) throw new Error(`DriveNC ${feed} sync failed: ${error.message}`);
    const rows = (data ?? []) as T[];
    if (rows.length === 0) break;
    await idbBulkPut(STORES[feed], rows);
    count += rows.length;
    if (rows.length < PAGE_SIZE) break;
    page++;
  }

  await idbPut('meta', {
    key: META_KEYS[feed],
    value: new Date().toISOString(),
  });
  return count;
}

/**
 * Sync all three DriveNC feeds from Supabase to the local cache.
 * Best-effort: a feed failure throws, but callers should catch per-feed
 * so one bad feed doesn't block the others (see syncDriveNC).
 */
export async function syncDriveNCEvents(): Promise<number> {
  return syncFeed<DriveNCEvent>('events');
}

export async function syncDriveNCSigns(): Promise<number> {
  return syncFeed<DriveNCSign>('signs');
}

export async function syncDriveNCWorkZones(): Promise<number> {
  return syncFeed<DriveNCWorkZone>('workzones');
}

/** Sync all feeds; returns per-feed counts. Never throws (logs instead). */
export async function syncDriveNC(): Promise<{
  events: number;
  signs: number;
  workzones: number;
}> {
  const result = { events: 0, signs: 0, workzones: 0 };
  try {
    result.events = await syncDriveNCEvents();
  } catch (e) {
    console.warn('[drivedata] events sync failed:', e);
  }
  try {
    result.signs = await syncDriveNCSigns();
  } catch (e) {
    console.warn('[drivedata] signs sync failed:', e);
  }
  try {
    result.workzones = await syncDriveNCWorkZones();
  } catch (e) {
    console.warn('[drivedata] workzones sync failed:', e);
  }
  return result;
}

// --- Cache readers (offline-first) -----------------------------------------

export async function getCachedDriveNCEvents(): Promise<DriveNCEvent[]> {
  try {
    return await idbGetAll<DriveNCEvent>('drivenc_events');
  } catch {
    return [];
  }
}

export async function getCachedDriveNCSigns(): Promise<DriveNCSign[]> {
  try {
    return await idbGetAll<DriveNCSign>('drivenc_signs');
  } catch {
    return [];
  }
}

export async function getCachedDriveNCWorkZones(): Promise<DriveNCWorkZone[]> {
  try {
    return await idbGetAll<DriveNCWorkZone>('drivenc_workzones');
  } catch {
    return [];
  }
}

/** Last successful sync timestamp for a feed, or null if never synced. */
export async function getDriveNCLastSync(
  feed: Feed,
): Promise<string | null> {
  try {
    const rec = await idbGet<{ key: string; value: string }>(
      'meta',
      META_KEYS[feed],
    );
    return rec?.value ?? null;
  } catch {
    return null;
  }
}

/** True if any feed was synced within the refresh window. */
export async function isDriveNCFresh(): Promise<boolean> {
  const ts = await getDriveNCLastSync('events');
  if (!ts) return false;
  return Date.now() - new Date(ts).getTime() < DRIVEDATA_REFRESH_MS;
}
