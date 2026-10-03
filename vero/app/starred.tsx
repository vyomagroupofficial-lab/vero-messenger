import React from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { StarredList } from '../src/features/messages/components/StarredList';
import { useChatsStore } from '../src/features/chats/useChatsStore';
import { conversationTitle } from '../src/shared/models/Message';
import { Colors, Spacing, Typography } from '../src/shared/theme/theme';

/** Starred messages: all chats, or one chat with ?conversationId=<id>. */
export default function StarredScreen() {
  const { conversationId } = useLocalSearchParams<{ conversationId?: string }>();
  const chat = useChatsStore((s) => s.conversations.find((c) => c.id === conversationId));
  return (
    <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.back} accessibilityLabel="Back">
          <Ionicons name="arrow-back" size={22} color={Colors.textPrimary} />
        </TouchableOpacity>
        <View>
          <Text style={styles.title}>Starred messages</Text>
          {chat && <Text style={styles.subtitle}>{conversationTitle(chat)}</Text>}
        </View>
      </View>
      <StarredList conversationId={conversationId || undefined} />
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
  subtitle: { color: Colors.textTertiary, fontSize: Typography.xs },
});
