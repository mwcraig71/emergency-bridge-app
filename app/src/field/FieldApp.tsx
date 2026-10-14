import React, { useCallback, useEffect, useMemo, useState } from 'react';
import BridgeLookup from './BridgeLookup';
import TriageFlow from './TriageFlow';
import RoadblockReport from './RoadblockReport';
import DirectionsView from './DirectionsView';
import TeamMap from '../components/TeamMap';
import Icon from '../components/Icon';
import type { Bridge, InspectionDraft, ActiveSession, Assignment, AppNotification } from '../types';
import { idbGetAll, idbPut, idbGet, idbDelete } from '../lib/idb';
import {
  newSessionId,
  markSessionLive,
  markSessionEnded,
  isLiveSession,
  isSameSession,
} from '../lib/crashSession';
import { pushQueue, pendingCount, pendingPhotos, clearQueue } from '../lib/sync';
import { syncRoadblocks } from '../lib/roadblocks';
import { startPositionBroadcast, stopPositionBroadcast } from '../lib/teamPositions';
import {
  syncAssignments,
  syncNotifications,
  getMyAssignments,
  getAllAssignments,
  getAssignmentForBridge,
  unreadNotificationCount,
  markAssignmentInProgress,
  markNotificationRead,
  assignToSelf,
} from '../lib/assignments';
import {
  inspectionsToGeoJSON,
  inspectionsToCsv,
  downloadFile,
} from '../lib/export';
import {
  startTracking,
  stopTracking,
  pauseTracking,
  resumeTracking,
  isTracking,
  isPaused,
  getActiveTrackElapsed,
  getActiveTrackDistance,
} from '../lib/track';

type Tab = 'inspect' | 'map' | 'closure' | 'sync';

interface FieldAppProps {
  /**
   * Inspector name from the login session. When provided it is used
   * directly and the free-text name input is hidden (no editing).
   * When absent, the legacy free-text behavior applies.
   */
  inspectorName?: string;
}

const FieldApp: React.FC<FieldAppProps> = ({ inspectorName: sessionName }) => {
  const [tab, setTab] = useState<Tab>('inspect');
  // Session-locked name: sign-in via the login screen, not editable here.
  const lockedName = (sessionName ?? '').trim();
  const [inspectorName, setInspectorName] = useState<string>(lockedName);
  const [nameLoaded, setNameLoaded] = useState(false);
  const [activeBridge, setActiveBridge] = useState<Bridge | null>(null);
  const [resumeDraft, setResumeDraft] = useState<InspectionDraft | null>(null);
  const [drafts, setDrafts] = useState<InspectionDraft[]>([]);
  const [pending, setPending] = useState<number>(0);
  const [pendingPhotosCount, setPendingPhotosCount] = useState<number>(0);
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<string | null>(null);
  const [directionsBridge, setDirectionsBridge] = useState<Bridge | null>(null);
  const [nameHint, setNameHint] = useState(false);
  // Crash-resume: session marker + matching in-progress draft found on startup
  const [crashSession, setCrashSession] = useState<{
    session: ActiveSession;
    draft: InspectionDraft;
  } | null>(null);
  // Step to restore TriageFlow to on resume (from the session marker).
  const [resumeStep, setResumeStep] = useState<string | undefined>(undefined);
  // Team assignments + notifications
  const [myAssignments, setMyAssignments] = useState<Assignment[]>([]);
  const [notifications, setNotifications] = useState<AppNotification[]>([]);
  const [unreadCount, setUnreadCount] = useState<number>(0);
  // True when no inspector name is known yet and the assignments list is
  // showing EVERYTHING (fallback) instead of just the user's own.
  const [showingAllAssignments, setShowingAllAssignments] = useState(false);
  const [crossAssignBridge, setCrossAssignBridge] = useState<{
    bridge: Bridge;
    assignedTo: string;
  } | null>(null);
  // GPS track recording (onX breadcrumbs)
  const [trackActive, setTrackActive] = useState(false);
  const [trackPaused, setTrackPaused] = useState(false);
  const [trackElapsed, setTrackElapsed] = useState('');
  const [trackDistance, setTrackDistance] = useState('');

  // Auto-start GPS track recording once the inspector name is known.
  useEffect(() => {
    if (!nameLoaded || !inspectorName.trim()) return;
    let cancelled = false;
    void startTracking(inspectorName.trim()).then(() => {
      if (!cancelled) {
        setTrackActive(isTracking());
        setTrackPaused(isPaused());
      }
    });
    // Live team position sharing (30s cadence, 10m threshold, pauses in
    // background). No-op until the inspector name is set.
    void startPositionBroadcast();
    return () => {
      cancelled = true;
      stopPositionBroadcast();
    };
  }, [nameLoaded, inspectorName]);

  // Live elapsed-time / distance readout for the recording pill.
  useEffect(() => {
    if (!trackActive) return;
    const fmtElapsed = (ms: number): string => {
      const s = Math.floor(ms / 1000);
      const h = Math.floor(s / 3600);
      const m = Math.floor((s % 3600) / 60);
      return h > 0 ? `${h}h ${m}m` : `${m}m`;
    };
    const fmtDist = (m: number): string =>
      m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`;
    let cancelled = false;
    const tick = async () => {
      try {
        const [ms, dist] = await Promise.all([
          getActiveTrackElapsed(),
          getActiveTrackDistance(),
        ]);
        if (!cancelled) {
          setTrackElapsed(fmtElapsed(ms));
          setTrackDistance(fmtDist(dist));
        }
      } catch {
        // ignore
      }
    };
    void tick();
    const id = window.setInterval(tick, 30_000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [trackActive]);

  const handleToggleTrackPause = useCallback(() => {
    if (isPaused()) {
      resumeTracking();
      setTrackPaused(false);
    } else {
      pauseTracking();
      setTrackPaused(true);
    }
  }, []);

  const refreshDrafts = useCallback(async () => {
    try {
      const all = (await idbGetAll('drafts')) as InspectionDraft[];
      setDrafts(all ?? []);
    } catch {
      setDrafts([]);
    }
    try {
      const p = await pendingCount();
      setPending(typeof p === 'number' ? p : 0);
    } catch {
      setPending(0);
    }
    try {
      const pp = await pendingPhotos();
      setPendingPhotosCount(typeof pp === 'number' ? pp : 0);
    } catch {
      setPendingPhotosCount(0);
    }
  }, []);

  const refreshAssignments = useCallback(async (name: string) => {
    const trimmed = name.trim();
    if (!trimmed) {
      // No name known (e.g. an admin opened the field app without ever
      // setting a Settings name): show ALL assignments rather than an
      // empty list that looks like there is no work assigned.
      try {
        setMyAssignments(await getAllAssignments());
        setShowingAllAssignments(true);
      } catch {
        setMyAssignments([]);
        setShowingAllAssignments(false);
      }
      setNotifications([]);
      setUnreadCount(0);
      return;
    }
    setShowingAllAssignments(false);
    try {
      setMyAssignments(await getMyAssignments(trimmed));
    } catch {
      setMyAssignments([]);
    }
    try {
      const all = (await idbGetAll<AppNotification>(
        'notifications',
      )) as AppNotification[];
      const mine = (all ?? [])
        .filter(
          (n) => n.recipient.trim().toLowerCase() === trimmed.toLowerCase(),
        )
        .sort((a, b) => b.created_at.localeCompare(a.created_at));
      setNotifications(mine);
      setUnreadCount(mine.filter((n) => !n.read_at).length);
    } catch {
      setNotifications([]);
      setUnreadCount(0);
    }
  }, []);

  // Asset IDs for the map's assignment filter (NBI = background data).
  const assignedAssetIds = useMemo(
    () => myAssignments.map((a) => a.asset_id),
    [myAssignments],
  );

  // Brief confirmation after "Add to my list" from the map.
  const [assignConfirm, setAssignConfirm] = useState<string | null>(null);
  const assignConfirmTimer = React.useRef<number | null>(null);

  const handleAssignToSelf = useCallback(
    async (bridge: Bridge) => {
      const name = inspectorName.trim();
      if (!name) {
        setTab('sync');
        return;
      }
      try {
        await assignToSelf(bridge.asset_id, name);
      } catch {
        // assignToSelf is best-effort and never throws; defensive.
      }
      await refreshAssignments(name);
      if (assignConfirmTimer.current) {
        window.clearTimeout(assignConfirmTimer.current);
      }
      setAssignConfirm(`Added ${bridge.asset_id} to your list`);
      assignConfirmTimer.current = window.setTimeout(
        () => setAssignConfirm(null),
        3500,
      );
    },
    [inspectorName, refreshAssignments],
  );

  useEffect(() => {
    let cancelled = false;
    if (lockedName) {
      // Signed in via the login screen: name is fixed, skip the cached lookup.
      setInspectorName(lockedName);
      setNameLoaded(true);
      return () => {
        cancelled = true;
      };
    }
    (async () => {
      try {
        const rec = (await idbGet('settings', 'inspector_name')) as
          | { value?: string }
          | string
          | null;
        let val = '';
        if (rec && typeof rec === 'object' && 'value' in rec) {
          val = String(rec.value ?? '');
        } else if (typeof rec === 'string') {
          val = rec;
        }
        if (!cancelled) {
          setInspectorName(val);
          setNameLoaded(true);
        }
      } catch {
        if (!cancelled) setNameLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [lockedName]);

  useEffect(() => {
    void refreshDrafts();
  }, [refreshDrafts]);

  useEffect(() => {
    if (nameLoaded) void refreshAssignments(inspectorName);
  }, [nameLoaded, inspectorName, refreshAssignments]);

  // --- Crash-resilience: active session tracking ---

  const saveActiveSession = useCallback(async (bridge: Bridge) => {
    // Never create a marker without an asset_id — a blank id would poison
    // the crash-resume check. Guard before claiming the session id.
    if (!bridge.asset_id || !bridge.asset_id.trim()) return;
    // Claim the session id SYNCHRONOUSLY (before the first await) so the
    // startup resume-check — which may still be in flight — can never treat
    // this new marker as stale. Works even for fire-and-forget callers.
    const sessionId = newSessionId();
    markSessionLive(sessionId);
    const now = new Date().toISOString();
    const session: ActiveSession = {
      key: 'active_session',
      session_id: sessionId,
      asset_id: bridge.asset_id,
      bridge_info: bridge,
      started_at: now,
      last_active: now,
    };
    try {
      await idbPut('settings', session);
    } catch {
      // ignore persistence failures
    }
  }, []);

  const clearActiveSession = useCallback(async () => {
    // Release ownership synchronously so an in-flight heartbeat can't
    // resurrect the marker it is about to delete.
    markSessionEnded();
    try {
      await idbDelete('settings', 'active_session');
    } catch {
      // ignore
    }
    setCrashSession(null);
  }, []);

  // On startup: check for an interrupted inspection session. If the
  // session's draft still exists and is in progress, offer to resume.
  // Otherwise silently clear the stale marker.
  //
  // Race note: this check is async and can interleave with a session the
  // user just started (its marker write may land before or after our reads).
  // Two guards keep our own startup from killing the new live marker:
  //  1. If the stored marker is this instance's live session, bail out —
  //     never banner it, never delete it.
  //  2. Before the stale-marker delete, re-read and only delete the exact
  //     session we inspected. The fixed 'active_session' key means an
  //     unconditional delete could otherwise wipe a newer session.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const session = (await idbGet<ActiveSession>(
          'settings',
          'active_session'
        )) as ActiveSession | undefined;
        if (!session) return;
        if (isLiveSession(session.session_id)) return;
        if (!session.asset_id || !session.asset_id.trim()) {
          // Poisoned marker (blank asset_id) — discard it, but only if the
          // marker is still the session we read above (startup race guard).
          const current = (await idbGet<ActiveSession>(
            'settings',
            'active_session'
          )) as ActiveSession | undefined;
          if (cancelled) return;
          if (isLiveSession(current?.session_id)) return;
          if (isSameSession(current, session)) {
            await idbDelete('settings', 'active_session');
          }
          return;
        }
        const all = (await idbGetAll<InspectionDraft>('drafts')) ?? [];
        const draft = all.find(
          (d) =>
            d.asset_id === session.asset_id &&
            d.triage_list === 'in_progress'
        );
        if (cancelled) return;
        if (draft) {
          setCrashSession({ session, draft });
        } else {
          // Stale: draft gone or already completed — clear silently, but only
          // if the marker is still the session we read above.
          const current = (await idbGet<ActiveSession>(
            'settings',
            'active_session'
          )) as ActiveSession | undefined;
          if (cancelled) return;
          if (isLiveSession(current?.session_id)) return;
          if (isSameSession(current, session)) {
            await idbDelete('settings', 'active_session');
          }
        }
      } catch {
        // ignore
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const persistName = useCallback(async (value: string) => {
    try {
      await idbPut('settings', { key: 'inspector_name', value });
    } catch {
      // ignore persistence failures
    }
  }, []);

  const handleNameChange = (value: string) => {
    if (lockedName) return; // name is fixed by the login session
    setInspectorName(value);
    if (value.trim()) setNameHint(false);
    void persistName(value);
  };

  const requireName = (): boolean => {
    if (!inspectorName.trim()) {
      setNameHint(true);
      // Land the user on the name field (Sync tab → Settings card) instead
      // of silently swallowing the tap they just made.
      setTab('sync');
      return false;
    }
    return true;
  };

  const handleSelectBridge = async (bridge: Bridge) => {
    if (!requireName()) return;
    // Cross-assignment check: warn if this bridge belongs to someone else.
    try {
      const asg = await getAssignmentForBridge(bridge.asset_id);
      if (
        asg &&
        asg.status !== 'complete' &&
        asg.assigned_to.trim().toLowerCase() !==
          inspectorName.trim().toLowerCase()
      ) {
        setCrossAssignBridge({ bridge, assignedTo: asg.assigned_to });
        return;
      }
    } catch {
      // Assignment lookup failure must not block the inspection flow.
    }
    startInspection(bridge);
  };

  const startInspection = (bridge: Bridge) => {
    setResumeDraft(null);
    setActiveBridge(bridge);
    setCrashSession(null);
    setTab('inspect');
    void saveActiveSession(bridge);
    void markAssignmentInProgress(bridge.asset_id, inspectorName).then(() =>
      refreshAssignments(inspectorName),
    );
  };

  const confirmCrossAssign = () => {
    if (!crossAssignBridge) return;
    const b = crossAssignBridge.bridge;
    setCrossAssignBridge(null);
    startInspection(b);
  };

  const handleResumeDraft = (draft: InspectionDraft) => {
    if (!requireName()) return;
    const bridge =
      (draft as unknown as { bridge?: Bridge }).bridge ??
      ({
        asset_id:
          (draft as unknown as { asset_id?: string }).asset_id ??
          (draft as unknown as { assetId?: string }).assetId ??
          '',
        struct_no:
          (draft as unknown as { struct_no?: string }).struct_no ?? '',
      } as unknown as Bridge);
    setActiveBridge(bridge);
    setResumeDraft(draft);
    // Carry the stored step through crash-resume (TriageFlow sanitizes it);
    // unconditional set so a stale step can never leak from a previous resume.
    setResumeStep(crashSession?.session.step ? crashSession.session.step : undefined);
    setCrashSession(null);
    setTab('inspect');
    void saveActiveSession(bridge);
  };

  const handleTriageDone = async () => {
    setActiveBridge(null);
    setResumeDraft(null);
    setResumeStep(undefined);
    await clearActiveSession();
    await refreshDrafts();
    setTab('inspect');
  };

  const handleTriageCancel = () => {
    setActiveBridge(null);
    setResumeDraft(null);
    setResumeStep(undefined);
    void clearActiveSession();
  };

  const handleSyncNow = async () => {
    setSyncing(true);
    setSyncResult(null);
    try {
      const result = await pushQueue();
      // Team data: assignments + notifications (best effort).
      try {
        await syncAssignments();
        if (inspectorName.trim()) {
          await syncNotifications(inspectorName.trim());
        }
        await refreshAssignments(inspectorName);
      } catch {
        // Team sync failure must not mask the main sync result.
      }
      // Roadblocks: pull latest closures for offline map display (best effort).
      try {
        await syncRoadblocks();
      } catch {
        // Roadblock sync failure must not mask the main sync result.
      }
      setSyncResult(
        result.failed > 0
          ? `Sync: ${result.pushed} pushed, ${result.failed} failed.\n${result.errors.join('\n')}`
          : result.pushed > 0
            ? `Sync complete: ${result.pushed} pushed.`
            : 'Sync complete. Nothing to push.'
      );
    } catch (err) {
      const msg =
        err instanceof Error
          ? err.message
          : err && typeof err === 'object' && 'message' in err
            ? String((err as { message: unknown }).message)
            : JSON.stringify(err);
      setSyncResult(`Sync failed: ${msg}`);
    } finally {
      setSyncing(false);
      await refreshDrafts();
    }
  };

  const handleExportGeoJSON = () => {
    try {
      const geojson = inspectionsToGeoJSON(drafts);
      downloadFile(
        `inspections-${new Date().toISOString().slice(0, 10)}.geojson`,
        typeof geojson === 'string' ? geojson : JSON.stringify(geojson)
      );
    } catch (err) {
      setSyncResult(
        `Export failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  };

  const handleExportCsv = () => {
    try {
      const csv = inspectionsToCsv(drafts);
      downloadFile(
        `inspections-${new Date().toISOString().slice(0, 10)}.csv`,
        typeof csv === 'string' ? csv : String(csv)
      );
    } catch (err) {
      setSyncResult(
        `Export failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  };

  const draftRows = useMemo(() => {
    return drafts.map((d, idx) => {
      const anyD = d as unknown as {
        asset_id?: string;
        assetId?: string;
        struct_no?: string;
        triage?: string;
        triage_status?: string;
        status?: string;
        bridge?: Bridge;
      };
      const assetId =
        anyD.asset_id ?? anyD.assetId ?? anyD.struct_no ?? `draft-${idx}`;
      const triage =
        anyD.triage ?? anyD.triage_status ?? anyD.status ?? 'UNKNOWN';
      return { key: `${assetId}-${idx}`, assetId, triage, raw: d };
    });
  }, [drafts]);

  const triagePillColor = (triage: string): string => {
    const t = triage.toUpperCase();
    if (t.includes('PASS') || t === 'GREEN' || t === 'OK') return '#2E7D32';
    if (t.includes('MONITOR') || t === 'YELLOW') return '#C9A227';
    if (t.includes('FAIL') || t === 'RED' || t.includes('CLOS'))
      return '#7A1F08';
    return '#5A5A5A';
  };

  const assignmentPillColor = (status: Assignment['status']): string => {
    if (status === 'complete') return '#2E7D32';
    if (status === 'in_progress') return '#C9A227';
    return '#001A52';
  };

  /** Tap a row in "My bridges": resolve the bridge record, then inspect. */
  const selectAssignedBridge = async (a: Assignment) => {
    if (!requireName()) return;
    try {
      const bridge = await idbGet<Bridge>('bridges', a.asset_id);
      if (bridge) {
        await handleSelectBridge(bridge);
      } else {
        setSyncResult(
          `Bridge ${a.asset_id} is not in the local inventory cache. Download the bridge inventory from the Sync tab first.`,
        );
        setTab('sync');
      }
    } catch {
      setSyncResult(`Could not load bridge ${a.asset_id} from cache.`);
      setTab('sync');
    }
  };

  const renderInspect = () => {
    if (activeBridge) {
      return (
        <TriageFlow
          bridge={activeBridge}
          inspectorName={inspectorName}
          existingDraft={resumeDraft ?? undefined}
          initialStep={resumeStep}
          onDone={() => void handleTriageDone()}
          onCancel={handleTriageCancel}
        />
      );
    }
    return (
      <div>
        {crashSession && (
          <div
            className="card"
            role="alert"
            style={{
              background: '#FBE7DF',
              border: '2px solid #CF3910',
              marginBottom: 12,
            }}
          >
            <div style={{ fontWeight: 700, marginBottom: 4 }}>
              You were inspecting {crashSession.session.asset_id}
            </div>
            <div className="muted" style={{ marginBottom: 12 }}>
              The app closed before this inspection was finished. Pick up
              where you left off.
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                className="btn"
                onClick={() => handleResumeDraft(crashSession.draft)}
                style={{
                  flex: 1,
                  minHeight: 52,
                  fontWeight: 700,
                  fontSize: 16,
                  background: '#CF3910',
                  color: '#fff',
                }}
              >
                Resume
              </button>
              <button
                className="btn"
                onClick={() => void clearActiveSession()}
                style={{ flex: 1, minHeight: 52, fontSize: 16 }}
              >
                Dismiss
              </button>
            </div>
          </div>
        )}
        {nameHint && (
          <div
            className="card"
            role="alert"
            style={{ color: '#7A1F08', fontWeight: 600 }}
          >
            Enter your inspector name before starting an inspection.
          </div>
        )}
        <BridgeLookup onSelect={handleSelectBridge} />
        <div className="card">
          <h3 style={{ marginTop: 0 }}>
            My bridges
            {myAssignments.length > 0 && (
              <span className="muted" style={{ fontWeight: 400 }}>
                {' '}
                ({myAssignments.filter((a) => a.status !== 'complete').length}{' '}
                open)
              </span>
            )}
          </h3>
          {showingAllAssignments && (
            <div
              role="note"
              style={{
                background: '#FFF4E5',
                border: '1px solid #C9A227',
                borderRadius: 2,
                padding: '10px 12px',
                marginBottom: 12,
                fontWeight: 600,
                color: '#5C4300',
              }}
            >
              <div style={{ marginBottom: 8 }}>
                Showing all assignments — set your name to see only yours.
              </div>
              <button
                type="button"
                className="btn"
                onClick={() => setTab('sync')}
                style={{
                  minHeight: 44,
                  fontWeight: 700,
                  background: '#001A52',
                  color: '#fff',
                }}
              >
                Set your name
              </button>
            </div>
          )}
          {myAssignments.length === 0 && (
            <div className="muted">
              No bridges assigned to you yet. Sync to download your
              assignments.
            </div>
          )}
          {myAssignments.length > 0 && (
            <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
              {myAssignments.map((a) => (
                <li key={a.asset_id} style={{ marginBottom: 8 }}>
                  <button
                    className="btn"
                    onClick={() => void selectAssignedBridge(a)}
                    disabled={a.status === 'complete'}
                    style={{
                      width: '100%',
                      minHeight: 56,
                      textAlign: 'left',
                      display: 'flex',
                      alignItems: 'center',
                      gap: 10,
                      padding: 12,
                      opacity: a.status === 'complete' ? 0.6 : 1,
                    }}
                  >
                    <span
                      style={{
                        background: assignmentPillColor(a.status),
                        color: '#fff',
                        borderRadius: 2,
                        padding: '2px 10px',
                        fontSize: 12,
                        fontWeight: 700,
                        textTransform: 'uppercase',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {a.status.replace('_', ' ')}
                    </span>
                    <span style={{ fontWeight: 600 }}>{a.asset_id}</span>
                    {showingAllAssignments && a.assigned_to && (
                      <span className="muted" style={{ fontSize: 12 }}>
                        {a.assigned_to}
                      </span>
                    )}
                    {a.status === 'complete' && a.completed_by && (
                      <span className="muted" style={{ fontSize: 12 }}>
                        by {a.completed_by}
                      </span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="card">
          <h3 style={{ marginTop: 0 }}>My drafts / pending</h3>
          {draftRows.length === 0 && (
            <div className="muted">No drafts yet.</div>
          )}
          {draftRows.length > 0 && (
            <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
              {draftRows.map((row) => (
                <li
                  key={row.key}
                  style={{
                    display: 'flex',
                    alignItems: 'stretch',
                    gap: 8,
                    marginBottom: 8,
                  }}
                >
                  <button
                    className="btn"
                    onClick={() => handleResumeDraft(row.raw)}
                    style={{
                      flex: 1,
                      minHeight: 56,
                      textAlign: 'left',
                      display: 'flex',
                      alignItems: 'center',
                      gap: 10,
                      padding: 12,
                    }}
                  >
                    <span
                      style={{
                        background: triagePillColor(row.triage),
                        color: '#fff',
                        borderRadius: 2,
                        padding: '2px 10px',
                        fontSize: 12,
                        fontWeight: 700,
                        textTransform: 'uppercase',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {row.triage}
                    </span>
                    <span style={{ fontWeight: 600 }}>{row.assetId}</span>
                  </button>
                  <button
                    className="btn"
                    aria-label={`Directions to ${row.assetId}`}
                    onClick={() => {
                      const b =
                        (row.raw as unknown as { bridge?: Bridge }).bridge ??
                        ({
                          asset_id: row.assetId,
                          struct_no: row.assetId,
                        } as unknown as Bridge);
                      setDirectionsBridge(b);
                    }}
                    style={{
                      minHeight: 56,
                      minWidth: 56,
                      padding: 12,
                      fontSize: 20,
                    }}
                  >
                    <Icon name="navigation" size={22} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    );
  };

  const renderMap = () => (
    <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 64, zIndex: 1 }}>
      <TeamMap
        showTeam
        showLocate
        showOfflineDownload
        height="100%"
        assignedAssetIds={assignedAssetIds}
        onAssignToSelf={handleAssignToSelf}
        onStartInspection={handleSelectBridge}
        onGetDirections={(b) => setDirectionsBridge(b)}
      />
      {assignConfirm && (
        <div
          role="status"
          className="toast"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
          }}
        >
          <Icon name="check" size={16} />
          {assignConfirm}
        </div>
      )}
    </div>
  );

  const renderClosure = () => (
    <RoadblockReport
      inspectorName={inspectorName}
      onDone={() => {
        void refreshDrafts();
        setTab('inspect');
      }}
    />
  );

  const renderSync = () => (
    <div className="screen">
      <div className="card">
        <h3 style={{ marginTop: 0 }}>Settings</h3>
        {lockedName ? (
          <div className="muted" style={{ fontSize: 16 }}>
            Signed in as <strong style={{ color: '#111' }}>{lockedName}</strong>
            <br />
            Switch users from the Sign out button above.
          </div>
        ) : (
          <>
            <label
              htmlFor="inspector-name"
              style={{ display: 'block', fontWeight: 600, marginBottom: 6 }}
            >
              Inspector name
            </label>
            <input
              id="inspector-name"
              className="field"
              type="text"
              value={inspectorName}
              onChange={(e) => handleNameChange(e.target.value)}
              placeholder="Your name"
              autoComplete="name"
              disabled={!nameLoaded}
              style={{ minHeight: 48, fontSize: 18, width: '100%' }}
            />
            {nameHint && (
              <div
                role="alert"
                style={{ marginTop: 8, color: '#7A1F08', fontWeight: 600 }}
              >
                Name required before inspecting.
              </div>
            )}
          </>
        )}
      </div>
      <div className="card">
        <h3 style={{ marginTop: 0 }}>Sync</h3>
        <div className="muted" style={{ marginBottom: 12 }}>
          {pending} item{pending === 1 ? '' : 's'} pending
          {pendingPhotosCount > 0 && (
            <>
              {' '}· {pendingPhotosCount} photo
              {pendingPhotosCount === 1 ? '' : 's'} awaiting upload
            </>
          )}
        </div>
        <button
          className="btn"
          onClick={() => void handleSyncNow()}
          disabled={syncing}
          style={{ minHeight: 56, width: '100%', fontSize: 18 }}
        >
          {syncing ? 'Syncing…' : 'Sync now'}
        </button>
        {syncResult && (
          <div className="muted" style={{ marginTop: 12, whiteSpace: 'pre-wrap' }}>
            {syncResult}
          </div>
        )}
        {pending > 0 && (
          <button
            className="btn danger"
            type="button"
            onClick={async () => {
              if (window.confirm(`Clear ${pending} queued item(s)? This cannot be undone.`)) {
                await clearQueue();
                setPending(0);
                setSyncResult('Queue cleared.');
              }
            }}
            style={{ marginTop: 8 }}
          >
            Clear sync queue ({pending})
          </button>
        )}
      </div>
      <div className="card">
        <h3 style={{ marginTop: 0 }}>
          Notifications
          {unreadCount > 0 && (
            <span
              style={{
                background: '#7A1F08',
                color: '#fff',
                borderRadius: 2,
                padding: '2px 10px',
                fontSize: 12,
                fontWeight: 700,
                marginLeft: 8,
              }}
            >
              {unreadCount} new
            </span>
          )}
        </h3>
        {notifications.length === 0 && (
          <div className="muted">No notifications.</div>
        )}
        {notifications.length > 0 && (
          <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
            {notifications.slice(0, 20).map((n) => (
              <li
                key={n.id}
                style={{
                  padding: '10px 12px',
                  marginBottom: 8,
                  border: '1px solid #ddd',
                  borderRadius: 8,
                  background: n.read_at ? '#fff' : '#FBE7DF',
                }}
                onClick={() => {
                  void markNotificationRead(n.id).then(() =>
                    refreshAssignments(inspectorName),
                  );
                }}
              >
                <div style={{ fontWeight: 700, fontSize: 14 }}>{n.title}</div>
                <div className="muted" style={{ fontSize: 13 }}>
                  {n.message}
                </div>
                <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>
                  {n.created_at
                    ? new Date(n.created_at).toLocaleString()
                    : ''}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="card">
        <h3 style={{ marginTop: 0 }}>Export</h3>
        <button
          className="btn"
          onClick={handleExportGeoJSON}
          disabled={drafts.length === 0}
          style={{ minHeight: 56, width: '100%', fontSize: 18, marginBottom: 12 }}
        >
          Export GeoJSON
        </button>
        <button
          className="btn"
          onClick={handleExportCsv}
          disabled={drafts.length === 0}
          style={{ minHeight: 56, width: '100%', fontSize: 18 }}
        >
          Export CSV
        </button>
      </div>
    </div>
  );

  return (
    <div style={{ minHeight: '100vh', paddingBottom: 80 }}>
      {tab === 'inspect' && renderInspect()}
      {tab === 'map' && renderMap()}
      {tab === 'closure' && renderClosure()}
      {tab === 'sync' && renderSync()}

      {directionsBridge && (
        <div
          role="dialog"
          aria-modal="true"
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.4)',
            zIndex: 100,
            display: 'flex',
            alignItems: 'flex-end',
          }}
        >
          <div
            style={{
              background: '#fff',
              width: '100%',
              maxHeight: '85vh',
              overflowY: 'auto',
              borderTopLeftRadius: 16,
              borderTopRightRadius: 16,
              paddingBottom: 16,
            }}
          >
            <DirectionsView
              bridge={directionsBridge}
              onClose={() => setDirectionsBridge(null)}
            />
          </div>
        </div>
      )}

      {crossAssignBridge && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Cross-assignment confirmation"
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.4)',
            zIndex: 100,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 24,
          }}
        >
          <div
            className="card"
            style={{ maxWidth: 420, width: '100%', margin: 0 }}
          >
            <h3 style={{ marginTop: 0 }}>Inspect someone else's bridge?</h3>
            <p>
              Bridge <strong>{crossAssignBridge.bridge.asset_id}</strong> is
              assigned to <strong>{crossAssignBridge.assignedTo}</strong>.
            </p>
            <p className="muted">
              If you inspect it, {crossAssignBridge.assignedTo} will be
              notified that you completed their bridge.
            </p>
            <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
              <button
                className="btn"
                onClick={confirmCrossAssign}
                style={{
                  flex: 1,
                  minHeight: 52,
                  fontWeight: 700,
                  fontSize: 16,
                  background: '#001A52',
                  color: '#fff',
                }}
              >
                Inspect anyway
              </button>
              <button
                className="btn"
                onClick={() => setCrossAssignBridge(null)}
                style={{ flex: 1, minHeight: 52, fontSize: 16 }}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* GPS track recording indicator (onX breadcrumbs) */}
      {trackActive && (
        <button
          type="button"
          onClick={handleToggleTrackPause}
          aria-label={trackPaused ? 'Resume track recording' : 'Pause track recording'}
          style={{
            position: 'fixed',
            left: 12,
            bottom: 92,
            zIndex: 60,
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            background: '#001A52',
            color: '#fff',
            border: 'none',
            borderRadius: 20,
            padding: '8px 14px',
            fontSize: 13,
            fontWeight: 600,
            boxShadow: '0 2px 8px rgba(0,0,0,0.3)',
            minHeight: 40,
          }}
        >
          <span
            style={{
              width: 10,
              height: 10,
              borderRadius: '50%',
              background: trackPaused ? '#C9A227' : '#CF3910',
              flexShrink: 0,
            }}
          />
          <span>{trackPaused ? 'Paused' : 'Recording'}</span>
          {trackElapsed && <span style={{ opacity: 0.8 }}>{trackElapsed}</span>}
          {trackDistance && <span style={{ opacity: 0.8 }}>{trackDistance}</span>}
        </button>
      )}

      <nav className="field-tabbar" aria-label="Field app sections">        {(
          [
            ['inspect', 'Inspect', 'clipboard'],
            ['map', 'Map', 'map'],
            ['closure', 'Closure', 'alert'],
            ['sync', 'Sync', 'sync'],
          ] as [Tab, string, 'clipboard' | 'map' | 'alert' | 'sync'][]
        ).map(([key, label, icon]) => (
          <button
            key={key}
            className={tab === key ? 'active' : ''}
            onClick={() => {
              if (key !== 'inspect' && key !== 'sync' && key !== 'map') {
                if (!requireName()) return;
              }
              setTab(key);
            }}
            aria-current={tab === key ? 'page' : undefined}
          >
            <Icon name={icon} size={22} />
            <span>{label}</span>
            {key === 'sync' && pending > 0 && (
              <span className="tab-badge">{pending > 99 ? '99+' : pending}</span>
            )}
          </button>
        ))}
      </nav>
    </div>
  );
};

export default FieldApp;
