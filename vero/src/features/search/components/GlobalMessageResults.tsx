import { router } from 'expo-router';

/** Opens a chat scrolled to one message, with the search terms highlighted. */
export function openMessage(conversationId: string, messageId: string, query?: string): void {
  router.push({ pathname: '/chat/[id]', params: { id: conversationId, messageId, ...(query ? { q: query } : {}) } });
}
