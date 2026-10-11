import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ClosureType, Roadblock } from '../types';
import { getGpsFix } from '../lib/location';
import { capturePhoto } from '../lib/camera';
import { idbPut, idbGetAll } from '../lib/idb';
import { enqueue } from '../lib/sync';
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
  const [status, setStatus] = useState<Status>('idle');
  const [submitError, setSubmitError] = useState<string | null>(null);

  const [existing, setExisting] = useState<Roadblock[]>([]);
  const [existingError, setExistingError] = useState<string | null>(null);
  const [queuedCount, setQueuedCount] = useState<number | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const online = useMemo(() => isOnline(), [status]);
  const configured = useMemo(() => isSupabaseConfigured(), []);


  const loadExisting = useCallback(async () => {
    setExistingError(null);
    if (online && configured) {
      const sb = getSupabase();
      if (!sb) {
        setExistingError('Supabase not configured');
        return;
      }
      try {
        const { data, error } = await sb
          .from('emg_roadblocks')
          .select('*')
          .order('reported_at', { ascending: false })
          .limit(50);
        if (error) {
          setExistingError(error.message);
          return;
        }
        const rows = (data ?? []) as Roadblock[];
        setExisting(rows);
      } catch (err) {
        setExistingError(err instanceof Error ? err.message : 'Failed to load');
      }
    } else {
      setExisting([]);
      try {
        const items = await idbGetAll<{ kind?: string }>('syncQueue');
        const n = Array.isArray(items) ? items.filter((i) => i && i.kind === 'roadblock').length : 0;
        setQueuedCount(n);
      } catch {
        setQueuedCount(0);
      }
    }
  }, [online, configured]);

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
      setGpsError(err instanceof Error ? err.message : 'GPS failed');
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
    setStatus('submitting');

    const id = crypto.randomUUID();
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

    try {
      if (online && configured) {
        const sb = getSupabase();
        if (!sb) throw new Error('Supabase not configured');
        const payload = {
          id: roadblock.id,
          road_name: roadblock.road_name,
          closure_type: roadblock.closure_type,
          status: roadblock.status,
          notes: roadblock.notes,
          reporter: roadblock.reporter,
          reported_at: roadblock.reported_at,
          geom: `SRID=4326;POINT(${gps.lon} ${gps.lat})`,
        };
        const { error } = await sb.from('emg_roadblocks').insert(payload);
        if (error) throw new Error(error.message);
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
      }

      if (photo) {
        try {
          await idbPut('photos', {
            id: `${id}-photo`,
            roadblockId: id,
            dataUrl: photo.dataUrl,
            takenAt: photo.takenAt,
            createdAt: reported_at,
          });
        } catch {
          /* photo persistence best-effort */
        }
      }

      setStatus('success');
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
        {online && configured ? (
          existingError ? (
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
          )
        ) : (
          <p className="muted">
            offline — {queuedCount ?? 0} queued
          </p>
        )}
      </div>

      <div className="card">
        <button className="btn" type="button" onClick={onDone}>
          Back
        </button>
      </div>
    </div>
  );
}
