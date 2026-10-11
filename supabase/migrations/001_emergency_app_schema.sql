-- Emergency Bridge Inspection app — database migration 001
-- Project: Bridge Inspections (Supabase)
-- All tables are prefixed emg_ and live in the public schema.
-- Existing tables in this project are NOT touched by this migration.
--
-- HOW TO RUN: paste the entire file into the Supabase SQL editor
-- (Dashboard → SQL Editor → New query) and click Run.

-- PostGIS for spatial types (safe if already enabled)
create extension if not exists postgis;

-- ============================================================
-- emg_districts — SCDOT engineering district boundaries
-- ============================================================
create table if not exists public.emg_districts (
  id            text primary key,          -- '1'..'7'
  dist_label    text not null,             -- 'District 1' etc.
  geom          geometry(MultiPolygon, 4326) not null
);
create index if not exists emg_districts_geom_idx
  on public.emg_districts using gist (geom);

-- ============================================================
-- emg_bridges — SC bridge inventory (9,503 records, NBI-based)
-- ============================================================
create table if not exists public.emg_bridges (
  asset_id      integer primary key,       -- SCDOT Asset ID (struct_no stripped of leading zeros)
  struct_no     text not null,             -- 15-digit NBI STRUCTURE_NUMBER_008
  county        text,
  county_name   text,
  district      text,                      -- '1'..'7' → emg_districts.id
  facility      text,
  feature       text,
  location      text,
  deck          text,                      -- NBI deck condition rating
  super         text,                      -- superstructure rating
  sub           text,                      -- substructure rating
  channel       text,
  culvert       text,
  struct_eval   text,
  deck_geom     text,
  scour         text,
  inv_rating    text,
  op_rating     text,
  posting       text,
  design_load   text,
  yr_built      integer,
  yr_recon      integer,
  length_m      numeric,
  max_span_m    numeric,
  spans         integer,
  lanes         integer,
  skew          integer,
  adt           integer,
  truck_pct     numeric,
  insp_freq     integer,
  last_inspect  text,
  maint         text,
  owner         text,
  status        text,
  bridge_cond   text,
  lowest        text,
  span_mat      text,
  span_type     text,
  geom          geometry(Point, 4326) not null
);
create index if not exists emg_bridges_geom_idx
  on public.emg_bridges using gist (geom);
create index if not exists emg_bridges_struct_no_idx
  on public.emg_bridges (struct_no);
create index if not exists emg_bridges_district_idx
  on public.emg_bridges (district);

-- ============================================================
-- emg_inspections — field triage inspection records
-- Field names mirror EmergencyBridgeInspection_XLSForm.xlsx
-- ============================================================
create table if not exists public.emg_inspections (
  id                    uuid primary key default gen_random_uuid(),
  asset_id              integer not null references public.emg_bridges(asset_id),
  inspector_name        text not null,
  inspection_datetime   timestamptz not null default now(),
  device_id             text,

  -- triage branching
  destroyed             text not null check (destroyed in ('yes','no')),
  access                text check (access in ('yes','no')),
  drone_used            text check (drone_used in ('yes','no')),
  bridge_still_there    text check (bridge_still_there in ('yes','no')),
  triage_list           text not null default 'in_progress'
                        check (triage_list in ('destroyed','likely_destroyed',
                               'revisit','ground_followup','in_progress','complete')),

  -- water / damage
  overtopped            text check (overtopped in ('yes','no')),
  overtop_depth_ft      numeric check (overtop_depth_ft is null or overtop_depth_ft >= 0),
  damage_rail           text not null default 'no' check (damage_rail in ('yes','no')),
  damage_deck           text not null default 'no' check (damage_deck in ('yes','no')),
  damage_super          text not null default 'no' check (damage_super in ('yes','no')),
  damage_sub            text not null default 'no' check (damage_sub in ('yes','no')),
  washout_abutment      text not null default 'no' check (washout_abutment in ('yes','no')),

  -- open / load decisions
  remain_open           text check (remain_open in ('yes','no','restricted_lanes')),
  remain_open_notes     text,
  safe_load             text check (safe_load in ('yes','no','reduced_load')),
  safe_load_notes       text,
  debris_amount         text check (debris_amount in
                        ('none','half_truck','one_truck','multiple','six_plus')),

  -- GPS verification
  gps_lat               double precision,
  gps_lon               double precision,
  coord_mismatch        text check (coord_mismatch in ('yes','no')),

  -- sync bookkeeping
  sync_status           text not null default 'pending'
                        check (sync_status in ('pending','synced','conflict')),
  client_inspection_id  text,              -- dedupe key from device
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),

  unique (client_inspection_id)
);
create index if not exists emg_inspections_asset_idx
  on public.emg_inspections (asset_id);
create index if not exists emg_inspections_triage_idx
  on public.emg_inspections (triage_list);
create index if not exists emg_inspections_inspector_idx
  on public.emg_inspections (inspector_name);
create index if not exists emg_inspections_datetime_idx
  on public.emg_inspections (inspection_datetime);

-- ============================================================
-- emg_inspection_photos — photo metadata (files in Storage)
-- ============================================================
create table if not exists public.emg_inspection_photos (
  id              uuid primary key default gen_random_uuid(),
  inspection_id   uuid not null references public.emg_inspections(id) on delete cascade,
  photo_type      text not null,           -- upstation | profile | downstation |
                                             -- destroyed_profile | destroyed_approach |
                                             -- rail | deck | super | sub | washout |
                                             -- condition | roadblock | debris
  storage_path    text not null,           -- path in Supabase Storage bucket
  description     text,                    -- required for condition/debris types
  taken_at        timestamptz not null default now(),
  created_at      timestamptz not null default now()
);
create index if not exists emg_inspection_photos_inspection_idx
  on public.emg_inspection_photos (inspection_id);

-- ============================================================
-- emg_roadblocks — closure reports with open/reopen lifecycle
-- ============================================================
create table if not exists public.emg_roadblocks (
  id              uuid primary key default gen_random_uuid(),
  road_name       text not null,
  closure_type    text not null check (closure_type in
                  ('fully_closed','limited_traffic','emergency_only')),
  geom            geometry(Point, 4326) not null,
  reporter        text not null,
  reported_at     timestamptz not null default now(),
  status          text not null default 'active' check (status in ('active','reopened')),
  reopened_at     timestamptz,
  reopened_by     text,
  notes           text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists emg_roadblocks_geom_idx
  on public.emg_roadblocks using gist (geom);
create index if not exists emg_roadblocks_status_idx
  on public.emg_roadblocks (status);

-- ============================================================
-- emg_road_statuses — road status pins (open/closed/partial/unknown)
-- ============================================================
create table if not exists public.emg_road_statuses (
  id              uuid primary key default gen_random_uuid(),
  geom            geometry(Point, 4326) not null,
  status          text not null check (status in ('open','closed','partial','unknown')),
  reporter        text not null,
  reported_at     timestamptz not null default now(),
  notes           text,
  created_at      timestamptz not null default now()
);
create index if not exists emg_road_statuses_geom_idx
  on public.emg_road_statuses using gist (geom);

-- ============================================================
-- emg_path_tracks — inspector GPS breadcrumb trails
-- ============================================================
create table if not exists public.emg_path_tracks (
  id              uuid primary key default gen_random_uuid(),
  inspector       text not null,
  geom            geometry(LineString, 4326) not null,
  started_at      timestamptz not null,
  ended_at        timestamptz,
  created_at      timestamptz not null default now()
);
create index if not exists emg_path_tracks_geom_idx
  on public.emg_path_tracks using gist (geom);
create index if not exists emg_path_tracks_inspector_idx
  on public.emg_path_tracks (inspector);

-- ============================================================
-- emg_team_positions — last-known inspector locations
-- ============================================================
create table if not exists public.emg_team_positions (
  inspector         text primary key,
  geom              geometry(Point, 4326) not null,
  updated_at        timestamptz not null default now(),
  assignment        text,                  -- asset_id currently heading to
  completed_count   integer not null default 0,
  pending_count     integer not null default 0
);

-- ============================================================
-- Row Level Security: secret key bypasses RLS; enable it so the
-- publishable key gets deny-by-default until app policies are added.
-- ============================================================
alter table public.emg_districts         enable row level security;
alter table public.emg_bridges           enable row level security;
alter table public.emg_inspections       enable row level security;
alter table public.emg_inspection_photos enable row level security;
alter table public.emg_roadblocks        enable row level security;
alter table public.emg_road_statuses     enable row level security;
alter table public.emg_path_tracks       enable row level security;
alter table public.emg_team_positions    enable row level security;

-- Read-only public access to the static inventory (bridges + districts).
-- Inspection/ops tables stay writable only via the secret key until the
-- app's auth model is finalized.
create policy emg_public_read_bridges
  on public.emg_bridges for select using (true);
create policy emg_public_read_districts
  on public.emg_districts for select using (true);

-- updated_at auto-touch (run-once migration: no DROP statements)
create or replace function public.emg_touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

create trigger emg_inspections_touch
  before update on public.emg_inspections
  for each row execute function public.emg_touch_updated_at();

create trigger emg_roadblocks_touch
  before update on public.emg_roadblocks
  for each row execute function public.emg_touch_updated_at();
