/**
 * File-to-file attachment encryption on device.
 *
 * Reads and writes in chunks through expo-file-system FileHandles, so only
 * one chunk (64 KiB) of a video is in JS memory at a time. The crypto itself
 * is in core/crypto/attachments (pure, unit-tested).
 */

import { File, FileMode } from 'expo-file-system';
import {
  AttachmentDecryptor,
  AttachmentEncryptor,
  DEFAULT_CHUNK_SIZE,
  StreamEncryptionResult,
} from '../../core/crypto/attachments';
import { decryptBlob, DecryptionError, type Sodium } from '../../core/crypto/primitives';
import type { MediaAttachment } from '../../shared/models/Message';

/** Let the UI breathe every N chunks (libsodium runs on the JS thread). */
const YIELD_EVERY = 8;
const yieldToUI = () => new Promise<void>((r) => setTimeout(r, 0));

export type ProgressFn = (fraction: number) => void;

export async function encryptFileToFile(
  sodium: Sodium,
  source: File,
  target: File,
  onProgress?: ProgressFn,
  chunkSize = DEFAULT_CHUNK_SIZE
): Promise<StreamEncryptionResult> {
  const size = source.size;
  const enc = new AttachmentEncryptor(sodium, chunkSize);
  target.create({ overwrite: true, intermediates: true });
  const input = source.open(FileMode.ReadOnly);
  const output = target.open(FileMode.WriteOnly);
  try {
    let offset = 0;
    let n = 0;
    do {
      const want = Math.min(chunkSize, size - offset);
      const chunk = want > 0 ? input.readBytes(want) : new Uint8Array(0);
      if (chunk.length !== want) throw new Error('The file changed while it was being encrypted.');
      offset += chunk.length;
      output.writeBytes(enc.push(chunk, offset >= size));
      if (++n % YIELD_EVERY === 0) {
        onProgress?.(size > 0 ? offset / size : 1);
        await yieldToUI();
      }
    } while (!enc.isFinished);
  } catch (e) {
    output.close();
    input.close();
    try {
      target.delete();
    } catch {
      // ignore
    }
    throw e;
  }
  output.close();
  input.close();
  onProgress?.(1);
  return enc.finish();
}

/**
 * Decrypts `source` (ciphertext) into `target`. On any failure the partial
 * target is deleted, so a truncated or tampered file never looks valid.
 */
export async function decryptFileToFile(
  sodium: Sodium,
  source: File,
  target: File,
  media: Pick<MediaAttachment, 'v' | 'chunkSize' | 'key' | 'nonce' | 'hash'>,
  onProgress?: ProgressFn
): Promise<void> {
  target.create({ overwrite: true, intermediates: true });
  try {
    if (media.v !== 2) {
      // Format v1: one AEAD over the whole file (old messages, small by construction).
      const plain = decryptBlob(sodium, await source.bytes(), media.key, media.nonce, media.hash);
      target.write(plain);
      onProgress?.(1);
      return;
    }

    const dec = new AttachmentDecryptor(sodium, media.key, media.nonce, media.chunkSize!, media.hash);
    const size = source.size;
    const input = source.open(FileMode.ReadOnly);
    const output = target.open(FileMode.WriteOnly);
    try {
      let offset = 0;
      let n = 0;
      while (offset < size) {
        const want = Math.min(dec.cipherChunkSize, size - offset);
        const chunk = input.readBytes(want);
        if (chunk.length !== want) throw new DecryptionError('Attachment was truncated');
        offset += want;
        output.writeBytes(dec.pull(chunk));
        if (++n % YIELD_EVERY === 0) {
          onProgress?.(offset / size);
          await yieldToUI();
        }
      }
      dec.finish();
    } finally {
      output.close();
      input.close();
    }
    onProgress?.(1);
  } catch (e) {
    try {
      target.delete();
    } catch {
      // ignore
    }
    throw e;
  }
}
