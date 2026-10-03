import React from 'react';
import { useLocalSearchParams } from 'expo-router';
import { ChatThread } from '../../src/features/chats/ChatThread';

export default function ChatScreen() {
  const { id, name, group } = useLocalSearchParams<{ id: string; name?: string; group?: string }>();
  return <ChatThread conversationId={id || ''} title={name} isGroup={group === undefined ? undefined : group === '1'} />;
}
