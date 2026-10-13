import { useCallback, useEffect, useMemo, useState } from 'react';
import { getSupabase, isOnline, isSupabaseConfigured } from '../lib/supabase';
import { getCachedFirms, syncFirms } from '../lib/firm';
import { loadStates } from '../lib/stateDashboard';
import type {
  AdminProfile,
  AdminRole,
  EmgAdmin,
  EmgState,
  Firm,
} from '../types';

interface AdminManagerProps {
  /** The signed-in admin's own profile — drives what they can see/grant. */
  profile: AdminProfile;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : 'Something went wrong.';
}

export function roleLabel(role: AdminRole): string {
  switch (role) {
    case 'super_admin':
      return 'Super admin';
    case 'state_admin':
      return 'State admin';
    case 'firm_admin':
      return 'Firm admin';
  }
}

/**
 * Admin management (migration 015 role hierarchy).
 *
 * super_admin sees and can grant every role in every state.
 * state_admin sees only their state: its state_admins and the
 * firm_admins of firms in that state; they can grant state_admin
 * (own state) and firm_admin (own state's firms) — never super_admin.
 *
 * Adding a row here grants the ROLE only. The person also needs a
 * Supabase Auth account with the same email to sign in (created in
 * the Supabase dashboard — this UI never touches passwords).
 */
export default function AdminManager({ profile }: AdminManagerProps) {
  const isSuper = profile.role === 'super_admin';
  const myState = profile.stateCode ?? null;

  const [admins, setAdmins] = useState<EmgAdmin[]>([]);
  const [firms, setFirms] = useState<Firm[]>([]);
  const [states, setStates] = useState<EmgState[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Add-admin form
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<AdminRole>('firm_admin');
  const [stateCode, setStateCode] = useState<string>(myState ?? '');
  const [firmId, setFirmId] = useState('');

  const refresh = useCallback(async () => {
    if (isOnline() && isSupabaseConfigured()) {
      try {
        await syncFirms();
      } catch {
        // fall back to the cache below
      }
    }
    setFirms(await getCachedFirms());
    setStates(await loadStates());
    const sb = getSupabase();
    if (!sb || !isOnline() || !isSupabaseConfigured()) {
      setAdmins([]);
      return;
    }
    const { data, error: qErr } = await sb
      .from('emg_admins')
      .select('id,auth_user_id,email,role,state_code,firm_id,created_at')
      .order('email');
    if (qErr) throw qErr;
    setAdmins((data ?? []) as unknown as EmgAdmin[]);
  }, []);

  useEffect(() => {
    let cancelled = false;
    refresh().catch((e) => {
      if (!cancelled) setError(errMsg(e));
    });
    return () => {
      cancelled = true;
    };
  }, [refresh]);

  const firmById = useMemo(
    () => new Map(firms.map((f) => [f.id, f])),
    [firms],
  );
  const stateName = useCallback(
    (code: string | null) =>
      states.find((s) => s.code === code)?.name ?? code ?? '—',
    [states],
  );

  /** Rows this admin is allowed to see. */
  const visibleAdmins = useMemo(() => {
    if (isSuper) return admins;
    return admins.filter((a) => {
      if (a.role === 'state_admin') return a.state_code === myState;
      if (a.role === 'firm_admin') {
        const f = a.firm_id ? firmById.get(a.firm_id) : undefined;
        return f?.state_code === myState;
      }
      return false; // super_admin rows are not shown to state admins
    });
  }, [admins, isSuper, myState, firmById]);

  /** Firms offered in the add form's firm picker. */
  const firmOptions = useMemo(() => {
    if (isSuper) return firms;
    return firms.filter((f) => f.state_code === myState);
  }, [firms, isSuper, myState]);

  const roleOptions: AdminRole[] = isSuper
    ? ['super_admin', 'state_admin', 'firm_admin']
    : ['state_admin', 'firm_admin'];

  const scopeLabel = (a: EmgAdmin): string => {
    if (a.role === 'super_admin') return 'All states';
    if (a.role === 'state_admin') return stateName(a.state_code);
    const f = a.firm_id ? firmById.get(a.firm_id) : undefined;
    return f ? f.name : '—';
  };

  const requireOnline = (): boolean => {
    if (!isOnline() || !isSupabaseConfigured()) {
      setError('Admin changes need an internet connection.');
      return false;
    }
    return true;
  };

  const addAdmin = async () => {
    setError(null);
    setNotice(null);
    if (!requireOnline()) return;
    const cleanEmail = email.trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(cleanEmail)) {
      setError('Enter a valid email address.');
      return;
    }
    if (!isSuper && role === 'super_admin') {
      setError('Only a super admin can create another super admin.');
      return;
    }
    const effectiveState =
      role === 'state_admin' ? (isSuper ? stateCode : myState) : null;
    if (role === 'state_admin' && !effectiveState) {
      setError('Choose the state for this state admin.');
      return;
    }
    if (role === 'firm_admin' && !firmId) {
      setError('Choose the firm for this firm admin.');
      return;
    }
    setBusy(true);
    try {
      const sb = getSupabase()!;
      const { error: insErr } = await sb.from('emg_admins').insert({
        email: cleanEmail,
        role,
        state_code: role === 'state_admin' ? effectiveState : null,
        firm_id: role === 'firm_admin' ? firmId : null,
      });
      if (insErr) {
        if (/duplicate|unique/i.test(insErr.message))
          throw new Error(`${cleanEmail} already has an admin role.`);
        throw insErr;
      }
      setEmail('');
      setFirmId('');
      await refresh();
      setNotice(
        `Added ${cleanEmail} as ${roleLabel(role).toLowerCase()}. They also need a login account — see the note below.`,
      );
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  const removeAdmin = async (a: EmgAdmin) => {
    setError(null);
    setNotice(null);
    if (!requireOnline()) return;
    if (
      !window.confirm(
        `Remove the ${roleLabel(a.role).toLowerCase()} role from ${a.email}? They will fall back to a plain firm admin login.`,
      )
    )
      return;
    setBusy(true);
    try {
      const sb = getSupabase()!;
      const { error: delErr } = await sb
        .from('emg_admins')
        .delete()
        .eq('id', a.id);
      if (delErr) throw delErr;
      await refresh();
      setNotice(`Removed admin role from ${a.email}.`);
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card">
      <h3 style={{ marginTop: 0 }}>
        Admins —{' '}
        {isSuper ? 'all states' : `${stateName(myState)} (${myState ?? ''})`}
      </h3>

      <p className="muted" style={{ marginTop: 0 }}>
        This list grants roles. A person also needs a login account:
        create it in the Supabase dashboard (Authentication → Users) with
        the same email address. Adding them here first is fine — the role
        links to their account the first time they sign in.
      </p>

      {visibleAdmins.length === 0 ? (
        <div className="muted" style={{ marginBottom: 12 }}>
          No admins in scope yet.
        </div>
      ) : (
        <div style={{ overflowX: 'auto', marginBottom: 12 }}>
          <table className="data">
            <thead>
              <tr>
                <th>Email</th>
                <th>Role</th>
                <th>Scope</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {visibleAdmins.map((a) => (
                <tr key={a.id}>
                  <td>{a.email}</td>
                  <td>{roleLabel(a.role)}</td>
                  <td>{scopeLabel(a)}</td>
                  <td style={{ textAlign: 'right' }}>
                    <button
                      type="button"
                      className="btn danger"
                      style={{ width: 'auto', margin: 0, minHeight: 44 }}
                      onClick={() => void removeAdmin(a)}
                      disabled={busy}
                    >
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div
        style={{
          display: 'flex',
          gap: 8,
          flexWrap: 'wrap',
          alignItems: 'flex-end',
        }}
      >
        <div className="field" style={{ flex: '2 1 220px', margin: 0 }}>
          <label htmlFor="admin-new-email">Email</label>
          <input
            id="admin-new-email"
            type="email"
            autoComplete="off"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="name@firm.com"
            disabled={busy}
          />
        </div>
        <div className="field" style={{ flex: '1 1 150px', margin: 0 }}>
          <label htmlFor="admin-new-role">Role</label>
          <select
            id="admin-new-role"
            value={role}
            onChange={(e) => setRole(e.target.value as AdminRole)}
            disabled={busy}
          >
            {roleOptions.map((r) => (
              <option key={r} value={r}>
                {roleLabel(r)}
              </option>
            ))}
          </select>
        </div>
        {role === 'state_admin' && (
          <div className="field" style={{ flex: '1 1 150px', margin: 0 }}>
            <label htmlFor="admin-new-state">State</label>
            <select
              id="admin-new-state"
              value={isSuper ? stateCode : (myState ?? '')}
              onChange={(e) => setStateCode(e.target.value)}
              disabled={busy || !isSuper}
            >
              <option value="">Choose a state…</option>
              {(isSuper
                ? states
                : states.filter((s) => s.code === myState)
              ).map((s) => (
                <option key={s.code} value={s.code}>
                  {s.name} ({s.code})
                </option>
              ))}
            </select>
          </div>
        )}
        {role === 'firm_admin' && (
          <div className="field" style={{ flex: '1 1 180px', margin: 0 }}>
            <label htmlFor="admin-new-firm">Firm</label>
            <select
              id="admin-new-firm"
              value={firmId}
              onChange={(e) => setFirmId(e.target.value)}
              disabled={busy}
            >
              <option value="">Choose a firm…</option>
              {firmOptions.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </select>
          </div>
        )}
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => void addAdmin()}
          disabled={busy}
          style={{ minHeight: 48, margin: 0, width: 'auto' }}
        >
          {busy ? '…' : 'Add admin'}
        </button>
      </div>

      {notice && (
        <div
          role="status"
          style={{ marginTop: 12, color: '#1E5B1E', fontWeight: 600 }}
        >
          {notice}
        </div>
      )}
      {error && (
        <div className="login-error" role="alert" style={{ marginTop: 12 }}>
          {error}
        </div>
      )}
    </div>
  );
}
