import { useEffect, useState } from 'react';
import { HashRouter, Routes, Route, Link, useLocation } from 'react-router-dom';
import FieldApp from './field/FieldApp';
import Dashboard from './dashboard/Dashboard';
import StateDashboard from './dashboard/StateDashboard';
import LoginScreen from './components/LoginScreen';
import UpdateButton from './components/UpdateButton';
import {
  clearSession,
  getAdminProfile,
  getSession,
  restoreAdminSession,
  type AuthSession,
} from './lib/auth';
import type { AdminProfile } from './types';
import { getSupabase } from './lib/supabase';

function adminRoleLabel(profile: AdminProfile): string {
  switch (profile.role) {
    case 'super_admin':
      return 'Super admin';
    case 'state_admin':
      return `State admin${profile.stateCode ? ` — ${profile.stateCode}` : ''}`;
    case 'firm_admin':
      return 'Firm admin';
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
  const path = loc.pathname;
  const active = path.startsWith('/statedashboard')
    ? 'state'
    : path.startsWith('/dashboard')
      ? 'firm'
      : 'field';
  const role = profile?.role ?? 'firm_admin';
  return (
    <nav className="env-nav">
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
          <span className="env-user">
            {profile.email} · {adminRoleLabel(profile)}
          </span>
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
      const s = getSession();
      if (s?.kind === 'firm_admin') {
        try {
          await restoreAdminSession();
        } catch {
          // Admin data calls will report offline instead.
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
