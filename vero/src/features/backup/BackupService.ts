/**
 * Encrypted cloud backup of the local message database and preferences.
 *
 *   setup   : random backup key -> key slots for the passphrase and/or the
 *             recovery key (backupCrypto.ts) -> key + slots in the secure
 *             keystore -> first backup
 *   backup  : buildSnapshot('full') (the same allow-listed tables as "move
 *             chats to a new phone": messages, chat cache, timers, call log,
 *             pinned contact keys, preferences - NEVER private keys) ->
 *             secretstream -> Storage `vero-backups/<user id>/backup.bin`
 *             (storage policies: own folder only)
 *   restore : download -> passphrase or recovery key -> verify + decrypt ->
 *             import; the backup key is kept so later backups keep working
 *
 * Daily auto-backup runs when the app comes to the foreground and the last
 * backup is older than 24 hours.
 */

import { supabase } from '../../core/network/supabase';
import type { Sodium } from '../../core/crypto/primitives';
import { secureStorage } from '../../core/storage/secureStorage';
import { databaseService } from '../../core/storage/DatabaseService';
import { buildSnapshot, importSnapshot } from '../transfer/TransferService';
import { decodeSnapshot, encodeSnapshot } from '../transfer/snapshot';
import {
  BackupError,
  KeySlot,
  SlotType,
  createPassphraseSlot,
  createRecoverySlot,
  decryptBackup,
  encryptBackup,
  generateBackupKey,
  parseBackup,
} from './backupCrypto';
import { parseRecoveryKey } from './recoveryKey';
import { getSumoSodium } from './sodiumSumo';
import { isAutoBackupDue } from './schedule';
import { backupStatus, backupStoreReady, useBackupStore } from './useBackupStore';

export const BACKUP_BUCKET = 'vero-backups';
export const MAX_BACKUP_BYTES = 50 * 1024 * 1024; // bucket file_size_limit (005)
const backupPath = (userId: string) => `${userId}/backup.bin`;
const secretKey = (userId: string) => `vero.backup.v1.${userId}`;

interface StoredConfig {
  key: string; // base64url backup key
  slots: KeySlot[];
}

export interface RemoteBackupInfo {
  updatedAt: string | null;
  size: number | null;
}

export type RestoreSecret = { passphrase: string } | { recoveryKey: string };

/** Lets the UI render a spinner before a long synchronous step (Argon2id, encryption). */
const yieldToUi = () => new Promise((r) => setTimeout(r, 60));

async function loadConfig(userId: string): Promise<StoredConfig | null> {
  const raw = await secureStorage.get(secretKey(userId));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as StoredConfig;
    return typeof parsed.key === 'string' && Array.isArray(parsed.slots) && parsed.slots.length ? parsed : null;
  } catch {
    return null;
  }
}

async function saveConfig(userId: string, config: StoredConfig): Promise<void> {
  await secureStorage.set(secretKey(userId), JSON.stringify(config));
}

export async function isBackupConfigured(userId: string): Promise<boolean> {
  return (await loadConfig(userId)) !== null;
}

/**
 * Turns backup on (or replaces its secrets): a NEW backup key, wrapped for the
 * chosen secrets, then an immediate backup that overwrites the old one.
 * `recoveryKey` is the key shown to the user (formatted).
 */
export async function setupBackup(
  userId: string,
  secrets: { passphrase?: string; recoveryKey?: string },
  onPhase?: (phase: 'deriving' | 'encrypting' | 'uploading') => void
): Promise<void> {
  if (!secrets.passphrase && !secrets.recoveryKey) throw new BackupError('Choose a passphrase or a recovery key.', 'input');
  const sodium = await getSumoSodium();
  onPhase?.('deriving');
  await yieldToUi();
  const key = generateBackupKey(sodium);
  try {
    const slots: KeySlot[] = [];
    if (secrets.passphrase) slots.push(createPassphraseSlot(sodium, key, userId, secrets.passphrase));
    if (secrets.recoveryKey) slots.push(createRecoverySlot(sodium, key, userId, parseRecoveryKey(sodium, secrets.recoveryKey)));
    await saveConfig(userId, { key: sodium.to_base64(key), slots });
    useBackupStore.getState().update(userId, { methods: slots.map((s) => s.type), restoreOfferHandled: true });
  } finally {
    sodium.memzero(key);
  }
  await runBackup(userId, onPhase);
}

/** Encrypts the local database and uploads it. */
export async function runBackup(
  userId: string,
  onPhase?: (phase: 'deriving' | 'encrypting' | 'uploading') => void
): Promise<{ bytes: number; at: string }> {
  const config = await loadConfig(userId);
  if (!config) throw new BackupError('Backup is not set up on this device.', 'input');
  const sodium = await getSumoSodium();
  onPhase?.('encrypting');
  await yieldToUi();

  const snapshot = await buildSnapshot(userId, 'full');
  const plaintext = encodeSnapshot(sodium as unknown as Sodium, snapshot);
  const key = sodium.from_base64(config.key);
  let file: Uint8Array;
  try {
    file = encryptBackup(sodium, { backupKey: key, userId, slots: config.slots, plaintext, createdAt: snapshot.createdAt });
  } finally {
    sodium.memzero(key);
    sodium.memzero(plaintext);
  }
  if (file.byteLength > MAX_BACKUP_BYTES) {
    throw new BackupError(
      `Your chats are too large to back up (${Math.round(file.byteLength / 1048576)} MB; the limit is 50 MB). Clear old chats and try again.`,
      'input'
    );
  }

  onPhase?.('uploading');
  const { error } = await supabase.storage.from(BACKUP_BUCKET).upload(backupPath(userId), file, {
    contentType: 'application/octet-stream',
    upsert: true,
    cacheControl: 'no-store',
  });
  if (error) throw new Error(`Upload failed: ${error.message}`);
  const at = new Date().toISOString();
  useBackupStore.getState().update(userId, { lastBackupAt: at, lastBackupBytes: file.byteLength });
  return { bytes: file.byteLength, at };
}

/** The backup on the server, if any. */
export async function getRemoteBackupInfo(userId: string): Promise<RemoteBackupInfo | null> {
  const { data, error } = await supabase.storage.from(BACKUP_BUCKET).list(userId, { limit: 10, search: 'backup.bin' });
  if (error) throw error;
  const file = (data ?? []).find((f) => f.name === 'backup.bin');
  if (!file) return null;
  const size = (file.metadata as { size?: number } | null)?.size;
  return { updatedAt: file.updated_at ?? file.created_at ?? null, size: typeof size === 'number' ? size : null };
}

export async function downloadBackup(userId: string): Promise<Uint8Array> {
  const { data, error } = await supabase.storage.from(BACKUP_BUCKET).createSignedUrl(backupPath(userId), 120);
  if (error || !data?.signedUrl) throw new Error('No backup found for this account.');
  const res = await fetch(data.signedUrl, { cache: 'no-store' } as RequestInit);
  if (!res.ok) throw new Error(`Download failed (${res.status})`);
  return new Uint8Array(await res.arrayBuffer());
}

/** Which secrets can unlock a downloaded backup (read from its plaintext header). */
export async function backupMethods(bytes: Uint8Array): Promise<{ methods: SlotType[]; createdAt: string }> {
  const sodium = await getSumoSodium();
  const { header } = parseBackup(sodium, bytes);
  return { methods: header.slots.map((s) => s.type), createdAt: header.createdAt };
}

/** Verifies, decrypts and imports a backup into this device's database. */
export async function restoreBackup(userId: string, bytes: Uint8Array, secret: RestoreSecret): Promise<{ rows: number }> {
  const sodium = await getSumoSodium();
  await yieldToUi();
  const unlock =
    'passphrase' in secret
      ? { passphrase: secret.passphrase }
      : { recoverySecret: parseRecoveryKey(sodium, secret.recoveryKey) };
  const { header, plaintext, backupKey } = decryptBackup(sodium, bytes, unlock, userId);
  let rows: number;
  try {
    const snapshot = decodeSnapshot(sodium as unknown as Sodium, plaintext, userId);
    if (snapshot.kind !== 'full') throw new BackupError('The backup file is damaged.', 'corrupt');
    rows = await importSnapshot(snapshot);
    // Keep the key so this device continues the same backup.
    await saveConfig(userId, { key: sodium.to_base64(backupKey), slots: header.slots });
  } finally {
    sodium.memzero(backupKey);
    sodium.memzero(plaintext);
  }
  useBackupStore.getState().update(userId, {
    methods: header.slots.map((s) => s.type),
    lastBackupAt: header.createdAt,
    lastBackupBytes: bytes.byteLength,
    restoreOfferHandled: true,
  });
  return { rows };
}

/** Turns backup off on this device; optionally deletes the backup from the server. */
export async function turnOffBackup(userId: string, deleteRemote: boolean): Promise<void> {
  if (deleteRemote) {
    const { error } = await supabase.storage.from(BACKUP_BUCKET).remove([backupPath(userId)]);
    if (error) throw error;
  }
  await secureStorage.remove(secretKey(userId));
  useBackupStore.getState().update(userId, { methods: [], lastBackupAt: null, lastBackupBytes: null });
}

let autoRunning = false;

/** Runs the daily backup if one is due. Never throws. */
export async function maybeRunAutoBackup(userId: string): Promise<void> {
  await backupStoreReady();
  if (autoRunning || !isAutoBackupDue(backupStatus(userId))) return;
  autoRunning = true;
  try {
    if (await isBackupConfigured(userId)) await runBackup(userId);
  } catch (e) {
    console.warn('[Backup] daily backup failed:', (e as Error)?.message);
  } finally {
    autoRunning = false;
  }
}

/**
 * After sign-in on a device without chats: is there a backup to offer?
 * Asked once per account and device.
 */
export async function shouldOfferRestore(userId: string): Promise<boolean> {
  await backupStoreReady();
  const status = backupStatus(userId);
  if (status.restoreOfferHandled || status.methods.length > 0) return false;
  if (await isBackupConfigured(userId)) return false;
  const local = await databaseService.getLastMessages();
  if (Object.keys(local).length > 0) {
    useBackupStore.getState().update(userId, { restoreOfferHandled: true });
    return false;
  }
  try {
    return (await getRemoteBackupInfo(userId)) !== null;
  } catch {
    return false;
  }
}

export function dismissRestoreOffer(userId: string): void {
  useBackupStore.getState().update(userId, { restoreOfferHandled: true });
}
