/**
 * Vero Auth Store (Zustand)
 */

import { create } from 'zustand';
import { authRepository, AuthUser, AuthResult } from './AuthRepository';
import { supabase, isSupabaseConfigured } from '../../core/network/supabase';
import { databaseService } from '../../core/storage/DatabaseService';
import { keyDirectory } from '../keys/KeyDirectory';
import { mediaCache } from '../media/mediaCache';

export const DEMO_USER_ID = 'demo-user';

interface AuthState {
  user: AuthUser | null;
  deviceId: string | null;
  isAuthenticated: boolean;
  /** True only for the offline showcase account; never touches Supabase. */
  isDemo: boolean;
  isLoading: boolean;
  initialized: boolean;

  initialize: () => Promise<void>;
  login: (email: string, password: string) => Promise<AuthResult>;
  signUp: (params: { email: string; password: string; username: string; displayName: string }) => Promise<AuthResult>;
  loginAsDemo: () => void;
  logout: () => Promise<void>;
  updateProfile: (updates: { displayName?: string; about?: string }) => Promise<{ success: boolean; error?: string }>;
}

let authListenerAttached = false;

export const useAuthStore = create<AuthState>((set, get) => {
  const applyResult = (result: AuthResult) => {
    if (result.success && result.user && result.deviceId) {
      databaseService.open(result.user.id);
      keyDirectory.reset();
      set({ user: result.user, deviceId: result.deviceId, isAuthenticated: true, isDemo: false });
    }
  };

  const clearSession = () => {
    void databaseService.close();
    mediaCache.clearAll(); // decrypted attachments never outlive the session
    keyDirectory.reset();
    set({ user: null, deviceId: null, isAuthenticated: false, isDemo: false });
  };

  return {
    user: null,
    deviceId: null,
    isAuthenticated: false,
    isDemo: false,
    isLoading: true,
    initialized: false,

    initialize: async () => {
      if (get().initialized) return;
      set({ initialized: true, isLoading: true });

      if (isSupabaseConfigured && !authListenerAttached) {
        authListenerAttached = true;
        supabase.auth.onAuthStateChange((event) => {
          // Server-side sign-out (expired refresh token, account deleted, ...).
          if (event === 'SIGNED_OUT' && get().isAuthenticated && !get().isDemo) {
            setTimeout(clearSession, 0);
          }
        });
      }

      try {
        if (isSupabaseConfigured) {
          const result = await authRepository.restoreSession();
          if (result) applyResult(result);
        }
      } catch (e) {
        console.warn('[AuthStore] session restore failed:', e);
      } finally {
        set({ isLoading: false });
      }
    },

    login: async (email, password) => {
      set({ isLoading: true });
      try {
        const result = await authRepository.login(email, password);
        applyResult(result);
        return result;
      } finally {
        set({ isLoading: false });
      }
    },

    signUp: async (params) => {
      set({ isLoading: true });
      try {
        const result = await authRepository.signUp(params);
        applyResult(result);
        return result;
      } finally {
        set({ isLoading: false });
      }
    },

    loginAsDemo: () => {
      databaseService.open(DEMO_USER_ID);
      set({
        user: { id: DEMO_USER_ID, email: 'demo@vero.app', username: 'you', displayName: 'You (Demo)' },
        deviceId: 'demo-device',
        isAuthenticated: true,
        isDemo: true,
      });
    },

    logout: async () => {
      const { user, deviceId, isDemo } = get();
      if (!isDemo) await authRepository.logout(user?.id ?? null, deviceId);
      clearSession();
    },

    updateProfile: async (updates) => {
      const { user, isDemo } = get();
      if (!user) return { success: false, error: 'Not signed in' };
      const result = isDemo ? { success: true } : await authRepository.updateProfile(user.id, updates);
      if (result.success) {
        set({
          user: {
            ...user,
            displayName: updates.displayName?.trim() || user.displayName,
            about: updates.about !== undefined ? updates.about.trim() : user.about,
          },
        });
      }
      return result;
    },
  };
});
