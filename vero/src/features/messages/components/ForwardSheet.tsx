/**
 * Pick chats to forward the selected messages to (max 5, or 1 for messages
 * that were already forwarded many times).
 */

import React, { useMemo, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { conversationTitle, Message } from '../../../shared/models/Message';
import { BorderRadius, Colors, Spacing, Typography } from '../../../shared/theme/theme';
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
  const conversations = useChatsStore((s) => s.conversations);
  const [selected, setSelected] = useState<string[]>([]);
  const [filter, setFilter] = useState('');
  const [busy, setBusy] = useState(false);
  const max = maxForwardTargets(messages);

  const list = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return q ? conversations.filter((c) => conversationTitle(c).toLowerCase().includes(q)) : conversations;
  }, [conversations, filter]);

  const toggle = (id: string) =>
    setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : s.length >= max ? (max === 1 ? [id] : s) : [...s, id]));

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
    <Modal visible={visible} transparent animationType="slide" onRequestClose={close}>
      <Pressable style={styles.backdrop} onPress={close}>
        <Pressable style={styles.sheet} onPress={() => undefined}>
          <View style={styles.header}>
            <Text style={styles.title}>
              Forward {messages.length > 1 ? `${messages.length} messages` : 'message'}
            </Text>
            <Text style={styles.subtitle}>
              {max === 1 ? 'Forwarded many times: one chat at a time' : `Up to ${max} chats`} · end-to-end encrypted
            </Text>
          </View>
          <View style={styles.search}>
            <Ionicons name="search" size={16} color={Colors.textTertiary} />
            <TextInput
              style={styles.searchInput}
              value={filter}
              onChangeText={setFilter}
              placeholder="Search chats"
              placeholderTextColor={Colors.textTertiary}
            />
          </View>
          <FlatList
            data={list}
            keyExtractor={(c) => c.id}
            style={styles.list}
            keyboardShouldPersistTaps="handled"
            renderItem={({ item }) => {
              const on = selected.includes(item.id);
              return (
                <TouchableOpacity style={styles.row} onPress={() => toggle(item.id)} accessibilityState={{ selected: on }}>
                  <Ionicons
                    name={item.conversationType === 'group' ? 'people-circle-outline' : 'person-circle-outline'}
                    size={30}
                    color={Colors.accentLight}
                  />
                  <Text style={styles.rowText} numberOfLines={1}>
                    {conversationTitle(item)}
                  </Text>
                  <Ionicons
                    name={on ? 'checkmark-circle' : 'ellipse-outline'}
                    size={22}
                    color={on ? Colors.accent : Colors.textTertiary}
                  />
                </TouchableOpacity>
              );
            }}
            ListEmptyComponent={<Text style={styles.empty}>No chats</Text>}
          />
          <TouchableOpacity
            style={[styles.sendBtn, (!check.ok || busy) && styles.sendBtnDisabled]}
            disabled={!check.ok || busy}
            onPress={send}
            accessibilityLabel="Forward"
          >
            {busy ? (
              <ActivityIndicator color={Colors.white} />
            ) : (
              <>
                <Ionicons name="arrow-redo" size={18} color={Colors.white} />
                <Text style={styles.sendText}>
                  {selected.length ? `Forward to ${selected.length} chat${selected.length > 1 ? 's' : ''}` : 'Choose chats'}
                </Text>
              </>
            )}
          </TouchableOpacity>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: Colors.overlay, justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: Colors.surfaceElevated,
    borderTopLeftRadius: BorderRadius['2xl'],
    borderTopRightRadius: BorderRadius['2xl'],
    paddingTop: Spacing.base,
    paddingBottom: Spacing.xl,
    maxHeight: '80%',
  },
  header: { paddingHorizontal: Spacing.lg, marginBottom: Spacing.sm },
  title: { color: Colors.textPrimary, fontSize: Typography.lg, fontWeight: Typography.bold },
  subtitle: { color: Colors.textTertiary, fontSize: Typography.xs, marginTop: 2 },
  search: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    marginHorizontal: Spacing.lg,
    marginBottom: Spacing.sm,
    paddingHorizontal: Spacing.md,
    height: 40,
    borderRadius: BorderRadius.lg,
    backgroundColor: Colors.inputBackground,
    borderWidth: 1,
    borderColor: Colors.inputBorder,
  },
  searchInput: { flex: 1, color: Colors.textPrimary, fontSize: Typography.sm, height: '100%' },
  list: { flexGrow: 0 },
  row: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md, paddingHorizontal: Spacing.lg, paddingVertical: Spacing.sm },
  rowText: { flex: 1, color: Colors.textPrimary, fontSize: Typography.base },
  empty: { color: Colors.textTertiary, textAlign: 'center', padding: Spacing.lg },
  sendBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.sm,
    marginHorizontal: Spacing.lg,
    marginTop: Spacing.md,
    height: 46,
    borderRadius: BorderRadius.lg,
    backgroundColor: Colors.accent,
  },
  sendBtnDisabled: { opacity: 0.5 },
  sendText: { color: Colors.white, fontSize: Typography.base, fontWeight: Typography.semibold },
});
