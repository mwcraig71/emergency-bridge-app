-- Migration 018: per-state configurable inspection questionnaires.
-- Phase 1 (2026-11-09). Design fork DECIDED by Michael 2026-11-09:
-- LOCKED CORE + free state additions. Questions marked is_core (the 16
-- system-mapped questions plus the two destroyed-gate photos) cannot be
-- deleted, unmapped, re-triggered, retyped, or reworded by states in the
-- Form Builder; states add their own questions around them. Enforcement
-- lives in app/src/lib/forms.ts (builder save path + publish validation).
--
-- Design: docs/questionnaire-design.md (Section 4). Mapping of the current
-- form to this schema: docs/questionnaire-phase1-mapping.md.
--
-- ADDITIVE ONLY:
--   * new tables emg_form_templates, emg_form_questions,
--     emg_inspection_answers
--   * emg_inspections gains two nullable columns (form_template_id,
--     form_version)
--   * NO existing column, default, or CHECK constraint is altered.
--   * Rollback = drop the three new tables and the two new columns.
--
-- Numbering note: 017 (emg_states.share_firm_progress) exists only in prod
-- (applied via the Management API) and intentionally has no file here.
-- NC division boundaries, previously planned as 018, shift to 019.

-- ============================================================
-- emg_form_templates — one state's questionnaire at one version.
-- state_code NULL = the system default template. At most one draft and
-- one published template per state (partial unique indexes below;
-- note Postgres treats NULL state_code as distinct, so the default
-- template's one-draft/one-published discipline is by convention).
-- ============================================================
create table if not exists public.emg_form_templates (
  id           uuid primary key default gen_random_uuid(),
  state_code   text references public.emg_states(code),
  name         text not null,
  version      integer not null,
  status       text not null check (status in ('draft','published','archived')),
  is_default   boolean not null default false,
  created_by   text,
  created_at   timestamptz not null default now(),
  published_at timestamptz,
  published_by text,
  unique (state_code, version)
);
create unique index if not exists emg_form_templates_one_draft
  on public.emg_form_templates (state_code) where status = 'draft';
create unique index if not exists emg_form_templates_one_published
  on public.emg_form_templates (state_code) where status = 'published';
create index if not exists emg_form_templates_state_idx
  on public.emg_form_templates (state_code);

-- ============================================================
-- emg_form_questions — a question tree within one template.
-- is_core marks the locked-core questions (seeded from the default
-- template; cloned drafts inherit the flag). The Form Builder refuses
-- to delete, unmap, re-trigger, retype, or reword is_core questions.
-- A child question (parent_question_id set) is visible only when the
-- parent's answer matches trigger_answer. maps_to_system_field names a
-- core emg_inspections column the answer also writes through to; the
-- allowlist mirrors the CHECK constraints in migration 001 and design
-- Appendix C. At most one question per template may claim a field.
-- ============================================================
create table if not exists public.emg_form_questions (
  id                  uuid primary key default gen_random_uuid(),
  template_id         uuid not null references public.emg_form_templates(id)
                        on delete cascade,
  parent_question_id  uuid references public.emg_form_questions(id)
                        on delete cascade,
  trigger_answer      text,
  sort_order          integer not null,
  type                text not null check (type in
                        ('yes_no','text','number','single_choice',
                         'multi_choice','photo')),
  prompt              text not null,
  help_text           text,
  required            boolean not null default false,
  is_core             boolean not null default false,
  options             jsonb,
  config              jsonb,
  maps_to_system_field text
                        check (maps_to_system_field is null or
                               maps_to_system_field in (
                                 'destroyed','access','drone_used',
                                 'bridge_still_there','overtopped',
                                 'overtop_depth_ft','damage_rail',
                                 'damage_deck','damage_super','damage_sub',
                                 'washout_abutment','remain_open',
                                 'remain_open_notes','safe_load',
                                 'safe_load_notes','debris_amount')),
  created_at          timestamptz not null default now(),
  unique (template_id, parent_question_id, sort_order)
);
create unique index if not exists emg_form_questions_one_mapping
  on public.emg_form_questions (template_id, maps_to_system_field)
  where maps_to_system_field is not null;
create index if not exists emg_form_questions_template_idx
  on public.emg_form_questions (template_id);
create index if not exists emg_form_questions_parent_idx
  on public.emg_form_questions (parent_question_id);

-- ============================================================
-- emg_inspections: record which template version produced the record.
-- Both columns nullable — every pre-questionnaire inspection keeps NULLs
-- and renders through the legacy detail view.
-- ============================================================
alter table public.emg_inspections
  add column if not exists form_template_id uuid
    references public.emg_form_templates(id);
alter table public.emg_inspections
  add column if not exists form_version integer;

-- ============================================================
-- emg_inspection_answers — one row per answered question, with prompt
-- and type snapshots so history stays readable after a state edits or
-- deletes questions. question_id deliberately has NO foreign key (see
-- design Section 4.4): the snapshots are the record.
-- Answer shapes by type (jsonb):
--   yes_no        {"value": "yes"}
--   text          {"value": "..."}
--   number        {"value": 3.5} | {"value": null, "unknown": true}
--   single_choice {"value": "restricted_lanes"}
--   multi_choice  {"value": ["debris", "scour"]}
--   photo         {"photo_ids": ["<photo uuid>", ...]}
-- ============================================================
create table if not exists public.emg_inspection_answers (
  id              uuid primary key default gen_random_uuid(),
  inspection_id   uuid not null references public.emg_inspections(id)
                    on delete cascade,
  question_id     uuid,
  prompt_snapshot text not null,
  type_snapshot   text not null,
  sort_snapshot   integer,
  answer          jsonb,
  created_at      timestamptz not null default now(),
  unique (inspection_id, question_id)
);
create index if not exists emg_inspection_answers_inspection_idx
  on public.emg_inspection_answers (inspection_id);

-- ============================================================
-- RLS: enabled with permissive pilot policies, consistent with the
-- rest of the app (scoping is enforced in app code; tightening is a
-- shared pre-rollout task, not introduced by this feature).
-- ============================================================
alter table public.emg_form_templates    enable row level security;
alter table public.emg_form_questions    enable row level security;
alter table public.emg_inspection_answers enable row level security;

create policy "emg_form_templates open select" on public.emg_form_templates for select using (true);
create policy "emg_form_templates open insert" on public.emg_form_templates for insert with check (true);
create policy "emg_form_templates open update" on public.emg_form_templates for update using (true);
create policy "emg_form_templates open delete" on public.emg_form_templates for delete using (true);

create policy "emg_form_questions open select" on public.emg_form_questions for select using (true);
create policy "emg_form_questions open insert" on public.emg_form_questions for insert with check (true);
create policy "emg_form_questions open update" on public.emg_form_questions for update using (true);
create policy "emg_form_questions open delete" on public.emg_form_questions for delete using (true);

create policy "emg_inspection_answers open select" on public.emg_inspection_answers for select using (true);
create policy "emg_inspection_answers open insert" on public.emg_inspection_answers for insert with check (true);
create policy "emg_inspection_answers open update" on public.emg_inspection_answers for update using (true);
create policy "emg_inspection_answers open delete" on public.emg_inspection_answers for delete using (true);

-- ============================================================
-- Seed: the system default template (state_code NULL, published v1)
-- with the current form's exact question set (design Appendix A,
-- verified against TriageFlow.tsx / PhotoSection.tsx 2026-11-09).
-- Photo questions carry their legacy photo_type in config so the
-- default template reproduces today's emg_inspection_photos rows
-- exactly; form-native photo questions (no config photo_type) write
-- 'form:<question_id>' instead (design Section 4.4).
-- Guarded: runs only if no default template exists yet.
-- ============================================================
do $$
declare
  v_template  uuid;
  q_destroyed uuid;
  q_access    uuid;
  q_drone     uuid;
  q_overtop   uuid;
  q_dmg_rail  uuid;
  q_dmg_deck  uuid;
  q_dmg_super uuid;
  q_dmg_sub   uuid;
  q_washout   uuid;
begin
  if exists (select 1 from public.emg_form_templates where is_default) then
    raise notice 'Default form template already exists — seed skipped.';
    return;
  end if;

  insert into public.emg_form_templates
    (state_code, name, version, status, is_default, created_by, published_at, published_by)
  values
    (null, 'Default post-storm triage', 1, 'published', true,
     'migration 018', now(), 'migration 018')
  returning id into v_template;

  -- 1. Destroyed? (root)
  insert into public.emg_form_questions
    (template_id, sort_order, type, prompt, required, is_core, maps_to_system_field)
  values
    (v_template, 1, 'yes_no', 'Was the bridge destroyed?', true, true, 'destroyed')
  returning id into q_destroyed;

  -- 2-3. Destroyed photos (children of 1 = yes). Core: they gate the
  -- destroyed outcome exactly as finish() requires them today.
  insert into public.emg_form_questions
    (template_id, parent_question_id, trigger_answer, sort_order, type, prompt, required, is_core, config)
  values
    (v_template, q_destroyed, 'yes', 2, 'photo', 'Bridge profile photo', true, true,
     '{"min_count": 1, "photo_type": "destroyed_profile"}'::jsonb),
    (v_template, q_destroyed, 'yes', 3, 'photo',
     'Approach-location photo — stand where the approach was, looking across where the bridge was',
     true, true, '{"min_count": 1, "photo_type": "destroyed_approach"}'::jsonb);

  -- 4. Access? (child of 1 = no)
  insert into public.emg_form_questions
    (template_id, parent_question_id, trigger_answer, sort_order, type, prompt, required, is_core, maps_to_system_field)
  values
    (v_template, q_destroyed, 'no', 4, 'yes_no',
     'Were you able to access the bridge?', true, true, 'access')
  returning id into q_access;

  -- 5. Drone used? (child of 4 = no)
  insert into public.emg_form_questions
    (template_id, parent_question_id, trigger_answer, sort_order, type, prompt, required, is_core, maps_to_system_field)
  values
    (v_template, q_access, 'no', 5, 'yes_no',
     'Was drone reconnaissance used?', true, true, 'drone_used')
  returning id into q_drone;

  -- 6. Still there? (child of 5 = yes)
  insert into public.emg_form_questions
    (template_id, parent_question_id, trigger_answer, sort_order, type, prompt, help_text, required, is_core, maps_to_system_field)
  values
    (v_template, q_drone, 'yes', 6, 'yes_no',
     'Is the bridge still there? (drone observation)',
     'Choosing No suggests likely destroyed. Choosing Yes places the bridge on the ground follow-up list for inspectors on the ground.',
     true, true, 'bridge_still_there');

  -- 7. Overtopped? (child of 4 = yes)
  insert into public.emg_form_questions
    (template_id, parent_question_id, trigger_answer, sort_order, type, prompt, required, is_core, maps_to_system_field)
  values
    (v_template, q_access, 'yes', 7, 'yes_no',
     'Has the bridge overtopped?', true, true, 'overtopped')
  returning id into q_overtop;

  -- 8. Overtopping depth (child of 7 = yes)
  insert into public.emg_form_questions
    (template_id, parent_question_id, trigger_answer, sort_order, type, prompt, required, is_core, config, maps_to_system_field)
  values
    (v_template, q_overtop, 'yes', 8, 'number',
     'Maximum depth of overtopping (ft)', true, true,
     '{"min": 0, "step": 0.1, "unit": "ft", "allow_unknown": true}'::jsonb,
     'overtop_depth_ft');

  -- 9-13. Damage questions (children of 4 = yes; not required, no pre-fill)
  insert into public.emg_form_questions
    (template_id, parent_question_id, trigger_answer, sort_order, type, prompt, required, is_core, maps_to_system_field)
  values
    (v_template, q_access, 'yes', 9, 'yes_no', 'Damage to rail', false, true, 'damage_rail')
  returning id into q_dmg_rail;
  insert into public.emg_form_questions
    (template_id, parent_question_id, trigger_answer, sort_order, type, prompt, required, is_core, maps_to_system_field)
  values
    (v_template, q_access, 'yes', 10, 'yes_no', 'Damage to deck', false, true, 'damage_deck')
  returning id into q_dmg_deck;
  insert into public.emg_form_questions
    (template_id, parent_question_id, trigger_answer, sort_order, type, prompt, required, is_core, maps_to_system_field)
  values
    (v_template, q_access, 'yes', 11, 'yes_no', 'Damage to superstructure', false, true, 'damage_super')
  returning id into q_dmg_super;
  insert into public.emg_form_questions
    (template_id, parent_question_id, trigger_answer, sort_order, type, prompt, required, is_core, maps_to_system_field)
  values
    (v_template, q_access, 'yes', 12, 'yes_no', 'Damage to substructure', false, true, 'damage_sub')
  returning id into q_dmg_sub;
  insert into public.emg_form_questions
    (template_id, parent_question_id, trigger_answer, sort_order, type, prompt, required, is_core, maps_to_system_field)
  values
    (v_template, q_access, 'yes', 13, 'yes_no', 'Approach washout behind abutments', false, true, 'washout_abutment')
  returning id into q_washout;

  -- 14-16. Standard photos (children of 4 = yes)
  insert into public.emg_form_questions
    (template_id, parent_question_id, trigger_answer, sort_order, type, prompt, required, config)
  values
    (v_template, q_access, 'yes', 14, 'photo', 'Upstation approach photo', false,
     '{"photo_type": "upstation"}'::jsonb),
    (v_template, q_access, 'yes', 15, 'photo', 'Bridge profile photo', false,
     '{"photo_type": "profile"}'::jsonb),
    (v_template, q_access, 'yes', 16, 'photo', 'Downstation approach photo', false,
     '{"photo_type": "downstation"}'::jsonb);

  -- 17-21. Per-damage photo slots (children of 9-13 = yes)
  insert into public.emg_form_questions
    (template_id, parent_question_id, trigger_answer, sort_order, type, prompt, required, config)
  values
    (v_template, q_dmg_rail, 'yes', 17, 'photo', 'Rail damage', false,
     '{"photo_type": "rail"}'::jsonb),
    (v_template, q_dmg_deck, 'yes', 18, 'photo', 'Deck damage', false,
     '{"photo_type": "deck"}'::jsonb),
    (v_template, q_dmg_super, 'yes', 19, 'photo', 'Superstructure damage', false,
     '{"photo_type": "super"}'::jsonb),
    (v_template, q_dmg_sub, 'yes', 20, 'photo', 'Substructure damage', false,
     '{"photo_type": "sub"}'::jsonb),
    (v_template, q_washout, 'yes', 21, 'photo', 'Washout photo', false,
     '{"photo_type": "washout"}'::jsonb);

  -- 22. Free-form condition photos (child of 4 = yes)
  insert into public.emg_form_questions
    (template_id, parent_question_id, trigger_answer, sort_order, type, prompt, required, config)
  values
    (v_template, q_access, 'yes', 22, 'photo', 'Condition photos', false,
     '{"photo_type": "condition", "allow_notes": true}'::jsonb);

  -- 23. Remain open? (child of 4 = yes)
  insert into public.emg_form_questions
    (template_id, parent_question_id, trigger_answer, sort_order, type, prompt, required, is_core, options, maps_to_system_field)
  values
    (v_template, q_access, 'yes', 23, 'single_choice',
     'Can the bridge remain open?', true, true,
     '[{"value": "yes", "label": "Yes"}, {"value": "no", "label": "No"}, {"value": "restricted_lanes", "label": "Restricted lane access"}]'::jsonb,
     'remain_open');

  -- 24. Remain-open notes (child of 4 = yes)
  insert into public.emg_form_questions
    (template_id, parent_question_id, trigger_answer, sort_order, type, prompt, required, is_core, maps_to_system_field)
  values
    (v_template, q_access, 'yes', 24, 'text', 'Notes', false, true, 'remain_open_notes');

  -- 25. Safe to carry load? (child of 4 = yes)
  insert into public.emg_form_questions
    (template_id, parent_question_id, trigger_answer, sort_order, type, prompt, required, is_core, options, maps_to_system_field)
  values
    (v_template, q_access, 'yes', 25, 'single_choice',
     'Is it safe to carry load?', true, true,
     '[{"value": "yes", "label": "Yes"}, {"value": "no", "label": "No"}, {"value": "reduced_load", "label": "Reduced load"}]'::jsonb,
     'safe_load');

  -- 26. Safe-load notes (child of 4 = yes)
  insert into public.emg_form_questions
    (template_id, parent_question_id, trigger_answer, sort_order, type, prompt, required, is_core, maps_to_system_field)
  values
    (v_template, q_access, 'yes', 26, 'text', 'Notes', false, true, 'safe_load_notes');

  -- 27. Debris at bridge (child of 4 = yes)
  insert into public.emg_form_questions
    (template_id, parent_question_id, trigger_answer, sort_order, type, prompt, required, is_core, options, maps_to_system_field)
  values
    (v_template, q_access, 'yes', 27, 'single_choice',
     'Debris at bridge', true, true,
     '[{"value": "none", "label": "None"}, {"value": "half_truck", "label": "0.5 truckload"}, {"value": "one_truck", "label": "1 truckload"}, {"value": "multiple", "label": "Multiple truckloads"}, {"value": "six_plus", "label": "6+ truckloads"}]'::jsonb,
     'debris_amount');
end $$;
