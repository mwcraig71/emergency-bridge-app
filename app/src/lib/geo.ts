// Geographic helpers: haversine distance, bearing, NBI mismatch detection.

const EARTH_M = 6371000;

export function haversineMeters(
  lat1: number, lon1: number, lat2: number, lon2: number,
): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_M * Math.asin(Math.sqrt(a));
}

/** Initial bearing from point 1 to point 2, in degrees 0-360. */
export function bearingDegrees(
  lat1: number, lon1: number, lat2: number, lon2: number,
): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const toDeg = (r: number) => (r * 180) / Math.PI;
  const dLon = toRad(lon2 - lon1);
  const y = Math.sin(dLon) * Math.cos(toRad(lat2));
  const x =
    Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
    Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(dLon);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

export function formatDistance(meters: number): string {
  if (meters < 1000) return `${Math.round(meters)} m`;
  const miles = meters / 1609.344;
  if (miles < 10) return `${miles.toFixed(1)} mi`;
  return `${Math.round(miles)} mi`;
}

export function formatBearing(deg: number): string {
  const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  return `${Math.round(deg)}° ${dirs[Math.round(deg / 45) % 8]}`;
}

/**
 * NBI coordinate mismatch check. Returns true when the observed GPS fix is
 * more than `thresholdMeters` (default 100) from the NBI bridge coordinates —
 * possible wrong bridge or bad NBI coords.
 */
export function isCoordMismatch(
  nbiLat: number, nbiLon: number,
  gpsLat: number | null, gpsLon: number | null,
  thresholdMeters = 100,
): boolean {
  if (gpsLat == null || gpsLon == null) return false;
  return haversineMeters(nbiLat, nbiLon, gpsLat, gpsLon) > thresholdMeters;
}

/**
 * Normalize a user-typed Asset ID for lookup.
 * Numeric input: strip leading zeros ('001892' -> '1892').
 * Non-numeric input: match literally (e.g. '2SC0300').
 */
export function normalizeAssetId(input: string): string {
  const t = input.trim();
  if (/^\d+$/.test(t)) return String(parseInt(t, 10));
  return t.toUpperCase();
}
