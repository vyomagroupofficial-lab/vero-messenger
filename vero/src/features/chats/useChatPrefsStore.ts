/**
 * Device-local chat list preferences.
 */

import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';

interface ChatPrefsState {
  /** Archived chats stay archived when new messages arrive. */
  keepArchived: boolean;
  setKeepArchived: (value: boolean) => void;
}

export const useChatPrefsStore = create<ChatPrefsState>()(
  persist(
    (set) => ({
      keepArchived: false,
      setKeepArchived: (keepArchived) => set({ keepArchived }),
    }),
    {
      name: 'vero-chat-prefs',
      storage: createJSONStorage(() => AsyncStorage),
      partialize: ({ keepArchived }) => ({ keepArchived }),
    }
  )
);
