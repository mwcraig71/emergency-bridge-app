import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.strinteg.emergencybridge',
  appName: 'Emergency Bridge Inspection',
  webDir: 'dist',
  backgroundColor: '#1a3a5c',
  android: {
    allowMixedContent: false,
  },
  plugins: {
    // Over-the-air updates via @capgo/capacitor-updater.
    // Self-hosted on GitHub Pages (see docs/OTA-UPDATES.md, Option B).
    // The plugin polls updateUrl natively — this must live here, not only
    // in VITE_OTA_UPDATE_URL, or autoUpdate silently targets Capgo cloud.
    CapacitorUpdater: {
      autoUpdate: true,
      resetWhenUpdate: false,
      updateUrl:
        'https://mwcraig71.github.io/emergency-bridge-app/ota/manifest.json',
    },
  },
};

export default config;
