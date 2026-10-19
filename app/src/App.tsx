import { useEffect, useRef, useState } from 'react';
import { HashRouter, Routes, Route, Link, useLocation } from 'react-router-dom';
import FieldApp from './field/FieldApp';
import Dashboard from './dashboard/Dashboard';
import StateDashboard from './dashboard/StateDashboard';
import LoginScreen from './components/LoginScreen';
import UpdateButton from './components/UpdateButton';
import {
  clearSession,
  fetchAdminProfileStrict,
  getAdminProfile,
  getSession,
  restoreAdminSession,
  setSession as persistAuthSession,
  type AuthSession,
} from './lib/auth';
import type { AdminProfile } from './types';
import { getSupabase } from './lib/supabase';
import { setCurrentFirmId } from './lib/firm';

function sameAdminProfile(
  a: AdminProfile | null,
  b: AdminProfile | null,
): boolean {
  if (!a || !b) return a === b;
  return (
    a.role === b.role &&
    a.email === b.email &&
    (a.stateCode ?? null) === (b.stateCode ?? null) &&
    (a.firmId ?? null) === (b.firmId ?? null)
  );
}

function adminRoleLabel(profile: AdminProfile): string {
  switch (profile.role) {
    case 'super_admin':
      return 'Super Admin';
    case 'state_admin':
      return `State Admin${profile.stateCode ? ` — ${profile.stateCode}` : ''}`;
    case 'firm_admin':
      return 'Firm Admin';
  }
}

// HashRouter: required for Capacitor file:// URLs (BrowserRouter breaks on device).
function EnvNav({
  session,
  profile,
  onSignOut,
}: {
  session: AuthSession;
  profile: AdminProfile | null;
  onSignOut: () => void;
}) {
  const loc = useLocation();
  const navRef = useRef<HTMLElement | null>(null);
  // Publish the nav's real height (it wraps to two rows on narrow
  // screens) so the field app's fixed full-screen map can start below
  // it instead of sliding underneath and hiding its top controls.
  useEffect(() => {
    const el = navRef.current;
    if (!el) return;
    const publish = () => {
      document.documentElement.style.setProperty(
        '--app-header-height',
        `${el.offsetHeight}px`,
      );
    };
    publish();
    const ro = new ResizeObserver(publish);
    ro.observe(el);
    return () => {
      ro.disconnect();
      document.documentElement.style.setProperty('--app-header-height', '0px');
    };
  }, []);
  const path = loc.pathname;
  const active = path.startsWith('/statedashboard')
    ? 'state'
    : path.startsWith('/dashboard')
      ? 'firm'
      : 'field';
  const role = profile?.role ?? 'firm_admin';
  return (
    <nav className="env-nav" ref={navRef}>
      <span className="brandmark" aria-label="Strinteg">
        <span className="str">STR</span>INTEG
      </span>
      {session.kind === 'firm_admin' && profile ? (
        <>
          {role !== 'state_admin' && (
            <Link to="/" className={`env-link${active === 'field' ? ' active' : ''}`}>
              Field app
            </Link>
          )}
          <Link
            to="/dashboard"
            className={`env-link${active === 'firm' ? ' active' : ''}`}
          >
            Firm ops
          </Link>
          {role !== 'firm_admin' && (
            <Link
              to="/statedashboard"
              className={`env-link${active === 'state' ? ' active' : ''}`}
            >
              State ops
            </Link>
          )}
          <span className="env-user">{adminRoleLabel(profile)}</span>
        </>
      ) : (
        <span className="env-user">Signed in as {session.kind === 'inspector' ? session.inspectorName : ''}</span>
      )}
      <UpdateButton />
      <button type="button" className="env-signout" onClick={onSignOut}>
        Sign out
      </button>
    </nav>
  );
}

/**
 * Login is the front door. No session → <LoginScreen/> full-screen, no nav.
 * Inspector session → field app only. Admin sessions route by role
 * (migration 015): super_admin → everything; state_admin → state +
 * firm ops scoped to their state; firm_admin → field app + firm ops
 * scoped to their firm.
 */
export default function App() {
  // undefined = still checking; null = no session (show login).
  const [session, setSession] = useState<AuthSession | null | undefined>(
    undefined,
  );

  useEffect(() => {
    (async () => {
      let s = getSession();
      if (s?.kind === 'firm_admin') {
        let restored = false;
        try {
          restored = await restoreAdminSession();
        } catch {
          // Admin data calls will report offline instead.
        }
        // Self-heal the stored role profile. It was resolved once at
        // sign-in and baked into the session; if that fetch failed, the
        // session silently carries the legacy firm_admin default and
        // role-gated UI (e.g. State ops) stays hidden until sign-out.
        // After a successful session restore, re-resolve the profile and
        // adopt it ONLY when a real emg_admins row comes back — a
        // failed/offline re-check must never downgrade a stored
        // super_admin/state_admin profile, so any error or null result
        // leaves the stored session exactly as-is.
        if (restored) {
          try {
            const sb = getSupabase();
            const { data } = (await sb?.auth.getUser()) ?? { data: null };
            const user = data?.user;
            if (sb && user) {
              const fresh = await fetchAdminProfileStrict(user.id, s.email);
              if (fresh && !sameAdminProfile(fresh, getAdminProfile(s))) {
                const healed: AuthSession = {
                  ...s,
                  profile: fresh,
                  firmId: fresh.firmId ?? undefined,
                };
                // A session returned by getSession() at launch came
                // from localStorage (in-memory starts empty), so it was
                // a remembered session — persist the healed profile the
                // same way so the fresh role sticks across launches.
                persistAuthSession(healed, true);
                // Mirror sign-in: a firm-bound admin is scoped to their
                // firm everywhere firm scoping applies.
                if (fresh.role === 'firm_admin' && fresh.firmId) {
                  setCurrentFirmId(fresh.firmId);
                }
                s = healed;
              }
            }
          } catch {
            // Re-check failed — keep the stored session exactly as-is.
          }
        }
      }
      setSession(s);
    })();
  }, []);

  const handleSignOut = () => {
    clearSession();
    try {
      void getSupabase()?.auth.signOut();
    } catch {
      // ignore
    }
    setSession(null);
  };

  if (session === undefined) {
    return (
      <div className="login-screen">
        <div className="login-loading">Loading…</div>
      </div>
    );
  }

  if (!session) {
    return <LoginScreen onSignedIn={setSession} />;
  }

  const profile = getAdminProfile(session);
  const role = profile?.role ?? 'firm_admin';

  return (
    <HashRouter>
      <EnvNav session={session} profile={profile} onSignOut={handleSignOut} />
      <Routes>
        {session.kind === 'inspector' ? (
          <Route
            path="/*"
            element={<FieldApp inspectorName={session.inspectorName} />}
          />
        ) : role === 'state_admin' ? (
          <>
            <Route
              path="/dashboard/*"
              element={
                <Dashboard firmId={session.firmId} adminProfile={profile} />
              }
            />
            <Route
              path="/*"
              element={<StateDashboard stateScope={profile?.stateCode ?? null} />}
            />
          </>
        ) : role === 'super_admin' ? (
          <>
            <Route path="/statedashboard/*" element={<StateDashboard />} />
            <Route
              path="/dashboard/*"
              element={
                <Dashboard firmId={session.firmId} adminProfile={profile} />
              }
            />
            <Route path="/*" element={<FieldApp />} />
          </>
        ) : (
          <>
            <Route
              path="/dashboard/*"
              element={
                <Dashboard firmId={session.firmId} adminProfile={profile} />
              }
            />
            <Route path="/*" element={<FieldApp />} />
          </>
        )}
      </Routes>
    </HashRouter>
  );
}
