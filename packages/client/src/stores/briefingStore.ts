/**
 * Pre-Session Briefing Store (Phase 4)
 *
 * Fetches the "Before you play" card data and records focus commitments.
 * Graceful degradation: if fetches fail, the store surfaces null briefing
 * and the Dashboard component renders accordingly.
 */

import { invoke } from '@tauri-apps/api/core';
import { create } from 'zustand';

// ── Types mirror PreSessionBriefingService.Briefing on the server ───────────

export interface Briefing {
  sessionNumber: number;
  detected?: {
    primarySkillId?: string;
    primarySkillName?: string;
    domain?: string;
  };
  practice: {
    drillName: string;
    drillSteps: string;
    durationMinutes: number;
  } | null;
  lookFor: {
    cue: string;
    context: string;
    when?: string;
    check?: string;
    ifYes?: string;
    ifNo?: string;
  } | null;
  avoid: {
    pattern: string;
    occurrenceLine: string;
    signature?: string;
    trigger?: string;
    instinct?: string;
    rule?: string;
  } | null;
  todayRule: string | null;
  currentCommitment: {
    focus: string;
    committedAt: string;
  } | null;
}

// ── Store ───────────────────────────────────────────────────────────────────

interface BriefingStore {
  briefing: Briefing | null;
  loading: boolean;
  fetchBriefing: () => Promise<void>;
  commitFocus: (focus: string) => Promise<void>;
  clearCommitment: () => void;
}

export const useBriefingStore = create<BriefingStore>((set, get) => ({
  briefing: null,
  loading: false,

  fetchBriefing: async () => {
    if (get().loading) return;
    set({ loading: true });
    try {
      const result = await invoke<Briefing>('get_pre_session_briefing');
      set({ briefing: result, loading: false });
    } catch (err) {
      console.warn('[briefingStore] fetch failed:', err);
      set({ briefing: null, loading: false });
    }
  },

  commitFocus: async (focus: string) => {
    try {
      // Optimistic update for instant UI feedback
      set((s) => ({
        briefing: s.briefing
          ? {
              ...s.briefing,
              currentCommitment: {
                focus,
                committedAt: new Date().toISOString(),
              },
            }
          : s.briefing,
      }));

      const result = await invoke<{
        success: boolean;
        commitment: { focus: string; committedAt: string };
      }>('commit_focus', { focus });

      // Reconcile with server timestamp
      if (result?.commitment) {
        set((s) => ({
          briefing: s.briefing
            ? { ...s.briefing, currentCommitment: result.commitment }
            : s.briefing,
        }));
      }
    } catch (err) {
      console.warn('[briefingStore] commit failed:', err);
      // On failure, revert: clear the optimistic commitment
      set((s) => ({
        briefing: s.briefing ? { ...s.briefing, currentCommitment: null } : s.briefing,
      }));
    }
  },

  clearCommitment: () => {
    set((s) => ({
      briefing: s.briefing ? { ...s.briefing, currentCommitment: null } : s.briefing,
    }));
  },
}));
