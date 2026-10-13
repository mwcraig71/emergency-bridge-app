import { useCallback, useEffect, useState } from 'react';
import { getSupabase, isOnline, isSupabaseConfigured } from '../lib/supabase';
import { getCachedFirms, getFirmInspectors, syncInspectors } from '../lib/firm';
import { hashPin } from '../lib/auth';
import type { Firm, Inspector } from '../types';

interface TeamRosterProps {
  /** Firm from the admin session. */
  firmId?: string;
  firmName?: string;
  /** State scope (state_admin sessions): the firm picker only lists
   *  firms in this state. Null/undefined = no state restriction. */
  stateCode?: string | null;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : 'Something went wrong.';
}

/**
 * Team roster management for a signed-in firm admin.
 * Add inspectors, set/reset their 4–8 digit PINs, remove inspectors.
 * PINs are hashed client-side (salt = inspector id) — only the hash is
 * written to the server. All writes need network; the list itself can show
 * the local cache.
 */
export default function TeamRoster({ firmId, firmName, stateCode }: TeamRosterProps) {
  const [activeFirmId, setActiveFirmId] = useState(firmId ?? '');
  const [firms, setFirms] = useState<Firm[]>([]);
  const [roster, setRoster] = useState<Inspector[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [newName, setNewName] = useState('');

  useEffect(() => {
    if (firmId) setActiveFirmId(firmId);
  }, [firmId]);

  const refresh = useCallback(async (fid: string) => {
    if (!fid) {
      setRoster([]);
      return;
    }
    if (isOnline() && isSupabaseConfigured()) {
      try {
        await syncInspectors(fid);
      } catch {
        // show the local cache instead
      }
    }
    setRoster(await getFirmInspectors(fid));
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const all = await getCachedFirms();
      // State admins only see firms in their state.
      const list = stateCode
        ? all.filter((f) => f.state_code === stateCode)
        : all;
      if (cancelled) return;
      setFirms(list);
      if (!activeFirmId && list.length === 1) setActiveFirmId(list[0].id);
      await refresh(activeFirmId || (list.length === 1 ? list[0].id : ''));
    })();
    return () => {
      cancelled = true;
    };
  }, [activeFirmId, refresh, stateCode]);

  const requireOnline = (): boolean => {
    if (!isOnline() || !isSupabaseConfigured()) {
      setError('Roster changes need an internet connection.');
      return false;
    }
    if (!activeFirmId) {
      setError('Choose a firm first.');
      return false;
    }
    return true;
  };

  const addInspector = async () => {
    setError(null);
    setNotice(null);
    if (!requireOnline()) return;
    const name = newName.trim();
    if (!name) {
      setError('Enter the inspector name.');
      return;
    }
    setBusy(true);
    try {
      const sb = getSupabase()!;
      const { error } = await sb
        .from('inspectors')
        .insert({ firm_id: activeFirmId, name });
      if (error) {
        if (/duplicate|unique/i.test(error.message))
          throw new Error(`${name} is already on this roster.`);
        throw error;
      }
      setNewName('');
      await refresh(activeFirmId);
      setNotice(`Added ${name}. Set a PIN so they can sign in.`);
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  const setPin = async (insp: Inspector) => {
    setError(null);
    setNotice(null);
    if (!requireOnline()) return;
    const first = window.prompt(`New PIN for ${insp.name} (4–8 digits):`);
    if (first === null) return;
    const second = window.prompt(`Confirm PIN for ${insp.name}:`);
    if (second === null) return;
    const p1 = first.trim();
    const p2 = second.trim();
    if (!/^\d{4,8}$/.test(p1) || p1 !== p2) {
      setError('PINs did not match, or were not 4–8 digits.');
      return;
    }
    setBusy(true);
    try {
      // Hash client-side; only the hash is written.
      const pinHash = await hashPin(p1, insp.id);
      const sb = getSupabase()!;
      const { error } = await sb
        .from('inspectors')
        .update({ pin_hash: pinHash })
        .eq('id', insp.id);
      if (error) throw error;
      await refresh(activeFirmId);
      setNotice(`PIN set for ${insp.name}.`);
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  const removeInspector = async (insp: Inspector) => {
    setError(null);
    setNotice(null);
    if (!requireOnline()) return;
    if (
      !window.confirm(
        `Remove ${insp.name} from the team? Their PIN will stop working.`,
      )
    )
      return;
    setBusy(true);
    try {
      const sb = getSupabase()!;
      const { error } = await sb
        .from('inspectors')
        .delete()
        .eq('id', insp.id);
      if (error) throw error;
      await refresh(activeFirmId);
      setNotice(`Removed ${insp.name}.`);
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  const activeFirmName =
    firmName ||
    firms.find((f) => f.id === activeFirmId)?.name ||
    'your firm';

  return (
    <div className="card">
      <h3 style={{ marginTop: 0 }}>Team roster — {activeFirmName}</h3>

      {!firmId && firms.length > 1 && (
        <div className="field" style={{ marginBottom: 12 }}>
          <label htmlFor="roster-firm">Firm</label>
          <select
            id="roster-firm"
            value={activeFirmId}
            onChange={(e) => setActiveFirmId(e.target.value)}
            disabled={busy}
          >
            <option value="">Choose a firm…</option>
            {firms.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </select>
        </div>
      )}

      {!activeFirmId && (
        <div className="muted">No firm selected.</div>
      )}

      {activeFirmId && roster.length === 0 && (
        <div className="muted" style={{ marginBottom: 12 }}>
          No inspectors on the roster yet.
        </div>
      )}

      {activeFirmId && roster.length > 0 && (
        <ul style={{ listStyle: 'none', padding: 0, margin: '0 0 12px' }}>
          {roster.map((insp) => (
            <li
              key={insp.id}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '10px 12px',
                marginBottom: 8,
                border: '1px solid #ddd',
                borderRadius: 8,
              }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 700, fontSize: 15 }}>
                  {insp.name}
                </div>
                <div className="muted" style={{ fontSize: 12 }}>
                  {insp.pin_hash ? 'PIN set' : 'No PIN set'}
                </div>
              </div>
              <button
                type="button"
                className="btn"
                style={{ width: 'auto', margin: 0, minHeight: 44 }}
                onClick={() => void setPin(insp)}
                disabled={busy}
              >
                {insp.pin_hash ? 'Reset PIN' : 'Set PIN'}
              </button>
              <button
                type="button"
                className="btn danger"
                style={{ width: 'auto', margin: 0, minHeight: 44 }}
                onClick={() => void removeInspector(insp)}
                disabled={busy}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}

      {activeFirmId && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
          <div className="field" style={{ flex: 1, margin: 0 }}>
            <label htmlFor="roster-new-name">Add inspector</label>
            <input
              id="roster-new-name"
              type="text"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="Full name"
              disabled={busy}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void addInspector();
              }}
            />
          </div>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => void addInspector()}
            disabled={busy}
            style={{ minHeight: 48, margin: 0, width: 'auto' }}
          >
            {busy ? '…' : 'Add'}
          </button>
        </div>
      )}

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
