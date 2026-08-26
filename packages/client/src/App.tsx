import { invoke } from '@tauri-apps/api/core';
import { useEffect, useState } from 'react';
import { LoginView } from './components/auth/LoginView';
import { MainLayout } from './components/layout/MainLayout';
import { UpdateBanner } from './components/layout/UpdateBanner';
import { ConsentDialog } from './components/onboarding/ConsentDialog';
import { OnboardingModal } from './components/onboarding/OnboardingModal';
import { AppLoader } from './components/shared/AppLoader';
import { ConnectivityBanner } from './components/shared/ConnectivityBanner';
import { formatUserError } from './lib/errors';
import { initAnalysisListeners, teardownAnalysisListeners } from './stores/analysisStore';
import { useAppStore } from './stores/appStore';
import { useAuthStore } from './stores/authStore';
import { initConnectivityMonitor, teardownConnectivityMonitor } from './stores/connectivityStore';
import { initGameStoreListeners, teardownGameStoreListeners } from './stores/gameStore';
import { initMatchStoreListeners, teardownMatchStoreListeners } from './stores/matchStore';
import {
  cleanupNotificationListeners,
  initNotificationListeners,
} from './stores/notificationStore';

export default function App() {
  const { isInitialized, initialize } = useAppStore();
  const { isLoggedIn, checkAuth } = useAuthStore();
  const [error, setError] = useState<string | null>(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [hasConsent, setHasConsent] = useState<boolean | null>(null);

  useEffect(() => {
    let mounted = true;

    const setup = async () => {
      await initMatchStoreListeners();
      await initAnalysisListeners();
      await initNotificationListeners();
      await initGameStoreListeners();
      initConnectivityMonitor();
    };

    setup().catch(console.error);

    (async () => {
      try {
        await initialize();
        await checkAuth();
        // Check if user already gave privacy consent
        const consent = await invoke<string | null>('get_setting', { key: 'privacy_consent' });
        if (mounted) {
          setHasConsent(!!consent && consent.trim().length > 0);
        }
      } catch (err) {
        console.error('Failed to initialize app:', err);
        if (mounted)
          setError(formatUserError(err, 'Scrima could not start. Please try reopening the app.'));
      } finally {
        if (mounted) setAuthChecked(true);
      }
    })();

    return () => {
      mounted = false;
      teardownMatchStoreListeners();
      teardownAnalysisListeners();
      cleanupNotificationListeners();
      teardownGameStoreListeners();
      teardownConnectivityMonitor();
    };
  }, []);

  if (error) {
    return (
      <div className="flex h-screen items-center justify-center bg-gray-950 text-white">
        <div className="text-center">
          <h1 className="text-2xl font-bold text-red-400 mb-2">Failed to initialize</h1>
          <p className="text-gray-400 text-sm">{error}</p>
        </div>
      </div>
    );
  }

  if (!isInitialized || !authChecked || hasConsent === null) {
    return <AppLoader label="Loading Scrima..." />;
  }

  // Auth guard — show login screen if not authenticated
  if (!isLoggedIn) {
    return <LoginView />;
  }

  // Privacy consent — show after login, before main app
  if (!hasConsent) {
    return <ConsentDialog onConsent={() => setHasConsent(true)} />;
  }

  return (
    <>
      <ConnectivityBanner />
      <UpdateBanner />
      <MainLayout />
      <OnboardingModal />
    </>
  );
}
