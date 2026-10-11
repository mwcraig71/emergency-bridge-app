-- Migration 003: multi-state support.
-- Adds a `state` column (2-letter code) to the inventory tables and
-- backfills existing rows as SC. Purely additive/altering on emg_*
-- tables only; no other project tables are referenced.
--
-- HOW TO RUN: paste into the Supabase SQL editor and click Run.

alter table public.emg_bridges   add column if not exists state text;
alter table public.emg_districts add column if not exists state text;

update public.emg_bridges   set state = 'SC' where state is null;
update public.emg_districts set state = 'SC' where state is null;

alter table public.emg_bridges   alter column state set not null;
alter table public.emg_districts alter column state set not null;

create index if not exists emg_bridges_state_idx
  on public.emg_bridges (state);
