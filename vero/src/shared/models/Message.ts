/**
 * Vero message & conversation models (client side, decrypted view).
 */

import type { ExtensionMessageType, MessageExt } from './payloadExtensions';

export interface User {
  id: string;
  username: string;
  displayName: string;
  avatarReference?: string | null;
  about?: string | null;
}

/** What the UI renders. The server only knows the coarse ServerMessageType. */
export type MessageType = 'text' | 'image' | 'video' | 'voice' | 'document' | 'system' | 'unavailable' | ExtensionMessageType;
export type ServerMessageType = 'text' | 'media' | 'reaction' | 'system';
export type MessageStatus = 'sending' | 'sent' | 'delivered' | 'read' | 'failed';

export interface MediaAttachment {
  mediaId: string;
  objectId: string;
  /**
   * Attachment encryption format. Absent/1: single-shot XChaCha20-Poly1305
   * (`nonce` is the AEAD nonce). 2: chunked secretstream (`nonce` is the
   * secretstream header, `chunkSize` the plaintext chunk size).
   */
  v?: 1 | 2;
  chunkSize?: number;
  /** Per-file key + nonce/header. Only ever travel inside the E2EE payload. */
  key: string;
  nonce: string;
  /** hex BLAKE2b-256 of the ciphertext */
  hash: string;
  mimeType: string;
  /** Plaintext size in bytes. */
  size: number;
  fileName?: string;
  width?: number;
  height?: number;
  durationMs?: number;
  /** Voice notes: peaks 0..100 (see features/media/waveform). */
  waveform?: number[];
  /** Images/videos: tiny JPEG preview (base64), shown blurred while downloading. */
  thumb?: string;
  /** Decrypted (or original, for the sender) local file. Device-local only. */
  localUri?: string;
  /** Voice notes: when this device first played it. Device-local only. */
  playedAt?: string;
}

export interface MessageReaction {
  emoji: string;
  userId: string;
}

export interface Message {
  id: string;
  conversationId: string;
  senderDeviceId: string;
  senderUserId: string;
  senderName?: string;
  content?: string;
  messageType: MessageType;
  media?: MediaAttachment;
  replyToMessageId?: string | null;
  replyPreview?: string | null;
  createdAt: string;
  expiresAt?: string | null;
  deletedAt?: string | null;
  status: MessageStatus;
  isOwn: boolean;
  reactions?: MessageReaction[];
  /** Sticker / GIF / payment card / bot data (see payloadExtensions.ts). */
  ext?: MessageExt;
}

export type ConversationType = 'direct' | 'group';

export interface ConversationMember extends User {
  role: 'member' | 'admin' | 'owner';
  lastDeliveredAt?: string | null;
  lastReadAt?: string | null;
}

export interface Conversation {
  id: string;
  conversationType: ConversationType;
  otherUser?: User;
  groupName?: string | null;
  members: ConversationMember[];
  lastMessage?: {
    content?: string;
    messageType: MessageType;
    senderName?: string;
    createdAt: string;
    isOwn: boolean;
  };
  unreadCount: number;
  createdAt: string;
  updatedAt: string;
}

export function conversationTitle(c: Pick<Conversation, 'conversationType' | 'otherUser' | 'groupName'>): string {
  return c.conversationType === 'direct'
    ? c.otherUser?.displayName || 'Unknown'
    : c.groupName || 'Group';
}

export function messagePreview(type: MessageType, content?: string): string {
  switch (type) {
    case 'image':
      return content ? `📷 ${content}` : '📷 Photo';
    case 'video':
      return content ? `🎥 ${content}` : '🎥 Video';
    case 'voice':
      return '🎤 Voice message';
    case 'document':
      return `📄 ${content || 'Document'}`;
    case 'unavailable':
      return '🔒 Encrypted message';
    default:
      return content || '';
  }
}
