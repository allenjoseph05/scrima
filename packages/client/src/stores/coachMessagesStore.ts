/**
 * Coach Messages Store (Phase 7D — Proactive Coach)
 *
 * Unread messages the coach has pushed based on key events (era closed, era
 * started, new hypothesis, returning player, plateau). User dismisses by
 * clicking — optimistic remove + server mark-read in background.
 */

import { invoke } from '@tauri-apps/api/core';
import { create } from 'zustand';

export type CoachMessageTrigger =
  | 'era_closed'
  | 'era_started'
  | 'hypothesis_new'
  | 'returning_player'
  | 'plateau_detected';

export interface CoachMessageData {
  trigger: CoachMessageTrigger;
  triggerRef?: string;
  body?: string;
  read: boolean;
  readAt?: string;
}

export interface CoachMessage {
  id: string;
  label: string;
  data: CoachMessageData;
  createdAt: string;
}

interface CoachMessagesStore {
  messages: CoachMessage[];
  loading: boolean;
  fetched: boolean;
  fetchMessages: () => Promise<void>;
  markRead: (id: string) => Promise<void>;
}

export const useCoachMessagesStore = create<CoachMessagesStore>((set, get) => ({
  messages: [],
  loading: false,
  fetched: false,

  fetchMessages: async () => {
    if (get().loading) return;
    set({ loading: true });
    try {
      const result = await invoke<{ messages: CoachMessage[] }>('get_coach_messages');
      set({
        messages: Array.isArray(result?.messages) ? result.messages : [],
        loading: false,
        fetched: true,
      });
    } catch (err) {
      console.warn('[coachMessagesStore] fetch failed:', err);
      set({ messages: [], loading: false, fetched: true });
    }
  },

  markRead: async (id: string) => {
    // Optimistic — remove immediately
    set((s) => ({ messages: s.messages.filter((m) => m.id !== id) }));
    try {
      await invoke('mark_coach_message_read', { id });
    } catch (err) {
      console.warn('[coachMessagesStore] mark-read failed:', err);
      await get().fetchMessages();
    }
  },
}));
