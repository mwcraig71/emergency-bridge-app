import { useMemo, useRef, useState } from 'react';
import React from 'react';
import { getSupabase, isOnline, isSupabaseConfigured } from '../lib/supabase';
import type { InspectionDraft } from '../types';

type ParsedRecord = InspectionDraft & {
  client_inspection_id: string;
  inspection_id?: string;
  inspection_datetime: string;
  asset_id: string;
};

interface RowError {
  row: number;
  reason: string;
}

interface PreviewState {
  parsed: ParsedRecord[];
  errors: RowError[];
  toInsert: ParsedRecord[];
  toUpdate: ParsedRecord[];
  skipped: ParsedRecord[];
}

const REQUIRED_COLUMNS = ['asset_id', 'inspection_datetime'] as const;

function genClientId(r: Partial<ParsedRecord>): string {
  const src = r.client_inspection_id ?? r.inspection_id ?? '';
  if (src) return String(src);
  const asset = r.asset_id ?? '';
  const dt = r.inspection_datetime ?? '';
  return `${asset}::${dt}`;
}

function coerceRecord(raw: Record<string, unknown>): Partial<ParsedRecord> {
  const out: Partial<ParsedRecord> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (v === undefined || v === null) continue;
    (out as Record<string, unknown>)[k] = typeof v === 'object' ? JSON.stringify(v) : v;
  }
  return out;
}

function parseCsv(text: string): Array<Record<string, unknown>> {
  const lines = text.replace(/\r\n/g, '\n').split('\n').filter((l) => l.trim().length > 0);
  if (lines.length === 0) return [];
  const headers = splitCsvLine(lines[0]);
  const rows: Array<Record<string, unknown>> = [];
  for (let i = 1; i < lines.length; i += 1) {
    const cells = splitCsvLine(lines[i]);
    const obj: Record<string, unknown> = {};
    for (let j = 0; j < headers.length; j += 1) {
      obj[headers[j]] = cells[j] ?? '';
    }
    rows.push(obj);
  }
  return rows;
}

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

function parseGeoJson(text: string): Array<Record<string, unknown>> {
  const obj = JSON.parse(text) as {
    type?: string;
    features?: Array<{ properties?: Record<string, unknown> }>;
  };
  if (!obj || obj.type !== 'FeatureCollection' || !Array.isArray(obj.features)) {
    throw new Error('GeoJSON must be a FeatureCollection.');
  }
  return obj.features.map((f) => f.properties ?? {});
}

function validate(raw: Record<string, unknown>, rowIdx: number): { ok?: Partial<ParsedRecord>; err?: RowError } {
  const rec = coerceRecord(raw);
  for (const col of REQUIRED_COLUMNS) {
    if (!rec[col]) {
      return { err: { row: rowIdx, reason: `missing ${col}` } };
    }
  }
  const dt = String(rec.inspection_datetime ?? '');
  const parsed = new Date(dt);
  if (isNaN(parsed.getTime())) {
    return { err: { row: rowIdx, reason: `bad datetime: ${dt}` } };
  }
  return { ok: rec };
}

export default function DataIntake(): React.JSX.Element {
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState<boolean>(false);

  async function handleFile(file: File): Promise<void> {
    setMessage(null);
    setPreview(null);
    try {
      const text = await file.text();
      let rawRows: Array<Record<string, unknown>> = [];
      const lower = file.name.toLowerCase();
      if (lower.endsWith('.geojson') || lower.endsWith('.json')) {
        rawRows = parseGeoJson(text);
      } else if (lower.endsWith('.csv')) {
        rawRows = parseCsv(text);
      } else {
        setMessage('Unsupported file type. Use .geojson, .json, or .csv.');
        return;
      }

      const parsed: ParsedRecord[] = [];
      const errors: RowError[] = [];
      rawRows.forEach((raw, i) => {
        const v = validate(raw, i + 1);
        if (v.err) {
          errors.push(v.err);
        } else if (v.ok) {
          const rec = v.ok as ParsedRecord;
          rec.client_inspection_id = genClientId(rec);
          parsed.push(rec);
        }
      });

      // Dedupe within file: (client_inspection_id + inspection_datetime), newest wins.
      const dedupe = new Map<string, ParsedRecord>();
      for (const rec of parsed) {
        const key = `${rec.client_inspection_id}::${rec.inspection_datetime}`;
        const prev = dedupe.get(key);
        if (!prev || new Date(rec.inspection_datetime) > new Date(prev.inspection_datetime)) {
          dedupe.set(key, rec);
        }
      }
      const unique = Array.from(dedupe.values());

      // Determine new vs update vs skipped using remote check.
      const toInsert: ParsedRecord[] = [];
      const toUpdate: ParsedRecord[] = [];
      const skipped: ParsedRecord[] = [];

      if (isSupabaseConfigured() && isOnline()) {
        const sb = getSupabase();
        if (sb) {
          const ids = unique.map((u) => u.client_inspection_id).filter((x) => !!x);
          const existing = new Map<string, string>();
          if (ids.length > 0) {
            const res = await sb
              .from('emg_inspections')
              .select('client_inspection_id, inspection_datetime')
              .in('client_inspection_id', ids);
            if (!res.error) {
              for (const row of (res.data ?? []) as Array<{
                client_inspection_id: string;
                inspection_datetime: string | null;
              }>) {
                if (row.inspection_datetime) existing.set(row.client_inspection_id, row.inspection_datetime);
              }
            }
          }
          for (const rec of unique) {
            if (!rec.asset_id) {
              errors.push({ row: -1, reason: `missing asset_id for ${rec.client_inspection_id}` });
              continue;
            }
            const prev = existing.get(rec.client_inspection_id);
            if (!prev) {
              toInsert.push(rec);
            } else if (new Date(rec.inspection_datetime) > new Date(prev)) {
              toUpdate.push(rec);
            } else {
              skipped.push(rec);
            }
          }
        } else {
          toInsert.push(...unique);
        }
      } else {
        toInsert.push(...unique);
      }

      setPreview({ parsed: unique, errors, toInsert, toUpdate, skipped });
      setMessage(
        `${unique.length} records parsed, ${toInsert.length} new, ${toUpdate.length} updates, ${
          skipped.length
        } skipped${errors.length ? `, ${errors.length} errors` : ''}.`,
      );
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    }
  }

  async function confirmUpload(): Promise<void> {
    if (!preview) return;
    setBusy(true);
    setMessage(null);
    try {
      if (!isSupabaseConfigured || !isOnline()) {
        setMessage('Offline or backend not configured — cannot upload right now.');
        return;
      }
      const sb = getSupabase();
      if (!sb) {
        setMessage('Supabase client unavailable.');
        return;
      }
      const payload = [...preview.toInsert, ...preview.toUpdate].map((r) => {
        const cleaned: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(r)) {
          if (v === undefined) continue;
          cleaned[k] = v;
        }
        return cleaned;
      });
      if (payload.length === 0) {
        setMessage('Nothing to upload.');
        return;
      }
      const { error } = await sb
        .from('emg_inspections')
        .upsert(payload, { onConflict: 'client_inspection_id' });
      if (error) {
        setMessage(`Upload failed: ${error.message}`);
      } else {
        setMessage(`Uploaded ${payload.length} records.`);
        setPreview(null);
      }
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const previewSummary = useMemo(() => {
    if (!preview) return null;
    return {
      parsed: preview.parsed.length,
      newRows: preview.toInsert.length,
      updates: preview.toUpdate.length,
      skipped: preview.skipped.length,
      errors: preview.errors.length,
    };
  }, [preview]);

  return (
    <div className="card">
      <h2 style={{ marginTop: 0 }}>Data intake</h2>
      <p className="muted">Upload field data (.geojson, .json, .csv) and dry-run before syncing.</p>

      <div className="field">
        <input
          ref={fileRef}
          type="file"
          accept=".geojson,.json,.csv"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void handleFile(f);
          }}
        />
      </div>

      {message && <p>{message}</p>}

      {previewSummary && preview && (
        <div style={{ marginTop: 8 }}>
          <p className="muted">
            Dry-run: {previewSummary.parsed} records parsed, {previewSummary.newRows} new,{' '}
            {previewSummary.updates} updates, {previewSummary.skipped} skipped
            {previewSummary.errors ? `, ${previewSummary.errors} skipped (missing asset_id / bad datetime)` : ''}.
          </p>

          {preview.errors.length > 0 && (
            <div className="err-box">
              <strong>Row errors</strong>
              <ul style={{ margin: '4px 0 0 16px', padding: 0 }}>
                {preview.errors.slice(0, 20).map((e, i) => (
                  <li key={i}>
                    Row {e.row}: {e.reason}
                  </li>
                ))}
                {preview.errors.length > 20 && <li>…and {preview.errors.length - 20} more</li>}
              </ul>
            </div>
          )}

          <button
            type="button"
            className="btn"
            disabled={busy || preview.toInsert.length + preview.toUpdate.length === 0}
            onClick={() => void confirmUpload()}
          >
            {busy ? 'Uploading…' : 'Confirm upload'}
          </button>
        </div>
      )}

      <details style={{ marginTop: 16 }}>
        <summary>Sync API for field devices</summary>
        <div className="muted" style={{ marginTop: 8 }}>
          <p>
            <strong>POST /rest/v1/emg_inspections</strong> — upsert on{' '}
            <code>client_inspection_id</code>. Photo metadata is posted to{' '}
            <code>emg_inspection_photos</code>; binaries go to Storage bucket{' '}
            <code>inspection-photos</code> (Phase 2). Roadblocks are posted to{' '}
            <code>emg_roadblocks</code>.
          </p>
          <pre style={{ whiteSpace: 'pre-wrap', background: '#f6f6f6', padding: 8, borderRadius: 4 }}>
{`curl -X POST "$SUPABASE_URL/rest/v1/emg_inspections" \\
  -H "apikey: $ANON_KEY" \\
  -H "Authorization: Bearer $ANON_KEY" \\
  -H "Content-Type: application/json" \\
  -H "Prefer: resolution=merge-duplicates" \\
  -d '[{
    "client_inspection_id": "device-A-0001",
    "asset_id": "bridge-1892",
    "inspection_datetime": "2024-06-01T14:22:00Z",
    "inspector_name": "A. Jones",
    "triage_list": "destroyed"
  }]'`}
          </pre>
          <p>
            Roadblock example:
          </p>
          <pre style={{ whiteSpace: 'pre-wrap', background: '#f6f6f6', padding: 8, borderRadius: 4 }}>
{`curl -X POST "$SUPABASE_URL/rest/v1/emg_roadblocks" \\
  -H "apikey: $ANON_KEY" \\
  -H "Authorization: Bearer $ANON_KEY" \\
  -H "Content-Type: application/json" \\
  -d '[{
    "road_name": "US-21",
    "closure_type": "flood",
    "reporter": "A. Jones",
    "reported_at": "2024-06-01T14:30:00Z"
  }]'`}
          </pre>
        </div>
      </details>
    </div>
  );
}
