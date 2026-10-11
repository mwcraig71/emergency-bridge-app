import React from 'react';
import ReactDOM from 'react-dom/client';
import { CapacitorUpdater } from '@capgo/capacitor-updater';
import { Capacitor } from '@capacitor/core';
import App from './App';
import './styles.css';

// Over-the-air updates: check the configured manifest URL on launch.
async function checkForOtaUpdate(): Promise<void> {
  if (!Capacitor.isNativePlatform()) return;
  const updateUrl = import.meta.env.VITE_OTA_UPDATE_URL as string | undefined;
  if (!updateUrl) return;
  try {
    await CapacitorUpdater.notifyAppReady();
    // The plugin's autoUpdate handles download+apply from updateUrl.
    // Manual check kept here so a missing manifest never blocks launch.
  } catch {
    // OTA is best-effort; the bundled web build always runs.
  }
}

void checkForOtaUpdate();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
