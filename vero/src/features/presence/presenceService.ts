/**
 * Online status and last seen for the signed-in user.
 *
 * While the app is in the foreground:
 *   - touch_last_seen() every minute (the server throttles and stores nothing
 *     when last seen is set to "Nobody"), and once more when the app leaves
 *     the foreground, so "last seen" is when the user left;
 *   - if "Show when I'm online" is on, Realtime Presence is tracked on the
 *     private topic presence:<my user id>. Only people who share a chat with
 *     the user (and share their own online status) may watch it - enforced
 *     by realtime.messages policies in 005_settings_push_backup.sql.
 */

import { AppState, AppStateStatus } from 'react-native';
import type { RealtimeChannel } from '@supabase/supabase-js';
import { supabase } from '../../core/network/supabase';
import { onPrivacyChange } from '../settings/settingsSync';
import { mayShareOnline } from '../settings/privacy';
import { useSettingsStore } from '../settings/useSettingsStore';

const HEARTBEAT_MS = 60_000;

export const presenceTopic = (userId: string) => `presence:${userId}`;

class PresenceService {
  private userId: string | null = null;
  private deviceId: string | null = null;
  private channel: RealtimeChannel | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private appStateSub: { remove: () => void } | null = null;
  private privacyUnsub: (() => void) | null = null;
  private active = false;

  start(userId: string, deviceId: string): void {
    if (this.userId === userId && this.deviceId === deviceId) return;
    this.stop();
    this.userId = userId;
    this.deviceId = deviceId;
    this.appStateSub = AppState.addEventListener('change', this.onAppState);
    this.privacyUnsub = onPrivacyChange((next, prev) => {
      if (next.showOnline !== prev.showOnline) void this.syncTracking();
      if (next.lastSeen !== prev.lastSeen) this.touch();
    });
    if (AppState.currentState === 'active' || AppState.currentState == null) this.goActive();
  }

  stop(): void {
    if (this.active) this.touch();
    this.appStateSub?.remove();
    this.appStateSub = null;
    this.privacyUnsub?.();
    this.privacyUnsub = null;
    this.goInactive(false);
    this.userId = null;
    this.deviceId = null;
  }

  private onAppState = (state: AppStateStatus) => {
    if (state === 'active') this.goActive();
    else if (this.active) this.goInactive(true);
  };

  private goActive(): void {
    if (!this.userId) return;
    this.active = true;
    this.touch();
    if (!this.heartbeat) this.heartbeat = setInterval(() => this.touch(), HEARTBEAT_MS);
    void this.syncTracking();
  }

  private goInactive(recordLastSeen: boolean): void {
    this.active = false;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    if (recordLastSeen) this.touch();
    this.leaveChannel();
  }

  private touch(): void {
    if (!this.userId) return;
    void supabase.rpc('touch_last_seen').then(({ error }) => {
      if (error) console.warn('[Presence] last seen update failed:', error.message);
    });
  }

  private leaveChannel(): void {
    const channel = this.channel;
    this.channel = null;
    if (!channel) return;
    void channel.untrack().catch(() => undefined).finally(() => void supabase.removeChannel(channel));
  }

  /** Track presence only while active AND sharing online status. */
  private async syncTracking(): Promise<void> {
    const share = mayShareOnline(useSettingsStore.getState());
    if (!this.active || !share || !this.userId || !this.deviceId) {
      this.leaveChannel();
      return;
    }
    if (this.channel) return;
    await supabase.realtime.setAuth();
    const channel = supabase.channel(presenceTopic(this.userId), {
      config: { private: true, presence: { key: this.deviceId, enabled: true } },
    });
    this.channel = channel;
    channel.subscribe((status, err) => {
      if (status === 'SUBSCRIBED' && this.channel === channel) {
        void channel.track({ online_at: new Date().toISOString() });
      } else if (status === 'CHANNEL_ERROR') {
        console.warn('[Presence] could not join own presence topic', err?.message);
      }
    });
  }
}

export const presenceService = new PresenceService();
