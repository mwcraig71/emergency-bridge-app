// Live team position sharing.
//
// Broadcasts the inspector's GPS position to emg_team_positions every
// 30 seconds (when online and the inspector name is set), and fetches
// teammates' positions for the team map.
//
// Battery-conscious by design:
//   * 30s broadcast interval
//   * 10m movement threshold — no broadcast when stationary
//   * Pauses when the page is hidden (background)
//
// Privacy: positions are scoped to the inspector's firm. When no firm is
// set (current field flow), no firm filter is applied and the broadcast
// carries firm_id = null.
import { getSupabase, isOnline, isSupabaseConfigured } from './supabase';
import { getGpsFix } from './location';
import { haversineMeters } from './geo';
import { idbGet } from './idb';
import { getCurrentFirmId } from './firm';

export const TEAM_POSITION_STALE_MS = 15 * 60 * 1000;
const BROADCAST_INTERVAL_MS = 30_000;
const MOVEMENT_THRESHOLD_M = 10;

export interface LiveTeamPosition {
  inspector_id: string;
  inspector_name: string;
  lon: number;
  lat: number;
  heading: number | null;
  speed: number | null;
  updated_at: string;
  firm_id: string | null;
  /** True when this row belongs to the current device. */
  is_self?: boolean;
  /** True when updated_at is older than TEAM_POSITION_STALE_MS. */
  stale?: boolean;
}

interface BroadcastState {
  timer: ReturnType<typeof setInterval> | null;
  lastBroadcast: { lat: number; lon: number } | null;
  inspectorId: string | null;
  inspectorName: string | null;
  running: boolean;
}

const state: BroadcastState = {
  timer: null,
  lastBroadcast: null,
  inspectorId: null,
  inspectorName: null,
  running: false,
};

/**
 * Stable device-scoped inspector id derived from the inspector name.
 * The field app identifies inspectors by name (settings.inspector_name);
 * this slug keeps the id stable across app restarts for the same name.
 */
export function inspectorIdForName(name: string): string {
  return (
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'inspector'
  );
}

/** Inspector display name from settings, or null when not set ("logged in"). */
export async function getInspectorName(): Promise<string | null> {
  try {
    const rec = (await idbGet('settings', 'inspector_name')) as
      | { value?: string }
      | undefined;
    const v = rec?.value?.trim();
    return v ? v : null;
  } catch {
    return null;
  }
}

/** Whether a position timestamp is stale (> 15 min old). */
export function isPositionStale(updatedAt: string | null | undefined): boolean {
  if (!updatedAt) return true;
  const t = Date.parse(updatedAt);
  if (Number.isNaN(t)) return true;
  return Date.now() - t > TEAM_POSITION_STALE_MS;
}

async function broadcastOnce(): Promise<void> {
  if (!state.inspectorId || !state.inspectorName) return;
  if (!isOnline() || !isSupabaseConfigured()) return;
  // Battery saving: don't broadcast from a backgrounded page.
  if (typeof document !== 'undefined' && document.hidden) return;

  let fix;
  try {
    fix = await getGpsFix();
  } catch {
    return; // GPS unavailable — skip this cycle, try again next tick.
  }

  // Movement throttle: skip when the inspector hasn't moved 10m.
  if (state.lastBroadcast) {
    const moved = haversineMeters(
      state.lastBroadcast.lat,
      state.lastBroadcast.lon,
      fix.lat,
      fix.lon,
    );
    if (moved < MOVEMENT_THRESHOLD_M) return;
  }

  const sb = getSupabase();
  if (!sb) return;

  const firmId = getCurrentFirmId();
  const { error } = await sb.from('emg_team_positions').upsert(
    {
      // Legacy PK column (migration 001) — keep it in sync.
      inspector: state.inspectorId,
      inspector_id: state.inspectorId,
      inspector_name: state.inspectorName,
      geom: `SRID=4326;POINT(${fix.lon} ${fix.lat})`,
      heading: null,
      speed: null,
      firm_id: firmId,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'inspector' },
  );
  if (error) {
    // Swallow — the next 30s tick retries. Never crash the field app
    // over a position broadcast.
    return;
  }
  state.lastBroadcast = { lat: fix.lat, lon: fix.lon };
}

function onVisibilityChange(): void {
  if (typeof document === 'undefined') return;
  // When hidden, skip broadcasts (broadcastOnce checks document.hidden).
  // When visible again, reset the movement baseline so the first tick
  // after returning to foreground always broadcasts a fresh position.
  if (!document.hidden) state.lastBroadcast = null;
}

/**
 * Start broadcasting this inspector's position every 30 seconds.
 * No-op when the inspector name isn't set or broadcasting already runs.
 * Safe to call repeatedly.
 */
export async function startPositionBroadcast(): Promise<void> {
  if (state.running) return;
  const name = await getInspectorName();
  if (!name) return;
  state.inspectorName = name;
  state.inspectorId = inspectorIdForName(name);
  state.running = true;
  state.lastBroadcast = null;

  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', onVisibilityChange);
  }
  // Broadcast immediately on start, then on the 30s cadence.
  void broadcastOnce();
  state.timer = setInterval(() => {
    void broadcastOnce();
  }, BROADCAST_INTERVAL_MS);
}

/** Stop broadcasting. Safe to call when not running. */
export function stopPositionBroadcast(): void {
  if (state.timer) {
    clearInterval(state.timer);
    state.timer = null;
  }
  if (typeof document !== 'undefined') {
    document.removeEventListener('visibilitychange', onVisibilityChange);
  }
  state.running = false;
  state.lastBroadcast = null;
  state.inspectorId = null;
  state.inspectorName = null;
}

/** Whether the broadcaster is currently running. */
export function isBroadcasting(): boolean {
  return state.running;
}

/** This device's inspector id, or null when broadcasting isn't running. */
export function getOwnInspectorId(): string | null {
  return state.inspectorId;
}

/**
 * Fetch teammates' live positions, scoped to the inspector's firm when set.
 * Each row is annotated with is_self and stale. Never throws — returns []
 * offline or on error.
 */
export async function fetchTeamPositions(): Promise<LiveTeamPosition[]> {
  const sb = getSupabase();
  if (!sb || !isSupabaseConfigured() || !isOnline()) return [];
  try {
    let query = sb
      .from('emg_team_positions')
      .select(
        'inspector_id,inspector_name,lon,lat,heading,speed,updated_at,firm_id',
      )
      .order('updated_at', { ascending: false })
      .limit(200);
    const firmId = getCurrentFirmId();
    if (firmId) query = query.eq('firm_id', firmId);
    const { data, error } = await query;
    if (error || !Array.isArray(data)) return [];
    const ownId = state.inspectorId;
    return (data as unknown as LiveTeamPosition[])
      .filter(
        (r) =>
          typeof r?.lat === 'number' &&
          typeof r?.lon === 'number' &&
          Number.isFinite(r.lat) &&
          Number.isFinite(r.lon),
      )
      .map((r) => ({
        ...r,
        is_self: ownId != null && r.inspector_id === ownId,
        stale: isPositionStale(r.updated_at),
      }));
  } catch {
    return [];
  }
}
