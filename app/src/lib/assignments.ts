// Team bridge assignments + notifications.
// Assignments are downloaded wholesale (a few hundred rows per deployment)
// so the field app can warn on cross-assignment inspections offline.
import { getSupabase, isOnline, isSupabaseConfigured } from './supabase';
import { idbBulkPut, idbGetAll, idbPut } from './idb';
import type { AppNotification, Assignment } from '../types';

const ASSIGNMENT_SELECT =
  'id,asset_id,assigned_to,assigned_by,assigned_at,status,' +
  'completed_by,completed_at,notes,created_at';

const NOTIFICATION_SELECT =
  'id,recipient,type,title,message,related_asset_id,created_at,read_at';

function rowToAssignment(r: Record<string, unknown>): Assignment {
  return {
    id: String(r.id),
    asset_id: String(r.asset_id),
    assigned_to: String(r.assigned_to ?? ''),
    assigned_by: (r.assigned_by as string) ?? null,
    assigned_at: String(r.assigned_at ?? ''),
    status: (r.status as Assignment['status']) ?? 'assigned',
    completed_by: (r.completed_by as string) ?? null,
    completed_at: (r.completed_at as string) ?? null,
    notes: (r.notes as string) ?? null,
    created_at: String(r.created_at ?? ''),
  };
}

function rowToNotification(r: Record<string, unknown>): AppNotification {
  return {
    id: String(r.id),
    recipient: String(r.recipient ?? ''),
    type: String(r.type ?? ''),
    title: String(r.title ?? ''),
    message: String(r.message ?? ''),
    related_asset_id: (r.related_asset_id as string) ?? null,
    created_at: String(r.created_at ?? ''),
    read_at: (r.read_at as string) ?? null,
  };
}

/**
 * Download all assignments into the IndexedDB `assignments` store.
 * Server rows are deduped by asset_id, keeping the latest assigned_at —
 * the local store is keyed by asset_id (one active assignment per bridge).
 */
export async function syncAssignments(): Promise<number> {
  const sb = getSupabase();
  if (!sb) throw new Error('Supabase is not configured');
  const { data, error } = await sb
    .from('emg_assignments')
    .select(ASSIGNMENT_SELECT)
    .order('assigned_at', { ascending: false });
  if (error) throw error;
  const seen = new Set<string>();
  const rows: Assignment[] = [];
  for (const r of ((data ?? []) as unknown as Record<string, unknown>[])) {
    const a = rowToAssignment(r);
    if (seen.has(a.asset_id)) continue;
    seen.add(a.asset_id);
    rows.push(a);
  }
  await idbBulkPut('assignments', rows);
  await idbPut('meta', {
    key: 'assignments_synced_at',
    value: new Date().toISOString(),
  });
  return rows.length;
}

/** Download notifications addressed to the inspector into IndexedDB. */
export async function syncNotifications(
  inspectorName: string,
): Promise<number> {
  const sb = getSupabase();
  if (!sb) throw new Error('Supabase is not configured');
  const name = inspectorName.trim();
  if (!name) return 0;
  const { data, error } = await sb
    .from('emg_notifications')
    .select(NOTIFICATION_SELECT)
    .eq('recipient', name)
    .order('created_at', { ascending: false })
    .limit(200);
  if (error) throw error;
  const rows = ((data ?? []) as unknown as Record<string, unknown>[]).map(
    rowToNotification,
  );
  await idbBulkPut('notifications', rows);
  return rows.length;
}

/** Assignments for one inspector, active (non-complete) first. */
export async function getMyAssignments(
  inspectorName: string,
): Promise<Assignment[]> {
  const all = await idbGetAll<Assignment>('assignments');
  const name = inspectorName.trim().toLowerCase();
  const mine = all.filter(
    (a) => a.assigned_to.trim().toLowerCase() === name,
  );
  const rank = (s: Assignment['status']) =>
    s === 'assigned' ? 0 : s === 'in_progress' ? 1 : 2;
  mine.sort(
    (a, b) => rank(a.status) - rank(b.status) || a.asset_id.localeCompare(b.asset_id),
  );
  return mine;
}

/** The current assignment for a bridge, if any. */
export async function getAssignmentForBridge(
  assetId: string,
): Promise<Assignment | undefined> {
  const all = await idbGetAll<Assignment>('assignments');
  return all.find((a) => a.asset_id === assetId);
}

/** Unread notification count for the inspector (local store). */
export async function unreadNotificationCount(
  inspectorName: string,
): Promise<number> {
  const name = inspectorName.trim().toLowerCase();
  const all = await idbGetAll<AppNotification>('notifications');
  return all.filter(
    (n) => n.recipient.trim().toLowerCase() === name && !n.read_at,
  ).length;
}

/**
 * Mark an assignment in_progress when its assignee starts the inspection.
 * Fire-and-forget safe: local update always applies; the server update is
 * best-effort (offline inspectors just stay 'assigned' until next sync).
 */
export async function markAssignmentInProgress(
  assetId: string,
  inspectorName: string,
): Promise<void> {
  const existing = await getAssignmentForBridge(assetId);
  if (
    !existing ||
    existing.status !== 'assigned' ||
    existing.assigned_to.trim().toLowerCase() !== inspectorName.trim().toLowerCase()
  ) {
    return;
  }
  const updated: Assignment = { ...existing, status: 'in_progress' };
  await idbPut('assignments', updated);
  if (!isOnline() || !isSupabaseConfigured()) return;
  try {
    const sb = getSupabase()!;
    await sb
      .from('emg_assignments')
      .update({ status: 'in_progress' })
      .eq('id', existing.id);
  } catch {
    // Best effort — the completion update in pushOne is authoritative.
  }
}

/**
 * Mark a notification read locally and on the server (best-effort).
 */
export async function markNotificationRead(id: string): Promise<void> {
  const all = await idbGetAll<AppNotification>('notifications');
  const found = all.find((n) => n.id === id);
  if (found && !found.read_at) {
    await idbPut('notifications', {
      ...found,
      read_at: new Date().toISOString(),
    });
  }
  if (!isOnline() || !isSupabaseConfigured()) return;
  try {
    const sb = getSupabase()!;
    await sb
      .from('emg_notifications')
      .update({ read_at: new Date().toISOString() })
      .eq('id', id);
  } catch {
    // Best effort.
  }
}
