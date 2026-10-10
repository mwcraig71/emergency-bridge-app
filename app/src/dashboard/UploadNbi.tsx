import { useEffect, useRef, useState } from 'react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { ONLINE_STYLE_URL } from '../lib/tilepacks';

// In production the API is same-origin (Render serves dist/ + /api).
// VITE_API_URL only needed for local dev (vite proxy or direct URL).
const API_BASE = (import.meta.env.VITE_API_URL as string | undefined) ?? '';
const IMPORT_TOKEN = (import.meta.env.VITE_IMPORT_TOKEN as string | undefined) ?? '';

const US_STATES = [
  'AL','AK','AZ','AR','CA','CO','CT','DE','DC','FL','GA','HI','ID','IL','IN','IA',
  'KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM',
  'NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA',
  'WV','WI','WY','PR',
];

interface PreviewRow {
  asset_id: string;
  struct_no: string;
  county: string | null;
  district: string | null;
  facility: string | null;
  location: string | null;
  lat: number;
  lon: number;
}

interface Preview {
  parse_id: string;
  state: string;
  filename: string;
  format: string;
  layout_verified: boolean;
  total_records: number;
  loadable: number;
  skipped_coords: number;
  districts: string[];
  bbox: [number, number, number, number] | null;
  sample_rows: PreviewRow[];
}

interface CheckResult {
  collision_count: number;
  collisions: string[];
  within_batch_duplicates: number;
  existing_count: number;
}

interface JobStatus {
  job_id: string;
  status: 'running' | 'completed' | 'aborted' | 'failed';
  done: number;
  total: number;
  loaded: number;
  skipped: number;
  error: string | null;
  collisions?: string[];
}

interface ImportLogRow {
  id: string;
  state: string;
  filename: string;
  imported_by: string | null;
  imported_at: string;
  format: string | null;
  total_records: number;
  loaded: number;
  skipped_coords: number;
  collisions: number;
  status: string;
  notes: string | null;
}

type Step = 'select' | 'preview' | 'check' | 'importing' | 'done';

function apiHeaders(): Record<string, string> {
  const h: Record<string, string> = {};
  if (IMPORT_TOKEN) h['x-import-token'] = IMPORT_TOKEN;
  return h;
}

async function apiJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(API_BASE + url, {
    ...init,
    headers: { ...apiHeaders(), ...(init?.headers ?? {}) },
  });
  const data = (await res.json()) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `request failed (${res.status})`);
  return data;
}

/** Mini map: bbox rectangle + sample points. */
function PreviewMap({ bbox, points }: { bbox: [number, number, number, number] | null; points: PreviewRow[] }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);

  useEffect(() => {
    if (!ref.current || !bbox) return;
    const [minLon, minLat, maxLon, maxLat] = bbox;
    const map = new maplibregl.Map({
      container: ref.current,
      style: ONLINE_STYLE_URL,
      bounds: [[minLon, minLat], [maxLon, maxLat]],
      fitBoundsOptions: { padding: 24 },
      attributionControl: { compact: true },
    });
    mapRef.current = map;
    map.on('load', () => {
      const ring: [number, number][] = [
        [minLon, minLat], [maxLon, minLat], [maxLon, maxLat],
        [minLon, maxLat], [minLon, minLat],
      ];
      map.addSource('bbox', {
        type: 'geojson',
        data: { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [ring] } },
      });
      map.addLayer({
        id: 'bbox-line', type: 'line', source: 'bbox',
        paint: { 'line-color': '#38bdf8', 'line-width': 2 },
      });
      const pts = points.slice(0, 300).map((p) => ({
        type: 'Feature' as const,
        properties: { asset_id: p.asset_id },
        geometry: { type: 'Point' as const, coordinates: [p.lon, p.lat] },
      }));
      map.addSource('pts', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: pts },
      });
      map.addLayer({
        id: 'pts', type: 'circle', source: 'pts',
        paint: { 'circle-radius': 3, 'circle-color': '#f59e0b', 'circle-stroke-width': 1, 'circle-stroke-color': '#fff' },
      });
    });
    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, [bbox]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!bbox) return <p className="muted">No coordinates to map.</p>;
  return <div ref={ref} style={{ height: 260, borderRadius: 8, overflow: 'hidden' }} />;
}

export default function UploadNbi(): React.JSX.Element {
  const [state, setState] = useState('NC');
  const [importedBy, setImportedBy] = useState('');
  const [step, setStep] = useState<Step>('select');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [check, setCheck] = useState<CheckResult | null>(null);
  const [job, setJob] = useState<JobStatus | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [log, setLog] = useState<ImportLogRow[] | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const pollRef = useRef<number | null>(null);

  useEffect(() => {
    void loadLog();
    return () => {
      if (pollRef.current) window.clearInterval(pollRef.current);
    };
  }, []);

  async function loadLog() {
    try {
      const rows = await apiJson<ImportLogRow[]>('/api/nbi/imports');
      setLog(rows);
    } catch {
      setLog([]);
    }
  }

  async function handleFile(file: File) {
    setMessage(null);
    setPreview(null);
    setCheck(null);
    setJob(null);
    if (!/^[A-Za-z]{2}$/.test(state)) {
      setMessage('Pick a 2-letter state code first.');
      return;
    }
    setBusy(true);
    try {
      const url = `/api/nbi/preview?state=${encodeURIComponent(state.toUpperCase())}`
        + `&filename=${encodeURIComponent(file.name)}`
        + `&prefix=${encodeURIComponent(state.toUpperCase())}`;
      const res = await fetch(API_BASE + url, {
        method: 'POST',
        headers: apiHeaders(),
        body: file,
      });
      const data = (await res.json()) as Preview & { error?: string };
      if (!res.ok) throw new Error(data.error ?? `preview failed (${res.status})`);
      setPreview(data);
      setStep('preview');
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function handleCheck() {
    if (!preview) return;
    setBusy(true);
    setMessage(null);
    try {
      const res = await apiJson<CheckResult>(
        `/api/nbi/check?parse_id=${encodeURIComponent(preview.parse_id)}`,
        { method: 'POST' },
      );
      setCheck(res);
      setStep('check');
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function handleImport() {
    if (!preview || !check) return;
    if (check.collision_count > 0 || check.within_batch_duplicates > 0) {
      setMessage('Import blocked: resolve collisions first. Nothing was written.');
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      const res = await apiJson<{ job_id: string; status: string }>(
        `/api/nbi/import?parse_id=${encodeURIComponent(preview.parse_id)}`
        + `&imported_by=${encodeURIComponent(importedBy.slice(0, 120))}`,
        { method: 'POST' },
      );
      setStep('importing');
      pollRef.current = window.setInterval(async () => {
        try {
          const js = await apiJson<JobStatus>(`/api/nbi/jobs/${encodeURIComponent(res.job_id)}`);
          setJob(js);
          if (js.status !== 'running') {
            if (pollRef.current) window.clearInterval(pollRef.current);
            pollRef.current = null;
            setBusy(false);
            setStep('done');
            void loadLog();
          }
        } catch (e) {
          if (pollRef.current) window.clearInterval(pollRef.current);
          pollRef.current = null;
          setBusy(false);
          setMessage(e instanceof Error ? e.message : String(e));
        }
      }, 1500);
    } catch (e) {
      setBusy(false);
      setMessage(e instanceof Error ? e.message : String(e));
    }
  }

  function reset() {
    setStep('select');
    setPreview(null);
    setCheck(null);
    setJob(null);
    setMessage(null);
  }

  const pct = job && job.total > 0 ? Math.round((job.done / job.total) * 100) : 0;

  return (
    <div className="card">
      <h2 style={{ marginTop: 0 }}>Upload NBI state file</h2>
      <p className="muted">
        Add a new state's bridge inventory from an FHWA NBI file. The file is parsed on the
        server, checked for ID collisions (fail-closed — nothing is written if any collide),
        then loaded in batches.
      </p>

      {step === 'select' && (
        <>
          <div style={{ display: 'flex', gap: 12, marginBottom: 12, flexWrap: 'wrap' }}>
            <label>
              State{' '}
              <select value={state} onChange={(e) => setState(e.target.value.toUpperCase())}>
                {US_STATES.map((s) => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
            </label>
            <label>
              Imported by{' '}
              <input
                type="text"
                value={importedBy}
                onChange={(e) => setImportedBy(e.target.value)}
                placeholder="inspector name"
                style={{ width: 200 }}
              />
            </label>
          </div>
          <div
            onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragOver(false);
              const f = e.dataTransfer.files?.[0];
              if (f) void handleFile(f);
            }}
            onClick={() => fileRef.current?.click()}
            style={{
              border: `2px dashed ${dragOver ? '#38bdf8' : '#475569'}`,
              borderRadius: 10,
              padding: 36,
              textAlign: 'center',
              cursor: 'pointer',
              background: dragOver ? '#1e3a5f' : 'transparent',
            }}
          >
            <p style={{ margin: 0 }}>
              {busy ? 'Parsing…' : 'Drop the NBI .txt file here, or click to browse'}
            </p>
            <p className="muted" style={{ margin: '8px 0 0' }}>
              CSV with NBI headers, or fixed-width NBI tape. Asset IDs will be stored as{' '}
              <code>{state}-&lt;id&gt;</code>.
            </p>
            <input
              ref={fileRef}
              type="file"
              accept=".txt,.csv"
              style={{ display: 'none' }}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void handleFile(f);
                e.target.value = '';
              }}
            />
          </div>
        </>
      )}

      {message && <p style={{ color: '#fca5a5' }}>{message}</p>}

      {step !== 'select' && preview && (
        <div style={{ marginTop: 12 }}>
          <h3>Preview — {preview.filename}</h3>
          <p>
            Format: <code>{preview.format}</code>{' '}
            {!preview.layout_verified && (
              <span style={{ color: '#fbbf24' }}>
                ⚠ unverified fixed-width layout — check the sample rows carefully before importing
              </span>
            )}
          </p>
          <p className="muted">
            {preview.total_records.toLocaleString()} records in file ·{' '}
            {preview.loadable.toLocaleString()} loadable ·{' '}
            {preview.skipped_coords.toLocaleString()} skipped (bad/implausible coordinates)
          </p>
          <p>
            District/division values found:{' '}
            {preview.districts.length === 0
              ? <span className="muted">none</span>
              : preview.districts.map((d) => <code key={d} style={{ marginRight: 6 }}>{d}</code>)}
          </p>
          <PreviewMap bbox={preview.bbox} points={preview.sample_rows} />
          <h4>Sample rows</h4>
          <div style={{ overflowX: 'auto' }}>
            <table className="data">
              <thead>
                <tr>
                  <th>Asset ID</th><th>Struct No</th><th>County</th><th>Dist</th>
                  <th>Facility</th><th>Location</th><th>Lat</th><th>Lon</th>
                </tr>
              </thead>
              <tbody>
                {preview.sample_rows.map((r) => (
                  <tr key={r.asset_id}>
                    <td><code>{r.asset_id}</code></td>
                    <td>{r.struct_no}</td>
                    <td>{r.county ?? '—'}</td>
                    <td>{r.district ?? '—'}</td>
                    <td>{r.facility ?? '—'}</td>
                    <td>{r.location ?? '—'}</td>
                    <td>{r.lat.toFixed(4)}</td>
                    <td>{r.lon.toFixed(4)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
            <button type="button" className="btn" onClick={reset}>Start over</button>
            {step === 'preview' && (
              <button type="button" className="btn btn-primary" onClick={handleCheck} disabled={busy}>
                {busy ? 'Checking…' : 'Check for ID collisions'}
              </button>
            )}
          </div>
        </div>
      )}

      {step === 'check' && check && (
        <div style={{ marginTop: 12 }}>
          <h3>Collision check</h3>
          {check.collision_count === 0 && check.within_batch_duplicates === 0 ? (
            <p style={{ color: '#86efac' }}>
              ✓ No collisions — {preview!.loadable.toLocaleString()} IDs are clear against{' '}
              {check.existing_count.toLocaleString()} existing bridges. Safe to import.
            </p>
          ) : (
            <div>
              <p style={{ color: '#fca5a5' }}>
                ✗ Blocked: {check.collision_count} collisions with existing bridges
                {check.within_batch_duplicates > 0 &&
                  `, ${check.within_batch_duplicates} duplicates within the file`}.
                Nothing was written.
              </p>
              {check.collisions.length > 0 && (
                <p className="muted">e.g. {check.collisions.slice(0, 10).join(', ')}</p>
              )}
            </div>
          )}
          <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
            <button type="button" className="btn" onClick={reset}>Start over</button>
            {check.collision_count === 0 && check.within_batch_duplicates === 0 && (
              <button type="button" className="btn btn-primary" onClick={handleImport} disabled={busy}>
                Import {preview!.loadable.toLocaleString()} bridges
              </button>
            )}
          </div>
        </div>
      )}

      {(step === 'importing' || step === 'done') && job && (
        <div style={{ marginTop: 12 }}>
          <h3>Import {job.status === 'running' ? 'in progress…' : job.status}</h3>
          <div style={{ background: '#0f172a', borderRadius: 6, height: 18, overflow: 'hidden' }}>
            <div
              style={{
                width: `${pct}%`, height: '100%',
                background: job.status === 'failed' || job.status === 'aborted' ? '#dc2626' : '#16a34a',
                transition: 'width 0.4s',
              }}
            />
          </div>
          <p className="muted">
            {job.done.toLocaleString()} / {job.total.toLocaleString()} ({pct}%)
            {job.error && <> — <span style={{ color: '#fca5a5' }}>{job.error}</span></>}
          </p>
          {job.status === 'completed' && (
            <p style={{ color: '#86efac' }}>
              ✓ Import complete: {job.loaded.toLocaleString()} bridges loaded
              ({job.skipped.toLocaleString()} skipped for bad coordinates).
            </p>
          )}
          {step === 'done' && (
            <button type="button" className="btn" onClick={reset}>Upload another state</button>
          )}
        </div>
      )}

      <h3 style={{ marginTop: 24 }}>Import log</h3>
      {log === null ? (
        <p className="muted">Loading…</p>
      ) : log.length === 0 ? (
        <p className="muted">No imports yet.</p>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table className="data">
            <thead>
              <tr>
                <th>When</th><th>State</th><th>File</th><th>By</th>
                <th>Total</th><th>Loaded</th><th>Skipped</th><th>Collisions</th><th>Status</th>
              </tr>
            </thead>
            <tbody>
              {log.map((r) => (
                <tr key={r.id}>
                  <td>{new Date(r.imported_at).toLocaleString()}</td>
                  <td>{r.state}</td>
                  <td>{r.filename}</td>
                  <td>{r.imported_by ?? '—'}</td>
                  <td>{r.total_records.toLocaleString()}</td>
                  <td>{r.loaded.toLocaleString()}</td>
                  <td>{r.skipped_coords.toLocaleString()}</td>
                  <td>{r.collisions.toLocaleString()}</td>
                  <td><span className={`pill pill-${r.status}`}>{r.status}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
