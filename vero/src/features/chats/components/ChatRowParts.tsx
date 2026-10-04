/**
 * Chat list pieces shared by the Chats tab and the Archived screen: the row,
 * status ticks, pin/mute markers, and the per-chat action sheet
 * (pin / archive / mark read).
 */

import React from 'react';
import { Text, View } from 'react-native';
import { Conversation, MessageStatus, conversationTitle } from '../../../shared/models/Message';
import { makeStyles, useTheme } from '../../../shared/theme/ThemeProvider';
import i18n, { useT } from '../../../shared/i18n';
import { conversationPreview, listTime } from '../../../shared/i18n/format';
import { Avatar, Badge, Icon, Pressy, Rise } from '../../../shared/ui';
import { friendlyError } from '../../../core/network/supabase';
import { ActionSheet, notify, SheetOption } from '../../groups/components/ui';
import { useMessagesStore } from '../../messages/useMessagesStore';
import { isMuted } from '../chatList';
import { useChatsStore } from '../useChatsStore';
import { useMuteStore } from '../../notifications/useMuteStore';

export function StatusTicks({ status }: { status?: MessageStatus }) {
  const { c } = useTheme();
  switch (status) {
    case 'sending':
      return <Icon name="clock" size={14} color={c.faint} />;
    case 'failed':
      return <Icon name="info" size={14} color={c.danger} />;
    case 'delivered':
      return <Icon name="checks" size={15} color={c.faint} />;
    case 'read':
      return <Icon name="checks" size={15} color={c.success} />;
    case 'sent':
      return <Icon name="check" size={15} color={c.faint} />;
    default:
      return null;
  }
}

/** Mute and pin markers next to the chat name. */
export function ChatMarkers({ conversation }: { conversation: Conversation }) {
  const { c } = useTheme();
  const t = useT();
  // Mute state lives in the notifications feature; the row's own column is a fallback.
  const mutedUntil = useMuteStore((s) => s.mutes[conversation.id] ?? null);
  return (
    <>
      {isMuted({ mutedUntil: mutedUntil ?? conversation.mutedUntil }) && (
        <View accessibilityLabel={t('mute.muted')}>
          <Icon name="bellOff" size={14} color={c.faint} />
        </View>
      )}
      {!!conversation.pinnedAt && (
        <View accessibilityLabel={t('chats.pinned')}>
          <Icon name="pin" size={14} color={c.accentText} />
        </View>
      )}
    </>
  );
}

/** One chat in a list: avatar, name with markers, time, preview, unread badge. */
export function ChatListRow({
  conversation: conv,
  index = 0,
  selected = false,
  onPress,
  onLongPress,
}: {
  conversation: Conversation;
  index?: number;
  selected?: boolean;
  onPress: () => void;
  onLongPress?: () => void;
}) {
  const { c } = useTheme();
  const s = useStyles();
  const t = useT();
  const name = conversationTitle(conv);
  const unread = conv.unreadCount || 0;
  const pv = conversationPreview(t, conv);
  const group = conv.conversationType === 'group';

  return (
    <Rise index={index}>
      <Pressy
        onPress={onPress}
        onLongPress={onLongPress}
        scaleTo={0.98}
        accessibilityLabel={unread ? t('chats.unreadA11y', { name, count: unread }) : name}
        accessibilityHint={onLongPress ? t('chats.longPressHint') : undefined}
        accessibilityState={{ selected }}
        hoverStyle={!selected ? { backgroundColor: c.tint } : undefined}
        style={[s.row, selected && s.rowSelected]}
      >
        <Avatar name={name} size={52} square={group} icon={group ? 'users' : undefined} />
        <View style={s.main}>
          <View style={s.top}>
            <Text style={[s.name, unread > 0 && s.nameUnread]} numberOfLines={1}>
              {name}
            </Text>
            <ChatMarkers conversation={conv} />
            <Text style={[s.time, unread > 0 && { color: c.accentText }]}>{listTime(t, conv.lastMessage?.createdAt)}</Text>
          </View>
          <View style={s.bottom}>
            {conv.lastMessage?.isOwn && <StatusTicks status={conv.lastMessage.status ?? 'sent'} />}
            {pv.icon && <Icon name={pv.icon} size={15} color={unread ? c.text : c.faint} />}
            <Text style={[s.preview, unread > 0 && { color: c.text }]} numberOfLines={1}>
              {pv.text}
            </Text>
            {unread > 0 && !selected && <Badge count={unread} />}
          </View>
        </View>
      </Pressy>
    </Rise>
  );
}

/** "Archived" entry at the top of the chat list. */
export function ArchivedEntry({ count, unread, onPress }: { count: number; unread: number; onPress: () => void }) {
  const { c } = useTheme();
  const s = useStyles();
  const t = useT();
  if (count === 0) return null;
  return (
    <Pressy onPress={onPress} scaleTo={0.98} hoverStyle={{ backgroundColor: c.tint }} style={[s.row, { marginTop: 10 }]} accessibilityLabel={t('chats.archived')}>
      <View style={s.archivedIcon}>
        <Icon name="archive" size={20} color={c.accentText} />
      </View>
      <Text style={[s.name, { flex: 1 }]}>{t('chats.archived')}</Text>
      {unread > 0 ? <Badge count={unread} /> : <Text style={s.time}>{count}</Text>}
    </Pressy>
  );
}

export function chatActionOptions(conversation: Conversation): SheetOption[] {
  const store = useChatsStore.getState();
  const run = (fn: () => Promise<void>, title: string) => () => void fn().catch((e) => notify(title, friendlyError(e)));
  const options: SheetOption[] = [];
  if (!conversation.archivedAt) {
    options.push({
      label: conversation.pinnedAt ? i18n.t('chats.unpin') : i18n.t('chats.pin'),
      icon: 'pin',
      onPress: run(() => store.setPinned(conversation.id, !conversation.pinnedAt), i18n.t('chats.pinFailed')),
    });
  }
  options.push({
    label: conversation.archivedAt ? i18n.t('chats.unarchive') : i18n.t('chats.archive'),
    icon: 'archive',
    onPress: run(() => store.setArchived(conversation.id, !conversation.archivedAt), i18n.t('chats.archiveFailed')),
  });
  if (conversation.unreadCount > 0) {
    options.push({
      label: i18n.t('chats.markRead'),
      icon: 'checks',
      onPress: run(() => useMessagesStore.getState().markConversationRead(conversation.id), i18n.t('chats.markReadFailed')),
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

const useStyles = makeStyles((c, t, f) => ({
  row: { flexDirection: 'row', alignItems: 'center', gap: 13, marginHorizontal: 8, paddingHorizontal: 12, paddingVertical: 10, borderRadius: 18 },
  rowSelected: { backgroundColor: c.raised, borderWidth: 1, borderColor: c.line },
  main: { flex: 1, minWidth: 0, gap: 4 },
  top: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  name: { flex: 1, fontFamily: f.semibold, fontSize: 16, color: c.text },
  nameUnread: { fontFamily: f.bold },
  time: { fontFamily: f.body, fontSize: 12, color: c.faint, marginLeft: 2 },
  bottom: { flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 22 },
  preview: { flex: 1, fontFamily: f.body, fontSize: 14, color: c.muted },
  archivedIcon: { width: 52, height: 52, borderRadius: 18, backgroundColor: c.accentTint, borderWidth: 1, borderColor: c.accentTint2, alignItems: 'center', justifyContent: 'center' },
}));
