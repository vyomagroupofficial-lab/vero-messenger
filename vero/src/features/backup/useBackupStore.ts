/**
 * Backup status on this device, per account (persisted). The backup key and
 * key slots live in the secure keystore (BackupService), not here.
 */

import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { SlotType } from './backupCrypto';

export interface BackupStatus {
  /** Which secrets unlock this account's backup (empty = backup off on this device). */
  methods: SlotType[];
  lastBackupAt: string | null;
  lastBackupBytes: number | null;
  autoDaily: boolean;
  /** The "restore from backup?" offer was answered (restored or skipped). */
  restoreOfferHandled: boolean;
}

export const EMPTY_BACKUP_STATUS: BackupStatus = {
  methods: [],
  lastBackupAt: null,
  lastBackupBytes: null,
  autoDaily: true,
  restoreOfferHandled: false,
};

interface BackupStoreState {
  byUser: Record<string, BackupStatus>;
  update: (userId: string, patch: Partial<BackupStatus>) => void;
  clear: (userId: string) => void;
}

export const useBackupStore = create<BackupStoreState>()(
  persist(
    (set) => ({
      byUser: {},
      update: (userId, patch) =>
        set((s) => ({ byUser: { ...s.byUser, [userId]: { ...(s.byUser[userId] ?? EMPTY_BACKUP_STATUS), ...patch } } })),
      clear: (userId) =>
        set((s) => {
          const byUser = { ...s.byUser };
          delete byUser[userId];
          return { byUser };
        }),
    }),
    {
      name: 'vero-backup',
      storage: createJSONStorage(() => AsyncStorage),
      partialize: ({ byUser }) => ({ byUser }),
    }
  )
);

export function backupStatus(userId: string | null | undefined): BackupStatus {
  return (userId && useBackupStore.getState().byUser[userId]) || EMPTY_BACKUP_STATUS;
}

export function useBackupStatus(userId: string | null | undefined): BackupStatus {
  return useBackupStore((s) => (userId && s.byUser[userId]) || EMPTY_BACKUP_STATUS);
}

/** Resolves once the persisted status has been read from storage. */
export function backupStoreReady(): Promise<void> {
  if (useBackupStore.persist.hasHydrated()) return Promise.resolve();
  return new Promise((resolve) => {
    const unsub = useBackupStore.persist.onFinishHydration(() => {
      unsub();
      resolve();
    });
  });
}
