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
    // Set VITE_OTA_UPDATE_URL to the update manifest endpoint (see docs/OTA-UPDATES.md).
    CapacitorUpdater: {
      autoUpdate: true,
      resetWhenUpdate: false,
    },
  },
};

export default config;
