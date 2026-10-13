import { useEffect, useState } from 'react';
import {
  getCurrentFirmId,
  getFirmInspectors,
  syncInspectors,
} from '../lib/firm';
import { isOnline, isSupabaseConfigured } from '../lib/supabase';
import type { Inspector } from '../types';

interface InspectorSelectProps {
  /** Firm whose roster fills the dropdown. Falls back to the current
   *  firm (getCurrentFirmId) when not given. */
  firmId?: string | null;
  /** Pre-loaded roster; skips the fetch when provided. */
  roster?: Inspector[];
  value: string;
  onChange: (name: string) => void;
  disabled?: boolean;
  placeholder?: string;
  id?: string;
  style?: React.CSSProperties;
}

/**
 * Inspector name control: a DROPDOWN populated from the current firm's
 * team roster (same source TeamRoster uses: syncInspectors +
 * getFirmInspectors). Falls back to a free-text input ONLY when the
 * roster is empty (no firm selected yet, or nobody added).
 */
export default function InspectorSelect({
  firmId,
  roster: rosterProp,
  value,
  onChange,
  disabled,
  placeholder = 'Select inspector…',
  id,
  style,
}: InspectorSelectProps) {
  const [loadedRoster, setLoadedRoster] = useState<Inspector[]>([]);

  useEffect(() => {
    if (rosterProp) return;
    let cancelled = false;
    (async () => {
      const fid = firmId ?? getCurrentFirmId();
      if (!fid) {
        if (!cancelled) setLoadedRoster([]);
        return;
      }
      if (isOnline() && isSupabaseConfigured()) {
        try {
          await syncInspectors(fid);
        } catch {
          // fall through to the local cache
        }
      }
      try {
        const list = await getFirmInspectors(fid);
        if (!cancelled) setLoadedRoster(list);
      } catch {
        if (!cancelled) setLoadedRoster([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [firmId, rosterProp]);

  const roster = rosterProp ?? loadedRoster;

  if (roster.length === 0) {
    return (
      <input
        id={id}
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        disabled={disabled}
        style={style}
      />
    );
  }

  return (
    <select
      id={id}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      disabled={disabled}
      style={style}
    >
      <option value="">{placeholder}</option>
      {roster.map((i) => (
        <option key={i.id} value={i.name}>
          {i.name}
        </option>
      ))}
      {value && !roster.some((i) => i.name === value) && (
        <option value={value}>{value}</option>
      )}
    </select>
  );
}
