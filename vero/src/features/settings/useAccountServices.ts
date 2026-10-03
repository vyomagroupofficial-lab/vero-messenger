/**
 * Per-session services owned by settings/notifications/presence/backup,
 * started from app/_layout.tsx once signed in:
 *   - privacy settings sync, muted chats
 *   - push token registration (if enabled on this device) + notification taps
 *   - online presence / last seen heartbeat
 *   - daily auto-backup when the app comes to the foreground
 *   - "restore from backup?" offer on a device without chats
 */

import { useEffect } from 'react';
import { AppState } from 'react-native';
import { router } from 'expo-router';
import { maybeRunAutoBackup, shouldOfferRestore } from '../backup/BackupService';
import { configureNotifications, registerForPush } from '../notifications/pushRegistration';
import { useMuteStore } from '../notifications/useMuteStore';
import { useNotificationRouting } from '../notifications/useNotificationRouting';
import { presenceService } from '../presence/presenceService';
import { stopAllPresenceWatches } from '../presence/usePresence';
import { loadPrivacySettings } from './settingsSync';
import { useSettingsStore } from './useSettingsStore';

export function useAccountServices(userId: string | null | undefined, deviceId: string | null | undefined, isDemo: boolean): void {
  const signedIn = !!userId && !!deviceId && !isDemo;
  useNotificationRouting(signedIn);

  useEffect(() => {
    if (!userId || !deviceId || isDemo) return;
    let cancelled = false;

    void configureNotifications();
    void loadPrivacySettings().finally(() => {
      if (!cancelled) presenceService.start(userId, deviceId);
    });
    void useMuteStore.getState().load();
    if (useSettingsStore.getState().notifications) void registerForPush(deviceId);

    void shouldOfferRestore(userId).then((offer) => {
      // Let the sign-in navigation settle before offering the restore.
      if (offer && !cancelled) setTimeout(() => !cancelled && router.push('/backup/restore'), 600);
      else if (!cancelled) void maybeRunAutoBackup(userId);
    });

    const sub = AppState.addEventListener('change', (state) => {
      if (state !== 'active') return;
      void useMuteStore.getState().load();
      void loadPrivacySettings();
      void maybeRunAutoBackup(userId);
    });

    return () => {
      cancelled = true;
      sub.remove();
      presenceService.stop();
      stopAllPresenceWatches();
      useMuteStore.getState().reset();
    };
  }, [userId, deviceId, isDemo]);
}
