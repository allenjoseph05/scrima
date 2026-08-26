import { useEffect } from 'react';
import { useMatchStore } from '../stores/matchStore';

export function useDetection() {
  const refreshRecordingStatus = useMatchStore((s) => s.refreshRecordingStatus);

  useEffect(() => {
    refreshRecordingStatus();
    const interval = setInterval(refreshRecordingStatus, 5000);
    return () => clearInterval(interval);
  }, []);
}
