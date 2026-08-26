import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-shell';
import { create } from 'zustand';
import { formatUserError } from '../lib/errors';

interface AuthStatus {
  isLoggedIn: boolean;
  email: string | null;
  displayName: string | null;
  subscriptionTier: string | null;
}

interface DeviceCodeResponse {
  userCode: string;
  deviceCode: string;
  verifyUrl: string;
  expiresIn: number;
}

interface AuthSession {
  sessionToken: string;
  userId: string;
  email: string | null;
  displayName: string | null;
  subscriptionTier: string | null;
}

interface AuthState {
  isLoggedIn: boolean;
  email: string | null;
  displayName: string | null;
  subscriptionTier: string | null;

  // Login flow state
  isLoggingIn: boolean;
  loginUserCode: string | null;
  loginError: string | null;

  /** Check stored session on app startup. */
  checkAuth: () => Promise<void>;

  /** Start the device code login flow. */
  startLogin: () => Promise<void>;

  /** Cancel an in-progress login. */
  cancelLogin: () => void;

  /** Log out and clear session. */
  logout: () => Promise<void>;
}

export const useAuthStore = create<AuthState>((set, get) => ({
  isLoggedIn: false,
  email: null,
  displayName: null,
  subscriptionTier: null,

  isLoggingIn: false,
  loginUserCode: null,
  loginError: null,

  checkAuth: async () => {
    try {
      const status = await invoke<AuthStatus>('auth_get_status');
      set({
        isLoggedIn: status.isLoggedIn,
        email: status.email,
        displayName: status.displayName,
        subscriptionTier: status.subscriptionTier,
      });
    } catch (err) {
      console.error('Auth check failed:', err);
      set({ isLoggedIn: false });
    }
  },

  startLogin: async () => {
    set({ isLoggingIn: true, loginError: null, loginUserCode: null });

    try {
      // Step 1: Get device code
      const deviceCode = await invoke<DeviceCodeResponse>('auth_start_login');
      set({ loginUserCode: deviceCode.userCode });

      // Step 2: Open browser to verify URL
      await open(deviceCode.verifyUrl);

      // Step 3: Poll for completion
      const maxAttempts = Math.floor(deviceCode.expiresIn / 3);
      for (let i = 0; i < maxAttempts; i++) {
        // Check if login was cancelled
        if (!get().isLoggingIn) return;

        await new Promise((r) => setTimeout(r, 3000));

        try {
          const session = await invoke<AuthSession | null>('auth_poll_token', {
            deviceCode: deviceCode.deviceCode,
          });

          if (session) {
            set({
              isLoggedIn: true,
              email: session.email,
              displayName: session.displayName,
              subscriptionTier: session.subscriptionTier,
              isLoggingIn: false,
              loginUserCode: null,
            });
            return;
          }
        } catch (err) {
          const msg = String(err);
          if (msg.includes('expired')) {
            set({ loginError: 'Login code expired. Please try again.', isLoggingIn: false });
            return;
          }
          // Other errors — keep polling
        }
      }

      // Timeout
      set({ loginError: 'Login timed out. Please try again.', isLoggingIn: false });
    } catch (err) {
      console.error('Login flow failed:', err);
      set({
        loginError: formatUserError(
          err,
          'Could not connect to the login service. Please check your connection and try again.',
        ),
        isLoggingIn: false,
      });
    }
  },

  cancelLogin: () => {
    set({ isLoggingIn: false, loginUserCode: null, loginError: null });
  },

  logout: async () => {
    try {
      await invoke('auth_logout');
    } catch (err) {
      console.error('Logout error:', err);
    }
    set({
      isLoggedIn: false,
      email: null,
      displayName: null,
      subscriptionTier: null,
    });
  },
}));
