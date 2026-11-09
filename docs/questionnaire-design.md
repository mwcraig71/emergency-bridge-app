# Per-State Configurable Inspection Questionnaire — Design

**Status:** Design only (2026-10-19). No code or schema has been changed.
**Scope:** Replace the hard-coded field-app triage form with a per-state
configurable questionnaire, administered in State ops, rendered in the field
app, with nested (conditional) questions. The current form becomes the
built-in default template.
**Companion docs:** `docs/overtopping-design.md` (separate feature).

---

## 1. Where we are today

The field inspection form is `app/src/field/TriageFlow.tsx` — a hand-written,
branching state machine of 11 full-screen steps (plus one intercepted
pseudo-step), with every question, branch, and validation rule written as
JSX. Answers write to fixed columns on `emg_inspections` (migration 001),
and the dashboards derive every status rollup from four of those columns:
`triage_list`, `remain_open`, `safe_load`, and (for the stream rollup in the
overtopping design) `overtopped` / `overtop_depth_ft`.

Consequences of the current shape:

- Any question change — even wording — is a code change, a build, and an
  OTA release.
- All states share one form. There is no way for a state to add its own
  questions (e.g. a state-specific scour or detour question).
- Validation is duplicated: `finish()` in TriageFlow checks a different
  required-field set per triage outcome, and `pushOne()` in
  `app/src/lib/sync.ts` re-checks a subset at sync time.
- The exact current question set is inventoried in **Appendix A**; it is
  the specification for the default template.

Things the current form already does that the new system must preserve:

- **Branching / nesting.** Access = No routes to a drone sub-flow;
  overtopped = Yes reveals a required depth input; each damage = Yes
  reveals a matching photo slot in the Photos step (`PhotoSection.tsx`).
- **Photo prompts as questions.** Two photos are *required* to finish a
  destroyed-bridge inspection; damage photos are conditional.
- **Offline-first.** Drafts persist in IndexedDB and sync via the queue
  (`client_inspection_id` dedupe, newest wins). Templates must work the
  same way.
- **Dashboard contract.** StatusBoard's `classify()` and State ops'
  `computeFirmProgress` / `computeStateOverview` (`lib/stateDashboard.ts`)
  read only `triage_list`, `remain_open`, `safe_load`. As long as those
  columns keep being written, every existing rollup, filter, map color,
  and export keeps working unchanged.

## 2. Goals and non-goals

**Goals**

1. Each state defines its own inspection questions in State ops: add,
   edit, delete, reorder — no code release needed.
2. Question types: **yes_no, text, number, single_choice, multi_choice,
   photo**.
3. **Nesting:** any question can be a child of another question and appear
   only when the parent is answered a specific way
   (`parent_question_id` + `trigger_answer`). Unlimited depth.
4. The current form ships as the **default template**; a state starts from
   a copy of it and customizes.
5. Answers to designated questions **write through** to the core
   `emg_inspections` columns so dashboard rollups never change.
6. Full answer history stays readable forever, even after a state edits or
   deletes questions (**prompt snapshots** on every answer).
7. Versioning: publishing freezes a version; an inspection keeps the
   template version it started with, even mid-event.

**Non-goals (v1)**

- No cross-state template sharing marketplace; states copy the default or
  start blank. (Copying another state's published template is a cheap
  follow-on.)
- No calculated/derived questions, no scoring, no skip-logic beyond
  parent-trigger reveal.
- No change to roadblock reports, team tracking, or DriveNC layers.
- No change to how inspectors log in or how assignments work.

## 3. Core concepts

- **Template** — one state's questionnaire at one version. States have at
  most one *draft* and one *published* template at a time (plus archived
  history and the system default).
- **Question** — a row in a tree. Root questions have
  `parent_question_id = NULL`. A child is visible only when its parent is
  visible *and* the parent's answer matches `trigger_answer`.
- **Trigger answer** — for `yes_no` parents: `'yes'` or `'no'`. For
  `single_choice` / `multi_choice` parents: one of the parent's option
  values (for multi_choice: "answer contains this value"). The builder
  restricts trigger parents to yes_no / single_choice / multi_choice —
  free-text and numeric triggers are too fragile to author reliably.
- **Mapped question** — a question with `maps_to_system_field` set. Its
  answer is *also* written to that core `emg_inspections` column at save
  time. Only mapped questions can affect dashboards. The allowlist of
  mappable fields is fixed in code (Appendix C).
- **Outcome** — the value written to `triage_list`. Today the outcome is
  chosen by which Finish button the inspector taps, not derived from
  answers. The questionnaire keeps a small built-in **outcome engine**
  (Section 6.3) driven by the mapped triage questions, so the default
  template reproduces today's five outcomes exactly. A state that removes
  the mapped triage questions gets `complete` for every finished
  inspection — see Risks.
- **Snapshot** — every stored answer carries the question's prompt (and
  type) as it read when the inspection was taken, so deleted or reworded
  questions still render faithfully in detail views and exports.

## 4. Data model — migration 018

> **Migration numbering:** the questionnaire takes **018**. The NC division
> boundaries work (previously planned as 018) shifts to **019**. Note the
> repo's migration *files* currently end at 016; 017
> (`emg_states.share_firm_progress`) exists only in prod, applied via the
> Management API. New files start at 018 — do not renumber 017 into the
> repo as part of this work.

### 4.1 `emg_form_templates`

```sql
create table public.emg_form_templates (
  id           uuid primary key default gen_random_uuid(),
  state_code   text references public.emg_states(code),  -- NULL = system default
  name         text not null,          -- e.g. 'NC post-storm triage'
  version      integer not null,       -- 1, 2, 3… per state
  status       text not null check (status in ('draft','published','archived')),
  is_default   boolean not null default false,  -- the seeded built-in template
  created_by   text,                   -- admin email
  created_at   timestamptz not null default now(),
  published_at timestamptz,
  published_by text,
  unique (state_code, version)
);
-- partial unique indexes: at most one draft and one published per state
create unique index emg_form_templates_one_draft
  on public.emg_form_templates (state_code) where status = 'draft';
create unique index emg_form_templates_one_published
  on public.emg_form_templates (state_code) where status = 'published';
```

**Publish flow:** publishing a draft (a) sets the draft row to
`published` and the previously published row to `archived` in one
transaction, then (b) clones the published row and its questions into a
new `draft` row with `version + 1`, ready for the next round of edits.
Published and archived rows are immutable — the builder only ever edits
the draft. This is what "publishing freezes a version" means in practice.

**Seeding:** migration 018 inserts the system default template
(`state_code = NULL`, `is_default = true`, version 1, status `published`)
with the question set from Appendix A. A state's first action in the Form
Builder is **"Start from default template"**, which clones the default
into that state's draft v1. (States that never customize simply use the
default as-is — the field app falls back to the default template when a
state has no published template of its own.)

### 4.2 `emg_form_questions`

```sql
create table public.emg_form_questions (
  id                  uuid primary key default gen_random_uuid(),
  template_id         uuid not null references public.emg_form_templates(id)
                        on delete cascade,
  parent_question_id  uuid references public.emg_form_questions(id)
                        on delete cascade,
  trigger_answer      text,            -- value that reveals this question;
                                       -- NULL only for root questions
  sort_order          integer not null,
  type                text not null check (type in
                        ('yes_no','text','number','single_choice',
                         'multi_choice','photo')),
  prompt              text not null,
  help_text           text,
  required            boolean not null default false,
  options             jsonb,           -- choice types only:
                        -- [{"value":"yes","label":"Yes"}, …]
  config              jsonb,           -- type extras, e.g. number:
                        -- {"min":0,"step":0.1,"unit":"ft","allow_unknown":true}
                        -- photo: {"min_count":1,"max_count":null}
  maps_to_system_field text            -- allowlist enforced in app code
                        check (maps_to_system_field is null or
                               maps_to_system_field in (/* Appendix C */)),
  created_at          timestamptz not null default now(),
  unique (template_id, parent_question_id, sort_order)
);
```

Authoring rules (enforced in the builder, sanity-checked server-side on
publish):

- `trigger_answer` is required iff `parent_question_id` is set, and must
  be a legal value of the parent's type (parent must be yes_no,
  single_choice, or multi_choice).
- A question's parent must belong to the same template, must not be
  itself, and must not create a cycle (the builder only offers eligible
  parents — questions that appear earlier in the tree — which makes
  cycles impossible by construction).
- A mapped field may be claimed by **at most one question per template**
  (partial unique index on `(template_id, maps_to_system_field)` where
  not null). Two questions writing one column is always a bug.
- Deleting a parent deletes its subtree (cascade) — the builder shows the
  full subtree in the delete confirmation.

### 4.3 `emg_inspections` changes

```sql
alter table public.emg_inspections
  add column form_template_id uuid references public.emg_form_templates(id),
  add column form_version integer;
```

Both nullable: every pre-questionnaire inspection keeps NULLs and renders
through the legacy detail view. `form_version` is denormalized from the
template row so exports and detail views can label "NC form v3" without a
join, and so the record stays self-describing even if template rows are
later archived.

The core answer columns (`destroyed`, `access`, …, Appendix C) **stay
exactly as they are**, including their CHECK constraints and the
`damage_*` NOT NULL defaults. They remain the dashboards' contract; the
questionnaire writes them via write-through (Section 6.2), never the
other way around.

### 4.4 `emg_inspection_answers`

```sql
create table public.emg_inspection_answers (
  id              uuid primary key default gen_random_uuid(),
  inspection_id   uuid not null references public.emg_inspections(id)
                    on delete cascade,
  question_id     uuid,                -- deliberately NO foreign key:
                                       -- questions in archived versions are
                                       -- never deleted, but a hard FK would
                                       -- couple history to builder deletes;
                                       -- the snapshots below are the record.
  prompt_snapshot text not null,
  type_snapshot   text not null,
  sort_snapshot   integer,             -- position when answered
  answer          jsonb,               -- shape by type, see below
  created_at      timestamptz not null default now(),
  unique (inspection_id, question_id)
);
create index emg_inspection_answers_inspection_idx
  on public.emg_inspection_answers (inspection_id);
```

Answer JSONB shapes by type:

| Type | `answer` example |
|---|---|
| yes_no | `{"value": "yes"}` |
| text | `{"value": "Water over the south approach"}` |
| number | `{"value": 3.5}` or `{"value": null, "unknown": true}` |
| single_choice | `{"value": "restricted_lanes"}` |
| multi_choice | `{"value": ["debris", "scour"]}` |
| photo | `{"photo_ids": ["<photo uuid>", …]}` — photos themselves still live in `emg_inspection_photos` / the `emg-photos` bucket; the answer links them to the question. New form photos use `photo_type = 'form:<question_id>'` (`photo_type` is plain text with no CHECK today, so no schema change is needed). |

Answers are written in the same sync push as the inspection row
(Section 6.2), upserted on `(inspection_id, question_id)`, so retries are
idempotent exactly like the inspection upsert.

### 4.5 RLS

Consistent with the current pilot posture: RLS enabled with permissive
policies, scoping enforced in the app (state admins see only their
state's templates because State ops already scopes by `emg_admins`).
Templates and questions are read-only to the field app (anon key reads
published templates only, via the app query, same pattern as roster
sync). Tightening RLS remains a pre-rollout task shared with the rest of
the app, not something this feature introduces or worsens.

## 5. State ops — Form Builder tab

New tab in the State Dashboard: **Form Builder**, visible to super_admin
(scoped by the existing state selector) and state_admin (own state only).
Firm admins do not see it.

Capabilities:

- **Template header:** state, current published version + publish date,
  draft status ("Draft v4 — 6 changes since v3"), buttons: *Start from
  default template* (first run), *Edit draft*, *Publish draft*,
  *View version history* (archived versions, read-only).
- **Question tree editor:** the draft as an indented tree.
  - Add question (root or as a child of any eligible question), delete
    (with subtree warning), drag/keyboard reorder within a level.
  - Per-question editor: type, prompt, help text, required toggle,
    options editor for choice types (value + label rows), type config
    (number min/step/unit/allow-unknown; photo min/max count),
    trigger-answer picker for children (populated from the parent's
    legal values), **maps-to field picker** (allowlist dropdown, shows
    which fields are already claimed).
  - Live validation panel: unclaimed-but-expected mappings, children
    whose trigger no longer matches a parent option (e.g. after the
    parent option was renamed), required question inside an optional
    branch, empty option lists, duplicate option values.
  - **Mapped-field warnings:** removing or unmapping `destroyed`,
    `remain_open`, or `safe_load` produces a hard warning (not a block)
    spelling out the dashboard consequence (Section 8) and requires the
    admin to type-confirm.
- **Preview:** renders the draft with the *actual field-app renderer*
  (same component, interactive, answers stored in local state only) in a
  phone frame, so what the state sees is byte-for-byte what inspectors
  get — including nesting reveals. A "test answers" mode lets the admin
  tap through branches quickly.
- **Publish:** runs the validation panel; errors block, warnings require
  acknowledgment. Publishing is the flow in Section 4.1. The publish
  confirmation lists the version number and a plain-language diff summary
  (questions added/removed/reworded since the last published version),
  because field devices will pick this up at their next sync.

## 6. Field app

### 6.1 Template delivery and offline cache

- At sync time (same pass that syncs firms and rosters), the app fetches
  the published template + questions for the inspector's state and stores
  them in a new IndexedDB store (`form_templates`), keyed by
  `(state_code, version)`. If the state has no published template, the
  system default is fetched and cached instead.
- Starting an inspection records `form_template_id` + `form_version` on
  the draft from the cached published version **at start time**. Drafts
  already in progress keep their version even if a newer one syncs
  mid-event. A device that has never synced a template falls back to a
  compiled-in copy of the default template (shipped in the bundle,
  generated from the same seed as migration 018) — an inspector is never
  blocked from inspecting by a missing template.
- The bridge's state (from the asset-ID prefix / bridge record) decides
  which state's template applies — relevant for multi-state firms
  (Strinteg and HDR serve NC + SC). The template is chosen per
  inspection, not per login.

### 6.2 Rendering and saving

- The renderer walks the question tree recursively: a question renders
  when its parent chain is visible and each trigger matches the current
  answers. Layout follows the current form's language — one card per
  step-group, big segmented Yes/No controls (selected Yes = green,
  No = red, choices = burnt orange), photo slots via the existing
  `PhotoSection` mechanics.
- Grouping into screens: root questions are paged in sort order; the
  default template's tree reproduces today's step flow (Appendix A
  notes the step each question came from). A progress indicator shows
  *n of m* visible required questions answered instead of today's fixed
  11-step dots.
- Answers live on the draft keyed by `question_id` (plus the prompt/type
  snapshot copied at draft creation, so the draft is self-contained
  offline).
- **Write-through:** when a mapped question is answered, the draft's
  corresponding core field is set from the answer (value mapping:
  yes_no → `'yes'/'no'`; choice → the option `value`, which the builder
  constrains to the column's legal values for mapped questions; number →
  numeric). The review screen and `finish()` read the core fields
  exactly as today.
- **Completion validation** is generated, not hand-written: every
  *visible required* question must be answered (photo questions: at
  least `min_count` photos). This replaces both of today's validation
  copies for form-driven fields. Inspector name and asset ID remain
  app-level requirements as today.
- **Sync:** the inspection push (`pushOne`, `lib/sync.ts`) gains
  `form_template_id` + `form_version` on the `emg_inspections` upsert,
  then upserts the draft's answers into `emg_inspection_answers` in the
  same queue item — if the answers fail, the whole item stays queued,
  same failure semantics as photos today.

### 6.3 The outcome engine (triage_list)

`triage_list` is not an answer; it is the inspection's disposition, and
the dashboards count on its five values. The questionnaire derives it
with a fixed rule set over the *mapped* answers, evaluated at finish:

1. `destroyed = 'yes'` → **destroyed**
2. else `access = 'no'` and `drone_used = 'yes'` and
   `bridge_still_there = 'no'` → **likely_destroyed**
3. else `access = 'no'` and `drone_used = 'yes'` and
   `bridge_still_there = 'yes'` → **ground_followup**
4. else `access = 'no'` → **revisit**
5. else → **complete**

This reproduces today's button-driven outcomes exactly, including the
confirmation screens, which become outcome-confirmation prompts in the
renderer ("This will file the bridge as Likely Destroyed — confirm?").
If a state removes one of the mapped triage questions, the rules that
mention it simply can't fire, and inspections fall through to
**complete** — predictable, and called out in the publish warnings.

## 7. Reporting

- **Inspection detail views** (firm ops StatusBoard detail, State ops):
  if `form_template_id` is set, render the Q&A from
  `emg_inspection_answers` ordered by `sort_snapshot`, prompt from the
  snapshot, nested answers indented under their parent question's answer
  (parent linkage resolved via `question_id` within the same template
  version, falling back to flat order). Photo answers render the linked
  photos inline. Inspections with NULL template (all historical ones)
  render through today's legacy field list.
- **CSV / GeoJSON export** (`lib/export.ts`): keep all existing core
  columns first (downstream consumers — ArcGIS/Survey123 shape — must
  not break), then append **one column per question** in the exported
  set, headed by the prompt snapshot (deduplicated across versions by
  prompt text; values are the answer's display value — label for choice
  answers, number/text as entered, photo count + links for photo
  answers). Exports spanning multiple template versions union the
  question columns; a bridge inspected under v2 and v3 shows blanks
  where a question didn't exist in its version.
- **Answer-driven actions (Phase 3):** a question can carry an action
  flag in `config` — v1 ships one: `{"flag_for_review": true}` on a
  yes_no or choice question + a trigger value; when an inspection syncs
  with that answer, the office gets an `emg_notifications` entry
  (existing table and plumbing) naming the bridge and the answer. This
  gives states "tell us immediately if X" without new infrastructure.

## 8. Open questions and risks

1. **A state removes a mapped core question — what happens to rollups?**
   The core column simply stays NULL/default for every new inspection.
   Concretely: remove `remain_open` and every new `complete` inspection
   lands in State ops' *open-unknown* bucket and the firm board's
   classify() falls through to "open" — the state would quietly lose its
   closed/restricted counts. Remove `destroyed` and the outcome engine
   can never produce `destroyed`. Remove `safe_load` and the reduced-load
   status disappears from firm boards (state rollups don't use it).
   Mitigations in this design: publish-time hard warnings, one-question-
   per-field enforcement, and the default template always available to
   re-copy. **Open decision:** should unmapping `destroyed`,
   `remain_open`, or `safe_load` be *blocked* outright rather than
   warned? Recommendation: warn in v1; block only if a state actually
   hurts itself.
2. **Damage questions lose their "pre-answered No" behavior.** Today the
   five damage fields default to `'no'` (draft and DB), so "not looked
   at" and "looked, no damage" are indistinguishable. As template
   questions they start unanswered. If a state makes them optional and
   inspectors skip them, write-through leaves the core columns at their
   DB default `'no'` — same ambiguity, preserved. If a state wants true
   "unassessed" tracking it can make them required; the answers table
   records the truth either way.
3. **`overtop_depth_unknown` never synced historically.** Today the
   "depth unknown" toggle is local-only; the server sees NULL depth.
   The number type's `allow_unknown` config formalizes this in the
   answers table (`{"value": null, "unknown": true}`), and write-through
   keeps `overtop_depth_ft` NULL — dashboards can't tell the difference
   today and still won't; the distinction now survives in the answers
   for anyone who needs it.
4. **Version skew across a firm's inspectors.** Mid-event republication
   means two inspectors can legitimately file under different versions.
   Exports and detail views are snapshot-based, so this is a reporting
   nuisance, not a data problem. Should publishing be discouraged during
   an active event? The builder shows a soft notice if inspections were
   filed under the current version in the last 24 h.
5. **Trigger-answer edits.** Renaming a parent option value in the draft
   orphans children keyed to the old value. The validation panel flags
   orphaned triggers as publish-blocking errors.
6. **Multi-choice trigger semantics.** "Contains" is the only sane rule;
   it is also the easiest to mis-author ("child appears if ANY of A/B"
   vs "if A specifically"). The builder UI must word this precisely.
7. **CSV column growth.** A state with 60 questions across 3 versions can
   produce a very wide export. Acceptable for v1; a per-template-version
   export filter is the follow-on if it bites.
8. **Photo-type collisions.** Form photos share `emg_inspection_photos`
   with the legacy photo types via the `form:<question_id>` prefix;
   legacy detail views must ignore types they don't know (they currently
   group by known types — verify in Phase 3).
9. **Spanish-language forms (PR).** Prompts are free text, so a state
   *can* author in Spanish today; true bilingual templates (same
   question, two prompt languages keyed to the inspector's device) are
   out of scope but the schema doesn't preclude a `prompt_i18n` JSONB
   later.
10. **Builder power vs. guardrails.** Unlimited nesting + required
    questions in deep branches can create inspections that are nearly
    impossible to complete in the field. The preview's tap-through mode
    is the main defense; consider a soft depth warning beyond 3 levels.

## 9. Phased build plan

**Phase 1 — Schema + builder + preview** (migration 018)
- Migration 018: tables in Section 4, default template seed
  (Appendix A), `emg_inspections` columns.
- `lib/forms.ts`: template fetch/clone/publish, validation rules,
  allowlist.
- State ops **Form Builder** tab: tree editor, question editor,
  validation panel, publish flow with diff summary, version history.
- Preview using a shared renderer component (built now, read-only data)
  so Phase 2 reuses it verbatim.
- Default template verified question-for-question against Appendix A.
- *Field app untouched in this phase — inspectors see no change.*

**Phase 2 — Field-app rendering + offline sync**
- Template sync + IndexedDB cache + compiled-in default fallback.
- Recursive renderer replaces TriageFlow's hard-coded steps (the
  component is retired once the default template renders identically);
  outcome engine (Section 6.3); generated completion validation.
- Draft model gains per-question answers + snapshots; write-through to
  core fields; sync push extended (template columns + answers upsert).
- Crash-resume keeps working: template version is stored on the draft,
  answers are part of the draft record.
- Device verification gate: run the default template side-by-side with
  the old flow on the same bridges before OTA — outcomes and core
  columns must match exactly.

**Phase 3 — Reporting, exports, actions**
- Q&A rendering in inspection detail views (firm + state), legacy view
  retained for pre-questionnaire inspections.
- CSV/GeoJSON export gains per-question columns (Section 7).
- `flag_for_review` answer actions → `emg_notifications`.
- Overtopping tie-in: the stream rollup reads `overtopped` /
  `overtop_depth_ft` from core columns as designed there; states that
  keep the mapped overtopping questions (the default does) feed it
  unchanged.

---

## Appendix A — The current form as the default template

Flow order, from `TriageFlow.tsx` + `PhotoSection.tsx` (2026-10-19).
"Maps to" is the `emg_inspections` column (photo answers map to
`emg_inspection_photos` rows). Required means the inspection cannot
finish without it *when the question is visible* (today's `finish()`
validation in TriageFlow).

| # | Prompt (exact current wording) | Type | Answer values | Maps to | Parent / trigger | Required |
|---|---|---|---|---|---|---|
| 1 | Was the bridge destroyed? | yes_no | yes / no | `destroyed` | root | yes |
| 2 | Bridge profile photo | photo | ≥1 photo | `emg_inspection_photos.photo_type = 'destroyed_profile'` | #1 = yes | yes (min 1) |
| 3 | Approach-location photo — stand where the approach was, looking across where the bridge was | photo | ≥1 photo | `…photo_type = 'destroyed_approach'` | #1 = yes | yes (min 1) |
| 4 | Were you able to access the bridge? | yes_no | yes / no | `access` | #1 = no | yes |
| 5 | Was drone reconnaissance used? | yes_no | yes / no | `drone_used` | #4 = no | yes |
| 6 | Is the bridge still there? (drone observation) | yes_no | yes / no | `bridge_still_there` | #5 = yes | yes |
| 7 | Has the bridge overtopped? | yes_no | yes / no | `overtopped` | #4 = yes | yes |
| 8 | Maximum depth of overtopping (ft) | number | ≥ 0, step 0.1, or "Depth unknown" toggle | `overtop_depth_ft` (+ `unknown` flag in answer only) | #7 = yes | yes (value or unknown) |
| 9 | Damage to rail | yes_no | yes / no | `damage_rail` | #4 = yes | no¹ |
| 10 | Damage to deck | yes_no | yes / no | `damage_deck` | #4 = yes | no¹ |
| 11 | Damage to superstructure | yes_no | yes / no | `damage_super` | #4 = yes | no¹ |
| 12 | Damage to substructure | yes_no | yes / no | `damage_sub` | #4 = yes | no¹ |
| 13 | Approach washout behind abutments | yes_no | yes / no | `washout_abutment` | #4 = yes | no¹ |
| 14 | Upstation approach photo | photo | photos | `…photo_type = 'upstation'` | #4 = yes | no |
| 15 | Bridge profile photo | photo | photos | `…photo_type = 'profile'` | #4 = yes | no |
| 16 | Downstation approach photo | photo | photos | `…photo_type = 'downstation'` | #4 = yes | no |
| 17 | Rail damage *(photo slot)* | photo | photos | `…photo_type = 'rail'` | #9 = yes | no |
| 18 | Deck damage *(photo slot)* | photo | photos | `…photo_type = 'deck'` | #10 = yes | no |
| 19 | Superstructure damage *(photo slot)* | photo | photos | `…photo_type = 'super'` | #11 = yes | no |
| 20 | Substructure damage *(photo slot)* | photo | photos | `…photo_type = 'sub'` | #12 = yes | no |
| 21 | Washout photo | photo | photos | `…photo_type = 'washout'` | #13 = yes | no |
| 22 | *(free-form)* Condition photos, each with a note | photo | photos + per-photo note text | `…photo_type = 'condition'`, note → `description` | #4 = yes | no |
| 23 | Can the bridge remain open? | single_choice | `yes` "Yes" / `no` "No" / `restricted_lanes` "Restricted lane access" | `remain_open` | #4 = yes | yes |
| 24 | Notes *(under remain-open)* | text | free text | `remain_open_notes` | #4 = yes | no |
| 25 | Is it safe to carry load? | single_choice | `yes` "Yes" / `no` "No" / `reduced_load` "Reduced load" | `safe_load` | #4 = yes | yes |
| 26 | Notes *(under safe-load)* | text | free text | `safe_load_notes` | #4 = yes | no |
| 27 | Debris at bridge | single_choice | `none` "None" / `half_truck` "0.5 truckload" / `one_truck` "1 truckload" / `multiple` "Multiple truckloads" / `six_plus` "6+ truckloads" | `debris_amount` | #4 = yes | yes |

¹ Damage questions are pre-filled `'no'` in today's draft (and the DB
columns are `NOT NULL DEFAULT 'no'`), so they are never strictly
"unanswered" today. The default template seeds them as not-required
yes_no questions with no pre-fill; write-through preserves today's
server-side picture (Section 8, risk 2).

**Not questions — flow outcomes and auto-captured data:**

- **Outcomes** (set `triage_list`, via Section 6.3's engine): answering
  #1 = yes + photos #2–3 → finish screen "Finish: mark DESTROYED" →
  `destroyed`. #5 = no → info screen "Find alternate access. This bridge
  is placed on the REVISIT list." → `revisit`. #6 = no → confirmation
  screen "Drone observation indicates the bridge may be gone. Confirm
  classification as likely destroyed." → `likely_destroyed`. #6 = yes →
  finishes immediately → `ground_followup`. Completing the #4 = yes path
  → review screen → `complete`.
- **Auto-captured, never asked:** GPS fix → `gps_lat`, `gps_lon`;
  `coord_mismatch` = `'yes'` when the fix is > 100 m from the NBI
  coordinates (drives an in-app warning banner); `inspector_name`
  (entered before the flow), `inspection_datetime`, `device_id`,
  `firm_id`, `client_inspection_id` (dedupe key), `sync_status`.
- **Review screen** (read-only, no input): overtopped + depth, the five
  damage answers, remain-open, safe-load, debris, photo count, both
  notes — the model for the Phase 3 detail view.

**Today's branch map (for the Phase 2 side-by-side test):**

```
destroyed? ──yes──► required photos ──► DESTROYED
    │no
access? ──no──► drone used? ──no──► REVISIT
    │yes            │yes
    │           still there? ──no──► (confirm) LIKELY DESTROYED
    │               │yes──► GROUND FOLLOW-UP
    ▼
overtopped? ──yes──► depth (value or unknown)
damage ×5 ──► photos (standard + per-damage slots + condition)
decisions (remain open / safe load / debris) ──► review ──► COMPLETE
```

## Appendix B — How dashboards derive status today (unchanged by this design)

- **Firm ops StatusBoard `classify()`:** `destroyed` → Destroyed;
  `likely_destroyed` → Likely Destroyed; `revisit` → Revisit;
  `ground_followup` → Ground Follow-up; `complete` + `remain_open='no'`
  → Closed; `complete` + `remain_open='restricted_lanes'` → Restricted
  lanes; `complete` + `safe_load='reduced_load'` → Reduced load;
  otherwise Open; anything else / `in_progress` → Not started.
- **State ops (`lib/stateDashboard.ts`):** per-firm counts bucketed by
  `triage_list` (destroyed / likelyDestroyed / revisit / groundFollowup /
  complete) and open / restricted / closed tallied from `remain_open`
  (`yes` / `restricted_lanes` / `no`) on the latest inspection per
  bridge; a `complete` inspection with `remain_open` NULL counts as
  open-unknown. `safe_load` does **not** feed state rollups.
- Nothing in either path reads the damage, debris, or drone columns;
  `overtopped` / `overtop_depth_ft` are detail-only today (the
  overtopping rollup design would be their first consumer).

## Appendix C — `maps_to_system_field` allowlist

Fixed in code; the builder's mapping picker offers exactly these. A
mapped question's type is constrained to match the column:

| Field | Column type / legal values | Question type |
|---|---|---|
| `destroyed` | text: yes / no | yes_no |
| `access` | text: yes / no | yes_no |
| `drone_used` | text: yes / no | yes_no |
| `bridge_still_there` | text: yes / no | yes_no |
| `overtopped` | text: yes / no | yes_no |
| `overtop_depth_ft` | numeric ≥ 0 | number |
| `damage_rail` | text: yes / no | yes_no |
| `damage_deck` | text: yes / no | yes_no |
| `damage_super` | text: yes / no | yes_no |
| `damage_sub` | text: yes / no | yes_no |
| `washout_abutment` | text: yes / no | yes_no |
| `remain_open` | text: yes / no / restricted_lanes | single_choice |
| `remain_open_notes` | text | text |
| `safe_load` | text: yes / no / reduced_load | single_choice |
| `safe_load_notes` | text | text |
| `debris_amount` | text: none / half_truck / one_truck / multiple / six_plus | single_choice |

Never mappable: `triage_list` (set by the outcome engine),
`gps_lat` / `gps_lon` / `coord_mismatch` (auto-captured),
`inspector_name`, `inspection_datetime`, `device_id`, `firm_id`,
`client_inspection_id`, `sync_status` (app bookkeeping).
