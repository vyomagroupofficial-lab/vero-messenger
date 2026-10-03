/**
 * Vero Media Repository
 *
 * Handles encrypted media uploads/downloads via Google Drive.
 * All media is encrypted client-side before upload.
 * Google Drive only ever receives ciphertext.
 */

import * as FileSystem from 'expo-file-system/legacy';
import * as ImagePicker from 'expo-image-picker';
import { cryptoManager } from '../../core/crypto/CryptoManager';
import { supabase } from '../../core/network/supabase';

export interface UploadProgress {
  progress: number; // 0-100
  bytesUploaded: number;
  totalBytes: number;
}

export interface UploadResult {
  success: boolean;
  mediaId?: string;
  driveFileId?: string;
  error?: string;
}

export interface MediaPickResult {
  uri: string;
  mimeType: string;
  size: number;
  width?: number;
  height?: number;
  duration?: number;
}

class MediaRepository {
  // ──────────────────────────────────────────────────────────────────────────
  // Pick media from device
  // ──────────────────────────────────────────────────────────────────────────

  async pickImage(): Promise<MediaPickResult | null> {
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== 'granted') {
      return null;
    }

    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      quality: 0.9,
      allowsEditing: false,
    });

    if (result.canceled || !result.assets[0]) return null;

    const asset = result.assets[0];
    return {
      uri: asset.uri,
      mimeType: asset.mimeType || 'image/jpeg',
      size: asset.fileSize || 0,
      width: asset.width,
      height: asset.height,
    };
  }

  async pickVideo(): Promise<MediaPickResult | null> {
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== 'granted') return null;

    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Videos,
      quality: 0.8,
    });

    if (result.canceled || !result.assets[0]) return null;

    const asset = result.assets[0];
    return {
      uri: asset.uri,
      mimeType: asset.mimeType || 'video/mp4',
      size: asset.fileSize || 0,
      width: asset.width,
      height: asset.height,
      duration: asset.duration ?? undefined,
    };
  }

  async pickFromCamera(): Promise<MediaPickResult | null> {
    const { status } = await ImagePicker.requestCameraPermissionsAsync();
    if (status !== 'granted') return null;

    const result = await ImagePicker.launchCameraAsync({
      quality: 0.9,
      allowsEditing: false,
    });

    if (result.canceled || !result.assets[0]) return null;

    const asset = result.assets[0];
    return {
      uri: asset.uri,
      mimeType: asset.mimeType || 'image/jpeg',
      size: asset.fileSize || 0,
      width: asset.width,
      height: asset.height,
    };
  }

  async pickDocument(): Promise<MediaPickResult | null> {
    try {
      const docPicker = await import('expo-document-picker');
      const result = await docPicker.getDocumentAsync({
        type: '*/*',
        copyToCacheDirectory: true,
      });

      if (result.canceled || !result.assets || !result.assets[0]) return null;

      const asset = result.assets[0];
      return {
        uri: asset.uri,
        mimeType: asset.mimeType || 'application/octet-stream',
        size: asset.size || 0,
      };
    } catch {
      return null;
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Upload encrypted media
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Upload a media file:
   * 1. Read file as ArrayBuffer
   * 2. Encrypt locally with AES-GCM
   * 3. Upload encrypted blob to Google Drive (via Edge Function)
   * 4. Store media record in Supabase
   * 5. Return media key (to be encrypted into the message envelope)
   */
  async uploadMedia(
    localUri: string,
    mimeType: string,
    conversationId: string,
    onProgress?: (progress: UploadProgress) => void
  ): Promise<{
    success: boolean;
    mediaId?: string;
    mediaKey?: string;
    mediaIv?: string;
    sha256?: string;
    error?: string;
  }> {
    try {
      // 1. Read file
      const fileInfo = await FileSystem.getInfoAsync(localUri);
      if (!fileInfo.exists) {
        return { success: false, error: 'File not found' };
      }

      // For large files, use a streaming approach. Here we read directly.
      const base64Data = await FileSystem.readAsStringAsync(localUri, {
        encoding: FileSystem.EncodingType.Base64,
      });

      // Convert base64 to ArrayBuffer
      const binaryStr = atob(base64Data);
      const bytes = new Uint8Array(binaryStr.length);
      for (let i = 0; i < binaryStr.length; i++) {
        bytes[i] = binaryStr.charCodeAt(i);
      }
      const plainBuffer = bytes.buffer;

      // 2. Encrypt locally
      const { encryptedBuffer, mediaKey, iv, sha256 } = await cryptoManager.encryptMedia(
        plainBuffer,
        mimeType
      );

      // Convert encrypted buffer to base64 for upload
      const encryptedBytes = new Uint8Array(encryptedBuffer);
      let encryptedBase64 = '';
      const chunk = 1024;
      for (let i = 0; i < encryptedBytes.length; i += chunk) {
        const chunkArr = Array.from(encryptedBytes.slice(i, i + chunk));
        encryptedBase64 += String.fromCharCode(...chunkArr);
      }
      encryptedBase64 = btoa(encryptedBase64);

      // 3. Upload via Edge Function (which handles Drive auth securely)
      // In production, this calls supabase.functions.invoke('create-upload-session')
      // then uploads the encrypted blob to Drive
      const { data, error: uploadError } = await supabase.functions.invoke(
        'create-upload-session',
        {
          body: {
            conversationId,
            encryptedData: encryptedBase64,
            mimeTypeHint: mimeType,
            encryptedSize: encryptedBuffer.byteLength,
            sha256,
          },
        }
      );

      if (uploadError) {
        // Fallback: store in Supabase storage (not recommended for production)
        console.warn('[MediaRepository] Edge Function unavailable, using fallback');
        return {
          success: false,
          error: 'Media upload service unavailable. Configure Google Drive Edge Function.',
        };
      }

      const driveFileId = data?.driveFileId;

      // 4. Record media metadata in Supabase
      const { data: mediaRecord, error: mediaError } = await supabase
        .from('media')
        .insert({
          conversation_id: conversationId,
          encrypted_object_id: driveFileId || `local-${Date.now()}`,
          encrypted_size: encryptedBuffer.byteLength,
          encrypted_sha256: sha256,
          mime_type_hint: mimeType,
          encryption_version: 1,
        })
        .select('id')
        .single();

      if (mediaError) {
        return { success: false, error: mediaError.message };
      }

      return {
        success: true,
        mediaId: mediaRecord.id,
        mediaKey,  // This is returned to be encrypted into the message envelope
        mediaIv: iv,
        sha256,
      };
    } catch (e: any) {
      console.error('[MediaRepository] uploadMedia error:', e);
      return { success: false, error: e.message };
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Download and decrypt media
  // ──────────────────────────────────────────────────────────────────────────

  async downloadAndDecryptMedia(
    encryptedObjectId: string,
    mediaKey: string,
    mediaIv: string,
    sha256: string,
    localPath: string
  ): Promise<{ success: boolean; uri?: string; error?: string }> {
    try {
      // 1. Get download URL from Edge Function
      const { data, error } = await supabase.functions.invoke('get-media-download-url', {
        body: { objectId: encryptedObjectId },
      });

      if (error) {
        return { success: false, error: 'Failed to get download URL' };
      }

      // 2. Download encrypted blob
      const downloadResult = await FileSystem.downloadAsync(data.url, localPath);
      if (downloadResult.status !== 200) {
        return { success: false, error: 'Download failed' };
      }

      // 3. Read and decrypt
      const encryptedBase64 = await FileSystem.readAsStringAsync(downloadResult.uri, {
        encoding: FileSystem.EncodingType.Base64,
      });

      const binaryStr = atob(encryptedBase64);
      const bytes = new Uint8Array(binaryStr.length);
      for (let i = 0; i < binaryStr.length; i++) {
        bytes[i] = binaryStr.charCodeAt(i);
      }

      const plainBuffer = await cryptoManager.decryptMedia(
        bytes.buffer,
        mediaKey,
        mediaIv,
        sha256
      );

      // 4. Write decrypted content to temp file
      const plainBytes = new Uint8Array(plainBuffer);
      let plainBase64 = '';
      const chunk = 1024;
      for (let i = 0; i < plainBytes.length; i += chunk) {
        const chunkArr = Array.from(plainBytes.slice(i, i + chunk));
        plainBase64 += String.fromCharCode(...chunkArr);
      }

      const decryptedPath = localPath.replace('.enc', '');
      await FileSystem.writeAsStringAsync(decryptedPath, btoa(plainBase64), {
        encoding: FileSystem.EncodingType.Base64,
      });

      return { success: true, uri: decryptedPath };
    } catch (e: any) {
      console.error('[MediaRepository] downloadAndDecryptMedia error:', e);
      return { success: false, error: e.message };
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Cache management
  // ──────────────────────────────────────────────────────────────────────────

  async getCacheDirectory(): Promise<string> {
    const dir = `${FileSystem.cacheDirectory}vero-media/`;
    const info = await FileSystem.getInfoAsync(dir);
    if (!info.exists) {
      await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
    }
    return dir;
  }

  async clearMediaCache(): Promise<void> {
    const dir = `${FileSystem.cacheDirectory}vero-media/`;
    const info = await FileSystem.getInfoAsync(dir);
    if (info.exists) {
      await FileSystem.deleteAsync(dir, { idempotent: true });
    }
  }
}

export const mediaRepository = new MediaRepository();
