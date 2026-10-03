/**
 * Decrypted-media cache on this device.
 *
 *   <cache>/vero-media/<accountId>/<mediaId>.<ext>   decrypted files
 *   <cache>/vero-media/<accountId>/tmp/              ciphertext in transit
 *   <cache>/vero-media/<accountId>/share/            copies named after the real file (for sharing)
 *
 * Per account, so a second account on the same phone never finds the first
 * one's plaintext. Cleared on logout, on "Clear media cache", and swept when
 * the messages that reference a file are deleted or expire.
 *
 * Native only: on web every method is a no-op (MediaRepository keeps blob URLs
 * in memory instead).
 */

import { Platform } from 'react-native';
import { Directory, File, Paths } from 'expo-file-system';
import type { MediaAttachment } from '../../shared/models/Message';

const ROOT = 'vero-media';
const TMP = 'tmp';
const SHARE = 'share';
/** Files younger than this survive a sweep (a send may still be in flight). */
const SWEEP_GRACE_MS = 10 * 60 * 1000;

const isNative = Platform.OS !== 'web';

const EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'image/heif': 'heif',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/webm': 'webm',
  'audio/mp4': 'm4a',
  'audio/m4a': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/aac': 'aac',
  'audio/mpeg': 'mp3',
  'audio/webm': 'webm',
  'audio/ogg': 'ogg',
  'application/pdf': 'pdf',
};

const safeSegment = (s: string) => s.replace(/[^a-zA-Z0-9-]/g, '').slice(0, 64) || 'x';

/** Extension used for the decrypted copy (players pick decoders by extension). */
export function extensionFor(media: Pick<MediaAttachment, 'mimeType' | 'fileName'>): string {
  const known = EXTENSIONS[media.mimeType?.toLowerCase()];
  if (known) return known;
  const fromName = media.fileName?.includes('.') ? media.fileName.split('.').pop() : undefined;
  const clean = fromName?.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8);
  return clean || 'bin';
}

function ensure(dir: Directory): Directory {
  if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
  return dir;
}

function rootDir(): Directory {
  return new Directory(Paths.cache, ROOT);
}

function accountDir(accountId: string): Directory {
  return ensure(new Directory(rootDir(), safeSegment(accountId)));
}

function deleteQuietly(entry: File | Directory): void {
  try {
    if (entry.exists) entry.delete();
  } catch {
    // best effort
  }
}

let tmpCounter = 0;

export const mediaCache = {
  isSupported: isNative,

  /** Where the decrypted copy of `media` lives (may not exist yet). */
  fileFor(accountId: string, media: Pick<MediaAttachment, 'mediaId' | 'mimeType' | 'fileName'>): File {
    return new File(accountDir(accountId), `${safeSegment(media.mediaId)}.${extensionFor(media)}`);
  },

  /** Existing decrypted copy, or null. */
  find(accountId: string, media: Pick<MediaAttachment, 'mediaId' | 'mimeType' | 'fileName'>): File | null {
    if (!isNative) return null;
    try {
      const f = this.fileFor(accountId, media);
      return f.exists && f.size > 0 ? f : null;
    } catch {
      return null;
    }
  },

  /** A fresh scratch file for ciphertext in transit. Caller deletes it. */
  tempFile(accountId: string, suffix = '.bin'): File {
    const dir = ensure(new Directory(accountDir(accountId), TMP));
    tmpCounter = (tmpCounter + 1) % 1_000_000;
    return new File(dir, `${Date.now().toString(36)}-${tmpCounter}-${Math.random().toString(36).slice(2, 8)}${suffix}`);
  },

  /** A copy of `source` named `fileName`, for the share sheet. Previous share copies are removed. */
  shareCopy(accountId: string, source: File, fileName: string): File {
    const dir = new Directory(accountDir(accountId), SHARE);
    deleteQuietly(dir);
    ensure(dir);
    const target = new File(dir, fileName);
    source.copySync(target, { overwrite: true });
    return target;
  },

  /** Moves an already-plaintext file (e.g. our own voice recording) into the cache. */
  adopt(accountId: string, sourceUri: string, media: Pick<MediaAttachment, 'mediaId' | 'mimeType' | 'fileName'>): string | null {
    if (!isNative) return null;
    try {
      const src = new File(sourceUri);
      if (!src.exists) return null;
      const target = this.fileFor(accountId, media);
      src.moveSync(target, { overwrite: true });
      return target.uri;
    } catch {
      return null;
    }
  },

  evict(accountId: string, media: Pick<MediaAttachment, 'mediaId' | 'mimeType' | 'fileName'>): void {
    if (!isNative) return;
    try {
      deleteQuietly(this.fileFor(accountId, media));
    } catch {
      // ignore
    }
  },

  /**
   * Deletes decrypted files whose media id is not in `liveMediaIds` (message
   * deleted, expired or cleared), stale temp files and old share copies.
   */
  sweep(accountId: string, liveMediaIds: ReadonlySet<string>, now = Date.now()): number {
    if (!isNative) return 0;
    let removed = 0;
    try {
      const dir = new Directory(rootDir(), safeSegment(accountId));
      if (!dir.exists) return 0;
      for (const entry of dir.list()) {
        if (entry instanceof Directory) {
          if (entry.name === TMP || entry.name === SHARE) {
            for (const inner of entry.list()) {
              const mtime = inner instanceof File ? inner.modificationTime ?? 0 : 0;
              if (now - mtime > SWEEP_GRACE_MS) {
                deleteQuietly(inner);
                removed++;
              }
            }
          }
          continue;
        }
        const id = entry.name.split('.')[0];
        const young = now - (entry.modificationTime ?? 0) < SWEEP_GRACE_MS;
        if (!liveMediaIds.has(id) && !young) {
          deleteQuietly(entry);
          removed++;
        }
      }
    } catch (e) {
      console.warn('[mediaCache] sweep failed:', (e as Error)?.message);
    }
    return removed;
  },

  /** Removes this account's cache, plus files from the pre-v2 flat layout. */
  clearAccount(accountId: string | null): void {
    if (!isNative) return;
    try {
      const root = rootDir();
      if (!root.exists) return;
      if (accountId) deleteQuietly(new Directory(root, safeSegment(accountId)));
      for (const entry of root.list()) if (entry instanceof File) deleteQuietly(entry);
    } catch (e) {
      console.warn('[mediaCache] clear failed:', (e as Error)?.message);
    }
  },

  /** Removes every account's decrypted media (logout). */
  clearAll(): void {
    if (!isNative) return;
    try {
      deleteQuietly(rootDir());
    } catch (e) {
      console.warn('[mediaCache] clearAll failed:', (e as Error)?.message);
    }
  },
};
