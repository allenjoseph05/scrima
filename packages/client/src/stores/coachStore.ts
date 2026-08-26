import { invoke } from '@tauri-apps/api/core';
import { create } from 'zustand';
import { formatUserError } from '../lib/errors';

// ── Types ────────────────────────────────────────────────────────────────────

export type CoachTab = 'coach' | 'skills' | 'journey' | 'data';

export interface CoachMessage {
  id: string;
  role: 'user' | 'coach';
  content: string;
  timestamp: number;
  type?: 'greeting' | 'insight' | 'chat';
}

export interface Observation {
  id: string;
  category: 'habit' | 'strength' | 'insight';
  text: string;
  occurrences: number;
  lastSeenAt: string;
  createdAt: string;
  // Phase 6 — Brain self-model. May be null on observations created before migration 0006.
  confidence?: number | null;
  confirmedAt?: string | null;
  disagreedAt?: string | null;
}

export interface SkillMastery {
  id: string;
  name: string;
  domain: string;
  mastery: number;
  trend: string;
  observations: number;
}

export interface BrainData {
  mastery: {
    skills: SkillMastery[];
    weakest: { id: string; name: string; mastery: number }[];
    strongest: { id: string; name: string; mastery: number }[];
  };
  graph: {
    totalNodes: number;
    totalEdges: number;
    patterns: { label: string; category: string; occurrences: number }[];
    recentGames: { label: string; createdAt: string }[];
  };
  strategies: {
    effective: { type: string; description: string; qValue: number }[];
    ineffective: { type: string; description: string; qValue: number }[];
  };
  observations: {
    habits: Observation[];
    strengths: Observation[];
    insights: Observation[];
  };
  reflections: { title: string; insight: string }[];
}

// ── Store ────────────────────────────────────────────────────────────────────

interface CoachState {
  // Tab navigation
  activeTab: CoachTab;
  setActiveTab: (tab: CoachTab) => void;

  // Boot animation (once per session)
  booted: boolean;
  setBooted: () => void;

  // Brain data
  brain: BrainData | null;
  brainLoading: boolean;
  brainError: string | null;
  fetchBrain: () => Promise<void>;

  // Chat
  messages: CoachMessage[];
  chatLoading: boolean;
  sendMessage: (text: string) => Promise<void>;
  initGreeting: () => Promise<void>;

  // Data management
  dismissObservation: (id: string) => Promise<void>;
  agreeObservation: (id: string) => Promise<void>;
  disagreeObservation: (id: string) => Promise<void>;
  resetBrain: () => Promise<void>;
}

let msgCounter = 0;
function makeId() {
  return `msg-${Date.now()}-${msgCounter++}`;
}

// Optimistically patch a single observation in the brain's observation lists.
function patchObservation(
  s: { brain: BrainData | null },
  id: string,
  patch: Partial<Observation>,
): { brain: BrainData | null } {
  if (!s.brain) return s;
  const apply = (list: Observation[]): Observation[] =>
    list.map((o) => (o.id === id ? { ...o, ...patch } : o));
  return {
    brain: {
      ...s.brain,
      observations: {
        habits: apply(s.brain.observations.habits),
        strengths: apply(s.brain.observations.strengths),
        insights: apply(s.brain.observations.insights),
      },
    },
  };
}

export const useCoachStore = create<CoachState>((set, get) => ({
  // Tab
  activeTab: 'coach',
  setActiveTab: (tab) => set({ activeTab: tab }),

  // Boot
  booted: false,
  setBooted: () => set({ booted: true }),

  // Brain
  brain: null,
  brainLoading: false,
  brainError: null,

  fetchBrain: async () => {
    set({ brainLoading: true, brainError: null });
    try {
      const result = await invoke<BrainData>('get_coaching_brain');
      set({ brain: result, brainLoading: false });
    } catch (err: any) {
      set({ brainError: err?.toString() ?? 'Failed to load brain data', brainLoading: false });
    }
  },

  // Chat
  messages: [],
  chatLoading: false,

  initGreeting: async () => {
    if (get().messages.length > 0) return; // already greeted
    set({ chatLoading: true });
    try {
      const res = await invoke<{ greeting: string }>('get_brain_greeting');
      set({
        messages: [
          {
            id: makeId(),
            role: 'coach',
            content: res.greeting,
            timestamp: Date.now(),
            type: 'greeting',
          },
        ],
        chatLoading: false,
      });
    } catch {
      // Fallback static greeting
      set({
        messages: [
          {
            id: makeId(),
            role: 'coach',
            content: "Welcome to Scrima. Play a game and I'll start learning how you play.",
            timestamp: Date.now(),
            type: 'greeting',
          },
        ],
        chatLoading: false,
      });
    }
  },

  sendMessage: async (text: string) => {
    const userMsg: CoachMessage = {
      id: makeId(),
      role: 'user',
      content: text,
      timestamp: Date.now(),
      type: 'chat',
    };

    const prev = get().messages;
    set({ messages: [...prev, userMsg], chatLoading: true });

    // Build history for the API (exclude greeting type metadata)
    const history = [...prev, userMsg]
      .filter((m) => m.type !== 'greeting' || m.role === 'coach')
      .map((m) => ({ role: m.role === 'coach' ? 'assistant' : 'user', content: m.content }));

    try {
      const res = await invoke<{
        answer: string;
        tokensUsed: number;
        softBlock?: boolean;
        quota?: { limit: number; remaining: number };
      }>('ask_brain_question', {
        question: text,
        history,
      });

      const coachMsg: CoachMessage = {
        id: makeId(),
        role: 'coach',
        content: res.answer,
        timestamp: Date.now(),
        type: 'chat',
      };

      set((s) => ({ messages: [...s.messages, coachMsg], chatLoading: false }));
    } catch (err) {
      console.error('ask_brain_question failed:', err);
      const errorMsg: CoachMessage = {
        id: makeId(),
        role: 'coach',
        content: formatUserError(
          err,
          "Sorry, I couldn't answer that right now. Try again in a moment.",
        ),
        timestamp: Date.now(),
        type: 'chat',
      };
      set((s) => ({ messages: [...s.messages, errorMsg], chatLoading: false }));
    }
  },

  // Data management
  dismissObservation: async (id: string) => {
    try {
      await invoke('dismiss_observation', { id });
      // Remove from local brain data
      set((s) => {
        if (!s.brain) return s;
        const obs = s.brain.observations;
        return {
          brain: {
            ...s.brain,
            observations: {
              habits: obs.habits.filter((o) => o.id !== id),
              strengths: obs.strengths.filter((o) => o.id !== id),
              insights: obs.insights.filter((o) => o.id !== id),
            },
          },
        };
      });
    } catch (err: any) {
      console.error('Failed to dismiss observation:', err);
    }
  },

  // Phase 6 — agree/disagree update local state optimistically
  agreeObservation: async (id: string) => {
    try {
      await invoke('agree_observation', { id });
      set((s) =>
        patchObservation(s, id, {
          confidence: 1.0,
          confirmedAt: new Date().toISOString(),
          disagreedAt: null,
        }),
      );
    } catch (err: any) {
      console.error('Failed to agree with observation:', err);
    }
  },

  disagreeObservation: async (id: string) => {
    try {
      await invoke('disagree_observation', { id });
      set((s) =>
        patchObservation(s, id, {
          confidence: 0.0,
          disagreedAt: new Date().toISOString(),
          confirmedAt: null,
        }),
      );
    } catch (err: any) {
      console.error('Failed to disagree with observation:', err);
    }
  },

  resetBrain: async () => {
    try {
      await invoke('reset_brain');
      set({
        brain: {
          mastery: { skills: [], weakest: [], strongest: [] },
          graph: { totalNodes: 0, totalEdges: 0, patterns: [], recentGames: [] },
          strategies: { effective: [], ineffective: [] },
          observations: { habits: [], strengths: [], insights: [] },
          reflections: [],
        },
        messages: [],
      });
    } catch (err: any) {
      console.error('Failed to reset brain:', err);
    }
  },
}));
