/**
 * Era Store (Phase 5 — Living Mind)
 *
 * Fetches the player's eras — variable-length chapters of growth, one per
 * bottleneck skill the coach has been working on with the player.
 */

import { invoke } from '@tauri-apps/api/core';
import { create } from 'zustand';

export interface EraData {
  startDate: string;
  endDate: string | null;
  status: 'active' | 'graduated' | 'abandoned' | 'paused';
  primarySkillId: string;
  primarySkillName: string;
  domain: string;
  gamesCount: number;
  startMastery: number;
  endMastery: number | null;
  summary: string;
}

/** Live status for closed eras — re-checked vs current skill mastery on read. */
export type EraLiveStatus = 'active' | 'maintained' | 'declining' | 'regressed' | 'unknown';

export interface Era {
  id: string;
  label: string;
  data: EraData;
  createdAt: string;
  /** Current pMastery for the era's primary skill (re-fetched on each list call). */
  currentMastery?: number | null;
  /** UI-facing live status — drives the regression badge. */
  liveStatus?: EraLiveStatus;
}

interface EraStore {
  eras: Era[];
  loading: boolean;
  fetched: boolean;
  fetchEras: () => Promise<void>;
}

export const useEraStore = create<EraStore>((set, get) => ({
  eras: [],
  loading: false,
  fetched: false,

  fetchEras: async () => {
    if (get().loading) return;
    set({ loading: true });
    try {
      const result = await invoke<{ eras: Era[] }>('get_eras');
      set({
        eras: Array.isArray(result?.eras) ? result.eras : [],
        loading: false,
        fetched: true,
      });
    } catch (err) {
      console.warn('[eraStore] fetch failed:', err);
      set({ eras: [], loading: false, fetched: true });
    }
  },
}));
