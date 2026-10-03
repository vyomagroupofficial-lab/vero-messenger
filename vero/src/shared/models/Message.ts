/**
 * Vero message & conversation models (client side, decrypted view).
 */

export interface User {
  id: string;
  username: string;
  displayName: string;
  avatarReference?: string | null;
  about?: string | null;
}

/** What the UI renders. The server only knows the coarse ServerMessageType. */
export type MessageType = 'text' | 'image' | 'video' | 'voice' | 'document' | 'system' | 'unavailable';
export type ServerMessageType = 'text' | 'media' | 'reaction' | 'system' | 'control';
export type MessageStatus = 'sending' | 'sent' | 'delivered' | 'read' | 'failed';

export interface MediaAttachment {
  mediaId: string;
  objectId: string;
  /** Per-file key + nonce. Only ever travel inside the E2EE payload. */
  key: string;
  nonce: string;
  hash: string;
  mimeType: string;
  size: number;
  fileName?: string;
  width?: number;
  height?: number;
  durationMs?: number;
  /** Decrypted (or original, for the sender) local file. Device-local only. */
  localUri?: string;
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
  /** Server time of the latest applied edit (text/caption changed by the sender). */
  editedAt?: string | null;
  /** Deleted for everyone: shown as "This message was deleted". */
  revokedAt?: string | null;
  /** Forward hop count from the encrypted payload (0/undefined = original). */
  forwardCount?: number;
  /** Starred on this account (local, synced between own devices). */
  starred?: boolean;
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
    status?: MessageStatus;
    /** Ready-to-show line: "Alice: 📷 Photo" in groups, deletion notices, etc. */
    preview?: string;
  };
  unreadCount: number;
  /** Own, private chat state (conversation_prefs). */
  pinnedAt?: string | null;
  archivedAt?: string | null;
  /** Present only if the backend exposes a mute column (owned elsewhere). */
  mutedUntil?: string | null;
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
