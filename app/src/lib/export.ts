// One-click GeoJSON + CSV export, shaped for ArcGIS/Survey123 import.
// Field names mirror EmergencyBridgeInspection_XLSForm.xlsx.
import type { InspectionDraft, Roadblock } from '../types';

const INSPECTION_COLUMNS = [
  'inspection_id', 'asset_id', 'inspector_name', 'inspection_datetime',
  'destroyed', 'access', 'drone_used', 'bridge_still_there', 'triage_list',
  'overtopped', 'overtop_depth_ft',
  'damage_rail', 'damage_deck', 'damage_super', 'damage_sub', 'washout_abutment',
  'remain_open', 'remain_open_notes', 'safe_load', 'safe_load_notes',
  'debris_amount', 'coord_mismatch',
  'gps_lat', 'gps_lon', 'lon', 'lat',
  'photo_count', 'sync_status',
] as const;

function inspectionRow(d: InspectionDraft): Record<string, string | number | null> {
  return {
    inspection_id: d.client_inspection_id,
    asset_id: d.asset_id,
    inspector_name: d.inspector_name,
    inspection_datetime: d.inspection_datetime,
    destroyed: d.destroyed,
    access: d.access,
    drone_used: d.drone_used,
    bridge_still_there: d.bridge_still_there,
    triage_list: d.triage_list,
    overtopped: d.overtopped,
    overtop_depth_ft: d.overtop_depth_ft,
    damage_rail: d.damage_rail,
    damage_deck: d.damage_deck,
    damage_super: d.damage_super,
    damage_sub: d.damage_sub,
    washout_abutment: d.washout_abutment,
    remain_open: d.remain_open,
    remain_open_notes: d.remain_open_notes || null,
    safe_load: d.safe_load,
    safe_load_notes: d.safe_load_notes || null,
    debris_amount: d.debris_amount,
    coord_mismatch: d.coord_mismatch,
    gps_lat: d.gps_lat,
    gps_lon: d.gps_lon,
    lon: d.gps_lon,
    lat: d.gps_lat,
    photo_count: d.photos.length,
    sync_status: d.sync_status,
  };
}

export function inspectionsToGeoJSON(drafts: InspectionDraft[]): GeoJSON.FeatureCollection {
  const features = drafts.map((d) => ({
    type: 'Feature' as const,
    geometry:
      d.gps_lon != null && d.gps_lat != null
        ? ({ type: 'Point' as const, coordinates: [d.gps_lon, d.gps_lat] } as GeoJSON.Geometry)
        : null,
    properties: inspectionRow(d) as GeoJSON.GeoJsonProperties,
  }));
  return { type: 'FeatureCollection', features: features as GeoJSON.Feature[] };
}

function csvCell(v: string | number | null): string {
  if (v == null) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function inspectionsToCsv(drafts: InspectionDraft[]): string {
  const rows = drafts.map(inspectionRow);
  const head = INSPECTION_COLUMNS.join(',');
  const lines = rows.map((r) =>
    INSPECTION_COLUMNS.map((c) => csvCell(r[c] ?? null)).join(','),
  );
  return [head, ...lines].join('\n');
}

const ROADBLOCK_COLUMNS = [
  'roadblock_id', 'road_name', 'closure_type', 'status',
  'reporter', 'reported_at', 'reopened_at', 'reopened_by', 'notes', 'lon', 'lat',
] as const;

export function roadblocksToGeoJSON(blocks: Roadblock[]): GeoJSON.FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: blocks.map((b) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [b.lon, b.lat] },
      properties: {
        roadblock_id: b.id,
        road_name: b.road_name,
        closure_type: b.closure_type,
        status: b.status,
        reporter: b.reporter,
        reported_at: b.reported_at,
        reopened_at: b.reopened_at,
        reopened_by: b.reopened_by,
        notes: b.notes,
        lon: b.lon,
        lat: b.lat,
      },
    })),
  };
}

export function roadblocksToCsv(blocks: Roadblock[]): string {
  const head = ROADBLOCK_COLUMNS.join(',');
  const lines = blocks.map((b) =>
    ROADBLOCK_COLUMNS.map((c) =>
      csvCell(
        (({ roadblock_id: b.id, road_name: b.road_name, closure_type: b.closure_type,
            status: b.status, reporter: b.reporter, reported_at: b.reported_at,
            reopened_at: b.reopened_at, reopened_by: b.reopened_by,
            notes: b.notes, lon: b.lon, lat: b.lat } as Record<string, string | number | null>)[c] ?? null),
      ),
    ).join(','),
  );
  return [head, ...lines].join('\n');
}

export function downloadFile(filename: string, content: string, mime = 'application/octet-stream'): void {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
