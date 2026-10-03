import React, { useMemo, useState } from 'react';
import { FlatList, StyleSheet, Switch, Text, TouchableOpacity, View } from 'react-native';
import { router } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useChatsStore } from '../src/features/chats/useChatsStore';
import { useChatPrefsStore } from '../src/features/chats/useChatPrefsStore';
import { splitArchived } from '../src/features/chats/chatList';
import { ChatActionSheet, SimpleChatRow } from '../src/features/chats/components/ChatRowParts';
import { Conversation } from '../src/shared/models/Message';
import { Colors, Spacing, Typography } from '../src/shared/theme/theme';

export default function ArchivedScreen() {
  const conversations = useChatsStore((s) => s.conversations);
  const archived = useMemo(() => splitArchived(conversations).archived, [conversations]);
  const keepArchived = useChatPrefsStore((s) => s.keepArchived);
  const setKeepArchived = useChatPrefsStore((s) => s.setKeepArchived);
  const [actionChat, setActionChat] = useState<Conversation | null>(null);

  return (
    <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.back} accessibilityLabel="Back">
          <Ionicons name="arrow-back" size={22} color={Colors.textPrimary} />
        </TouchableOpacity>
        <Text style={styles.title}>Archived</Text>
      </View>

      <View style={styles.setting}>
        <View style={{ flex: 1 }}>
          <Text style={styles.settingTitle}>Keep chats archived</Text>
          <Text style={styles.settingText}>
            Archived chats stay here when new messages arrive. Saved on this device.
          </Text>
        </View>
        <Switch value={keepArchived} onValueChange={setKeepArchived} />
      </View>

      <FlatList
        data={archived}
        keyExtractor={(c) => c.id}
        renderItem={({ item }) => (
          <SimpleChatRow
            conversation={item}
            onPress={() => router.push(`/chat/${item.id}`)}
            onLongPress={() => setActionChat(item)}
          />
        )}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Ionicons name="archive-outline" size={40} color={Colors.accent} />
            <Text style={styles.emptyText}>No archived chats. Long-press a chat to archive it.</Text>
          </View>
        }
      />
      <ChatActionSheet conversation={actionChat} onClose={() => setActionChat(null)} />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
  },
  back: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  title: { color: Colors.textPrimary, fontSize: Typography.lg, fontWeight: Typography.bold },
  setting: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: Colors.divider,
  },
  settingTitle: { color: Colors.textPrimary, fontSize: Typography.base, fontWeight: Typography.semibold },
  settingText: { color: Colors.textTertiary, fontSize: Typography.xs, marginTop: 2 },
  empty: { alignItems: 'center', padding: Spacing['2xl'], gap: Spacing.md },
  emptyText: { color: Colors.textSecondary, fontSize: Typography.sm, textAlign: 'center' },
});
