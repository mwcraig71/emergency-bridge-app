-- Migration 009: firm-level multi-tenancy scaffolding.
--
-- Firms receive groups of bridges and assign them to inspector teams within
-- the firm. Auth plan (not built yet):
--   * Firm login: secure, online (future login UI).
--   * Inspector login: MUST work offline — roster + PIN hash cached on device,
--     verified locally. Guaranteed access, no network dependency.
--
-- This migration only creates the data model. All firm_id columns are
-- nullable so existing rows and the current no-firm field flow keep working.
-- RLS policies follow the open anon pattern from migrations 007/008 and
-- will be tightened when auth lands.
--
-- HOW TO RUN: paste the entire file into the Supabase SQL editor
-- (Dashboard → SQL Editor → New query) and click Run.

-- ============================================================
-- firms
-- ============================================================
create table if not exists public.firms (
  id         uuid primary key default gen_random_uuid(),
  name       text not null unique,
  created_at timestamptz not null default now()
);

-- ============================================================
-- inspectors: per-firm roster. pin_hash is nullable until the
-- offline PIN login is built; the hash never leaves the server
-- in client-facing selects (no client select policy exposes it —
-- see note below).
-- ============================================================
create table if not exists public.inspectors (
  id         uuid primary key default gen_random_uuid(),
  firm_id    uuid not null references public.firms(id) on delete cascade,
  name       text not null,
  pin_hash   text,
  created_at timestamptz not null default now(),
  unique (firm_id, name)
);
create index if not exists idx_inspectors_firm
  on public.inspectors (firm_id);

-- ============================================================
-- firm_bridges: which bridges belong to which firm. Bridges are
-- shared NBI data, so membership is a mapping table rather than
-- a column on emg_bridges.
-- ============================================================
create table if not exists public.firm_bridges (
  firm_id     uuid not null references public.firms(id) on delete cascade,
  asset_id    text not null references public.emg_bridges(asset_id) on delete cascade,
  assigned_at timestamptz not null default now(),
  primary key (firm_id, asset_id)
);
create index if not exists idx_firm_bridges_asset
  on public.firm_bridges (asset_id);

-- ============================================================
-- firm_id on operational tables (nullable — backward compatible).
-- ON DELETE SET NULL keeps inspection history if a firm is removed.
-- ============================================================
alter table public.emg_assignments
  add column if not exists firm_id uuid references public.firms(id) on delete set null;
create index if not exists idx_assignments_firm
  on public.emg_assignments (firm_id);

alter table public.emg_inspections
  add column if not exists firm_id uuid references public.firms(id) on delete set null;
create index if not exists idx_inspections_firm
  on public.emg_inspections (firm_id);

alter table public.emg_notifications
  add column if not exists firm_id uuid references public.firms(id) on delete set null;
create index if not exists idx_notifications_firm
  on public.emg_notifications (firm_id);

-- ============================================================
-- Row Level Security: open anon policies matching migrations 007/008.
-- Tighten these when firm/inspector auth is implemented.
-- NOTE: no SELECT policy exposes inspectors.pin_hash to anon clients —
-- the roster sync must select explicit columns (id, firm_id, name,
-- created_at) and never pin_hash.
-- ============================================================
alter table public.firms         enable row level security;
alter table public.inspectors    enable row level security;
alter table public.firm_bridges  enable row level security;

drop policy if exists firms_select on public.firms;
create policy firms_select
  on public.firms for select using (true);

drop policy if exists firms_insert on public.firms;
create policy firms_insert
  on public.firms for insert with check (true);

drop policy if exists firms_update on public.firms;
create policy firms_update
  on public.firms for update using (true) with check (true);

drop policy if exists inspectors_select on public.inspectors;
create policy inspectors_select
  on public.inspectors for select using (true);

drop policy if exists inspectors_insert on public.inspectors;
create policy inspectors_insert
  on public.inspectors for insert with check (true);

drop policy if exists inspectors_update on public.inspectors;
create policy inspectors_update
  on public.inspectors for update using (true) with check (true);

drop policy if exists firm_bridges_select on public.firm_bridges;
create policy firm_bridges_select
  on public.firm_bridges for select using (true);

drop policy if exists firm_bridges_insert on public.firm_bridges;
create policy firm_bridges_insert
  on public.firm_bridges for insert with check (true);

drop policy if exists firm_bridges_update on public.firm_bridges;
create policy firm_bridges_update
  on public.firm_bridges for update using (true) with check (true);

-- Tell PostgREST to pick up the new tables/columns immediately.
notify pgrst, 'reload schema';
