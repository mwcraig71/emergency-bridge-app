# Questionnaire Phase 1 — Current-Form Mapping

**Status:** Groundwork only (2026-11-09). No schema applied, no app behavior
changed. Companion to `docs/questionnaire-design.md` (the design) and the
draft `supabase/migrations/018_form_templates.sql` (not applied anywhere).

**Sources read for this mapping:**

- `app/src/field/TriageFlow.tsx` — the branching form (note: the design doc
  and this file use the real path `app/src/field/`; there is no copy under
  `app/src/components/`).
- `app/src/field/PhotoSection.tsx` — photo slots.
- `supabase/migrations/001_emergency_app_schema.sql` — `emg_inspections`
  columns and CHECK constraints.

---

## Blocking questions for Michael (priority order)

Phase 1 splits in two halves. The **schema half** (migration 018 draft)
needs *no* decision — it is identical under either design fork. The
**Form Builder half** (State ops tab, validation panel, publish flow)
cannot be built until items 1–2 are decided. Item 3 has a safe default
and only gates finalizing the publish flow.

1. **The fork: locked core + free state additions, or full state
   control?** (Design §3, §8.1.) Under locked-core, the mapped questions
   that drive dashboards (`destroyed`, `access`, `drone_used`,
   `bridge_still_there`, `remain_open`, `safe_load`, …) cannot be
   deleted or unmapped; states only add their own questions around them.
   Under full control, a state can remove/unmap any question and the
   builder can only warn. This decides the builder's maps-to picker,
   delete rules, and publish validation — it must be settled before any
   builder code is written. The schema, seed, and this mapping are the
   same either way.
2. **If full control: warn or *block* when a state unmaps `destroyed`,
   `remain_open`, or `safe_load`?** (Design §8.1.) Unmapping any of
   these silently degrades the dashboards: no `destroyed` → the outcome
   engine can never produce `destroyed`; no `remain_open` → every new
   complete inspection lands in the open-unknown bucket and closed /
   restricted counts quietly vanish; no `safe_load` → reduced-load
   status disappears from firm boards. The design recommends *warn* in
   v1 (type-to-confirm), block only if a state hurts itself. Needs a
   yes/no from Michael before the publish flow's validation panel is
   built. (Moot if item 1 lands on locked-core.)
3. **Publishing a new version mid-event.** (Design §8.4.) Two inspectors
   in the same firm can legitimately file under different versions after
   a republish. Design default: allow it, show a soft notice in the
   builder if inspections were filed under the current version in the
   last 24 h. Confirm the soft-notice default is acceptable, or say if
   publishing should be restricted during an active event. Does not
   block starting the builder; blocks finalizing publish.

Everything else in design §8 already has a workable default and does
**not** block Phase 1: damage questions losing their pre-answered "no"
(§8.2 — ambiguity preserved via DB defaults), `overtop_depth_unknown`
staying answer-only (§8.3), orphaned trigger detection as a
publish-blocking validation error (§8.5), multi-choice "contains"
trigger semantics (§8.6), wide CSV exports (§8.7), legacy photo-type
handling (§8.8), Spanish prompts as free text (§8.9), and a soft nesting
-depth warning (§8.10).

---

## Mapping table — current questions → DB columns → outcome-engine role

Step names are TriageFlow's `STEP_ORDER`. "Required" is what
`finish()` actually validates today, per outcome. Outcome-engine roles
refer to design §6.3 (the fixed rule set that derives `triage_list`).

| # | Question (current wording) | TriageFlow step | Type | Parent / trigger | Required today (validated in `finish()`) | DB column(s) written | `maps_to_system_field` | Outcome-engine role |
|---|---|---|---|---|---|---|---|---|
| 1 | Was the bridge destroyed? | `destroyed` | yes_no | root | Always — every outcome | `emg_inspections.destroyed` (NOT NULL, CHECK yes/no) | `destroyed` | **Rule 1:** `= 'yes'` → outcome `destroyed`. Gates the entire flow (yes → photos path; no → everything else). |
| 2 | Bridge profile photo | `destroyed_photos` | photo | #1 = yes | Required (min 1) for outcome `destroyed` only | `emg_inspection_photos` row, `photo_type = 'destroyed_profile'` | — (photo; legacy type carried in question `config`) | Gate for Rule 1: `finish('destroyed')` refuses without #2 **and** #3. |
| 3 | Approach-location photo — stand where the approach was, looking across where the bridge was | `destroyed_photos` | photo | #1 = yes | Required (min 1) for outcome `destroyed` only | `emg_inspection_photos` row, `photo_type = 'destroyed_approach'` | — | Gate for Rule 1 (with #2). |
| 4 | Were you able to access the bridge? | `access` | yes_no | #1 = no | Required for outcome `complete` | `emg_inspections.access` (CHECK yes/no) | `access` | **Branch point for Rules 2–5:** `= 'no'` enters the drone sub-flow (Rules 2–4); `= 'yes'` leads to the full inspection → Rule 5 (`complete`). |
| 5 | Was drone reconnaissance used? | `drone` | yes_no | #4 = no | Required for outcome `revisit` | `emg_inspections.drone_used` (CHECK yes/no) | `drone_used` | **Rules 2–4 input:** `= 'no'` → `revisit` (via the `revisit_note` info screen); `= 'yes'` → #6 decides between Rules 2 and 3. |
| 6 | Is the bridge still there? (drone observation) | `still_there` | yes_no | #5 = yes | Required for outcomes `ground_followup` and `likely_destroyed` | `emg_inspections.bridge_still_there` (CHECK yes/no) | `bridge_still_there` | **Rules 2–3 input:** `= 'no'` → confirmation screen → `likely_destroyed`; `= 'yes'` → finishes immediately as `ground_followup`. |
| 7 | Has the bridge overtopped? | `overtopped` | yes_no | #4 = yes | Required for outcome `complete` | `emg_inspections.overtopped` (CHECK yes/no) | `overtopped` | None for `triage_list`. Feeds the overtopping stream rollup (separate design) and the review screen. |
| 8 | Maximum depth of overtopping (ft) | `overtopped` (same card, revealed inline) | number (≥ 0, step 0.1) + "Depth unknown" toggle | #7 = yes | Required for `complete` when #7 = yes: a valid depth **or** the unknown toggle | `emg_inspections.overtop_depth_ft` (numeric, CHECK ≥ 0). The unknown toggle writes **only** the draft field `overtop_depth_unknown` — it is *not* a DB column and is dropped at sync today (design §8.3). | `overtop_depth_ft` | None for `triage_list`. Rollup input (with #7). In the template system the unknown flag survives in the answer JSON (`{"value": null, "unknown": true}`). |
| 9 | Damage to rail | `damage` | yes_no | #4 = yes | Not validated — pre-filled `'no'` in `freshDraft()` | `emg_inspections.damage_rail` (NOT NULL DEFAULT 'no') | `damage_rail` | None. Side effect: `= 'yes'` reveals photo slot #17 (via `damageFlags` in PhotoSection). |
| 10 | Damage to deck | `damage` | yes_no | #4 = yes | Not validated — pre-filled `'no'` | `emg_inspections.damage_deck` (NOT NULL DEFAULT 'no') | `damage_deck` | None. Reveals photo slot #18 when yes. |
| 11 | Damage to superstructure | `damage` | yes_no | #4 = yes | Not validated — pre-filled `'no'` | `emg_inspections.damage_super` (NOT NULL DEFAULT 'no') | `damage_super` | None. Reveals photo slot #19 when yes. |
| 12 | Damage to substructure | `damage` | yes_no | #4 = yes | Not validated — pre-filled `'no'` | `emg_inspections.damage_sub` (NOT NULL DEFAULT 'no') | `damage_sub` | None. Reveals photo slot #20 when yes. |
| 13 | Approach washout behind abutments | `damage` | yes_no | #4 = yes | Not validated — pre-filled `'no'` | `emg_inspections.washout_abutment` (NOT NULL DEFAULT 'no') | `washout_abutment` | None. Reveals photo slot #21 when yes. |
| 14 | Upstation approach photo | `photos` | photo | #4 = yes | Optional | `emg_inspection_photos` row, `photo_type = 'upstation'` | — | None. Standard slot in PhotoSection `STANDARD_SLOTS`. |
| 15 | Bridge profile photo | `photos` | photo | #4 = yes | Optional | `emg_inspection_photos` row, `photo_type = 'profile'` | — | None. Distinct from #2 (different `photo_type`, different branch). |
| 16 | Downstation approach photo | `photos` | photo | #4 = yes | Optional | `emg_inspection_photos` row, `photo_type = 'downstation'` | — | None. |
| 17 | Rail damage *(photo slot)* | `photos` | photo | #9 = yes | Optional | `emg_inspection_photos` row, `photo_type = 'rail'` | — | None. Slot exists only while #9 = yes (`DAMAGE_MAP` in PhotoSection). |
| 18 | Deck damage *(photo slot)* | `photos` | photo | #10 = yes | Optional | `emg_inspection_photos` row, `photo_type = 'deck'` | — | None. |
| 19 | Superstructure damage *(photo slot)* | `photos` | photo | #11 = yes | Optional | `emg_inspection_photos` row, `photo_type = 'super'` | — | None. |
| 20 | Substructure damage *(photo slot)* | `photos` | photo | #12 = yes | Optional | `emg_inspection_photos` row, `photo_type = 'sub'` | — | None. |
| 21 | Washout photo | `photos` | photo | #13 = yes | Optional | `emg_inspection_photos` row, `photo_type = 'washout'` | — | None. |
| 22 | Condition photos, each with a note *(free-form, unlimited)* | `photos` | photo (+ per-photo note text) | #4 = yes | Optional | `emg_inspection_photos` rows, `photo_type = 'condition'`; note → that row's `description` | — | None. The only photo type whose note is part of the answer today; other slots also accept notes via the same input, stored the same way. |
| 23 | Can the bridge remain open? | `decisions` | single_choice: `yes` / `no` / `restricted_lanes` ("Restricted lane access") | #4 = yes | Required for outcome `complete` | `emg_inspections.remain_open` (CHECK yes/no/restricted_lanes) | `remain_open` | None for `triage_list` itself, but **primary dashboard input**: firm `classify()` and State ops open/restricted/closed tallies read this column on `complete` inspections (design Appendix B). |
| 24 | Notes *(under remain-open)* | `decisions` | text | #4 = yes (sibling of #23, not a child of it) | Optional | `emg_inspections.remain_open_notes` | `remain_open_notes` | None. Shown on the review screen when non-empty. |
| 25 | Is it safe to carry load? | `decisions` | single_choice: `yes` / `no` / `reduced_load` ("Reduced load") | #4 = yes | Required for outcome `complete` | `emg_inspections.safe_load` (CHECK yes/no/reduced_load) | `safe_load` | None for `triage_list`. Firm-board input only: `classify()` maps `reduced_load` → "Reduced load" status; state rollups do not read it (design Appendix B). |
| 26 | Notes *(under safe-load)* | `decisions` | text | #4 = yes (sibling of #25) | Optional | `emg_inspections.safe_load_notes` | `safe_load_notes` | None. |
| 27 | Debris at bridge | `decisions` | single_choice: `none` / `half_truck` ("0.5 truckload") / `one_truck` ("1 truckload") / `multiple` ("Multiple truckloads") / `six_plus` ("6+ truckloads") | #4 = yes | Required for outcome `complete` | `emg_inspections.debris_amount` (CHECK the five values) | `debris_amount` | None. Detail/review only today. |

## Not questions — outcomes and auto-captured data

| Item | Where it comes from today | DB column | Role in the template system |
|---|---|---|---|
| Outcome `destroyed` | "Finish: mark DESTROYED" button on the `destroyed_photos` step | `triage_list` | Outcome engine Rule 1 (#1 = yes, gated on photos #2–#3). Never mappable. |
| Outcome `revisit` | "Place on revisit list" button on the `revisit_note` info screen ("Find alternate access…") | `triage_list` | Rule 4 (access = no, drone = no path). The info screen becomes renderer copy, not a question. |
| Outcome `likely_destroyed` | "Confirm: likely destroyed" button on the confirmation pseudo-step reached from `still_there` = No | `triage_list` | Rule 2. The confirmation becomes an outcome-confirmation prompt in the renderer. |
| Outcome `ground_followup` | Tapping Yes on `still_there` calls `finish('ground_followup')` immediately — no separate screen | `triage_list` | Rule 3. |
| Outcome `complete` | "Save inspection" button on the read-only `review` step | `triage_list` | Rule 5 (fall-through). The review screen is generated from answers; it is not a question. |
| GPS fix | `getGpsFix()` on mount, best-effort | `gps_lat`, `gps_lon` | Auto-captured; never mappable. |
| Coordinate mismatch | `isCoordMismatch()` — fix > 100 m from NBI coords → in-app warning banner | `coord_mismatch` ('yes'/'no') | Auto-captured; never mappable. |
| Inspector name | Entered before the flow; `finish()` validates non-empty | `inspector_name` | App-level requirement, stays outside the template. |
| Inspection datetime, device, firm, dedupe key, sync state | Draft creation / sync layer | `inspection_datetime`, `device_id`, `firm_id` (via assignment context), `client_inspection_id`, `sync_status` | App bookkeeping; never mappable. Phase 2 adds `form_template_id` + `form_version` to the draft at start time. |

## Implementation notes from the code read (for Phase 1/2 builders)

1. **Photo questions need their legacy `photo_type` in the seed.** Design
   §4.4 says *new* form photos use `photo_type = 'form:<question_id>'`,
   but the default template must reproduce today's rows exactly, or
   legacy detail views and the Phase 2 side-by-side test break. The
   draft migration therefore seeds each default-template photo question
   with `config = {"photo_type": "<legacy type>"}` (plus
   `{"min_count": 1}` on #2–#3). The Phase 2 renderer rule: if a photo
   question's config carries `photo_type`, write that; otherwise write
   `form:<question_id>`.
2. **Damage pre-fill.** `freshDraft()` pre-answers #9–#13 as `'no'`;
   the seeded template marks them not-required with no pre-fill, per
   design Appendix A note 1. The DB columns keep `NOT NULL DEFAULT
   'no'`, so the server-side picture is unchanged when a state leaves
   them optional.
3. **Validation is per-outcome today, generated tomorrow.** `finish()`
   checks a different required set per `triage_list` value (see the
   Required column). The template system replaces this with "every
   visible required question answered" (design §6.2) — the mapping
   above is the equivalence proof for the default template.
4. **`unique (template_id, parent_question_id, sort_order)` caveat.**
   Postgres treats NULLs as distinct in unique indexes, so the
   constraint in design §4.2 does not actually prevent duplicate
   `sort_order` among *root* questions. Kept as designed in the draft
   migration; ordering integrity for roots is a builder responsibility
   unless Michael wants a stricter constraint later. Not a blocker.
5. **Design-doc discrepancy check:** Appendix A's question set, wording,
   triggers, and required flags match the code exactly (verified line
   by line against `TriageFlow.tsx` / `PhotoSection.tsx`, including the
   `still_there` confirmation pseudo-step, which the code implements by
   intercepting a non-`STEP_ORDER` step value). No corrections needed.
