// Bridge ID resolution for bulk assignment input.
// Handles raw user input like "1892", "SC-1892", "000000000001892"
// and resolves them to emg_bridges records.
import { getSupabase } from './supabase';
import { getCurrentFirmId, getFirmBridges } from './firm';
import type { Bridge } from '../types';

export type BridgeState = 'SC' | 'NC';

const BRIDGE_SELECT = 'asset_id,struct_no,facility,county_name,district';

/**
 * Normalize a raw pasted ID into candidate asset_id forms.
 * E.g. "000000000001892" (SC) -> ["SC-000000000001892", "SC-1892"].
 */
export function normalizeBridgeInput(
  raw: string,
  state: BridgeState,
): string[] {
  const t = raw.trim().toUpperCase();
  if (!t) return [];
  // Strip a state prefix if present ("SC-1892", "NC 10001", "sc1892").
  let core = t;
  const m = /^(SC|NC)[-\s]?(.+)$/.exec(t);
  if (m) core = m[2].trim();
  if (!core) return [];
  const candidates: string[] = [`${state}-${core}`];
  // Numeric cores: also try stripping leading zeros
  // (SC NBI structure numbers like "000000000001892" -> asset "SC-1892").
  if (/^\d+$/.test(core)) {
    const stripped = core.replace(/^0+/, '') || '0';
    if (stripped !== core) candidates.push(`${state}-${stripped}`);
  }
  return [...new Set(candidates)];
}

export interface ResolveResult {
  found: Bridge[];
  notFound: string[];
}

/**
 * Resolve a batch of raw IDs against emg_bridges.
 * Returns matched bridge records (deduped) plus the raw inputs
 * that matched nothing.
 *
 * When a firm is active (explicit firmId or the current firm), results are
 * restricted to bridges in that firm's bridge group. Pass firmId as null
 * to skip firm filtering entirely.
 */
export async function resolveBridgeIds(
  rawIds: string[],
  state: BridgeState,
  firmId?: string | null,
): Promise<ResolveResult> {
  const sb = getSupabase();
  if (!sb) throw new Error('Supabase is not configured');

  // Firm scoping: only resolve bridges in the firm's group.
  const fid = firmId === undefined ? getCurrentFirmId() : firmId;
  let firmAssets: Set<string> | null = null;
  if (fid) {
    firmAssets = new Set(await getFirmBridges(fid));
  }

  const inputToCandidates = new Map<string, string[]>();
  const allCandidates = new Set<string>();
  for (const raw of rawIds) {
    const t = raw.trim();
    if (!t) continue;
    // Dedupe identical raw inputs.
    if (inputToCandidates.has(t)) continue;
    const cands = normalizeBridgeInput(t, state);
    inputToCandidates.set(t, cands);
    for (const c of cands) allCandidates.add(c);
  }

  const found = new Map<string, Bridge>();
  const candidateList = [...allCandidates];
  for (let i = 0; i < candidateList.length; i += 500) {
    const chunk = candidateList.slice(i, i + 500);
    const { data, error } = await sb
      .from('emg_bridges')
      .select(BRIDGE_SELECT)
      .in('asset_id', chunk);
    if (error) throw error;
    for (const b of ((data ?? []) as unknown as Bridge[])) {
      found.set(b.asset_id, b);
    }
  }

  const foundBridges: Bridge[] = [];
  const notFound: string[] = [];
  const seenAssets = new Set<string>();
  for (const [raw, cands] of inputToCandidates) {
    let matched: Bridge | null = null;
    for (const c of cands) {
      const b = found.get(c);
      if (b) {
        matched = b;
        break;
      }
    }
    if (matched) {
      if (firmAssets && !firmAssets.has(matched.asset_id)) {
        // Bridge exists but is not in this firm's group — treat as not found.
        notFound.push(raw);
      } else if (!seenAssets.has(matched.asset_id)) {
        seenAssets.add(matched.asset_id);
        foundBridges.push(matched);
      }
    } else {
      notFound.push(raw);
    }
  }
  // Keep found list in a stable order.
  foundBridges.sort((a, b) => a.asset_id.localeCompare(b.asset_id));

  return { found: foundBridges, notFound };
}

/**
 * Parse pasted/CSV text into a list of raw IDs.
 * Accepts one ID per line, or a single-column CSV (first column used,
 * header row auto-skipped).
 */
export function parseIdList(text: string): string[] {
  const lines = text.split(/\r?\n/);
  const ids: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    // First column only; strip surrounding quotes.
    const first = line
      .split(/[,;\t]/)[0]
      .trim()
      .replace(/^"|"$/g, '')
      .trim();
    if (!first) continue;
    // Skip a header row that looks like a column label.
    if (i === 0 && /^(id|asset|bridge|struct)/i.test(first)) continue;
    ids.push(first);
  }
  return ids;
}
