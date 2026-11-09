// State ops Form Builder (migration 018, Phase 1) — per-state
// configurable inspection questionnaires with a LOCKED CORE.
//
// A state starts from the published system default template (or from its
// own published version), then customizes a draft: core questions
// (is_core — the system-mapped set that drives the dashboards, plus the
// destroyed-gate photos) are locked: they cannot be deleted, unmapped,
// re-triggered, retyped, or reworded, and the save/publish path in
// lib/forms.ts re-verifies that on every write. State questions can be
// added anywhere (including nested follow-ups under core questions),
// reordered among their siblings, and worded freely.
//
// Publishing freezes a version (draft → published, previous published →
// archived) and clones a fresh draft for the next round. Field devices
// pick a published version up at sync — Phase 2; in Phase 1 inspectors
// see no change.
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import FormPreview from './FormPreview';
import {
  buildTree,
  countRecentInspections,
  descendantsOf,
  diffSummary,
  isTriggerCapable,
  legalTriggerValues,
  loadDefaultTemplate,
  loadQuestions,
  loadStateTemplates,
  publishDraft,
  renumber,
  saveDraftQuestions,
  startDraftFromDefault,
  startDraftFromPublished,
  validateQuestions,
  QUESTION_TYPE_LABELS,
  type QuestionNode,
  type TemplateDiff,
  type ValidationResult,
} from '../lib/forms';
import { getAdminProfile } from '../lib/auth';
import type {
  EmgState,
  FormQuestion,
  FormTemplate,
  QuestionOption,
  QuestionType,
} from '../types';

interface FormBuilderProps {
  states: EmgState[];
  /** State scope from StateDashboard (null = super admin, all states —
   *  the builder then carries its own state picker). */
  stateCode: string | null;
}

const TYPE_OPTIONS: QuestionType[] = [
  'yes_no',
  'text',
  'number',
  'single_choice',
  'multi_choice',
  'photo',
];

export default function FormBuilder({ states, stateCode }: FormBuilderProps) {
  const actorEmail = getAdminProfile()?.email ?? null;
  const [selectedState, setSelectedState] = useState<string>(
    stateCode ?? states[0]?.code ?? '',
  );
  useEffect(() => {
    if (stateCode) setSelectedState(stateCode);
    else if (!selectedState && states[0]) setSelectedState(states[0].code);
  }, [stateCode, states, selectedState]);

  const [templates, setTemplates] = useState<FormTemplate[]>([]);
  const [defaultQuestions, setDefaultQuestions] = useState<FormQuestion[]>([]);
  const [questions, setQuestions] = useState<FormQuestion[]>([]);
  const [savedSnapshot, setSavedSnapshot] = useState<string>('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [mode, setMode] = useState<'edit' | 'preview' | 'history'>('edit');
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Publish confirmation state.
  const [publishOpen, setPublishOpen] = useState(false);
  const [publishValidation, setPublishValidation] =
    useState<ValidationResult | null>(null);
  const [publishDiff, setPublishDiff] = useState<TemplateDiff | null>(null);
  const [recentCount, setRecentCount] = useState(0);

  // History read-only view.
  const [viewing, setViewing] = useState<FormTemplate | null>(null);
  const [viewQuestions, setViewQuestions] = useState<FormQuestion[]>([]);

  const draft = templates.find((t) => t.status === 'draft') ?? null;
  const published = templates.find((t) => t.status === 'published') ?? null;
  const dirty = JSON.stringify(questions) !== savedSnapshot;

  const stateName =
    states.find((s) => s.code === selectedState)?.name ?? selectedState;

  const reload = useCallback(async () => {
    if (!selectedState) return;
    setLoading(true);
    setError(null);
    try {
      const [list, def] = await Promise.all([
        loadStateTemplates(selectedState),
        loadDefaultTemplate(),
      ]);
      setTemplates(list);
      setDefaultQuestions(def?.questions ?? []);
      const d = list.find((t) => t.status === 'draft');
      if (d) {
        const qs = await loadQuestions(d.id);
        setQuestions(qs);
        setSavedSnapshot(JSON.stringify(qs));
      } else {
        setQuestions([]);
        setSavedSnapshot('');
      }
      setSelectedId(null);
      setPublishOpen(false);
      setViewing(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [selectedState]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const liveValidation = useMemo(
    () =>
      draft
        ? validateQuestions(questions, defaultQuestions)
        : { errors: [], warnings: [] },
    [draft, questions, defaultQuestions],
  );

  // ---------------------------------------------------------- mutations

  const patchQuestion = (id: string, patch: Partial<FormQuestion>) => {
    setQuestions((prev) =>
      prev.map((q) => (q.id === id ? { ...q, ...patch } : q)),
    );
  };

  const addQuestion = (parentId: string | null) => {
    if (!draft) return;
    const parent = parentId
      ? (questions.find((q) => q.id === parentId) ?? null)
      : null;
    const q: FormQuestion = {
      id: crypto.randomUUID(),
      template_id: draft.id,
      parent_question_id: parentId,
      trigger_answer: parent ? (legalTriggerValues(parent)[0] ?? 'yes') : null,
      sort_order: 9999,
      type: 'yes_no',
      prompt: '',
      help_text: null,
      required: false,
      is_core: false,
      options: null,
      config: null,
      maps_to_system_field: null,
      created_at: new Date().toISOString(),
    };
    setQuestions((prev) => renumber([...prev, q]));
    setSelectedId(q.id);
    setMode('edit');
  };

  const deleteQuestion = (q: FormQuestion) => {
    if (q.is_core) return;
    const kids = descendantsOf(questions, q.id);
    const msg =
      kids.length > 0
        ? `Delete "${q.prompt || 'this question'}" and its ${kids.length} follow-up question(s)? This applies when you save the draft.`
        : `Delete "${q.prompt || 'this question'}"? This applies when you save the draft.`;
    if (!window.confirm(msg)) return;
    const drop = new Set([q.id, ...kids.map((k) => k.id)]);
    setQuestions((prev) => renumber(prev.filter((x) => !drop.has(x.id))));
    setSelectedId(null);
  };

  const moveQuestion = (q: FormQuestion, dir: -1 | 1) => {
    const siblings = questions
      .filter((x) => x.parent_question_id === q.parent_question_id)
      .sort((a, b) => a.sort_order - b.sort_order);
    const idx = siblings.findIndex((x) => x.id === q.id);
    const swap = siblings[idx + dir];
    if (!swap) return;
    const order = new Map(siblings.map((s) => [s.id, s.sort_order]));
    order.set(q.id, swap.sort_order);
    order.set(swap.id, q.sort_order);
    setQuestions((prev) =>
      renumber(
        prev.map((x) =>
          order.has(x.id) ? { ...x, sort_order: order.get(x.id)! } : x,
        ),
      ),
    );
  };

  const handleSave = async () => {
    if (!draft) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await saveDraftQuestions(draft, questions, defaultQuestions);
      const qs = await loadQuestions(draft.id);
      setQuestions(qs);
      setSavedSnapshot(JSON.stringify(qs));
      setNotice('Draft saved.');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleStart = async (from: 'default' | 'published') => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      if (from === 'default') await startDraftFromDefault(selectedState, actorEmail);
      else await startDraftFromPublished(selectedState, actorEmail);
      await reload();
      setNotice(
        from === 'default'
          ? 'Draft created from the system default template.'
          : 'Draft created from the published version.',
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const openPublish = async () => {
    if (!draft) return;
    setPublishValidation(validateQuestions(questions, defaultQuestions));
    try {
      const base = published
        ? await loadQuestions(published.id)
        : defaultQuestions;
      setPublishDiff(diffSummary(base, questions));
      setRecentCount(published ? await countRecentInspections(published.id) : 0);
    } catch {
      setPublishDiff(null);
      setRecentCount(0);
    }
    setPublishOpen(true);
  };

  const handlePublish = async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const { published: now } = await publishDraft(selectedState, actorEmail);
      await reload();
      setNotice(
        `Published ${stateName} form version ${now.version}. A fresh draft (v${now.version + 1}) is ready for the next round of edits.`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const openHistoryView = async (t: FormTemplate) => {
    setViewing(t);
    setViewQuestions([]);
    try {
      setViewQuestions(await loadQuestions(t.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  // ---------------------------------------------------------- rendering

  const selected = questions.find((q) => q.id === selectedId) ?? null;
  const byId = useMemo(
    () => new Map(questions.map((q) => [q.id, q])),
    [questions],
  );

  const renderTreeRows = (
    nodes: QuestionNode[],
    depth: number,
    readOnly: boolean,
    source: FormQuestion[] = questions,
  ): ReactNode[] =>
    nodes.flatMap((node) => {
      const q = node.question;
      const siblings = source
        .filter((x) => x.parent_question_id === q.parent_question_id)
        .sort((a, b) => a.sort_order - b.sort_order);
      const idx = siblings.findIndex((x) => x.id === q.id);
      const row = (
        <div
          key={q.id}
          className="fb-row"
          style={{
            marginLeft: depth * 22,
            background: selectedId === q.id ? '#1e3a5f' : undefined,
            borderLeft: q.is_core ? '3px solid #CF3910' : '3px solid transparent',
          }}
          onClick={() => !readOnly && setSelectedId(q.id)}
        >
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 600 }}>
              {q.prompt || <span className="muted">(untitled question)</span>}
              {q.required ? <span className="req-badge">Required</span> : null}
              {q.is_core ? <span className="lock-badge">🔒 Core</span> : null}
            </div>
            <div className="muted" style={{ fontSize: 12 }}>
              {QUESTION_TYPE_LABELS[q.type]}
              {q.maps_to_system_field
                ? ` · writes to ${q.maps_to_system_field}`
                : ''}
              {q.parent_question_id
                ? ` · shows when parent = "${q.trigger_answer ?? ''}"`
                : ''}
            </div>
          </div>
          {!readOnly && (
            <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
              <button
                type="button"
                className="btn fb-mini"
                disabled={idx <= 0}
                title="Move up"
                onClick={(e) => {
                  e.stopPropagation();
                  moveQuestion(q, -1);
                }}
              >
                ↑
              </button>
              <button
                type="button"
                className="btn fb-mini"
                disabled={idx >= siblings.length - 1}
                title="Move down"
                onClick={(e) => {
                  e.stopPropagation();
                  moveQuestion(q, 1);
                }}
              >
                ↓
              </button>
              {isTriggerCapable(q.type) && (
                <button
                  type="button"
                  className="btn fb-mini"
                  title="Add a follow-up question under this one"
                  onClick={(e) => {
                    e.stopPropagation();
                    addQuestion(q.id);
                  }}
                >
                  + Follow-up
                </button>
              )}
              {!q.is_core && (
                <button
                  type="button"
                  className="btn fb-mini danger"
                  title="Delete this question"
                  onClick={(e) => {
                    e.stopPropagation();
                    deleteQuestion(q);
                  }}
                >
                  Delete
                </button>
              )}
            </div>
          )}
        </div>
      );
      return [row, ...renderTreeRows(node.children, depth + 1, readOnly, source)];
    });

  return (
    <div>
      {/* Header */}
      <div className="card">
        <h2 style={{ marginTop: 0 }}>Form Builder — inspection questionnaire</h2>
        <p className="muted" style={{ marginTop: 0 }}>
          Each state runs its own questionnaire. The <strong>core questions</strong>{' '}
          — the ones that feed the state and firm dashboards — are locked:
          they can&rsquo;t be deleted, reworded, retyped, unmapped, or
          re-triggered. Your state&rsquo;s own questions can be added
          anywhere, including follow-ups under core questions, and reordered
          freely. Inspectors pick up a published version at their next sync;
          an inspection always keeps the version it started with.
        </p>
        <div
          style={{
            display: 'flex',
            gap: 12,
            flexWrap: 'wrap',
            alignItems: 'flex-end',
          }}
        >
          {!stateCode && (
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span className="muted">State</span>
              <select
                value={selectedState}
                onChange={(e) => setSelectedState(e.target.value)}
              >
                {states.map((s) => (
                  <option key={s.code} value={s.code}>
                    {s.name} ({s.code})
                  </option>
                ))}
              </select>
            </label>
          )}
          <div>
            <div className="muted">Published form</div>
            <div>
              {published
                ? `Version ${published.version} — published ${
                    published.published_at
                      ? new Date(published.published_at).toLocaleDateString()
                      : ''
                  }${published.published_by ? ` by ${published.published_by}` : ''}`
                : 'None — inspectors use the system default form'}
            </div>
          </div>
          <div>
            <div className="muted">Draft</div>
            <div>
              {draft
                ? `Version ${draft.version}${dirty ? ' — unsaved changes' : ' — saved'}`
                : 'No draft'}
            </div>
          </div>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button
              type="button"
              className={mode === 'edit' ? 'btn btn-primary' : 'btn'}
              onClick={() => setMode('edit')}
            >
              Edit
            </button>
            <button
              type="button"
              className={mode === 'preview' ? 'btn btn-primary' : 'btn'}
              onClick={() => setMode('preview')}
              disabled={!draft}
            >
              Preview
            </button>
            <button
              type="button"
              className={mode === 'history' ? 'btn btn-primary' : 'btn'}
              onClick={() => setMode('history')}
            >
              Version history
            </button>
          </div>
        </div>
        {error && <p style={{ color: '#f87171', marginBottom: 0 }}>{error}</p>}
        {notice && <p style={{ color: '#4ade80', marginBottom: 0 }}>{notice}</p>}
      </div>

      {loading && (
        <div className="card">
          <p className="muted">Loading form templates…</p>
        </div>
      )}

      {/* No templates yet / no draft */}
      {!loading && !draft && mode !== 'history' && (
        <div className="card">
          {published ? (
            <>
              <h3 style={{ marginTop: 0 }}>No draft in progress</h3>
              <p className="muted">
                {stateName} is running published version {published.version}.
                Create a new draft from it to make changes — publishing the
                draft is what inspectors will pick up.
              </p>
              <button
                type="button"
                className="btn btn-primary"
                disabled={busy}
                onClick={() => void handleStart('published')}
              >
                Create draft from published v{published.version}
              </button>
            </>
          ) : (
            <>
              <h3 style={{ marginTop: 0 }}>{stateName} has no custom form yet</h3>
              <p className="muted">
                Inspectors currently use the system default form. Start from
                that template to build {stateName}&rsquo;s own version — the
                core questions come along locked, and you add your questions
                around them.
              </p>
              <button
                type="button"
                className="btn btn-primary"
                disabled={busy}
                onClick={() => void handleStart('default')}
              >
                Start from default template
              </button>
            </>
          )}
        </div>
      )}

      {/* Editor */}
      {!loading && draft && mode === 'edit' && (
        <div className="fb-layout">
          <div className="card" style={{ flex: 1, minWidth: 320 }}>
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
              }}
            >
              <h3 style={{ marginTop: 0 }}>
                Draft v{draft.version} — questions
              </h3>
              <button
                type="button"
                className="btn"
                onClick={() => addQuestion(null)}
              >
                + Add question
              </button>
            </div>
            {renderTreeRows(buildTree(questions), 0, false)}
            <p className="muted" style={{ fontSize: 12 }}>
              🔒 Core questions (orange edge) come from the system default
              and are locked. Your questions can move anywhere among their
              siblings — the core questions always keep their order and
              wording.
            </p>
          </div>
          <div className="card fb-side">
            {selected ? (
              <QuestionEditor
                key={selected.id}
                question={selected}
                allQuestions={questions}
                byId={byId}
                onPatch={(patch) => patchQuestion(selected.id, patch)}
                onDelete={() => deleteQuestion(selected)}
              />
            ) : (
              <p className="muted">
                Select a question to edit it, or add a new one. Follow-ups
                nest under any Yes/No or choice question and appear only for
                the trigger answer you pick.
              </p>
            )}
            {/* Validation panel */}
            <div style={{ marginTop: 16, borderTop: '1px solid #334155', paddingTop: 12 }}>
              <h4 style={{ margin: '0 0 8px' }}>Checks</h4>
              {liveValidation.errors.length === 0 &&
              liveValidation.warnings.length === 0 ? (
                <p style={{ color: '#4ade80', margin: 0 }}>
                  ✓ Core intact, no problems found.
                </p>
              ) : (
                <>
                  {liveValidation.errors.map((e, i) => (
                    <p key={`e${i}`} style={{ color: '#f87171', margin: '4px 0' }}>
                      ✕ {e}
                    </p>
                  ))}
                  {liveValidation.warnings.map((w, i) => (
                    <p key={`w${i}`} style={{ color: '#fbbf24', margin: '4px 0' }}>
                      ⚠ {w}
                    </p>
                  ))}
                </>
              )}
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 16, flexWrap: 'wrap' }}>
              <button
                type="button"
                className="btn btn-primary"
                disabled={busy || !dirty}
                onClick={() => void handleSave()}
              >
                Save draft
              </button>
              <button
                type="button"
                className="btn"
                disabled={busy || dirty || liveValidation.errors.length > 0}
                title={
                  dirty
                    ? 'Save the draft first'
                    : liveValidation.errors.length > 0
                      ? 'Fix the problems above first'
                      : undefined
                }
                onClick={() => void openPublish()}
              >
                Publish draft…
              </button>
            </div>
            {publishOpen && (
              <div
                style={{
                  marginTop: 16,
                  border: '1px solid #CF3910',
                  borderRadius: 8,
                  padding: 12,
                }}
              >
                <h4 style={{ marginTop: 0 }}>
                  Publish {stateName} form v{draft.version}?
                </h4>
                {publishValidation && publishValidation.errors.length > 0 && (
                  <>
                    <p style={{ color: '#f87171' }}>
                      These problems block publishing:
                    </p>
                    {publishValidation.errors.map((e, i) => (
                      <p key={i} style={{ color: '#f87171', margin: '4px 0' }}>
                        ✕ {e}
                      </p>
                    ))}
                  </>
                )}
                {publishValidation &&
                  publishValidation.warnings.map((w, i) => (
                    <p key={i} style={{ color: '#fbbf24', margin: '4px 0' }}>
                      ⚠ {w}
                    </p>
                  ))}
                {publishDiff && (
                  <div className="muted" style={{ fontSize: 13 }}>
                    {publishDiff.added.length > 0 && (
                      <p style={{ margin: '4px 0' }}>
                        Added: {publishDiff.added.join('; ')}
                      </p>
                    )}
                    {publishDiff.removed.length > 0 && (
                      <p style={{ margin: '4px 0' }}>
                        Removed: {publishDiff.removed.join('; ')}
                      </p>
                    )}
                    {publishDiff.moved > 0 && (
                      <p style={{ margin: '4px 0' }}>
                        {publishDiff.moved} question(s) changed position.
                      </p>
                    )}
                    {publishDiff.added.length === 0 &&
                      publishDiff.removed.length === 0 &&
                      publishDiff.moved === 0 && (
                        <p style={{ margin: '4px 0' }}>
                          No question changes vs the current published form.
                        </p>
                      )}
                  </div>
                )}
                {recentCount > 0 && (
                  <p style={{ color: '#fbbf24' }}>
                    Heads up: {recentCount} inspection(s) were filed under
                    the current published version in the last 24 hours.
                    Publishing now is allowed — inspectors already working
                    keep the version they started with, and new inspections
                    use v{draft.version}.
                  </p>
                )}
                <p className="muted" style={{ fontSize: 13 }}>
                  Publishing freezes v{draft.version}. The previous published
                  version is archived, and a fresh draft is created for the
                  next round of edits.
                </p>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={
                      busy ||
                      (publishValidation?.errors.length ?? 1) > 0
                    }
                    onClick={() => void handlePublish()}
                  >
                    Publish v{draft.version}
                  </button>
                  <button
                    type="button"
                    className="btn"
                    onClick={() => setPublishOpen(false)}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Preview */}
      {!loading && draft && mode === 'preview' && (
        <div className="card">
          <h3 style={{ marginTop: 0 }}>
            Preview — draft v{draft.version} as inspectors will see it
          </h3>
          <FormPreview questions={questions} />
        </div>
      )}

      {/* History */}
      {!loading && mode === 'history' && (
        <div className="card">
          <h3 style={{ marginTop: 0 }}>{stateName} form versions</h3>
          {templates.length === 0 ? (
            <p className="muted">
              No custom versions yet — {stateName} uses the system default
              form.
            </p>
          ) : (
            <div className="table-scroll">
              <table className="data">
                <thead>
                  <tr>
                    <th>Version</th>
                    <th>Status</th>
                    <th>Created</th>
                    <th>Published</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {templates.map((t) => (
                    <tr key={t.id}>
                      <td>v{t.version}</td>
                      <td>{t.status}</td>
                      <td>
                        {new Date(t.created_at).toLocaleDateString()}
                        {t.created_by ? ` · ${t.created_by}` : ''}
                      </td>
                      <td>
                        {t.published_at
                          ? `${new Date(t.published_at).toLocaleDateString()}${t.published_by ? ` · ${t.published_by}` : ''}`
                          : '—'}
                      </td>
                      <td>
                        <button
                          type="button"
                          className="btn"
                          onClick={() => void openHistoryView(t)}
                        >
                          View
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {viewing && (
            <div style={{ marginTop: 16 }}>
              <h4 style={{ marginTop: 0 }}>
                Version {viewing.version} ({viewing.status}) — read only
              </h4>
              {renderTreeRows(buildTree(viewQuestions), 0, true, viewQuestions)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Per-question editor (state questions only — core renders read-only)
// ---------------------------------------------------------------------------

function QuestionEditor({
  question: q,
  allQuestions,
  byId,
  onPatch,
  onDelete,
}: {
  question: FormQuestion;
  allQuestions: FormQuestion[];
  byId: Map<string, FormQuestion>;
  onPatch: (patch: Partial<FormQuestion>) => void;
  onDelete: () => void;
}) {
  if (q.is_core) {
    const parent = q.parent_question_id
      ? byId.get(q.parent_question_id)
      : null;
    return (
      <div>
        <h4 style={{ marginTop: 0 }}>🔒 Core question</h4>
        <p style={{ fontWeight: 600 }}>{q.prompt}</p>
        <dl className="field-grid" style={{ gridTemplateColumns: '1fr' }}>
          <div>
            <dt>Type</dt>
            <dd>{QUESTION_TYPE_LABELS[q.type]}</dd>
          </div>
          {q.maps_to_system_field && (
            <div>
              <dt>Writes to</dt>
              <dd>
                <code>{q.maps_to_system_field}</code> (dashboard data)
              </dd>
            </div>
          )}
          <div>
            <dt>Required</dt>
            <dd>{q.required ? 'Yes' : 'No'}</dd>
          </div>
          {parent && (
            <div>
              <dt>Shows when</dt>
              <dd>
                “{parent.prompt}” = {q.trigger_answer}
              </dd>
            </div>
          )}
        </dl>
        <p className="muted" style={{ fontSize: 13 }}>
          Core questions come from the system default form and feed the
          dashboards, so they can&rsquo;t be deleted, reworded, retyped,
          unmapped, or re-triggered. You can add follow-up questions under
          this one, and place your own questions before or after it.
        </p>
      </div>
    );
  }

  const descendants = new Set(
    allQuestions.filter((x) => {
      let p = x.parent_question_id;
      while (p) {
        if (p === q.id) return true;
        p = byId.get(p)?.parent_question_id ?? null;
      }
      return false;
    }).map((x) => x.id),
  );
  const parentChoices = allQuestions.filter(
    (x) => x.id !== q.id && !descendants.has(x.id) && isTriggerCapable(x.type),
  );
  const parent = q.parent_question_id
    ? byId.get(q.parent_question_id)
    : null;
  const triggerValues = parent ? legalTriggerValues(parent) : [];

  const setType = (type: QuestionType) => {
    const patch: Partial<FormQuestion> = { type };
    if (type === 'single_choice' || type === 'multi_choice') {
      patch.options = q.options ?? [{ value: '', label: '' }];
      patch.config = null;
    } else if (type === 'number') {
      patch.options = null;
      patch.config = q.config ?? { min: 0, step: 1, allow_unknown: false };
    } else if (type === 'photo') {
      patch.options = null;
      patch.config = q.config ?? { min_count: 0 };
    } else {
      patch.options = null;
      patch.config = null;
    }
    onPatch(patch);
  };

  const setOptions = (options: QuestionOption[]) => onPatch({ options });
  const options = q.options ?? [];
  const cfg = q.config ?? {};

  return (
    <div>
      <h4 style={{ marginTop: 0 }}>Edit question</h4>
      <div className="field">
        <label htmlFor="fb-prompt">Question wording</label>
        <input
          id="fb-prompt"
          type="text"
          value={q.prompt}
          onChange={(e) => onPatch({ prompt: e.target.value })}
          placeholder="e.g. Is the approach road passable?"
        />
      </div>
      <div className="field">
        <label htmlFor="fb-help">Help text (optional)</label>
        <input
          id="fb-help"
          type="text"
          value={q.help_text ?? ''}
          onChange={(e) => onPatch({ help_text: e.target.value || null })}
          placeholder="Shown under the question in the field"
        />
      </div>
      <div className="field">
        <label htmlFor="fb-type">Type</label>
        <select
          id="fb-type"
          value={q.type}
          onChange={(e) => setType(e.target.value as QuestionType)}
        >
          {TYPE_OPTIONS.map((t) => (
            <option key={t} value={t}>
              {QUESTION_TYPE_LABELS[t]}
            </option>
          ))}
        </select>
      </div>
      <label style={{ display: 'flex', gap: 8, alignItems: 'center', margin: '8px 0' }}>
        <input
          type="checkbox"
          checked={q.required}
          onChange={(e) => onPatch({ required: e.target.checked })}
        />
        <span>Required — the inspection can&rsquo;t finish without it (when visible)</span>
      </label>

      {(q.type === 'single_choice' || q.type === 'multi_choice') && (
        <div className="field">
          <label>Answer options</label>
          {options.map((o, i) => (
            <div key={i} style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
              <input
                type="text"
                value={o.value}
                placeholder="value"
                style={{ flex: 1 }}
                onChange={(e) =>
                  setOptions(
                    options.map((x, j) =>
                      j === i ? { ...x, value: e.target.value } : x,
                    ),
                  )
                }
              />
              <input
                type="text"
                value={o.label}
                placeholder="Label shown to inspector"
                style={{ flex: 1 }}
                onChange={(e) =>
                  setOptions(
                    options.map((x, j) =>
                      j === i ? { ...x, label: e.target.value } : x,
                    ),
                  )
                }
              />
              <button
                type="button"
                className="btn"
                onClick={() => setOptions(options.filter((_, j) => j !== i))}
              >
                ✕
              </button>
            </div>
          ))}
          <button
            type="button"
            className="btn"
            onClick={() => setOptions([...options, { value: '', label: '' }])}
          >
            + Add option
          </button>
          <p className="hint">
            Values are stored in the data; labels are what inspectors see.
            Changing a value later can orphan follow-ups keyed to it — the
            checks below will flag that.
          </p>
        </div>
      )}

      {q.type === 'number' && (
        <div className="field">
          <label>Number settings</label>
          <div style={{ display: 'flex', gap: 8 }}>
            <label style={{ flex: 1 }}>
              <span className="muted">Min</span>
              <input
                type="number"
                value={typeof cfg.min === 'number' ? cfg.min : ''}
                onChange={(e) =>
                  onPatch({
                    config: {
                      ...cfg,
                      min: e.target.value === '' ? undefined : Number(e.target.value),
                    },
                  })
                }
              />
            </label>
            <label style={{ flex: 1 }}>
              <span className="muted">Step</span>
              <input
                type="number"
                value={typeof cfg.step === 'number' ? cfg.step : ''}
                onChange={(e) =>
                  onPatch({
                    config: {
                      ...cfg,
                      step: e.target.value === '' ? undefined : Number(e.target.value),
                    },
                  })
                }
              />
            </label>
            <label style={{ flex: 1 }}>
              <span className="muted">Unit</span>
              <input
                type="text"
                value={typeof cfg.unit === 'string' ? cfg.unit : ''}
                onChange={(e) =>
                  onPatch({ config: { ...cfg, unit: e.target.value } })
                }
                placeholder="ft"
              />
            </label>
          </div>
          <label style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 6 }}>
            <input
              type="checkbox"
              checked={cfg.allow_unknown === true}
              onChange={(e) =>
                onPatch({ config: { ...cfg, allow_unknown: e.target.checked } })
              }
            />
            <span>Allow an “unknown” answer instead of a number</span>
          </label>
        </div>
      )}

      {q.type === 'photo' && (
        <div className="field">
          <label htmlFor="fb-mincount">Minimum photos required</label>
          <input
            id="fb-mincount"
            type="number"
            min={0}
            value={typeof cfg.min_count === 'number' ? cfg.min_count : 0}
            onChange={(e) =>
              onPatch({ config: { ...cfg, min_count: Number(e.target.value) } })
            }
          />
        </div>
      )}

      <div className="field">
        <label htmlFor="fb-parent">Placement</label>
        <select
          id="fb-parent"
          value={q.parent_question_id ?? ''}
          onChange={(e) => {
            const pid = e.target.value || null;
            const p = pid ? byId.get(pid) : null;
            onPatch({
              parent_question_id: pid,
              trigger_answer: p ? (legalTriggerValues(p)[0] ?? 'yes') : null,
            });
          }}
        >
          <option value="">Top level (always shown)</option>
          {parentChoices.map((p) => (
            <option key={p.id} value={p.id}>
              Follow-up to: {p.prompt || '(untitled)'}
            </option>
          ))}
        </select>
        {parent && (
          <>
            <label htmlFor="fb-trigger" style={{ marginTop: 8 }}>
              Show this follow-up when the parent is answered
            </label>
            <select
              id="fb-trigger"
              value={q.trigger_answer ?? ''}
              onChange={(e) => onPatch({ trigger_answer: e.target.value })}
            >
              {triggerValues.map((v) => (
                <option key={v} value={v}>
                  {parent.type === 'multi_choice' ? `includes "${v}"` : `"${v}"`}
                </option>
              ))}
            </select>
            {parent.type === 'multi_choice' && (
              <p className="hint">
                For multiple-choice parents, the follow-up appears when the
                inspector&rsquo;s answers include the chosen value.
              </p>
            )}
          </>
        )}
      </div>

      <button
        type="button"
        className="btn danger"
        onClick={onDelete}
        style={{ marginTop: 8 }}
      >
        Delete this question
      </button>
    </div>
  );
}
