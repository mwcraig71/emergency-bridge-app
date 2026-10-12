-- Migration 012: server-side sync for roadblock closure photos.
--
-- Roadblock photos were previously local-only (IndexedDB `photos` store,
-- schema v6). This adds the server table emg_roadblock_photos; the image
-- binaries live in the existing private "emg-photos" bucket (created by
-- migration 010) under the `roadblocks/` prefix. The bucket-wide storage
-- policies from 010 already cover that prefix; an explicit path-scoped
-- policy is added below for clarity.
--
-- HOW TO RUN: paste into the Supabase SQL editor and Run.
-- STATUS: NOT RUN — only run via the Management API / SQL editor.

create table if not exists public.emg_roadblock_photos (
  id              uuid primary key default gen_random_uuid(),
  -- NOTE: emg_roadblocks.id is uuid, so the FK is uuid (not text).
  roadblock_id    uuid not null references public.emg_roadblocks(id) on delete cascade,
  storage_path    text not null unique,   -- object key in the emg-photos bucket
  note            text,
  taken_at        timestamptz not null default now(),
  inspector_id    text,
  synced_at       timestamptz not null default now(),
  created_at      timestamptz not null default now()
);
create index if not exists emg_roadblock_photos_roadblock_idx
  on public.emg_roadblock_photos (roadblock_id);

alter table public.emg_roadblock_photos enable row level security;

-- Field app syncs with the anon key (same open-policy style as 008/010).
drop policy if exists emg_roadblock_photos_insert on public.emg_roadblock_photos;
create policy emg_roadblock_photos_insert
  on public.emg_roadblock_photos for insert with check (true);

drop policy if exists emg_roadblock_photos_select on public.emg_roadblock_photos;
create policy emg_roadblock_photos_select
  on public.emg_roadblock_photos for select using (true);

drop policy if exists emg_roadblock_photos_update on public.emg_roadblock_photos;
create policy emg_roadblock_photos_update
  on public.emg_roadblock_photos for update
  using (true) with check (true);

-- Storage: binaries for roadblock photos live under roadblocks/ in the
-- private emg-photos bucket. The bucket-wide policies from migration 010
-- already permit this; this path-scoped policy makes the intent explicit.
drop policy if exists emg_photos_roadblocks_insert on storage.objects;
create policy emg_photos_roadblocks_insert
  on storage.objects for insert
  with check (
    bucket_id = 'emg-photos'
    and (storage.foldername(name))[1] = 'roadblocks'
  );

drop policy if exists emg_photos_roadblocks_select on storage.objects;
create policy emg_photos_roadblocks_select
  on storage.objects for select
  using (
    bucket_id = 'emg-photos'
    and (storage.foldername(name))[1] = 'roadblocks'
  );
