// Sample content for demo mode. Shown only when there is no real data to load.

import { Conversation, Message, User } from '../../shared/models/Message';
import type { LocalCallRecord } from '../../core/storage/DatabaseService';

export const DEMO_USER_ID = 'demo-user-id-001';
export const DEMO_DEVICE_ID = 'dev_local_primary';

const ago = (min: number) => new Date(Date.now() - min * 60 * 1000).toISOString();

const me: User = { id: DEMO_USER_ID, displayName: 'Aria Rao', username: 'aria' };

export const DEMO_PEOPLE: Record<string, User> = {
  maya: { id: 'maya-fernandes-01', username: 'maya_f', displayName: 'Maya Fernandes', about: 'Film photos & long walks' },
  arjun: { id: 'arjun-mehta-02', username: 'arjun_m', displayName: 'Arjun Mehta', about: 'Editing, always editing' },
  kabir: { id: 'kabir-shah-03', username: 'kabir_s', displayName: 'Kabir Shah', about: 'Ship it' },
  noor: { id: 'noor-alrashid-04', username: 'noor_a', displayName: 'Noor Al-Rashid', about: 'Say it with a voice note' },
  ira: { id: 'ira-menon-05', username: 'ira_m', displayName: 'Ira Menon', about: 'Travelling · back on the 14th' },
  kenji: { id: 'kenji-watanabe-06', username: 'kenji_w', displayName: 'Kenji Watanabe', about: 'Tokyo · GMT+9' },
  theo: { id: 'theo-lindqvist-07', username: 'theo_l', displayName: 'Theo Lindqvist', about: 'Stockholm' },
  sana: { id: 'sana-iyer-08', username: 'sana_i', displayName: 'Sana Iyer', about: 'Colour & light' },
};

export const DEMO_ONLINE = new Set([DEMO_PEOPLE.maya.id, DEMO_PEOPLE.kabir.id, DEMO_PEOPLE.arjun.id]);

export const DEMO_CONTACTS: User[] = Object.values(DEMO_PEOPLE).sort((a, b) => a.displayName.localeCompare(b.displayName));

const msg = (
  conversationId: string,
  id: string,
  from: User,
  minutesAgo: number,
  extra: Partial<Message>
): Message => ({
  id,
  conversationId,
  senderDeviceId: from.id === DEMO_USER_ID ? DEMO_DEVICE_ID : `${from.id}_dev`,
  senderUserId: from.id,
  senderProfile: from,
  messageType: 'text',
  status: 'read',
  isOwn: from.id === DEMO_USER_ID,
  createdAt: ago(minutesAgo),
  ...extra,
});

const MAYA = 'demo-chat-maya';
const LEDGER = 'demo-chat-ledger';
const KABIR = 'demo-chat-kabir';
const NOOR = 'demo-chat-noor';

const mayaRooftop = msg(MAYA, 'demo-maya-2', me, 70, { content: 'Yes! Rooftop at 7?' });

export const DEMO_MESSAGES: Record<string, Message[]> = {
  [MAYA]: [
    msg(MAYA, 'demo-maya-1', DEMO_PEOPLE.maya, 71, { content: 'Are we still on for tonight?' }),
    mayaRooftop,
    msg(MAYA, 'demo-maya-3', DEMO_PEOPLE.maya, 67, {
      messageType: 'image',
      content: 'The light up there right now',
      reactions: [{ emoji: '❤️', userId: DEMO_USER_ID, createdAt: ago(66) }],
    }),
    msg(MAYA, 'demo-maya-4', me, 65, { messageType: 'voice', content: 'Voice message' }),
    msg(MAYA, 'demo-maya-5', DEMO_PEOPLE.maya, 60, {
      content: 'Perfect. See you at 7 — I’ll bring the film camera',
      replyToMessageId: mayaRooftop.id,
      replyToMessage: mayaRooftop,
    }),
  ],
  [LEDGER]: [
    msg(LEDGER, 'demo-ledger-1', DEMO_PEOPLE.sana, 130, { content: 'Is the grade locked or are we doing one more pass?' }),
    msg(LEDGER, 'demo-ledger-2', me, 118, { content: 'One more pass on the night scenes. Notes tonight.' }),
    msg(LEDGER, 'demo-ledger-3', DEMO_PEOPLE.arjun, 100, { messageType: 'document', content: 'final_cut_v7.mov' }),
    msg(LEDGER, 'demo-ledger-4', DEMO_PEOPLE.arjun, 99, {
      content: 'Final cut is in the shared folder',
      reactions: [{ emoji: '🔥', userId: DEMO_USER_ID, createdAt: ago(98) }],
    }),
  ],
  [KABIR]: [
    msg(KABIR, 'demo-kabir-1', DEMO_PEOPLE.kabir, 52, { content: 'Did the fix go out?' }),
    msg(KABIR, 'demo-kabir-2', me, 47, { content: 'Pushing in five', status: 'delivered' }),
  ],
  [NOOR]: [
    msg(NOOR, 'demo-noor-1', DEMO_PEOPLE.noor, 60 * 20, { content: 'You have to tell the story from the trip' }),
    msg(NOOR, 'demo-noor-2', me, 60 * 19, { messageType: 'voice', content: 'Voice message' }),
  ],
};

const last = (id: string) => {
  const m = DEMO_MESSAGES[id][DEMO_MESSAGES[id].length - 1];
  const label =
    m.messageType === 'image' ? 'Photo' : m.messageType === 'voice' ? 'Voice message' : m.messageType === 'document' ? m.content : m.content;
  return {
    content: label,
    messageType: m.messageType,
    senderDisplayName: m.senderProfile?.displayName,
    createdAt: m.createdAt,
    isOwn: m.isOwn,
  };
};

const conv = (c: Partial<Conversation> & { id: string; conversationType: 'direct' | 'group' }): Conversation => ({
  unreadCount: 0,
  createdAt: ago(60 * 24 * 30),
  updatedAt: ago(5),
  ...c,
});

export const DEMO_CONVERSATIONS: Conversation[] = [
  conv({ id: MAYA, conversationType: 'direct', otherUser: DEMO_PEOPLE.maya, lastMessage: last(MAYA), unreadCount: 2, isOnline: true }),
  conv({
    id: LEDGER,
    conversationType: 'group',
    groupName: 'Studio Ledger',
    memberCount: 4,
    lastMessage: last(LEDGER),
    unreadCount: 5,
  }),
  conv({ id: KABIR, conversationType: 'direct', otherUser: DEMO_PEOPLE.kabir, lastMessage: last(KABIR), isOnline: true, isTyping: true }),
  conv({ id: NOOR, conversationType: 'direct', otherUser: DEMO_PEOPLE.noor, lastMessage: last(NOOR) }),
];

/** Members per demo conversation, so headers and sending work offline. */
export const DEMO_MEMBERS: Record<string, User[]> = {
  [MAYA]: [me, DEMO_PEOPLE.maya],
  [LEDGER]: [me, DEMO_PEOPLE.arjun, DEMO_PEOPLE.sana, DEMO_PEOPLE.kabir],
  [KABIR]: [me, DEMO_PEOPLE.kabir],
  [NOOR]: [me, DEMO_PEOPLE.noor],
};

export const DEMO_REPLIES = ['Love that', 'Ha, yes — exactly', 'On my way', 'Give me ten minutes', 'Sending it now'];

export const DEMO_CALLS: LocalCallRecord[] = [
  { id: 'c1', peerId: DEMO_PEOPLE.maya.id, peerName: 'Maya Fernandes', callType: 'video', direction: 'incoming', duration: 24 * 60 + 16, createdAt: ago(45) },
  { id: 'c2', peerId: 'studio-ledger', peerName: 'Studio Ledger', callType: 'video', direction: 'outgoing', duration: 18 * 60, createdAt: ago(80) },
  { id: 'c3', peerId: DEMO_PEOPLE.kabir.id, peerName: 'Kabir Shah', callType: 'voice', direction: 'missed', duration: 0, createdAt: ago(130) },
  { id: 'c4', peerId: DEMO_PEOPLE.maya.id, peerName: 'Maya Fernandes', callType: 'voice', direction: 'outgoing', duration: 231, createdAt: ago(60 * 20) },
  { id: 'c5', peerId: DEMO_PEOPLE.noor.id, peerName: 'Noor Al-Rashid', callType: 'voice', direction: 'incoming', duration: 12 * 60, createdAt: ago(60 * 23) },
  { id: 'c6', peerId: DEMO_PEOPLE.theo.id, peerName: 'Theo Lindqvist', callType: 'voice', direction: 'missed', duration: 0, createdAt: ago(60 * 24 * 3) },
];

export function isDemoConversation(id?: string | null) {
  return !!id && id.startsWith('demo-');
}

export function demoConversationFor(userId: string): string | undefined {
  return Object.keys(DEMO_MEMBERS).find((cid) => {
    const members = DEMO_MEMBERS[cid];
    return members.length === 2 && members.some((m) => m.id === userId);
  });
}
