import { invoke } from '@tauri-apps/api/core';
import { create } from 'zustand';

export type ConnectionState = 'online' | 'offline' | 'server_down' | 'unknown';

// Tunables — deliberately forgiving to avoid flappy false positives.
//   - HEARTBEAT_INTERVAL_MS: how often we ping when healthy (baseline).
//   - FAILURE_THRESHOLD: require this many consecutive misses before showing
//     the banner. A single dropped packet, a dev-server --watch restart,
//     or a transient NIC blip on Windows must NOT trigger it.
//   - FAST_RETRY_MS: after a failure we retry quickly so recovery is snappy.
const HEARTBEAT_INTERVAL_MS = 60_000;
const FAST_RETRY_MS = 4_000;
const FAILURE_THRESHOLD = 3;

interface ConnectivityState {
  status: ConnectionState;
  /** Monotonic counter of consecutive failed heartbeats. */
  consecutiveFailures: number;
  /** Timestamp of the last successful heartbeat (ms epoch, 0 until first success). */
  lastOkAt: number;
  setOnline: () => void;
  setOffline: () => void;
  recordHeartbeat: (ok: boolean) => void;
}

export const useConnectivityStore = create<ConnectivityState>((set, get) => ({
  status: 'unknown',
  consecutiveFailures: 0,
  lastOkAt: 0,

  setOnline: () =>
    set((s) => ({
      status: s.consecutiveFailures >= FAILURE_THRESHOLD ? 'server_down' : 'online',
    })),

  setOffline: () => set({ status: 'offline', consecutiveFailures: 0 }),

  recordHeartbeat: (ok: boolean) => {
    if (ok) {
      set({ status: 'online', consecutiveFailures: 0, lastOkAt: Date.now() });
      return;
    }
    const next = get().consecutiveFailures + 1;
    set({
      consecutiveFailures: next,
      status: next >= FAILURE_THRESHOLD ? 'server_down' : get().status,
    });
  },
}));

// ── Init / teardown ──────────────────────────────────────────────────────────

let heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
let onlineHandler: (() => void) | null = null;
let offlineHandler: (() => void) | null = null;
let running = false;

async function pingOnce(): Promise<boolean> {
  // If the browser says we're offline, don't even try — just flip the store.
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    useConnectivityStore.getState().setOffline();
    return false;
  }
  try {
    const ok = await invoke<boolean>('check_server_health');
    useConnectivityStore.getState().recordHeartbeat(ok);
    return ok;
  } catch {
    useConnectivityStore.getState().recordHeartbeat(false);
    return false;
  }
}

/**
 * Self-scheduling heartbeat loop: on success we wait HEARTBEAT_INTERVAL_MS;
 * on failure we wait FAST_RETRY_MS so transient blips don't hold the banner
 * visible for a whole minute after the server recovers.
 */
function scheduleNext(delay: number) {
  if (!running) return;
  heartbeatTimer = setTimeout(async () => {
    if (!running) return;
    const ok = await pingOnce();
    scheduleNext(ok ? HEARTBEAT_INTERVAL_MS : FAST_RETRY_MS);
  }, delay);
}

export function initConnectivityMonitor() {
  if (running) return;
  running = true;

  onlineHandler = () => {
    useConnectivityStore.getState().setOnline();
    void pingOnce();
  };
  offlineHandler = () => {
    useConnectivityStore.getState().setOffline();
  };
  window.addEventListener('online', onlineHandler);
  window.addEventListener('offline', offlineHandler);

  // Seed: initial state reflects the browser's online flag,
  // then immediately run a heartbeat so `server_down` can be detected.
  if (navigator.onLine === false) {
    useConnectivityStore.getState().setOffline();
    scheduleNext(FAST_RETRY_MS);
  } else {
    void pingOnce().then((ok) => scheduleNext(ok ? HEARTBEAT_INTERVAL_MS : FAST_RETRY_MS));
  }
}

export function teardownConnectivityMonitor() {
  running = false;
  if (heartbeatTimer) {
    clearTimeout(heartbeatTimer);
    heartbeatTimer = null;
  }
  if (onlineHandler) {
    window.removeEventListener('online', onlineHandler);
    onlineHandler = null;
  }
  if (offlineHandler) {
    window.removeEventListener('offline', offlineHandler);
    offlineHandler = null;
  }
}
