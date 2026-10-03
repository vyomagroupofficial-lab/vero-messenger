import type { ConversationMember, Message, MessageStatus } from '../../shared/models/Message';

/** Status of one of OUR messages, derived from the other members' receipt watermarks. */
export function computeStatus(message: Message, members: ConversationMember[], myUserId: string): MessageStatus {
  if (!message.isOwn || message.status === 'sending' || message.status === 'failed') return message.status;
  const others = members.filter((m) => m.id !== myUserId);
  if (others.length === 0) return message.status;
  if (others.every((m) => m.lastReadAt && m.lastReadAt >= message.createdAt)) return 'read';
  if (others.every((m) => m.lastDeliveredAt && m.lastDeliveredAt >= message.createdAt)) return 'delivered';
  return 'sent';
}
