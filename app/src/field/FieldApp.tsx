import React, { useCallback, useEffect, useMemo, useState } from 'react';
import BridgeLookup from './BridgeLookup';
import TriageFlow from './TriageFlow';
import RoadblockReport from './RoadblockReport';
import DirectionsView from './DirectionsView';
import TeamMap from '../components/TeamMap';
import type { Bridge, InspectionDraft } from '../types';
import { idbGetAll, idbPut, idbGet } from '../lib/idb';
import { pushQueue, pendingCount } from '../lib/sync';
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

  const handleSelectBridge = (bridge: Bridge) => {
    if (!requireName()) return;
    setResumeDraft(null);
    setActiveBridge(bridge);
    setTab('inspect');
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
    setTab('inspect');
  };

  const handleTriageDone = async () => {
    setActiveBridge(null);
    setResumeDraft(null);
    await refreshDrafts();
    setTab('inspect');
  };

  const handleTriageCancel = () => {
    setActiveBridge(null);
    setResumeDraft(null);
  };

  const handleSyncNow = async () => {
    setSyncing(true);
    setSyncResult(null);
    try {
      const result = await pushQueue();
      setSyncResult(
        result
          ? `Sync complete: ${JSON.stringify(result)}`
          : 'Sync complete.'
      );
    } catch (err) {
      setSyncResult(
        `Sync failed: ${err instanceof Error ? err.message : String(err)}`
      );
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
    <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 64 }}>
      <TeamMap showTeam />
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
          <div className="muted" style={{ marginTop: 12 }}>
            {syncResult}
          </div>
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
      <div className="card" style={{ position: 'sticky', top: 0, zIndex: 10 }}>
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
