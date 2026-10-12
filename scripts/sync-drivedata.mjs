#!/usr/bin/env node
/**
 * DriveNC backend sync job.
 *
 * Calls the drivenc-* CLIs (which hold the API key via the Secure Vault)
 * and upserts results into the Supabase emg_drivedata_* tables. The field
 * app syncs from Supabase to IndexedDB — the frontend never touches the
 * DriveNC API directly.
 *
 * Run via cron every 15 minutes (API throttles at 10 calls/60s; this job
 * makes 3 calls per run). Example crontab line:
 *   7,22,37,52 * * * * /home/hatch/workspace/emergency-bridge-app/scripts/sync-drivedata.mjs
 *
 * Requires SUPABASE_URL and SUPABASE_SERVICE_KEY in the environment.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const BIN = '/home/hatch/workspace/skills/drivenc/bin';
const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('SUPABASE_URL and SUPABASE_SERVICE_KEY must be set');
  process.exit(1);
}

async function runCli(name, args = []) {
  const { stdout } = await execFileAsync(`${BIN}/${name}`, args, {
    timeout: 90000,
    maxBuffer: 64 * 1024 * 1024,
  });
  return JSON.parse(stdout);
}

async function upsert(table, rows, mapFn) {
  if (rows.length === 0) {
    console.log(`  ${table}: 0 rows, skipping`);
    return;
  }
  const mapped = rows.map(mapFn).filter(Boolean);
  // Upsert in batches of 500.
  for (let i = 0; i < mapped.length; i += 500) {
    const batch = mapped.slice(i, i + 500);
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/${table}?on_conflict=id`,
      {
        method: 'POST',
        headers: {
          apikey: SERVICE_KEY,
          Authorization: `Bearer ${SERVICE_KEY}`,
          'Content-Type': 'application/json',
          Prefer: 'resolution=merge-duplicates',
        },
        body: JSON.stringify(batch),
      },
    );
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`${table} upsert failed (${res.status}): ${text.slice(0, 300)}`);
    }
  }
  console.log(`  ${table}: upserted ${mapped.length} rows`);
}

const toIso = (unix) =>
  unix ? new Date(unix * 1000).toISOString() : null;

async function main() {
  console.log(`[sync-drivedata] ${new Date().toISOString()}`);

  // 1. Events
  const events = await runCli('drivenc-events');
  await upsert('emg_drivedata_events', events, (e) => {
    if (!e || e.ID == null) return null;
    const lon = Number(e.Longitude);
    const lat = Number(e.Latitude);
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
    return {
      id: String(e.ID),
      roadway: e.RoadwayName ?? '',
      direction: e.DirectionOfTravel ?? '',
      description: e.Description ?? '',
      event_type: e.EventType ?? '',
      event_subtype: e.EventSubType ?? '',
      is_full_closure: e.IsFullClosure === true,
      severity: e.Severity ?? '',
      lanes_affected: e.LanesAffected ?? '',
      county: e.County ?? '',
      lon,
      lat,
      reported: toIso(e.Reported),
      last_updated: toIso(e.LastUpdated) ?? new Date().toISOString(),
      detour_instructions: Array.isArray(e.DetourInstructions)
        ? e.DetourInstructions
        : [],
      synced_at: new Date().toISOString(),
    };
  });

  // 2. Message signs
  const signs = await runCli('drivenc-signs');
  await upsert('emg_drivedata_signs', signs, (s) => {
    if (!s || s.Id == null) return null;
    const lon = Number(s.Longitude);
    const lat = Number(s.Latitude);
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
    const messages = Array.isArray(s.Messages)
      ? s.Messages.map((m) => (typeof m === 'string' ? m : m?.Text ?? '')).filter(Boolean)
      : [];
    return {
      id: String(s.Id),
      name: s.Name ?? '',
      roadway: s.Roadway ?? '',
      direction: s.DirectionOfTravel ?? '',
      messages,
      county: s.County ?? '',
      lon,
      lat,
      last_updated: s.LastUpdated ?? new Date().toISOString(),
      synced_at: new Date().toISOString(),
    };
  });

  // 3. Work zones (WZDx GeoJSON)
  const wzdx = await runCli('drivenc-wzdx');
  const features = Array.isArray(wzdx?.features) ? wzdx.features : [];
  await upsert('emg_drivedata_workzones', features, (f) => {
    if (!f || f.id == null) return null;
    const core = f.properties?.core_details ?? {};
    return {
      id: String(f.id),
      road_names: Array.isArray(core.road_names) ? core.road_names : [],
      direction: core.direction ?? '',
      description: core.description ?? '',
      geometry: f.geometry ?? null,
      last_updated:
        wzdx?.feed_info?.update_date ?? new Date().toISOString(),
      synced_at: new Date().toISOString(),
    };
  });

  console.log('[sync-drivedata] done');
}

main().catch((err) => {
  console.error('[sync-drivedata] FAILED:', err.message);
  process.exit(1);
});
