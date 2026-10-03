/**
 * Vero Message & Conversation Models
 */

export interface User {
  id: string;
  username: string;
  displayName: string;
  avatarReference?: string | null;
  about?: string | null;
}

export interface Device {
  id: string;
  userId: string;
  deviceLabel: string;
  identityPublicKey: string;
  registrationId: number;
  createdAt: string;
  lastSeenAt: string;
  revokedAt?: string | null;
}

export type MessageType = 'text' | 'image' | 'video' | 'audio' | 'voice' | 'document' | 'call' | 'system';
export type MessageStatus = 'draft' | 'encrypting' | 'queued' | 'uploading_media' | 'sending' | 'sent' | 'delivered' | 'read' | 'played' | 'failed';

export interface MediaAttachment {
  mediaId: string;
  mimeTypeHint: string;
  encryptedObjectId: string;
  thumbnailObjectId?: string | null;
  encryptedSize: number;
  // These are stored locally only, never sent to server
  localUri?: string;
  // Media key (encrypted in the message envelope, decrypted locally)
  mediaKey?: string;
  mediaIv?: string;
  sha256?: string;
}

export interface Message {
  id: string;
  conversationId: string;
  senderDeviceId: string;
  senderUserId?: string;       // Resolved locally from device lookup
  senderProfile?: User;        // Resolved locally
  
  // Decrypted content (NEVER stored in Supabase plaintext)
  content?: string;            // Decrypted message text
  messageType: MessageType;
  media?: MediaAttachment;
  replyToMessageId?: string | null;
  replyToMessage?: Message;    // Resolved locally

  // Timestamps
  createdAt: string;
  expiresAt?: string | null;
  deletedAt?: string | null;

  // Status (local tracking)
  status: MessageStatus;
  isOwn: boolean;              // Is this message sent by the current user?
  
  // Reactions (stored as encrypted event envelopes)
  reactions?: MessageReaction[];

  // Edit history
  editedAt?: string;
  isEdited?: boolean;
}

export interface MessageReaction {
  emoji: string;
  userId: string;
  username?: string;
  createdAt: string;
}

export type ConversationType = 'direct' | 'group';

export interface Conversation {
  id: string;
  conversationType: ConversationType;
  
  // For direct chats: the other participant
  otherUser?: User;
  
  // For group chats
  groupName?: string;
  groupAvatar?: string | null;
  memberCount?: number;
  
  // Last message preview (decrypted locally)
  lastMessage?: {
    content?: string;
    messageType: MessageType;
    senderDisplayName?: string;
    createdAt: string;
    isOwn: boolean;
  };
  
  // Metadata
  unreadCount: number;
  isTyping?: boolean;
  typingUsers?: string[];     // display names of typing users
  
  // Presence (direct chats only)
  isOnline?: boolean;
  lastSeen?: string | null;
  
  createdAt: string;
  updatedAt: string;

  // Security
  encryptionVerified?: boolean;
  safetyNumber?: string;
}

export interface PresenceState {
  userId: string;
  status: 'online' | 'offline';
  lastSeen?: string;
}

export interface CallSession {
  id: string;
  conversationId: string;
  callType: 'voice' | 'video';
  status: 'ringing' | 'active' | 'ended' | 'missed' | 'rejected';
  initiatorUserId: string;
  startedAt?: string;
  endedAt?: string;
  duration?: number;  // seconds
}
