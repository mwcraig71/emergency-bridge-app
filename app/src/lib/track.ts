// GPS track recording (onX Offroad model).
//
// Records the inspector's traveled path as breadcrumb points, displayed as a
// green polyline on the map. Works fully offline: points are persisted to
// IndexedDB as they're captured (crash-safe), and completed tracks are queued
// for sync to emg_path_tracks when online.
//
// Sampling: a point is recorded every 10 seconds OR every 50 meters,
// whichever comes first. This balances breadcrumb fidelity against battery.
import { watchGps, type GpsFix } from './location';
import { haversineMeters } from './geo';
import { idbGet, idbPut, idbGetAll, idbDelete } from './idb';
import { enqueue } from './sync';
import type { PathTrack } from '../types';

const SAMPLE_INTERVAL_MS = 10_000;
const SAMPLE_DISTANCE_M = 50;
const ACTIVE_TRACK_KEY = 'active_track';

export interface TrackPoint {
  lat: number;
  lon: number;
  accuracy: number | null;
  timestamp: number;
}

export interface ActiveTrack {
  id: string;
  inspector: string;
  started_at: string;
  points: TrackPoint[];
}

interface TrackerState {
  unsubscribe: (() => void) | null;
  lastSampleTime: number;
  lastSamplePoint: TrackPoint | null;
  paused: boolean;
}

const state: TrackerState = {
  unsubscribe: null,
  lastSampleTime: 0,
  lastSamplePoint: null,
  paused: false,
};

function newTrackId(): string {
  // UUID to match the emg_path_tracks.id uuid column.
  try {
    return crypto.randomUUID();
  } catch {
    return `track-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }
}

/** Whether a track is currently being recorded. */
export function isTracking(): boolean {
  return state.unsubscribe !== null;
}

/** Whether tracking is paused (recorder alive but not sampling). */
export function isPaused(): boolean {
  return state.paused;
}

/**
 * Start recording a GPS track for the given inspector.
 * If a track is already active (e.g. after a crash), it is resumed.
 * Safe to call multiple times — only one recorder runs.
 */
export async function startTracking(inspector: string): Promise<void> {
  if (state.unsubscribe) return; // already recording

  const name = inspector.trim();
  if (!name) return;

  // Resume an interrupted track if one exists for this inspector.
  let active = await getActiveTrack().catch(() => undefined);
  if (active && active.inspector.toLowerCase() !== name.toLowerCase()) {
    // Different inspector — finalize the old track first.
    await stopTracking().catch(() => {});
    active = undefined;
  }
  if (!active) {
    active = {
      id: newTrackId(),
      inspector: name,
      started_at: new Date().toISOString(),
      points: [],
    };
    await idbPut('meta', { key: ACTIVE_TRACK_KEY, value: active });
  }

  state.lastSampleTime = 0;
  state.lastSamplePoint =
    active.points.length > 0 ? active.points[active.points.length - 1] : null;
  state.paused = false;

  try {
    state.unsubscribe = watchGps(
      (fix) => void onFix(fix, active!),
      () => {
        // GPS error — keep the recorder alive; points resume when fixes return.
      },
    );
  } catch {
    // Geolocation unavailable — nothing to record. Not fatal.
    state.unsubscribe = null;
  }
}

/** Pause sampling without ending the track. */
export function pauseTracking(): void {
  state.paused = true;
}

/** Resume sampling after a pause. */
export function resumeTracking(): void {
  state.paused = false;
  state.lastSampleTime = 0; // force a sample on next fix
}

async function onFix(fix: GpsFix, active: ActiveTrack): Promise<void> {
  if (state.paused) return;
  const now = Date.now();
  const point: TrackPoint = {
    lat: fix.lat,
    lon: fix.lon,
    accuracy: fix.accuracy,
    timestamp: fix.timestamp,
  };

  const timeElapsed = now - state.lastSampleTime >= SAMPLE_INTERVAL_MS;
  const distMoved =
    state.lastSamplePoint === null ||
    haversineMeters(
      state.lastSamplePoint.lat,
      state.lastSamplePoint.lon,
      point.lat,
      point.lon,
    ) >= SAMPLE_DISTANCE_M;

  if (!timeElapsed && !distMoved) return;

  // Re-read the active track (it may have been updated by another tab).
  const current = await getActiveTrack().catch(() => undefined);
  const target = current ?? active;
  target.points.push(point);
  await idbPut('meta', { key: ACTIVE_TRACK_KEY, value: target }).catch(
    () => {},
  );
  state.lastSampleTime = now;
  state.lastSamplePoint = point;
}

/**
 * Stop recording. The completed track is saved to the tracks store and
 * queued for sync. Returns the finalized track, or null if none was active.
 */
export async function stopTracking(): Promise<PathTrack | null> {
  if (state.unsubscribe) {
    state.unsubscribe();
    state.unsubscribe = null;
  }
  state.paused = false;

  const active = await getActiveTrack().catch(() => undefined);
  await idbDelete('meta', ACTIVE_TRACK_KEY).catch(() => {});
  if (!active || active.points.length === 0) return null;

  const track: PathTrack = {
    id: active.id,
    inspector: active.inspector,
    geojson: {
      type: 'LineString',
      coordinates: active.points.map((p) => [p.lon, p.lat]),
    },
    started_at: active.started_at,
    ended_at: new Date().toISOString(),
  };
  await idbPut('tracks', track);
  // Queue for upload — the 'track' handler in sync.ts pushes to emg_path_tracks.
  await enqueue('track', track).catch(() => {});
  return track;
}

/** The in-progress track, if any. */
export async function getActiveTrack(): Promise<ActiveTrack | undefined> {
  try {
    const rec = await idbGet<{ key: string; value: ActiveTrack }>(
      'meta',
      ACTIVE_TRACK_KEY,
    );
    return rec?.value;
  } catch {
    return undefined;
  }
}

/** All completed tracks (newest first). Works offline. */
export async function getTrackHistory(): Promise<PathTrack[]> {
  try {
    const all = await idbGetAll<PathTrack>('tracks');
    all.sort((a, b) => (b.started_at ?? '').localeCompare(a.started_at ?? ''));
    return all;
  } catch {
    return [];
  }
}

/** Total distance of the active track in meters. */
export async function getActiveTrackDistance(): Promise<number> {
  const active = await getActiveTrack().catch(() => undefined);
  if (!active || active.points.length < 2) return 0;
  let meters = 0;
  for (let i = 1; i < active.points.length; i++) {
    meters += haversineMeters(
      active.points[i - 1].lat,
      active.points[i - 1].lon,
      active.points[i].lat,
      active.points[i].lon,
    );
  }
  return meters;
}

/** Elapsed time of the active track in milliseconds. */
export async function getActiveTrackElapsed(): Promise<number> {
  const active = await getActiveTrack().catch(() => undefined);
  if (!active) return 0;
  return Date.now() - Date.parse(active.started_at);
}
