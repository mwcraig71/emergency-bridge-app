// Firm multi-tenancy scaffolding.
//
// Model (migration 009):
//   firms         — tenants; each firm owns groups of bridges.
//   inspectors    — per-firm roster (name + pin_hash for the offline PIN
//                   login; the hash is selected and cached so verification
//                   works with zero network calls).
//   firm_bridges  — mapping of shared NBI bridges to firms.
//
// Auth (built — see lib/auth.ts + components/LoginScreen.tsx):
//   * Firm admin login: Supabase Auth email+password (online only).
//   * Inspector login: 4–8 digit PIN verified locally against the cached
//     roster. Works offline — guaranteed access, no network dependency.
//
// When no session exists, App.tsx gates on the login screen; after an
// inspector sign-in, getCurrentFirmId() returns the signed-in firm and every
// firm-scoped query filters to it.
import { getSupabase, isSupabaseConfigured } from './supabase';
import { idbBulkPut, idbGetAll } from './idb';
import type { Firm, Inspector } from '../types';

const FIRM_ID_STORAGE_KEY = 'emg.firm_id';

const FIRM_SELECT = 'id,name,created_at';
// The salted SHA-256 PIN hash IS selected by clients: it is cached in
// IndexedDB so offline inspector login can verify PINs with zero network
// calls (see lib/auth.ts). The salt is the inspector id (stored in the same
// row), so the hash never exposes the plaintext PIN — never log, display,
// or transmit plaintext PINs. TODO: tighten RLS to column-level grants
// (deny pin_hash to anon) once the auth model matures; RLS is `using (true)`
// open today so roster syncs can read it.
const INSPECTOR_SELECT = 'id,firm_id,name,pin_hash,created_at';

/**
 * The currently active firm, or null when no firm is selected
 * (current field flow — no login UI yet).
 */
export function getCurrentFirmId(): string | null {
  try {
    const v = localStorage.getItem(FIRM_ID_STORAGE_KEY);
    return v && v.trim() ? v.trim() : null;
  } catch {
    return null;
  }
}

/** Persist the active firm (used by the future login UI). */
export function setCurrentFirmId(id: string | null): void {
  try {
    if (id && id.trim()) localStorage.setItem(FIRM_ID_STORAGE_KEY, id.trim());
    else localStorage.removeItem(FIRM_ID_STORAGE_KEY);
  } catch {
    // Storage unavailable — firm scoping silently disabled.
  }
}

/**
 * Add a firm_id equality filter to a PostgREST query when a firm is active.
 * Pass-through when no firm is set, so current behavior is unchanged.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function withFirmFilter(query: any, firmId?: string | null): any {
  const fid = firmId ?? getCurrentFirmId();
  return fid ? query.eq('firm_id', fid) : query;
}

/**
 * Download the firm list into the IndexedDB `firms` store.
 * No-op offline.
 */
export async function syncFirms(): Promise<Firm[]> {
  const sb = getSupabase();
  if (!sb || !isSupabaseConfigured()) return [];
  const { data, error } = await sb
    .from('firms')
    .select(FIRM_SELECT)
    .order('name');
  if (error) throw error;
  const rows = ((data ?? []) as unknown as Firm[]).map((f) => ({
    id: String(f.id),
    name: String(f.name ?? ''),
    created_at: String(f.created_at ?? ''),
  }));
  await idbBulkPut('firms', rows);
  return rows;
}

/**
 * Download a firm's inspector roster into the IndexedDB `inspectors` store,
 * INCLUDING pin_hash (needed for offline PIN verification — see lib/auth.ts).
 * Pass an explicit firmId or rely on the current firm; no-op when unset.
 */
export async function syncInspectors(
  firmId?: string | null,
): Promise<Inspector[]> {
  const sb = getSupabase();
  if (!sb || !isSupabaseConfigured()) return [];
  const fid = firmId ?? getCurrentFirmId();
  if (!fid) return [];
  const { data, error } = await sb
    .from('inspectors')
    .select(INSPECTOR_SELECT)
    .eq('firm_id', fid)
    .order('name');
  if (error) throw error;
  const rows = ((data ?? []) as unknown as Inspector[]).map((r) => ({
    id: String(r.id),
    firm_id: String(r.firm_id),
    name: String(r.name ?? ''),
    pin_hash: r.pin_hash ? String(r.pin_hash) : null,
    created_at: String(r.created_at ?? ''),
  }));
  // Replace the cached roster for this firm.
  const existing = await idbGetAll<Inspector>('inspectors');
  const keep = existing.filter((i) => i.firm_id !== fid);
  await idbBulkPut('inspectors', [...keep, ...rows]);
  return rows;
}

/**
 * Inspector roster for a firm, from the local cache (works offline).
 * Used by the future offline PIN login screen.
 */
export async function getFirmInspectors(
  firmId?: string | null,
): Promise<Inspector[]> {
  const fid = firmId ?? getCurrentFirmId();
  if (!fid) return [];
  const all = await idbGetAll<Inspector>('inspectors');
  return all
    .filter((i) => i.firm_id === fid)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Asset IDs belonging to a firm (from firm_bridges). Server read;
 * returns [] offline or when no firm is set.
 */
export async function getFirmBridges(
  firmId?: string | null,
): Promise<string[]> {
  const sb = getSupabase();
  if (!sb || !isSupabaseConfigured()) return [];
  const fid = firmId ?? getCurrentFirmId();
  if (!fid) return [];
  const { data, error } = await sb
    .from('firm_bridges')
    .select('asset_id')
    .eq('firm_id', fid);
  if (error) throw error;
  return ((data ?? []) as unknown as { asset_id: string }[]).map((r) =>
    String(r.asset_id),
  );
}

/**
 * Cached firms (from the last syncFirms). Works offline.
 */
export async function getCachedFirms(): Promise<Firm[]> {
  const all = await idbGetAll<Firm>('firms');
  return all.sort((a, b) => a.name.localeCompare(b.name));
}
