// Local-first sync: queue mutations in IndexedDB, push to Supabase when online.
// Server merge rule: dedupe by client_inspection_id + timestamp, newest wins.
import { getSupabase, isSupabaseConfigured, isOnline } from './supabase';
import { idbGetAll, idbPut, idbDelete } from './idb';
import { getCurrentFirmId } from './firm';
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

/** Push queued items. Returns { pushed, failed, errors }. Stops on first auth error. */
export async function pushQueue(): Promise<{
  pushed: number;
  failed: number;
  errors: string[];
}> {
  const sb = getSupabase();
  if (!sb || !isOnline()) return { pushed: 0, failed: 0, errors: [] };
  const items = await idbGetAll<SyncQueueItem>('syncQueue');
  let pushed = 0;
  let failed = 0;
  const errors: string[] = [];
  for (const item of items) {
    try {
      await pushOne(sb, item);
      await idbDelete('syncQueue', item.id);
      pushed++;
    } catch (e) {
      failed++;
      const msg = e instanceof Error ? e.message : String(e);
      errors.push(`${item.kind} (${item.id.slice(0, 8)}): ${msg}`);
      if (/401|403|jwt/i.test(msg)) break; // auth problem — don't hammer
      await idbPut('syncQueue', { ...item, attempts: item.attempts + 1 });
    }
  }
  return { pushed, failed, errors };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function pushOne(sb: any, item: SyncQueueItem): Promise<void> {
  switch (item.kind) {
    case 'inspection': {
      const d = item.payload as InspectionDraft;
      // Validate required fields before push — give user-friendly errors.
      const missing: string[] = [];
      if (!d.destroyed) missing.push('"Was the bridge destroyed?"');
      if (!d.asset_id) missing.push('bridge ID');
      if (!d.inspector_name) missing.push('inspector name');
      if (missing.length > 0) {
        throw new Error(
          `Inspection is missing: ${missing.join(', ')}. ` +
          `Please open the inspection and complete these fields.`
        );
      }
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
        firm_id: d.firm_id ?? getCurrentFirmId(),
      };
      // Newest-wins upsert on the client dedupe key.
      const { error } = await sb
        .from('emg_inspections')
        .upsert(row, { onConflict: 'client_inspection_id' });
      if (error) throw new Error(error.message);
      // Mark the local draft as synced so pendingCount doesn't count it.
      try {
        const draft = await idbGetAll<InspectionDraft>('drafts').then(
          (ds) => ds.find((x) => x.client_inspection_id === d.client_inspection_id)
        );
        if (draft) {
          await idbPut('drafts', { ...draft, sync_status: 'synced' });
        }
      } catch {
        // Non-fatal: draft stays 'pending' but won't block future syncs.
      }
      // Team assignment bookkeeping — best effort, never fails the push.
      await markAssignmentComplete(sb, d.asset_id, d.inspector_name).catch(
        () => {},
      );
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

/** Clear all items from the sync queue. Use when a stuck item can't be fixed. */
export async function clearQueue(): Promise<void> {
  const items = await idbGetAll<SyncQueueItem>('syncQueue');
  for (const item of items) {
    await idbDelete('syncQueue', item.id);
  }
}

export function isSyncConfigured(): boolean {
  return isSupabaseConfigured();
}

/**
 * Team assignment bookkeeping after an inspection push.
 *
 * Marks the bridge's assignment complete (if one exists and is not already
 * complete) and, when someone other than the assignee did the inspection,
 * inserts a notification for the assignee.
 *
 * Best-effort: failures are swallowed by the caller so the inspection
 * push itself is never affected.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function markAssignmentComplete(
  sb: any,
  assetId: string,
  inspectorName: string,
): Promise<void> {
  const now = new Date().toISOString();
  const { data } = await sb
    .from('emg_assignments')
    .select('id,assigned_to,status')
    .eq('asset_id', assetId)
    .order('assigned_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  const row = data as {
    id: string;
    assigned_to: string;
    status: string;
  } | null;
  if (!row || row.status === 'complete') return;

  const { error: updateError } = await sb
    .from('emg_assignments')
    .update({
      status: 'complete',
      completed_by: inspectorName,
      completed_at: now,
    })
    .eq('id', row.id);
  if (updateError) throw new Error(updateError.message);

  // Cross-assignment: tell the assignee someone else did their bridge.
  const assignee = (row.assigned_to ?? '').trim();
  if (assignee && assignee.toLowerCase() !== inspectorName.trim().toLowerCase()) {
    const { error: notifError } = await sb.from('emg_notifications').insert({
      recipient: assignee,
      type: 'bridge_completed_by_other',
      title: `Bridge ${assetId} inspected`,
      message: `${inspectorName} inspected your assigned bridge ${assetId}.`,
      related_asset_id: assetId,
      firm_id: getCurrentFirmId(),
    });
    if (notifError) throw new Error(notifError.message);
  }
}
