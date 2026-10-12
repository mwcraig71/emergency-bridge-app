-- DriveNC (NCDOT) secondary data tables.
--
-- These tables are populated by the backend sync job
-- (scripts/sync-drivedata.mjs), which calls the drivenc-* CLIs and upserts
-- here. The field app syncs these tables to IndexedDB when online
-- (see app/src/lib/drivedata.ts) so the DriveNC overlay works offline.
--
-- DriveNC is a SECONDARY source. Inspector ground-truth pins (emg_roadblocks,
-- emg_road_statuses) always take visual precedence on the map.

-- NCDOT traffic events: closures, incidents, roadwork.
CREATE TABLE IF NOT EXISTS emg_drivedata_events (
  id TEXT PRIMARY KEY,
  roadway TEXT NOT NULL DEFAULT '',
  direction TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  event_type TEXT NOT NULL DEFAULT '',
  event_subtype TEXT NOT NULL DEFAULT '',
  is_full_closure BOOLEAN NOT NULL DEFAULT FALSE,
  severity TEXT NOT NULL DEFAULT '',
  lanes_affected TEXT NOT NULL DEFAULT '',
  county TEXT NOT NULL DEFAULT '',
  lon DOUBLE PRECISION,
  lat DOUBLE PRECISION,
  reported TIMESTAMPTZ,
  last_updated TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  detour_instructions JSONB NOT NULL DEFAULT '[]'::jsonb,
  synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_drivedata_events_county
  ON emg_drivedata_events (county);
CREATE INDEX IF NOT EXISTS idx_drivedata_events_type
  ON emg_drivedata_events (event_type);

-- NCDOT overhead message signs.
CREATE TABLE IF NOT EXISTS emg_drivedata_signs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  roadway TEXT NOT NULL DEFAULT '',
  direction TEXT NOT NULL DEFAULT '',
  messages JSONB NOT NULL DEFAULT '[]'::jsonb,
  county TEXT NOT NULL DEFAULT '',
  lon DOUBLE PRECISION,
  lat DOUBLE PRECISION,
  last_updated TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_drivedata_signs_county
  ON emg_drivedata_signs (county);

-- NCDOT WZDx work zones (geometry stored as GeoJSON).
CREATE TABLE IF NOT EXISTS emg_drivedata_workzones (
  id TEXT PRIMARY KEY,
  road_names JSONB NOT NULL DEFAULT '[]'::jsonb,
  direction TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  geometry JSONB,
  last_updated TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Read-only for the app's anon key (the sync job uses the service key).
ALTER TABLE emg_drivedata_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE emg_drivedata_signs ENABLE ROW LEVEL SECURITY;
ALTER TABLE emg_drivedata_workzones ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'emg_drivedata_events' AND policyname = 'drivedata_events_read'
  ) THEN
    CREATE POLICY drivedata_events_read ON emg_drivedata_events
      FOR SELECT USING (true);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'emg_drivedata_signs' AND policyname = 'drivedata_signs_read'
  ) THEN
    CREATE POLICY drivedata_signs_read ON emg_drivedata_signs
      FOR SELECT USING (true);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'emg_drivedata_workzones' AND policyname = 'drivedata_workzones_read'
  ) THEN
    CREATE POLICY drivedata_workzones_read ON emg_drivedata_workzones
      FOR SELECT USING (true);
  END IF;
END $$;
