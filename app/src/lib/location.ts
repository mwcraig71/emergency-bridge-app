// GPS: Capacitor Geolocation on device, browser geolocation fallback on web.
// GPS satellite positioning works without cell service — never gate on network.
import { Geolocation } from '@capacitor/geolocation';
import { Capacitor } from '@capacitor/core';

export interface GpsFix {
  lat: number;
  lon: number;
  accuracy: number | null;
  timestamp: number;
}

async function fixNative(): Promise<GpsFix> {
  const pos = await Geolocation.getCurrentPosition({
    enableHighAccuracy: true,
    timeout: 20000,
  });
  return {
    lat: pos.coords.latitude,
    lon: pos.coords.longitude,
    accuracy: pos.coords.accuracy,
    timestamp: pos.timestamp,
  };
}

function fixWeb(): Promise<GpsFix> {
  return new Promise((resolve, reject) => {
    if (!('geolocation' in navigator)) {
      return reject(new Error('Geolocation not available'));
    }
    navigator.geolocation.getCurrentPosition(
      (pos) =>
        resolve({
          lat: pos.coords.latitude,
          lon: pos.coords.longitude,
          accuracy: pos.coords.accuracy,
          timestamp: pos.timestamp,
        }),
      (err) => reject(new Error(err.message)),
      { enableHighAccuracy: true, timeout: 20000 },
    );
  });
}

/** One-shot GPS fix. Rejects on timeout/denial — callers must handle gracefully. */
export async function getGpsFix(): Promise<GpsFix> {
  if (Capacitor.isNativePlatform()) {
    try {
      return await fixNative();
    } catch {
      return fixWeb();
    }
  }
  return fixWeb();
}

/**
 * Watch position continuously (breadcrumb tracking, directions).
 * Returns an unsubscribe function. Callback receives fixes; errors are swallowed
 * except the first, which is delivered via onError.
 */
export function watchGps(
  onFix: (fix: GpsFix) => void,
  onError?: (err: Error) => void,
): () => void {
  let done = false;
  let watchId = '';
  let errored = false;

  const handleFix = (f: GpsFix) => {
    if (!done) onFix(f);
  };

  if (Capacitor.isNativePlatform()) {
    Geolocation.watchPosition({ enableHighAccuracy: true }, (pos, err) => {
      if (err) {
        if (!errored) {
          errored = true;
          onError?.(new Error(String(err)));
        }
        return;
      }
      if (pos) {
        handleFix({
          lat: pos.coords.latitude,
          lon: pos.coords.longitude,
          accuracy: pos.coords.accuracy,
          timestamp: pos.timestamp,
        });
      }
    }).then((id) => {
      watchId = id;
    });
    return () => {
      done = true;
      if (watchId) void Geolocation.clearWatch({ id: watchId });
    };
  }

  const id = navigator.geolocation.watchPosition(
    (pos) =>
      handleFix({
        lat: pos.coords.latitude,
        lon: pos.coords.longitude,
        accuracy: pos.coords.accuracy,
        timestamp: pos.timestamp,
      }),
    (err) => {
      if (!errored) {
        errored = true;
        onError?.(new Error(err.message));
      }
    },
    { enableHighAccuracy: true },
  );
  return () => {
    done = true;
    navigator.geolocation.clearWatch(id);
  };
}
