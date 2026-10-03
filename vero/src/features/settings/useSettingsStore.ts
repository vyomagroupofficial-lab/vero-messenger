/**
 * Device-local privacy preferences (persisted with AsyncStorage).
 */

import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';

interface SettingsState {
  readReceipts: boolean;
  typingIndicators: boolean;
  notifications: boolean;
  defaultTimerSeconds: number;
  set: (patch: Partial<Omit<SettingsState, 'set'>>) => void;
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      readReceipts: true,
      typingIndicators: true,
      notifications: true,
      defaultTimerSeconds: 0,
      set: (patch) => set(patch),
    }),
    {
      name: 'vero-settings',
      storage: createJSONStorage(() => AsyncStorage),
      partialize: ({ set: _set, ...rest }) => rest,
    }
  )
);
