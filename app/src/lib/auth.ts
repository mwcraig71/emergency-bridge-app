// Authentication for the Emergency Bridge Inspection app.
//
// Two login kinds:
//   * Inspector — 4–8 digit PIN verified locally against the cached roster
//     (IndexedDB `inspectors` store). Works fully OFFLINE — zero network
//     calls during sign-in. This is the field login; guaranteed access.
//   * Firm admin — Supabase Auth email+password. Requires network.
//
// PIN security:
//   * PINs are SHA-256 hashed client-side, salted with the inspector id.
//   * Plaintext PINs are NEVER stored or transmitted — no logs, no
//     localStorage, no IndexedDB. Only the hash is written (on admin set)
//     and cached (for offline verification).
import { getSupabase, isOnline, isSupabaseConfigured } from './supabase';
import { syncFirms, syncInspectors } from './firm';
import type { Inspector } from '../types';

export type AuthSession =
  | {
      kind: 'inspector';
      inspectorId: string;
      inspectorName: string;
      firmId: string;
      firmName: string;
      rememberedAt: string;
    }
  | {
      kind: 'firm_admin';
      email: string;
      /** Firm the admin belongs to, when known. */
      firmId?: string;
      rememberedAt: string;
    };

const AUTH_SESSION_KEY = 'emg.auth_session';
const ADMIN_SESSION_KEY = 'emg.admin_session';

// In-memory session when "Remember me" is off.
let memorySession: AuthSession | null = null;

/**
 * SHA-256 hash of a PIN, salted with the inspector id.
 * Salt lives in the same row as the hash (it is not secret); its job is
 * to make identical PINs across inspectors hash differently and to
 * defeat precomputed tables.
 */
export async function hashPin(pin: string, salt: string): Promise<string> {
  const input = new TextEncoder().encode(`${salt}:${pin}`);
  const digest = await crypto.subtle.digest('SHA-256', input);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** Constant-time-ish comparison of a PIN against a stored hash. */
export async function verifyPin(
  pin: string,
  inspectorId: string,
  expectedHash: string | null | undefined,
): Promise<boolean> {
  if (!expectedHash) return false;
  const computed = await hashPin(pin, inspectorId);
  if (computed.length !== expectedHash.length) return false;
  let diff = 0;
  for (let i = 0; i < computed.length; i++) {
    diff |= computed.charCodeAt(i) ^ expectedHash.charCodeAt(i);
  }
  return diff === 0;
}

/** Current session: memory first, then the remembered session in localStorage. */
export function getSession(): AuthSession | null {
  if (memorySession) return memorySession;
  try {
    const raw = localStorage.getItem(AUTH_SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as AuthSession;
    if (!parsed || (parsed.kind !== 'inspector' && parsed.kind !== 'firm_admin'))
      return null;
    memorySession = parsed;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Store a session. Persisted to localStorage ONLY when `remember` is true;
 * otherwise kept in memory (module variable) and lost on reload.
 */
export function setSession(session: AuthSession, remember: boolean): void {
  memorySession = session;
  try {
    if (remember) localStorage.setItem(AUTH_SESSION_KEY, JSON.stringify(session));
    else localStorage.removeItem(AUTH_SESSION_KEY);
  } catch {
    // Storage unavailable — session lives in memory only.
  }
}

/** Clear the session (memory + remembered copies). Sign-out path. */
export function clearSession(): void {
  memorySession = null;
  try {
    localStorage.removeItem(AUTH_SESSION_KEY);
    localStorage.removeItem(ADMIN_SESSION_KEY);
  } catch {
    // ignore
  }
}

/**
 * Inspector sign-in. Verifies the PIN against the LOCALLY CACHED roster
 * (IndexedDB) — this function makes zero network calls and works offline.
 * Throws a user-friendly Error on failure.
 */
export async function signInInspector(
  inspector: Inspector,
  pin: string,
  firmName: string,
): Promise<AuthSession> {
  if (!inspector.pin_hash) {
    throw new Error(
      'No PIN set yet — ask your firm admin to set one in the Firm ops dashboard.',
    );
  }
  const ok = await verifyPin(pin, inspector.id, inspector.pin_hash);
  if (!ok) throw new Error('Incorrect PIN. Check the number and try again.');
  return {
    kind: 'inspector',
    inspectorId: inspector.id,
    inspectorName: inspector.name,
    firmId: inspector.firm_id,
    firmName,
    rememberedAt: new Date().toISOString(),
  };
}

function friendlyAuthError(message: string): string {
  if (/invalid login credentials/i.test(message))
    return 'Email or password is incorrect.';
  if (/email not confirmed/i.test(message))
    return 'This email address has not been confirmed yet.';
  return message || 'Sign-in failed. Try again.';
}

/**
 * Firm admin sign-in (Supabase Auth). Requires network.
 * The supabase client runs with persistSession:false, so we persist the
 * returned session ourselves under `emg.admin_session` when remembered and
 * restore it with `restoreAdminSession()` on the next launch.
 */
export async function signInFirmAdmin(
  email: string,
  password: string,
  remember: boolean,
): Promise<AuthSession> {
  const sb = getSupabase();
  if (!sb || !isSupabaseConfigured())
    throw new Error('Supabase is not configured in this build.');
  if (!isOnline())
    throw new Error('Firm admin sign-in needs an internet connection.');
  const { data, error } = await sb.auth.signInWithPassword({
    email: email.trim(),
    password,
  });
  if (error) throw new Error(friendlyAuthError(error.message));
  if (!data.session) throw new Error('Sign-in failed. Try again.');
  if (remember) {
    try {
      localStorage.setItem(
        ADMIN_SESSION_KEY,
        JSON.stringify({
          access_token: data.session.access_token,
          refresh_token: data.session.refresh_token,
        }),
      );
    } catch {
      // Storage unavailable — admin session lasts this visit only.
    }
  } else {
    try {
      localStorage.removeItem(ADMIN_SESSION_KEY);
    } catch {
      // ignore
    }
  }
  return {
    kind: 'firm_admin',
    email: email.trim(),
    rememberedAt: new Date().toISOString(),
  };
}

/**
 * Restore a remembered firm-admin Supabase session after app relaunch.
 * Returns true when the restore succeeded; false offline or when there is
 * nothing valid to restore (the login gate may still accept the remembered
 * app session — admin data calls will simply report offline).
 */
export async function restoreAdminSession(): Promise<boolean> {
  const sb = getSupabase();
  if (!sb) return false;
  try {
    const raw = localStorage.getItem(ADMIN_SESSION_KEY);
    if (!raw) return false;
    const { access_token, refresh_token } = JSON.parse(raw) as {
      access_token?: string;
      refresh_token?: string;
    };
    if (!access_token || !refresh_token) return false;
    const { error } = await sb.auth.setSession({
      access_token,
      refresh_token,
    });
    if (error) {
      try {
        localStorage.removeItem(ADMIN_SESSION_KEY);
      } catch {
        // ignore
      }
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

/** When online, download firms then the selected firm's roster for login. */
export async function syncRosterForLogin(
  firmId?: string | null,
): Promise<void> {
  await syncFirms();
  await syncInspectors(firmId);
}
