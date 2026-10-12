/**
 * crashSession.ts — in-memory guard for the crash-resume session marker.
 *
 * The marker lives in IndexedDB under settings/'active_session' (a single
 * fixed key), and every access is async. That creates a startup race: the
 * resume/stale-session check can interleave with a session write from an
 * inspection the user just started, and an unconditional `idbDelete` on the
 * fixed key would then wipe the brand-new live marker.
 *
 * This module tracks the session id this app instance currently owns.
 * - `markSessionLive(id)` must be called SYNCHRONOUSLY (before the first
 *   await) when a session write is initiated, so even fire-and-forget
 *   `void saveActiveSession(...)` calls establish ownership immediately.
 * - `isLiveSession(id)` lets the startup check and the heartbeat skip or
 *   protect the live marker: a live marker is never bannered and never
 *   deleted by its own startup's cleanup.
 * - `markSessionEnded(id?)` must be called synchronously when the session is
 *   intentionally cleared (submit/cancel/dismiss), so an in-flight heartbeat
 *   can't resurrect the deleted marker.
 *
 * This is purely in-memory and resets on reload, so a genuinely crashed
 * session from a previous launch is never considered live — it still gets
 * the Resume/Dismiss banner. All local state; no network dependency.
 */

let liveSessionId: string | null = null;

/** Generate a unique id for a newly created session marker. */
export function newSessionId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Claim ownership of a session id. Call synchronously before the IDB write. */
export function markSessionLive(id: string): void {
  liveSessionId = id;
}

/** The session id owned by this app instance, or null when none is active. */
export function getLiveSessionId(): string | null {
  return liveSessionId;
}

/** True when the given marker belongs to this app instance's live session. */
export function isLiveSession(id: string | undefined | null): boolean {
  return !!id && id === liveSessionId;
}

/**
 * Release ownership. Call synchronously when the session is intentionally
 * ended. With no id given, releases whatever is live.
 */
export function markSessionEnded(id?: string): void {
  if (id === undefined || liveSessionId === id) {
    liveSessionId = null;
  }
}

/**
 * Identity check for two session records: same session only if the ids
 * match. Markers written before `session_id` existed fall back to
 * started_at + asset_id. Used to verify a marker is still the exact session
 * a check inspected before deleting it (the fixed IDB key means an
 * unconditional delete could otherwise kill a newer session).
 */
export function isSameSession(
  a: { session_id?: string; started_at?: string; asset_id?: string } | undefined | null,
  b: { session_id?: string; started_at?: string; asset_id?: string } | undefined | null
): boolean {
  if (!a || !b) return false;
  if (a.session_id || b.session_id) return a.session_id === b.session_id;
  return a.started_at === b.started_at && a.asset_id === b.asset_id;
}
