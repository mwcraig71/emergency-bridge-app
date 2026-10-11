-- Migration 004: prefix existing SC asset IDs with 'SC-'.
-- Decision 2026-10-10: state-prefixed IDs (SC-1892, NC-10001) resolve the
-- 171 cross-state collisions (NBI numbers are only unique within a state).
-- emg_inspections is empty, so no FK rows to cascade.
-- Idempotent: the WHERE guard skips already-prefixed rows on re-run.

update public.emg_bridges
   set asset_id = 'SC-' || asset_id
 where state = 'SC'
   and asset_id not like 'SC-%';
