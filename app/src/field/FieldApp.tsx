import React, { useCallback, useEffect, useMemo, useState } from 'react';
import BridgeLookup from './BridgeLookup';
import TriageFlow from './TriageFlow';
import RoadblockReport from './RoadblockReport';
import DirectionsView from './DirectionsView';
import TeamMap from '../components/TeamMap';
import type { Bridge, InspectionDraft, ActiveSession, Assignment, AppNotification } from '../types';
import { idbGetAll, idbPut, idbGet, idbDelete } from '../lib/idb';
import { pushQueue, pendingCount, clearQueue } from '../lib/sync';
import {
  syncAssignments,
  syncNotifications,
  getMyAssignments,
  getAssignmentForBridge,
  unreadNotificationCount,
  markAssignmentInProgress,
  markNotificationRead,
} from '../lib/assignments';
import {
  inspectionsToGeoJSON,
  inspectionsToCsv,
  downloadFile,
} from '../lib/export';

type Tab = 'inspect' | 'map' | 'closure' | 'sync';

const FieldApp: React.FC = () => {
  const [tab, setTab] = useState<Tab>('inspect');
  const [inspectorName, setInspectorName] = useState<string>('');
  const [nameLoaded, setNameLoaded] = useState(false);
  const [activeBridge, setActiveBridge] = useState<Bridge | null>(null);
  const [resumeDraft, setResumeDraft] = useState<InspectionDraft | null>(null);
  const [drafts, setDrafts] = useState<InspectionDraft[]>([]);
  const [pending, setPending] = useState<number>(0);
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<string | null>(null);
  const [directionsBridge, setDirectionsBridge] = useState<Bridge | null>(null);
  const [nameHint, setNameHint] = useState(false);
  // Crash-resume: session marker + matching in-progress draft found on startup
  const [crashSession, setCrashSession] = useState<{
    session: ActiveSession;
    draft: InspectionDraft;
  } | null>(null);
  // Team assignments + notifications
  const [myAssignments, setMyAssignments] = useState<Assignment[]>([]);
  const [notifications, setNotifications] = useState<AppNotification[]>([]);
  const [unreadCount, setUnreadCount] = useState<number>(0);
  const [crossAssignBridge, setCrossAssignBridge] = useState<{
    bridge: Bridge;
    assignedTo: string;
  } | null>(null);

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
  }, []);

  const refreshAssignments = useCallback(async (name: string) => {
    const trimmed = name.trim();
    if (!trimmed) {
      setMyAssignments([]);
      setNotifications([]);
      setUnreadCount(0);
      return;
    }
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

  useEffect(() => {
    let cancelled = false;
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
  }, []);

  useEffect(() => {
    void refreshDrafts();
  }, [refreshDrafts]);

  useEffect(() => {
    if (nameLoaded) void refreshAssignments(inspectorName);
  }, [nameLoaded, inspectorName, refreshAssignments]);

  // --- Crash-resilience: active session tracking ---

  const saveActiveSession = useCallback(async (bridge: Bridge) => {
    const now = new Date().toISOString();
    const session: ActiveSession = {
      key: 'active_session',
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
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const session = (await idbGet<ActiveSession>(
          'settings',
          'active_session'
        )) as ActiveSession | undefined;
        if (!session || !session.asset_id) return;
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
          // Stale: draft gone or already completed — clear silently
          await idbDelete('settings', 'active_session');
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
    setInspectorName(value);
    if (value.trim()) setNameHint(false);
    void persistName(value);
  };

  const requireName = (): boolean => {
    if (!inspectorName.trim()) {
      setNameHint(true);
      setTab('inspect');
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
    setCrashSession(null);
    setTab('inspect');
    void saveActiveSession(bridge);
  };

  const handleTriageDone = async () => {
    setActiveBridge(null);
    setResumeDraft(null);
    await clearActiveSession();
    await refreshDrafts();
    setTab('inspect');
  };

  const handleTriageCancel = () => {
    setActiveBridge(null);
    setResumeDraft(null);
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
    if (t.includes('PASS') || t === 'GREEN' || t === 'OK') return '#1b5e20';
    if (t.includes('MONITOR') || t === 'YELLOW') return '#a66a00';
    if (t.includes('FAIL') || t === 'RED' || t.includes('CLOS'))
      return '#b00020';
    return '#555';
  };

  const assignmentPillColor = (status: Assignment['status']): string => {
    if (status === 'complete') return '#1b5e20';
    if (status === 'in_progress') return '#a66a00';
    return '#0b57d0';
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
              background: '#fff8e1',
              border: '2px solid #ffb300',
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
                  background: '#ffb300',
                  color: '#222',
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
            style={{ color: '#b00020', fontWeight: 600 }}
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
                        borderRadius: 999,
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
                        borderRadius: 999,
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
                    ➤
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
        onStartInspection={handleSelectBridge}
        onGetDirections={(b) => setDirectionsBridge(b)}
      />
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
            style={{ marginTop: 8, color: '#b00020', fontWeight: 600 }}
          >
            Name required before inspecting.
          </div>
        )}
      </div>
      <div className="card">
        <h3 style={{ marginTop: 0 }}>Sync</h3>
        <div className="muted" style={{ marginBottom: 12 }}>
          {pending} item{pending === 1 ? '' : 's'} pending
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
            className="btn"
            type="button"
            onClick={async () => {
              if (window.confirm(`Clear ${pending} queued item(s)? This cannot be undone.`)) {
                await clearQueue();
                setPending(0);
                setSyncResult('Queue cleared.');
              }
            }}
            style={{ marginTop: 8, background: '#fff', color: '#b00020', border: '1px solid #b00020' }}
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
                background: '#b00020',
                color: '#fff',
                borderRadius: 999,
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
                  background: n.read_at ? '#fff' : '#e8f0fe',
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
                  background: '#0b57d0',
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

      <nav
        style={{
          position: 'fixed',
          bottom: 0,
          left: 0,
          right: 0,
          display: 'grid',
          gridTemplateColumns: 'repeat(4, 1fr)',
          borderTop: '1px solid #ddd',
          background: '#fff',
          paddingBottom: 'env(safe-area-inset-bottom, 0px)',
          zIndex: 50,
        }}
      >
        {(
          [
            ['inspect', 'Inspect'],
            ['map', 'Map'],
            ['closure', 'Report closure'],
            ['sync', 'Sync'],
          ] as [Tab, string][]
        ).map(([key, label]) => (
          <button
            key={key}
            className="btn"
            onClick={() => {
              if (key !== 'inspect' && key !== 'sync' && key !== 'map') {
                if (!requireName()) return;
              }
              setTab(key);
            }}
            aria-current={tab === key ? 'page' : undefined}
            style={{
              minHeight: 56,
              borderRadius: 0,
              background: tab === key ? '#e8f0fe' : '#fff',
              color: tab === key ? '#0b57d0' : '#222',
              fontWeight: 600,
              fontSize: 14,
            }}
          >
            {label}
          </button>
        ))}
      </nav>
    </div>
  );
};

export default FieldApp;
