/**
 * "Add me" QR codes and QR-based safety-number verification.
 *
 * My QR encodes vero://u/<username>?fp=<my 30-digit fingerprint>, where the
 * fingerprint covers all of my active device keys (same function as safety
 * numbers). Whoever scans it compares that against the keys the SERVER hands
 * them for me: if they match, the server isn't substituting keys, and the
 * scanner's safety number with me is marked verified.
 */

import { supabase } from '../../core/network/supabase';
import { getSodium } from '../../core/crypto/sodium';
import { partyFingerprint } from '../../core/crypto/primitives';
import { cryptoManager } from '../../core/crypto/CryptoManager';
import { databaseService } from '../../core/storage/DatabaseService';
import { keyDirectory } from '../keys/KeyDirectory';
import type { User } from '../../shared/models/Message';

/** Fingerprint of a user's active device keys as the server reports them, or null if none. */
export async function fingerprintForUser(userId: string): Promise<string | null> {
  const keys = await keyDirectory.getUserKeys(userId);
  if (!keys.length) return null;
  return partyFingerprint(await getSodium(), userId, keys);
}

export async function resolveUsername(username: string): Promise<User | null> {
  const { data, error } = await supabase.rpc('resolve_username', { p_username: username });
  if (error) throw error;
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    avatarReference: row.avatar_reference,
    about: row.about,
  };
}

export type QrVerificationResult = 'verified' | 'mismatch' | 'unavailable';

/**
 * Verifies a contact from the fingerprint in their QR code and, on success,
 * stores the current safety number as verified (the same record the
 * "Verify safety number" screen uses). Call it after a direct chat exists:
 * device keys are only served to people who share a conversation.
 *
 * On a mismatch any previous verification is cleared, because the keys the
 * server gives us no longer match what the contact's own device shows.
 */
export async function verifyContactFromQr(
  myUserId: string,
  theirUserId: string,
  scannedFingerprint: string
): Promise<QrVerificationResult> {
  const theirKeys = await keyDirectory.getUserKeys(theirUserId);
  if (!theirKeys.length) return 'unavailable';
  const sodium = await getSodium();
  if (partyFingerprint(sodium, theirUserId, theirKeys) !== scannedFingerprint) {
    await databaseService.setVerifiedSafetyNumber(theirUserId, null);
    return 'mismatch';
  }
  const myKeys = await keyDirectory.getUserKeys(myUserId);
  if (!myKeys.length) return 'unavailable';
  const number = await cryptoManager.computeSafetyNumber(
    { userId: myUserId, keys: myKeys },
    { userId: theirUserId, keys: theirKeys }
  );
  await databaseService.setVerifiedSafetyNumber(theirUserId, number);
  return 'verified';
}
