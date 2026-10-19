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
import { setCurrentFirmId, syncFirms, syncInspectors } from './firm';
import type { AdminProfile, Inspector } from '../types';

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
      /** Role profile from emg_admins (migration 015). Optional so
       *  sessions stored before roles existed still parse; readers go
       *  through getAdminProfile(), which applies the legacy default. */
      profile?: AdminProfile;
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

interface EmgAdminRow {
  role: AdminProfile['role'];
  state_code: string | null;
  firm_id: string | null;
}

/**
 * Resolve the signed-in admin's role profile from emg_admins
 * (migration 015): look up by auth_user_id first, then by email
 * (linking auth_user_id when found by email so later lookups hit the
 * id path).
 *
 * If NO row exists — or the table is unreachable (migration not run
 * yet) — fall back to the LEGACY behavior: firm_admin with no firm
 * binding, picking their firm in the dashboard. Nobody is locked out
 * by a missing role row.
 */
export async function fetchAdminProfile(
  authUserId: string,
  email: string,
): Promise<AdminProfile> {
  const resolved = await fetchAdminProfileStrict(authUserId, email);
  return resolved ?? { role: 'firm_admin', email };
}

/**
 * Strict variant of fetchAdminProfile: returns the resolved profile ONLY
 * when a real emg_admins row was found. Returns null when no row exists,
 * the table is unreachable, or Supabase is not configured — i.e. exactly
 * the cases where fetchAdminProfile substitutes the legacy default.
 *
 * Used by the launch-time self-heal in App.tsx, which must never let a
 * failed or offline re-check overwrite (downgrade) a stored profile.
 */
export async function fetchAdminProfileStrict(
  authUserId: string,
  email: string,
): Promise<AdminProfile | null> {
  const sb = getSupabase();
  if (!sb) return null;
  try {
    let row: EmgAdminRow | null = null;
    const byId = await sb
      .from('emg_admins')
      .select('role,state_code,firm_id')
      .eq('auth_user_id', authUserId)
      .maybeSingle();
    if (!byId.error) row = (byId.data as EmgAdminRow | null) ?? null;
    if (!row) {
      const byEmail = await sb
        .from('emg_admins')
        .select('role,state_code,firm_id')
        .eq('email', email)
        .maybeSingle();
      if (byEmail.error) return null;
      row = (byEmail.data as EmgAdminRow | null) ?? null;
      if (row) {
        // Best-effort link so the next sign-in finds the row by id.
        try {
          await sb
            .from('emg_admins')
            .update({ auth_user_id: authUserId })
            .eq('email', email);
        } catch {
          // ignore — email fallback keeps working
        }
      }
    }
    if (!row) return null;
    return {
      role: row.role,
      email,
      stateCode: row.state_code ?? null,
      firmId: row.firm_id ?? null,
    };
  } catch {
    return null;
  }
}

/**
 * The admin profile for a session (or the current session when none is
 * passed). Sessions stored before roles existed get the legacy default
 * (firm_admin, unbound). Returns null for inspector / no session.
 */
export function getAdminProfile(
  session?: AuthSession | null,
): AdminProfile | null {
  const s = session === undefined ? getSession() : session;
  if (!s || s.kind !== 'firm_admin') return null;
  if (s.profile) return s.profile;
  return {
    role: 'firm_admin',
    email: s.email,
    firmId: s.firmId ?? null,
    stateCode: null,
  };
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
  // Resolve the role profile (super / state / firm admin) from
  // emg_admins. Missing row → legacy firm_admin default (see
  // fetchAdminProfile) — never a lockout.
  const cleanEmail = email.trim();
  const profile = await fetchAdminProfile(
    data.user?.id ?? '',
    cleanEmail,
  ).catch(() => ({ role: 'firm_admin', email: cleanEmail }) as AdminProfile);
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
  // A firm-bound admin lands on their firm everywhere firm scoping applies.
  if (profile.role === 'firm_admin' && profile.firmId) {
    setCurrentFirmId(profile.firmId);
  }
  return {
    kind: 'firm_admin',
    email: cleanEmail,
    firmId: profile.firmId ?? undefined,
    profile,
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
