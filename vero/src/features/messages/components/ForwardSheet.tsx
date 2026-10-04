/**
 * Pick chats to forward the selected messages to (max 5, or 1 for messages
 * that were already forwarded many times).
 */

import React, { useMemo, useState } from 'react';
import { FlatList, Text, View } from 'react-native';
import Animated, { ZoomIn } from 'react-native-reanimated';
import { conversationTitle, Message } from '../../../shared/models/Message';
import { makeStyles, useTheme } from '../../../shared/theme/ThemeProvider';
import { useT } from '../../../shared/i18n';
import { Avatar, Button, Icon, Pressy, SearchField, Sheet } from '../../../shared/ui';
import { useChatsStore } from '../../chats/useChatsStore';
import { checkForwardSelection, maxForwardTargets } from '../forward';

export function ForwardSheet({
  visible,
  messages,
  onClose,
  onForward,
}: {
  visible: boolean;
  messages: Message[];
  onClose: () => void;
  onForward: (conversationIds: string[]) => Promise<void>;
}) {
  const { c, type } = useTheme();
  const s = useStyles();
  const t = useT();
  const conversations = useChatsStore((st) => st.conversations);
  const [selected, setSelected] = useState<string[]>([]);
  const [filter, setFilter] = useState('');
  const [busy, setBusy] = useState(false);
  const max = maxForwardTargets(messages);

  const list = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return q ? conversations.filter((cv) => conversationTitle(cv).toLowerCase().includes(q)) : conversations;
  }, [conversations, filter]);

  const toggle = (id: string) =>
    setSelected((sel) => (sel.includes(id) ? sel.filter((x) => x !== id) : sel.length >= max ? (max === 1 ? [id] : sel) : [...sel, id]));

  const close = () => {
    if (busy) return;
    setSelected([]);
    setFilter('');
    onClose();
  };

  const check = checkForwardSelection(messages, selected.length);

  const send = async () => {
    if (!check.ok || busy) return;
    setBusy(true);
    try {
      await onForward(selected);
      setSelected([]);
      setFilter('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet visible={visible} onClose={close} title={t('forward.title', { count: messages.length })}>
      <View style={s.note}>
        <Icon name="lock" size={13} color={c.success} />
        <Text style={[type.caption, { flex: 1 }]}>{max === 1 ? t('forward.oneChat') : t('forward.upTo', { count: max })}</Text>
      </View>
      <SearchField value={filter} onChangeText={setFilter} placeholder={t('forward.search')} />
      <FlatList
        data={list}
        keyExtractor={(cv) => cv.id}
        style={{ maxHeight: 340 }}
        keyboardShouldPersistTaps="handled"
        renderItem={({ item }) => {
          const on = selected.includes(item.id);
          const name = conversationTitle(item);
          const group = item.conversationType === 'group';
          return (
            <Pressy
              onPress={() => toggle(item.id)}
              scaleTo={0.98}
              hoverStyle={{ backgroundColor: c.tint }}
              style={[s.row, on && s.rowOn]}
              accessibilityRole="checkbox"
              accessibilityState={{ checked: on }}
              accessibilityLabel={name}
            >
              <Avatar name={name} size={42} square={group} icon={group ? 'users' : undefined} />
              <Text style={[type.body, { flex: 1 }]} numberOfLines={1}>
                {name}
              </Text>
              <View style={[s.check, on && s.checkOn]}>
                {on && (
                  <Animated.View entering={ZoomIn.springify().damping(12)}>
                    <Icon name="check" size={15} color={c.onAccent} strokeWidth={2.4} />
                  </Animated.View>
                )}
              </View>
            </Pressy>
          );
        }}
        ListEmptyComponent={<Text style={[type.caption, { textAlign: 'center', padding: 20 }]}>{t('forward.noChats')}</Text>}
      />
      <Button
        label={selected.length ? t('forward.sendTo', { count: selected.length }) : t('forward.choose')}
        icon="forward"
        loading={busy}
        disabled={!check.ok}
        onPress={send}
      />
    </Sheet>
  );
}

const useStyles = makeStyles((c, t, f) => ({
  note: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 8, paddingHorizontal: 8, borderRadius: 16 },
  rowOn: { backgroundColor: c.accentTint },
  check: { width: 24, height: 24, borderRadius: 12, borderWidth: 1.5, borderColor: c.line3, alignItems: 'center', justifyContent: 'center' },
  checkOn: { backgroundColor: c.accent, borderColor: c.accent },
}));
