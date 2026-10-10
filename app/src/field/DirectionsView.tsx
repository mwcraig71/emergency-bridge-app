import React, { useEffect, useMemo, useState } from 'react';
import type { Bridge } from '../types';
import { watchGps, type GpsFix } from '../lib/location';
import {
  bearingDegrees,
  haversineMeters,
  formatDistance,
  formatBearing,
} from '../lib/geo';
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
      url = `https://maps.apple.com/?daddr=${destLat},${destLon}`;
    } else if (isAndroid()) {
      url = `geo:${destLat},${destLon}?q=${destLat},${destLon}`;
    } else {
      url = `https://maps.apple.com/?daddr=${destLat},${destLon}`;
    }
    window.open(url, '_blank', 'noopener,noreferrer');
  };

  const position = fix ? { lon: fix.lon, lat: fix.lat } : null;

  return (
    <div className="sheet-backdrop">
      <div className="sheet">
        {!bridge ? (
          <>
            <h2>No destination</h2>
            <p className="muted">Select a bridge to get directions.</p>
            <button className="btn" type="button" onClick={onClose}>
              Close
            </button>
          </>
        ) : (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <button
                className="btn"
                type="button"
                onClick={onClose}
                aria-label="Close"
                style={{ flex: '0 0 auto' }}
              >
                Close
              </button>
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 700 }}>{bridge.asset_id}</div>
                <div className="muted">
{[bridge.facility, bridge.feature].filter(Boolean).join(' over ')}
                  {bridge.location ? ` · ${bridge.location}` : ''}
                </div>
              </div>
            </div>

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

            <button className="btn" type="button" onClick={handleOpenMaps} style={{ marginTop: 8 }}>
              Open in Maps app
            </button>
          </>
        )}
      </div>
    </div>
  );
}
