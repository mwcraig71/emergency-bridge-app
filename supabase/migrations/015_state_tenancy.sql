-- Migration 015: state-level tenancy + admin role hierarchy.
--
-- The app is used by more than one state now. This migration adds:
--   emg_states  — the states that run inspection programs (SC, NC, ...).
--   firms.state_code — which state a firm operates in (nullable: existing
--     firms are NOT assumed to belong to any state; Michael assigns each
--     firm's state explicitly after this migration runs).
--   emg_admins  — admin role assignments for Supabase Auth users:
--       super_admin — overall admin; all states, all firms.
--       state_admin — one state (state_code required); manages that
--                     state's firms and admins.
--       firm_admin  — one firm (firm_id required); the pre-existing
--                     firm ops login.
--
-- A bridge's state is derived, not stored: it is the prefix of
-- emg_bridges.asset_id before the '-' (e.g. 'SC-1892' -> 'SC',
-- 'NC-10001' -> 'NC'). Asset IDs are state-prefixed (migrations 003/004),
-- so state scoping for bridges is a prefix filter on asset_id.
--
-- RLS policies follow the open pattern from migrations 008/009/010
-- (permissive `using (true)`) — the app enforces role scoping in the UI
-- layer today. TODO: tighten to role-aware row policies once every admin
-- has an emg_admins row; do not tighten before then or legacy firm
-- admins (no row yet) lose access.
--
-- BOOTSTRAP: the FIRST super_admin row must be inserted by SQL (the
-- Admins UI can only be used by someone who is already an admin):
--
--   insert into public.emg_admins (auth_user_id, email, role)
--   values (
--     (select id from auth.users where email = 'michaelcraig@strinteg.com'),
--     'michaelcraig@strinteg.com',
--     'super_admin'
--   );
--
-- (The named person also needs a Supabase Auth account with that email —
-- Dashboard -> Authentication -> Users.)
--
-- HOW TO RUN: paste the entire file into the Supabase SQL editor
-- (Dashboard → SQL Editor → New query) and click Run.

-- ============================================================
-- emg_states
-- ============================================================
create table if not exists public.emg_states (
  code       text primary key,
  name       text not null,
  created_at timestamptz not null default now()
);

insert into public.emg_states (code, name) values
  ('SC', 'South Carolina'),
  ('NC', 'North Carolina')
on conflict (code) do nothing;

-- ============================================================
-- firms.state_code — which state the firm operates in.
-- Nullable on purpose: existing firms keep NULL until Michael
-- assigns them a state. Do NOT backfill a guessed state here.
-- ============================================================
alter table public.firms
  add column if not exists state_code text references public.emg_states(code);
create index if not exists idx_firms_state
  on public.firms (state_code);

-- ============================================================
-- emg_admins: role assignment per admin login.
--   auth_user_id — Supabase Auth user id (auth.users.id). Unique so a
--     login maps to exactly one role row. Nullable so a role can be
--     granted by email before the Auth account exists; the app links
--     auth_user_id on first sign-in (lookup falls back to email).
--   role — 'super_admin' | 'state_admin' | 'firm_admin'.
--   state_code — required for state_admin (enforced by check below).
--   firm_id — required for firm_admin (enforced by check below).
-- ============================================================
create table if not exists public.emg_admins (
  id           uuid primary key default gen_random_uuid(),
  auth_user_id uuid unique,
  email        text not null unique,
  role         text not null check (role in ('super_admin', 'state_admin', 'firm_admin')),
  state_code   text references public.emg_states(code),
  firm_id      uuid references public.firms(id) on delete cascade,
  created_at   timestamptz not null default now(),
  constraint emg_admins_state_admin_needs_state
    check (role <> 'state_admin' or state_code is not null),
  constraint emg_admins_firm_admin_needs_firm
    check (role <> 'firm_admin' or firm_id is not null)
);
create index if not exists idx_emg_admins_state
  on public.emg_admins (state_code);
create index if not exists idx_emg_admins_firm
  on public.emg_admins (firm_id);

-- ============================================================
-- Row Level Security: open policies matching migrations 008/009/010.
-- Role scoping is enforced in the app layer for now (see header).
-- ============================================================
alter table public.emg_states enable row level security;
alter table public.emg_admins enable row level security;

drop policy if exists emg_states_select on public.emg_states;
create policy emg_states_select
  on public.emg_states for select using (true);

drop policy if exists emg_states_insert on public.emg_states;
create policy emg_states_insert
  on public.emg_states for insert with check (true);

drop policy if exists emg_states_update on public.emg_states;
create policy emg_states_update
  on public.emg_states for update using (true) with check (true);

drop policy if exists emg_admins_select on public.emg_admins;
create policy emg_admins_select
  on public.emg_admins for select using (true);

drop policy if exists emg_admins_insert on public.emg_admins;
create policy emg_admins_insert
  on public.emg_admins for insert with check (true);

drop policy if exists emg_admins_update on public.emg_admins;
create policy emg_admins_update
  on public.emg_admins for update using (true) with check (true);

drop policy if exists emg_admins_delete on public.emg_admins;
create policy emg_admins_delete
  on public.emg_admins for delete using (true);

-- Tell PostgREST to pick up the new tables/columns immediately.
notify pgrst, 'reload schema';
