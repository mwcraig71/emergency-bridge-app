-- Migration 007: team bridge assignments + notifications.
--
-- emg_assignments: loose assignment of bridges to inspectors. A bridge may be
-- inspected by someone other than the assignee (cross-assignment); completion
-- records who actually did the work.
--
-- emg_notifications: notify an assignee when someone else completes their bridge.
--
-- HOW TO RUN: paste the entire file into the Supabase SQL editor
-- (Dashboard → SQL Editor → New query) and click Run.

-- ============================================================
-- emg_assignments
-- ============================================================
create table if not exists public.emg_assignments (
  id            uuid primary key default gen_random_uuid(),
  asset_id      text not null references public.emg_bridges(asset_id),
  assigned_to   text not null,             -- inspector name
  assigned_by   text,                      -- who assigned it
  assigned_at   timestamptz not null default now(),
  status        text not null default 'assigned'
                check (status in ('assigned','in_progress','complete')),
  completed_by  text,                      -- actual inspector (may differ from assigned_to)
  completed_at  timestamptz,
  notes         text,
  created_at    timestamptz not null default now()
);
create index if not exists idx_assignments_asset
  on public.emg_assignments (asset_id);
create index if not exists idx_assignments_assignee
  on public.emg_assignments (assigned_to);
create index if not exists idx_assignments_status
  on public.emg_assignments (status);

-- ============================================================
-- emg_notifications
-- ============================================================
create table if not exists public.emg_notifications (
  id                uuid primary key default gen_random_uuid(),
  recipient         text not null,         -- inspector name
  type              text not null,         -- e.g. 'bridge_completed_by_other'
  title             text not null,
  message           text not null,
  related_asset_id  text,
  created_at        timestamptz not null default now(),
  read_at           timestamptz
);
create index if not exists idx_notifications_recipient
  on public.emg_notifications (recipient);
create index if not exists idx_notifications_read
  on public.emg_notifications (recipient, read_at);

-- ============================================================
-- Row Level Security. The field app and dashboard use the anon key,
-- so these tables need explicit policies:
--   SELECT — everyone reads assignments/notifications
--   INSERT — field app creates notifications; dashboard creates assignments
--   UPDATE — completion tracking (assignment status) and read receipts
-- ============================================================
alter table public.emg_assignments  enable row level security;
alter table public.emg_notifications enable row level security;

drop policy if exists emg_assignments_select on public.emg_assignments;
create policy emg_assignments_select
  on public.emg_assignments for select using (true);

drop policy if exists emg_assignments_insert on public.emg_assignments;
create policy emg_assignments_insert
  on public.emg_assignments for insert with check (true);

drop policy if exists emg_assignments_update on public.emg_assignments;
create policy emg_assignments_update
  on public.emg_assignments for update using (true) with check (true);

drop policy if exists emg_notifications_select on public.emg_notifications;
create policy emg_notifications_select
  on public.emg_notifications for select using (true);

drop policy if exists emg_notifications_insert on public.emg_notifications;
create policy emg_notifications_insert
  on public.emg_notifications for insert with check (true);

drop policy if exists emg_notifications_update on public.emg_notifications;
create policy emg_notifications_update
  on public.emg_notifications for update using (true) with check (true);

-- Tell PostgREST to pick up the new tables immediately.
notify pgrst, 'reload schema';
