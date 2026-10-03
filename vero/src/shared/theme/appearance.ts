/**
 * Device-local appearance preferences: colour theme and app language.
 * Both default to following the system.
 */

import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';

export type ThemePreference = 'system' | 'light' | 'dark';
export type LanguagePreference = 'system' | 'en' | 'hi' | 'bn' | 'ta' | 'te' | 'mr';

interface AppearanceState {
  theme: ThemePreference;
  language: LanguagePreference;
  hydrated: boolean;
  setTheme: (theme: ThemePreference) => void;
  setLanguage: (language: LanguagePreference) => void;
}

export const useAppearance = create<AppearanceState>()(
  persist(
    (set) => ({
      theme: 'system',
      language: 'system',
      hydrated: false,
      setTheme: (theme) => set({ theme }),
      setLanguage: (language) => set({ language }),
    }),
    {
      name: 'vero-appearance',
      storage: createJSONStorage(() => AsyncStorage),
      partialize: ({ theme, language }) => ({ theme, language }),
      onRehydrateStorage: () => () => useAppearance.setState({ hydrated: true }),
    }
  )
);
