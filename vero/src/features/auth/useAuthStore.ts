/**
 * Vero Auth Store (Zustand)
 *
 * Global auth state management.
 */

import { create } from 'zustand';
import { authRepository, AuthUser } from './AuthRepository';
import { supabase } from '../../core/network/supabase';

interface AuthState {
  user: AuthUser | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  deviceId: string | null;

  // Actions
  initialize: () => Promise<void>;
  login: (email: string, password: string) => Promise<{ success: boolean; error?: string }>;
  signUp: (params: {
    email: string;
    password: string;
    username: string;
    displayName: string;
  }) => Promise<{ success: boolean; error?: string }>;
  logout: () => Promise<void>;
  updateProfile: (updates: {
    displayName?: string;
    about?: string;
    avatarReference?: string;
  }) => Promise<{ success: boolean; error?: string }>;
  loginAsDemo: () => Promise<{ success: boolean }>;
  setUser: (user: AuthUser | null) => void;
}

export const useAuthStore = create<AuthState>((set, get) => ({
  user: null,
  isAuthenticated: false,
  isLoading: true,
  deviceId: null,

  initialize: async () => {
    set({ isLoading: true });
    try {
      const session = await authRepository.getCurrentSession();
      if (session) {
        const user = await authRepository.getCurrentUser();
        const deviceId = await authRepository.getLocalDeviceId();
        set({ user, isAuthenticated: !!user, deviceId });
      } else {
        set({ user: null, isAuthenticated: false });
      }

      // Listen to auth state changes
      supabase.auth.onAuthStateChange(async (event, session) => {
        if (event === 'SIGNED_IN' && session) {
          const user = await authRepository.getCurrentUser();
          const deviceId = await authRepository.getLocalDeviceId();
          set({ user, isAuthenticated: true, deviceId });
        } else if (event === 'SIGNED_OUT') {
          set({ user: null, isAuthenticated: false, deviceId: null });
        }
      });
    } catch (e) {
      console.error('[AuthStore] initialize error:', e);
      set({ user: null, isAuthenticated: false });
    } finally {
      set({ isLoading: false });
    }
  },

  login: async (email: string, password: string) => {
    set({ isLoading: true });
    try {
      const result = await authRepository.login({ email, password });
      if (result.success && result.user) {
        const deviceId = await authRepository.getLocalDeviceId();
        set({ user: result.user, isAuthenticated: true, deviceId });
      }
      return { success: result.success, error: result.error };
    } finally {
      set({ isLoading: false });
    }
  },

  signUp: async (params) => {
    set({ isLoading: true });
    try {
      const result = await authRepository.signUp(params);
      if (result.success && result.user) {
        const deviceId = await authRepository.getLocalDeviceId();
        set({ user: result.user, isAuthenticated: true, deviceId });
      }
      return { success: result.success, error: result.error };
    } finally {
      set({ isLoading: false });
    }
  },

  logout: async () => {
    await authRepository.logout();
    set({ user: null, isAuthenticated: false, deviceId: null });
  },

  updateProfile: async (updates) => {
    const result = await authRepository.updateProfile(updates);
    if (result.success && updates.displayName) {
      const { user } = get();
      if (user) {
        set({
          user: {
            ...user,
            displayName: updates.displayName || user.displayName,
            avatarReference: updates.avatarReference ?? user.avatarReference,
          },
        });
      }
    }
    return result;
  },
  loginAsDemo: async () => {
    set({ isLoading: true });
    try {
      const demoUser: AuthUser = {
        id: 'demo-user-id-001',
        email: 'alex.chen@vero.network',
        username: 'alexchen',
        displayName: 'Alex Chen (Vero)',
        avatarReference: 'https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?auto=format&fit=crop&w=200&q=80',
      };
      set({ user: demoUser, isAuthenticated: true, deviceId: 'dev_local_primary' });
      return { success: true };
    } finally {
      set({ isLoading: false });
    }
  },

  setUser: (user) => set({ user, isAuthenticated: !!user }),
}));
