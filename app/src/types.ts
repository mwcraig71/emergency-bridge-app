// Shared types for the Emergency Bridge Inspection app.
// DB tables are emg_* prefixed (see supabase/migrations/001_emergency_app_schema.sql).

export type YesNo = 'yes' | 'no';

export type TriageList =
  | 'destroyed'
  | 'likely_destroyed'
  | 'revisit'
  | 'ground_followup'
  | 'in_progress'
  | 'complete';

export type OpenStatus = 'yes' | 'no' | 'restricted_lanes';
export type LoadStatus = 'yes' | 'no' | 'reduced_load';
export type DebrisAmount = 'none' | 'half_truck' | 'one_truck' | 'multiple' | 'six_plus';
export type ClosureType = 'fully_closed' | 'limited_traffic' | 'emergency_only';
export type RoadStatus = 'open' | 'closed' | 'partial' | 'unknown';

/** Bridge inventory record (emg_bridges). asset_id is TEXT (21 of 9,503 are alphanumeric). */
export interface Bridge {
  asset_id: string;
  struct_no: string;
  county: string | null;
  county_name: string | null;
  district: string | null; // '1'..'7'
  facility: string | null;
  feature: string | null;
  location: string | null;
  deck: string | null;
  super: string | null;
  sub: string | null;
  channel: string | null;
  culvert: string | null;
  struct_eval: string | null;
  deck_geom: string | null;
  scour: string | null;
  inv_rating: string | null;
  op_rating: string | null;
  posting: string | null;
  design_load: string | null;
  yr_built: number | null;
  yr_recon: number | null;
  length_m: number | null;
  max_span_m: number | null;
  spans: number | null;
  lanes: number | null;
  skew: number | null;
  adt: number | null;
  truck_pct: number | null;
  insp_freq: number | null;
  last_inspect: string | null;
  maint: string | null;
  owner: string | null;
  status: string | null;
  bridge_cond: string | null;
  lowest: string | null;
  span_mat: string | null;
  span_type: string | null;
  lon: number;
  lat: number;
}

export interface District {
  id: string;
  dist_label: string;
  geojson: GeoJSON.MultiPolygon;
}

/** Photo categories — never call downstation "reverse direction". */
export type PhotoType =
  | 'upstation'
  | 'profile'
  | 'downstation'
  | 'destroyed_profile'
  | 'destroyed_approach'
  | 'rail'
  | 'deck'
  | 'super'
  | 'sub'
  | 'washout'
  | 'condition'
  | 'debris'
  | 'roadblock';

export interface PhotoRef {
  id: string; // client-side uuid
  photo_type: PhotoType;
  description?: string; // required for condition/debris
  dataUrl?: string; // local preview (not persisted to server)
  storage_path?: string; // set after upload
  taken_at: string; // ISO
}

/** Local inspection draft — mirrors emg_inspections columns. */
export interface InspectionDraft {
  client_inspection_id: string;
  asset_id: string;
  inspector_name: string;
  inspection_datetime: string;
  device_id?: string;
  destroyed: YesNo | null;
  access: YesNo | null;
  drone_used: YesNo | null;
  bridge_still_there: YesNo | null;
  triage_list: TriageList;
  overtopped: YesNo | null;
  overtop_depth_ft: number | null;
  damage_rail: YesNo;
  damage_deck: YesNo;
  damage_super: YesNo;
  damage_sub: YesNo;
  washout_abutment: YesNo;
  remain_open: OpenStatus | null;
  remain_open_notes: string;
  safe_load: LoadStatus | null;
  safe_load_notes: string;
  debris_amount: DebrisAmount | null;
  gps_lat: number | null;
  gps_lon: number | null;
  coord_mismatch: YesNo | null;
  photos: PhotoRef[];
  sync_status: 'pending' | 'synced' | 'conflict';
  updated_at: string;
  /** Owning firm (multi-tenancy). Null = pre-firm legacy / no firm selected. */
  firm_id?: string | null;
}

export interface Roadblock {
  id: string;
  road_name: string;
  closure_type: ClosureType;
  lon: number;
  lat: number;
  reporter: string;
  reported_at: string;
  status: 'active' | 'reopened';
  reopened_at?: string | null;
  reopened_by?: string | null;
  notes: string | null;
}

/** Crash-resilience marker: tracks the inspection in progress so the app
 *  can offer to resume after a crash/power loss. Stored in the IndexedDB
 *  `settings` store under key 'active_session'. */
export interface ActiveSession {
  key: 'active_session';
  asset_id: string;
  bridge_info: Bridge;
  started_at: string; // ISO timestamp
  last_active: string; // ISO timestamp, updated every 30s during inspection
}

export interface RoadStatusPin {
  id: string;
  lon: number;
  lat: number;
  status: RoadStatus;
  reporter: string;
  reported_at: string;
  notes: string | null;
}

export interface PathTrack {
  id: string;
  inspector: string;
  geojson: GeoJSON.LineString;
  started_at: string;
  ended_at: string | null;
}

export interface TeamPosition {
  inspector: string;
  lon: number;
  lat: number;
  updated_at: string;
  assignment: string | null;
  completed_count: number;
  pending_count: number;
}

export interface SyncQueueItem {
  id: string;
  kind: 'inspection' | 'roadblock' | 'road_status' | 'track' | 'position' | 'photo';
  payload: unknown;
  attempts: number;
  created_at: string;
}

export type AssignmentStatus = 'assigned' | 'in_progress' | 'complete';

/** Loose bridge-to-inspector assignment (emg_assignments). */
export interface Assignment {
  id: string;
  asset_id: string;
  assigned_to: string;
  assigned_by: string | null;
  assigned_at: string;
  status: AssignmentStatus;
  completed_by: string | null;
  completed_at: string | null;
  notes: string | null;
  created_at: string;
  /** Owning firm (multi-tenancy). Null = pre-firm legacy / no firm selected. */
  firm_id?: string | null;
}

/** Inspector notification (emg_notifications). */
export interface AppNotification {
  id: string;
  recipient: string;
  type: string;
  title: string;
  message: string;
  related_asset_id: string | null;
  created_at: string;
  read_at: string | null;
  /** Owning firm (multi-tenancy). Null = pre-firm legacy / no firm selected. */
  firm_id?: string | null;
}

/** Firm (tenant). Firms receive groups of bridges and assign them to
 *  inspector teams within the firm. */
export interface Firm {
  id: string;
  name: string;
  created_at: string;
}

/** Inspector roster entry for a firm (inspectors table).
 *  pin_hash is never exposed to clients — roster syncs select explicit
 *  columns only (see lib/firm.ts). */
export interface Inspector {
  id: string;
  firm_id: string;
  name: string;
  created_at: string;
}

/** Bridge-to-firm membership (firm_bridges mapping table). Bridges are
 *  shared NBI data; firm ownership is a mapping, not a column. */
export interface FirmBridge {
  firm_id: string;
  asset_id: string;
  assigned_at: string;
}

/** Named bucket of bridges for bulk assignment (IndexedDB `buckets` store). */
export interface Bucket {
  id: string;
  name: string;
  state: 'SC' | 'NC';
  asset_ids: string[];
  /** asset_id -> inspector name (only bridges with an inspector assigned). */
  inspector_map: Record<string, string>;
  created_at: string;
}
