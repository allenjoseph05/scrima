import { invoke } from '@tauri-apps/api/core';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useMatchStore } from '../stores/matchStore';

interface RecordingActions {
  startRecording: () => Promise<{ matchId: string; encoder: string } | null>;
  stopRecording: () => Promise<string | null>;
  ffmpegAvailable: boolean;
}

/**
 * Hook for controlling recording from the frontend.
 * Polls recording status every 2s while recording is active
 * so the UI shows live file size and detects ffmpeg crashes.
 */
export function useRecording(): RecordingActions {
  const { recording, refreshRecordingStatus } = useMatchStore();
  const [ffmpegAvailable, setFfmpegAvailable] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Check ffmpeg once on mount
  useEffect(() => {
    invoke<boolean>('check_ffmpeg')
      .then(setFfmpegAvailable)
      .catch(() => setFfmpegAvailable(false));
  }, []);

  // Poll recording status every 2s while recording is active
  useEffect(() => {
    if (recording.isRecording) {
      pollRef.current = setInterval(() => {
        refreshRecordingStatus();
      }, 2000);
    } else if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [recording.isRecording, refreshRecordingStatus]);

  const startRecording = useCallback(async () => {
    try {
      const result = await invoke<{ matchId: string; encoder: string }>('start_recording');
      await refreshRecordingStatus();
      return result;
    } catch (e) {
      console.error('start_recording failed:', e);
      return null;
    }
  }, [refreshRecordingStatus]);

  const stopRecording = useCallback(async () => {
    try {
      const path = await invoke<string>('stop_recording');
      await refreshRecordingStatus();
      return path;
    } catch (e) {
      console.error('stop_recording failed:', e);
      return null;
    }
  }, [refreshRecordingStatus]);

  return { startRecording, stopRecording, ffmpegAvailable };
}
