import React from 'react';
import { useLocalSearchParams } from 'expo-router';
import { ChatThread } from '../../src/features/chats/ChatThread';

export default function ChatScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <ChatThread conversationId={id ?? ''} />;
}
