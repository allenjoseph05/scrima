import { type UnlistenFn, listen } from '@tauri-apps/api/event';
import { create } from 'zustand';

type View = 'dashboard' | 'history' | 'coaching' | 'your_coach';

export interface AppNotification {
  id: string;
  title: string;
  body: string;
  type: 'analysis_complete' | 'weekly_report' | 'error';
  targetView: View;
  read: boolean;
  createdAt: number;
}

interface NotificationState {
  notifications: AppNotification[];
  unreadCounts: Record<string, number>;
  addNotification: (n: Omit<AppNotification, 'id' | 'createdAt' | 'read'>) => void;
  markRead: (id: string) => void;
  dismissForView: (view: View) => void;
  clearAll: () => void;
  unreadCountForView: (view: View) => number;
}

let counter = 0;

function computeUnreadCounts(notifications: AppNotification[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const n of notifications) {
    if (!n.read) {
      counts[n.targetView] = (counts[n.targetView] || 0) + 1;
    }
  }
  return counts;
}

export const useNotificationStore = create<NotificationState>((set, get) => ({
  notifications: [],
  unreadCounts: {},

  addNotification: (n) => {
    const notification: AppNotification = {
      ...n,
      id: `notif-${Date.now()}-${counter++}`,
      read: false,
      createdAt: Date.now(),
    };
    set((s) => {
      const notifications = [notification, ...s.notifications].slice(0, 50);
      return { notifications, unreadCounts: computeUnreadCounts(notifications) };
    });
  },

  markRead: (id) => {
    set((s) => {
      const notifications = s.notifications.map((n) => (n.id === id ? { ...n, read: true } : n));
      return { notifications, unreadCounts: computeUnreadCounts(notifications) };
    });
  },

  dismissForView: (view) => {
    set((s) => {
      const notifications = s.notifications.map((n) =>
        n.targetView === view && !n.read ? { ...n, read: true } : n,
      );
      return { notifications, unreadCounts: computeUnreadCounts(notifications) };
    });
  },

  clearAll: () => set({ notifications: [], unreadCounts: {} }),

  unreadCountForView: (view) => {
    return get().notifications.filter((n) => n.targetView === view && !n.read).length;
  },
}));

// ── Tauri event listeners ─────────────────────────────────────────────────────

const unlisteners: UnlistenFn[] = [];

export async function initNotificationListeners() {
  // Clean up any existing listeners first
  cleanupNotificationListeners();

  const { addNotification } = useNotificationStore.getState();

  unlisteners.push(
    await listen<{ matchId: string }>('scrima:analysis-complete', (e) => {
      addNotification({
        title: 'Analysis Complete',
        body: `Coaching report ready for match ${(e.payload.matchId ?? '').slice(0, 8)}`,
        type: 'analysis_complete',
        targetView: 'coaching',
      });
    }),
  );

  unlisteners.push(
    await listen('scrima:weekly-report-ready', () => {
      addNotification({
        title: 'Weekly Report Ready',
        body: 'Your weekly coaching report is ready to view.',
        type: 'weekly_report',
        targetView: 'coaching',
      });
    }),
  );

  unlisteners.push(
    await listen<{ matchId: string; reason: string }>('scrima:recording-crashed', (e) => {
      addNotification({
        title: 'Recording Stopped Unexpectedly',
        body: e.payload.reason || 'ffmpeg crashed — partial recording saved to history.',
        type: 'error',
        targetView: 'dashboard',
      });
    }),
  );
}

export function cleanupNotificationListeners() {
  unlisteners.forEach((fn) => fn());
  unlisteners.length = 0;
}
