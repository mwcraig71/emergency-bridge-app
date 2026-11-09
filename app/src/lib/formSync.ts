// Template delivery + offline cache (design §6.1).
//
// At sync time the app fetches the published template + questions for
// each state it serves and caches them in the IndexedDB 'form_templates'
// store, keyed by (state, version). A state with no published template
// of its own caches the system default under its own key. Starting an
// inspection resolves the template for the BRIDGE's state (multi-state
// firms serve NC + SC — the template is per inspection, not per login),
// and a device that has never synced falls back to the compiled-in
// default template from lib/defaultTemplate.ts.
import { getSupabase, isOnline, isSupabaseConfigured } from './supabase';
import { idbGetAll, idbPut } from './idb';
import { loadQuestions } from './forms';
import {
  BUILTIN_QUESTIONS,
  BUILTIN_TEMPLATE,
} from './defaultTemplate';
import type {
  CachedFormTemplate,
  FormQuestion,
  FormTemplate,
} from '../types';

const TEMPLATE_COLS =
  'id,state_code,name,version,status,is_default,created_by,created_at,published_at,published_by';

/** State code for a bridge: the asset-ID prefix ('NC-10001' → 'NC').
 *  Returns null when the asset ID carries no two-letter state prefix. */
export function stateCodeForAsset(assetId: string): string | null {
  const m = /^([A-Za-z]{2})-/.exec(assetId ?? '');
  return m ? m[1].toUpperCase() : null;
}

async function fetchPublishedForState(
  stateCode: string,
): Promise<{ template: FormTemplate; questions: FormQuestion[] } | null> {
  const sb = getSupabase();
  if (!sb) return null;
  const { data, error } = await sb
    .from('emg_form_templates')
    .select(TEMPLATE_COLS)
    .eq('state_code', stateCode)
    .eq('status', 'published')
    .maybeSingle();
  if (error) throw error;
  if (data) {
    const template = data as unknown as FormTemplate;
    return { template, questions: await loadQuestions(template.id) };
  }
  // No state template — fall back to the system default.
  const { data: def, error: defErr } = await sb
    .from('emg_form_templates')
    .select(TEMPLATE_COLS)
    .eq('is_default', true)
    .maybeSingle();
  if (defErr) throw defErr;
  if (!def) return null;
  const template = def as unknown as FormTemplate;
  return { template, questions: await loadQuestions(template.id) };
}

async function cacheTemplate(
  forState: string,
  bundle: { template: FormTemplate; questions: FormQuestion[] },
): Promise<void> {
  const rec: CachedFormTemplate = {
    key: `${forState}:${bundle.template.version}`,
    for_state: forState,
    template: bundle.template,
    questions: bundle.questions,
    fetched_at: new Date().toISOString(),
  };
  await idbPut('form_templates', rec);
}

/**
 * Refresh the offline template cache for the given states (plus the
 * bare default). Best-effort per state: a failure leaves the previous
 * cache (or the compiled-in fallback) in place. No-op offline.
 */
export async function syncFormTemplates(states: string[]): Promise<void> {
  if (!isSupabaseConfigured() || !isOnline()) return;
  const wanted = [...new Set(states.map((s) => s.toUpperCase()))];
  for (const state of wanted) {
    try {
      const bundle = await fetchPublishedForState(state);
      if (bundle) await cacheTemplate(state, bundle);
    } catch {
      // Keep whatever is cached.
    }
  }
  // Always keep a bare copy of the default for unknown-state bridges.
  try {
    const sb = getSupabase();
    if (sb) {
      const { data } = await sb
        .from('emg_form_templates')
        .select(TEMPLATE_COLS)
        .eq('is_default', true)
        .maybeSingle();
      if (data) {
        const template = data as unknown as FormTemplate;
        await cacheTemplate('DEFAULT', {
          template,
          questions: await loadQuestions(template.id),
        });
      }
    }
  } catch {
    // Compiled-in fallback covers this.
  }
}

export interface ResolvedTemplate {
  template: FormTemplate;
  questions: FormQuestion[];
  /** 'cache' = a synced published template (real server ids);
   *  'builtin' = the compiled-in default (form_template_id stays null
   *  on the draft and is resolved to the real default at push time). */
  source: 'cache' | 'builtin';
}

/** Resolve the template an inspection on a bridge in `stateCode` should
 *  use right now: newest cached record for that state, else the cached
 *  default, else the compiled-in default. Never throws. */
export async function resolveTemplateForState(
  stateCode: string | null,
): Promise<ResolvedTemplate> {
  try {
    const all = await idbGetAll<CachedFormTemplate>('form_templates');
    const forState = (stateCode
      ? all.filter((r) => r.for_state === stateCode)
      : []
    ).sort((a, b) => b.fetched_at.localeCompare(a.fetched_at));
    if (forState.length > 0) {
      return {
        template: forState[0].template,
        questions: forState[0].questions,
        source: 'cache',
      };
    }
    const def = all
      .filter((r) => r.for_state === 'DEFAULT')
      .sort((a, b) => b.fetched_at.localeCompare(a.fetched_at));
    if (def.length > 0) {
      return { template: def[0].template, questions: def[0].questions, source: 'cache' };
    }
  } catch {
    // Fall through to the compiled-in default.
  }
  return {
    template: BUILTIN_TEMPLATE,
    questions: BUILTIN_QUESTIONS,
    source: 'builtin',
  };
}
