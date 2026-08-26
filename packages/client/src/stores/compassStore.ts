/**
 * Bottleneck Compass Store (Phase 3)
 *
 * Fetches the player's current bottleneck skill — the single skill whose
 * improvement would unblock the most downstream skills. Backed by BKT mastery
 * data + the static prerequisite graph in skill-taxonomy.ts on the server.
 *
 * See: docs/YOUR_COACH_PHASE3_PLAN.md
 */

import { invoke } from '@tauri-apps/api/core';
import { create } from 'zustand';

// ── Types mirror BottleneckCompassService.CompassState on the server ────────

export type CompassPrimary = {
  skillId: string;
  name: string;
  domain: string;
  pMastery: number;
  blockedCount: number;
  blockedSkillIds: string[];
};

export type CompassRunnerUp = {
  skillId: string;
  name: string;
  blockedCount: number;
};

export type CompassState =
  | { state: 'building'; totalObservations: number; gamesToGo: number }
  | { state: 'early'; totalObservations: number }
  | { state: 'all_mastered' }
  | {
      state: 'ready';
      primary: CompassPrimary;
      runnersUp: CompassRunnerUp[];
      totalObservations: number;
      alignedWithPriorityCategory?: boolean;
    };

// ── Store ───────────────────────────────────────────────────────────────────

interface CompassStore {
  compass: CompassState | null;
  loading: boolean;
  lastCategoryFetched: string | null;
  fetchCompass: (priorityCategory?: string) => Promise<void>;
}

export const useCompassStore = create<CompassStore>((set, get) => ({
  compass: null,
  loading: false,
  lastCategoryFetched: null,

  fetchCompass: async (priorityCategory) => {
    // Dedup: skip if we already fetched for this same category and we have data
    const current = get();
    if (
      current.compass !== null &&
      current.lastCategoryFetched === (priorityCategory ?? null) &&
      !current.loading
    ) {
      return;
    }

    set({ loading: true });
    try {
      const result = await invoke<CompassState>('get_compass', {
        priorityCategory: priorityCategory ?? null,
      });
      set({
        compass: result,
        loading: false,
        lastCategoryFetched: priorityCategory ?? null,
      });
    } catch (err) {
      console.warn('[compassStore] fetch failed:', err);
      // Degrade gracefully — don't crash the report view
      set({
        compass: { state: 'building', totalObservations: 0, gamesToGo: 5 },
        loading: false,
        lastCategoryFetched: priorityCategory ?? null,
      });
    }
  },
}));
