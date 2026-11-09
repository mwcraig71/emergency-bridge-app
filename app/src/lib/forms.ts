// Per-state configurable questionnaires (migration 018) — data layer,
// validation, and the publish flow for the State ops Form Builder.
//
// LOCKED CORE (Michael's decision, 2026-11-09): the questions seeded from
// the system default template with is_core = true — every question mapped
// to a core emg_inspections column, plus the two photos that gate the
// destroyed outcome — can never be deleted, unmapped, re-triggered,
// retyped, or reworded by a state. States add their own questions around
// the core (roots, or nested follow-ups under any question), reorder
// their additions, and word them freely. Enforcement lives here, in the
// only save/publish path the builder uses:
//
//   * saveDraftQuestions() re-checks the edited question set against the
//     default template's core set and refuses to persist a set that
//     alters or drops a core question.
//   * publishDraft() runs the full validation (validateQuestions) and
//     refuses to publish while any error stands.
//   * A database backstop helps too: emg_form_questions has a partial
//     unique index allowing at most one question per mapped field per
//     template, and every allowlisted field is already claimed by a core
//     question — a state question can never claim a system field without
//     colliding with the index.
//
// Phase 1 scope: builder + preview only. The field app still renders the
// hard-coded TriageFlow; nothing here changes how inspections are taken
// or synced until Phase 2.
import { getSupabase, isSupabaseConfigured } from './supabase';
import type {
  FormQuestion,
  FormTemplate,
  QuestionOption,
  QuestionType,
} from '../types';

function sb() {
  const client = getSupabase();
  if (!client || !isSupabaseConfigured()) {
    throw new Error('Supabase is not configured in this build.');
  }
  return client;
}

// ---------------------------------------------------------------------------
// The maps_to_system_field allowlist (design Appendix C). Fixed in code;
// the builder never offers it for state-added questions — every field is
// already claimed by a locked core question from the default template.
// ---------------------------------------------------------------------------

export interface SystemFieldSpec {
  field: string;
  label: string;
  type: QuestionType;
  /** Legal option values for choice-typed fields. */
  values?: string[];
}

export const SYSTEM_FIELDS: SystemFieldSpec[] = [
  { field: 'destroyed', label: 'Destroyed?', type: 'yes_no' },
  { field: 'access', label: 'Able to access?', type: 'yes_no' },
  { field: 'drone_used', label: 'Drone used?', type: 'yes_no' },
  { field: 'bridge_still_there', label: 'Bridge still there?', type: 'yes_no' },
  { field: 'overtopped', label: 'Overtopped?', type: 'yes_no' },
  { field: 'overtop_depth_ft', label: 'Overtopping depth (ft)', type: 'number' },
  { field: 'damage_rail', label: 'Damage to rail', type: 'yes_no' },
  { field: 'damage_deck', label: 'Damage to deck', type: 'yes_no' },
  { field: 'damage_super', label: 'Damage to superstructure', type: 'yes_no' },
  { field: 'damage_sub', label: 'Damage to substructure', type: 'yes_no' },
  { field: 'washout_abutment', label: 'Approach washout', type: 'yes_no' },
  {
    field: 'remain_open',
    label: 'Can remain open?',
    type: 'single_choice',
    values: ['yes', 'no', 'restricted_lanes'],
  },
  { field: 'remain_open_notes', label: 'Remain-open notes', type: 'text' },
  {
    field: 'safe_load',
    label: 'Safe to carry load?',
    type: 'single_choice',
    values: ['yes', 'no', 'reduced_load'],
  },
  { field: 'safe_load_notes', label: 'Safe-load notes', type: 'text' },
  {
    field: 'debris_amount',
    label: 'Debris at bridge',
    type: 'single_choice',
    values: ['none', 'half_truck', 'one_truck', 'multiple', 'six_plus'],
  },
];

export const QUESTION_TYPE_LABELS: Record<QuestionType, string> = {
  yes_no: 'Yes / No',
  text: 'Text input',
  single_choice: 'Single choice',
  multi_choice: 'Multiple choice',
  number: 'Number',
  photo: 'Photo',
};

/** Types that can legally parent a nested follow-up (design §3). */
export function isTriggerCapable(type: QuestionType): boolean {
  return type === 'yes_no' || type === 'single_choice' || type === 'multi_choice';
}

/** The answer values that can reveal a child of this question. */
export function legalTriggerValues(q: FormQuestion): string[] {
  if (q.type === 'yes_no') return ['yes', 'no'];
  if (q.type === 'single_choice' || q.type === 'multi_choice') {
    return (q.options ?? []).map((o) => o.value);
  }
  return [];
}

/**
 * Stable identity for a core question across template clones (cloning
 * assigns fresh UUIDs, so core questions are matched by what they ARE,
 * not by id): mapped questions by their system field, the destroyed-gate
 * photos by their legacy photo_type. Returns null for state questions.
 */
export function coreKey(q: FormQuestion): string | null {
  if (q.maps_to_system_field) return `field:${q.maps_to_system_field}`;
  if (q.type === 'photo') {
    const pt = q.config?.photo_type;
    if (pt === 'destroyed_profile' || pt === 'destroyed_approach') {
      return `photo:${String(pt)}`;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

const TEMPLATE_COLS =
  'id,state_code,name,version,status,is_default,created_by,created_at,published_at,published_by';
const QUESTION_COLS =
  'id,template_id,parent_question_id,trigger_answer,sort_order,type,prompt,help_text,required,is_core,options,config,maps_to_system_field,created_at';

export async function loadDefaultTemplate(): Promise<{
  template: FormTemplate;
  questions: FormQuestion[];
} | null> {
  const client = sb();
  const { data, error } = await client
    .from('emg_form_templates')
    .select(TEMPLATE_COLS)
    .eq('is_default', true)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const template = data as unknown as FormTemplate;
  return { template, questions: await loadQuestions(template.id) };
}

/** All templates belonging to one state, newest version first. */
export async function loadStateTemplates(
  stateCode: string,
): Promise<FormTemplate[]> {
  const client = sb();
  const { data, error } = await client
    .from('emg_form_templates')
    .select(TEMPLATE_COLS)
    .eq('state_code', stateCode)
    .order('version', { ascending: false });
  if (error) throw error;
  return (data as unknown as FormTemplate[]) ?? [];
}

export async function loadQuestions(
  templateId: string,
): Promise<FormQuestion[]> {
  const client = sb();
  const { data, error } = await client
    .from('emg_form_questions')
    .select(QUESTION_COLS)
    .eq('template_id', templateId)
    .order('sort_order', { ascending: true });
  if (error) throw error;
  return (data as unknown as FormQuestion[]) ?? [];
}

// ---------------------------------------------------------------------------
// Cloning (start-from-default, draft-after-publish)
// ---------------------------------------------------------------------------

function newId(): string {
  return crypto.randomUUID();
}

/** Build insert rows cloning `source` questions into a new template,
 *  with fresh ids and remapped parents. Core flags carry over. */
function cloneRows(
  source: FormQuestion[],
  targetTemplateId: string,
): Record<string, unknown>[] {
  const idMap = new Map<string, string>();
  for (const q of source) idMap.set(q.id, newId());
  return source.map((q) => ({
    id: idMap.get(q.id),
    template_id: targetTemplateId,
    parent_question_id: q.parent_question_id
      ? (idMap.get(q.parent_question_id) ?? null)
      : null,
    trigger_answer: q.trigger_answer,
    sort_order: q.sort_order,
    type: q.type,
    prompt: q.prompt,
    help_text: q.help_text,
    required: q.required,
    is_core: q.is_core,
    options: q.options,
    config: q.config,
    maps_to_system_field: q.maps_to_system_field,
  }));
}

async function insertTemplate(
  stateCode: string,
  name: string,
  version: number,
  actorEmail: string | null,
): Promise<FormTemplate> {
  const client = sb();
  const { data, error } = await client
    .from('emg_form_templates')
    .insert({
      state_code: stateCode,
      name,
      version,
      status: 'draft',
      is_default: false,
      created_by: actorEmail,
    })
    .select(TEMPLATE_COLS)
    .single();
  if (error) throw error;
  return data as unknown as FormTemplate;
}

async function cloneIntoDraft(
  stateCode: string,
  source: { template: FormTemplate; questions: FormQuestion[] },
  version: number,
  actorEmail: string | null,
): Promise<FormTemplate> {
  const client = sb();
  const draft = await insertTemplate(
    stateCode,
    source.template.name,
    version,
    actorEmail,
  );
  const rows = cloneRows(source.questions, draft.id);
  if (rows.length > 0) {
    const { error } = await client.from('emg_form_questions').insert(rows);
    if (error) throw error;
  }
  return draft;
}

/**
 * Create the state's first draft by cloning the system default template.
 * Version = one past the highest version the state already has (so a
 * state that archived v1 and starts over gets v2, never a collision).
 * Throws if a draft already exists.
 */
export async function startDraftFromDefault(
  stateCode: string,
  actorEmail: string | null,
): Promise<FormTemplate> {
  const existing = await loadStateTemplates(stateCode);
  if (existing.some((t) => t.status === 'draft')) {
    throw new Error('A draft already exists for this state.');
  }
  const def = await loadDefaultTemplate();
  if (!def) throw new Error('The system default template is missing.');
  const nextVersion = existing.reduce((m, t) => Math.max(m, t.version), 0) + 1;
  return cloneIntoDraft(stateCode, def, nextVersion, actorEmail);
}

/** Create a new draft by cloning the state's published template. */
export async function startDraftFromPublished(
  stateCode: string,
  actorEmail: string | null,
): Promise<FormTemplate> {
  const existing = await loadStateTemplates(stateCode);
  if (existing.some((t) => t.status === 'draft')) {
    throw new Error('A draft already exists for this state.');
  }
  const published = existing.find((t) => t.status === 'published');
  if (!published) {
    throw new Error('No published template to copy — start from the default.');
  }
  const questions = await loadQuestions(published.id);
  const nextVersion = existing.reduce((m, t) => Math.max(m, t.version), 0) + 1;
  return cloneIntoDraft(
    stateCode,
    { template: published, questions },
    nextVersion,
    actorEmail,
  );
}

// ---------------------------------------------------------------------------
// Locked-core check + validation
// ---------------------------------------------------------------------------

export interface ValidationResult {
  errors: string[];
  warnings: string[];
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/** Map of coreKey -> question for the questions that carry a core key. */
function keyedCoreSet(questions: FormQuestion[]): Map<string, FormQuestion> {
  const map = new Map<string, FormQuestion>();
  for (const q of questions) {
    const k = coreKey(q);
    if (k) map.set(k, q);
  }
  return map;
}

/**
 * Locked-core integrity: every core question from the default template
 * must be present in `questions` with its locked fields untouched (type,
 * prompt, help text, required flag, options, config, parent core key,
 * trigger, mapping). Returns a list of violations (empty = intact).
 * Parent linkage is compared by core key, so it survives cloning.
 */
export function coreViolations(
  questions: FormQuestion[],
  defaultQuestions: FormQuestion[],
): string[] {
  const out: string[] = [];
  const mine = keyedCoreSet(questions);
  const byId = new Map(questions.map((q) => [q.id, q]));
  const refById = new Map(defaultQuestions.map((q) => [q.id, q]));

  for (const ref of defaultQuestions) {
    if (!ref.is_core) continue;
    const key = coreKey(ref);
    if (!key) continue;
    const label = ref.maps_to_system_field ?? ref.prompt;
    const got = mine.get(key);
    if (!got) {
      out.push(`Core question missing: "${ref.prompt}" (${label}).`);
      continue;
    }
    if (!got.is_core) {
      out.push(`Core question "${ref.prompt}" lost its core lock.`);
    }
    if (got.type !== ref.type) {
      out.push(`Core question "${ref.prompt}" changed type.`);
    }
    if (got.prompt !== ref.prompt) {
      out.push(`Core question wording changed: "${ref.prompt}".`);
    }
    if ((got.help_text ?? '') !== (ref.help_text ?? '')) {
      out.push(`Core question "${ref.prompt}" changed its help text.`);
    }
    if (got.required !== ref.required) {
      out.push(`Core question "${ref.prompt}" changed its required flag.`);
    }
    if (!sameJson(got.options, ref.options)) {
      out.push(`Core question "${ref.prompt}" changed its answer choices.`);
    }
    if (!sameJson(got.config, ref.config)) {
      out.push(`Core question "${ref.prompt}" changed its settings.`);
    }
    if (got.trigger_answer !== ref.trigger_answer) {
      out.push(`Core question "${ref.prompt}" changed its trigger.`);
    }
    // Parent: both roots, or parents carrying the same core key.
    const refParent = ref.parent_question_id
      ? refById.get(ref.parent_question_id)
      : null;
    const gotParent = got.parent_question_id
      ? byId.get(got.parent_question_id)
      : null;
    const refParentKey = refParent ? coreKey(refParent) : null;
    const gotParentKey = gotParent ? coreKey(gotParent) : null;
    if (refParentKey !== gotParentKey) {
      out.push(`Core question "${ref.prompt}" was moved to a different parent.`);
    }
  }

  // No forged core questions, and no state question may claim a field.
  for (const q of questions) {
    if (q.is_core && !coreKey(q)) {
      out.push(`Question "${q.prompt}" is marked core but is not a core question.`);
    }
    if (!q.is_core && q.maps_to_system_field) {
      out.push(
        `Question "${q.prompt}" claims system field ${q.maps_to_system_field} — only core questions map to system fields.`,
      );
    }
  }
  return out;
}

/**
 * Full publish/save validation (design §5): locked-core integrity plus
 * authoring sanity — orphaned triggers, empty/duplicate choice options,
 * duplicate field claims, parents that cannot trigger, cycles.
 */
export function validateQuestions(
  questions: FormQuestion[],
  defaultQuestions: FormQuestion[],
): ValidationResult {
  const errors: string[] = [...coreViolations(questions, defaultQuestions)];
  const warnings: string[] = [];
  const byId = new Map(questions.map((q) => [q.id, q]));

  // Duplicate mapped-field claims.
  const claimed = new Map<string, FormQuestion>();
  for (const q of questions) {
    if (!q.maps_to_system_field) continue;
    const prev = claimed.get(q.maps_to_system_field);
    if (prev) {
      errors.push(
        `System field ${q.maps_to_system_field} is claimed by both "${prev.prompt}" and "${q.prompt}".`,
      );
    } else {
      claimed.set(q.maps_to_system_field, q);
    }
  }
  // Every allowlisted field claimed exactly once (by its core question).
  for (const spec of SYSTEM_FIELDS) {
    if (!claimed.has(spec.field)) {
      errors.push(`No question maps to system field ${spec.field} (${spec.label}).`);
    }
  }

  const depthOf = (q: FormQuestion, seen: Set<string>): number => {
    if (!q.parent_question_id || seen.has(q.id)) return 0;
    const parent = byId.get(q.parent_question_id);
    if (!parent) return 0;
    seen.add(q.id);
    return 1 + depthOf(parent, seen);
  };

  for (const q of questions) {
    const name = q.prompt.trim() || '(untitled question)';
    if (!q.prompt.trim()) {
      errors.push('A question has an empty prompt.');
    }
    if (q.type === 'single_choice' || q.type === 'multi_choice') {
      const opts = q.options ?? [];
      if (opts.length === 0) {
        errors.push(`Choice question "${name}" has no answer options.`);
      }
      const values = new Set<string>();
      for (const o of opts) {
        if (!o.value.trim()) errors.push(`Question "${name}" has an option with an empty value.`);
        if (values.has(o.value)) {
          errors.push(`Question "${name}" has duplicate option value "${o.value}".`);
        }
        values.add(o.value);
      }
    }
    if (q.parent_question_id) {
      const parent = byId.get(q.parent_question_id);
      if (!parent) {
        errors.push(`Question "${name}" points at a parent that is not in this template.`);
      } else {
        if (!isTriggerCapable(parent.type)) {
          errors.push(
            `Question "${name}" is nested under "${parent.prompt}", which cannot reveal follow-ups (only Yes/No and choice questions can).`,
          );
        } else if (!q.trigger_answer) {
          errors.push(`Question "${name}" has a parent but no trigger answer.`);
        } else if (!legalTriggerValues(parent).includes(q.trigger_answer)) {
          errors.push(
            `Question "${name}" triggers on "${q.trigger_answer}", which is no longer an answer to "${parent.prompt}".`,
          );
        }
      }
    } else if (q.trigger_answer) {
      errors.push(`Root question "${name}" carries a trigger answer but has no parent.`);
    }
    const depth = depthOf(q, new Set());
    if (depth > 3) {
      warnings.push(
        `Question "${name}" is nested ${depth} levels deep — deep branches are hard to complete in the field.`,
      );
    }
  }
  return { errors, warnings };
}

// ---------------------------------------------------------------------------
// Saving a draft (the one write path — locked core enforced)
// ---------------------------------------------------------------------------

/**
 * Replace a draft template's questions with the edited set. Refuses to
 * persist when the set alters or drops a core question, when the target
 * is not a draft, or when basic authoring errors stand. New/kept
 * questions carry client-side UUIDs, so parents remap in a single pass.
 */
export async function saveDraftQuestions(
  template: FormTemplate,
  questions: FormQuestion[],
  defaultQuestions: FormQuestion[],
): Promise<void> {
  if (template.status !== 'draft') {
    throw new Error('Only a draft template can be edited.');
  }
  const { errors } = validateQuestions(questions, defaultQuestions);
  if (errors.length > 0) {
    throw new Error(`Cannot save — ${errors[0]}`);
  }
  const client = sb();
  const { error: delError } = await client
    .from('emg_form_questions')
    .delete()
    .eq('template_id', template.id);
  if (delError) throw delError;
  if (questions.length > 0) {
    const rows = questions.map((q) => ({
      id: q.id,
      template_id: template.id,
      parent_question_id: q.parent_question_id,
      trigger_answer: q.trigger_answer,
      sort_order: q.sort_order,
      type: q.type,
      prompt: q.prompt,
      help_text: q.help_text,
      required: q.required,
      is_core: q.is_core,
      options: q.options,
      config: q.config,
      maps_to_system_field: q.maps_to_system_field,
    }));
    const { error } = await client.from('emg_form_questions').insert(rows);
    if (error) throw error;
  }
}

// ---------------------------------------------------------------------------
// Publishing (design §4.1 + §8.4)
// ---------------------------------------------------------------------------

/**
 * Inspections filed under the given template in the last 24 h (design
 * §8.4's soft-notice input). In Phase 1 every inspection still has a NULL
 * form_template_id, so this is 0 until Phase 2 ships.
 */
export async function countRecentInspections(
  templateId: string,
): Promise<number> {
  const client = sb();
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const { count, error } = await client
    .from('emg_inspections')
    .select('id', { count: 'exact', head: true })
    .eq('form_template_id', templateId)
    .gte('inspection_datetime', since);
  if (error) throw error;
  return count ?? 0;
}

/**
 * Publish the state's draft: previous published version is archived, the
 * draft becomes published (frozen), and a fresh draft is cloned from it
 * for the next round of edits. Validation errors block the publish.
 */
export async function publishDraft(
  stateCode: string,
  actorEmail: string | null,
): Promise<{ published: FormTemplate; newDraft: FormTemplate }> {
  const client = sb();
  const templates = await loadStateTemplates(stateCode);
  const draft = templates.find((t) => t.status === 'draft');
  if (!draft) throw new Error('There is no draft to publish.');
  const published = templates.find((t) => t.status === 'published');

  const draftQuestions = await loadQuestions(draft.id);
  const def = await loadDefaultTemplate();
  if (!def) throw new Error('The system default template is missing.');
  const { errors } = validateQuestions(draftQuestions, def.questions);
  if (errors.length > 0) {
    throw new Error(`Cannot publish — ${errors[0]}`);
  }

  if (published) {
    const { error } = await client
      .from('emg_form_templates')
      .update({ status: 'archived' })
      .eq('id', published.id);
    if (error) throw error;
  }
  const { data, error } = await client
    .from('emg_form_templates')
    .update({
      status: 'published',
      published_at: new Date().toISOString(),
      published_by: actorEmail,
    })
    .eq('id', draft.id)
    .select(TEMPLATE_COLS)
    .single();
  if (error) throw error;
  const publishedNow = data as unknown as FormTemplate;

  const newDraft = await cloneIntoDraft(
    stateCode,
    { template: publishedNow, questions: draftQuestions },
    draft.version + 1,
    actorEmail,
  );
  return { published: publishedNow, newDraft };
}

// ---------------------------------------------------------------------------
// Tree helpers + publish diff (shared by the builder UI)
// ---------------------------------------------------------------------------

export interface QuestionNode {
  question: FormQuestion;
  children: QuestionNode[];
}

/** Build the question tree, siblings ordered by sort_order. */
export function buildTree(questions: FormQuestion[]): QuestionNode[] {
  const byParent = new Map<string | null, FormQuestion[]>();
  for (const q of questions) {
    const key = q.parent_question_id;
    const list = byParent.get(key) ?? [];
    list.push(q);
    byParent.set(key, list);
  }
  const make = (parentId: string | null): QuestionNode[] =>
    (byParent.get(parentId) ?? [])
      .slice()
      .sort((a, b) => a.sort_order - b.sort_order)
      .map((q) => ({ question: q, children: make(q.id) }));
  return make(null);
}

/** All descendants of a question (for delete confirmations). */
export function descendantsOf(
  questions: FormQuestion[],
  id: string,
): FormQuestion[] {
  const out: FormQuestion[] = [];
  const walk = (parentId: string) => {
    for (const q of questions) {
      if (q.parent_question_id === parentId) {
        out.push(q);
        walk(q.id);
      }
    }
  };
  walk(id);
  return out;
}

/**
 * Reassign sort_order across the whole template by tree traversal order
 * (roots in order, each followed by its subtree) — the seed's global
 * numbering scheme. Call after any reorder/insert/delete in the editor.
 */
export function renumber(questions: FormQuestion[]): FormQuestion[] {
  const order = new Map<string, number>();
  let n = 0;
  const walk = (nodes: QuestionNode[]) => {
    for (const node of nodes) {
      n += 1;
      order.set(node.question.id, n);
      walk(node.children);
    }
  };
  walk(buildTree(questions));
  return questions.map((q) => ({ ...q, sort_order: order.get(q.id) ?? q.sort_order }));
}

export interface TemplateDiff {
  added: string[];
  removed: string[];
  moved: number;
}

/**
 * Plain-language diff between the currently published questions and a
 * draft, for the publish confirmation: core questions match by core key,
 * state questions by prompt text.
 */
export function diffSummary(
  oldQuestions: FormQuestion[],
  newQuestions: FormQuestion[],
): TemplateDiff {
  const keyOf = (q: FormQuestion) => coreKey(q) ?? `prompt:${q.prompt.trim()}`;
  const oldMap = new Map(oldQuestions.map((q) => [keyOf(q), q]));
  const newMap = new Map(newQuestions.map((q) => [keyOf(q), q]));
  const added: string[] = [];
  const removed: string[] = [];
  let moved = 0;
  for (const [k, q] of newMap) {
    const old = oldMap.get(k);
    if (!old) added.push(q.prompt);
    else if (old.sort_order !== q.sort_order) moved += 1;
  }
  for (const [k, q] of oldMap) {
    if (!newMap.has(k)) removed.push(q.prompt);
  }
  return { added, removed, moved };
}

export type { QuestionOption };
