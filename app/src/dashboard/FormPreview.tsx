// Form Preview — renders a form template's question tree the way the
// field app will (Phase 2 reuses this renderer): nested questions appear
// only when the parent's test answer matches their trigger, Yes = green,
// No = red, choices = burnt orange, exactly like TriageFlow's controls.
//
// Answers live in local state only — this is a tap-through test mode for
// state admins, nothing is saved. Photo questions render as slots (no
// camera in the office preview).
import { useMemo, useState, type ReactNode } from 'react';
import { buildTree, type QuestionNode } from '../lib/forms';
import type { FormQuestion } from '../types';

type Answer = string | string[] | undefined;

function answerMatches(answer: Answer, trigger: string): boolean {
  if (Array.isArray(answer)) return answer.includes(trigger);
  return answer === trigger;
}

export default function FormPreview({
  questions,
}: {
  questions: FormQuestion[];
}) {
  const [answers, setAnswers] = useState<Record<string, Answer>>({});
  const [unknowns, setUnknowns] = useState<Record<string, boolean>>({});
  const tree = useMemo(() => buildTree(questions), [questions]);

  const setAnswer = (id: string, value: Answer) =>
    setAnswers((prev) => ({ ...prev, [id]: value }));

  // Visible questions, in render order, driving the progress count.
  const visible: FormQuestion[] = [];
  const collect = (nodes: QuestionNode[]) => {
    for (const node of nodes) {
      visible.push(node.question);
      const ans = answers[node.question.id];
      for (const child of node.children) {
        if (
          child.question.trigger_answer &&
          answerMatches(ans, child.question.trigger_answer)
        ) {
          collect([child]);
        }
      }
    }
  };
  collect(tree);

  const requiredVisible = visible.filter((q) => q.required);
  const answeredRequired = requiredVisible.filter((q) => {
    const a = answers[q.id];
    if (q.type === 'number' && unknowns[q.id]) return true;
    if (Array.isArray(a)) return a.length > 0;
    return a !== undefined && a !== '';
  });

  const renderNode = (node: QuestionNode, depth: number): ReactNode => {
    const q = node.question;
    const ans = answers[q.id];
    const kids = node.children.filter(
      (c) =>
        c.question.trigger_answer &&
        answerMatches(ans, c.question.trigger_answer),
    );
    return (
      <div
        key={q.id}
        style={depth > 0 ? { marginLeft: 14, borderLeft: '2px solid #e2e8f0', paddingLeft: 10 } : undefined}
      >
        <div className="field">
          <div className="field-label" style={{ textTransform: 'none', letterSpacing: 0 }}>
            {q.prompt}
            {q.required ? <span className="req-badge">Required</span> : null}
            {q.is_core ? (
              <span className="lock-badge" title="Locked core question">
                {' '}
                🔒 core
              </span>
            ) : null}
          </div>
          {q.help_text && <p className="hint">{q.help_text}</p>}
          {q.type === 'yes_no' && (
            <div className="seg" role="group" aria-label={q.prompt}>
              {['yes', 'no'].map((v) => (
                <button
                  key={v}
                  type="button"
                  className={`btn ${v}${ans === v ? ' active' : ' secondary'}`}
                  aria-pressed={ans === v}
                  style={{ flex: 1, minHeight: 52 }}
                  onClick={() => setAnswer(q.id, v)}
                >
                  {v === 'yes' ? 'Yes' : 'No'}
                </button>
              ))}
            </div>
          )}
          {q.type === 'single_choice' && (
            <div className="choice" role="radiogroup" aria-label={q.prompt}>
              {(q.options ?? []).map((o) => (
                <button
                  key={o.value}
                  type="button"
                  role="radio"
                  aria-checked={ans === o.value}
                  className={`btn pick${ans === o.value ? ' active' : ' secondary'}`}
                  style={{ minHeight: 48, textAlign: 'left', width: '100%', marginBottom: 6 }}
                  onClick={() => setAnswer(q.id, o.value)}
                >
                  {o.label}
                </button>
              ))}
            </div>
          )}
          {q.type === 'multi_choice' && (
            <div className="choice" role="group" aria-label={q.prompt}>
              {(q.options ?? []).map((o) => {
                const selected = Array.isArray(ans) && ans.includes(o.value);
                return (
                  <button
                    key={o.value}
                    type="button"
                    aria-pressed={selected}
                    className={`btn pick${selected ? ' active' : ' secondary'}`}
                    style={{ minHeight: 48, textAlign: 'left', width: '100%', marginBottom: 6 }}
                    onClick={() => {
                      const cur = Array.isArray(ans) ? ans : [];
                      setAnswer(
                        q.id,
                        selected
                          ? cur.filter((v) => v !== o.value)
                          : [...cur, o.value],
                      );
                    }}
                  >
                    {selected ? '☑ ' : '☐ '}
                    {o.label}
                  </button>
                );
              })}
            </div>
          )}
          {q.type === 'text' && (
            <textarea
              value={typeof ans === 'string' ? ans : ''}
              onChange={(e) => setAnswer(q.id, e.target.value)}
              placeholder="Inspector types here…"
              rows={2}
            />
          )}
          {q.type === 'number' && (
            <div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <input
                  type="number"
                  value={unknowns[q.id] ? '' : typeof ans === 'string' ? ans : ''}
                  disabled={Boolean(unknowns[q.id])}
                  min={typeof q.config?.min === 'number' ? (q.config.min as number) : undefined}
                  step={typeof q.config?.step === 'number' ? (q.config.step as number) : undefined}
                  onChange={(e) => setAnswer(q.id, e.target.value)}
                  placeholder="0.0"
                  style={{ flex: 1 }}
                />
                {typeof q.config?.unit === 'string' && (
                  <span className="muted">{String(q.config.unit)}</span>
                )}
              </div>
              {q.config?.allow_unknown === true && (
                <label style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 6 }}>
                  <input
                    type="checkbox"
                    checked={Boolean(unknowns[q.id])}
                    onChange={(e) =>
                      setUnknowns((prev) => ({ ...prev, [q.id]: e.target.checked }))
                    }
                  />
                  <span>Unknown</span>
                </label>
              )}
            </div>
          )}
          {q.type === 'photo' && (
            <div className="photo-slot-preview">
              📷 Photo slot
              {typeof q.config?.min_count === 'number' && q.config.min_count > 0
                ? ` — at least ${String(q.config.min_count)} required`
                : ' — optional'}
            </div>
          )}
        </div>
        {kids.map((c) => renderNode(c, depth + 1))}
      </div>
    );
  };

  return (
    <div>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: 8,
        }}
      >
        <span className="muted" style={{ fontSize: 13 }}>
          {answeredRequired.length} of {requiredVisible.length} visible required
          questions answered
        </span>
        <button
          type="button"
          className="btn"
          onClick={() => {
            setAnswers({});
            setUnknowns({});
          }}
        >
          Reset test answers
        </button>
      </div>
      <div className="phone-frame">
        <div className="phone-notch" />
        {tree.length === 0 ? (
          <p className="muted" style={{ padding: 16 }}>
            No questions yet.
          </p>
        ) : (
          tree.map((n) => renderNode(n, 0))
        )}
        <p className="muted" style={{ fontSize: 12, textAlign: 'center' }}>
          Preview only — answers are not saved. Follow-up questions appear
          when their trigger answer is selected.
        </p>
      </div>
    </div>
  );
}
