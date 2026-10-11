# NBI State Upload Guide

The dashboard's **Upload NBI state file** tab (Operations Dashboard →
Upload NBI state file) loads a new state's FHWA NBI bridge inventory into
`emg_bridges` without touching the command line.

## Supported file variants

| Variant | Status |
|---|---|
| CSV with NBI header names (`STRUCTURE_NUMBER_008`, `LAT_016`, `LONG_017`, …) — e.g. SC25__1.txt, NC25.txt | ✅ Fully supported |
| Fixed-width NBI tape (standard FHWA item positions) | ⚠️ Parsed best-effort, **flagged "unverified layout"** in the UI — check the sample rows before importing. The fixed-width positions have not yet been validated against a real fixed-width file. |
| Anything else | ❌ Rejected with "Unknown NBI format" |

Coordinates are expected as DMS strings (`LAT_016` = `DDMMSSss`,
`LONG_017` = `DDDMMSSss`, positive-west longitudes negated on import).
Rows with malformed coordinates — or coordinates outside the selected
state's rough bounding box (catches transposed-digit NBI errors) — are
counted as **skipped**, never loaded.

## The flow

1. **Pick the state** (2-letter code) and your name, then drop the `.txt` file.
   Asset IDs are stored as `<STATE>-<id>` (e.g. `NC-10001`) so IDs that
   collide across states stay unique.
2. **Preview**: format detected, record counts, coordinate bounding box on a
   mini map, distinct district/division values, and 10 sample rows. Verify
   the samples look right — especially for fixed-width files.
3. **Collision check**: the server compares every would-be asset ID against
   the live table. **Fail-closed**: any collision (or duplicate within the
   file) blocks the import and nothing is written.
4. **Import**: streamed in 400-row batches with a progress bar. The attempt
   is recorded in `emg_imports` either way (completed / aborted / failed).

## Setup (one time)

1. Run `supabase/migrations/005_emg_imports.sql` in the Supabase SQL editor
   (creates the import-log table).
2. Deploy via `render.yaml` (Render Blueprint). Set in the Render dashboard:
   - `SUPABASE_SERVICE_ROLE_KEY` — Supabase → API keys → **secret** key
     (server-side only, never in the client bundle)
   - `VITE_SUPABASE_ANON_KEY` — the **publishable** key (baked into the bundle)
   - `IMPORT_TOKEN` and `VITE_IMPORT_TOKEN` — same long random string;
     the dashboard sends it as `x-import-token` so random internet users
     can't trigger imports. If unset, the API is open (fine on a private
     network, not on the public internet).

## Notes

- Parsing logic lives in `supabase/nbi_parse.py`, shared by the seed scripts
  (`seed_bridges.py`, `seed_nc.py`) and the server — one implementation.
- `county_name` is left NULL (needs a FIPS lookup — follow-up).
- Division/district boundary *geometries* for new states are a separate step
  (dissolve Census TIGER counties); the text district values work for
  filtering immediately.
- The 28 NC rows with out-of-state coordinates already in the DB predate the
  bounding-box check; they can be cleaned with a follow-up script if desired.
