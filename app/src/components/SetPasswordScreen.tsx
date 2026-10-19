import { useEffect, useRef, useState } from 'react';
import { getSupabase } from '../lib/supabase';
import { clearSession } from '../lib/auth';

interface SetPasswordScreenProps {
  accessToken: string;
  refreshToken: string;
  /** Leave this screen and render the normal app (login or session). */
  onDone: () => void;
}

type Phase = 'verifying' | 'ready' | 'success' | 'invalid';

/**
 * Standalone screen shown when the app is opened from a Supabase
 * password-recovery link (see main.tsx — the link's tokens arrive in
 * the URL hash and are intercepted before the router sees them).
 *
 * Flow: adopt the recovery session with setSession(), let the user set
 * a new password via updateUser(), then sign out and clear any stored
 * app session so the next sign-in uses the new password. A bad or
 * expired link lands on a plain error with a way out — the user is
 * never trapped here.
 */
export default function SetPasswordScreen({
  accessToken,
  refreshToken,
  onDone,
}: SetPasswordScreenProps) {
  const [phase, setPhase] = useState<Phase>('verifying');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const startedRef = useRef(false);

  // Adopt the recovery session once. Any failure means the link is
  // invalid or expired.
  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    (async () => {
      const sb = getSupabase();
      if (!sb) {
        setPhase('invalid');
        return;
      }
      try {
        const { error: sessionError } = await sb.auth.setSession({
          access_token: accessToken,
          refresh_token: refreshToken,
        });
        setPhase(sessionError ? 'invalid' : 'ready');
      } catch {
        setPhase('invalid');
      }
    })();
  }, [accessToken, refreshToken]);

  const handleSubmit = async () => {
    setError(null);
    if (password.length < 6) {
      setError('Use at least 6 characters for the new password.');
      return;
    }
    if (password !== confirm) {
      setError('The two passwords do not match.');
      return;
    }
    const sb = getSupabase();
    if (!sb) {
      setPhase('invalid');
      return;
    }
    try {
      setBusy(true);
      const { error: updateError } = await sb.auth.updateUser({ password });
      if (updateError) {
        setError(updateError.message || 'Could not set the password. Try again.');
        return;
      }
      // Password is set: drop the recovery session and any remembered
      // app session so the next sign-in uses the new password.
      try {
        await sb.auth.signOut();
      } catch {
        // ignore — local session state is cleared below regardless
      }
      clearSession();
      setPhase('success');
    } catch {
      setError('Could not set the password. Check your connection and try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-screen">
      <header className="login-header">
        <div className="login-brandrow">
          <span className="brandmark" aria-label="Strinteg">
            <span className="str">STR</span>INTEG
          </span>
          <h1>Emergency Bridge Inspection</h1>
        </div>
        <p>Set a new password for your admin account.</p>
      </header>

      <main className="login-main">
        <div className="card">
          {phase === 'verifying' && (
            <div className="muted login-status">Verifying your link…</div>
          )}

          {phase === 'invalid' && (
            <div>
              <div className="login-error" role="alert">
                This password reset link is invalid or has expired. Ask for a
                new link, or continue to the normal sign-in.
              </div>
              <button
                type="button"
                className="btn btn-primary login-submit"
                onClick={onDone}
              >
                Continue to sign in
              </button>
            </div>
          )}

          {phase === 'success' && (
            <div>
              <div className="login-note" role="status">
                Password set — sign in with your new password.
              </div>
              <button
                type="button"
                className="btn btn-primary login-submit"
                onClick={onDone}
              >
                Sign in
              </button>
            </div>
          )}

          {phase === 'ready' && (
            <div>
              <div className="field">
                <label htmlFor="setpw-new">New password</label>
                <input
                  id="setpw-new"
                  type="password"
                  autoComplete="new-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  disabled={busy}
                />
              </div>

              <div className="field">
                <label htmlFor="setpw-confirm">Confirm new password</label>
                <input
                  id="setpw-confirm"
                  type="password"
                  autoComplete="new-password"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  disabled={busy}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void handleSubmit();
                  }}
                />
              </div>

              <button
                type="button"
                className="btn btn-primary login-submit"
                onClick={() => void handleSubmit()}
                disabled={busy}
              >
                {busy ? 'Setting password…' : 'Set password'}
              </button>

              {error && (
                <div className="login-error" role="alert">
                  {error}
                </div>
              )}

              <button
                type="button"
                className="btn login-submit"
                onClick={onDone}
                disabled={busy}
              >
                Continue to sign in
              </button>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
