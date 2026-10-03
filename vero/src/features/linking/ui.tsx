/**
 * Small building blocks shared by the QR / discovery / linking / transfer
 * screens. Styling uses the app theme tokens only, so a theme revamp carries
 * over automatically.
 */

import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet, ActivityIndicator, StyleProp, ViewStyle } from 'react-native';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { Colors, Typography, Spacing, BorderRadius } from '../../shared/theme/theme';

export function ScreenHeader({ title, onBack, right }: { title: string; onBack?: () => void; right?: React.ReactNode }) {
  return (
    <View style={styles.header}>
      <TouchableOpacity
        style={styles.iconBtn}
        onPress={onBack ?? (() => (router.canGoBack() ? router.back() : router.replace('/')))}
        accessibilityLabel="Back"
      >
        <Ionicons name="arrow-back" size={22} color={Colors.textPrimary} />
      </TouchableOpacity>
      <Text style={styles.headerTitle} numberOfLines={1}>
        {title}
      </Text>
      <View style={styles.iconBtnPlaceholder}>{right}</View>
    </View>
  );
}

export function Card({ children, style }: { children: React.ReactNode; style?: StyleProp<ViewStyle> }) {
  return <View style={[styles.card, style]}>{children}</View>;
}

export function Button({
  label,
  onPress,
  icon,
  variant = 'primary',
  loading,
  disabled,
}: {
  label: string;
  onPress: () => void;
  icon?: keyof typeof Ionicons.glyphMap;
  variant?: 'primary' | 'secondary' | 'danger';
  loading?: boolean;
  disabled?: boolean;
}) {
  const color = variant === 'primary' ? Colors.white : variant === 'danger' ? Colors.error : Colors.accentLight;
  return (
    <TouchableOpacity
      style={[styles.btn, styles[variant], (disabled || loading) && styles.disabled]}
      onPress={onPress}
      disabled={disabled || loading}
      activeOpacity={0.85}
    >
      {loading ? (
        <ActivityIndicator color={color} size="small" />
      ) : (
        <>
          {icon && <Ionicons name={icon} size={18} color={color} style={{ marginRight: 8 }} />}
          <Text style={[styles.btnText, { color }]}>{label}</Text>
        </>
      )}
    </TouchableOpacity>
  );
}

export function Note({ icon = 'information-circle', children, tone = 'info' }: { icon?: keyof typeof Ionicons.glyphMap; children: React.ReactNode; tone?: 'info' | 'warning' | 'success' }) {
  const color = tone === 'warning' ? Colors.warning : tone === 'success' ? Colors.emerald : Colors.accent;
  return (
    <View style={styles.note}>
      <Ionicons name={icon} size={16} color={color} style={{ marginTop: 1 }} />
      <Text style={styles.noteText}>{children}</Text>
    </View>
  );
}

export function ProgressBar({ value }: { value: number | null }) {
  return (
    <View style={styles.progressTrack}>
      <View style={[styles.progressFill, { width: `${Math.round(Math.min(1, Math.max(0.03, value ?? 0.08)) * 100)}%` }]} />
    </View>
  );
}

export const ui = StyleSheet.create({
  title: { fontSize: Typography.xl, fontWeight: Typography.bold, color: Colors.textPrimary, textAlign: 'center' },
  body: { fontSize: Typography.sm, color: Colors.textSecondary, lineHeight: 20, textAlign: 'center' },
  label: { fontSize: Typography.sm, fontWeight: Typography.semibold, color: Colors.textPrimary },
  muted: { fontSize: Typography.xs, color: Colors.textTertiary, lineHeight: 17 },
  content: { padding: Spacing.xl, gap: Spacing.lg, paddingBottom: 60 },
  center: { alignItems: 'center', gap: Spacing.md },
  input: {
    backgroundColor: Colors.inputBackground,
    borderRadius: BorderRadius.lg,
    borderWidth: 1,
    borderColor: Colors.inputBorder,
    color: Colors.textPrimary,
    paddingHorizontal: Spacing.md,
    height: 48,
    fontSize: Typography.base,
  },
  screen: { flex: 1, backgroundColor: Colors.background },
});

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.xl,
    paddingVertical: Spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
    backgroundColor: Colors.background,
  },
  headerTitle: { flex: 1, textAlign: 'center', fontSize: Typography.lg, fontWeight: Typography.bold, color: Colors.textPrimary },
  iconBtn: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: Colors.surfaceGlassLight,
    justifyContent: 'center',
    alignItems: 'center',
  },
  iconBtnPlaceholder: { width: 38, height: 38, justifyContent: 'center', alignItems: 'center' },
  card: {
    backgroundColor: Colors.surface,
    borderRadius: BorderRadius.xl,
    borderWidth: 1,
    borderColor: Colors.border,
    padding: Spacing.lg,
    gap: Spacing.md,
  },
  btn: {
    height: 50,
    borderRadius: BorderRadius.lg,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: Spacing.lg,
  },
  primary: { backgroundColor: Colors.accent },
  secondary: { backgroundColor: Colors.accentSubtle, borderWidth: 1, borderColor: Colors.borderAccent },
  danger: { backgroundColor: 'rgba(244, 63, 94, 0.1)', borderWidth: 1, borderColor: 'rgba(244, 63, 94, 0.35)' },
  disabled: { opacity: 0.55 },
  btnText: { fontSize: Typography.base, fontWeight: Typography.bold },
  note: {
    flexDirection: 'row',
    gap: Spacing.sm,
    backgroundColor: Colors.surfaceElevated,
    borderRadius: BorderRadius.lg,
    padding: Spacing.md,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  noteText: { flex: 1, fontSize: Typography.xs, color: Colors.textSecondary, lineHeight: 18 },
  progressTrack: { height: 8, borderRadius: 4, backgroundColor: Colors.surfaceHighlight, overflow: 'hidden', width: '100%' },
  progressFill: { height: 8, borderRadius: 4, backgroundColor: Colors.accent },
});
