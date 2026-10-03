/**
 * Recent, favourite and custom stickers (device-local, per account).
 * Custom sticker images live in the app's document directory (native) or as
 * data URIs (web); nothing here is uploaded until a sticker is sent.
 */

import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';

export type StickerItem =
  | { kind: 'bundled'; pack: string; id: string; emoji?: string }
  | { kind: 'custom'; id: string; uri: string; emoji?: string };

export const itemKey = (s: StickerItem) => (s.kind === 'bundled' ? `b:${s.pack}/${s.id}` : `c:${s.id}`);

interface AccountStickers {
  recents: StickerItem[];
  favourites: StickerItem[];
  custom: Extract<StickerItem, { kind: 'custom' }>[];
}

const EMPTY: AccountStickers = { recents: [], favourites: [], custom: [] };
export const MAX_RECENTS = 24;
export const MAX_CUSTOM = 120;

interface StickerState {
  accounts: Record<string, AccountStickers>;
  forUser: (userId: string) => AccountStickers;
  addRecent: (userId: string, item: StickerItem) => void;
  toggleFavourite: (userId: string, item: StickerItem) => void;
  addCustom: (userId: string, item: Extract<StickerItem, { kind: 'custom' }>) => void;
  removeCustom: (userId: string, id: string) => void;
}

export const useStickerStore = create<StickerState>()(
  persist(
    (set, get) => {
      const update = (userId: string, fn: (a: AccountStickers) => AccountStickers) =>
        set((s) => ({ accounts: { ...s.accounts, [userId]: fn(s.accounts[userId] ?? EMPTY) } }));
      return {
        accounts: {},
        forUser: (userId) => get().accounts[userId] ?? EMPTY,
        addRecent: (userId, item) =>
          update(userId, (a) => ({
            ...a,
            recents: [item, ...a.recents.filter((r) => itemKey(r) !== itemKey(item))].slice(0, MAX_RECENTS),
          })),
        toggleFavourite: (userId, item) =>
          update(userId, (a) => ({
            ...a,
            favourites: a.favourites.some((f) => itemKey(f) === itemKey(item))
              ? a.favourites.filter((f) => itemKey(f) !== itemKey(item))
              : [item, ...a.favourites],
          })),
        addCustom: (userId, item) =>
          update(userId, (a) => ({ ...a, custom: [item, ...a.custom].slice(0, MAX_CUSTOM) })),
        removeCustom: (userId, id) =>
          update(userId, (a) => {
            const gone = (s: StickerItem) => s.kind === 'custom' && s.id === id;
            return {
              recents: a.recents.filter((s) => !gone(s)),
              favourites: a.favourites.filter((s) => !gone(s)),
              custom: a.custom.filter((s) => s.id !== id),
            };
          }),
      };
    },
    {
      name: 'vero-stickers',
      storage: createJSONStorage(() => AsyncStorage),
      partialize: (s) => ({ accounts: s.accounts }) as any,
    }
  )
);
