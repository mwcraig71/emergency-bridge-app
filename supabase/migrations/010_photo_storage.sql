-- Migration 010: Supabase Storage bucket for inspection photos.
--
-- The field app uploads photo binaries to the "emg-photos" bucket
-- (see app/src/lib/sync.ts → pushPhoto); emg_inspection_photos.storage_path
-- points at the object key, and emg_inspection_photos.description carries
-- the photo note.
--
-- HOW TO RUN: paste the entire file into the Supabase SQL editor
-- (Dashboard → SQL Editor → New query) and click Run.
--
-- STATUS: NOT RUN — only Michael runs migrations. Until this runs, photo
-- uploads fail with a clear "bucket missing" error and photos stay queued.

insert into storage.buckets (id, name, public)
values ('emg-photos', 'emg-photos', false)
on conflict (id) do nothing;

-- Field app uploads with the anon key (same open-policy style as 008).
drop policy if exists emg_photos_insert on storage.objects;
create policy emg_photos_insert
  on storage.objects for insert with check (bucket_id = 'emg-photos');

drop policy if exists emg_photos_update on storage.objects;
create policy emg_photos_update
  on storage.objects for update
  using (bucket_id = 'emg-photos') with check (bucket_id = 'emg-photos');

drop policy if exists emg_photos_delete on storage.objects;
create policy emg_photos_delete
  on storage.objects for delete using (bucket_id = 'emg-photos');

drop policy if exists emg_photos_select on storage.objects;
create policy emg_photos_select
  on storage.objects for select using (bucket_id = 'emg-photos');
