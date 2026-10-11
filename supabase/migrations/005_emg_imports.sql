-- Migration 005: import log for self-service NBI state uploads.
-- Written by the /api/nbi/import server route after each load attempt
-- (including fail-closed aborts). Purely additive; no other tables touched.
--
-- HOW TO RUN: paste into the Supabase SQL editor and click Run.

create table if not exists public.emg_imports (
  id              uuid primary key default gen_random_uuid(),
  state           text not null,               -- 2-letter state code, e.g. 'NC'
  filename        text not null,               -- original upload filename
  imported_by     text,                        -- inspector / operator name
  imported_at     timestamptz not null default now(),
  format          text,                        -- 'csv' | 'fixedwidth'
  total_records   integer not null default 0,  -- rows seen in file
  loaded          integer not null default 0,  -- rows inserted
  skipped_coords  integer not null default 0,  -- rows dropped: bad coords
  collisions      integer not null default 0,  -- asset_id collisions found
  status          text not null default 'completed'
                  check (status in ('completed','aborted','failed')),
  notes           text
);

create index if not exists emg_imports_state_idx
  on public.emg_imports (state);
create index if not exists emg_imports_at_idx
  on public.emg_imports (imported_at desc);

alter table public.emg_imports enable row level security;
-- Reads go through the import API (service_role); no anon policies:
-- dashboard lists imports via GET /api/nbi/imports, never direct table reads.
