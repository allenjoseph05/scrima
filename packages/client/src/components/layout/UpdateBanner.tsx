import { invoke } from '@tauri-apps/api/core';
import { useEffect, useState } from 'react';

interface UpdateInfo {
  available: boolean;
  version: string | null;
  body: string | null;
}

export function UpdateBanner() {
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  const [installing, setInstalling] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    // Check on mount, then every 6 hours
    checkUpdate();
    const interval = setInterval(checkUpdate, 6 * 60 * 60 * 1000);
    return () => clearInterval(interval);
  }, []);

  async function checkUpdate() {
    try {
      const info = await invoke<UpdateInfo>('check_for_update');
      if (info.available) setUpdate(info);
    } catch {
      // Silently ignore update check failures
    }
  }

  async function handleInstall() {
    setInstalling(true);
    try {
      await invoke('install_update');
      // App will restart — this won't be reached
    } catch (err) {
      console.error('Update failed:', err);
      setInstalling(false);
    }
  }

  if (!update?.available || dismissed) return null;

  return (
    <div
      className="flex items-center gap-3 px-4 py-2 text-xs"
      style={{
        background: 'linear-gradient(90deg, #7C3AED22, #00D4FF22)',
        borderBottom: '1px solid #7C3AED44',
      }}
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" style={{ flexShrink: 0 }}>
        <path
          d="M12 2v14m0 0l-5-5m5 5l5-5M5 20h14"
          stroke="#7C3AED"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      <span style={{ color: '#E8EFFF' }}>
        <strong>Scrima {update.version}</strong> is available
      </span>
      <div className="flex-1" />
      {installing ? (
        <span className="flex items-center gap-2" style={{ color: '#7A8BAD' }}>
          <div
            className="w-3 h-3 border border-t-transparent rounded-full animate-spin"
            style={{ borderColor: '#7C3AED', borderTopColor: 'transparent' }}
          />
          Installing...
        </span>
      ) : (
        <>
          <button
            type="button"
            onClick={handleInstall}
            className="px-3 py-1 text-xs font-bold uppercase tracking-wider"
            style={{
              background: '#7C3AED',
              color: '#E8EFFF',
              border: 'none',
              cursor: 'pointer',
            }}
          >
            Update Now
          </button>
          <button
            type="button"
            onClick={() => setDismissed(true)}
            className="px-2 py-1 text-xs"
            style={{ color: '#7A8BAD', background: 'none', border: 'none', cursor: 'pointer' }}
          >
            Later
          </button>
        </>
      )}
    </div>
  );
}
