import { useEffect, useRef, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { CapacitorUpdater } from '@capgo/capacitor-updater';

type Phase = 'idle' | 'checking' | 'downloading' | 'restarting';

/**
 * Manual over-the-air update check for the top nav. The plugin's
 * autoUpdate only applies bundles across background/launch cycles, so
 * this gives the user an explicit control: check the self-hosted
 * manifest (updateUrl in capacitor.config.ts), download a newer bundle,
 * and apply it immediately via set(), which reloads the app.
 *
 * Result messages render in the shared .toast so they are visible from
 * every view; progress shows on the button itself. Failures (offline,
 * unreachable manifest) surface a friendly message and never throw.
 */
export default function UpdateButton() {
  const [phase, setPhase] = useState<Phase>('idle');
  const [message, setMessage] = useState<string | null>(null);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  const showMessage = (text: string) => {
    setMessage(text);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setMessage(null), 8000);
  };

  const handleClick = async () => {
    if (phase !== 'idle') return;
    if (!Capacitor.isNativePlatform()) {
      showMessage('Updates are managed in the installed app.');
      return;
    }
    try {
      setPhase('checking');
      const latest = await CapacitorUpdater.getLatest();
      const { bundle } = await CapacitorUpdater.current();
      if (
        latest.error === 'no_new_version_available' ||
        latest.version === bundle.version ||
        !latest.url
      ) {
        showMessage(`You're on the latest version (${bundle.version}).`);
        return;
      }
      setPhase('downloading');
      const downloaded = await CapacitorUpdater.download({
        url: latest.url,
        version: latest.version,
        ...(latest.checksum ? { checksum: latest.checksum } : {}),
        ...(latest.sessionKey ? { sessionKey: latest.sessionKey } : {}),
        ...(latest.manifest ? { manifest: latest.manifest } : {}),
      });
      setPhase('restarting');
      // set() applies the bundle and reloads immediately — it is a
      // terminal call, so nothing after it runs.
      await CapacitorUpdater.set({ id: downloaded.id });
    } catch {
      showMessage("Couldn't check for updates. Check your connection and try again.");
    } finally {
      setPhase('idle');
    }
  };

  const label =
    phase === 'checking'
      ? 'Checking…'
      : phase === 'downloading'
        ? 'Downloading update…'
        : phase === 'restarting'
          ? 'Restarting…'
          : 'Check for updates';

  return (
    <>
      <button
        type="button"
        className="env-update"
        onClick={handleClick}
        disabled={phase !== 'idle'}
      >
        {label}
      </button>
      {message && (
        <div className="toast" role="status">
          {message}
        </div>
      )}
    </>
  );
}
