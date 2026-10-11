import { useEffect, useRef, useState } from 'react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import type { Bridge, Roadblock, RoadStatusPin, PathTrack, TeamPosition } from '../types';
import { createTilePackProvider } from '../lib/tilepacks';
import { getSupabase, isOnline, isSupabaseConfigured } from '../lib/supabase';
import { idbGetAll } from '../lib/idb';

interface TeamMapProps {
  focusBridge?: Bridge | null;
  showTeam?: boolean;
  showLocate?: boolean;
  position?: { lon: number; lat: number } | null;
  height?: string;
  onBridgeClick?: (assetId: string) => void;
  /** Field-app actions for the built-in bridge info sheet. Shown only when set. */
  onStartInspection?: (bridge: Bridge) => void;
  onGetDirections?: (bridge: Bridge) => void;
}

type Recency = '6h' | '24h' | 'all';

const SC_CENTER: [number, number] = [-80.9, 33.9];

function statusColor(status: string | undefined | null): string {
  switch (status) {
    case 'destroyed':
      return '#1c2733';
    case 'likely_destroyed':
      return '#7a2e2e';
    case 'revisit':
      return '#eab308';
    case 'ground_followup':
      return '#3b82f6';
    case 'complete':
      return '#16a34a';
    default:
      return '#94a3b8';
  }
}

function closureColor(status: string | undefined | null, closureType?: string | null): string {
  const s = (status || '').toLowerCase();
  if (s.includes('reopen') || s.includes('open') || s.includes('clear')) return '#16a34a';
  if (s.includes('partial') || s.includes('lane')) return '#eab308';
  if (closureType && /partial/i.test(closureType)) return '#eab308';
  return '#dc2626';
}

function roadStatusColor(status: string | undefined | null): string {
  const s = (status || '').toLowerCase();
  if (s.includes('open')) return '#16a34a';
  if (s.includes('closed') || s.includes('close')) return '#dc2626';
  if (s.includes('partial') || s.includes('caution')) return '#eab308';
  return '#6b7280';
}

function parseTs(v: unknown): number | null {
  if (typeof v !== 'string' && typeof v !== 'number') return null;
  const t = new Date(v).getTime();
  return Number.isFinite(t) ? t : null;
}

function recencyMs(r: Recency): number | null {
  if (r === '6h') return 6 * 3600 * 1000;
  if (r === '24h') return 24 * 3600 * 1000;
  return null;
}

function withinRecency(ts: unknown, r: Recency): boolean {
  const ms = recencyMs(r);
  if (ms == null) return true;
  const t = parseTs(ts);
  if (t == null) return true;
  return Date.now() - t <= ms;
}

function timeAgo(ts: unknown): string {
  const t = parseTs(ts);
  if (t == null) return 'unknown time';
  const diff = Math.max(0, Date.now() - t);
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} hr ago`;
  const days = Math.floor(hrs / 24);
  return `${days} d ago`;
}

function isStale(ts: unknown, thresholdMs = 3600 * 1000): boolean {
  const t = parseTs(ts);
  if (t == null) return true;
  return Date.now() - t > thresholdMs;
}

function buildPopup(
  title: string,
  rows: Array<[string, string]>,
): HTMLElement {
  const root = document.createElement('div');
  root.style.fontSize = '12px';
  root.style.lineHeight = '1.4';
  root.style.maxWidth = '240px';
  const h = document.createElement('div');
  h.style.fontWeight = '600';
  h.style.marginBottom = '4px';
  h.textContent = title;
  root.appendChild(h);
  for (const [k, v] of rows) {
    if (!v) continue;
    const line = document.createElement('div');
    const kk = document.createElement('span');
    kk.style.color = '#6b7280';
    kk.textContent = `${k}: `;
    const vv = document.createElement('span');
    vv.textContent = v;
    line.appendChild(kk);
    line.appendChild(vv);
    root.appendChild(line);
  }
  return root;
}

function escapeText(v: unknown): string {
  if (v == null) return '';
  return String(v);
}

/** Short display ID for map labels, e.g. "SC-1892" -> "1892". */
function shortAssetId(assetId: string): string {
  const dash = assetId.indexOf('-');
  return dash >= 0 ? assetId.slice(dash + 1) : assetId;
}

/** NBI 0-9 condition rating -> color. */
function ratingColor(r: string | null | undefined): string {
  if (r == null || r === '' || r === 'N') return '#6b7280';
  const n = parseInt(r, 10);
  if (Number.isNaN(n)) return '#6b7280';
  if (n >= 7) return '#16a34a';
  if (n >= 5) return '#eab308';
  return '#dc2626';
}

export default function TeamMap({
  focusBridge,
  showTeam = false,
  showLocate = false,
  position = null,
  height = '60dvh',
  onBridgeClick,
  onStartInspection,
  onGetDirections,
}: TeamMapProps) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const initRef = useRef<boolean>(false);
  const gpsMarkerRef = useRef<maplibregl.Marker | null>(null);
  const focusMarkerRef = useRef<maplibregl.Marker | null>(null);
  const routeSourceIdRef = useRef<string | null>(null);
  const [recency, setRecency] = useState<Recency>('all');
  const [styleError, setStyleError] = useState<boolean>(false);
  const [ready, setReady] = useState<boolean>(false);
  const [selected, setSelected] = useState<Bridge | null>(null);
  const dataRef = useRef<{
    bridges: Bridge[];
    roadblocks: Roadblock[];
    statusPins: RoadStatusPin[];
    paths: PathTrack[];
    team: TeamPosition[];
    triageByAsset: Map<string, string>;
  }>({
    bridges: [],
    roadblocks: [],
    statusPins: [],
    paths: [],
    team: [],
    triageByAsset: new Map(),
  });

  const onBridgeClickRef = useRef(onBridgeClick);
  useEffect(() => {
    onBridgeClickRef.current = onBridgeClick;
  }, [onBridgeClick]);

  // Ref so the one-time map click handler can open the info sheet with
  // the latest state setter and full bridge lookup.
  const selectBridgeRef = useRef<(b: Bridge) => void>(() => {});
  useEffect(() => {
    selectBridgeRef.current = (b: Bridge) => setSelected(b);
  });

  const focusBridgeRef = useRef(focusBridge);
  useEffect(() => {
    focusBridgeRef.current = focusBridge ?? null;
  }, [focusBridge]);

  // Init map once
  useEffect(() => {
    if (!wrapRef.current) return;
    if (initRef.current) return;
    initRef.current = true;

    let cancelled = false;
    const wrap = wrapRef.current;

    (async () => {
      let style: string | maplibregl.StyleSpecification;
      try {
        const provider = createTilePackProvider();
        const s = await provider.getStyle();
        style = s as string | maplibregl.StyleSpecification;
      } catch {
        style = {
          version: 8,
          sources: {},
          layers: [
            {
              id: 'bg',
              type: 'background',
              paint: { 'background-color': '#0b1220' },
            },
          ],
        };
        setStyleError(true);
      }

      if (cancelled) return;

      const fb = focusBridgeRef.current;
      const center: [number, number] = fb
        ? [fb.lon, fb.lat]
        : SC_CENTER;
      const zoom = fb ? 13 : 6.5;

      let map: maplibregl.Map;
      try {
        map = new maplibregl.Map({
          container: wrap,
          style: style as maplibregl.StyleSpecification | string,
          center,
          zoom,
          attributionControl: { compact: true },
        });
      } catch {
        setStyleError(true);
        return;
      }

      mapRef.current = map;

      // Locate-me button (field app)
      if (showLocate) {
        map.addControl(
          new maplibregl.GeolocateControl({
            positionOptions: { enableHighAccuracy: true },
            trackUserLocation: false,
            showUserLocation: true,
          }),
          'bottom-right'
        );
      }

      map.on('error', (e) => {
        const err = (e as unknown as { error?: Error }).error;
        if (err) setStyleError(true);
      });

      map.on('load', () => {
        if (cancelled) return;
        setReady(true);

        // Bridges source + layer
        map.addSource('bridges', {
          type: 'geojson',
          data: { type: 'FeatureCollection', features: [] },
        });
        map.addLayer({
          id: 'bridges-circle',
          type: 'circle',
          source: 'bridges',
          paint: {
            'circle-radius': [
              'interpolate',
              ['linear'],
              ['zoom'],
              5,
              2.5,
              10,
              5,
              14,
              8,
            ],
            'circle-color': ['get', 'color'],
            'circle-stroke-color': '#0b1220',
            'circle-stroke-width': 0.6,
          },
        });

        map.on('click', 'bridges-circle', (ev) => {
          const f = ev.features && ev.features[0];
          if (!f) return;
          const props = (f.properties || {}) as { asset_id?: string };
          if (!props.asset_id) return;
          if (onBridgeClickRef.current) {
            onBridgeClickRef.current(props.asset_id);
            return;
          }
          // No external handler (field app): open the built-in info sheet.
          const b = dataRef.current.bridges.find(
            (x) => x.asset_id === props.asset_id,
          );
          if (b) selectBridgeRef.current(b);
        });
        map.on('mouseenter', 'bridges-circle', () => {
          map.getCanvas().style.cursor = 'pointer';
        });
        map.on('mouseleave', 'bridges-circle', () => {
          map.getCanvas().style.cursor = '';
        });

        // Bridge number labels — symbol layer, only at high zoom to avoid clutter.
        map.addLayer({
          id: 'bridges-label',
          type: 'symbol',
          source: 'bridges',
          minzoom: 11,
          layout: {
            'text-field': ['get', 'label'],
            'text-size': 11,
            'text-font': ['Open Sans Regular', 'Noto Sans Regular'],
            'text-anchor': 'bottom',
            'text-offset': [0, -0.9],
            'text-allow-overlap': false,
            'text-ignore-placement': false,
            'text-padding': 2,
          },
          paint: {
            'text-color': '#e2e8f0',
            'text-halo-color': '#0b1220',
            'text-halo-width': 1.5,
          },
        });

        // Roadblocks source + layer
        map.addSource('roadblocks', {
          type: 'geojson',
          data: { type: 'FeatureCollection', features: [] },
        });
        map.addLayer({
          id: 'roadblocks-circle',
          type: 'circle',
          source: 'roadblocks',
          paint: {
            'circle-radius': [
              'interpolate',
              ['linear'],
              ['zoom'],
              5,
              3,
              10,
              5,
              14,
              8,
            ],
            'circle-color': ['get', 'color'],
            'circle-stroke-color': '#0b1220',
            'circle-stroke-width': 0.8,
          },
        });

        map.on('click', 'roadblocks-circle', (ev) => {
          const f = ev.features && ev.features[0];
          if (!f) return;
          const p = (f.properties || {}) as Record<string, unknown>;
          const coords =
            f.geometry && f.geometry.type === 'Point'
              ? (f.geometry.coordinates as [number, number])
              : null;
          if (!coords) return;
          const popup = new maplibregl.Popup({ closeButton: true })
            .setLngLat(coords)
            .setDOMContent(
              buildPopup(escapeText(p.road_name) || 'Roadblock', [
                ['Closure', escapeText(p.closure_type)],
                ['Status', escapeText(p.status)],
                ['Reporter', escapeText(p.reporter)],
                ['Reported', timeAgo(p.reported_at)],
              ]),
            )
            .addTo(map);
          void popup;
        });
        map.on('mouseenter', 'roadblocks-circle', () => {
          map.getCanvas().style.cursor = 'pointer';
        });
        map.on('mouseleave', 'roadblocks-circle', () => {
          map.getCanvas().style.cursor = '';
        });

        // Road status pins source + layer
        map.addSource('status_pins', {
          type: 'geojson',
          data: { type: 'FeatureCollection', features: [] },
        });
        map.addLayer({
          id: 'status_pins-square',
          type: 'circle',
          source: 'status_pins',
          paint: {
            'circle-radius': [
              'interpolate',
              ['linear'],
              ['zoom'],
              5,
              2,
              10,
              4,
              14,
              6,
            ],
            'circle-color': ['get', 'color'],
            'circle-stroke-color': '#0b1220',
            'circle-stroke-width': 0.8,
          },
        });

        // Paths source + layer
        map.addSource('paths', {
          type: 'geojson',
          data: { type: 'FeatureCollection', features: [] },
        });
        map.addLayer({
          id: 'paths-line',
          type: 'line',
          source: 'paths',
          paint: {
            'line-color': '#16a34a',
            'line-width': 1.5,
            'line-opacity': 0.85,
          },
        });

        // Team source + layer
        map.addSource('team', {
          type: 'geojson',
          data: { type: 'FeatureCollection', features: [] },
        });
        map.addLayer({
          id: 'team-circle',
          type: 'circle',
          source: 'team',
          paint: {
            'circle-radius': [
              'interpolate',
              ['linear'],
              ['zoom'],
              5,
              4,
              10,
              7,
              14,
              10,
            ],
            'circle-color': ['get', 'color'],
            'circle-stroke-color': '#0b1220',
            'circle-stroke-width': 1,
          },
        });
        map.addLayer({
          id: 'team-label',
          type: 'symbol',
          source: 'team',
          layout: {
            'text-field': ['get', 'initial'],
            'text-size': 10,
            'text-font': ['Open Sans Regular', 'Noto Sans Regular'],
            'text-allow-overlap': true,
          },
          paint: {
            'text-color': '#ffffff',
          },
        });

        map.on('click', 'team-circle', (ev) => {
          const f = ev.features && ev.features[0];
          if (!f) return;
          const p = (f.properties || {}) as Record<string, unknown>;
          const coords =
            f.geometry && f.geometry.type === 'Point'
              ? (f.geometry.coordinates as [number, number])
              : null;
          if (!coords) return;
          new maplibregl.Popup({ closeButton: true })
            .setLngLat(coords)
            .setDOMContent(
              buildPopup(escapeText(p.inspector) || 'Team member', [
                ['Updated', timeAgo(p.updated_at)],
                ['Assignment', escapeText(p.assignment)],
                ['Completed', escapeText(p.completed_count)],
                ['Pending', escapeText(p.pending_count)],
              ]),
            )
            .addTo(map);
        });
        map.on('mouseenter', 'team-circle', () => {
          map.getCanvas().style.cursor = 'pointer';
        });
        map.on('mouseleave', 'team-circle', () => {
          map.getCanvas().style.cursor = '';
        });

        // Route source (focus bridge dashed route)
        map.addSource('route', {
          type: 'geojson',
          data: { type: 'FeatureCollection', features: [] },
        });
        map.addLayer({
          id: 'route-line',
          type: 'line',
          source: 'route',
          paint: {
            'line-color': '#3b82f6',
            'line-width': 2,
            'line-dasharray': [2, 2],
            'line-opacity': 0.8,
          },
        });
        routeSourceIdRef.current = 'route';
      });
    })();

    return () => {
      cancelled = true;
      const map = mapRef.current;
      if (map) {
        try {
          map.remove();
        } catch {
          // ignore
        }
      }
      mapRef.current = null;
      gpsMarkerRef.current = null;
      focusMarkerRef.current = null;
      initRef.current = false;
    };
  }, []);

  // Data fetch
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const store = dataRef.current;

      // Cached bridges
      try {
        const cached = (await idbGetAll('bridges')) as Bridge[];
        if (!cancelled && Array.isArray(cached)) {
          store.bridges = cached;
        }
      } catch {
        // ignore
      }

      if (!isOnline() || !isSupabaseConfigured()) {
        applyLayers();
        return;
      }

      const supabase = getSupabase();
      if (!supabase) {
        applyLayers();
        return;
      }

      // Inspections
      try {
        const { data } = await supabase
          .from('emg_inspections')
          .select('asset_id,triage_list,inspection_datetime')
          .order('inspection_datetime', { ascending: false })
          .limit(5000);
        if (!cancelled && Array.isArray(data)) {
          const map = new Map<string, string>();
          for (const row of data as Array<{
            asset_id?: string;
            triage_list?: string;
            inspection_datetime?: string;
          }>) {
            if (
              row.asset_id &&
              !map.has(row.asset_id) &&
              typeof row.triage_list === 'string'
            ) {
              map.set(row.asset_id, row.triage_list);
            }
          }
          store.triageByAsset = map;
        }
      } catch {
        // ignore
      }

      // Bridges (if cache empty)
      if (!store.bridges || store.bridges.length === 0) {
        try {
          const { data } = await supabase
            .from('emg_bridges')
            .select('asset_id,lon,lat,bridge_cond')
            .limit(2000);
          if (!cancelled && Array.isArray(data)) {
            store.bridges = (data as Array<{
              asset_id?: string;
              lon?: number;
              lat?: number;
              bridge_cond?: string;
            }>)
              .filter(
                (b) =>
                  b.asset_id != null &&
                  b.lon != null &&
                  b.lat != null,
              )
              .map(
                (b) =>
                  ({
                    asset_id: String(b.asset_id),
                    lon: Number(b.lon),
                    lat: Number(b.lat),
                    bridge_cond: b.bridge_cond,
                  }) as unknown as Bridge,
              );
          }
        } catch {
          // ignore
        }
      }

      // Roadblocks
      try {
        const { data } = await supabase
          .from('emg_roadblocks')
          .select(
            'id,road_name,closure_type,status,reporter,reported_at,reopened_at,reopened_by,notes,lon,lat',
          )
          .limit(2000);
        if (!cancelled && Array.isArray(data)) {
          store.roadblocks = data as unknown as Roadblock[];
        }
      } catch {
        // ignore
      }

      // Road statuses
      try {
        const { data } = await supabase
          .from('emg_road_statuses')
          .select('id,status,reporter,reported_at,notes,lon,lat')
          .limit(2000);
        if (!cancelled && Array.isArray(data)) {
          store.statusPins = data as unknown as RoadStatusPin[];
        }
      } catch {
        // ignore
      }

      // Path tracks
      try {
        const { data } = await supabase
          .from('emg_path_tracks')
          .select('id,inspector,geojson')
          .limit(1000);
        if (!cancelled && Array.isArray(data)) {
          store.paths = data as unknown as PathTrack[];
        }
      } catch {
        // ignore
      }

      // Team
      if (showTeam) {
        try {
          const { data } = await supabase
            .from('emg_team_positions')
            .select(
              'inspector,lon,lat,updated_at,assignment,completed_count,pending_count',
            )
            .limit(500);
          if (!cancelled && Array.isArray(data)) {
            store.team = data as unknown as TeamPosition[];
          }
        } catch {
          // ignore
        }
      }

      applyLayers();
    })();

    function applyLayers() {
      const map = mapRef.current;
      if (!map || !ready) return;
      const store = dataRef.current;
      const sel = recency;

      // Bridges
      const bridgeFeatures = store.bridges
        .filter(
          (b) =>
            typeof b.lon === 'number' &&
            typeof b.lat === 'number' &&
            Number.isFinite(b.lon) &&
            Number.isFinite(b.lat),
        )
        .map((b) => {
          const triage = store.triageByAsset.get(b.asset_id);
          const color = statusColor(triage);
          return {
            type: 'Feature' as const,
            geometry: {
              type: 'Point' as const,
              coordinates: [b.lon, b.lat] as [number, number],
            },
            properties: {
              asset_id: b.asset_id,
              label: shortAssetId(b.asset_id),
              color,
            },
          };
        });
      const bSrc = map.getSource('bridges') as
        | maplibregl.GeoJSONSource
        | undefined;
      if (bSrc) {
        bSrc.setData({
          type: 'FeatureCollection',
          features: bridgeFeatures,
        });
      }

      // Roadblocks
      const roadblockFeatures = store.roadblocks
        .filter((r) => withinRecency(r.reported_at, sel))
        .map((r) => {
          const lon =
            typeof r.lon === 'number'
              ? r.lon
              : null;
          const lat =
            typeof r.lat === 'number'
              ? r.lat
              : null;
          if (lon == null || lat == null) return null;
          if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
          return {
            type: 'Feature' as const,
            geometry: {
              type: 'Point' as const,
              coordinates: [lon, lat] as [number, number],
            },
            properties: {
              road_name: r.road_name ?? '',
              closure_type: r.closure_type ?? '',
              status: r.status ?? '',
              reporter: r.reporter ?? '',
              reported_at: r.reported_at ?? '',
              color: closureColor(r.status, r.closure_type),
            },
          };
        })
        .filter((x): x is NonNullable<typeof x> => x != null);
      const rbSrc = map.getSource('roadblocks') as
        | maplibregl.GeoJSONSource
        | undefined;
      if (rbSrc) {
        rbSrc.setData({
          type: 'FeatureCollection',
          features: roadblockFeatures,
        });
      }

      // Status pins
      const statusFeatures = store.statusPins
        .filter((p) => withinRecency(p.reported_at, sel))
        .map((p) => {
          const lon = p.lon;
          const lat = p.lat;
          if (
            typeof lon !== 'number' ||
            typeof lat !== 'number' ||
            !Number.isFinite(lon) ||
            !Number.isFinite(lat)
          )
            return null;
          return {
            type: 'Feature' as const,
            geometry: {
              type: 'Point' as const,
              coordinates: [lon, lat] as [number, number],
            },
            properties: {
              color: roadStatusColor(p.status),
            },
          };
        })
        .filter((x): x is NonNullable<typeof x> => x != null);
      const stSrc = map.getSource('status_pins') as
        | maplibregl.GeoJSONSource
        | undefined;
      if (stSrc) {
        stSrc.setData({
          type: 'FeatureCollection',
          features: statusFeatures,
        });
      }

      // Paths
      const pathFeatures: GeoJSON.Feature[] = [];
      for (const p of store.paths) {
        const raw = p.geojson;
        if (!raw) continue;
        let geom: GeoJSON.Geometry | null = null;
        if (typeof raw === 'string') {
          try {
            geom = JSON.parse(raw) as GeoJSON.Geometry;
          } catch {
            geom = null;
          }
        } else {
          geom = raw as GeoJSON.Geometry;
        }
        if (!geom) continue;
        pathFeatures.push({
          type: 'Feature',
          geometry: geom,
          properties: {
            id: p.id,
            inspector: p.inspector,
          },
        });
      }
      const pSrc = map.getSource('paths') as
        | maplibregl.GeoJSONSource
        | undefined;
      if (pSrc) {
        pSrc.setData({
          type: 'FeatureCollection',
          features: pathFeatures,
        });
      }

      // Team
      const teamFeatures = showTeam
        ? store.team
            .filter((t) => withinRecency(t.updated_at, sel))
            .map((t) => {
              const lon = t.lon;
              const lat = t.lat;
              if (
                typeof lon !== 'number' ||
                typeof lat !== 'number' ||
                !Number.isFinite(lon) ||
                !Number.isFinite(lat)
              )
                return null;
              const stale = isStale(t.updated_at);
              const initial = (t.inspector || '?')
                .trim()
                .charAt(0)
                .toUpperCase();
              return {
                type: 'Feature' as const,
                geometry: {
                  type: 'Point' as const,
                  coordinates: [lon, lat] as [number, number],
                },
                properties: {
                  inspector: t.inspector ?? '',
                  assignment: t.assignment ?? '',
                  completed_count: t.completed_count ?? '',
                  pending_count: t.pending_count ?? '',
                  updated_at: t.updated_at ?? '',
                  initial,
                  color: stale ? '#94a3b8' : '#0ea5e9',
                },
              };
            })
            .filter((x): x is NonNullable<typeof x> => x != null)
        : [];
      const tSrc = map.getSource('team') as
        | maplibregl.GeoJSONSource
        | undefined;
      if (tSrc) {
        tSrc.setData({
          type: 'FeatureCollection',
          features: teamFeatures,
        });
      }
    }

    return () => {
      cancelled = true;
    };
  }, [ready, recency, showTeam]);

  // Focus bridge marker + route
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;

    const fb = focusBridge ?? null;

    // Remove prior focus marker
    if (focusMarkerRef.current) {
      focusMarkerRef.current.remove();
      focusMarkerRef.current = null;
    }

    // Remove prior route
    const routeSrc = map.getSource('route') as
      | maplibregl.GeoJSONSource
      | undefined;
    if (routeSrc) {
      routeSrc.setData({
        type: 'FeatureCollection',
        features: [],
      });
    }

    if (!fb) return;

    // Fit view
    try {
      map.flyTo({
        center: [fb.lon, fb.lat],
        zoom: 14,
        essential: true,
      });
    } catch {
      // ignore
    }

    // Highlight marker
    const el = document.createElement('div');
    el.style.width = '18px';
    el.style.height = '18px';
    el.style.borderRadius = '50%';
    el.style.background = '#f97316';
    el.style.border = '2px solid #ffffff';
    el.style.boxShadow = '0 0 0 4px rgba(249,115,22,0.25)';
    const marker = new maplibregl.Marker({ element: el })
      .setLngLat([fb.lon, fb.lat])
      .addTo(map);
    focusMarkerRef.current = marker;

    // Route line
    if (position && routeSrc) {
      routeSrc.setData({
        type: 'FeatureCollection',
        features: [
          {
            type: 'Feature',
            geometry: {
              type: 'LineString',
              coordinates: [
                [position.lon, position.lat],
                [fb.lon, fb.lat],
              ],
            },
            properties: {},
          },
        ],
      });
    }
  }, [focusBridge, ready, position]);

  // GPS dot
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;

    if (gpsMarkerRef.current) {
      gpsMarkerRef.current.remove();
      gpsMarkerRef.current = null;
    }

    if (!position) return;

    const el = document.createElement('div');
    el.className = 'gps-dot';
    el.style.width = '14px';
    el.style.height = '14px';
    el.style.borderRadius = '50%';
    el.style.background = '#2563eb';
    el.style.border = '2px solid #ffffff';
    el.style.boxShadow = '0 0 0 0 rgba(37,99,235,0.7)';
    el.style.animation = 'gpsPulse 2s infinite';

    const marker = new maplibregl.Marker({ element: el })
      .setLngLat([position.lon, position.lat])
      .addTo(map);
    gpsMarkerRef.current = marker;
  }, [position, ready]);

  return (
    <div
      className="team-map"
      style={{
        position: 'relative',
        width: '100%',
        height,
        overflow: 'hidden',
      }}
    >
      <div
        ref={wrapRef}
        className="map-wrap"
        style={{ position: 'absolute', inset: 0 }}
      />

      {/* Recency filter overlay */}
      <div
        style={{
          position: 'absolute',
          top: 8,
          right: 8,
          zIndex: 5,
          background: 'rgba(15,23,42,0.85)',
          color: '#e2e8f0',
          padding: '4px 6px',
          borderRadius: 6,
          fontSize: 12,
        }}
      >
        <label
          htmlFor="team-map-recency"
          style={{ marginRight: 6 }}
        >
          Recency
        </label>
        <select
          id="team-map-recency"
          value={recency}
          onChange={(e) => setRecency(e.target.value as Recency)}
          style={{
            background: 'transparent',
            color: 'inherit',
            border: '1px solid #334155',
            borderRadius: 4,
            padding: '2px 4px',
          }}
        >
          <option value="6h">6h</option>
          <option value="24h">24h</option>
          <option value="all">All</option>
        </select>
      </div>

      {/* Legend */}
      <div
        style={{
          position: 'absolute',
          bottom: 8,
          left: 8,
          zIndex: 5,
          background: 'rgba(15,23,42,0.85)',
          color: '#e2e8f0',
          padding: '6px 10px',
          borderRadius: 6,
          fontSize: 11,
          lineHeight: 1.5,
          pointerEvents: 'none',
        }}
      >
        <div style={{ fontWeight: 600, marginBottom: 3 }}>Legend</div>
        {[
          ['#1c2733', 'Destroyed'],
          ['#7a2e2e', 'Likely destroyed'],
          ['#eab308', 'Revisit / partial'],
          ['#3b82f6', 'Ground follow-up / GPS'],
          ['#16a34a', 'Complete / passable'],
          ['#94a3b8', 'Not started'],
          ['#dc2626', 'Roadblock (active)'],
          ['#0ea5e9', 'Team active'],
        ].map(([c, label]) => (
          <div key={label} style={{ display: 'flex', alignItems: 'center' }}>
            <span
              style={{
                display: 'inline-block',
                width: 10,
                height: 10,
                borderRadius: 2,
                background: c,
                marginRight: 6,
              }}
            />
            <span>{label}</span>
          </div>
        ))}
      </div>

      {styleError && (
        <div
          className="err-box"
          style={{
            position: 'absolute',
            top: 8,
            left: 8,
            zIndex: 5,
            background: 'rgba(153,27,27,0.9)',
            color: '#fee2e2',
            padding: '6px 10px',
            borderRadius: 6,
            fontSize: 12,
            maxWidth: 260,
          }}
        >
          Map tiles unavailable offline — GPS and data layers still work.
        </div>
      )}

      {/* Bridge info bottom sheet (field app tap-to-inspect) */}
      {selected && (
        <>
          <div
            onClick={() => setSelected(null)}
            aria-hidden
            style={{
              position: 'absolute',
              inset: 0,
              zIndex: 9,
              background: 'rgba(0,0,0,0.25)',
            }}
          />
          <div
            role="dialog"
            aria-modal="true"
            aria-label={`Bridge ${selected.asset_id}`}
            style={{
              position: 'absolute',
              left: 0,
              right: 0,
              bottom: 0,
              zIndex: 10,
              display: 'flex',
              justifyContent: 'center',
              pointerEvents: 'none',
            }}
          >
            <div
              style={{
                pointerEvents: 'auto',
                width: '100%',
                maxWidth: 560,
                maxHeight: '55%',
                overflowY: 'auto',
                background: '#0f172a',
                color: '#e2e8f0',
                borderTopLeftRadius: 16,
                borderTopRightRadius: 16,
                padding: '8px 16px calc(12px + env(safe-area-inset-bottom))',
                boxShadow: '0 -4px 24px rgba(0,0,0,0.5)',
              }}
            >
              <div
                aria-hidden
                style={{
                  width: 40,
                  height: 4,
                  borderRadius: 2,
                  background: '#334155',
                  margin: '4px auto 10px',
                }}
              />
              <div
                style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  justifyContent: 'space-between',
                  gap: 12,
                }}
              >
                <div>
                  <div style={{ fontSize: 18, fontWeight: 700 }}>
                    {selected.asset_id}
                  </div>
                  <div style={{ fontSize: 13, color: '#94a3b8', marginTop: 2 }}>
                    {[selected.facility, selected.feature]
                      .filter(Boolean)
                      .join(' over ') || '—'}
                  </div>
                  <div style={{ fontSize: 13, color: '#94a3b8' }}>
                    {selected.county_name ?? selected.county ?? '—'}
                    {selected.yr_built ? ` · Built ${selected.yr_built}` : ''}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setSelected(null)}
                  aria-label="Close bridge details"
                  style={{
                    flex: '0 0 auto',
                    background: 'transparent',
                    border: '1px solid #334155',
                    color: '#e2e8f0',
                    borderRadius: 8,
                    width: 36,
                    height: 36,
                    fontSize: 18,
                    cursor: 'pointer',
                  }}
                >
                  ×
                </button>
              </div>

              <div
                style={{
                  display: 'flex',
                  gap: 12,
                  marginTop: 10,
                  fontSize: 13,
                }}
              >
                {(
                  [
                    ['Deck', selected.deck],
                    ['Super', selected.super],
                    ['Sub', selected.sub],
                  ] as Array<[string, string | null]>
                ).map(([label, val]) => (
                  <div
                    key={label}
                    style={{
                      flex: 1,
                      background: '#1e293b',
                      borderRadius: 8,
                      padding: '8px 10px',
                      textAlign: 'center',
                    }}
                  >
                    <div style={{ fontSize: 11, color: '#94a3b8' }}>{label}</div>
                    <div
                      style={{
                        fontSize: 18,
                        fontWeight: 700,
                        color: ratingColor(val),
                      }}
                    >
                      {val ?? '—'}
                    </div>
                  </div>
                ))}
              </div>

              <div
                style={{
                  display: 'flex',
                  gap: 8,
                  marginTop: 12,
                }}
              >
                {onStartInspection && (
                  <button
                    type="button"
                    onClick={() => {
                      const b = selected;
                      setSelected(null);
                      onStartInspection(b);
                    }}
                    style={{
                      flex: 1,
                      minHeight: 48,
                      borderRadius: 10,
                      border: 'none',
                      background: '#16a34a',
                      color: '#fff',
                      fontSize: 15,
                      fontWeight: 700,
                      cursor: 'pointer',
                    }}
                  >
                    Start Inspection
                  </button>
                )}
                {onGetDirections && (
                  <button
                    type="button"
                    onClick={() => {
                      const b = selected;
                      setSelected(null);
                      onGetDirections(b);
                    }}
                    style={{
                      flex: 1,
                      minHeight: 48,
                      borderRadius: 10,
                      border: '1px solid #334155',
                      background: '#1e293b',
                      color: '#e2e8f0',
                      fontSize: 15,
                      fontWeight: 600,
                      cursor: 'pointer',
                    }}
                  >
                    Get Directions
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => setSelected(null)}
                  style={{
                    minHeight: 48,
                    padding: '0 18px',
                    borderRadius: 10,
                    border: '1px solid #334155',
                    background: 'transparent',
                    color: '#94a3b8',
                    fontSize: 15,
                    cursor: 'pointer',
                  }}
                >
                  Close
                </button>
              </div>
            </div>
          </div>
        </>
      )}

      <style>{`
        @keyframes gpsPulse {
          0% { box-shadow: 0 0 0 0 rgba(37,99,235,0.7); }
          70% { box-shadow: 0 0 0 12px rgba(37,99,235,0); }
          100% { box-shadow: 0 0 0 0 rgba(37,99,235,0); }
        }
      `}</style>
    </div>
  );
}
