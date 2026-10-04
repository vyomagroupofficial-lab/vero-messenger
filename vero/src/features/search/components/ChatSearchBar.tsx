import React from 'react';
import { ActivityIndicator, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { BorderRadius, Colors, Spacing, Typography } from '../../../shared/theme/theme';

/** Search field for one chat with "n of m" and older/newer navigation. */
export function ChatSearchBar({
  query,
  onChangeQuery,
  index,
  total,
  searching,
  onOlder,
  onNewer,
  onClose,
}: {
  query: string;
  onChangeQuery: (q: string) => void;
  index: number;
  total: number;
  searching: boolean;
  onOlder: () => void;
  onNewer: () => void;
  onClose: () => void;
}) {
  const label = searching ? '' : query.trim().length < 2 ? '' : total === 0 ? 'No results' : `${index + 1} of ${total}`;
  return (
    <View style={styles.bar}>
      <TouchableOpacity onPress={onClose} style={styles.iconBtn} accessibilityLabel="Close search">
        <Ionicons name="arrow-back" size={22} color={Colors.textPrimary} />
      </TouchableOpacity>
      <View style={styles.field}>
        <Ionicons name="search" size={16} color={Colors.textTertiary} />
        <TextInput
          style={styles.input}
          value={query}
          onChangeText={onChangeQuery}
          placeholder="Search this chat"
          placeholderTextColor={Colors.textTertiary}
          autoFocus
          returnKeyType="search"
          onSubmitEditing={onOlder}
        />
        {searching ? <ActivityIndicator size="small" color={Colors.accent} /> : <Text style={styles.count}>{label}</Text>}
      </View>
      <TouchableOpacity
        onPress={onOlder}
        disabled={total === 0}
        style={styles.iconBtn}
        accessibilityLabel="Older result"
      >
        <Ionicons name="chevron-up" size={22} color={total ? Colors.textPrimary : Colors.textMuted} />
      </TouchableOpacity>
      <TouchableOpacity
        onPress={onNewer}
        disabled={total === 0}
        style={styles.iconBtn}
        accessibilityLabel="Newer result"
      >
        <Ionicons name="chevron-down" size={22} color={total ? Colors.textPrimary : Colors.textMuted} />
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: Spacing.sm,
    paddingVertical: Spacing.sm,
    gap: Spacing.xs,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
    backgroundColor: '#070D18',
  },
  iconBtn: { width: 36, height: 36, borderRadius: 18, justifyContent: 'center', alignItems: 'center' },
  field: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    backgroundColor: Colors.inputBackground,
    borderRadius: BorderRadius.lg,
    borderWidth: 1,
    borderColor: Colors.borderAccent,
    paddingHorizontal: Spacing.md,
    height: 40,
  },
  input: { flex: 1, color: Colors.textPrimary, fontSize: Typography.sm, height: '100%' },
  count: { color: Colors.textTertiary, fontSize: Typography.xs },
});
