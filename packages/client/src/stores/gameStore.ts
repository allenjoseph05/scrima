import { type UnlistenFn, listen } from '@tauri-apps/api/event';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

// ── Game Definitions ─────────────────────────────────────────────────────────

export interface GameDefinition {
  id: string;
  name: string;
  accentColor: string;
  labels: {
    character: string; // "Agent" for Valorant, "Champion" for LoL, "Legend" for Apex
    map: string;
    mode: string;
  };
  enabled: boolean;
}

export const GAME_DEFINITIONS: GameDefinition[] = [
  {
    id: 'valorant',
    name: 'Valorant',
    accentColor: '#FF4655',
    labels: { character: 'Agent', map: 'Map', mode: 'Game Mode' },
    enabled: true,
  },
  {
    id: 'cs2',
    name: 'CS2',
    accentColor: '#DE9B35',
    labels: { character: 'Operator', map: 'Map', mode: 'Game Mode' },
    enabled: false,
  },
  {
    id: 'league_of_legends',
    name: 'League',
    accentColor: '#C89B3C',
    labels: { character: 'Champion', map: 'Map', mode: 'Queue' },
    enabled: false,
  },
];

// ── Store ────────────────────────────────────────────────────────────────────

interface GameState {
  activeGameId: string;
  setActiveGame: (gameId: string) => void;
  getDefinition: () => GameDefinition;
}

export const useGameStore = create<GameState>()(
  persist(
    (set, get) => ({
      activeGameId: 'valorant',

      setActiveGame: (gameId: string) => {
        const exists = GAME_DEFINITIONS.some((g) => g.id === gameId && g.enabled);
        if (exists) {
          set({ activeGameId: gameId });
        }
      },

      getDefinition: () =>
        GAME_DEFINITIONS.find((g) => g.id === get().activeGameId) ?? GAME_DEFINITIONS[0],
    }),
    {
      name: 'scrima-game-store',
      storage: createJSONStorage(() => localStorage),
      partialize: (s) => ({ activeGameId: s.activeGameId }),
    },
  ),
);

// ── Event listener — auto-switch when backend detects a game ─────────────────

let _unlisten: UnlistenFn[] = [];

export async function initGameStoreListeners() {
  // Clean up any existing listeners first
  teardownGameStoreListeners();

  _unlisten.push(
    await listen<{ game: string; running: boolean }>('scrima:game-detected', ({ payload }) => {
      if (payload.running) {
        useGameStore.getState().setActiveGame(payload.game);
      }
    }),
  );
}

export function teardownGameStoreListeners() {
  _unlisten.forEach((fn) => fn());
  _unlisten = [];
}
