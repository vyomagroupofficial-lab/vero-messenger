/**
 * User preferences.
 *
 * Privacy settings (read receipts, typing, last seen, online, default timer,
 * notification previews) are the account's `user_settings` row, cached here
 * so they apply offline and at start-up; settingsSync.ts loads and saves
 * them. `notifications` is per device (push on/off for this installation).
 */

import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { DEFAULT_PRIVACY, PrivacySettings } from './privacy';

export interface SettingsState extends PrivacySettings {
  /** Push notifications on this device. */
  notifications: boolean;
  set: (patch: Partial<Omit<SettingsState, 'set'>>) => void;
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      ...DEFAULT_PRIVACY,
      notifications: true,
      set: (patch) => set(patch),
    }),
    {
      name: 'vero-settings',
      version: 2,
      storage: createJSONStorage(() => AsyncStorage),
      partialize: ({ set: _set, ...rest }) => rest,
      migrate: (persisted: any) => {
        const { defaultTimerSeconds: _old, ...rest } = persisted ?? {};
        return { ...DEFAULT_PRIVACY, notifications: true, ...rest };
      },
    }
  )
);

export function privacySnapshot(): PrivacySettings {
  const s = useSettingsStore.getState();
  return {
    readReceipts: s.readReceipts,
    typingIndicators: s.typingIndicators,
    lastSeen: s.lastSeen,
    showOnline: s.showOnline,
    defaultDisappearingSeconds: s.defaultDisappearingSeconds,
    notificationPreviews: s.notificationPreviews,
  };
}
