/**
 * Starred messages across chats, or in one chat. Data comes from this
 * device's decrypted store; stars sync encrypted between own devices.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { FlatList, Text, View } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { messagingStore } from '../../../core/storage/messagingStore';
import { currentSession } from '../../../core/session';
import { conversationTitle, Message } from '../../../shared/models/Message';
import { makeStyles, useTheme } from '../../../shared/theme/ThemeProvider';
import { useT } from '../../../shared/i18n';
import { listTime, typeLabel } from '../../../shared/i18n/format';
import { EmptyState, Icon, IconButton, Pressy, Rise } from '../../../shared/ui';
import { useChatsStore } from '../../chats/useChatsStore';
import { openMessage } from '../../search/components/GlobalMessageResults';
import { setStarred } from '../messageActions';
import { selfSync } from '../selfSync';
import { useMessagesStore } from '../useMessagesStore';
import { ForwardedLabel, RevokedBody } from './MessageLabels';

export function StarredList({ conversationId }: { conversationId?: string }) {
  const { c } = useTheme();
  const s = useStyles();
  const t = useT();
  const conversations = useChatsStore((st) => st.conversations);
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
    return <EmptyState icon="star" title={t('starred.emptyTitle')} body={t('starred.empty')} />;
  }

  const byId = new Map(conversations.map((cv) => [cv.id, cv]));
  return (
    <FlatList
      data={items}
      keyExtractor={(m) => m.id}
      contentContainerStyle={s.list}
      renderItem={({ item, index }) => {
        const chat = byId.get(item.conversationId);
        const label = typeLabel(t, item.messageType, item.content);
        const own = item.isOwn;
        return (
          <Rise index={Math.min(index, 10)}>
            <View style={s.meta}>
              <Text style={s.who} numberOfLines={1}>
                {own ? t('common.you') : item.senderName || t('common.someone')}
                {!conversationId && chat ? <Text style={s.chat}>{`  ›  ${conversationTitle(chat)}`}</Text> : null}
              </Text>
              <Text style={s.date}>{listTime(t, item.createdAt)}</Text>
            </View>
            <View style={[s.line, own && { justifyContent: 'flex-end' }]}>
              <Pressy
                onPress={() => {
                  if (conversationId && router.canGoBack()) {
                    // Opened from that chat's menu: go back to it instead of stacking a second copy.
                    void useMessagesStore.getState().jumpTo(item.conversationId, item.id);
                    router.back();
                  } else {
                    openMessage(item.conversationId, item.id);
                  }
                }}
                scaleTo={0.98}
                style={[s.bubble, own ? s.bubbleOwn : s.bubbleOther]}
                accessibilityHint={t('starred.openHint')}
              >
                {item.revokedAt ? (
                  <RevokedBody isOwn={own} />
                ) : (
                  <>
                    <ForwardedLabel hops={item.forwardCount} isOwn={own} />
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                      {label.icon && item.messageType !== 'text' && <Icon name={label.icon} size={15} color={own ? c.onMine : c.accentText} />}
                      <Text style={[s.body, { color: own ? c.onMine : c.text }]} numberOfLines={4}>
                        {label.text}
                      </Text>
                    </View>
                  </>
                )}
                <View style={s.footer}>
                  <Icon name="starFilled" size={11} color={c.accent} />
                  {!!item.editedAt && <Text style={[s.edited, { color: own ? c.mineMeta : c.faint }]}>{t('messages.edited')}</Text>}
                </View>
              </Pressy>
              <IconButton icon="star" label={t('thread.unstar')} size={36} color={c.accentText} onPress={() => void unstar(item)} />
            </View>
          </Rise>
        );
      }}
    />
  );
}

const useStyles = makeStyles((c, t, f) => ({
  list: { padding: 16, gap: 14, width: '100%', maxWidth: 760, alignSelf: 'center' },
  meta: { flexDirection: 'row', alignItems: 'baseline', gap: 8, marginBottom: 6, paddingHorizontal: 4 },
  who: { flex: 1, fontFamily: f.semibold, fontSize: 13, color: c.accentText },
  chat: { fontFamily: f.medium, color: c.muted },
  date: { fontFamily: f.body, fontSize: 12, color: c.faint },
  line: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  bubble: { flexShrink: 1, maxWidth: '88%', paddingHorizontal: 13, paddingTop: 9, paddingBottom: 7, borderRadius: 20 },
  bubbleOwn: { backgroundColor: c.mine },
  bubbleOther: { backgroundColor: c.theirs, borderWidth: 1, borderColor: c.line },
  body: { flexShrink: 1, fontFamily: f.body, fontSize: 15, lineHeight: f.script === 'latin' ? 21 : 24 },
  footer: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 4, justifyContent: 'flex-end' },
  edited: { fontFamily: f.body, fontSize: 11, fontStyle: 'italic' },
}));
