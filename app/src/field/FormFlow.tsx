// FormFlow — the questionnaire-driven field inspection flow (Phase 2).
//
// Replaces TriageFlow's hard-coded steps: the question tree for the
// bridge's state (cached published template, or the compiled-in default)
// is rendered recursively — a question appears when its parent chain is
// visible and each trigger matches (design §6.2). Mapped answers write
// through to the core emg_inspections columns on the draft, completion
// validation is generated from the visible required questions, and
// triage_list is derived by the outcome engine (§6.3) at finish —
// reproducing the legacy flow's five outcomes exactly.
//
// Drafts are self-contained: the template's questions, the stamped
// form_template_id + form_version, and the per-question answers (with
// snapshots) all live on the draft record, so crash-resume renders the
// exact version the inspection started under.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  Bridge,
  FormAnswerValue,
  FormQuestion,
  InspectionDraft,
  PhotoRef,
} from '../types';
import { capturePhoto } from '../lib/camera';
import { getGpsFix } from '../lib/location';
import { isCoordMismatch } from '../lib/geo';
import { idbPut, idbGet } from '../lib/idb';
import { isLiveSession } from '../lib/crashSession';
import { enqueue } from '../lib/sync';
import { buildTree, type QuestionNode } from '../lib/forms';
import {
  answerOf,
  applyWriteThrough,
  deriveOutcome,
  formProgress,
  missingRequired,
  normalizeCore,
  photosForQuestion,
  photoTypeFor,
  seedAnswersFromCore,
  syncPhotoAnswers,
  triggerMatches,
  withAnswer,
} from '../lib/formEngine';
import {
  resolveTemplateForState,
  stateCodeForAsset,
} from '../lib/formSync';
import Icon from '../components/Icon';

interface FormFlowProps {
  bridge: Bridge;
  inspectorName: string;
  existingDraft?: InspectionDraft;
  /** Legacy TriageFlow step name from crash-resume — the form renders
   *  as one scrollable flow, so there is no step to restore. Accepted
   *  for prop compatibility with FieldApp. */
  initialStep?: string;
  onDone: (draft: InspectionDraft) => void;
  onCancel: () => void;
}

function freshDraft(bridge: Bridge, inspectorName: string): InspectionDraft {
  const cid =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `local-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return {
    client_inspection_id: cid,
    asset_id: bridge.asset_id,
    inspector_name: inspectorName,
    inspection_datetime: new Date().toISOString(),
    sync_status: 'pending',
    triage_list: 'in_progress',
    photos: [],
    destroyed: null,
    access: null,
    drone_used: null,
    bridge_still_there: null,
    overtopped: null,
    overtop_depth_ft: null,
    overtop_depth_unknown: false,
    damage_rail: 'no',
    damage_deck: 'no',
    damage_super: 'no',
    damage_sub: 'no',
    washout_abutment: 'no',
    remain_open: null,
    remain_open_notes: '',
    safe_load: null,
    safe_load_notes: '',
    debris_amount: null,
    gps_lat: null,
    gps_lon: null,
    coord_mismatch: null,
    updated_at: new Date().toISOString(),
    form_template_id: null,
    form_version: null,
    form_answers: [],
    form_questions: undefined,
  };
}

function BridgeHeader({ bridge }: { bridge: Bridge }) {
  const line3 = [bridge.facility ?? '', bridge.feature ?? '', bridge.location ?? '']
    .filter(Boolean)
    .join(' · ');
  return (
    <div className="card">
      <div className="field-label">Asset {bridge.asset_id}</div>
      <div style={{ fontWeight: 600 }}>
        {bridge.county_name ?? '—'}
        {bridge.district ? ` · District ${bridge.district}` : ''}
      </div>
      {line3 ? <div style={{ marginTop: 4, wordBreak: 'break-word' }}>{line3}</div> : null}
      <div style={{ marginTop: 6, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        <span className="pill">Deck {bridge.deck ?? '—'}</span>
        <span className="pill">Super {bridge.super ?? '—'}</span>
        <span className="pill">Sub {bridge.sub ?? '—'}</span>
      </div>
    </div>
  );
}

export default function FormFlow(props: FormFlowProps) {
  const { bridge, inspectorName, existingDraft, onDone, onCancel } = props;

  const [draft, setDraft] = useState<InspectionDraft>(() => {
    if (!existingDraft) return freshDraft(bridge, inspectorName);
    // Resuming a draft that already carries its template: keep it. If it
    // carries questions but no answers (never happens from FormFlow, but
    // cheap to guard), seed answers from the core columns.
    if (existingDraft.form_questions && !existingDraft.form_answers) {
      return {
        ...existingDraft,
        form_answers: seedAnswersFromCore(
          existingDraft,
          existingDraft.form_questions,
        ),
      };
    }
    return existingDraft;
  });
  const [ready, setReady] = useState<boolean>(
    () => Boolean(existingDraft?.form_questions),
  );
  const [busy, setBusy] = useState(false);
  const [gpsBanner, setGpsBanner] = useState(false);
  const gpsAppliedRef = useRef(false);

  // Attach the template for a fresh draft (or a legacy draft that
  // predates Phase 2): resolve from the offline cache for the bridge's
  // state, falling back to the compiled-in default. In-progress drafts
  // keep the version they started with — this runs only when the draft
  // carries no question snapshot.
  useEffect(() => {
    if (existingDraft?.form_questions) return;
    let cancelled = false;
    (async () => {
      const res = await resolveTemplateForState(
        stateCodeForAsset(bridge.asset_id),
      );
      if (cancelled) return;
      setDraft((d) => {
        if (d.form_questions) return d;
        const base: InspectionDraft = {
          ...d,
          form_questions: res.questions,
          form_version: res.template.version,
          form_template_id: res.source === 'cache' ? res.template.id : null,
        };
        if (existingDraft && !existingDraft.form_answers) {
          // Legacy draft: its progress lives in the core columns.
          base.form_answers = seedAnswersFromCore(base, res.questions);
        }
        return base;
      });
      setReady(true);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bridge.asset_id]);

  // Best-effort GPS (same behavior as the legacy flow).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const fix = await getGpsFix();
        if (cancelled || gpsAppliedRef.current) return;
        gpsAppliedRef.current = true;
        const mismatch = isCoordMismatch(bridge.lat, bridge.lon, fix.lat, fix.lon);
        setDraft((d) => ({
          ...d,
          gps_lat: fix.lat,
          gps_lon: fix.lon,
          coord_mismatch: mismatch ? 'yes' : 'no',
        }));
        setGpsBanner(mismatch);
      } catch {
        // silent
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [bridge.lat, bridge.lon]);

  // Persist to IndexedDB on every change — gated on the template being
  // attached so a fresh draft is never saved template-less.
  useEffect(() => {
    if (!ready) return;
    idbPut('drafts', draft).catch(() => {
      /* silent */
    });
  }, [draft, ready]);

  // Crash-resilience heartbeat (same contract as TriageFlow: only ever
  // touch this instance's live session marker).
  useEffect(() => {
    let cancelled = false;
    const beat = async () => {
      try {
        const session = (await idbGet<{
          key: string;
          session_id?: string;
          asset_id: string;
          last_active: string;
        }>('settings', 'active_session')) as
          | (Record<string, unknown> & {
              key: string;
              session_id?: string;
              asset_id: string;
              last_active: string;
            })
          | undefined;
        if (cancelled) return;
        if (!bridge.asset_id || !bridge.asset_id.trim()) return;
        if (
          session &&
          session.asset_id === bridge.asset_id &&
          isLiveSession(session.session_id)
        ) {
          await idbPut('settings', {
            ...session,
            step: 'form',
            last_active: new Date().toISOString(),
          });
        }
      } catch {
        /* silent */
      }
    };
    void beat();
    const timer = setInterval(() => {
      void beat();
    }, 30000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [bridge.asset_id]);

  const questions = useMemo(
    () => draft.form_questions ?? [],
    [draft.form_questions],
  );
  const tree = useMemo(() => buildTree(questions), [questions]);
  const progress = useMemo(
    () => formProgress(questions, draft.form_answers, draft.photos),
    [questions, draft.form_answers, draft.photos],
  );
  const outcome = useMemo(() => deriveOutcome(draft), [draft]);

  const setAnswer = useCallback(
    (q: FormQuestion, value: FormAnswerValue) => {
      setDraft((d) => {
        let next: InspectionDraft = {
          ...d,
          form_answers: withAnswer(d.form_answers, q, value),
          updated_at: new Date().toISOString(),
        };
        next = applyWriteThrough(next, q, value);
        return next;
      });
    },
    [],
  );

  const onCapture = useCallback(
    async (q: FormQuestion) => {
      setBusy(true);
      try {
        const { dataUrl, takenAt } = await capturePhoto();
        const id =
          typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
            ? crypto.randomUUID()
            : `photo-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const ref: PhotoRef = { id, photo_type: photoTypeFor(q), dataUrl, taken_at: takenAt };
        setDraft((d) => {
          const photos = [...d.photos, ref];
          return {
            ...d,
            photos,
            form_answers: syncPhotoAnswers(
              d.form_answers,
              d.form_questions ?? [],
              photos,
            ),
            updated_at: new Date().toISOString(),
          };
        });
      } catch {
        /* silent */
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  const onRemovePhoto = useCallback((id: string) => {
    setDraft((d) => {
      const photos = d.photos.filter((p) => p.id !== id);
      return {
        ...d,
        photos,
        form_answers: syncPhotoAnswers(d.form_answers, d.form_questions ?? [], photos),
      };
    });
  }, []);

  const onDescribePhoto = useCallback((id: string, description: string) => {
    setDraft((d) => ({
      ...d,
      photos: d.photos.map((p) => (p.id === id ? { ...p, description } : p)),
    }));
  }, []);

  const finish = useCallback(async () => {
    const missing: string[] = [];
    if (!draft.inspector_name?.trim()) missing.push('Enter inspector name');
    if (!draft.asset_id || !draft.asset_id.trim())
      missing.push('Bridge asset ID missing');
    for (const q of missingRequired(questions, draft.form_answers, draft.photos)) {
      missing.push(
        q.type === 'photo' ? `Add photo: ${q.prompt}` : `Answer: ${q.prompt}`,
      );
    }
    if (missing.length > 0) {
      alert(`Cannot finish inspection. Please complete:\n• ${missing.join('\n• ')}`);
      return;
    }
    const finalDraft: InspectionDraft = {
      ...normalizeCore(draft),
      triage_list: outcome,
      form_answers: syncPhotoAnswers(draft.form_answers, questions, draft.photos),
      updated_at: new Date().toISOString(),
    };
    try {
      await idbPut('drafts', finalDraft);
    } catch (err) {
      console.error('Failed to save draft:', err);
      alert('Could not save inspection draft. Please try again.');
      return;
    }
    try {
      await enqueue('inspection', finalDraft);
    } catch (err) {
      console.error('Failed to queue inspection:', err);
      alert('Inspection saved locally but could not be queued for sync. Please try syncing manually.');
    }
    onDone(finalDraft);
  }, [draft, questions, outcome, onDone]);

  // ---- Question controls (the legacy form's look: Yes green / No red /
  // ---- choices burnt orange, big tap targets) ----

  const renderControl = (q: FormQuestion): React.ReactNode => {
    const ans = answerOf(draft.form_answers, q.id)?.answer;
    const value = ans && 'value' in ans ? ans.value : undefined;
    switch (q.type) {
      case 'yes_no':
        return (
          <div className="seg" role="group" aria-label={q.prompt}>
            {(['yes', 'no'] as const).map((v) => (
              <button
                key={v}
                type="button"
                className={`btn ${v}${value === v ? ' active' : ' secondary'}`}
                aria-pressed={value === v}
                style={{ flex: 1, minHeight: 56 }}
                onClick={() => setAnswer(q, { value: v })}
              >
                {v === 'yes' ? 'Yes' : 'No'}
              </button>
            ))}
          </div>
        );
      case 'single_choice':
        return (
          <div className="choice" role="radiogroup" aria-label={q.prompt}>
            {(q.options ?? []).map((o) => (
              <button
                key={o.value}
                type="button"
                role="radio"
                aria-checked={value === o.value}
                className={`btn ${o.value === 'yes' ? 'yes' : o.value === 'no' ? 'no' : 'pick'}${value === o.value ? ' active' : ' secondary'}`}
                style={{ minHeight: 48, textAlign: 'left', width: '100%', marginBottom: 6 }}
                onClick={() => setAnswer(q, { value: o.value })}
              >
                {o.label}
              </button>
            ))}
          </div>
        );
      case 'multi_choice': {
        const selected = Array.isArray(value) ? value : [];
        return (
          <div className="choice" role="group" aria-label={q.prompt}>
            {(q.options ?? []).map((o) => {
              const on = selected.includes(o.value);
              return (
                <button
                  key={o.value}
                  type="button"
                  aria-pressed={on}
                  className={`btn pick${on ? ' active' : ' secondary'}`}
                  style={{ minHeight: 48, textAlign: 'left', width: '100%', marginBottom: 6 }}
                  onClick={() =>
                    setAnswer(q, {
                      value: on
                        ? selected.filter((v) => v !== o.value)
                        : [...selected, o.value],
                    })
                  }
                >
                  {on ? '☑ ' : '☐ '}
                  {o.label}
                </button>
              );
            })}
          </div>
        );
      }
      case 'number': {
        const unknown =
          ans && 'unknown' in ans && ans.unknown === true;
        const numVal =
          typeof value === 'number' && Number.isFinite(value) ? String(value) : '';
        return (
          <div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <input
                type="number"
                inputMode="decimal"
                min={typeof q.config?.min === 'number' ? (q.config.min as number) : undefined}
                step={typeof q.config?.step === 'number' ? (q.config.step as number) : undefined}
                value={unknown ? '' : numVal}
                disabled={unknown}
                onChange={(e) => {
                  const raw = e.target.value;
                  if (raw === '') {
                    setAnswer(q, { value: null });
                    return;
                  }
                  const n = Number(raw);
                  if (!Number.isFinite(n) || n < 0) return;
                  setAnswer(q, { value: n });
                }}
                style={{ flex: 1, minHeight: 48 }}
                aria-label={q.prompt}
              />
              {typeof q.config?.unit === 'string' ? (
                <span className="muted">{String(q.config.unit)}</span>
              ) : null}
            </div>
            {q.config?.allow_unknown === true ? (
              <button
                type="button"
                className={`btn${unknown ? ' active' : ' secondary'}`}
                aria-pressed={unknown}
                style={{ marginTop: 8, minHeight: 44, width: '100%' }}
                onClick={() =>
                  setAnswer(
                    q,
                    unknown ? { value: null } : { value: null, unknown: true },
                  )
                }
              >
                {q.maps_to_system_field === 'overtop_depth_ft'
                  ? 'Depth unknown'
                  : 'Unknown'}
              </button>
            ) : null}
          </div>
        );
      }
      case 'text':
        return (
          <textarea
            rows={3}
            value={typeof value === 'string' ? value : ''}
            onChange={(e) => setAnswer(q, { value: e.target.value })}
            aria-label={q.prompt}
            style={{ width: '100%' }}
          />
        );
      case 'photo': {
        const mine = photosForQuestion(q, draft.photos);
        const max =
          typeof q.config?.max_count === 'number'
            ? (q.config.max_count as number)
            : null;
        const allowNotes = q.config?.allow_notes === true;
        return (
          <div>
            <div className="photo-grid">
              {mine.map((p) => (
                <div key={p.id} className="photo-item">
                  {p.dataUrl ? <img src={p.dataUrl} alt={p.description ?? ''} /> : null}
                  <button
                    type="button"
                    className="rm"
                    aria-label="Remove photo"
                    onClick={() => onRemovePhoto(p.id)}
                  >
                    ×
                  </button>
                  {allowNotes ? (
                    <input
                      className="photo-note"
                      type="text"
                      value={p.description ?? ''}
                      placeholder="Add a note…"
                      onChange={(e) => onDescribePhoto(p.id, e.target.value)}
                      aria-label="Photo note"
                    />
                  ) : null}
                </div>
              ))}
            </div>
            {max === null || mine.length < max ? (
              <button
                type="button"
                className="photo-add-compact"
                disabled={busy}
                onClick={() => void onCapture(q)}
                aria-label={q.prompt}
              >
                {busy ? 'Capturing…' : (<><Icon name="camera" size={16} /> Add photo</>)}
              </button>
            ) : null}
          </div>
        );
      }
      default:
        return null;
    }
  };

  const renderNode = (node: QuestionNode, depth: number): React.ReactNode => {
    const q = node.question;
    const ans = answerOf(draft.form_answers, q.id)?.answer;
    const kids = node.children.filter(
      (c) => c.question.trigger_answer && triggerMatches(ans, c.question.trigger_answer),
    );
    return (
      <div
        key={q.id}
        style={
          depth > 0
            ? { marginLeft: 14, borderLeft: '2px solid #e2e8f0', paddingLeft: 10, marginTop: 10 }
            : { marginTop: 10 }
        }
      >
        <div className="field">
          <div className="field-label">
            {q.prompt}
            {q.required ? <span className="req-badge">Required</span> : null}
          </div>
          {q.help_text ? <p className="hint">{q.help_text}</p> : null}
          {renderControl(q)}
        </div>
        {kids.map((c) => renderNode(c, depth + 1))}
      </div>
    );
  };

  const finishLabel =
    outcome === 'destroyed'
      ? 'Finish: mark DESTROYED'
      : outcome === 'revisit'
        ? 'Place on revisit list'
        : outcome === 'likely_destroyed'
          ? 'Confirm: likely destroyed'
          : outcome === 'ground_followup'
            ? 'Finish: ground follow-up'
            : 'Save inspection';

  const renderOutcomePanel = () => {
    if (outcome === 'revisit' && draft.drone_used === 'no') {
      return (
        <div className="card">
          <div className="warn-box">
            Find alternate access. This bridge is placed on the REVISIT list.
          </div>
        </div>
      );
    }
    if (outcome === 'likely_destroyed') {
      return (
        <div className="card">
          <div className="warn-box">
            Drone observation indicates the bridge may be gone. Confirm
            classification as likely destroyed.
          </div>
        </div>
      );
    }
    if (outcome === 'complete' && draft.access === 'yes') {
      const overtopLine =
        draft.overtopped === 'yes'
          ? draft.overtop_depth_unknown
            ? 'Yes — depth Unknown'
            : `Yes — max ${typeof draft.overtop_depth_ft === 'number' ? draft.overtop_depth_ft : '—'} ft`
          : draft.overtopped === 'no'
            ? 'No'
            : '—';
      return (
        <div className="card">
          <div className="field-label">Review</div>
          <div style={{ display: 'grid', gap: 6, marginTop: 4 }}>
            <div>Overtopped: {overtopLine}</div>
            <div>Rail damage: {draft.damage_rail}</div>
            <div>Deck damage: {draft.damage_deck}</div>
            <div>Superstructure damage: {draft.damage_super}</div>
            <div>Substructure damage: {draft.damage_sub}</div>
            <div>Approach washout: {draft.washout_abutment}</div>
            <div>Remain open: {draft.remain_open ?? '—'}</div>
            <div>Safe to carry load: {draft.safe_load ?? '—'}</div>
            <div>Debris: {draft.debris_amount ?? '—'}</div>
            <div>Photos: {draft.photos.length}</div>
            <div>Questions answered: {(draft.form_answers ?? []).length}</div>
          </div>
          {draft.remain_open_notes ? (
            <div style={{ marginTop: 8 }}>
              <div className="field-label">Open notes</div>
              <div style={{ wordBreak: 'break-word' }}>{draft.remain_open_notes}</div>
            </div>
          ) : null}
          {draft.safe_load_notes ? (
            <div style={{ marginTop: 8 }}>
              <div className="field-label">Load notes</div>
              <div style={{ wordBreak: 'break-word' }}>{draft.safe_load_notes}</div>
            </div>
          ) : null}
        </div>
      );
    }
    return null;
  };

  if (!ready) {
    return (
      <div className="screen">
        <BridgeHeader bridge={bridge} />
        <div className="card">
          <div className="muted">Loading inspection form…</div>
        </div>
      </div>
    );
  }

  return (
    <div className="screen">
      <BridgeHeader bridge={bridge} />
      {gpsBanner ? (
        <div className="warn-box">
          GPS differs from NBI coordinates by &gt;100 m — verify this is the
          correct bridge.
        </div>
      ) : null}
      <div className="field" style={{ marginBottom: 4 }}>
        <div className="eyebrow">Inspection progress</div>
        <div className="field-label">
          {progress.answered} of {progress.total} required questions answered
          {draft.form_version ? ` · Form v${draft.form_version}` : ''}
        </div>
        <div
          style={{
            height: 6,
            borderRadius: 2,
            background: '#DDDDDD',
            overflow: 'hidden',
          }}
        >
          <div
            style={{
              height: '100%',
              width:
                progress.total > 0
                  ? `${Math.round((progress.answered / progress.total) * 100)}%`
                  : '0%',
              background: '#CF3910',
            }}
          />
        </div>
      </div>
      {tree.map((node) => (
        <div className="card" key={node.question.id}>
          {renderNode(node, 0)}
        </div>
      ))}
      {renderOutcomePanel()}
      <div className="card" style={{ display: 'flex', gap: 8 }}>
        <button type="button" className="btn secondary" style={{ flex: 1 }} onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="btn" style={{ flex: 1 }} onClick={() => void finish()}>
          {finishLabel}
        </button>
      </div>
    </div>
  );
}
