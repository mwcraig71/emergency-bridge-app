// Compiled-in copy of the system default template (migration 018 seed),
// shipped in the bundle as the never-synced fallback: a device that has
// never completed a template sync still renders the full current form,
// so an inspector is never blocked by a missing template (design §6.1).
//
// The question set mirrors supabase/migrations/018_form_templates.sql
// question-for-question (prompts, parents, triggers, options, config,
// required flags, core flags, system-field mappings — design Appendix A).
// Ids are deterministic UUIDs in a reserved 00000000-…-d0xx range: they
// are NOT the server-seeded row ids (those are random), which is fine —
// emg_inspection_answers.question_id has no foreign key and the prompt/
// type snapshots are the durable record. Drafts started from this
// fallback carry form_template_id = null; lib/sync.ts resolves the real
// default template id at push time.
import type { FormQuestion, FormTemplate } from '../types';

export const BUILTIN_TEMPLATE_ID = '00000000-0000-4000-8000-0000000000d0';

const qid = (n: number): string =>
  `00000000-0000-4000-8000-0000000000${n.toString(16).padStart(2, '0')}`;

export const BUILTIN_TEMPLATE: FormTemplate = {
  id: BUILTIN_TEMPLATE_ID,
  state_code: null,
  name: 'Default post-storm triage',
  version: 1,
  status: 'published',
  is_default: true,
  created_by: 'migration 018',
  created_at: '2026-11-09T00:00:00.000Z',
  published_at: '2026-11-09T00:00:00.000Z',
  published_by: 'migration 018',
};

type Q = Partial<Omit<FormQuestion, 'id' | 'template_id' | 'created_at'>> &
  Pick<FormQuestion, 'sort_order' | 'type' | 'prompt' | 'required'>;

function q(n: number, partial: Q): FormQuestion {
  return {
    help_text: null,
    options: null,
    config: null,
    maps_to_system_field: null,
    parent_question_id: null,
    trigger_answer: null,
    is_core: false,
    ...partial,
    id: qid(n),
    template_id: BUILTIN_TEMPLATE_ID,
    created_at: '2026-11-09T00:00:00.000Z',
  } as FormQuestion;
}

// Parent ids by Appendix A number: 1 destroyed · 4 access · 5 drone ·
// 6 still-there · 7 overtopped · 9–13 damage questions.
const P = {
  destroyed: qid(1),
  access: qid(4),
  drone: qid(5),
  overtopped: qid(7),
  dmgRail: qid(9),
  dmgDeck: qid(10),
  dmgSuper: qid(11),
  dmgSub: qid(12),
  washout: qid(13),
};

export const BUILTIN_QUESTIONS: FormQuestion[] = [
  q(1, {
    sort_order: 1, type: 'yes_no', prompt: 'Was the bridge destroyed?',
    required: true, is_core: true, maps_to_system_field: 'destroyed',
  }),
  q(2, {
    parent_question_id: P.destroyed, trigger_answer: 'yes',
    sort_order: 2, type: 'photo', prompt: 'Bridge profile photo',
    required: true, is_core: true,
    config: { min_count: 1, photo_type: 'destroyed_profile' },
  }),
  q(3, {
    parent_question_id: P.destroyed, trigger_answer: 'yes',
    sort_order: 3, type: 'photo',
    prompt: 'Approach-location photo — stand where the approach was, looking across where the bridge was',
    required: true, is_core: true,
    config: { min_count: 1, photo_type: 'destroyed_approach' },
  }),
  q(4, {
    parent_question_id: P.destroyed, trigger_answer: 'no',
    sort_order: 4, type: 'yes_no', prompt: 'Were you able to access the bridge?',
    required: true, is_core: true, maps_to_system_field: 'access',
  }),
  q(5, {
    parent_question_id: P.access, trigger_answer: 'no',
    sort_order: 5, type: 'yes_no', prompt: 'Was drone reconnaissance used?',
    required: true, is_core: true, maps_to_system_field: 'drone_used',
  }),
  q(6, {
    parent_question_id: P.drone, trigger_answer: 'yes',
    sort_order: 6, type: 'yes_no',
    prompt: 'Is the bridge still there? (drone observation)',
    help_text: 'Choosing No suggests likely destroyed. Choosing Yes places the bridge on the ground follow-up list for inspectors on the ground.',
    required: true, is_core: true, maps_to_system_field: 'bridge_still_there',
  }),
  q(7, {
    parent_question_id: P.access, trigger_answer: 'yes',
    sort_order: 7, type: 'yes_no', prompt: 'Has the bridge overtopped?',
    required: true, is_core: true, maps_to_system_field: 'overtopped',
  }),
  q(8, {
    parent_question_id: P.overtopped, trigger_answer: 'yes',
    sort_order: 8, type: 'number', prompt: 'Maximum depth of overtopping (ft)',
    required: true, is_core: true,
    config: { min: 0, step: 0.1, unit: 'ft', allow_unknown: true },
    maps_to_system_field: 'overtop_depth_ft',
  }),
  q(9, {
    parent_question_id: P.access, trigger_answer: 'yes',
    sort_order: 9, type: 'yes_no', prompt: 'Damage to rail',
    required: false, is_core: true, maps_to_system_field: 'damage_rail',
  }),
  q(10, {
    parent_question_id: P.access, trigger_answer: 'yes',
    sort_order: 10, type: 'yes_no', prompt: 'Damage to deck',
    required: false, is_core: true, maps_to_system_field: 'damage_deck',
  }),
  q(11, {
    parent_question_id: P.access, trigger_answer: 'yes',
    sort_order: 11, type: 'yes_no', prompt: 'Damage to superstructure',
    required: false, is_core: true, maps_to_system_field: 'damage_super',
  }),
  q(12, {
    parent_question_id: P.access, trigger_answer: 'yes',
    sort_order: 12, type: 'yes_no', prompt: 'Damage to substructure',
    required: false, is_core: true, maps_to_system_field: 'damage_sub',
  }),
  q(13, {
    parent_question_id: P.access, trigger_answer: 'yes',
    sort_order: 13, type: 'yes_no', prompt: 'Approach washout behind abutments',
    required: false, is_core: true, maps_to_system_field: 'washout_abutment',
  }),
  q(14, {
    parent_question_id: P.access, trigger_answer: 'yes',
    sort_order: 14, type: 'photo', prompt: 'Upstation approach photo',
    required: false, config: { photo_type: 'upstation' },
  }),
  q(15, {
    parent_question_id: P.access, trigger_answer: 'yes',
    sort_order: 15, type: 'photo', prompt: 'Bridge profile photo',
    required: false, config: { photo_type: 'profile' },
  }),
  q(16, {
    parent_question_id: P.access, trigger_answer: 'yes',
    sort_order: 16, type: 'photo', prompt: 'Downstation approach photo',
    required: false, config: { photo_type: 'downstation' },
  }),
  q(17, {
    parent_question_id: P.dmgRail, trigger_answer: 'yes',
    sort_order: 17, type: 'photo', prompt: 'Rail damage',
    required: false, config: { photo_type: 'rail' },
  }),
  q(18, {
    parent_question_id: P.dmgDeck, trigger_answer: 'yes',
    sort_order: 18, type: 'photo', prompt: 'Deck damage',
    required: false, config: { photo_type: 'deck' },
  }),
  q(19, {
    parent_question_id: P.dmgSuper, trigger_answer: 'yes',
    sort_order: 19, type: 'photo', prompt: 'Superstructure damage',
    required: false, config: { photo_type: 'super' },
  }),
  q(20, {
    parent_question_id: P.dmgSub, trigger_answer: 'yes',
    sort_order: 20, type: 'photo', prompt: 'Substructure damage',
    required: false, config: { photo_type: 'sub' },
  }),
  q(21, {
    parent_question_id: P.washout, trigger_answer: 'yes',
    sort_order: 21, type: 'photo', prompt: 'Washout photo',
    required: false, config: { photo_type: 'washout' },
  }),
  q(22, {
    parent_question_id: P.access, trigger_answer: 'yes',
    sort_order: 22, type: 'photo', prompt: 'Condition photos',
    required: false, config: { photo_type: 'condition', allow_notes: true },
  }),
  q(23, {
    parent_question_id: P.access, trigger_answer: 'yes',
    sort_order: 23, type: 'single_choice', prompt: 'Can the bridge remain open?',
    required: true, is_core: true,
    options: [
      { value: 'yes', label: 'Yes' },
      { value: 'no', label: 'No' },
      { value: 'restricted_lanes', label: 'Restricted lane access' },
    ],
    maps_to_system_field: 'remain_open',
  }),
  q(24, {
    parent_question_id: P.access, trigger_answer: 'yes',
    sort_order: 24, type: 'text', prompt: 'Notes',
    required: false, is_core: true, maps_to_system_field: 'remain_open_notes',
  }),
  q(25, {
    parent_question_id: P.access, trigger_answer: 'yes',
    sort_order: 25, type: 'single_choice', prompt: 'Is it safe to carry load?',
    required: true, is_core: true,
    options: [
      { value: 'yes', label: 'Yes' },
      { value: 'no', label: 'No' },
      { value: 'reduced_load', label: 'Reduced load' },
    ],
    maps_to_system_field: 'safe_load',
  }),
  q(26, {
    parent_question_id: P.access, trigger_answer: 'yes',
    sort_order: 26, type: 'text', prompt: 'Notes',
    required: false, is_core: true, maps_to_system_field: 'safe_load_notes',
  }),
  q(27, {
    parent_question_id: P.access, trigger_answer: 'yes',
    sort_order: 27, type: 'single_choice', prompt: 'Debris at bridge',
    required: true, is_core: true,
    options: [
      { value: 'none', label: 'None' },
      { value: 'half_truck', label: '0.5 truckload' },
      { value: 'one_truck', label: '1 truckload' },
      { value: 'multiple', label: 'Multiple truckloads' },
      { value: 'six_plus', label: '6+ truckloads' },
    ],
    maps_to_system_field: 'debris_amount',
  }),
];
