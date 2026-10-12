import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  Bridge,
  InspectionDraft,
  PhotoRef,
  PhotoType,
  YesNo,
  TriageList,
  OpenStatus,
  LoadStatus,
  DebrisAmount,
} from '../types';
import { capturePhoto } from '../lib/camera';
import { getGpsFix } from '../lib/location';
import { isCoordMismatch } from '../lib/geo';
import { idbPut, idbGet } from '../lib/idb';
import { enqueue } from '../lib/sync';
import PhotoSection from './PhotoSection';

interface TriageFlowProps {
  bridge: Bridge;
  inspectorName: string;
  existingDraft?: InspectionDraft;
  onDone: (draft: InspectionDraft) => void;
  onCancel: () => void;
}

type Step =
  | 'destroyed'
  | 'destroyed_photos'
  | 'access'
  | 'drone'
  | 'revisit_note'
  | 'still_there'
  | 'review_likely_destroyed'
  | 'overtopped'
  | 'damage'
  | 'photos'
  | 'decisions'
  | 'review';

const STEP_ORDER: Step[] = [
  'destroyed',
  'destroyed_photos',
  'access',
  'drone',
  'revisit_note',
  'still_there',
  'overtopped',
  'damage',
  'photos',
  'decisions',
  'review',
];

function stepIndex(s: Step): number {
  const i = STEP_ORDER.indexOf(s);
  return i < 0 ? 0 : i;
}

function freshDraft(bridge: Bridge, inspectorName: string): InspectionDraft {
  const cid =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `local-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const draft: InspectionDraft = {
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
  };
  return draft;
}

interface SegOption<T extends string> {
  value: T;
  label: string;
}

interface SegProps<T extends string> {
  label: string;
  options: SegOption<T>[];
  value: T | null | undefined;
  onChange: (v: T) => void;
  required?: boolean;
}

function Segmented<T extends string>(props: SegProps<T>) {
  const { label, options, value, onChange, required } = props;
  return (
    <div className="field">
      <div className="field-label">
        {label}
        {required ? <span className="req-badge">Required</span> : null}
      </div>
      <div className="seg" role="group" aria-label={label}>
        {options.map((opt) => {
          const active = value === opt.value;
          return (
            <button
              key={opt.value}
              type="button"
              className={`btn${active ? ' active' : ' secondary'}`}
              aria-pressed={active}
              onClick={() => onChange(opt.value)}
              style={{ flex: 1, minHeight: 52 }}
            >
              {opt.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

interface ChoiceProps<T extends string> {
  label: string;
  options: SegOption<T>[];
  value: T | null | undefined;
  onChange: (v: T) => void;
}

function ChoiceList<T extends string>(props: ChoiceProps<T>) {
  const { label, options, value, onChange } = props;
  return (
    <div className="field">
      <div className="field-label">{label}</div>
      <div className="choice" role="radiogroup" aria-label={label}>
        {options.map((opt) => {
          const active = value === opt.value;
          return (
            <button
              key={opt.value}
              type="button"
              role="radio"
              aria-checked={active}
              className={`btn${active ? ' active' : ' secondary'}`}
              onClick={() => onChange(opt.value)}
              style={{ minHeight: 48, textAlign: 'left' }}
            >
              {opt.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function BridgeHeader({ bridge }: { bridge: Bridge }) {
  const facility = bridge.facility ?? '';
  const feature = bridge.feature ?? '';
  const location = bridge.location ?? '';
  const line3 = [facility, feature, location].filter(Boolean).join(' · ');
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

function ProgressDots({ step }: { step: Step }) {
  const active = stepIndex(step);
  const total = STEP_ORDER.length;
  return (
    <div className="field" style={{ marginBottom: 4 }}>
      <div className="eyebrow">Inspection progress</div>
      <div className="field-label">Step {active + 1} of {total}</div>
      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
        {STEP_ORDER.map((s, i) => (
          <span
            key={s}
            aria-hidden="true"
            style={{
              width: 24,
              height: 6,
              borderRadius: 2,
              background: i <= active ? '#CF3910' : '#DDDDDD',
            }}
          />
        ))}
      </div>
    </div>
  );
}

export default function TriageFlow(props: TriageFlowProps) {
  const { bridge, inspectorName, existingDraft, onDone, onCancel } = props;

  const [draft, setDraft] = useState<InspectionDraft>(
    () => existingDraft ?? freshDraft(bridge, inspectorName),
  );
  const [step, setStep] = useState<Step>('destroyed');
  const [busy, setBusy] = useState(false);
  const [gpsBanner, setGpsBanner] = useState(false);
  const gpsAppliedRef = useRef(false);

  // Best-effort GPS
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const fix = await getGpsFix();
        if (cancelled || gpsAppliedRef.current) return;
        gpsAppliedRef.current = true;
        const mismatch = isCoordMismatch(
          bridge.lat,
          bridge.lon,
          fix.lat,
          fix.lon,
        );
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

  // Persist to IndexedDB on every change
  useEffect(() => {
    idbPut('drafts', draft).catch(() => {
      /* silent */
    });
  }, [draft]);

  // Crash-resilience heartbeat: refresh the active session's last_active
  // every 30s so a crash/power loss can offer resume on next launch.
  useEffect(() => {
    let cancelled = false;
    const beat = async () => {
      try {
        const session = (await idbGet<{
          key: string;
          asset_id: string;
          last_active: string;
        }>('settings', 'active_session')) as
          | (Record<string, unknown> & {
              key: string;
              asset_id: string;
              last_active: string;
            })
          | undefined;
        if (cancelled) return;
        if (session && session.asset_id === bridge.asset_id) {
          await idbPut('settings', {
            ...session,
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

  const damageFlags = useMemo(
    () => ({
      rail: draft.damage_rail === 'yes',
      deck: draft.damage_deck === 'yes',
      super: draft.damage_super === 'yes',
      sub: draft.damage_sub === 'yes',
      washout: draft.washout_abutment === 'yes',
    }),
    [draft.damage_rail, draft.damage_deck, draft.damage_super, draft.damage_sub, draft.washout_abutment],
  );

  const finish = useCallback(
    async (triage: TriageList) => {
      // Validate required fields before queuing — don't let incomplete
      // inspections into the sync queue.
      const missing: string[] = [];
      if (!draft.destroyed) missing.push('Was the bridge destroyed?');
      if (!draft.inspector_name?.trim()) missing.push('Inspector name');
      if (missing.length > 0) {
        alert(
          `Cannot finish inspection. Please complete:\n• ${missing.join('\n• ')}`
        );
        return;
      }
      const finalDraft: InspectionDraft = { ...draft, triage_list: triage };
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
    },
    [draft, onDone],
  );

  const onCapture = useCallback(
    async (type: PhotoType) => {
      setBusy(true);
      try {
        const { dataUrl, takenAt } = await capturePhoto();
        const id =
          typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
            ? crypto.randomUUID()
            : `photo-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const ref: PhotoRef = {
          id,
          photo_type: type,
          dataUrl,
          taken_at: takenAt,
        };
        setDraft((d) => ({ ...d, photos: [...d.photos, ref] }));
      } catch {
        /* silent */
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  const onRemove = useCallback((id: string) => {
    setDraft((d) => ({ ...d, photos: d.photos.filter((p) => p.id !== id) }));
  }, []);

  const onDescribe = useCallback((id: string, description: string) => {
    setDraft((d) => ({
      ...d,
      photos: d.photos.map((p) => (p.id === id ? { ...p, description } : p)),
    }));
  }, []);

  // Derived
  const destroyedProfile = draft.photos.some((p) => p.photo_type === 'destroyed_profile');
  const destroyedApproach = draft.photos.some((p) => p.photo_type === 'destroyed_approach');
  const destroyedPhotosReady = destroyedProfile && destroyedApproach;

  const overtopDepthValid =
    draft.overtopped === 'yes'
      ? typeof draft.overtop_depth_ft === 'number' && draft.overtop_depth_ft >= 0
      : true;

  // Handlers
  const setYesNo = useCallback(
    <K extends keyof InspectionDraft>(key: K, val: YesNo) => {
      setDraft((d) => ({ ...d, [key]: val } as InspectionDraft));
    },
    [],
  );

  const renderDestroyed = () => (
    <>
      <div className="card">
        <div className="field-label">Was the bridge destroyed?</div>
        <div className="seg" role="group" aria-label="Was the bridge destroyed?">
          <button
            type="button"
            className={`btn${draft.destroyed === 'yes' ? ' active' : ' secondary'}`}
            style={{ flex: 1, minHeight: 56 }}
            onClick={() => {
              setYesNo('destroyed', 'yes');
              setStep('destroyed_photos');
            }}
          >
            Yes
          </button>
          <button
            type="button"
            className={`btn${draft.destroyed === 'no' ? ' active' : ' secondary'}`}
            style={{ flex: 1, minHeight: 56 }}
            onClick={() => {
              setYesNo('destroyed', 'no');
              setStep('access');
            }}
          >
            No
          </button>
        </div>
      </div>
    </>
  );

  const renderDestroyedPhotos = () => (
    <>
      <PhotoSection
        photos={draft.photos}
        onCapture={onCapture}
        onRemove={onRemove}
        onDescribe={onDescribe}
        busy={busy}
        destroyedMode={true}
        damageFlags={damageFlags}
      />
      <div className="card" style={{ display: 'flex', gap: 8 }}>
        <button
          type="button"
          className="btn secondary"
          style={{ flex: 1 }}
          onClick={() => setStep('destroyed')}
        >
          Back
        </button>
        <button
          type="button"
          className="btn"
          style={{ flex: 1 }}
          disabled={!destroyedPhotosReady}
          onClick={() => finish('destroyed')}
        >
          Finish: mark DESTROYED
        </button>
      </div>
    </>
  );

  const renderAccess = () => (
    <div className="card">
      <div className="field-label">Were you able to access the bridge?</div>
      <div className="seg" role="group" aria-label="Were you able to access the bridge?">
        <button
          type="button"
          className={`btn${draft.access === 'yes' ? ' active' : ' secondary'}`}
          style={{ flex: 1, minHeight: 56 }}
          onClick={() => {
            setYesNo('access', 'yes');
            setStep('overtopped');
          }}
        >
          Yes
        </button>
        <button
          type="button"
          className={`btn${draft.access === 'no' ? ' active' : ' secondary'}`}
          style={{ flex: 1, minHeight: 56 }}
          onClick={() => {
            setYesNo('access', 'no');
            setStep('drone');
          }}
        >
          No
        </button>
      </div>
    </div>
  );

  const renderDrone = () => (
    <div className="card">
      <div className="field-label">Was drone reconnaissance used?</div>
      <div className="seg" role="group" aria-label="Was drone reconnaissance used?">
        <button
          type="button"
          className={`btn${draft.drone_used === 'yes' ? ' active' : ' secondary'}`}
          style={{ flex: 1, minHeight: 56 }}
          onClick={() => {
            setYesNo('drone_used', 'yes');
            setStep('still_there');
          }}
        >
          Yes
        </button>
        <button
          type="button"
          className={`btn${draft.drone_used === 'no' ? ' active' : ' secondary'}`}
          style={{ flex: 1, minHeight: 56 }}
          onClick={() => {
            setYesNo('drone_used', 'no');
            setStep('revisit_note');
          }}
        >
          No
        </button>
      </div>
    </div>
  );

  const renderRevisitNote = () => (
    <div className="card">
      <div className="warn-box">
        Find alternate access. This bridge is placed on the REVISIT list.
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
        <button
          type="button"
          className="btn secondary"
          style={{ flex: 1 }}
          onClick={() => setStep('drone')}
        >
          Back
        </button>
        <button
          type="button"
          className="btn"
          style={{ flex: 1 }}
          onClick={() => finish('revisit')}
        >
          Place on revisit list
        </button>
      </div>
    </div>
  );

  const renderStillThere = () => (
    <div className="card">
      <div className="field-label">Is the bridge still there? (drone observation)</div>
      <div className="seg" role="group" aria-label="Is the bridge still there?">
        <button
          type="button"
          className={`btn${draft.bridge_still_there === 'no' ? ' active' : ' secondary'}`}
          style={{ flex: 1, minHeight: 56 }}
          onClick={() => {
            setYesNo('bridge_still_there', 'no');
            setStep('review_likely_destroyed');
          }}
        >
          No
        </button>
        <button
          type="button"
          className={`btn${draft.bridge_still_there === 'yes' ? ' active' : ' secondary'}`}
          style={{ flex: 1, minHeight: 56 }}
          onClick={() => {
            setYesNo('bridge_still_there', 'yes');
            finish('ground_followup');
          }}
        >
          Yes
        </button>
      </div>
      <div style={{ marginTop: 12, fontSize: 13, opacity: 0.8 }}>
        Choosing No suggests likely destroyed. Choosing Yes places the bridge on
        the ground follow-up list for inspectors on the ground.
      </div>
    </div>
  );

  const renderLikelyDestroyedConfirm = () => (
    <div className="card">
      <div className="warn-box">
        Drone observation indicates the bridge may be gone. Confirm classification
        as likely destroyed.
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
        <button
          type="button"
          className="btn secondary"
          style={{ flex: 1 }}
          onClick={() => setStep('still_there')}
        >
          Back
        </button>
        <button
          type="button"
          className="btn"
          style={{ flex: 1 }}
          onClick={() => finish('likely_destroyed')}
        >
          Confirm: likely destroyed
        </button>
      </div>
    </div>
  );

  const renderOvertopped = () => (
    <div className="card">
      <div className="field-label">Has the bridge overtopped?</div>
      <div className="seg" role="group" aria-label="Has the bridge overtopped?">
        <button
          type="button"
          className={`btn${draft.overtopped === 'yes' ? ' active' : ' secondary'}`}
          style={{ flex: 1, minHeight: 56 }}
          onClick={() =>
            setDraft((d) => ({
              ...d,
              overtopped: 'yes',
              overtop_depth_ft:
                typeof d.overtop_depth_ft === 'number' ? d.overtop_depth_ft : 0,
            }))
          }
        >
          Yes
        </button>
        <button
          type="button"
          className={`btn${draft.overtopped === 'no' ? ' active' : ' secondary'}`}
          style={{ flex: 1, minHeight: 56 }}
          onClick={() =>
            setDraft((d) => ({
              ...d,
              overtopped: 'no',
              overtop_depth_ft: null,
            }))
          }
        >
          No
        </button>
      </div>

      {draft.overtopped === 'yes' ? (
        <div className="field" style={{ marginTop: 12 }}>
          <label className="field-label" htmlFor="overtop-depth">
            Maximum depth of overtopping (ft)
            <span className="req-badge">Required</span>
          </label>
          <input
            id="overtop-depth"
            type="number"
            inputMode="decimal"
            min={0}
            step="0.1"
            value={
              typeof draft.overtop_depth_ft === 'number'
                ? String(draft.overtop_depth_ft)
                : ''
            }
            onChange={(e) => {
              const v = e.target.value;
              if (v === '') {
                setDraft((d) => ({ ...d, overtop_depth_ft: null }));
                return;
              }
              const n = Number(v);
              if (!Number.isFinite(n) || n < 0) return;
              setDraft((d) => ({ ...d, overtop_depth_ft: n }));
            }}
          />
        </div>
      ) : null}

      <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
        <button
          type="button"
          className="btn secondary"
          style={{ flex: 1 }}
          onClick={() => setStep('access')}
        >
          Back
        </button>
        <button
          type="button"
          className="btn"
          style={{ flex: 1 }}
          disabled={!overtopDepthValid}
          onClick={() => setStep('damage')}
        >
          Continue
        </button>
      </div>
    </div>
  );

  const renderDamage = () => (
    <>
      <div className="card">
        <Segmented<YesNo>
          label="Damage to rail"
          options={[
            { value: 'yes', label: 'Yes' },
            { value: 'no', label: 'No' },
          ]}
          value={draft.damage_rail}
          onChange={(v) => setYesNo('damage_rail', v)}
        />
        <Segmented<YesNo>
          label="Damage to deck"
          options={[
            { value: 'yes', label: 'Yes' },
            { value: 'no', label: 'No' },
          ]}
          value={draft.damage_deck}
          onChange={(v) => setYesNo('damage_deck', v)}
        />
        <Segmented<YesNo>
          label="Damage to superstructure"
          options={[
            { value: 'yes', label: 'Yes' },
            { value: 'no', label: 'No' },
          ]}
          value={draft.damage_super}
          onChange={(v) => setYesNo('damage_super', v)}
        />
        <Segmented<YesNo>
          label="Damage to substructure"
          options={[
            { value: 'yes', label: 'Yes' },
            { value: 'no', label: 'No' },
          ]}
          value={draft.damage_sub}
          onChange={(v) => setYesNo('damage_sub', v)}
        />
        <Segmented<YesNo>
          label="Approach washout behind abutments"
          options={[
            { value: 'yes', label: 'Yes' },
            { value: 'no', label: 'No' },
          ]}
          value={draft.washout_abutment}
          onChange={(v) => setYesNo('washout_abutment', v)}
        />
      </div>
      <div className="card" style={{ display: 'flex', gap: 8 }}>
        <button
          type="button"
          className="btn secondary"
          style={{ flex: 1 }}
          onClick={() => setStep('overtopped')}
        >
          Back
        </button>
        <button
          type="button"
          className="btn"
          style={{ flex: 1 }}
          onClick={() => setStep('photos')}
        >
          Continue
        </button>
      </div>
    </>
  );

  const renderPhotos = () => (
    <>
      <PhotoSection
        photos={draft.photos}
        onCapture={onCapture}
        onRemove={onRemove}
        onDescribe={onDescribe}
        busy={busy}
        destroyedMode={false}
        damageFlags={damageFlags}
      />
      <div className="card" style={{ display: 'flex', gap: 8 }}>
        <button
          type="button"
          className="btn secondary"
          style={{ flex: 1 }}
          onClick={() => setStep('damage')}
        >
          Back
        </button>
        <button
          type="button"
          className="btn"
          style={{ flex: 1 }}
          onClick={() => setStep('decisions')}
        >
          Continue
        </button>
      </div>
    </>
  );

  const renderDecisions = () => (
    <>
      <div className="card">
        <ChoiceList<OpenStatus>
          label="Can the bridge remain open?"
          options={[
            { value: 'yes', label: 'Yes' },
            { value: 'no', label: 'No' },
            { value: 'restricted_lanes', label: 'Restricted lane access' },
          ]}
          value={draft.remain_open}
          onChange={(v) => setDraft((d) => ({ ...d, remain_open: v }))}
        />
        <div className="field">
          <label className="field-label" htmlFor="open-notes">
            Notes
          </label>
          <textarea
            id="open-notes"
            rows={3}
            value={draft.remain_open_notes ?? ''}
            onChange={(e) =>
              setDraft((d) => ({ ...d, remain_open_notes: e.target.value }))
            }
          />
        </div>
      </div>

      <div className="card">
        <ChoiceList<LoadStatus>
          label="Is it safe to carry load?"
          options={[
            { value: 'yes', label: 'Yes' },
            { value: 'no', label: 'No' },
            { value: 'reduced_load', label: 'Reduced load' },
          ]}
          value={draft.safe_load}
          onChange={(v) => setDraft((d) => ({ ...d, safe_load: v }))}
        />
        <div className="field">
          <label className="field-label" htmlFor="load-notes">
            Notes
          </label>
          <textarea
            id="load-notes"
            rows={3}
            value={draft.safe_load_notes ?? ''}
            onChange={(e) =>
              setDraft((d) => ({ ...d, safe_load_notes: e.target.value }))
            }
          />
        </div>
      </div>

      <div className="card">
        <ChoiceList<DebrisAmount>
          label="Debris at bridge"
          options={[
            { value: 'none', label: 'None' },
            { value: 'half_truck', label: '0.5 truckload' },
            { value: 'one_truck', label: '1 truckload' },
            { value: 'multiple', label: 'Multiple truckloads' },
            { value: 'six_plus', label: '6+ truckloads' },
          ]}
          value={draft.debris_amount}
          onChange={(v) => setDraft((d) => ({ ...d, debris_amount: v }))}
        />
      </div>

      <div className="card" style={{ display: 'flex', gap: 8 }}>
        <button
          type="button"
          className="btn secondary"
          style={{ flex: 1 }}
          onClick={() => setStep('photos')}
        >
          Back
        </button>
        <button
          type="button"
          className="btn"
          style={{ flex: 1 }}
          onClick={() => setStep('review')}
        >
          Continue to review
        </button>
      </div>
    </>
  );

  const renderReview = () => {
    const overtopLine =
      draft.overtopped === 'yes'
        ? `Yes — max ${typeof draft.overtop_depth_ft === 'number' ? draft.overtop_depth_ft : '—'} ft`
        : draft.overtopped === 'no'
          ? 'No'
          : '—';

    return (
      <>
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
            <div>Triage outcome: complete</div>
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
        <div className="card" style={{ display: 'flex', gap: 8 }}>
          <button
            type="button"
            className="btn secondary"
            style={{ flex: 1 }}
            onClick={() => setStep('decisions')}
          >
            Back
          </button>
          <button
            type="button"
            className="btn"
            style={{ flex: 1 }}
            onClick={() => finish('complete')}
          >
            Save inspection
          </button>
        </div>
      </>
    );
  };

  const renderStep = () => {
    switch (step) {
      case 'destroyed':
        return renderDestroyed();
      case 'destroyed_photos':
        return renderDestroyedPhotos();
      case 'access':
        return renderAccess();
      case 'drone':
        return renderDrone();
      case 'revisit_note':
        return renderRevisitNote();
      case 'still_there':
        return renderStillThere();
      case 'overtopped':
        return renderOvertopped();
      case 'damage':
        return renderDamage();
      case 'photos':
        return renderPhotos();
      case 'decisions':
        return renderDecisions();
      case 'review':
        return renderReview();
      default:
        return renderDestroyed();
    }
  };

  // 'likely_destroyed' confirmation is not a real STEP_ORDER entry, but
  // we render it directly if the user arrives from 'still_there' with No.
  // Handled by intercepting via a local pseudo-step.
  const [pseudo, setPseudo] = useState<'likely_destroyed' | null>(null);
  // Intercept setStep('review_likely_destroyed') by mapping it here.
  useEffect(() => {
    if ((step as string) === 'review_likely_destroyed') {
      setPseudo('likely_destroyed');
      setStep('still_there');
    }
  }, [step]);

  return (
    <div className="screen">
      <BridgeHeader bridge={bridge} />
      {gpsBanner ? (
        <div className="warn-box">
          GPS differs from NBI coordinates by &gt;100 m — verify this is the
          correct bridge.
        </div>
      ) : null}
      {pseudo === 'likely_destroyed' ? (
        <>
          <ProgressDots step="still_there" />
          {renderLikelyDestroyedConfirm()}
        </>
      ) : (
        <>
          <ProgressDots step={step} />
          {renderStep()}
        </>
      )}
      <div className="card" style={{ display: 'flex', gap: 8 }}>
        <button
          type="button"
          className="btn secondary"
          style={{ flex: 1 }}
          onClick={onCancel}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
