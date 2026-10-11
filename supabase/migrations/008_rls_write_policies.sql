-- Migration 008: RLS write policies for field data tables.
--
-- The field app uses the anon key. Tables had RLS enabled with no INSERT/UPDATE
-- policies, so every inspection/roadblock/photo push failed with:
--   "new row violates row-level security policy"
--
-- HOW TO RUN: paste the entire file into the Supabase SQL editor
-- (Dashboard → SQL Editor → New query) and click Run.

-- emg_inspections: field app inserts/updates inspection records
drop policy if exists emg_inspections_insert on public.emg_inspections;
create policy emg_inspections_insert
  on public.emg_inspections for insert with check (true);

drop policy if exists emg_inspections_update on public.emg_inspections;
create policy emg_inspections_update
  on public.emg_inspections for update using (true) with check (true);

drop policy if exists emg_inspections_select on public.emg_inspections;
create policy emg_inspections_select
  on public.emg_inspections for select using (true);

-- emg_inspection_photos: field app inserts photo records
drop policy if exists emg_inspection_photos_insert on public.emg_inspection_photos;
create policy emg_inspection_photos_insert
  on public.emg_inspection_photos for insert with check (true);

drop policy if exists emg_inspection_photos_select on public.emg_inspection_photos;
create policy emg_inspection_photos_select
  on public.emg_inspection_photos for select using (true);

-- emg_roadblocks: field app inserts roadblock reports
drop policy if exists emg_roadblocks_insert on public.emg_roadblocks;
create policy emg_roadblocks_insert
  on public.emg_roadblocks for insert with check (true);

drop policy if exists emg_roadblocks_select on public.emg_roadblocks;
create policy emg_roadblocks_select
  on public.emg_roadblocks for select using (true);

-- emg_road_statuses: field app inserts road status pins
drop policy if exists emg_road_statuses_insert on public.emg_road_statuses;
create policy emg_road_statuses_insert
  on public.emg_road_statuses for insert with check (true);

drop policy if exists emg_road_statuses_select on public.emg_road_statuses;
create policy emg_road_statuses_select
  on public.emg_road_statuses for select using (true);

-- emg_path_tracks: field app inserts GPS path breadcrumbs
drop policy if exists emg_path_tracks_insert on public.emg_path_tracks;
create policy emg_path_tracks_insert
  on public.emg_path_tracks for insert with check (true);

drop policy if exists emg_path_tracks_select on public.emg_path_tracks;
create policy emg_path_tracks_select
  on public.emg_path_tracks for select using (true);

-- emg_team_positions: field app inserts/updates team location
drop policy if exists emg_team_positions_insert on public.emg_team_positions;
create policy emg_team_positions_insert
  on public.emg_team_positions for insert with check (true);

drop policy if exists emg_team_positions_update on public.emg_team_positions;
create policy emg_team_positions_update
  on public.emg_team_positions for update using (true) with check (true);

drop policy if exists emg_team_positions_select on public.emg_team_positions;
create policy emg_team_positions_select
  on public.emg_team_positions for select using (true);

-- Tell PostgREST to pick up the new policies immediately.
notify pgrst, 'reload schema';
