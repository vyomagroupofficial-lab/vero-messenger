/**
 * Attachment size limits (pure, shared by UI and upload code).
 *
 * Supabase's free plan caps a single Storage object at 50 MB, and the
 * `vero-media` bucket is configured with the same limit (migration 004). The
 * limit applies to the CIPHERTEXT, which is slightly larger than the file.
 */

import { DEFAULT_CHUNK_SIZE, encryptedSizeFor } from '../../core/crypto/attachments';

/**
 * Max encrypted object size in bytes. Must match MAX_BYTES in the media-upload
 * function and the bucket's file_size_limit (004_media.sql).
 */
export const MAX_ENCRYPTED_BYTES = 50 * 1024 * 1024;

/** Images up to this size download automatically; bigger media waits for a tap. */
export const AUTO_DOWNLOAD_MAX_BYTES = 8 * 1024 * 1024;

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function exceedsUploadLimit(plainSize: number, chunkSize = DEFAULT_CHUNK_SIZE): boolean {
  return encryptedSizeFor(plainSize, chunkSize) > MAX_ENCRYPTED_BYTES;
}

export class MediaTooLargeError extends Error {
  constructor(size?: number) {
    const limit = `${Math.floor(MAX_ENCRYPTED_BYTES / 1024 / 1024)} MB`;
    super(
      size && size > 0
        ? `This file is ${formatBytes(size)}. Vero can send files up to ${limit}.`
        : `Vero can send files up to ${limit}.`
    );
    this.name = 'MediaTooLargeError';
  }
}
