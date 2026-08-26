import { invoke } from '@tauri-apps/api/core';
import { type UnlistenFn, listen } from '@tauri-apps/api/event';
import { create } from 'zustand';

// ─── Types matching Rust IPC output (camelCase via #[serde(rename_all = "camelCase")]) ───

export interface RecordingStatus {
  isRecording: boolean;
  matchId: string | null;
  filePath: string | null;
  startedAtMs: number | null;
  encoderUsed: string | null;
  estimatedSizeMb: number;
}

export interface MatchRow {
  id: string;
  gameId: string;
  startedAt: number;
  endedAt: number | null;
  durationMs: number | null;
  map: string | null;
  agent: string | null;
  won: boolean | null;
  kills: number;
  deaths: number;
  assists: number;
  recordingPath: string | null;
  recordingSizeBytes: number | null;
  analysisStatus: string;
  createdAt: number;
}

export interface GameEvent {
  id: string;
  timestampMs: number;
  eventTypeId: string;
  confidence: number;
  detectionSources: string[];
  data: Record<string, unknown>;
}

export interface MetricValue {
  metricId: string;
  value: number;
  formatted: string;
}

export interface CoachableMoment {
  event: GameEvent;
  surroundingEvents: GameEvent[];
  clipWindow: { beforeSeconds: number; afterSeconds: number };
}

export interface MatchSummary {
  matchId: string;
  gameId: string;
  startedAtMs: number;
  endedAtMs: number;
  durationMs: number;
  events: GameEvent[];
  metrics: MetricValue[];
  coachableMoments: CoachableMoment[];
}

// ─── Store ───────────────────────────────────────────────────────────────────

interface MatchState {
  // Status
  recording: RecordingStatus;

  // Derived convenience flag
  isRecording: boolean;

  // Post-game
  lastMatchSummary: MatchSummary | null;

  // History
  matchHistory: MatchRow[];

  // Actions
  refreshRecordingStatus: () => Promise<void>;
  refreshMatchHistory: () => Promise<void>;
  refreshMatchSummary: () => Promise<void>;
}

const defaultRecording: RecordingStatus = {
  isRecording: false,
  matchId: null,
  filePath: null,
  startedAtMs: null,
  encoderUsed: null,
  estimatedSizeMb: 0,
};

export const useMatchStore = create<MatchState>((set) => ({
  recording: defaultRecording,
  isRecording: false,
  lastMatchSummary: null,
  matchHistory: [],

  refreshRecordingStatus: async () => {
    try {
      const status = await invoke<RecordingStatus>('get_recording_status');
      set({ recording: status, isRecording: status.isRecording });
    } catch (e) {
      console.error('get_recording_status:', e);
    }
  },

  refreshMatchHistory: async () => {
    try {
      const rows = await invoke<MatchRow[]>('list_recent_matches', { limit: 20 });
      set({ matchHistory: rows });
    } catch (e) {
      console.error('list_recent_matches:', e);
    }
  },

  refreshMatchSummary: async () => {
    try {
      const summary = await invoke<MatchSummary | null>('get_match_summary');
      if (summary?.matchId) set({ lastMatchSummary: summary });
    } catch (e) {
      console.error('get_match_summary:', e);
    }
  },
}));

// ─── Tauri event listeners (set up once at app start) ─────────────────────

let _unlisten: UnlistenFn[] = [];

export async function initMatchStoreListeners() {
  // Clean up any existing listeners first
  teardownMatchStoreListeners();

  const store = useMatchStore.getState();

  // Auto-refresh when a session starts
  const unlistenStart = await listen<{ game: string }>('scrima:game-session-start', () => {
    store.refreshRecordingStatus();
  });

  // Auto-refresh when session ends (no auto-analysis — user triggers manually from history)
  const unlistenEnd = await listen<{ matchId: string }>('scrima:game-session-end', () => {
    store.refreshRecordingStatus();
    store.refreshMatchSummary();
    store.refreshMatchHistory();
  });

  // Refresh history when recording crashes so partial recording appears
  const unlistenCrash = await listen<{ matchId: string }>('scrima:recording-crashed', () => {
    store.refreshRecordingStatus();
    store.refreshMatchHistory();
  });

  _unlisten = [unlistenStart, unlistenEnd, unlistenCrash];
}

export function teardownMatchStoreListeners() {
  _unlisten.forEach((fn) => fn());
  _unlisten = [];
}
