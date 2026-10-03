/**
 * Sending attachments as E2EE messages, plus the UI hook the chat screen uses.
 */

import { useCallback, useRef, useState } from 'react';
import { Alert } from 'react-native';
import { friendlyError } from '../../core/network/supabase';
import { databaseService } from '../../core/storage/DatabaseService';
import type { Message } from '../../shared/models/Message';
import { useMessagesStore } from '../messages/useMessagesStore';
import { MediaTooLargeError } from './limits';
import { mediaRepository, PickedMedia } from './MediaRepository';
import type { TransferPhase } from './transfer';
import type { VoiceRecording } from './useVoiceRecorder';

export interface SendMediaOptions {
  replyTo?: Message | null;
  caption?: string;
  onProgress?: (phase: TransferPhase, fraction: number) => void;
}

/** Encrypts, uploads and sends one attachment. Resolves with the sent (or failed) message. */
export async function sendMediaMessage(
  conversationId: string,
  picked: PickedMedia,
  opts: SendMediaOptions = {}
): Promise<Message | null> {
  const media = await mediaRepository.uploadEncrypted(picked, conversationId, { onProgress: opts.onProgress });
  // Voice recordings are ours: move them into the cache. Picker files are copied.
  const localUri = mediaRepository.rememberSent(media, picked.uri, picked.kind === 'voice');
  return useMessagesStore
    .getState()
    .send(
      conversationId,
      { t: 'media', kind: picked.kind, media, caption: opts.caption || undefined },
      { mediaId: media.mediaId, localUri, replyTo: opts.replyTo ?? null }
    );
}

export function voiceRecordingToMedia(rec: VoiceRecording): PickedMedia {
  return {
    uri: rec.uri,
    kind: 'voice',
    mimeType: rec.mimeType,
    size: rec.size,
    durationMs: rec.durationMs,
    waveform: rec.waveform,
  };
}

/** Records locally that this device has played a received voice note. */
export async function markVoicePlayed(message: Message): Promise<void> {
  if (!message.media || message.media.playedAt) return;
  const media = { ...message.media, playedAt: new Date().toISOString() };
  await databaseService.updateMessageMedia(message.id, media);
  useMessagesStore.getState().upsert(message.conversationId, { ...message, media });
}

const PHASE_LABEL: Record<TransferPhase, string> = {
  preparing: 'Preparing',
  encrypting: 'Encrypting',
  uploading: 'Uploading',
  verifying: 'Verifying',
  downloading: 'Downloading',
  decrypting: 'Decrypting',
};

/**
 * Chat-screen helper: one upload at a time, progress label, friendly errors
 * (e.g. the 50 MB limit).
 */
export function useMediaSender(conversationId: string) {
  const [status, setStatus] = useState<string | null>(null);
  const busy = useRef(false);

  const send = useCallback(
    async (picked: PickedMedia, opts: Omit<SendMediaOptions, 'onProgress'> = {}): Promise<boolean> => {
      if (busy.current) {
        Alert.alert('Please wait', 'Another attachment is still being sent.');
        return false;
      }
      busy.current = true;
      setStatus('Encrypting…');
      try {
        const result = await sendMediaMessage(conversationId, picked, {
          ...opts,
          onProgress: (phase, f) =>
            setStatus(
              phase === 'uploading' || phase === 'encrypting'
                ? `${PHASE_LABEL[phase]}… ${Math.round(f * 100)}%`
                : `${PHASE_LABEL[phase]}…`
            ),
        });
        if (result?.status === 'failed') {
          Alert.alert('Message not sent', 'Check your connection, then tap the message to retry.');
        }
        return true;
      } catch (e) {
        Alert.alert(
          e instanceof MediaTooLargeError ? 'File too large' : 'Upload failed',
          friendlyError(e, 'Could not send the attachment.')
        );
        return false;
      } finally {
        busy.current = false;
        setStatus(null);
      }
    },
    [conversationId]
  );

  return { uploading: status !== null, status, send };
}
