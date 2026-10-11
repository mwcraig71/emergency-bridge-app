// User-defined offline map tile download.
//
// The inspector pans/zooms the map to cover their work area (up to ~1/3 of NC),
// taps "Download this area", and the app fetches vector tiles for the visible
// bounds across a zoom range, storing them in IndexedDB. MapLibre then serves
// cached tiles when offline via a custom protocol handler.
//
// Tile source: Carto Positron vector tiles (same as the online style).
// Tile URL template (verified 2026-10-11): https://tiles-a.basemaps.cartocdn.com/vectortiles/carto.streets/v1/{z}/{x}/{y}.mvt

import { idbGet, idbPut, idbDelete, idbGetAll, idbCount } from './idb';

/** Geographic bounds in degrees. */
export interface TileBounds {
  west: number;
  south: number;
  east: number;
  north: number;
}

export interface TileCoord {
  z: number;
  x: number;
  y: number;
}

/** A named downloaded area (for the "manage" UI). */
export interface OfflineArea {
  id: string;
  name: string;
  bounds: TileBounds;
  minZoom: number;
  maxZoom: number;
  tileCount: number;
  downloadedTiles: number;
  sizeBytes: number;
  downloadedAt: string; // ISO
}

/** Stored tile record in the `offlineTiles` object store. */
export interface StoredTile {
  key: string; // `${z}/${x}/${y}`
  z: number;
  x: number;
  y: number;
  data: ArrayBuffer;
  url: string;
  downloadedAt: string;
  sizeBytes: number;
}

/** Stored area record in the `offlineAreas` object store. */
export type StoredArea = OfflineArea;

/** Carto vector tile URL template (from tiles.json). */
export const TILE_URL_TEMPLATE =
  'https://tiles-a.basemaps.cartocdn.com/vectortiles/carto.streets/v1/{z}/{x}/{y}.mvt';

/** Custom protocol scheme used to route tile requests through the offline cache. */
export const OFFLINE_PROTOCOL = 'offline-tile';

const MAX_BYTES = 500 * 1024 * 1024; // 500 MB hard cap
const AVG_TILE_BYTES = 45 * 1024; // observed ~20-100KB for Carto vector tiles
const DEFAULT_MIN_ZOOM = 8;
const DEFAULT_MAX_ZOOM = 14;

/** Convert lon/lat to slippy-map tile x/y at zoom z. */
export function lonLatToTile(lon: number, lat: number, z: number): [number, number] {
  const n = Math.pow(2, z);
  const x = Math.floor(((lon + 180) / 360) * n);
  const latRad = (lat * Math.PI) / 180;
  const y = Math.floor(
    ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n,
  );
  return [x, y];
}

/** Get the tile key for storage. */
export function tileKey(z: number, x: number, y: number): string {
  return `${z}/${x}/${y}`;
}

/** Build the network URL for a tile. */
export function tileUrl(z: number, x: number, y: number): string {
  return TILE_URL_TEMPLATE.replace('{z}', String(z))
    .replace('{x}', String(x))
    .replace('{y}', String(y));
}

/**
 * Calculate all tile coordinates covering the bounds for zooms minZoom..maxZoom.
 * Bounds are clamped to valid lat/lon ranges.
 */
export function tilesForBounds(
  bounds: TileBounds,
  minZoom: number,
  maxZoom: number,
): TileCoord[] {
  const west = Math.max(-180, Math.min(180, bounds.west));
  const east = Math.max(-180, Math.min(180, bounds.east));
  const south = Math.max(-85, Math.min(85, bounds.south));
  const north = Math.max(-85, Math.min(85, bounds.north));
  if (west >= east || south >= north) return [];

  const tiles: TileCoord[] = [];
  for (let z = minZoom; z <= maxZoom; z++) {
    const n = Math.pow(2, z);
    const [x0] = lonLatToTile(west, north, z);
    const [, y0] = lonLatToTile(west, north, z);
    const [x1] = lonLatToTile(east, south, z);
    const [, y1] = lonLatToTile(east, south, z);
    const xa = Math.max(0, Math.min(x0, x1));
    const xb = Math.min(n - 1, Math.max(x0, x1));
    const ya = Math.max(0, Math.min(y0, y1));
    const yb = Math.min(n - 1, Math.max(y0, y1));
    for (let x = xa; x <= xb; x++) {
      for (let y = ya; y <= yb; y++) {
        tiles.push({ z, x, y });
      }
    }
  }
  return tiles;
}

export interface DownloadEstimate {
  tileCount: number;
  estimatedBytes: number;
  exceedsCap: boolean;
  maxBytes: number;
}

/** Estimate download size before starting. */
export function estimateDownload(
  bounds: TileBounds,
  minZoom: number,
  maxZoom: number,
): DownloadEstimate {
  const tiles = tilesForBounds(bounds, minZoom, maxZoom);
  const estimatedBytes = tiles.length * AVG_TILE_BYTES;
  return {
    tileCount: tiles.length,
    estimatedBytes,
    exceedsCap: estimatedBytes > MAX_BYTES,
    maxBytes: MAX_BYTES,
  };
}

/** Get current visible bounds from a MapLibre map instance. */
export function getTileBounds(map: {
  getBounds(): { getWest(): number; getSouth(): number; getEast(): number; getNorth(): number };
}): TileBounds {
  const b = map.getBounds();
  return {
    west: b.getWest(),
    south: b.getSouth(),
    east: b.getEast(),
    north: b.getNorth(),
  };
}

/** Retrieve a cached tile. Returns null on cache miss. */
export async function getOfflineTile(
  z: number,
  x: number,
  y: number,
): Promise<ArrayBuffer | null> {
  try {
    const rec = await idbGet<StoredTile>('offlineTiles', tileKey(z, x, y));
    return rec ? rec.data : null;
  } catch {
    return null;
  }
}

export interface DownloadProgress {
  done: number;
  total: number;
  bytes: number;
  failed: number;
}

/**
 * Download tiles for the given bounds/zoom range into IndexedDB.
 *
 * - Uses the bounds as captured at call time (panning mid-download is safe).
 * - Skips tiles already cached (resumable).
 * - Concurrency-limited fetches; individual failures are counted and skipped.
 * - Aborts early if storage quota is exceeded.
 */
export async function downloadTiles(
  bounds: TileBounds,
  minZoom: number,
  maxZoom: number,
  onProgress?: (p: DownloadProgress) => void,
  shouldCancel?: () => boolean,
): Promise<DownloadProgress> {
  const tiles = tilesForBounds(bounds, minZoom, maxZoom);
  const total = tiles.length;
  let done = 0;
  let bytes = 0;
  let failed = 0;
  const CONCURRENCY = 6;

  const report = () => onProgress?.({ done, total, bytes, failed });

  // Check which tiles are already cached to support resume.
  const missing: TileCoord[] = [];
  for (const t of tiles) {
    if (shouldCancel?.()) break;
    const existing = await getOfflineTile(t.z, t.x, t.y);
    if (existing) {
      done++;
      bytes += existing.byteLength;
    } else {
      missing.push(t);
    }
    if ((done + missing.length) % 50 === 0) report();
  }
  report();

  // Fetch missing tiles with bounded concurrency.
  for (let i = 0; i < missing.length; i += CONCURRENCY) {
    if (shouldCancel?.()) break;
    const batch = missing.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      batch.map(async (t) => {
        try {
          const resp = await fetch(tileUrl(t.z, t.x, t.y));
          if (!resp.ok) return { t, ok: false as const };
          const data = await resp.arrayBuffer();
          if (data.byteLength === 0) return { t, ok: false as const };
          const rec: StoredTile = {
            key: tileKey(t.z, t.x, t.y),
            z: t.z,
            x: t.x,
            y: t.y,
            data,
            url: tileUrl(t.z, t.x, t.y),
            downloadedAt: new Date().toISOString(),
            sizeBytes: data.byteLength,
          };
          await idbPut('offlineTiles', rec);
          return { t, ok: true as const, bytes: data.byteLength };
        } catch {
          return { t, ok: false as const };
        }
      }),
    );
    for (const r of results) {
      done++;
      if (r.ok) {
        bytes += r.bytes;
      } else {
        failed++;
      }
      if (bytes > MAX_BYTES) {
        report();
        throw new Error(
          `Download exceeded the ${Math.round(MAX_BYTES / 1024 / 1024)} MB cap and was stopped.`,
        );
      }
    }
    report();
  }

  return { done, total, bytes, failed };
}

/** Save a named offline area record. */
export async function saveOfflineArea(area: OfflineArea): Promise<void> {
  await idbPut('offlineAreas', area as unknown as Record<string, unknown>);
}

/** List all downloaded offline areas. */
export async function listOfflineAreas(): Promise<OfflineArea[]> {
  try {
    const all = await idbGetAll<StoredArea>('offlineAreas');
    return all.sort((a, b) => b.downloadedAt.localeCompare(a.downloadedAt));
  } catch {
    return [];
  }
}

/** Delete an offline area and all its tiles. */
export async function deleteOfflineArea(id: string): Promise<void> {
  const area = await idbGet<StoredArea>('offlineAreas', id);
  if (!area) return;
  const tiles = tilesForBounds(area.bounds, area.minZoom, area.maxZoom);
  // Delete in chunks to avoid long transactions.
  const CHUNK = 500;
  for (let i = 0; i < tiles.length; i += CHUNK) {
    await Promise.all(
      tiles.slice(i, i + CHUNK).map((t) => idbDelete('offlineTiles', tileKey(t.z, t.x, t.y)).catch(() => {})),
    );
  }
  await idbDelete('offlineAreas', id);
}

/** Total bytes currently used by cached tiles. */
export async function offlineTileUsage(): Promise<{ tiles: number; bytes: number }> {
  try {
    const all = await idbGetAll<StoredTile>('offlineTiles');
    return {
      tiles: all.length,
      bytes: all.reduce((s, t) => s + (t.sizeBytes || 0), 0),
    };
  } catch {
    return { tiles: 0, bytes: 0 };
  }
}

/** Format bytes for display. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/**
 * Rewrite a MapLibre style so vector tile requests go through the
 * `offline-tile://` protocol. The protocol handler (registered once per
 * page load) checks IndexedDB first and falls back to the network.
 */
export function rewriteStyleForOffline(
  style: Record<string, unknown>,
): Record<string, unknown> {
  const out = JSON.parse(JSON.stringify(style)) as Record<string, unknown>;
  const sources = out.sources as Record<string, Record<string, unknown>> | undefined;
  if (!sources) return out;
  for (const key of Object.keys(sources)) {
    const src = sources[key];
    if (src.type === 'vector' && Array.isArray(src.tiles)) {
      src.tiles = (src.tiles as string[]).map((u) =>
        typeof u === 'string' && u.startsWith('https://')
          ? u.replace(/^https:\/\//, `${OFFLINE_PROTOCOL}://`)
          : u,
      );
    }
    if (src.type === 'vector' && typeof src.url === 'string') {
      // TileJSON endpoint — leave as-is; tile URLs inside are resolved
      // relative to it and still pass through transformRequest below.
    }
  }
  return out;
}

/**
 * Parse z/x/y out of an offline-tile:// URL.
 * Supports .../{z}/{x}/{y}.mvt and .../{z}/{x}/{y}.pbf patterns.
 */
export function parseOfflineTileUrl(url: string): TileCoord | null {
  const m = url.match(/\/(\d+)\/(\d+)\/(\d+)\.(mvt|pbf)(\?|$)/);
  if (!m) return null;
  return { z: parseInt(m[1], 10), x: parseInt(m[2], 10), y: parseInt(m[3], 10) };
}

/** Reconstruct the real https URL from an offline-tile:// URL. */
export function realUrlFromOffline(url: string): string {
  return url.replace(new RegExp(`^${OFFLINE_PROTOCOL}://`), 'https://');
}
