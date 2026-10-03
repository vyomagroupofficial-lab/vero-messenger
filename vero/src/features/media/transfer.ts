/**
 * Moving encrypted attachments between this device and object storage.
 *
 * Shared by chat attachments (MediaRepository) and stories (storyMedia):
 *
 *   encryptForUpload()   plaintext file/bytes -> chunked ciphertext (format v2)
 *   putCiphertext()      PUT the ciphertext to a signed upload URL
 *   fetchCiphertext()    GET a signed download URL into a temp file / memory
 *   decryptToLocal()     ciphertext -> decrypted file in the media cache (or a
 *                        blob: URL on web), verifying hash and integrity
 *
 * Native: files are processed chunk by chunk through expo-file-system
 * FileHandles, uploads/downloads are native transfers straight from/to disk,
 * so a 50 MB video never sits in JS memory. Web: everything is in memory
 * (browsers have no file system we could stream to).
 */

import { Platform } from 'react-native';
import { File, UploadType } from 'expo-file-system';
import {
  DEFAULT_CHUNK_SIZE,
  decryptAttachment,
  encryptAttachment,
  StreamEncryptionResult,
} from '../../core/crypto/attachments';
import { decryptBlob } from '../../core/crypto/primitives';
import { getSodium } from '../../core/crypto/sodium';
import type { MediaAttachment } from '../../shared/models/Message';
import { decryptFileToFile, encryptFileToFile } from './fileCrypto';
import { exceedsUploadLimit, MediaTooLargeError } from './limits';
import { mediaCache } from './mediaCache';

export const isWeb = Platform.OS === 'web';

export type TransferPhase = 'preparing' | 'encrypting' | 'uploading' | 'verifying' | 'downloading' | 'decrypting';
export type TransferProgress = (phase: TransferPhase, fraction: number) => void;

/** Plaintext input: a local file URI (native file:// or web blob:/data:) or raw bytes. */
export interface PlainSource {
  uri?: string;
  bytes?: Uint8Array;
}

/** The encrypted attachment, ready to upload. Call dispose() when done. */
export interface EncryptedUpload extends StreamEncryptionResult {
  v: 2;
  chunkSize: number;
  /** Native: temp file with the ciphertext. */
  file?: File;
  /** Web (or bytes input): the ciphertext in memory. */
  bytes?: Uint8Array;
  dispose(): void;
}

export class MediaUnavailableError extends Error {
  constructor(message = 'This file is no longer available.') {
    super(message);
    this.name = 'MediaUnavailableError';
  }
}

async function readAllBytes(src: PlainSource): Promise<Uint8Array> {
  if (src.bytes) return src.bytes;
  if (!src.uri) throw new Error('Nothing to send');
  if (isWeb || /^(blob:|data:|https?:)/.test(src.uri)) {
    const res = await fetch(src.uri);
    if (!res.ok) throw new Error('Could not read the file');
    return new Uint8Array(await res.arrayBuffer());
  }
  return new File(src.uri).bytes();
}

/** Plaintext size without reading the file (0 if unknown). */
export function plainSizeOf(src: PlainSource): number {
  if (src.bytes) return src.bytes.byteLength;
  if (!src.uri || isWeb || !/^file:/.test(src.uri)) return 0;
  try {
    const f = new File(src.uri);
    return f.exists ? f.size : 0;
  } catch {
    return 0;
  }
}

/**
 * Encrypts with a fresh key (crypto_secretstream, 64 KiB chunks). Enforces the
 * upload limit BEFORE doing any work, with a friendly error.
 */
export async function encryptForUpload(
  src: PlainSource,
  accountId: string,
  onProgress?: TransferProgress
): Promise<EncryptedUpload> {
  const chunkSize = DEFAULT_CHUNK_SIZE;
  const knownSize = plainSizeOf(src);
  if (knownSize && exceedsUploadLimit(knownSize, chunkSize)) throw new MediaTooLargeError(knownSize);
  const sodium = await getSodium();

  if (!isWeb && !src.bytes && src.uri && /^file:/.test(src.uri)) {
    const source = new File(src.uri);
    if (!source.exists) throw new Error('The file is no longer on this device.');
    const target = mediaCache.tempFile(accountId, '.enc');
    const result = await encryptFileToFile(sodium, source, target, (f) => onProgress?.('encrypting', f), chunkSize);
    if (exceedsUploadLimit(result.plainSize, chunkSize)) {
      target.delete();
      throw new MediaTooLargeError(result.plainSize);
    }
    return {
      ...result,
      v: 2,
      chunkSize,
      file: target,
      dispose: () => {
        try {
          if (target.exists) target.delete();
        } catch {
          // ignore
        }
      },
    };
  }

  const plain = await readAllBytes(src);
  if (exceedsUploadLimit(plain.byteLength, chunkSize)) throw new MediaTooLargeError(plain.byteLength);
  onProgress?.('encrypting', 0);
  const { ciphertext, ...result } = encryptAttachment(sodium, plain, chunkSize);
  onProgress?.('encrypting', 1);
  return { ...result, v: 2, chunkSize, bytes: ciphertext, dispose: () => undefined };
}

/** PUTs the ciphertext to a signed upload URL. Throws on any non-2xx answer. */
export async function putCiphertext(
  upload: EncryptedUpload,
  url: string,
  headers: Record<string, string>,
  onProgress?: TransferProgress
): Promise<void> {
  onProgress?.('uploading', 0);
  let status: number;
  let body = '';
  if (upload.file) {
    const res = await upload.file.upload(url, {
      httpMethod: 'PUT',
      uploadType: UploadType.BINARY_CONTENT,
      mimeType: 'application/octet-stream',
      headers,
      onProgress: (p) => onProgress?.('uploading', p.totalBytes > 0 ? p.bytesSent / p.totalBytes : 0),
    });
    status = res.status;
    body = res.body;
  } else if (upload.bytes) {
    const res = await fetch(url, { method: 'PUT', headers, body: upload.bytes as unknown as BodyInit });
    status = res.status;
    if (!res.ok) body = await res.text().catch(() => '');
  } else {
    throw new Error('Nothing to upload');
  }
  if (status < 200 || status >= 300) {
    if (status === 413) throw new MediaTooLargeError();
    console.warn('[media] upload failed:', status, body.slice(0, 200));
    throw new Error(`Upload failed (${status}). Please try again.`);
  }
  onProgress?.('uploading', 1);
}

/** Ciphertext downloaded to a temp file (native) or into memory (web). */
export interface DownloadedCiphertext {
  file?: File;
  bytes?: Uint8Array;
  dispose(): void;
}

export async function fetchCiphertext(
  url: string,
  accountId: string,
  headers: Record<string, string> = {},
  onProgress?: TransferProgress
): Promise<DownloadedCiphertext> {
  onProgress?.('downloading', 0);
  if (isWeb) {
    const res = await fetch(url, { headers });
    if (res.status === 404 || res.status === 400) throw new MediaUnavailableError();
    if (!res.ok) throw new Error('Download failed. Please try again.');
    const bytes = new Uint8Array(await res.arrayBuffer());
    onProgress?.('downloading', 1);
    return { bytes, dispose: () => undefined };
  }
  const temp = mediaCache.tempFile(accountId, '.enc');
  const dispose = () => {
    try {
      if (temp.exists) temp.delete();
    } catch {
      // ignore
    }
  };
  try {
    const file = await File.downloadFileAsync(url, temp, {
      headers,
      idempotent: true,
      onProgress: (p) => onProgress?.('downloading', p.totalBytes > 0 ? p.bytesWritten / p.totalBytes : 0),
    });
    onProgress?.('downloading', 1);
    return { file, dispose };
  } catch (e) {
    dispose();
    const msg = (e as Error)?.message ?? '';
    if (/\b(400|404)\b/.test(msg)) throw new MediaUnavailableError();
    throw new Error('Download failed. Please try again.');
  }
}

type DecryptParams = Pick<MediaAttachment, 'v' | 'chunkSize' | 'key' | 'nonce' | 'hash' | 'mimeType'>;

/** Decrypts in memory (web, tests, tiny files). Supports formats v1 and v2. */
export async function decryptBytes(ciphertext: Uint8Array, media: DecryptParams): Promise<Uint8Array> {
  const sodium = await getSodium();
  if (media.v === 2) {
    return decryptAttachment(sodium, ciphertext, media.key, media.nonce, media.chunkSize ?? 0, media.hash);
  }
  return decryptBlob(sodium, ciphertext, media.key, media.nonce, media.hash);
}

/**
 * Decrypts downloaded ciphertext into `target` (native) or a blob: URL (web).
 * Returns the URI. Nothing partial is left behind on failure.
 */
export async function decryptToLocal(
  downloaded: DownloadedCiphertext,
  media: DecryptParams,
  target: File | null,
  onProgress?: TransferProgress
): Promise<string> {
  onProgress?.('decrypting', 0);
  if (downloaded.file && target) {
    const sodium = await getSodium();
    await decryptFileToFile(sodium, downloaded.file, target, media, (f) => onProgress?.('decrypting', f));
    return target.uri;
  }
  const bytes = downloaded.bytes ?? (downloaded.file ? await downloaded.file.bytes() : null);
  if (!bytes) throw new Error('Nothing to decrypt');
  const plain = await decryptBytes(bytes, media);
  onProgress?.('decrypting', 1);
  if (target) {
    target.create({ overwrite: true, intermediates: true });
    target.write(plain);
    return target.uri;
  }
  return URL.createObjectURL(new Blob([plain as unknown as BlobPart], { type: media.mimeType }));
}
