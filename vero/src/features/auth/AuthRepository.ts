/**
 * Vero Auth Repository
 *
 * Handles all authentication operations via Supabase Auth.
 * On registration, also initializes device crypto identity.
 */

import { supabase } from '../../core/network/supabase';
import { cryptoManager, DeviceKeys } from '../../core/crypto/CryptoManager';
import * as SecureStore from 'expo-secure-store';

const DEVICE_ID_KEY = 'vero_device_id';

export interface SignUpParams {
  email: string;
  password: string;
  username: string;
  displayName: string;
}

export interface LoginParams {
  email: string;
  password: string;
}

export interface AuthUser {
  id: string;
  email: string;
  username?: string;
  displayName?: string;
  avatarReference?: string | null;
}

export interface AuthResult {
  success: boolean;
  user?: AuthUser;
  error?: string;
}

class AuthRepository {
  // ──────────────────────────────────────────────────────────────────────────
  // Sign Up
  // ──────────────────────────────────────────────────────────────────────────

  async signUp(params: SignUpParams): Promise<AuthResult> {
    try {
      // 1. Create Supabase Auth account
      const { data, error } = await supabase.auth.signUp({
        email: params.email,
        password: params.password,
      });

      if (error || !data.user) {
        return { success: false, error: error?.message || 'Sign up failed' };
      }

      const userId = data.user.id;

      // 2. Create profile
      const { error: profileError } = await supabase
        .from('profiles')
        .insert({
          id: userId,
          username: params.username.toLowerCase().trim(),
          display_name: params.displayName.trim(),
        });

      if (profileError) {
        return { success: false, error: profileError.message };
      }

      // 3. Generate device crypto identity
      const deviceKeys = await cryptoManager.generateDeviceKeys();

      // 4. Register device with Supabase
      await this.registerDevice(userId, deviceKeys);

      return {
        success: true,
        user: {
          id: userId,
          email: params.email,
          username: params.username,
          displayName: params.displayName,
        },
      };
    } catch (e: any) {
      console.error('[AuthRepository] signUp error:', e);
      return { success: false, error: e.message || 'Unexpected error' };
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Log In
  // ──────────────────────────────────────────────────────────────────────────

  async login(params: LoginParams): Promise<AuthResult> {
    try {
      const { data, error } = await supabase.auth.signInWithPassword({
        email: params.email,
        password: params.password,
      });

      if (error || !data.user) {
        return { success: false, error: error?.message || 'Login failed' };
      }

      const userId = data.user.id;

      // Ensure device keys exist (may be first login on new device)
      const hasKeys = await cryptoManager.hasDeviceKeys();
      if (!hasKeys) {
        const deviceKeys = await cryptoManager.generateDeviceKeys();
        await this.registerDevice(userId, deviceKeys);
      }

      // Fetch profile
      const profile = await this.getProfile(userId);

      return {
        success: true,
        user: {
          id: userId,
          email: data.user.email!,
          username: profile?.username,
          displayName: profile?.display_name,
          avatarReference: profile?.avatar_reference,
        },
      };
    } catch (e: any) {
      console.error('[AuthRepository] login error:', e);
      return { success: false, error: e.message || 'Unexpected error' };
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Logout
  // ──────────────────────────────────────────────────────────────────────────

  async logout(): Promise<void> {
    try {
      await supabase.auth.signOut();
      // Note: We intentionally do NOT clear crypto keys on logout
      // Keys should only be cleared when the device is explicitly revoked
      // This allows re-login on the same device to work seamlessly
    } catch (e) {
      console.error('[AuthRepository] logout error:', e);
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Session
  // ──────────────────────────────────────────────────────────────────────────

  async getCurrentSession() {
    const { data } = await supabase.auth.getSession();
    return data.session;
  }

  async getCurrentUser(): Promise<AuthUser | null> {
    const { data } = await supabase.auth.getUser();
    if (!data.user) return null;

    const profile = await this.getProfile(data.user.id);
    return {
      id: data.user.id,
      email: data.user.email!,
      username: profile?.username,
      displayName: profile?.display_name,
      avatarReference: profile?.avatar_reference,
    };
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Device Registration
  // ──────────────────────────────────────────────────────────────────────────

  private async registerDevice(userId: string, deviceKeys: DeviceKeys): Promise<void> {
    const deviceLabel = `Mobile Device`;

    const { data, error } = await supabase
      .from('devices')
      .insert({
        user_id: userId,
        device_label: deviceLabel,
        identity_public_key: deviceKeys.identityPublicKey,
        registration_id: deviceKeys.registrationId,
      })
      .select('id')
      .single();

    if (error) {
      console.error('[AuthRepository] registerDevice error:', error);
      throw error;
    }

    // Store device ID locally
    await SecureStore.setItemAsync(DEVICE_ID_KEY, data.id);
  }

  async getLocalDeviceId(): Promise<string | null> {
    return SecureStore.getItemAsync(DEVICE_ID_KEY);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Profile
  // ──────────────────────────────────────────────────────────────────────────

  private async getProfile(userId: string) {
    const { data } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', userId)
      .single();
    return data;
  }

  async updateProfile(updates: {
    displayName?: string;
    about?: string;
    avatarReference?: string;
  }): Promise<{ success: boolean; error?: string }> {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return { success: false, error: 'Not authenticated' };

    const { error } = await supabase
      .from('profiles')
      .update({
        ...(updates.displayName && { display_name: updates.displayName }),
        ...(updates.about !== undefined && { about: updates.about }),
        ...(updates.avatarReference && { avatar_reference: updates.avatarReference }),
      })
      .eq('id', user.id);

    if (error) return { success: false, error: error.message };
    return { success: true };
  }
}

export const authRepository = new AuthRepository();
