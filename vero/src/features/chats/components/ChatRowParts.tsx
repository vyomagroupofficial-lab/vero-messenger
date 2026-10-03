/**
 * Chat list pieces: status/pin/mute markers, the "Archived" entry row, the
 * per-chat action sheet (pin / archive / mark read) and a simple row used by
 * the Archived screen.
 */

import React from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import { Conversation, MessageStatus, conversationTitle } from '../../../shared/models/Message';
import { Colors, Spacing, Typography } from '../../../shared/theme/theme';
import { friendlyError } from '../../../core/network/supabase';
import { ActionSheet, notify, SheetOption } from '../../groups/components/ui';
import { useMessagesStore } from '../../messages/useMessagesStore';
import { isMuted } from '../chatList';
import { useChatsStore } from '../useChatsStore';
import { useMuteStore } from '../../notifications/useMuteStore';

dayjs.extend(relativeTime);

export function StatusTicks({ status }: { status?: MessageStatus }) {
  switch (status) {
    case 'sending':
      return <Ionicons name="time-outline" size={14} color={Colors.textTertiary} style={styles.tick} />;
    case 'failed':
      return <Ionicons name="alert-circle" size={14} color={Colors.error} style={styles.tick} />;
    case 'delivered':
      return <Ionicons name="checkmark-done-outline" size={15} color={Colors.textTertiary} style={styles.tick} />;
    case 'read':
      return <Ionicons name="checkmark-done" size={15} color={Colors.accentLight} style={styles.tick} />;
    case 'sent':
      return <Ionicons name="checkmark" size={15} color={Colors.textTertiary} style={styles.tick} />;
    default:
      return null;
  }
}

/** Pin and mute markers next to the chat name. */
export function ChatMarkers({ conversation }: { conversation: Conversation }) {
  // Mute state lives in the notifications feature (005); the row's own column is a fallback.
  const mutedUntil = useMuteStore((s) => s.mutes[conversation.id] ?? null);
  return (
    <>
      {isMuted({ mutedUntil: mutedUntil ?? conversation.mutedUntil }) && (
        <Ionicons name="volume-mute" size={14} color={Colors.textTertiary} accessibilityLabel="Muted" />
      )}
      {!!conversation.pinnedAt && (
        <Ionicons name="pin" size={14} color={Colors.textTertiary} accessibilityLabel="Pinned" />
      )}
    </>
  );
}

export function ArchivedEntry({ count, unread, onPress }: { count: number; unread: number; onPress: () => void }) {
  if (count === 0) return null;
  return (
    <TouchableOpacity style={styles.archivedRow} onPress={onPress} accessibilityRole="button">
      <View style={styles.archivedIcon}>
        <Ionicons name="archive-outline" size={20} color={Colors.accentLight} />
      </View>
      <Text style={styles.archivedText}>Archived</Text>
      <Text style={[styles.archivedCount, unread > 0 && styles.archivedCountUnread]}>{unread > 0 ? unread : count}</Text>
    </TouchableOpacity>
  );
}

export function chatActionOptions(conversation: Conversation): SheetOption[] {
  const store = useChatsStore.getState();
  const run = (fn: () => Promise<void>, title: string) => () =>
    void fn().catch((e) => notify(title, friendlyError(e)));
  const options: SheetOption[] = [];
  if (!conversation.archivedAt) {
    options.push({
      label: conversation.pinnedAt ? 'Unpin chat' : 'Pin chat',
      icon: 'pin-outline',
      onPress: run(() => store.setPinned(conversation.id, !conversation.pinnedAt), 'Could not pin chat'),
    });
  }
  options.push({
    label: conversation.archivedAt ? 'Unarchive chat' : 'Archive chat',
    icon: 'archive-outline',
    onPress: run(() => store.setArchived(conversation.id, !conversation.archivedAt), 'Could not archive chat'),
  });
  if (conversation.unreadCount > 0) {
    options.push({
      label: 'Mark as read',
      icon: 'checkmark-done-outline',
      onPress: run(() => useMessagesStore.getState().markConversationRead(conversation.id), 'Could not mark as read'),
    });
  }
  return options;
}

export function ChatActionSheet({ conversation, onClose }: { conversation: Conversation | null; onClose: () => void }) {
  return (
    <ActionSheet
      visible={conversation !== null}
      title={conversation ? conversationTitle(conversation) : undefined}
      options={conversation ? chatActionOptions(conversation) : []}
      onClose={onClose}
    />
  );
}

/** Compact row for the Archived screen. */
export function SimpleChatRow({
  conversation,
  onPress,
  onLongPress,
}: {
  conversation: Conversation;
  onPress: () => void;
  onLongPress: () => void;
}) {
  const last = conversation.lastMessage;
  const unread = conversation.unreadCount > 0;
  return (
    <TouchableOpacity style={styles.row} onPress={onPress} onLongPress={onLongPress} delayLongPress={300}>
      <View style={styles.avatar}>
        <Ionicons name={conversation.conversationType === 'group' ? 'people' : 'person'} size={20} color={Colors.white} />
      </View>
      <View style={{ flex: 1 }}>
        <View style={styles.rowTop}>
          <Text style={[styles.name, unread && styles.bold]} numberOfLines={1}>
            {conversationTitle(conversation)}
          </Text>
          <ChatMarkers conversation={conversation} />
          <Text style={styles.time}>{last ? dayjs(last.createdAt).fromNow(true) : ''}</Text>
        </View>
        <View style={styles.rowBottom}>
          {last?.isOwn && <StatusTicks status={last.status} />}
          <Text style={[styles.preview, unread && styles.previewUnread]} numberOfLines={1}>
            {last ? last.preview ?? last.content ?? '' : '🔒 End-to-end encrypted'}
          </Text>
          {unread && (
            <View style={styles.badge}>
              <Text style={styles.badgeText}>{conversation.unreadCount > 99 ? '99+' : conversation.unreadCount}</Text>
            </View>
          )}
        </View>
      </View>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  tick: { marginRight: 4 },
  archivedRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.base,
    paddingHorizontal: Spacing.xl,
    paddingVertical: Spacing.md,
  },
  archivedIcon: {
    width: 52,
    alignItems: 'center',
  },
  archivedText: { flex: 1, color: Colors.textPrimary, fontSize: Typography.base, fontWeight: Typography.semibold },
  archivedCount: { color: Colors.textTertiary, fontSize: Typography.sm },
  archivedCountUnread: { color: Colors.accentLight, fontWeight: Typography.bold },
  row: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md, paddingHorizontal: Spacing.lg, paddingVertical: Spacing.md },
  avatar: {
    width: 46,
    height: 46,
    borderRadius: 23,
    backgroundColor: Colors.surfaceHighlight,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rowTop: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 3 },
  rowBottom: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  name: { flex: 1, color: Colors.textPrimary, fontSize: Typography.base },
  bold: { fontWeight: Typography.bold },
  time: { color: Colors.textTertiary, fontSize: Typography.xs },
  preview: { flex: 1, color: Colors.textSecondary, fontSize: Typography.sm },
  previewUnread: { color: Colors.textPrimary, fontWeight: Typography.semibold },
  badge: {
    backgroundColor: Colors.accent,
    borderRadius: 10,
    minWidth: 20,
    height: 20,
    paddingHorizontal: 6,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeText: { color: Colors.white, fontSize: 10, fontWeight: Typography.bold },
});
