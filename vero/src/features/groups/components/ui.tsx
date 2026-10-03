/**
 * Cross-platform dialogs for the group/channel/community screens.
 * (react-native-web's Alert.alert ignores buttons, so web uses window.confirm.)
 */

import React from 'react';
import { Alert, Modal, Platform, Pressable, Share, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { Ionicons } from '@expo/vector-icons';
import { BorderRadius, Colors, Spacing, Typography } from '../../../shared/theme/theme';

export function notify(title: string, message?: string): void {
  if (Platform.OS === 'web') {
    (globalThis as any).alert?.(message ? `${title}\n\n${message}` : title);
  } else {
    Alert.alert(title, message);
  }
}

export function confirmAction(title: string, message: string, confirmLabel: string, destructive = false): Promise<boolean> {
  if (Platform.OS === 'web') {
    return Promise.resolve(!!(globalThis as any).confirm?.(`${title}\n\n${message}`));
  }
  return new Promise((resolve) =>
    Alert.alert(title, message, [
      { text: 'Cancel', style: 'cancel', onPress: () => resolve(false) },
      { text: confirmLabel, style: destructive ? 'destructive' : 'default', onPress: () => resolve(true) },
    ], { cancelable: true, onDismiss: () => resolve(false) })
  );
}

/** OS share sheet; falls back to the clipboard where sharing isn't available. */
export async function shareLink(url: string, title: string): Promise<void> {
  try {
    if (Platform.OS === 'web' && !(globalThis as any).navigator?.share) throw new Error('no share');
    await Share.share(Platform.OS === 'ios' ? { url, message: title } : { message: `${title}\n${url}`, title });
  } catch {
    await Clipboard.setStringAsync(url);
    notify('Link copied', url);
  }
}

export async function copyLink(url: string): Promise<void> {
  await Clipboard.setStringAsync(url);
  notify('Link copied', url);
}

export interface SheetOption {
  label: string;
  icon?: keyof typeof Ionicons.glyphMap;
  destructive?: boolean;
  onPress: () => void;
}

export function ActionSheet({
  visible,
  title,
  options,
  onClose,
}: {
  visible: boolean;
  title?: string;
  options: SheetOption[];
  onClose: () => void;
}) {
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <View style={styles.sheet}>
          {!!title && <Text style={styles.title}>{title}</Text>}
          {options.map((o) => (
            <TouchableOpacity
              key={o.label}
              style={styles.option}
              onPress={() => {
                onClose();
                o.onPress();
              }}
            >
              {o.icon && <Ionicons name={o.icon} size={20} color={o.destructive ? Colors.error : Colors.accent} />}
              <Text style={[styles.optionText, o.destructive && { color: Colors.error }]}>{o.label}</Text>
            </TouchableOpacity>
          ))}
          <TouchableOpacity style={styles.option} onPress={onClose}>
            <Ionicons name="close" size={20} color={Colors.textSecondary} />
            <Text style={[styles.optionText, { color: Colors.textSecondary }]}>Cancel</Text>
          </TouchableOpacity>
        </View>
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
    paddingVertical: Spacing.md,
    paddingBottom: Spacing['2xl'],
  },
  title: {
    color: Colors.textSecondary,
    fontSize: Typography.sm,
    fontWeight: Typography.semibold,
    paddingHorizontal: Spacing.lg,
    paddingBottom: Spacing.sm,
  },
  option: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md, paddingHorizontal: Spacing.lg, paddingVertical: Spacing.md },
  optionText: { color: Colors.textPrimary, fontSize: Typography.base },
});
