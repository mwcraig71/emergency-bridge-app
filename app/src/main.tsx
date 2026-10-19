import React, { useState } from 'react';
import ReactDOM from 'react-dom/client';
import { CapacitorUpdater } from '@capgo/capacitor-updater';
import { Capacitor } from '@capacitor/core';
import App from './App';
import SetPasswordScreen from './components/SetPasswordScreen';
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

// Password-recovery links (Supabase) land on the site root with the
// tokens in the URL hash: #access_token=...&refresh_token=...&type=recovery.
// The app uses HashRouter, so that hash is NOT a route — intercept it
// here, before the router mounts, and scrub it from the URL so the
// router never tries to parse it and the tokens don't linger in the
// address bar. No recovery hash → the app renders exactly as before.
interface RecoveryTokens {
  accessToken: string;
  refreshToken: string;
}

function takeRecoveryTokens(): RecoveryTokens | null {
  const hash = window.location.hash;
  if (!hash || hash.length < 2) return null;
  const params = new URLSearchParams(hash.slice(1));
  const accessToken = params.get('access_token');
  if (params.get('type') !== 'recovery' || !accessToken) return null;
  window.history.replaceState(
    null,
    '',
    window.location.pathname + window.location.search,
  );
  return {
    accessToken,
    refreshToken: params.get('refresh_token') ?? '',
  };
}

const recoveryTokens = takeRecoveryTokens();

function Root() {
  const [recoveryDone, setRecoveryDone] = useState(false);
  if (recoveryTokens && !recoveryDone) {
    return (
      <SetPasswordScreen
        accessToken={recoveryTokens.accessToken}
        refreshToken={recoveryTokens.refreshToken}
        onDone={() => setRecoveryDone(true)}
      />
    );
  }
  return <App />;
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>,
);
