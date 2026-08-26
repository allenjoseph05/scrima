/**
 * Hypothesis Store (Phase 7B — Living Mind belief tiers)
 *
 * Fetches the coach's pending hypotheses and handles agree/disagree actions.
 * Optimistic UI updates on agree/disagree — remove locally, reconcile with
 * server response.
 */

import { invoke } from '@tauri-apps/api/core';
import { create } from 'zustand';

export type HypothesisCategory = 'agent_variance' | 'map_variance' | 'pattern_recurring';

export interface HypothesisData {
  category: HypothesisCategory;
  evidence: string;
  status: 'pending' | 'confirmed' | 'rejected';
  evidenceCount: number;
  generatedAt: string;
  resolvedAt?: string | null;
}

export interface Hypothesis {
  id: string;
  label: string;
  data: HypothesisData;
  createdAt: string;
}

interface HypothesisStore {
  hypotheses: Hypothesis[];
  loading: boolean;
  fetched: boolean;
  fetchHypotheses: () => Promise<void>;
  confirmHypothesis: (id: string) => Promise<void>;
  rejectHypothesis: (id: string) => Promise<void>;
}

export const useHypothesisStore = create<HypothesisStore>((set, get) => ({
  hypotheses: [],
  loading: false,
  fetched: false,

  fetchHypotheses: async () => {
    if (get().loading) return;
    set({ loading: true });
    try {
      const result = await invoke<{ hypotheses: Hypothesis[] }>('get_hypotheses');
      set({
        hypotheses: Array.isArray(result?.hypotheses) ? result.hypotheses : [],
        loading: false,
        fetched: true,
      });
    } catch (err) {
      console.warn('[hypothesisStore] fetch failed:', err);
      set({ hypotheses: [], loading: false, fetched: true });
    }
  },

  confirmHypothesis: async (id: string) => {
    // Optimistic — remove from pending list
    set((s) => ({ hypotheses: s.hypotheses.filter((h) => h.id !== id) }));
    try {
      await invoke('confirm_hypothesis', { id });
    } catch (err) {
      console.warn('[hypothesisStore] confirm failed:', err);
      // Refetch on failure to reconcile state
      await get().fetchHypotheses();
    }
  },

  rejectHypothesis: async (id: string) => {
    set((s) => ({ hypotheses: s.hypotheses.filter((h) => h.id !== id) }));
    try {
      await invoke('reject_hypothesis', { id });
    } catch (err) {
      console.warn('[hypothesisStore] reject failed:', err);
      await get().fetchHypotheses();
    }
  },
}));
