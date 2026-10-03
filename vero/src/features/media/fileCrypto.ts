/**
 * File-to-file attachment encryption on device.
 *
 * Reads and writes in chunks through expo-file-system FileHandles, so only
 * one chunk (64 KiB) of a video is in JS memory at a time. The crypto and the
 * chunk loop are in core/crypto/attachments (pure, unit-tested); this file
 * only adapts FileHandles to its reader/writer interfaces.
 */

import { File, FileMode } from 'expo-file-system';
import {
  ChunkReader,
  ChunkWriter,
  decryptStream,
  DEFAULT_CHUNK_SIZE,
  encryptStream,
  StreamEncryptionResult,
} from '../../core/crypto/attachments';
import { decryptBlob, DecryptionError, type Sodium } from '../../core/crypto/primitives';
import type { MediaAttachment } from '../../shared/models/Message';

export type ProgressFn = (fraction: number) => void;

/** libsodium runs on the JS thread: give the UI a frame between batches of chunks. */
const yieldToUI = () => new Promise<void>((r) => setTimeout(r, 0));

function deleteQuietly(file: File): void {
  try {
    if (file.exists) file.delete();
  } catch {
    // ignore
  }
}

function withHandles<T>(source: File, target: File, fn: (r: ChunkReader, w: ChunkWriter) => Promise<T>): Promise<T> {
  target.create({ overwrite: true, intermediates: true });
  const input = source.open(FileMode.ReadOnly);
  let output;
  try {
    output = target.open(FileMode.WriteOnly);
  } catch (e) {
    input.close();
    throw e;
  }
  const out = output;
  return fn({ read: (n) => input.readBytes(n) }, { write: (b) => out.writeBytes(b) }).finally(() => {
    out.close();
    input.close();
  });
}

export async function encryptFileToFile(
  sodium: Sodium,
  source: File,
  target: File,
  onProgress?: ProgressFn,
  chunkSize = DEFAULT_CHUNK_SIZE
): Promise<StreamEncryptionResult> {
  try {
    return await withHandles(source, target, (r, w) =>
      encryptStream(sodium, r, w, source.size, chunkSize, {
        onChunk: async (f) => {
          onProgress?.(f);
          await yieldToUI();
        },
      })
    );
  } catch (e) {
    deleteQuietly(target);
    throw e;
  }
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
  try {
    if (media.v !== 2) {
      // Format v1: one AEAD over the whole file (old messages, small by construction).
      const plain = decryptBlob(sodium, await source.bytes(), media.key, media.nonce, media.hash);
      target.create({ overwrite: true, intermediates: true });
      target.write(plain);
      onProgress?.(1);
      return;
    }
    if (!media.chunkSize) throw new DecryptionError('Unsupported attachment chunk size');
    await withHandles(source, target, (r, w) =>
      decryptStream(
        sodium,
        r,
        w,
        source.size,
        { key: media.key, header: media.nonce, chunkSize: media.chunkSize!, hash: media.hash },
        {
          onChunk: async (f) => {
            onProgress?.(f);
            await yieldToUI();
          },
        }
      )
    );
  } catch (e) {
    deleteQuietly(target);
    throw e;
  }
}
