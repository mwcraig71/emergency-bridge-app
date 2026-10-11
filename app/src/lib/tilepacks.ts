// Tile-pack abstraction for offline maps.
//
// Phase 1 (this scaffold): OnlineTileProvider — MapLibre renders from online
// vector/raster tiles. GPS, breadcrumbs, closures and the inspection form all
// work without network; only the basemap picture needs connectivity.
//
// Phase 2 (production): PmtilesPackProvider — pre-downloaded PMTiles archives
// (single-file vector tiles, ~1-3 GB for SC) served from device storage via a
// local pmtiles:// source. The TeamMap component consumes only the
// TilePackProvider interface, so the swap is transparent.
//
// See 04-PRODUCTION-ARCHITECTURE.md ("Offline tile packs") for the generation
// pipeline (tilemaker/Protomaps -> PMTiles, z0-14, clipped to SC + buffer).

export interface TilePack {
  id: string;
  name: string;
  region: string;
  minZoom: number;
  maxZoom: number;
  sizeBytes: number | null; // null until downloaded/measured
  status: 'available' | 'downloading' | 'ready' | 'error';
  version: string;
  downloadedAt: string | null;
}

export interface TilePackProvider {
  readonly kind: 'online' | 'pmtiles';
  /** MapLibre style (URL or style object) for the current pack selection. */
  getStyle(): Promise<string | Record<string, unknown>>;
  /** Packs known to the provider (remote catalog + local state merged). */
  listPacks(): Promise<TilePack[]>;
  /** Download + verify a pack (Phase 2). Resolves when ready for offline use. */
  downloadPack(id: string, onProgress?: (pct: number) => void): Promise<void>;
  /** Delete a downloaded pack (Phase 2). */
  deletePack(id: string): Promise<void>;
}

/** Free, keyless online vector style (Carto Positron). */
export const ONLINE_STYLE_URL =
  'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json';

export class OnlineTileProvider implements TilePackProvider {
  readonly kind = 'online' as const;

  async getStyle(): Promise<string> {
    return ONLINE_STYLE_URL;
  }

  async listPacks(): Promise<TilePack[]> {
    // Phase 2: merge remote pack catalog with local download state.
    // Phase 1: no downloadable packs yet — return the implicit online pack.
    return [
      {
        id: 'online-basemap',
        name: 'Online basemap (requires connection)',
        region: 'South Carolina',
        minZoom: 0,
        maxZoom: 18,
        sizeBytes: null,
        status: 'ready',
        version: 'live',
        downloadedAt: null,
      },
    ];
  }

  async downloadPack(): Promise<void> {
    throw new Error(
      'Offline tile packs are a Phase 2 production item (see docs + 04-PRODUCTION-ARCHITECTURE.md).',
    );
  }

  async deletePack(): Promise<void> {
    throw new Error('No downloaded packs in Phase 1.');
  }
}

/**
 * Phase 2 stub. Real implementation:
 * - packs stored under Capacitor Filesystem (Documents/tilepacks/<id>.pmtiles)
 * - served to MapLibre via the pmtiles.js Protocol (addProtocol('pmtiles', ...))
 * - getStyle() returns a style JSON whose sources use pmtiles:// URLs
 */
export class PmtilesPackProvider implements TilePackProvider {
  readonly kind = 'pmtiles' as const;

  async getStyle(): Promise<Record<string, unknown>> {
    throw new Error(
      'PmtilesPackProvider is not implemented yet — Phase 2 (see tilepacks.ts header).',
    );
  }

  async listPacks(): Promise<TilePack[]> {
    throw new Error('PmtilesPackProvider is not implemented yet — Phase 2.');
  }

  async downloadPack(): Promise<void> {
    throw new Error('PmtilesPackProvider is not implemented yet — Phase 2.');
  }

  async deletePack(): Promise<void> {
    throw new Error('PmtilesPackProvider is not implemented yet — Phase 2.');
  }
}

/** Factory: online now; swap to PMTiles when Phase 2 lands (feature flag). */
export function createTilePackProvider(): TilePackProvider {
  // const useOffline = localStorage.getItem('tilepacks.enabled') === '1';
  // return useOffline ? new PmtilesPackProvider() : new OnlineTileProvider();
  return new OnlineTileProvider();
}
