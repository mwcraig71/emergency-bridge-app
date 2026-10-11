import React, { useEffect, useMemo, useState } from 'react';
import type { Bridge } from '../types';
import { watchGps, type GpsFix } from '../lib/location';
import {
  bearingDegrees,
  haversineMeters,
  formatDistance,
  formatBearing,
} from '../lib/geo';
import { getSupabase, isOnline, isSupabaseConfigured } from '../lib/supabase';
import TeamMap from '../components/TeamMap';

type Props = {
  bridge: Bridge | null;
  onClose: () => void;
};

function isIOS(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  return /iPad|iPhone|iPod/.test(ua);
}

function isAndroid(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  return /Android/i.test(ua);
}

export default function DirectionsView({ bridge, onClose }: Props): React.JSX.Element {
  const [fix, setFix] = useState<GpsFix | null>(null);
  const [gpsError, setGpsError] = useState<string | null>(null);
  const [online, setOnline] = useState<boolean>(() => isOnline());
  const [nearbyClosures, setNearbyClosures] = useState<number | null>(null);

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

  useEffect(() => {
    let stop: (() => void) | null = null;
    try {
      stop = watchGps(
        (f) => {
          setFix(f);
          setGpsError(null);
        },
        (err) => {
          setGpsError(err instanceof Error ? err.message : 'GPS unavailable');
        }
      );
    } catch (err) {
      setGpsError(err instanceof Error ? err.message : 'GPS unavailable');
    }
    return () => {
      if (stop) stop();
    };
  }, []);

  // Warn about reported road closures near the destination bridge.
  // Roadblock data lives in Supabase (not cached offline), so this only
  // runs when online.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setNearbyClosures(null);
      if (!bridge || bridge.lat == null || bridge.lon == null) return;
      if (!isOnline() || !isSupabaseConfigured()) return;
      const supabase = getSupabase();
      if (!supabase) return;
      try {
        const [{ data: rbs }, { data: pins }] = await Promise.all([
          supabase
            .from('emg_roadblocks')
            .select('lon,lat,status')
            .eq('status', 'active')
            .limit(2000),
          supabase.from('emg_road_statuses').select('lon,lat,status').limit(2000),
        ]);
        if (cancelled) return;
        let count = 0;
        const RADIUS_M = 5000;
        const check = (lon: unknown, lat: unknown, closed: boolean) => {
          if (!closed) return;
          if (typeof lon !== 'number' || typeof lat !== 'number') return;
          if (!Number.isFinite(lon) || !Number.isFinite(lat)) return;
          const d = haversineMeters(bridge.lat, bridge.lon, lat, lon);
          if (d <= RADIUS_M) count += 1;
        };
        for (const r of (rbs ?? []) as Array<{
          lon?: number;
          lat?: number;
          status?: string;
        }>) {
          check(r.lon, r.lat, r.status === 'active');
        }
        for (const p of (pins ?? []) as Array<{
          lon?: number;
          lat?: number;
          status?: string;
        }>) {
          const s = (p.status ?? '').toLowerCase();
          check(p.lon, p.lat, s.includes('clos'));
        }
        setNearbyClosures(count);
      } catch {
        // ignore — warning is best-effort
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [bridge]);

  const destLat = bridge?.lat ?? null;
  const destLon = bridge?.lon ?? null;

  const bearing = useMemo(() => {
    if (!fix || destLat == null || destLon == null) return null;
    return bearingDegrees(fix.lat, fix.lon, destLat, destLon);
  }, [fix, destLat, destLon]);

  const distance = useMemo(() => {
    if (!fix || destLat == null || destLon == null) return null;
    return haversineMeters(fix.lat, fix.lon, destLat, destLon);
  }, [fix, destLat, destLon]);

  const handleOpenMaps = () => {
    if (destLat == null || destLon == null) return;
    let url: string;
    if (isIOS()) {
      url = `maps://?daddr=${destLat},${destLon}`;
    } else if (isAndroid()) {
      url = `geo:${destLat},${destLon}?q=${destLat},${destLon}`;
    } else {
      url = `https://maps.apple.com/?daddr=${destLat},${destLon}`;
    }
    window.open(url, '_blank', 'noopener,noreferrer');
  };

  const position = fix ? { lon: fix.lon, lat: fix.lat } : null;

  return (
    <div className="directions-fullscreen">
      <div className="directions-header">
        {!bridge ? (
          <h2 style={{ margin: 0 }}>No destination</h2>
        ) : (
          <>
            <button
              className="btn"
              type="button"
              onClick={onClose}
              aria-label="Close"
              style={{ flex: '0 0 auto' }}
            >
              ✕
            </button>
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 700 }}>{bridge.asset_id}</div>
              <div className="muted" style={{ fontSize: 13 }}>
                {[bridge.facility, bridge.feature].filter(Boolean).join(' over ')}
              </div>
            </div>
          </>
        )}
      </div>
      <div className="directions-body">
        {!bridge ? (
          <>
            <p className="muted">Select a bridge to get directions.</p>
            <button className="btn" type="button" onClick={onClose}>
              Close
            </button>
          </>
        ) : (
          <>

            <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginTop: 12 }}>
              <div
                aria-hidden
                style={{
                  width: 64,
                  height: 64,
                  borderRadius: '50%',
                  border: '2px solid #ccc',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: 28,
                  transform: `rotate(${bearing ?? 0}deg)`,
                  transition: 'transform 0.2s ease-out',
                }}
              >
                ↑
              </div>
              <div>
                <div style={{ fontSize: 24, fontWeight: 700 }}>
                  {distance != null ? formatDistance(distance) : '—'}
                </div>
                <div className="muted">
                  {bearing != null ? `Bearing ${formatBearing(bearing)}` : 'Waiting for GPS…'}
                </div>
              </div>
            </div>

            {!fix && gpsError ? (
              <div className="warn-box">
                Waiting for GPS fix… (GPS works without cell service)
              </div>
            ) : null}
            {!fix && !gpsError ? (
              <p className="muted" style={{ marginTop: 8 }}>
                Waiting for GPS fix… (GPS works without cell service)
              </p>
            ) : null}

            <div style={{ marginTop: 12, height: 320 }}>
              <TeamMap focusBridge={bridge} showTeam position={position} />
            </div>

            <div className="warn-box" style={{ marginTop: 12 }}>
              External maps may show roads as closed that are actually passable. Trust team ground
              truth.
            </div>

            {nearbyClosures != null && nearbyClosures > 0 && (
              <div className="warn-box" style={{ marginTop: 8 }}>
                ⚠ {nearbyClosures} road closure{nearbyClosures === 1 ? '' : 's'}{' '}
                reported near this bridge
              </div>
            )}

            {online && (
              <button
                className="btn"
                type="button"
                onClick={handleOpenMaps}
                style={{ marginTop: 8 }}
              >
                Open in Maps app
              </button>
            )}
            {!online && (
              <p className="muted" style={{ marginTop: 8 }}>
                External maps need a data connection — use the compass bearing above while offline.
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}
