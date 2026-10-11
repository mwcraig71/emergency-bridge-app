// Local-first sync: queue mutations in IndexedDB, push to Supabase when online.
// Server merge rule: dedupe by client_inspection_id + timestamp, newest wins.
import { getSupabase, isSupabaseConfigured, isOnline } from './supabase';
import { idbGetAll, idbPut, idbDelete } from './idb';
import type { InspectionDraft, Roadblock, SyncQueueItem, PhotoRef } from '../types';

function uuid(): string {
  return crypto.randomUUID();
}

export async function enqueue(
  kind: SyncQueueItem['kind'],
  payload: unknown,
): Promise<void> {
  const item: SyncQueueItem = {
    id: uuid(),
    kind,
    payload,
    attempts: 0,
    created_at: new Date().toISOString(),
  };
  await idbPut('syncQueue', item);
}

/** Push queued items. Returns { pushed, failed }. Stops on first auth error. */
export async function pushQueue(): Promise<{ pushed: number; failed: number }> {
  const sb = getSupabase();
  if (!sb || !isOnline()) return { pushed: 0, failed: 0 };
  const items = await idbGetAll<SyncQueueItem>('syncQueue');
  let pushed = 0;
  let failed = 0;
  for (const item of items) {
    try {
      await pushOne(sb, item);
      await idbDelete('syncQueue', item.id);
      pushed++;
    } catch (e) {
      failed++;
      const msg = String(e);
      if (/401|403|jwt/i.test(msg)) break; // auth problem — don't hammer
      await idbPut('syncQueue', { ...item, attempts: item.attempts + 1 });
    }
  }
  return { pushed, failed };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function pushOne(sb: any, item: SyncQueueItem): Promise<void> {
  switch (item.kind) {
    case 'inspection': {
      const d = item.payload as InspectionDraft;
      const row = {
        asset_id: d.asset_id,
        inspector_name: d.inspector_name,
        inspection_datetime: d.inspection_datetime,
        device_id: d.device_id ?? null,
        destroyed: d.destroyed,
        access: d.access,
        drone_used: d.drone_used,
        bridge_still_there: d.bridge_still_there,
        triage_list: d.triage_list === 'complete' ? 'complete' : d.triage_list,
        overtopped: d.overtopped,
        overtop_depth_ft: d.overtop_depth_ft,
        damage_rail: d.damage_rail,
        damage_deck: d.damage_deck,
        damage_super: d.damage_super,
        damage_sub: d.damage_sub,
        washout_abutment: d.washout_abutment,
        remain_open: d.remain_open,
        remain_open_notes: d.remain_open_notes || null,
        safe_load: d.safe_load,
        safe_load_notes: d.safe_load_notes || null,
        debris_amount: d.debris_amount,
        gps_lat: d.gps_lat,
        gps_lon: d.gps_lon,
        coord_mismatch: d.coord_mismatch,
        sync_status: 'synced',
        client_inspection_id: d.client_inspection_id,
      };
      // Newest-wins upsert on the client dedupe key.
      const { error } = await sb
        .from('emg_inspections')
        .upsert(row, { onConflict: 'client_inspection_id' });
      if (error) throw new Error(error.message);
      break;
    }
    case 'roadblock': {
      const b = item.payload as Roadblock & { photoDataUrl?: string };
      const { error } = await sb.from('emg_roadblocks').insert({
        road_name: b.road_name,
        closure_type: b.closure_type,
        geom: `SRID=4326;POINT(${b.lon} ${b.lat})`,
        reporter: b.reporter,
        reported_at: b.reported_at,
        status: b.status,
        reopened_at: b.reopened_at,
        reopened_by: b.reopened_by,
        notes: b.notes,
      });
      if (error) throw new Error(error.message);
      break;
    }
    case 'photo': {
      const p = item.payload as {
        inspection_client_id: string;
        photo: PhotoRef;
      };
      // Look up the server inspection id by client key, then insert metadata.
      // Binary upload to Storage is handled separately (Phase 2); for now the
      // dataUrl is too large for a row — metadata only, photo queued locally.
      const { data: insp } = await sb
        .from('emg_inspections')
        .select('id')
        .eq('client_inspection_id', p.inspection_client_id)
        .maybeSingle();
      if (!insp) throw new Error('inspection not synced yet; photo deferred');
      const { error } = await sb.from('emg_inspection_photos').insert({
        inspection_id: (insp as { id: string }).id,
        photo_type: p.photo.photo_type,
        storage_path: p.photo.storage_path ?? `pending/${p.photo.id}.jpg`,
        description: p.photo.description ?? null,
        taken_at: p.photo.taken_at,
      });
      if (error) throw new Error(error.message);
      break;
    }
    default:
      throw new Error(`pushOne: unsupported kind ${item.kind}`);
  }
}

/** True when the app has unsynced work. Drives the "N pending" badge. */
export async function pendingCount(): Promise<number> {
  const [q, drafts] = await Promise.all([
    idbGetAll('syncQueue'),
    idbGetAll<InspectionDraft>('drafts'),
  ]);
  return q.length + drafts.filter((d) => d.sync_status === 'pending').length;
}

export function isSyncConfigured(): boolean {
  return isSupabaseConfigured();
}
