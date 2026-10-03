/**
 * Offline demo content. Used ONLY for the explicit "Explore demo" account,
 * which has its own local database and never talks to Supabase.
 */

import { databaseService } from '../../core/storage/DatabaseService';
import { Conversation, Message, User } from '../../shared/models/Message';
import { DEMO_USER_ID } from '../auth/useAuthStore';

export const DEMO_CONTACTS: User[] = [
  { id: 'demo-sarah', username: 'sarah', displayName: 'Sarah Connor', about: 'Security lead' },
  { id: 'demo-marcus', username: 'marcus', displayName: 'Marcus Vance', about: 'Protocol engineer' },
  { id: 'demo-elena', username: 'elena', displayName: 'Elena Rostova', about: 'Cryptographer' },
];

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

function msg(
  conversationId: string,
  id: string,
  from: User | null,
  content: string,
  minutes: number
): Message {
  return {
    id,
    conversationId,
    senderDeviceId: from ? `${from.id}-device` : 'demo-device',
    senderUserId: from ? from.id : DEMO_USER_ID,
    senderName: from ? from.displayName : 'You',
    content,
    messageType: 'text',
    status: 'read',
    isOwn: !from,
    createdAt: minutesAgo(minutes),
    reactions: [],
  };
}

export async function seedDemoData(): Promise<void> {
  const existing = await databaseService.getCachedConversations();
  if (existing.length > 0) return;

  const [sarah, marcus, elena] = DEMO_CONTACTS;
  const me = { id: DEMO_USER_ID, username: 'you', displayName: 'You (Demo)', role: 'member' as const };
  const conversations: Conversation[] = [
    {
      id: 'demo-chat-sarah',
      conversationType: 'direct',
      otherUser: sarah,
      members: [me, { ...sarah, role: 'member' }],
      unreadCount: 0,
      createdAt: minutesAgo(600),
      updatedAt: minutesAgo(12),
    },
    {
      id: 'demo-chat-marcus',
      conversationType: 'direct',
      otherUser: marcus,
      members: [me, { ...marcus, role: 'member' }],
      unreadCount: 0,
      createdAt: minutesAgo(900),
      updatedAt: minutesAgo(45),
    },
    {
      id: 'demo-group-core',
      conversationType: 'group',
      groupName: 'Vero Core Team',
      members: [{ ...me, role: 'owner' }, { ...sarah, role: 'member' }, { ...elena, role: 'member' }],
      unreadCount: 0,
      createdAt: minutesAgo(2000),
      updatedAt: minutesAgo(120),
    },
  ];
  await databaseService.saveConversations(conversations);

  const messages = [
    msg('demo-chat-sarah', 'demo-1', sarah, 'Hey! This is demo mode, nothing here leaves your phone.', 25),
    msg('demo-chat-sarah', 'demo-2', null, 'Nice. And with a real account messages are end-to-end encrypted?', 20),
    msg('demo-chat-sarah', 'demo-3', sarah, 'Yes, every device gets its own key slot. Try verifying safety numbers with a real contact.', 12),
    msg('demo-chat-marcus', 'demo-4', marcus, 'Attachments are encrypted on-device before they are uploaded.', 50),
    msg('demo-chat-marcus', 'demo-5', null, 'So Drive only ever stores ciphertext 👍', 45),
    msg('demo-group-core', 'demo-6', elena, 'Removing someone from a group means new messages are no longer encrypted for their devices.', 120),
  ];
  for (const m of messages) await databaseService.saveMessage(m);
}
