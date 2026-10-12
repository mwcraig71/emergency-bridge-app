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
    if (
      typeof navigator === 'undefined' ||
      !('geolocation' in navigator) ||
      !navigator.geolocation
    ) {
      return reject(new GpsError('Geolocation is not available in this browser', 0));
    }
    navigator.geolocation.getCurrentPosition(
      (pos) =>
        resolve({
          lat: pos.coords.latitude,
          lon: pos.coords.longitude,
          accuracy: pos.coords.accuracy,
          timestamp: pos.timestamp,
        }),
      (err) => reject(new GpsError(err.message || 'GPS unavailable', err.code)),
      { enableHighAccuracy: true, timeout: 20000 },
    );
  });
}

/**
 * Error from GPS APIs that carries the GeolocationPositionError code
 * (1 = permission denied, 2 = position unavailable, 3 = timeout).
 * Callers use `code === 1` to show an "enable location access" message
 * instead of a generic "waiting for fix".
 */
export class GpsError extends Error {
  code: number;
  constructor(message: string, code = 0) {
    super(message);
    this.name = 'GpsError';
    this.code = code;
  }
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
  let unsubscribed = false;

  const handleFix = (f: GpsFix) => {
    if (!done) onFix(f);
  };
  const handleError = (err: Error) => {
    if (!errored) {
      errored = true;
      onError?.(err);
    }
  };

  if (Capacitor.isNativePlatform()) {
    // The watch id arrives asynchronously: if unsubscribe() runs before the
    // promise resolves, `cancelled` makes sure the id is cleared the moment
    // it arrives instead of leaking a native watch in the background.
    let cancelled = false;
    Geolocation.watchPosition({ enableHighAccuracy: true }, (pos, err) => {
      if (err) {
        handleError(new Error(String(err)));
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
    })
      .then((id) => {
        watchId = id;
        if (cancelled) void Geolocation.clearWatch({ id });
      })
      .catch((e) => {
        handleError(e instanceof Error ? e : new Error(String(e)));
      });
    return () => {
      if (unsubscribed) return;
      unsubscribed = true;
      done = true;
      cancelled = true;
      if (watchId) void Geolocation.clearWatch({ id: watchId });
    };
  }

  // Web path: navigator.geolocation is absent in non-secure contexts and
  // some embedded browsers — guard instead of throwing an obscure TypeError.
  if (
    typeof navigator === 'undefined' ||
    !('geolocation' in navigator) ||
    !navigator.geolocation
  ) {
    throw new GpsError('Geolocation is not available in this browser', 0);
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
      handleError(new GpsError(err.message || 'GPS unavailable', err.code));
    },
    { enableHighAccuracy: true },
  );
  return () => {
    if (unsubscribed) return;
    unsubscribed = true;
    done = true;
    navigator.geolocation.clearWatch(id);
  };
}
