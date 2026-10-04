import React from 'react';
import { useLocalSearchParams } from 'expo-router';
import { ChatThread } from '../../src/features/chats/ChatThread';

export default function ChatScreen() {
  // messageId / q: opened from search or starred messages — jump to and highlight that message.
  const { id, messageId, q } = useLocalSearchParams<{ id: string; messageId?: string; q?: string }>();
  return <ChatThread conversationId={id ?? ''} jumpMessageId={messageId} jumpQuery={q} />;
}
