import React, { useEffect, useState } from 'react';
import type { Bridge, InspectionDraft } from '../types';
import {
  findBridge,
  nearestUninspected,
  syncBridgeCache,
  type SyncBridgeCacheOptions,
} from '../lib/bridges';
import { getAllAssignments, syncAssignments } from '../lib/assignments';
import { idbGetAll, idbCount, idbGet } from '../lib/idb';
import { getGpsFix } from '../lib/location';
import { formatDistance } from '../lib/geo';

interface BridgeLookupProps {
  onSelect: (bridge: Bridge) => void;
}

interface NearbyResult {
  bridge: Bridge;
  distance: number;
}

const BridgeLookup: React.FC<BridgeLookupProps> = ({ onSelect }) => {
  const [cachedCount, setCachedCount] = useState<number | null>(null);
  const [syncedAt, setSyncedAt] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncProgress, setSyncProgress] = useState<string>('');
  // Inventory download chooser: the user picks what lands on the device
  // BEFORE anything downloads (states, and/or only their assignments).
  const [dlNc, setDlNc] = useState(false);
  const [dlSc, setDlSc] = useState(false);
  const [dlAssignedOnly, setDlAssignedOnly] = useState(false);
  const [query, setQuery] = useState('');
  const [notFound, setNotFound] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);
  const [nearbyError, setNearbyError] = useState<string | null>(null);
  const [nearbyLoading, setNearbyLoading] = useState(false);
  const [nearby, setNearby] = useState<NearbyResult[] | null>(null);

  const refreshMeta = async () => {
    try {
      const count = await idbCount('bridges');
      setCachedCount(count);
      const meta = await idbGet('meta', 'bridges_synced_at');
      if (meta && typeof meta === 'object' && 'value' in meta) {
        setSyncedAt(String((meta as { value: unknown }).value));
      } else if (typeof meta === 'string') {
        setSyncedAt(meta);
      } else {
        setSyncedAt(null);
      }
    } catch {
      setCachedCount(0);
    }
  };

  useEffect(() => {
    void refreshMeta();
  }, []);

  const handleSync = async () => {
    const states: string[] = [];
    if (dlNc) states.push('NC');
    if (dlSc) states.push('SC');
    if (states.length === 0 && !dlAssignedOnly) {
      setSyncProgress(
        'Choose at least one state — or "Only bridges assigned to me" — before downloading.',
      );
      return;
    }
    setSyncing(true);
    setSyncProgress('Starting download…');
    try {
      let options: SyncBridgeCacheOptions = { states };
      if (dlAssignedOnly) {
        // Refresh the local assignments cache first (best effort), then
        // download just those bridges instead of a whole state.
        try {
          await syncAssignments();
        } catch {
          // fall back to whatever assignments are already cached
        }
        const mine = await getAllAssignments().catch(() => []);
        let ids = [...new Set(mine.map((a) => a.asset_id))];
        if (states.length > 0) {
          ids = ids.filter((id) =>
            states.some((s) => id.startsWith(`${s}-`)),
          );
        }
        if (ids.length === 0) {
          setSyncProgress(
            'No assignments found on this device yet. Download a state ' +
              'inventory instead, or ask your firm admin to assign you bridges first.',
          );
          return;
        }
        options = { assetIds: ids };
      }
      await syncBridgeCache((done: number, total: number) => {
        setSyncProgress(`Downloaded ${done} of ${total} bridges…`);
      }, options);
      setSyncProgress('Complete');
      await refreshMeta();
    } catch (err) {
      const msg =
        err instanceof Error
          ? err.message
          : err && typeof err === 'object' && 'message' in err
            ? String((err as { message: unknown }).message)
            : JSON.stringify(err);
      setSyncProgress(`Sync failed: ${msg}`);
    } finally {
      setSyncing(false);
    }
  };

  const handleSearch = async () => {
    const input = query.trim();
    if (!input) return;
    setSearching(true);
    setNotFound(null);
    try {
      const bridge = await findBridge(input);
      if (bridge) {
        onSelect(bridge);
      } else {
        setNotFound(`No bridge found for '${input}'.`);
      }
    } catch {
      setNotFound(`No bridge found for '${input}'.`);
    } finally {
      setSearching(false);
    }
  };

  const handleFindNearest = async () => {
    setNearbyLoading(true);
    setNearbyError(null);
    setNearby(null);
    try {
      const fix = await getGpsFix();
      const drafts = (await idbGetAll('drafts')) as InspectionDraft[];
      const inspected = new Set<string>();
      for (const d of drafts) {
        const id = (d as unknown as { asset_id?: string; assetId?: string })
          .asset_id;
        const altId = (d as unknown as { assetId?: string }).assetId;
        if (id) inspected.add(String(id));
        if (altId) inspected.add(String(altId));
      }
      const results = await nearestUninspected(
        fix.lat,
        fix.lon,
        inspected,
        25
      );
      const mapped: NearbyResult[] = (results ?? []).map((r) => ({
        bridge: r as Bridge,
        distance: (r as Bridge & { distanceM: number }).distanceM ?? 0,
      }));
      setNearby(mapped);
    } catch {
      setNearbyError('GPS unavailable');
    } finally {
      setNearbyLoading(false);
    }
  };

  const count = cachedCount ?? 0;
  const hasInventory = cachedCount !== null && count > 0;

  /** State / assigned-only chooser shown before any download starts. */
  const renderDownloadChooser = (buttonLabel: string) => {
    const checkRow = (
      checked: boolean,
      onChange: (v: boolean) => void,
      label: string,
    ) => (
      <label
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          minHeight: 48,
          cursor: 'pointer',
          fontSize: 16,
        }}
      >
        <input
          type="checkbox"
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
          disabled={syncing}
          style={{ width: 22, height: 22, accentColor: '#CF3910' }}
        />
        <span>{label}</span>
      </label>
    );
    return (
      <div>
        <div style={{ fontWeight: 600, marginBottom: 4 }}>
          Which inventory do you want to download?
        </div>
        {checkRow(dlNc, setDlNc, 'North Carolina')}
        {checkRow(dlSc, setDlSc, 'South Carolina')}
        {checkRow(
          dlAssignedOnly,
          setDlAssignedOnly,
          'Only bridges assigned to me',
        )}
        <button
          className="btn"
          style={{ minHeight: 56, width: '100%', fontSize: 18, marginTop: 8 }}
          onClick={() => void handleSync()}
          disabled={syncing}
        >
          {syncing ? 'Downloading…' : buttonLabel}
        </button>
        {syncProgress && (
          <div className="muted" style={{ marginTop: 12 }}>
            {syncProgress}
          </div>
        )}
      </div>
    );
  };

  if (cachedCount === null) {
    return (
      <div className="screen">
        <div className="card">
          <div className="muted">Loading bridge inventory…</div>
        </div>
      </div>
    );
  }

  if (!hasInventory) {
    return (
      <div className="screen">
        <div className="card">
          <h2 style={{ marginTop: 0 }}>Bridge Inventory</h2>
          <p className="muted">
            No bridges are cached on this device. Download the inventory before
            inspecting.
          </p>
          {renderDownloadChooser('Download bridge inventory')}
        </div>
      </div>
    );
  }

  return (
    <div className="screen">
      <div className="card">
        <label
          htmlFor="bridge-lookup-input"
          style={{ display: 'block', fontWeight: 600, marginBottom: 6 }}
        >
          SCDOT Asset ID
        </label>
        <input
          id="bridge-lookup-input"
          className="field"
          type="text"
          inputMode="text"
          autoComplete="off"
          autoCapitalize="characters"
          placeholder="e.g. 0123456"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setNotFound(null);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              void handleSearch();
            }
          }}
          style={{ minHeight: 48, fontSize: 18, width: '100%' }}
        />
        <button
          className="btn"
          onClick={() => void handleSearch()}
          disabled={searching || !query.trim()}
          style={{ minHeight: 56, width: '100%', fontSize: 18, marginTop: 12 }}
        >
          {searching ? 'Searching…' : 'Search'}
        </button>
        {notFound && (
          <div
            role="alert"
            style={{ marginTop: 12, color: '#b00020', fontWeight: 600 }}
          >
            {notFound}
          </div>
        )}
        <div className="muted" style={{ marginTop: 12, fontSize: 13 }}>
          {count.toLocaleString()} bridges cached
          {syncedAt ? ` · last sync ${new Date(syncedAt).toLocaleString()}` : ''}
        </div>
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Download more inventory</h3>
        {renderDownloadChooser('Download selected inventory')}
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Nearby uninspected</h3>
        <button
          className="btn"
          onClick={() => void handleFindNearest()}
          disabled={nearbyLoading}
          style={{ minHeight: 56, width: '100%', fontSize: 18 }}
        >
          {nearbyLoading ? 'Locating…' : 'Find nearest uninspected'}
        </button>
        {nearbyError && (
          <div role="alert" style={{ marginTop: 12, color: '#b00020' }}>
            {nearbyError}
          </div>
        )}
        {nearby && nearby.length === 0 && (
          <div className="muted" style={{ marginTop: 12 }}>
            No uninspected bridges within 25 miles.
          </div>
        )}
        {nearby && nearby.length > 0 && (
          <ul style={{ listStyle: 'none', padding: 0, margin: '12px 0 0 0' }}>
            {nearby.map((r, idx) => {
              const b = r.bridge;
              const assetId =
                (b as unknown as { asset_id?: string }).asset_id ?? b.struct_no ??
                (b as unknown as { id?: string }).id ??
                '';
              const county = b.county_name ?? b.county ?? '';
              const facility =
                (b as unknown as { facility?: string }).facility ?? '';
              return (
                <li key={`${assetId}-${idx}`} style={{ marginBottom: 8 }}>
                  <button
                    className="btn"
                    onClick={() => onSelect(b)}
                    style={{
                      minHeight: 64,
                      width: '100%',
                      textAlign: 'left',
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'flex-start',
                      gap: 2,
                      padding: 12,
                    }}
                  >
                    <span style={{ fontWeight: 700, fontSize: 16 }}>
                      {formatDistance(r.distance)} · {assetId}
                    </span>
                    <span className="muted" style={{ fontSize: 13 }}>
                      {county}
                      {county && facility ? ' · ' : ''}
                      {facility}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
};

export default BridgeLookup;
