import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ClosureType, Roadblock, SyncQueueItem, RoadblockPhoto, RoadblockPhotoQueuePayload } from '../types';
import { getGpsFix } from '../lib/location';
import { capturePhoto } from '../lib/camera';
import { idbPut, idbGetAll } from '../lib/idb';
import { enqueue, pushRoadblockPhoto, isUuid } from '../lib/sync';
import { getSupabase, isOnline, isSupabaseConfigured } from '../lib/supabase';

type Props = {
  inspectorName: string;
  onDone: () => void;
};

type GpsState = {
  lat: number;
  lon: number;
  accuracy: number;
} | null;

type PhotoState = {
  dataUrl: string;
  takenAt: string;
} | null;

/** A roadblock closure photo — shared type lives in types.ts. Photos are
 *  stored locally in the IndexedDB `photos` store and synced to the
 *  emg-photos bucket + emg_roadblock_photos table when online. */

type PhotoSaveState = 'idle' | 'saved' | 'failed';

type Status = 'idle' | 'submitting' | 'success';

const CLOSURE_OPTIONS: Array<{ value: ClosureType; label: string; hint: string }> = [
  { value: 'fully_closed', label: 'Fully closed', hint: 'No vehicles can pass' },
  { value: 'limited_traffic', label: 'Limited traffic', hint: 'Restricted access' },
  { value: 'emergency_only', label: 'Passable for emergency vehicles', hint: 'Emergency access only' },
];

function closureLabel(c: ClosureType | string): string {
  switch (c) {
    case 'fully_closed':
      return 'Fully closed';
    case 'limited_traffic':
      return 'Limited traffic';
    case 'emergency_only':
      return 'Passable for emergency vehicles';
    default:
      return String(c);
  }
}

function isStaleActive(rb: Roadblock): boolean {
  if (rb.status !== 'active') return false;
  const t = Date.parse(rb.reported_at);
  if (!Number.isFinite(t)) return false;
  return Date.now() - t > 12 * 60 * 60 * 1000;
}

/** UUID with a Math.random fallback — crypto.randomUUID() throws in
 *  non-secure contexts, and a throw there must never leave the submit
 *  button stuck on "Submitting…". */
function newReportId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
  } catch {
    // fall through to the fallback below
  }
  return `rb-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function formatDate(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  try {
    return new Date(t).toLocaleString();
  } catch {
    return iso;
  }
}

export default function RoadblockReport({ inspectorName, onDone }: Props): React.JSX.Element {
  const [roadName, setRoadName] = useState<string>('');
  const [closureType, setClosureType] = useState<ClosureType>('fully_closed');
  const [notes, setNotes] = useState<string>('');
  const [gps, setGps] = useState<GpsState>(null);
  const [gpsLoading, setGpsLoading] = useState<boolean>(false);
  const [gpsError, setGpsError] = useState<string | null>(null);
  const [photo, setPhoto] = useState<PhotoState>(null);
  const [photoSave, setPhotoSave] = useState<PhotoSaveState>('idle');
  const [photoError, setPhotoError] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>('idle');
  const [submitError, setSubmitError] = useState<string | null>(null);

  const [existing, setExisting] = useState<Roadblock[]>([]);
  const [existingError, setExistingError] = useState<string | null>(null);
  const [queued, setQueued] = useState<Roadblock[]>([]);
  const [lastSync, setLastSync] = useState<string | null>(null);
  const [photoMap, setPhotoMap] = useState<Record<string, string>>({});
  // Server-side photo URLs (signed URLs from the emg-photos bucket), keyed
  // by roadblock id. Local IndexedDB photos take precedence when present.
  const [serverPhotoMap, setServerPhotoMap] = useState<Record<string, string>>({});
  // Outcome of the just-submitted photo: synced now, queued for later, or
  // local-only (e.g. sync not configured).
  const [photoSync, setPhotoSync] = useState<'synced' | 'queued' | 'local' | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  /** Resolve the best photo for a roadblock: local IndexedDB copy first
   *  (works offline), server signed URL as fallback (e.g. another device). */
  const photoSrcFor = useCallback(
    (roadblockId: string): string | null =>
      photoMap[roadblockId] ?? serverPhotoMap[roadblockId] ?? null,
    [photoMap, serverPhotoMap]
  );

  // Reactive online state: recompute on browser online/offline events, not
  // just when the submit status changes (a stale snapshot would queue when
  // the device just came back online, or attempt a doomed direct insert).
  const [online, setOnline] = useState<boolean>(() => isOnline());
  const configured = useMemo(() => isSupabaseConfigured(), []);

  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    setOnline(isOnline());
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);


  /** Load server-side closure photos for the given roadblock ids and
   *  resolve signed URLs from the private emg-photos bucket. Local
   *  IndexedDB photos take display precedence; these fill the gaps
   *  (e.g. photos taken on another device). Best-effort — never throws. */
  const loadServerPhotos = useCallback(
    async (roadblockIds: string[]) => {
      if (!online || !configured || roadblockIds.length === 0) return;
      try {
        const sb = getSupabase();
        if (!sb) return;
        const { data, error } = await sb
          .from('emg_roadblock_photos')
          .select('roadblock_id, storage_path')
          .in('roadblock_id', roadblockIds);
        if (error || !data) return;
        const map: Record<string, string> = {};
        for (const row of data as Array<{
          roadblock_id: string;
          storage_path: string;
        }>) {
          if (!row.storage_path || map[row.roadblock_id]) continue;
          try {
            const { data: urlData } = await sb.storage
              .from('emg-photos')
              .createSignedUrl(row.storage_path, 3600);
            if (urlData?.signedUrl) map[row.roadblock_id] = urlData.signedUrl;
          } catch {
            // One bad URL must not block the rest.
          }
        }
        setServerPhotoMap(map);
      } catch {
        // Best-effort: local photos (if any) still display.
      }
    },
    [online, configured]
  );

  const loadExisting = useCallback(async () => {
    setExistingError(null);
    // 1. Read from local cache FIRST — instant, works offline (onX model).
    try {
      const { getCachedRoadblocks, getRoadblocksLastSync } = await import(
        '../lib/roadblocks'
      );
      const cached = await getCachedRoadblocks();
      setExisting(cached.slice(0, 50));
      const ts = await getRoadblocksLastSync();
      setLastSync(ts);
    } catch {
      // Cache read failed — continue to network attempt below.
    }

    // 2. If online, refresh from Supabase in the background and update cache.
    if (online && configured) {
      try {
        const { syncRoadblocks, getCachedRoadblocks, getRoadblocksLastSync } =
          await import('../lib/roadblocks');
        await syncRoadblocks();
        const refreshed = await getCachedRoadblocks();
        setExisting(refreshed.slice(0, 50));
        const ts = await getRoadblocksLastSync();
        setLastSync(ts);
        // Fetch server-side closure photos for the visible roadblocks.
        // Signed URLs (bucket is private); best-effort, never blocks the list.
        void loadServerPhotos(refreshed.slice(0, 50).map((r) => r.id));
      } catch (err) {
        // Network refresh failed — cached data (if any) is already shown.
        // Only show error if we have no cached data at all.
        setExisting((prev) => {
          if (prev.length === 0) {
            setExistingError(
              err instanceof Error ? err.message : 'Failed to load'
            );
          }
          return prev;
        });
      }
    }

    // Queued (unsynced) roadblocks from the sync queue.
    try {
      const items = await idbGetAll<SyncQueueItem>('syncQueue');
      const roadblocks = Array.isArray(items)
        ? items
            .filter((i) => i && i.kind === 'roadblock')
            .map((i) => i.payload)
            .filter(
              (p): p is Roadblock =>
                !!p && typeof (p as Roadblock).id === 'string'
            )
        : [];
      setQueued(roadblocks);
    } catch {
      setQueued([]);
    }
    // Roadblock photos: local IndexedDB copies are available in every list
    // view, online or offline. Server copies (from other devices) are
    // merged in via loadServerPhotos above; local takes precedence.
    try {
      const photos = await idbGetAll<RoadblockPhoto>('photos');
      const map: Record<string, string> = {};
      if (Array.isArray(photos)) {
        for (const p of photos) {
          if (p && p.roadblockId && p.dataUrl) map[p.roadblockId] = p.dataUrl;
        }
      }
      setPhotoMap(map);
    } catch {
      setPhotoMap({});
    }
  }, [online, configured, loadServerPhotos]);

  useEffect(() => {
    void loadExisting();
  }, [loadExisting]);

  const handleCaptureGps = useCallback(async () => {
    setGpsLoading(true);
    setGpsError(null);
    try {
      const fix = await getGpsFix();
      setGps({ lat: fix.lat, lon: fix.lon, accuracy: fix.accuracy ?? 0 });
    } catch (err) {
      const code = (err as { code?: number } | null)?.code;
      setGpsError(
        code === 1
          ? 'GPS permission denied. Enable location access in Settings.'
          : err instanceof Error
            ? err.message
            : 'GPS failed'
      );
    } finally {
      setGpsLoading(false);
    }
  }, []);

  const handleCapturePhoto = useCallback(async () => {
    try {
      const captured = await capturePhoto();
      setPhoto({ dataUrl: captured.dataUrl, takenAt: captured.takenAt });
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'Photo failed');
    }
  }, []);

  const canSubmit =
    roadName.trim().length > 0 && gps !== null && status !== 'submitting' && status !== 'success';

  const handleSubmit = useCallback(async () => {
    if (!gps) {
      setSubmitError('Capture GPS location of the closure first.');
      return;
    }
    if (!roadName.trim()) {
      setSubmitError('Road name is required.');
      return;
    }
    setSubmitError(null);
    setPhotoSave('idle');
    setPhotoError(null);
    setPhotoSync(null);
    setStatus('submitting');

    try {
      // ID generation lives inside the try: crypto.randomUUID() can throw in
      // non-secure contexts, and the catch below resets status to 'idle' so
      // the UI always reaches a terminal state.
      const id = newReportId();
      const reported_at = new Date().toISOString();
      const roadblock: Roadblock = {
        id,
        road_name: roadName.trim(),
        closure_type: closureType,
        status: 'active',
        lat: gps.lat,
        lon: gps.lon,
        notes: notes.trim() || null,
        reporter: inspectorName,
        reported_at,
      };
      // Server-side id for the photo FK. When the client id isn't a valid
      // uuid (non-secure-context fallback), the server generates one and we
      // read it back.
      let serverRoadblockId: string | null = null;

      if (online && configured) {
        const sb = getSupabase();
        if (!sb) throw new Error('Supabase not configured');
        const payload: Record<string, unknown> = {
          road_name: roadblock.road_name,
          closure_type: roadblock.closure_type,
          status: roadblock.status,
          notes: roadblock.notes,
          reporter: roadblock.reporter,
          reported_at: roadblock.reported_at,
          geom: `SRID=4326;POINT(${gps.lon} ${gps.lat})`,
        };
        if (isUuid(id)) payload.id = id;
        const { data: inserted, error } = await sb
          .from('emg_roadblocks')
          .insert(payload)
          .select('id')
          .maybeSingle();
        if (error) throw new Error(error.message);
        serverRoadblockId =
          (inserted as { id: string } | null)?.id ?? (isUuid(id) ? id : null);
      } else {
        await enqueue('roadblock', {
          id: roadblock.id,
          road_name: roadblock.road_name,
          closure_type: roadblock.closure_type,
          status: roadblock.status,
          lat: roadblock.lat,
          lon: roadblock.lon,
          notes: roadblock.notes,
          reporter: roadblock.reporter,
          reported_at: roadblock.reported_at,
        });
        serverRoadblockId = isUuid(id) ? id : null;
      }

      // Persist the closure photo locally first (crash-safe), then sync it.
      // A photo failure never fails the roadblock report itself.
      if (photo) {
        const localPhoto: RoadblockPhoto = {
          id: `${id}-photo`,
          roadblockId: id,
          dataUrl: photo.dataUrl,
          takenAt: photo.takenAt,
          createdAt: reported_at,
        };
        let savedLocally = false;
        try {
          await idbPut('photos', localPhoto);
          setPhotoSave('saved');
          setPhotoError(null);
          savedLocally = true;
        } catch (err) {
          setPhotoSave('failed');
          setPhotoError(
            err instanceof Error ? err.message : 'Photo could not be stored on this device'
          );
        }
        // Sync the photo when we have a server roadblock id to attach it to.
        if (savedLocally && serverRoadblockId && online && configured) {
          try {
            const sb = getSupabase();
            if (!sb) throw new Error('Supabase not configured');
            await pushRoadblockPhoto(sb, serverRoadblockId, localPhoto);
            setPhotoSync('synced');
          } catch {
            // Upload failed — queue for retry on the next sync.
            try {
              await enqueue('roadblock_photo', {
                roadblock_id: serverRoadblockId,
                photo_id: localPhoto.id,
                inspector: inspectorName,
              } satisfies RoadblockPhotoQueuePayload);
              setPhotoSync('queued');
            } catch {
              setPhotoSync('local');
            }
          }
        } else if (savedLocally && serverRoadblockId) {
          // Offline (or sync not configured): queue the photo for later.
          try {
            await enqueue('roadblock_photo', {
              roadblock_id: serverRoadblockId,
              photo_id: localPhoto.id,
              inspector: inspectorName,
            } satisfies RoadblockPhotoQueuePayload);
            setPhotoSync('queued');
          } catch {
            setPhotoSync('local');
          }
        } else if (savedLocally) {
          setPhotoSync('local');
        }
      } else {
        setPhotoSave('idle');
        setPhotoError(null);
      }

      setStatus('success');
      // Cache the new roadblock locally so it appears on the map immediately,
      // even before the next server sync.
      try {
        const { cacheRoadblock } = await import('../lib/roadblocks');
        await cacheRoadblock(roadblock);
      } catch {
        // Non-fatal: loadExisting() below will refresh from whatever cache exists.
      }
      void loadExisting();
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'Submit failed');
      setStatus('idle');
    }
  }, [gps, roadName, closureType, notes, inspectorName, online, configured, photo, loadExisting]);

  const handleReopen = useCallback(
    async (rb: Roadblock) => {
      if (!online || !configured) {
        setSubmitError(
          'Offline — reopen will sync when online. Please retry from a connected device.'
        );
        return;
      }
      const sb = getSupabase();
      if (!sb) {
        setSubmitError('Supabase not configured');
        return;
      }
      try {
        const { error } = await sb
          .from('emg_roadblocks')
          .update({ status: 'reopened', reopened_at: new Date().toISOString() })
          .eq('id', rb.id);
        if (error) {
          setSubmitError(error.message);
          return;
        }
        setExisting((prev) =>
          prev.map((r) => (r.id === rb.id ? { ...r, status: 'reopened' } : r))
        );
        // Update the local cache so the map reflects the reopen offline.
        try {
          const { cacheRoadblock } = await import('../lib/roadblocks');
          await cacheRoadblock({
            ...rb,
            status: 'reopened',
            reopened_at: new Date().toISOString(),
          });
        } catch {
          // Non-fatal: cache will refresh on next sync.
        }
      } catch (err) {
        setSubmitError(err instanceof Error ? err.message : 'Reopen failed');
      }
    },
    [online, configured]
  );

  if (status === 'success') {
    return (
      <div className="screen">
        <div className="card">
          <h2>Road closure reported</h2>
          <p className="muted">
            {online && configured
              ? 'Synced to server.'
              : 'Saved offline — will sync when connectivity returns.'}
          </p>
          {photo ? (
            photoSave === 'failed' ? (
              <div className="warn-box">
                <strong>Photo not saved.</strong>{' '}
                {photoError ?? 'The closure photo could not be stored on this device.'}{' '}
                The report itself was submitted — keep the photo in your camera
                app as a backup.
              </div>
            ) : photoSave === 'saved' ? (
              <p className="muted">
                {photoSync === 'synced'
                  ? 'Photo synced to server.'
                  : photoSync === 'queued'
                    ? 'Photo saved on this device — will upload when connectivity returns.'
                    : 'Photo saved on this device.'}
              </p>
            ) : null
          ) : null}
          <button className="btn" type="button" onClick={onDone}>
            Done
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="screen">
      <div className="card">
        <h2>Report road closure</h2>

        <label className="field">
          <span>Which road was closed?</span>
          <input
            type="text"
            value={roadName}
            onChange={(e) => setRoadName(e.target.value)}
            placeholder="Road name / route number"
          />
        </label>

        <div className="field">
          <span>GPS point of closure</span>
          <button
            className="btn"
            type="button"
            onClick={() => void handleCaptureGps()}
            disabled={gpsLoading}
          >
            {gpsLoading ? 'Locating…' : gps ? 'Recapture GPS' : 'Capture GPS'}
          </button>
          {gps ? (
            <p className="muted">
              {gps.lat.toFixed(5)}, {gps.lon.toFixed(5)} · ±{Math.round(gps.accuracy)} m
            </p>
          ) : (
            <p className="muted">Not captured yet</p>
          )}
          {gpsError ? <div className="warn-box">{gpsError}</div> : null}
        </div>

        <div className="field">
          <span>Closure type</span>
          <div className="choice" role="radiogroup" aria-label="Closure type">
            {CLOSURE_OPTIONS.map((opt) => (
              <label key={opt.value} className={`choice ${closureType === opt.value ? 'selected' : ''}`}>
                <input
                  type="radio"
                  name="closure"
                  value={opt.value}
                  checked={closureType === opt.value}
                  onChange={() => setClosureType(opt.value)}
                />
                <span>
                  <strong>{opt.label}</strong>
                  <span className="muted"> — {opt.hint}</span>
                </span>
              </label>
            ))}
          </div>
        </div>

        <label className="field">
          <span>Notes (optional)</span>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={3}
            placeholder="Details, landmarks, access instructions…"
          />
        </label>

        <div className="field">
          <span>Photo (optional)</span>
          <button className="btn" type="button" onClick={() => void handleCapturePhoto()}>
            {photo ? 'Retake photo' : 'Capture photo'}
          </button>
          {photo ? (
            <div style={{ marginTop: 8 }}>
              <img
                src={photo.dataUrl}
                alt="Closure thumbnail"
                style={{ maxWidth: 160, borderRadius: 6 }}
              />
            </div>
          ) : null}
        </div>

        {submitError ? <div className="warn-box">{submitError}</div> : null}

        <button
          className="btn"
          type="button"
          disabled={!canSubmit}
          onClick={() => void handleSubmit()}
        >
          {status === 'submitting' ? 'Submitting…' : 'Submit report'}
        </button>
      </div>

      <div className="card">
        <h3>Existing roadblocks</h3>
        {lastSync ? (
          <p className="muted" style={{ fontSize: 12, marginTop: -8 }}>
            Last updated:{' '}
            {new Date(lastSync).toLocaleString()}
            {!online ? ' (offline — showing cached)' : ''}
          </p>
        ) : !online ? (
          <p className="muted" style={{ fontSize: 12, marginTop: -8 }}>
            Offline — showing cached roadblocks
          </p>
        ) : null}
        {existingError ? (
          <div className="warn-box">{existingError}</div>
        ) : existing.length === 0 ? (
          <p className="muted">No roadblocks reported.</p>
        ) : (
          <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
            {existing.map((rb) => {
                const active = rb.status === 'active';
                const stale = isStaleActive(rb);
                const expanded = expandedId === rb.id;
                return (
                  <li
                    key={rb.id}
                    style={{
                      borderBottom: '1px solid #eee',
                      padding: '8px 0',
                      cursor: 'pointer',
                    }}
                    onClick={() => setExpandedId(expanded ? null : rb.id)}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <strong style={{ flex: 1 }}>{rb.road_name}</strong>
                      <span className={`pill ${active ? 'pill-danger' : 'pill-ok'}`}>
                        {active ? 'CLOSED' : 'REOPENED'}
                      </span>
                      {stale ? <span className="pill pill-warn">verify</span> : null}
                    </div>
                    <div className="muted" style={{ fontSize: 12 }}>
                      {closureLabel(rb.closure_type)} · {rb.reporter} · {formatDate(rb.reported_at)}
                    </div>
                    {expanded ? (
                      <div style={{ marginTop: 8 }}>
                        {photoSrcFor(rb.id) ? (
                          <img
                            src={photoSrcFor(rb.id) as string}
                            alt="Closure photo"
                            style={{ maxWidth: 160, borderRadius: 6, marginBottom: 8 }}
                          />
                        ) : null}
                        {rb.notes ? <p>{rb.notes}</p> : <p className="muted">No notes.</p>}
                        {active ? (
                          <button
                            className="btn"
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              void handleReopen(rb);
                            }}
                          >
                            Mark reopened
                          </button>
                        ) : null}
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        {queued.length > 0 ? (
          <>
            <h4 style={{ marginTop: 16 }}>Pending sync</h4>
            <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
              {queued.map((rb) => (
              <li
                key={rb.id}
                style={{ borderBottom: '1px solid #eee', padding: '8px 0' }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <strong style={{ flex: 1 }}>{rb.road_name}</strong>
                  <span className="pill pill-warn">queued</span>
                </div>
                <div className="muted" style={{ fontSize: 12 }}>
                  {closureLabel(rb.closure_type)} · {rb.reporter} · {formatDate(rb.reported_at)}
                </div>
                {photoSrcFor(rb.id) ? (
                  <img
                    src={photoSrcFor(rb.id) as string}
                    alt="Closure photo"
                    style={{ maxWidth: 160, borderRadius: 6, marginTop: 8 }}
                  />
                ) : null}
              </li>
              ))}
            </ul>
          </>
        ) : null}
      </div>

      <div className="card">
        <button className="btn" type="button" onClick={onDone}>
          Back
        </button>
      </div>
    </div>
  );
}
