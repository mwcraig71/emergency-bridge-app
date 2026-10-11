-- Migration 002: asset_id must be TEXT, not integer.
-- 21 of 9,503 SC bridges have alphanumeric asset IDs (e.g. '2SC0300',
-- 'S651', '42520-00001'). The integer PK rejected them.
-- Purely additive/altering on emg_* tables only; existing project tables
-- are not referenced.

do $$
declare cname text;
begin
  select conname into cname
    from pg_constraint
   where conrelid = 'public.emg_inspections'::regclass
     and contype = 'f';
  if cname is not null then
    execute format('alter table public.emg_inspections drop constraint %I', cname);
  end if;
end $$;

alter table public.emg_bridges alter column asset_id type text;
alter table public.emg_inspections alter column asset_id type text;

alter table public.emg_inspections
  add constraint emg_inspections_asset_id_fkey
  foreign key (asset_id) references public.emg_bridges(asset_id);
