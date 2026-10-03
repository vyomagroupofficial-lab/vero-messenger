/**
 * Starred messages across chats, or in one chat. Data comes from this
 * device's decrypted store; stars sync encrypted between own devices.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { FlatList, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { router, useFocusEffect } from 'expo-router';
import dayjs from 'dayjs';
import { messagingStore } from '../../../core/storage/messagingStore';
import { currentSession } from '../../../core/session';
import { conversationTitle, Message } from '../../../shared/models/Message';
import { Colors, Spacing, Typography } from '../../../shared/theme/theme';
import { previewBody } from '../../chats/chatList';
import { useChatsStore } from '../../chats/useChatsStore';
import { openMessage } from '../../search/components/GlobalMessageResults';
import { setStarred } from '../messageActions';
import { selfSync } from '../selfSync';
import { useMessagesStore } from '../useMessagesStore';
import { ForwardedLabel } from './MessageLabels';

export function StarredList({ conversationId }: { conversationId?: string }) {
  const conversations = useChatsStore((s) => s.conversations);
  const [items, setItems] = useState<Message[] | null>(null);

  const reload = useCallback(() => {
    void messagingStore.getStarredMessages(conversationId).then(setItems);
  }, [conversationId]);

  useFocusEffect(reload);
  useEffect(() => selfSync.onStarsChanged(reload), [reload]);

  const unstar = async (m: Message) => {
    const session = currentSession();
    if (!session) return;
    await setStarred(session, [m], false);
    reload();
  };

  if (items === null) return null;
  if (items.length === 0) {
    return (
      <View style={styles.empty}>
        <Ionicons name="star-outline" size={40} color={Colors.warning} />
        <Text style={styles.emptyTitle}>No starred messages</Text>
        <Text style={styles.emptyText}>Long-press a message and tap Star to find it here later.</Text>
      </View>
    );
  }

  const byId = new Map(conversations.map((c) => [c.id, c]));
  return (
    <FlatList
      data={items}
      keyExtractor={(m) => m.id}
      contentContainerStyle={{ paddingVertical: Spacing.sm }}
      ItemSeparatorComponent={() => <View style={styles.sep} />}
      renderItem={({ item }) => {
        const chat = byId.get(item.conversationId);
        return (
          <TouchableOpacity
            style={styles.row}
            onPress={() => {
              if (conversationId && router.canGoBack()) {
                // Opened from that chat's menu: go back to it instead of stacking a second copy.
                void useMessagesStore.getState().jumpTo(item.conversationId, item.id);
                router.back();
              } else {
                openMessage(item.conversationId, item.id);
              }
            }}
            onLongPress={() => void unstar(item)}
            accessibilityHint="Long-press to unstar"
          >
            <View style={styles.meta}>
              <Text style={styles.who} numberOfLines={1}>
                {item.isOwn ? 'You' : item.senderName || 'Someone'}
                {!conversationId && chat ? ` › ${conversationTitle(chat)}` : ''}
              </Text>
              <Text style={styles.date}>{dayjs(item.createdAt).format('MMM D, HH:mm')}</Text>
            </View>
            <View style={styles.bubble}>
              <ForwardedLabel hops={item.forwardCount} />
              <Text style={styles.body} numberOfLines={4}>
                {previewBody(item)}
              </Text>
              <View style={styles.footer}>
                <Ionicons name="star" size={11} color={Colors.warning} />
                {!!item.editedAt && <Text style={styles.edited}>edited</Text>}
              </View>
            </View>
          </TouchableOpacity>
        );
      }}
    />
  );
}

const styles = StyleSheet.create({
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: Spacing['2xl'], gap: Spacing.sm },
  emptyTitle: { color: Colors.textPrimary, fontSize: Typography.lg, fontWeight: Typography.bold },
  emptyText: { color: Colors.textSecondary, fontSize: Typography.sm, textAlign: 'center' },
  sep: { height: 1, backgroundColor: Colors.divider, marginHorizontal: Spacing.lg },
  row: { paddingHorizontal: Spacing.lg, paddingVertical: Spacing.md },
  meta: { flexDirection: 'row', justifyContent: 'space-between', gap: Spacing.sm, marginBottom: 6 },
  who: { flex: 1, color: Colors.accentLight, fontSize: Typography.sm, fontWeight: Typography.semibold },
  date: { color: Colors.textTertiary, fontSize: Typography.xs },
  bubble: {
    backgroundColor: Colors.bubbleReceived,
    borderWidth: 1,
    borderColor: Colors.bubbleReceivedBorder,
    borderRadius: 14,
    padding: Spacing.md,
  },
  body: { color: Colors.textPrimary, fontSize: Typography.base },
  footer: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 4, justifyContent: 'flex-end' },
  edited: { fontSize: 10, fontStyle: 'italic', color: Colors.textTertiary },
});
