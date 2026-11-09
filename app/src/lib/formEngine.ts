// Form engine — the pure logic of the questionnaire field renderer
// (design §6.2/§6.3): question-tree visibility, generated completion
// validation, write-through from answers to the core emg_inspections
// columns, and the outcome engine that derives triage_list.
//
// Deliberately dependency-free (type-only imports) so it can be unit
// verified outside the app bundle — see scripts/verify-form-engine.mjs,
// which walks the default template through every Appendix A branch and
// compares outcomes + core columns against the legacy TriageFlow.
import type {
  FormAnswerDraft,
  FormAnswerValue,
  FormQuestion,
  InspectionDraft,
  PhotoRef,
  TriageList,
  YesNo,
} from '../types';

// ---------------------------------------------------------------------------
// Answers: lookup + trigger matching
// ---------------------------------------------------------------------------

export function answerOf(
  answers: FormAnswerDraft[] | undefined,
  questionId: string,
): FormAnswerDraft | undefined {
  return (answers ?? []).find((a) => a.question_id === questionId);
}

/** The scalar/array value used for trigger matching (design §3):
 *  yes_no / single_choice → the value; multi_choice → contains. */
export function triggerMatches(
  answer: FormAnswerValue | undefined,
  trigger: string,
): boolean {
  if (!answer || !('value' in answer)) return false;
  const v = answer.value;
  if (Array.isArray(v)) return v.includes(trigger);
  return v === trigger;
}

// ---------------------------------------------------------------------------
// Visibility: a question renders when its whole parent chain is visible
// and each trigger matches the parent's current answer (design §6.2).
// Returned in render order (tree order, siblings by sort_order).
// ---------------------------------------------------------------------------

export function visibleQuestions(
  questions: FormQuestion[],
  answers: FormAnswerDraft[] | undefined,
): FormQuestion[] {
  const byParent = new Map<string | null, FormQuestion[]>();
  for (const q of questions) {
    const list = byParent.get(q.parent_question_id) ?? [];
    list.push(q);
    byParent.set(q.parent_question_id, list);
  }
  for (const list of byParent.values()) {
    list.sort((a, b) => a.sort_order - b.sort_order);
  }
  const out: FormQuestion[] = [];
  // Roots always render; a child renders only under a visible parent
  // whose answer matches the child's trigger.
  const walkSubtree = (q: FormQuestion) => {
    out.push(q);
    const mine = answerOf(answers, q.id);
    for (const child of byParent.get(q.id) ?? []) {
      if (
        child.trigger_answer &&
        triggerMatches(mine?.answer, child.trigger_answer)
      ) {
        walkSubtree(child);
      }
    }
  };
  for (const root of byParent.get(null) ?? []) walkSubtree(root);
  return out;
}

// ---------------------------------------------------------------------------
// Photo linkage: a photo question's photos are the draft photos whose
// photo_type is the question's legacy slot type (config.photo_type, the
// default template) or 'form:<question_id>' (state-added questions).
// ---------------------------------------------------------------------------

export function photoTypeFor(q: FormQuestion): string {
  const pt = q.config?.photo_type;
  return typeof pt === 'string' && pt ? pt : `form:${q.id}`;
}

export function photosForQuestion(
  q: FormQuestion,
  photos: PhotoRef[] | undefined,
): PhotoRef[] {
  const t = photoTypeFor(q);
  return (photos ?? []).filter((p) => p.photo_type === t);
}

// ---------------------------------------------------------------------------
// Answered-ness + generated completion validation (design §6.2)
// ---------------------------------------------------------------------------

export function isAnswered(
  q: FormQuestion,
  answer: FormAnswerValue | undefined,
  photos: PhotoRef[] | undefined,
): boolean {
  switch (q.type) {
    case 'photo': {
      const min =
        typeof q.config?.min_count === 'number'
          ? (q.config.min_count as number)
          : q.required
            ? 1
            : 0;
      return photosForQuestion(q, photos).length >= Math.max(min, q.required ? 1 : 0);
    }
    case 'number': {
      if (!answer || !('value' in answer)) return false;
      if ('unknown' in answer && answer.unknown === true) {
        return q.config?.allow_unknown === true;
      }
      const v = answer.value;
      if (typeof v !== 'number' || !Number.isFinite(v)) return false;
      const min = typeof q.config?.min === 'number' ? (q.config.min as number) : null;
      return min === null || v >= min;
    }
    case 'text': {
      if (!answer || !('value' in answer)) return false;
      return typeof answer.value === 'string' && answer.value.trim().length > 0;
    }
    case 'multi_choice': {
      if (!answer || !('value' in answer)) return false;
      return Array.isArray(answer.value) && answer.value.length > 0;
    }
    default: {
      // yes_no, single_choice
      if (!answer || !('value' in answer)) return false;
      return typeof answer.value === 'string' && answer.value.length > 0;
    }
  }
}

/** Visible required questions that are not yet answered — the generated
 *  replacement for TriageFlow finish()'s hand-written checks. */
export function missingRequired(
  questions: FormQuestion[],
  answers: FormAnswerDraft[] | undefined,
  photos: PhotoRef[] | undefined,
): FormQuestion[] {
  return visibleQuestions(questions, answers).filter(
    (q) => q.required && !isAnswered(q, answerOf(answers, q.id)?.answer, photos),
  );
}

export function formProgress(
  questions: FormQuestion[],
  answers: FormAnswerDraft[] | undefined,
  photos: PhotoRef[] | undefined,
): { answered: number; total: number } {
  const req = visibleQuestions(questions, answers).filter((q) => q.required);
  return {
    answered: req.filter((q) =>
      isAnswered(q, answerOf(answers, q.id)?.answer, photos),
    ).length,
    total: req.length,
  };
}

// ---------------------------------------------------------------------------
// Snapshots + answer construction
// ---------------------------------------------------------------------------

export function makeAnswer(
  q: FormQuestion,
  answer: FormAnswerValue,
): FormAnswerDraft {
  return {
    question_id: q.id,
    prompt_snapshot: q.prompt,
    type_snapshot: q.type,
    sort_snapshot: q.sort_order,
    answer,
  };
}

/** Replace (or append) the answer for a question, stamping snapshots. */
export function withAnswer(
  answers: FormAnswerDraft[] | undefined,
  q: FormQuestion,
  answer: FormAnswerValue,
): FormAnswerDraft[] {
  const next = (answers ?? []).filter((a) => a.question_id !== q.id);
  next.push(makeAnswer(q, answer));
  return next;
}

/** Refresh every photo question's answer from the draft's photo list:
 *  { photo_ids: [...] } for questions with at least one photo; questions
 *  left with zero photos have their answer removed. */
export function syncPhotoAnswers(
  answers: FormAnswerDraft[] | undefined,
  questions: FormQuestion[],
  photos: PhotoRef[] | undefined,
): FormAnswerDraft[] {
  let next = [...(answers ?? [])];
  for (const q of questions) {
    if (q.type !== 'photo') continue;
    const ids = photosForQuestion(q, photos).map((p) => p.id);
    next = next.filter((a) => a.question_id !== q.id);
    if (ids.length > 0) next.push(makeAnswer(q, { photo_ids: ids }));
  }
  return next;
}

// ---------------------------------------------------------------------------
// Write-through (design §6.2): a mapped answer also sets the draft's
// core emg_inspections field, exactly as the legacy form did, so the
// dashboards' contract never changes. Unmapped questions touch nothing.
// ---------------------------------------------------------------------------

const YES_NO_FIELDS = new Set([
  'destroyed',
  'access',
  'drone_used',
  'bridge_still_there',
  'overtopped',
  'damage_rail',
  'damage_deck',
  'damage_super',
  'damage_sub',
  'washout_abutment',
]);

export function applyWriteThrough(
  draft: InspectionDraft,
  q: FormQuestion,
  answer: FormAnswerValue,
): InspectionDraft {
  const field = q.maps_to_system_field;
  if (!field) return draft;
  const next: InspectionDraft = { ...draft };
  const rec = next as unknown as Record<string, unknown>;
  if (YES_NO_FIELDS.has(field)) {
    if ('value' in answer && (answer.value === 'yes' || answer.value === 'no')) {
      rec[field] = answer.value as YesNo;
    }
    return next;
  }
  switch (field) {
    case 'overtop_depth_ft': {
      if ('unknown' in answer && answer.unknown === true) {
        next.overtop_depth_ft = null;
        next.overtop_depth_unknown = true;
      } else if ('value' in answer && typeof answer.value === 'number') {
        next.overtop_depth_ft = answer.value;
        next.overtop_depth_unknown = false;
      } else if ('value' in answer && answer.value === null) {
        next.overtop_depth_ft = null;
        next.overtop_depth_unknown = false;
      }
      return next;
    }
    case 'remain_open':
    case 'safe_load':
    case 'debris_amount': {
      if ('value' in answer && typeof answer.value === 'string') {
        rec[field] = answer.value;
      }
      return next;
    }
    case 'remain_open_notes':
    case 'safe_load_notes': {
      if ('value' in answer) {
        rec[field] = typeof answer.value === 'string' ? answer.value : '';
      }
      return next;
    }
    default:
      return draft;
  }
}

/** Legacy parity cleanup (TriageFlow cleared the depth whenever
 *  overtopped flipped to No): an inspection that did not overtop carries
 *  no depth and no unknown flag. */
export function normalizeCore(draft: InspectionDraft): InspectionDraft {
  if (draft.overtopped === 'no') {
    return { ...draft, overtop_depth_ft: null, overtop_depth_unknown: false };
  }
  return draft;
}

// ---------------------------------------------------------------------------
// Outcome engine (design §6.3): derive triage_list from the mapped
// answers at finish. Reproduces the legacy button-driven outcomes
// exactly; a template missing a mapped triage question simply cannot
// fire the rules that mention it and falls through to 'complete'.
// ---------------------------------------------------------------------------

export function deriveOutcome(core: {
  destroyed: YesNo | null;
  access: YesNo | null;
  drone_used: YesNo | null;
  bridge_still_there: YesNo | null;
}): Exclude<TriageList, 'in_progress'> {
  if (core.destroyed === 'yes') return 'destroyed';
  if (core.access === 'no' && core.drone_used === 'yes') {
    if (core.bridge_still_there === 'no') return 'likely_destroyed';
    if (core.bridge_still_there === 'yes') return 'ground_followup';
  }
  if (core.access === 'no') return 'revisit';
  return 'complete';
}

// ---------------------------------------------------------------------------
// Seeding answers from core fields — used when resuming a draft that
// predates Phase 2 (answers were captured as core columns by the legacy
// flow). Fresh drafts start with NO seeded answers: in particular the
// damage questions must not inherit the DB-default 'no' pre-fill
// (design §8 risk 2; Appendix A note 1).
// ---------------------------------------------------------------------------

export function seedAnswersFromCore(
  draft: InspectionDraft,
  questions: FormQuestion[],
): FormAnswerDraft[] {
  const out: FormAnswerDraft[] = [];
  const core = draft as unknown as Record<string, unknown>;
  for (const q of questions) {
    if (q.type === 'photo') continue; // handled by syncPhotoAnswers
    const field = q.maps_to_system_field;
    if (!field) continue;
    const v = core[field];
    if (YES_NO_FIELDS.has(field)) {
      if (v === 'yes' || v === 'no') out.push(makeAnswer(q, { value: v }));
    } else if (field === 'overtop_depth_ft') {
      if (draft.overtop_depth_unknown === true) {
        out.push(makeAnswer(q, { value: null, unknown: true }));
      } else if (typeof v === 'number' && Number.isFinite(v)) {
        out.push(makeAnswer(q, { value: v }));
      }
    } else if (
      field === 'remain_open' ||
      field === 'safe_load' ||
      field === 'debris_amount'
    ) {
      if (typeof v === 'string' && v) out.push(makeAnswer(q, { value: v }));
    } else if (field === 'remain_open_notes' || field === 'safe_load_notes') {
      if (typeof v === 'string' && v) out.push(makeAnswer(q, { value: v }));
    }
  }
  return syncPhotoAnswers(out, questions, draft.photos);
}
