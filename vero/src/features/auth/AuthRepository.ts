/**
 * Vero Auth Repository
 *
 * Supabase Auth + per-device identity registration.
 * The profile row is created server-side by a trigger from the sign-up
 * metadata, so sign-up also works when email confirmation is enabled.
 */

import { Platform } from 'react-native';
import * as Device from 'expo-device';
import { supabase, friendlyError } from '../../core/network/supabase';
import { cryptoManager } from '../../core/crypto/CryptoManager';

export interface SignUpParams {
  email: string;
  password: string;
  username: string;
  displayName: string;
}

export interface AuthUser {
  id: string;
  email: string;
  username?: string;
  displayName?: string;
  avatarReference?: string | null;
  about?: string | null;
}

export interface AuthResult {
  success: boolean;
  user?: AuthUser;
  deviceId?: string;
  /** Sign-up succeeded but the project requires email confirmation first. */
  needsEmailConfirmation?: boolean;
  error?: string;
}

function deviceLabel(): string {
  const name = Device.modelName || Device.deviceName;
  const os = Platform.OS === 'ios' ? 'iOS' : Platform.OS === 'android' ? 'Android' : 'Web';
  return (name ? `${name} (${os})` : `${os} device`).slice(0, 64);
}

class AuthRepository {
  async isUsernameAvailable(username: string): Promise<boolean> {
    const { data, error } = await supabase.rpc('username_available', { p_username: username });
    if (error) return true; // let the server-side unique constraint decide
    return data === true;
  }

  async signUp(params: SignUpParams): Promise<AuthResult> {
    try {
      const username = params.username.trim().toLowerCase();
      if (!(await this.isUsernameAvailable(username))) {
        return { success: false, error: 'That username is already taken.' };
      }

      const { data, error } = await supabase.auth.signUp({
        email: params.email.trim(),
        password: params.password,
        options: { data: { username, display_name: params.displayName.trim() } },
      });
      if (error) return { success: false, error: error.message };
      if (!data.user) return { success: false, error: 'Sign up failed' };
      if (!data.session) return { success: true, needsEmailConfirmation: true };

      return this.completeSession(data.user.id, data.user.email ?? params.email);
    } catch (e) {
      return { success: false, error: friendlyError(e) };
    }
  }

  async login(email: string, password: string): Promise<AuthResult> {
    try {
      const { data, error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
      if (error || !data.user) return { success: false, error: error?.message || 'Login failed' };
      return this.completeSession(data.user.id, data.user.email ?? email);
    } catch (e) {
      return { success: false, error: friendlyError(e) };
    }
  }

  /** Restores a persisted session on app start (null when signed out). */
  async restoreSession(): Promise<AuthResult | null> {
    const { data } = await supabase.auth.getSession();
    const user = data.session?.user;
    if (!user) return null;
    return this.completeSession(user.id, user.email ?? '');
  }

  async sendPasswordReset(email: string): Promise<{ success: boolean; error?: string }> {
    const { error } = await supabase.auth.resetPasswordForEmail(email.trim());
    return error ? { success: false, error: error.message } : { success: true };
  }

  private async completeSession(userId: string, email: string): Promise<AuthResult> {
    const deviceId = await this.ensureDeviceRegistered(userId);
    const profile = await this.getProfile(userId);
    return {
      success: true,
      deviceId,
      user: {
        id: userId,
        email,
        username: profile?.username,
        displayName: profile?.display_name,
        avatarReference: profile?.avatar_reference,
        about: profile?.about,
      },
    };
  }

  /**
   * Makes sure this installation has an identity key for `userId` and a live
   * (non-revoked) device row whose key matches it. Idempotent.
   */
  async ensureDeviceRegistered(userId: string): Promise<string> {
    const { publicKey } = await cryptoManager.getOrCreateIdentity(userId);
    const storedId = await cryptoManager.getDeviceId(userId);

    if (storedId) {
      const { data, error } = await supabase
        .from('devices')
        .select('id, identity_public_key, revoked_at')
        .eq('id', storedId)
        .maybeSingle();
      if (error) {
        // Offline: trust the local registration and carry on.
        return storedId;
      }
      if (data && !data.revoked_at && data.identity_public_key === publicKey) {
        void supabase.from('devices').update({ last_seen_at: new Date().toISOString() }).eq('id', storedId);
        return storedId;
      }
      if (data?.revoked_at) {
        // This installation was signed out remotely: its old key must never be reused.
        await cryptoManager.clearIdentity(userId);
        return this.ensureDeviceRegistered(userId);
      }
    }

    // Re-use an existing row for this exact key (e.g. app data restored), else register.
    const { data: existing } = await supabase
      .from('devices')
      .select('id, revoked_at')
      .eq('identity_public_key', publicKey)
      .maybeSingle();
    if (existing && !existing.revoked_at) {
      await cryptoManager.setDeviceId(userId, existing.id);
      return existing.id;
    }
    if (existing?.revoked_at) {
      await cryptoManager.clearIdentity(userId);
      return this.ensureDeviceRegistered(userId);
    }

    const { data, error } = await supabase
      .from('devices')
      .insert({ identity_public_key: publicKey, device_label: deviceLabel() })
      .select('id')
      .single();
    if (error) throw error;
    await cryptoManager.setDeviceId(userId, data.id);
    return data.id;
  }

  async logout(userId: string | null, deviceId: string | null): Promise<void> {
    try {
      if (deviceId) await supabase.from('push_tokens').delete().eq('device_id', deviceId);
    } catch {
      // best effort
    }
    // Keys stay on the device so the same account can sign back in and keep its history.
    // "Unlink this device" (revokeDevice) is the destructive option.
    await supabase.auth.signOut().catch(() => undefined);
    void userId;
  }

  async listDevices(): Promise<
    { id: string; deviceLabel: string; createdAt: string; lastSeenAt: string; revokedAt: string | null }[]
  > {
    const { data, error } = await supabase
      .from('devices')
      .select('id, device_label, created_at, last_seen_at, revoked_at')
      .order('last_seen_at', { ascending: false });
    if (error) throw error;
    return (data || []).map((d: any) => ({
      id: d.id,
      deviceLabel: d.device_label,
      createdAt: d.created_at,
      lastSeenAt: d.last_seen_at,
      revokedAt: d.revoked_at,
    }));
  }

  /** Revokes a device. New messages will no longer be encrypted for it. */
  async revokeDevice(deviceId: string): Promise<void> {
    const { error } = await supabase
      .from('devices')
      .update({ revoked_at: new Date().toISOString() })
      .eq('id', deviceId);
    if (error) throw error;
  }

  private async getProfile(userId: string) {
    const { data } = await supabase
      .from('profiles')
      .select('username, display_name, avatar_reference, about')
      .eq('id', userId)
      .maybeSingle();
    return data;
  }

  async updateProfile(
    userId: string,
    updates: { displayName?: string; about?: string }
  ): Promise<{ success: boolean; error?: string }> {
    const patch: Record<string, string> = {};
    if (updates.displayName !== undefined) patch.display_name = updates.displayName.trim();
    if (updates.about !== undefined) patch.about = updates.about.trim();
    const { error } = await supabase.from('profiles').update(patch).eq('id', userId);
    return error ? { success: false, error: error.message } : { success: true };
  }
}

export const authRepository = new AuthRepository();
