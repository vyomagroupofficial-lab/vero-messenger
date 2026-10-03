/**
 * Small presentational pieces shared by the group / channel / community
 * screens. Plain components on existing theme tokens (the UI session restyles).
 */

import React from 'react';
import { Image, StyleSheet, Switch, Text, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { BorderRadius, Colors, Spacing, Typography } from '../../../shared/theme/theme';

export function EntityAvatar({
  name,
  dataUri,
  size = 48,
  icon,
}: {
  name: string;
  dataUri?: string | null;
  size?: number;
  icon?: keyof typeof Ionicons.glyphMap;
}) {
  const box = { width: size, height: size, borderRadius: size / 2 };
  if (dataUri) return <Image source={{ uri: dataUri }} style={[styles.avatar, box]} accessibilityIgnoresInvertColors />;
  return (
    <View style={[styles.avatar, box]}>
      {icon ? (
        <Ionicons name={icon} size={size * 0.45} color={Colors.accentLight} />
      ) : (
        <Text style={[styles.avatarText, { fontSize: size * 0.4 }]}>{(name.trim()[0] || '?').toUpperCase()}</Text>
      )}
    </View>
  );
}

export function AdminsOnlyNotice({ text = 'Only admins can send messages' }: { text?: string }) {
  return (
    <View style={styles.notice} accessibilityRole="text">
      <Ionicons name="megaphone-outline" size={16} color={Colors.textSecondary} />
      <Text style={styles.noticeText}>{text}</Text>
    </View>
  );
}

export function SectionHeader({ title }: { title: string }) {
  return <Text style={styles.sectionHeader}>{title.toUpperCase()}</Text>;
}

export function Row({
  icon,
  label,
  sublabel,
  onPress,
  danger,
  right,
  disabled,
}: {
  icon?: keyof typeof Ionicons.glyphMap;
  label: string;
  sublabel?: string | null;
  onPress?: () => void;
  danger?: boolean;
  right?: React.ReactNode;
  disabled?: boolean;
}) {
  const color = danger ? Colors.error : Colors.textPrimary;
  const content = (
    <View style={[styles.row, disabled && { opacity: 0.5 }]}>
      {icon && <Ionicons name={icon} size={20} color={danger ? Colors.error : Colors.accent} style={styles.rowIcon} />}
      <View style={{ flex: 1 }}>
        <Text style={[styles.rowLabel, { color }]}>{label}</Text>
        {!!sublabel && <Text style={styles.rowSub}>{sublabel}</Text>}
      </View>
      {right}
    </View>
  );
  return onPress ? (
    <TouchableOpacity onPress={onPress} disabled={disabled} activeOpacity={0.7}>
      {content}
    </TouchableOpacity>
  ) : (
    content
  );
}

export function ToggleRow({
  label,
  sublabel,
  value,
  onChange,
  disabled,
}: {
  label: string;
  sublabel?: string;
  value: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <Row
      label={label}
      sublabel={sublabel}
      disabled={disabled}
      right={
        <Switch
          value={value}
          onValueChange={onChange}
          disabled={disabled}
          trackColor={{ true: Colors.accent, false: Colors.surfaceHighlight }}
          thumbColor={Colors.white}
        />
      }
    />
  );
}

export function ScreenHeader({ title, subtitle, onBack, right }: { title: string; subtitle?: string; onBack: () => void; right?: React.ReactNode }) {
  return (
    <View style={styles.header}>
      <TouchableOpacity onPress={onBack} style={styles.backBtn} accessibilityLabel="Back">
        <Ionicons name="arrow-back" size={22} color={Colors.textPrimary} />
      </TouchableOpacity>
      <View style={{ flex: 1 }}>
        <Text style={styles.headerTitle} numberOfLines={1}>
          {title}
        </Text>
        {!!subtitle && (
          <Text style={styles.headerSub} numberOfLines={1}>
            {subtitle}
          </Text>
        )}
      </View>
      {right}
    </View>
  );
}

export function Banner({ icon, text, tone = 'info' }: { icon: keyof typeof Ionicons.glyphMap; text: string; tone?: 'info' | 'warning' }) {
  const color = tone === 'warning' ? Colors.warning : Colors.accent;
  return (
    <View style={[styles.banner, { borderColor: color }]}>
      <Ionicons name={icon} size={14} color={color} />
      <Text style={styles.bannerText}>{text}</Text>
    </View>
  );
}

export function PrimaryButton({ label, onPress, disabled, danger }: { label: string; onPress: () => void; disabled?: boolean; danger?: boolean }) {
  return (
    <TouchableOpacity
      style={[styles.primaryBtn, danger && { backgroundColor: Colors.error }, disabled && { opacity: 0.5 }]}
      onPress={onPress}
      disabled={disabled}
      activeOpacity={0.85}
    >
      <Text style={styles.primaryBtnText}>{label}</Text>
    </TouchableOpacity>
  );
}

export const groupStyles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  scroll: { paddingBottom: Spacing['3xl'] },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: Spacing.xl, gap: Spacing.md },
  hero: { alignItems: 'center', paddingVertical: Spacing.xl, gap: Spacing.sm, paddingHorizontal: Spacing.base },
  heroTitle: { fontSize: Typography.xl, fontWeight: Typography.bold, color: Colors.textPrimary, textAlign: 'center' },
  heroSub: { fontSize: Typography.sm, color: Colors.textSecondary, textAlign: 'center' },
  body: { fontSize: Typography.base, color: Colors.textPrimary, lineHeight: 21 },
  muted: { fontSize: Typography.sm, color: Colors.textTertiary },
  input: {
    backgroundColor: Colors.inputBackground,
    borderColor: Colors.inputBorder,
    borderWidth: 1,
    borderRadius: BorderRadius.md,
    color: Colors.textPrimary,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
    fontSize: Typography.base,
    marginHorizontal: Spacing.base,
    marginBottom: Spacing.sm,
  },
  card: {
    backgroundColor: Colors.surface,
    borderRadius: BorderRadius.lg,
    borderWidth: 1,
    borderColor: Colors.border,
    marginHorizontal: Spacing.base,
    marginBottom: Spacing.sm,
    padding: Spacing.md,
  },
  chip: {
    paddingHorizontal: Spacing.md,
    paddingVertical: 6,
    borderRadius: BorderRadius.full,
    borderWidth: 1,
    borderColor: Colors.border,
    backgroundColor: Colors.surface,
  },
  chipActive: { borderColor: Colors.accent, backgroundColor: Colors.accentSubtle },
  chipText: { color: Colors.textSecondary, fontSize: Typography.sm },
  chipTextActive: { color: Colors.accentLight, fontWeight: Typography.semibold },
});

const styles = StyleSheet.create({
  avatar: {
    backgroundColor: Colors.accentSubtle,
    borderWidth: 1,
    borderColor: Colors.borderAccent,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  avatarText: { color: Colors.accentLight, fontWeight: Typography.bold },
  notice: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.sm,
    paddingVertical: Spacing.md,
    paddingHorizontal: Spacing.base,
    borderTopWidth: 1,
    borderTopColor: Colors.divider,
    backgroundColor: Colors.surface,
  },
  noticeText: { color: Colors.textSecondary, fontSize: Typography.sm },
  sectionHeader: {
    fontSize: 11,
    fontWeight: Typography.bold,
    color: Colors.textTertiary,
    letterSpacing: 0.8,
    paddingHorizontal: Spacing.base,
    paddingTop: Spacing.lg,
    paddingBottom: Spacing.sm,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: Spacing.base,
    paddingVertical: Spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Colors.divider,
    gap: Spacing.md,
  },
  rowIcon: { width: 22 },
  rowLabel: { fontSize: Typography.base, fontWeight: Typography.medium },
  rowSub: { fontSize: Typography.xs, color: Colors.textSecondary, marginTop: 2 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: Spacing.sm,
    paddingVertical: Spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
    gap: Spacing.sm,
  },
  backBtn: { padding: Spacing.sm },
  headerTitle: { fontSize: Typography.md, fontWeight: Typography.bold, color: Colors.textPrimary },
  headerSub: { fontSize: Typography.xs, color: Colors.textSecondary },
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    marginHorizontal: Spacing.base,
    marginVertical: Spacing.sm,
    padding: Spacing.sm,
    borderRadius: BorderRadius.md,
    borderWidth: 1,
    backgroundColor: Colors.surface,
  },
  bannerText: { flex: 1, fontSize: Typography.xs, color: Colors.textSecondary },
  primaryBtn: {
    backgroundColor: Colors.accent,
    borderRadius: BorderRadius.full,
    paddingVertical: Spacing.md,
    paddingHorizontal: Spacing.xl,
    alignItems: 'center',
    marginHorizontal: Spacing.base,
    marginVertical: Spacing.sm,
  },
  primaryBtnText: { color: Colors.white, fontWeight: Typography.bold, fontSize: Typography.base },
});
