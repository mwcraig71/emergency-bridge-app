-- ============================================================
-- 013_team_positions.sql — live team position sharing
--
-- The emg_team_positions table already exists from 001 (inspector PK,
-- geom, assignment, completed/pending counts; lon/lat generated in 006).
-- This migration adds the live-sharing columns. Old columns are kept for
-- backwards compatibility; the broadcaster writes both.
--
-- STALENESS CONTRACT: readers must treat positions older than 15 minutes
-- as stale (grayed out on the map). Rows are never deleted server-side;
-- the app filters by updated_at.
-- ============================================================

alter table public.emg_team_positions
  add column if not exists inspector_id text;
alter table public.emg_team_positions
  add column if not exists inspector_name text;
alter table public.emg_team_positions
  add column if not exists heading double precision;
alter table public.emg_team_positions
  add column if not exists speed double precision;
alter table public.emg_team_positions
  add column if not exists firm_id text;

-- Backfill the new id column from the legacy PK for existing rows.
update public.emg_team_positions
set inspector_id = inspector
where inspector_id is null;

-- Firm-scoped reads + recency ordering.
create index if not exists emg_team_positions_firm_idx
  on public.emg_team_positions (firm_id);
create index if not exists emg_team_positions_updated_idx
  on public.emg_team_positions (updated_at desc);

comment on table public.emg_team_positions is
  'Live inspector positions. Readers treat positions older than 15 minutes as stale.';

-- RLS: read for everyone (the app filters by firm client-side until the
-- login UI exists), insert/update open for the field app's upserts.
-- (008 created permissive policies already; re-assert them idempotently.)
drop policy if exists emg_team_positions_select on public.emg_team_positions;
create policy emg_team_positions_select
  on public.emg_team_positions for select using (true);

drop policy if exists emg_team_positions_insert on public.emg_team_positions;
create policy emg_team_positions_insert
  on public.emg_team_positions for insert with check (true);

drop policy if exists emg_team_positions_update on public.emg_team_positions;
create policy emg_team_positions_update
  on public.emg_team_positions for update using (true) with check (true);

-- Tell PostgREST to pick up the new columns immediately.
notify pgrst, 'reload schema';
