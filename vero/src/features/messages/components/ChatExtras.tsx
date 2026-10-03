/**
 * Chat screen add-ons: edit banner, multi-select bar, edit history sheet.
 */

import React from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import dayjs from 'dayjs';
import type { Message } from '../../../shared/models/Message';
import { BorderRadius, Colors, Spacing, Typography } from '../../../shared/theme/theme';
import type { EditHistoryEntry } from '../edits';

export function EditBanner({ message, onCancel }: { message: Message; onCancel: () => void }) {
  return (
    <View style={styles.banner}>
      <Ionicons name="create-outline" size={16} color={Colors.accent} />
      <View style={{ flex: 1 }}>
        <Text style={styles.bannerTitle}>Edit message</Text>
        <Text style={styles.bannerText} numberOfLines={1}>
          {message.content || (message.messageType === 'text' ? '' : 'Add a caption')}
        </Text>
      </View>
      <TouchableOpacity onPress={onCancel} accessibilityLabel="Cancel edit">
        <Ionicons name="close" size={20} color={Colors.textSecondary} />
      </TouchableOpacity>
    </View>
  );
}

export function SelectionBar({
  count,
  allStarred,
  canForward,
  onCancel,
  onStar,
  onForward,
  onCopy,
  onDelete,
}: {
  count: number;
  allStarred: boolean;
  canForward: boolean;
  onCancel: () => void;
  onStar: () => void;
  onForward: () => void;
  onCopy?: () => void;
  onDelete: () => void;
}) {
  return (
    <View style={styles.selection}>
      <TouchableOpacity onPress={onCancel} style={styles.iconBtn} accessibilityLabel="Cancel selection">
        <Ionicons name="close" size={22} color={Colors.textPrimary} />
      </TouchableOpacity>
      <Text style={styles.selectionCount}>{count} selected</Text>
      <TouchableOpacity onPress={onStar} disabled={!count} style={styles.iconBtn} accessibilityLabel={allStarred ? 'Unstar' : 'Star'}>
        <Ionicons name={allStarred ? 'star' : 'star-outline'} size={21} color={count ? Colors.warning : Colors.textMuted} />
      </TouchableOpacity>
      {onCopy && (
        <TouchableOpacity onPress={onCopy} disabled={!count} style={styles.iconBtn} accessibilityLabel="Copy">
          <Ionicons name="copy-outline" size={21} color={count ? Colors.textPrimary : Colors.textMuted} />
        </TouchableOpacity>
      )}
      <TouchableOpacity onPress={onForward} disabled={!canForward} style={styles.iconBtn} accessibilityLabel="Forward">
        <Ionicons name="arrow-redo-outline" size={21} color={canForward ? Colors.textPrimary : Colors.textMuted} />
      </TouchableOpacity>
      <TouchableOpacity onPress={onDelete} disabled={!count} style={styles.iconBtn} accessibilityLabel="Delete for me">
        <Ionicons name="trash-outline" size={21} color={count ? Colors.error : Colors.textMuted} />
      </TouchableOpacity>
    </View>
  );
}

export function EditHistorySheet({
  entries,
  onClose,
}: {
  entries: EditHistoryEntry[] | null;
  onClose: () => void;
}) {
  return (
    <Modal visible={entries !== null} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <View style={styles.sheet}>
          <Text style={styles.sheetTitle}>Edit history</Text>
          <Text style={styles.sheetSubtitle}>Kept on this device only</Text>
          <ScrollView style={{ maxHeight: 360 }}>
            {(entries ?? []).map((e, i, all) => (
              <View key={`${e.at}-${i}`} style={styles.version}>
                <Text style={styles.versionMeta}>
                  {i === 0 && all.length > 1 ? 'Original' : i === all.length - 1 ? 'Current' : `Edit ${i}`} ·{' '}
                  {dayjs(e.at).format('MMM D, HH:mm')}
                </Text>
                <Text style={styles.versionText}>{e.text || '(no caption)'}</Text>
              </View>
            ))}
          </ScrollView>
        </View>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    paddingHorizontal: Spacing.base,
    paddingVertical: Spacing.sm,
    borderTopWidth: 1,
    borderTopColor: Colors.border,
    backgroundColor: Colors.surface,
  },
  bannerTitle: { color: Colors.accentLight, fontSize: Typography.xs, fontWeight: Typography.bold },
  bannerText: { color: Colors.textSecondary, fontSize: Typography.sm },
  selection: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.xs,
    paddingHorizontal: Spacing.sm,
    paddingVertical: Spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
    backgroundColor: '#070D18',
  },
  selectionCount: { flex: 1, color: Colors.textPrimary, fontSize: Typography.base, fontWeight: Typography.semibold },
  iconBtn: { width: 38, height: 38, borderRadius: 19, justifyContent: 'center', alignItems: 'center' },
  backdrop: { flex: 1, backgroundColor: Colors.overlay, justifyContent: 'center', padding: Spacing.xl },
  sheet: { backgroundColor: Colors.surfaceElevated, borderRadius: BorderRadius.xl, padding: Spacing.lg },
  sheetTitle: { color: Colors.textPrimary, fontSize: Typography.lg, fontWeight: Typography.bold },
  sheetSubtitle: { color: Colors.textTertiary, fontSize: Typography.xs, marginBottom: Spacing.md },
  version: { paddingVertical: Spacing.sm, borderBottomWidth: 1, borderBottomColor: Colors.divider },
  versionMeta: { color: Colors.textTertiary, fontSize: Typography.xs, marginBottom: 2 },
  versionText: { color: Colors.textPrimary, fontSize: Typography.base },
});
