import { useEffect, useState } from 'react';
import {
  getCachedFirms,
  getFirmInspectors,
  syncFirms,
  syncInspectors,
  setCurrentFirmId,
} from '../lib/firm';
import {
  setSession,
  signInInspector,
  signInFirmAdmin,
  type AuthSession,
} from '../lib/auth';
import { isOnline, isSupabaseConfigured } from '../lib/supabase';
import type { Firm, Inspector } from '../types';

interface LoginScreenProps {
  onSignedIn: (session: AuthSession) => void;
}

type Tab = 'inspector' | 'admin';

export default function LoginScreen({ onSignedIn }: LoginScreenProps) {
  const [tab, setTab] = useState<Tab>('inspector');
  const [firms, setFirms] = useState<Firm[]>([]);
  const [firmId, setFirmId] = useState('');
  const [roster, setRoster] = useState<Inspector[]>([]);
  const [inspectorId, setInspectorId] = useState('');
  const [pin, setPin] = useState('');
  const [remember, setRemember] = useState(true);
  const [adminEmail, setAdminEmail] = useState('');
  const [adminPassword, setAdminPassword] = useState('');
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Load firms: when online, always refresh from the server (syncFirms
  // also rewrites the cache) so a stale cached list can't hide firms that
  // were added later. Fall back to the cache when offline or the sync
  // fails — offline PIN login from cache keeps working as before.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        let list: Firm[] | null = null;
        if (isOnline() && isSupabaseConfigured()) {
          setStatus('Downloading firm list…');
          try {
            list = await syncFirms();
          } catch {
            list = null; // sync failed — fall back to the cache below
          }
          if (!cancelled) setStatus(null);
        }
        if (list === null) list = await getCachedFirms();
        if (!cancelled) {
          setFirms(list);
          if (list.length > 0) setFirmId(list[0].id);
        }
      } catch {
        if (!cancelled) setStatus(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Load the selected firm's roster: when online, always refresh from the
  // server (syncInspectors also rewrites the cached roster) so a stale
  // cache can't hide inspectors added later. Fall back to the cache when
  // offline or the sync fails — offline PIN login keeps working as before.
  useEffect(() => {
    if (!firmId) {
      setRoster([]);
      setInspectorId('');
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        let list: Inspector[] | null = null;
        if (isOnline() && isSupabaseConfigured()) {
          setStatus('Downloading team roster…');
          try {
            await syncInspectors(firmId);
            list = await getFirmInspectors(firmId);
          } catch {
            list = null; // sync failed — fall back to the cache below
          }
          if (!cancelled) setStatus(null);
        }
        if (list === null) list = await getFirmInspectors(firmId);
        if (!cancelled) {
          setRoster(list);
          setInspectorId((prev) =>
            list.some((i) => i.id === prev) ? prev : (list[0]?.id ?? ''),
          );
        }
      } catch {
        if (!cancelled) setStatus(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [firmId]);

  const selectedInspector = roster.find((i) => i.id === inspectorId) ?? null;
  const offline = !isOnline();

  const handleInspectorSignIn = async () => {
    setError(null);
    if (!selectedInspector) {
      setError('Choose your name from the list.');
      return;
    }
    if (!/^\d{4,8}$/.test(pin.trim())) {
      setError('Enter your 4–8 digit PIN.');
      return;
    }
    // Offline path: roster + hash came from the local cache — no network.
    try {
      setBusy(true);
      const firmName = firms.find((f) => f.id === firmId)?.name ?? '';
      const session = await signInInspector(
        selectedInspector,
        pin.trim(),
        firmName,
      );
      setSession(session, remember);
      setCurrentFirmId(firmId);
      onSignedIn(session);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Sign-in failed. Try again.');
    } finally {
      setBusy(false);
    }
  };

  const handleAdminSignIn = async () => {
    setError(null);
    if (!adminEmail.trim() || !adminPassword) {
      setError('Enter your email and password.');
      return;
    }
    try {
      setBusy(true);
      const session = await signInFirmAdmin(adminEmail, adminPassword, remember);
      setSession(session, remember);
      onSignedIn(session);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Sign-in failed. Try again.');
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
        <p>Sign in to start your shift.</p>
      </header>

      <main className="login-main">
        <div className="card">
          <div className="login-tabs" role="tablist" aria-label="Sign in as">
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'inspector'}
              className={tab === 'inspector' ? 'active' : ''}
              onClick={() => {
                setTab('inspector');
                setError(null);
              }}
            >
              Inspector
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'admin'}
              className={tab === 'admin' ? 'active' : ''}
              onClick={() => {
                setTab('admin');
                setError(null);
              }}
            >
              Admin
            </button>
          </div>

          {tab === 'inspector' ? (
            <div role="tabpanel">
              {offline && (
                <div className="login-note" role="status">
                  Offline — sign-in works from the team roster already on this
                  device.
                </div>
              )}

              <div className="field">
                <label htmlFor="login-firm">Firm</label>
                <select
                  id="login-firm"
                  value={firmId}
                  onChange={(e) => setFirmId(e.target.value)}
                  disabled={busy || firms.length === 0}
                >
                  {firms.length === 0 && (
                    <option value="">No firms on this device</option>
                  )}
                  {firms.map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.name}
                    </option>
                  ))}
                </select>
              </div>

              <div className="field">
                <label htmlFor="login-inspector">Your name</label>
                <select
                  id="login-inspector"
                  value={inspectorId}
                  onChange={(e) => setInspectorId(e.target.value)}
                  disabled={busy || roster.length === 0}
                >
                  {roster.length === 0 && (
                    <option value="">No roster on this device</option>
                  )}
                  {roster.map((i) => (
                    <option key={i.id} value={i.id}>
                      {i.name}
                    </option>
                  ))}
                </select>
              </div>

              {roster.length === 0 && offline && firmId && (
                <div className="login-error" role="alert">
                  Connect to the internet to download your team roster first.
                </div>
              )}

              {selectedInspector && !selectedInspector.pin_hash && (
                <div className="login-note" role="status">
                  No PIN set yet — ask your firm admin to set one in the Firm
                  ops dashboard.
                </div>
              )}

              <div className="field">
                <label htmlFor="login-pin">PIN</label>
                <input
                  id="login-pin"
                  type="password"
                  inputMode="numeric"
                  autoComplete="off"
                  value={pin}
                  onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
                  placeholder="4–8 digits"
                  maxLength={8}
                  disabled={busy}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void handleInspectorSignIn();
                  }}
                />
              </div>

              <label className="login-remember">
                <input
                  type="checkbox"
                  checked={remember}
                  onChange={(e) => setRemember(e.target.checked)}
                />
                Remember me on this device
              </label>

              <button
                type="button"
                className="btn btn-primary login-submit"
                onClick={() => void handleInspectorSignIn()}
                disabled={busy || !selectedInspector}
              >
                {busy ? 'Signing in…' : 'Sign in'}
              </button>

              {status && <div className="muted login-status">{status}</div>}
              {error && (
                <div className="login-error" role="alert">
                  {error}
                </div>
              )}
            </div>
          ) : (
            <div role="tabpanel">
              {offline && (
                <div className="login-note" role="status">
                  Admin sign-in requires an internet connection.
                </div>
              )}

              <div className="field">
                <label htmlFor="login-email">Email</label>
                <input
                  id="login-email"
                  type="email"
                  autoComplete="username"
                  value={adminEmail}
                  onChange={(e) => setAdminEmail(e.target.value)}
                  placeholder="you@firm.com"
                  disabled={busy}
                />
              </div>

              <div className="field">
                <label htmlFor="login-password">Password</label>
                <input
                  id="login-password"
                  type="password"
                  autoComplete="current-password"
                  value={adminPassword}
                  onChange={(e) => setAdminPassword(e.target.value)}
                  disabled={busy}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void handleAdminSignIn();
                  }}
                />
              </div>

              <label className="login-remember">
                <input
                  type="checkbox"
                  checked={remember}
                  onChange={(e) => setRemember(e.target.checked)}
                />
                Remember me on this device
              </label>

              <button
                type="button"
                className="btn btn-primary login-submit"
                onClick={() => void handleAdminSignIn()}
                disabled={busy || offline}
              >
                {busy ? 'Signing in…' : 'Sign in'}
              </button>

              {error && (
                <div className="login-error" role="alert">
                  {error}
                </div>
              )}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
