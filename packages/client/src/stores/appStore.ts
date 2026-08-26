import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

export type Screen = 'home' | 'game';
export type GameView = 'dashboard' | 'history' | 'coaching' | 'your_coach';

// Legacy alias so existing imports of `View` still compile during migration
export type View = GameView;

interface AppState {
  isInitialized: boolean;
  screen: Screen;
  activeView: GameView;
  showSettings: boolean;

  initialize: () => Promise<void>;
  setActiveView: (view: GameView) => void;
  enterGame: (gameId: string) => void;
  goHome: () => void;
  toggleSettings: () => void;
}

export const useAppStore = create<AppState>()(
  persist(
    (set) => ({
      isInitialized: false,
      screen: 'home',
      activeView: 'dashboard',
      showSettings: false,

      initialize: async () => {
        set({ isInitialized: true });
      },

      setActiveView: (view) => set({ activeView: view }),

      enterGame: (gameId: string) => {
        import('./gameStore').then(({ useGameStore }) => {
          useGameStore.getState().setActiveGame(gameId);
        });
        set({ screen: 'game', activeView: 'dashboard' });
      },

      goHome: () => set({ screen: 'home', showSettings: false }),

      toggleSettings: () => set((s) => ({ showSettings: !s.showSettings })),
    }),
    {
      name: 'scrima-app-store',
      storage: createJSONStorage(() => localStorage),
      partialize: (s) => ({ screen: s.screen, activeView: s.activeView }),
      onRehydrateStorage: () => (state) => {
        // Guard: if we rehydrated into 'game' but gameStore has no valid game, fall back
        if (state && state.screen === 'game') {
          import('./gameStore').then(({ useGameStore, GAME_DEFINITIONS }) => {
            const id = useGameStore.getState().activeGameId;
            if (!GAME_DEFINITIONS.some((g) => g.id === id && g.enabled)) {
              state.screen = 'home';
            }
          });
        }
      },
    },
  ),
);
