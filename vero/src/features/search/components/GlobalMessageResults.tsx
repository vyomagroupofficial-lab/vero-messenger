import React from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import dayjs from 'dayjs';
import { Conversation, Message, conversationTitle } from '../../../shared/models/Message';
import { Colors, Spacing, Typography } from '../../../shared/theme/theme';
import { makeSnippet } from '../searchQuery';
import { HighlightedText } from './HighlightedText';

export function openMessage(conversationId: string, messageId: string, query?: string): void {
  router.push({ pathname: '/chat/[id]', params: { id: conversationId, messageId, ...(query ? { q: query } : {}) } });
}

/** Message matches across all chats (chat list search). */
export function GlobalMessageResults({
  results,
  conversations,
  query,
}: {
  results: Message[];
  conversations: Conversation[];
  query: string;
}) {
  if (results.length === 0) return null;
  const byId = new Map(conversations.map((c) => [c.id, c]));
  return (
    <View style={styles.section}>
      <View style={styles.header}>
        <Ionicons name="lock-closed" size={13} color={Colors.accent} />
        <Text style={styles.headerText}>Messages · searched on this device</Text>
      </View>
      {results.map((m) => {
        const chat = byId.get(m.conversationId);
        const isGroup = chat?.conversationType === 'group';
        const who = m.isOwn ? 'You' : m.senderName;
        return (
          <TouchableOpacity
            key={m.id}
            style={styles.row}
            onPress={() => openMessage(m.conversationId, m.id, query)}
            accessibilityRole="button"
          >
            <View style={{ flex: 1 }}>
              <View style={styles.titleRow}>
                <Text style={styles.chatName} numberOfLines={1}>
                  {chat ? conversationTitle(chat) : 'Chat'}
                </Text>
                <Text style={styles.date}>{dayjs(m.createdAt).format('MMM D, HH:mm')}</Text>
              </View>
              <HighlightedText
                style={styles.snippet}
                numberOfLines={2}
                text={`${isGroup && who ? `${who}: ` : ''}${makeSnippet(m.content ?? '', query)}`}
                query={query}
              />
            </View>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  section: {
    marginTop: Spacing.base,
    paddingTop: Spacing.sm,
    borderTopWidth: 1,
    borderTopColor: Colors.border,
    paddingHorizontal: Spacing.xl,
  },
  header: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: Spacing.sm },
  headerText: {
    fontSize: Typography.xs,
    fontWeight: Typography.bold,
    color: Colors.accentLight,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  },
  row: { paddingVertical: Spacing.sm, borderBottomWidth: 1, borderBottomColor: Colors.divider },
  titleRow: { flexDirection: 'row', justifyContent: 'space-between', gap: Spacing.sm, marginBottom: 2 },
  chatName: { flex: 1, color: Colors.textPrimary, fontSize: Typography.sm, fontWeight: Typography.semibold },
  date: { color: Colors.textTertiary, fontSize: Typography.xs },
  snippet: { color: Colors.textSecondary, fontSize: Typography.sm },
});
