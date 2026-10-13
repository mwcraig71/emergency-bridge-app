-- Migration 016: firms can operate in multiple states.
-- Replaces the single firms.state_code (migration 015) with a junction.
-- Michael's assignments (2026-10-13):
--   Strinteg     -> NC, SC
--   HDR          -> NC, SC
--   AI Engineers -> SC
--   AECOM        -> NC

create table if not exists public.firm_states (
  firm_id    uuid not null references public.firms(id) on delete cascade,
  state_code text not null references public.emg_states(code),
  primary key (firm_id, state_code)
);
create index if not exists idx_firm_states_state on public.firm_states (state_code);

alter table public.firm_states enable row level security;
create policy "firm_states open select" on public.firm_states for select using (true);
create policy "firm_states open insert" on public.firm_states for insert with check (true);
create policy "firm_states open update" on public.firm_states for update using (true);
create policy "firm_states open delete" on public.firm_states for delete using (true);

-- Carry over any single-state assignments made under migration 015.
insert into public.firm_states (firm_id, state_code)
select id, state_code from public.firms where state_code is not null
on conflict do nothing;

-- New firms named by Michael (2026-10-13).
insert into public.firms (name) values ('AI Engineers') on conflict (name) do nothing;
insert into public.firms (name) values ('AECOM') on conflict (name) do nothing;

-- Michael's state assignments (2026-10-13).
insert into public.firm_states (firm_id, state_code)
select f.id, s.code
from public.firms f, public.emg_states s
where (f.name = 'Strinteg' and s.code in ('NC', 'SC'))
   or (f.name = 'HDR' and s.code in ('NC', 'SC'))
   or (f.name = 'AI Engineers' and s.code = 'SC')
   or (f.name = 'AECOM' and s.code = 'NC')
on conflict do nothing;

-- firms.state_code is retained for backward compatibility with the 015-era
-- client but is no longer authoritative; firm_states is the source of truth.
comment on column public.firms.state_code is
  'Deprecated by migration 016 — use firm_states (many-to-many).';
