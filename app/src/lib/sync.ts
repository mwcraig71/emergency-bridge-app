// Local-first sync: queue mutations in IndexedDB, push to Supabase when online.
// Server merge rule: dedupe by client_inspection_id + timestamp, newest wins.
import { getSupabase, isSupabaseConfigured, isOnline } from './supabase';
import { idbGetAll, idbPut, idbDelete, idbGet } from './idb';
import { getCurrentFirmId } from './firm';
import type { InspectionDraft, Roadblock, SyncQueueItem, PhotoRef, RoadblockPhoto, RoadblockPhotoQueuePayload } from '../types';

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
  // Ordering: inspections first (photos ride with them), then roadblocks
  // (their photos ride with them / follow as roadblock_photo items), then
  // everything else in enqueue order. (Queue keys are random UUIDs, so raw
  // IndexedDB order is arbitrary.)
  const kindRank = (k: SyncQueueItem['kind']) =>
    k === 'inspection' ? 0 : k === 'roadblock' ? 1 : 2;
  items.sort(
    (a, b) =>
      kindRank(a.kind) - kindRank(b.kind) ||
      a.created_at.localeCompare(b.created_at),
  );
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
      // Photos ride with the inspection: upload each one now that the server
      // row exists. pushPhoto is idempotent, so a retry is safe; any failure
      // keeps the whole inspection item queued so nothing is silently dropped.
      const { data: inspRow } = await sb
        .from('emg_inspections')
        .select('id')
        .eq('client_inspection_id', d.client_inspection_id)
        .maybeSingle();
      const serverId = (inspRow as { id: string } | null)?.id;
      if (!serverId) {
        throw new Error('inspection upserted but server row not found');
      }
      for (const photo of d.photos ?? []) {
        try {
          await pushPhoto(sb, serverId, photo);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          throw new Error(`photo (${photo.id.slice(0, 8)}): ${msg}`);
        }
      }
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
      // Upsert (not insert) so a retry after a partial failure — e.g. the
      // roadblock row landed but a photo upload failed — doesn't create a
      // duplicate. The client-generated id is preserved when it's a valid
      // uuid, so queued photos can reference the server row.
      const row: Record<string, unknown> = {
        road_name: b.road_name,
        closure_type: b.closure_type,
        geom: `SRID=4326;POINT(${b.lon} ${b.lat})`,
        reporter: b.reporter,
        reported_at: b.reported_at,
        status: b.status,
        reopened_at: b.reopened_at,
        reopened_by: b.reopened_by,
        notes: b.notes,
      };
      if (isUuid(b.id)) row.id = b.id;
      const { data: rbRow, error } = await sb
        .from('emg_roadblocks')
        .upsert(row, { onConflict: 'id' })
        .select('id')
        .maybeSingle();
      if (error) throw new Error(error.message);
      const serverRoadblockId =
        (rbRow as { id: string } | null)?.id ?? (isUuid(b.id) ? b.id : null);
      // Photos ride with the roadblock: push any unsynced local photos for
      // this roadblock now that the server row exists. pushRoadblockPhoto is
      // idempotent; a failure keeps this item queued so nothing is dropped.
      if (serverRoadblockId) {
        const localPhotos = await idbGetAll<RoadblockPhoto>('photos');
        for (const p of localPhotos) {
          if (p.roadblockId === b.id && !p.syncedAt) {
            try {
              await pushRoadblockPhoto(sb, serverRoadblockId, p);
            } catch (e) {
              const msg = e instanceof Error ? e.message : String(e);
              throw new Error(`roadblock photo (${p.id.slice(0, 8)}): ${msg}`);
            }
          }
        }
      }
      break;
    }
    case 'roadblock_photo': {
      // Stand-alone roadblock photo (e.g. the report was submitted online
      // but its photo upload failed, or a photo was captured later). The
      // image bytes stay in the IndexedDB `photos` store; this item only
      // references them.
      const p = item.payload as RoadblockPhotoQueuePayload;
      const local = await idbGet<RoadblockPhoto>('photos', p.photo_id);
      if (!local) break; // photo deleted locally — drop the item
      if (local.syncedAt && local.storagePath) break; // already synced
      try {
        await pushRoadblockPhoto(sb, p.roadblock_id, local);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        throw new Error(`roadblock photo (${p.photo_id.slice(0, 8)}): ${msg}`);
      }
      break;
    }
    case 'photo': {
      const p = item.payload as {
        inspection_client_id: string;
        photo: PhotoRef;
      };
      // Stand-alone photo queue item (e.g. a photo added after the
      // inspection already synced). Look up the server inspection id,
      // then run the same idempotent upload path as the inspection case.
      const { data: insp } = await sb
        .from('emg_inspections')
        .select('id')
        .eq('client_inspection_id', p.inspection_client_id)
        .maybeSingle();
      if (!insp) throw new Error('inspection not synced yet; photo deferred');
      try {
        await pushPhoto(sb, (insp as { id: string }).id, p.photo);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        throw new Error(`photo (${p.photo.id.slice(0, 8)}): ${msg}`);
      }
      break;
    }
    case 'road_status': {
      // Update the status of an existing roadblock (e.g. mark reopened).
      // Payload: { id: string; status: 'active' | 'reopened'; reopened_at?: string; reopened_by?: string }
      // Payload: { id: string; status: 'active' | 'reopened'; reopened_at?: string; reopened_by?: string }
      const s = item.payload as {
        id: string;
        status: 'active' | 'reopened';
        reopened_at?: string;
        reopened_by?: string;
      };
      const { error } = await sb
        .from('emg_roadblocks')
        .update({
          status: s.status,
          reopened_at: s.reopened_at ?? null,
          reopened_by: s.reopened_by ?? null,
        })
        .eq('id', s.id);
      if (error) throw new Error(error.message);
      // Update the local cache too so the map reflects the change offline.
      try {
        const { getCachedRoadblocks, cacheRoadblock } = await import('./roadblocks');
        const cached = await getCachedRoadblocks();
        const existing = cached.find((r) => r.id === s.id);
        if (existing) {
          await cacheRoadblock({
            ...existing,
            status: s.status,
            reopened_at: s.reopened_at ?? existing.reopened_at,
            reopened_by: s.reopened_by ?? existing.reopened_by,
          });
        }
      } catch {
        // Non-fatal: cache will refresh on next syncRoadblocks().
      }
      break;
    }
    case 'track': {
      // GPS breadcrumb track (onX model). Payload is a PathTrack:
      // { id, inspector, geojson (LineString), started_at, ended_at }.
      // Upserted by id so retries are idempotent. The table stores a
      // PostGIS geom; we write WKT and read back the generated geojson.
      const t = item.payload as {
        id: string;
        inspector: string;
        geojson: { type: string; coordinates: Array<[number, number]> };
        started_at: string;
        ended_at: string | null;
      };
      if (!t.id || !t.inspector || !t.geojson?.coordinates?.length) {
        throw new Error('track payload is missing id/inspector/coordinates');
      }
      const wkt =
        'SRID=4326;LINESTRING(' +
        t.geojson.coordinates.map((c) => `${c[0]} ${c[1]}`).join(',') +
        ')';
      // Insert-only (no UPDATE policy on this table): skip if already synced.
      const { data: existingTrack } = await sb
        .from('emg_path_tracks')
        .select('id')
        .eq('id', t.id)
        .maybeSingle();
      if (!existingTrack) {
        const { error: trackError } = await sb.from('emg_path_tracks').insert({
          id: t.id,
          inspector: t.inspector,
          geom: wkt,
          started_at: t.started_at,
          ended_at: t.ended_at,
        });
        if (trackError) throw new Error(trackError.message);
      }
      break;
    }
    case 'position': {
      // Live team position ping (not yet implemented server-side).
      // Kept as a no-op that drops the item so the queue doesn't clog;
      // a future emg_team_positions writer can replace this.
      break;
    }
    default:
      throw new Error(`pushOne: unsupported kind ${item.kind}`);
  }
}

/** Supabase Storage bucket for inspection photo binaries. Created by
 *  supabase/migrations/010_photo_storage.sql (NOT RUN yet). */
const PHOTO_BUCKET = 'emg-photos';

async function dataUrlToBlob(dataUrl: string): Promise<Blob> {
  const res = await fetch(dataUrl);
  if (!res.ok) throw new Error('could not decode photo image data');
  return await res.blob();
}

/**
 * Upload one inspection photo: binary to Supabase Storage, metadata row
 * (including the photo note) to emg_inspection_photos.
 *
 * Idempotent — safe to retry: the storage upload uses upsert and the metadata
 * insert is skipped when a row already exists for the storage path.
 * Throws on any failure; the caller keeps the queue item so the photo is
 * never silently dropped.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function pushPhoto(
  sb: any,
  inspectionId: string,
  photo: PhotoRef,
): Promise<void> {
  const storagePath =
    photo.storage_path ?? `inspections/${inspectionId}/${photo.id}.jpg`;
  // Already recorded? Skip the insert — retry after a partial failure.
  const { data: existing } = await sb
    .from('emg_inspection_photos')
    .select('id')
    .eq('storage_path', storagePath)
    .maybeSingle();
  if (existing) return;
  if (!photo.dataUrl) {
    throw new Error(`photo ${photo.id.slice(0, 8)} has no image data to upload`);
  }
  const blob = await dataUrlToBlob(photo.dataUrl);
  const { error: uploadError } = await sb.storage
    .from(PHOTO_BUCKET)
    .upload(storagePath, blob, {
      upsert: true,
      contentType: blob.type || 'image/jpeg',
    });
  if (uploadError) {
    const msg = uploadError.message || 'unknown storage error';
    if (/bucket/i.test(msg) && /not found|does not exist/i.test(msg)) {
      throw new Error(
        `photo storage bucket "${PHOTO_BUCKET}" is missing — run ` +
          `supabase/migrations/010_photo_storage.sql in the Supabase SQL ` +
          `editor, then sync again. Photo stays queued.`,
      );
    }
    throw new Error(`photo upload failed: ${msg}`);
  }
  const { error } = await sb.from('emg_inspection_photos').insert({
    inspection_id: inspectionId,
    photo_type: photo.photo_type,
    storage_path: storagePath,
    description: photo.description ?? null,
    taken_at: photo.taken_at,
  });
  if (error) throw new Error(error.message);
}

/** True for a canonical uuid string — guards against the non-uuid
 *  Math.random fallback id used in non-secure contexts. Exported for the
 *  roadblock report screen, which preserves client ids on direct insert. */
export function isUuid(s: unknown): s is string {
  return (
    typeof s === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)
  );
}

/**
 * Upload one roadblock closure photo: binary to the emg-photos bucket under
 * `roadblocks/<roadblockId>/`, metadata row to emg_roadblock_photos.
 *
 * Mirrors pushPhoto: idempotent (skips when a row already exists for the
 * storage path), marks the local IndexedDB record synced on success.
 * Throws on any failure; the caller keeps the queue item so the photo is
 * never silently dropped.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function pushRoadblockPhoto(
  sb: any,
  roadblockId: string,
  photo: RoadblockPhoto,
): Promise<void> {
  const storagePath =
    photo.storagePath ?? `roadblocks/${roadblockId}/${photo.id}.jpg`;
  // Already recorded? Mark local synced and skip — retry after partial failure.
  const { data: existing } = await sb
    .from('emg_roadblock_photos')
    .select('id')
    .eq('storage_path', storagePath)
    .maybeSingle();
  if (existing) {
    await markRoadblockPhotoSynced(photo.id, storagePath);
    return;
  }
  if (!photo.dataUrl) {
    throw new Error(
      `roadblock photo ${photo.id.slice(0, 8)} has no image data to upload`
    );
  }
  const blob = await dataUrlToBlob(photo.dataUrl);
  const { error: uploadError } = await sb.storage
    .from(PHOTO_BUCKET)
    .upload(storagePath, blob, {
      upsert: true,
      contentType: blob.type || 'image/jpeg',
    });
  if (uploadError) {
    const msg = uploadError.message || 'unknown storage error';
    if (/bucket/i.test(msg) && /not found|does not exist/i.test(msg)) {
      throw new Error(
        `photo storage bucket "${PHOTO_BUCKET}" is missing — run ` +
          `supabase/migrations/010_photo_storage.sql in the Supabase SQL ` +
          `editor, then sync again. Photo stays queued.`
      );
    }
    throw new Error(`roadblock photo upload failed: ${msg}`);
  }
  const { error } = await sb.from('emg_roadblock_photos').insert({
    roadblock_id: roadblockId,
    storage_path: storagePath,
    note: photo.note ?? null,
    taken_at: photo.takenAt,
  });
  if (error) throw new Error(error.message);
  await markRoadblockPhotoSynced(photo.id, storagePath);
}

/** Mark a local roadblock photo as synced (best-effort; never throws). */
async function markRoadblockPhotoSynced(
  photoId: string,
  storagePath: string
): Promise<void> {
  try {
    const rec = await idbGet<RoadblockPhoto>('photos', photoId);
    if (rec) {
      await idbPut('photos', {
        ...rec,
        storagePath,
        syncedAt: new Date().toISOString(),
      });
    }
  } catch {
    // Non-fatal: the server row exists, so the next push is idempotent.
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

/** Number of photos awaiting upload: stand-alone 'photo' and
 *  'roadblock_photo' queue items plus photos attached to pending inspection
 *  drafts (they ride with the inspection push). Drives the "N photos
 *  awaiting upload" line in the Sync tab. */
export async function pendingPhotos(): Promise<number> {
  const [q, drafts] = await Promise.all([
    idbGetAll<SyncQueueItem>('syncQueue'),
    idbGetAll<InspectionDraft>('drafts'),
  ]);
  const queued = q.filter(
    (i) => i.kind === 'photo' || i.kind === 'roadblock_photo'
  ).length;
  const inDrafts = drafts
    .filter((d) => d.sync_status === 'pending')
    .reduce((n, d) => n + (d.photos?.length ?? 0), 0);
  return queued + inDrafts;
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
