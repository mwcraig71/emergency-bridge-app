cp .env.example .env
# edit .env and fill in:
#   VITE_SUPABASE_URL=...
#   VITE_SUPABASE_ANON_KEY=...
# ⚠️  anon key only — never put the service-role key in the app bundle.
npm install
npm run dev
```

Routes:

- `/` — field app (inspector workflow)
- `/dashboard` — aggregation dashboard

## Capacitor (Android)

First time only:

```bash
npx cap add android
```

After any dependency or config change:

```bash
npm run build
npx cap sync android
npx cap open android      # opens Android Studio
```

Debug APK from CLI:

```bash
cd android
./gradlew assembleDebug
# → android/app/build/outputs/apk/debug/app-debug.apk
```

## OTA updates

See [`../docs/OTA-UPDATES.md`](../docs/OTA-UPDATES.md).

## Data

The app expects the `emg_*` tables created by `supabase/migrations/001` and `002`. Run migrations in order against a fresh Supabase project with PostGIS enabled.

Bridge inventory is fetched and cached into **IndexedDB** on first lookup, so subsequent inspections work fully offline. Writes queue locally and flush when connectivity returns.

## Build

```bash
npm run build       # → dist/
```

## Notes

- **HashRouter** is intentional — the app is loaded from `file://` on device and browser history APIs don't behave there.
- **Photos are downscaled to 1024px** on the longest edge before upload to keep sync payloads small over field connections.
- **Tile packs** are abstracted in `src/lib/tilepacks.ts`. Phase 1 uses raster tiles; **Phase 2 will swap in PMTiles** for offline-friendly vector tiles without changing call sites.
