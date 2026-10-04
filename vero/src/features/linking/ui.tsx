/**
 * Building blocks shared by the QR / discovery / linking / transfer screens, in the Ink & Brass
 * design. Theme-aware, so every screen follows the light/dark setting.
 */

import React, { useEffect } from 'react';
import { StyleProp, StyleSheet, Text, View, ViewStyle } from 'react-native';
import Animated, { ZoomIn, useAnimatedStyle, useSharedValue, withRepeat, withSequence, withTiming } from 'react-native-reanimated';
import { router } from 'expo-router';
import { makeStyles, useTheme } from '../../shared/theme/ThemeProvider';
import { useT } from '../../shared/i18n';
import { BorderRadius, Colors, Spacing, Typography } from '../../shared/theme/theme';
import { Button as VeroButton, Glyph, GlyphName, glyphToIcon, IconButton, isIconName } from '../../shared/ui';

export function ScreenHeader({ title, onBack, right }: { title: string; onBack?: () => void; right?: React.ReactNode }) {
  const { type } = useTheme();
  const s = useStyles();
  const t = useT();
  return (
    <View style={s.header}>
      <IconButton icon="back" label={t('common.back')} onPress={onBack ?? (() => (router.canGoBack() ? router.back() : router.replace('/')))} />
      <Text style={[type.name, { flex: 1, textAlign: 'center', fontSize: 17 }]} numberOfLines={1} accessibilityRole="header">
        {title}
      </Text>
      <View style={{ width: 44, alignItems: 'center' }}>{right}</View>
    </View>
  );
}

export function Card({ children, style }: { children: React.ReactNode; style?: StyleProp<ViewStyle> }) {
  const s = useStyles();
  return <View style={[s.card, style]}>{children}</View>;
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
  icon?: GlyphName;
  variant?: 'primary' | 'secondary' | 'danger';
  loading?: boolean;
  disabled?: boolean;
}) {
  const mapped = icon ? glyphToIcon(icon) ?? (isIconName(String(icon)) ? (icon as any) : undefined) : undefined;
  return <VeroButton label={label} onPress={onPress} icon={mapped} variant={variant === 'danger' ? 'dangerSoft' : variant} loading={loading} disabled={disabled} />;
}

export function Note({ icon = 'info', children, tone = 'info' }: { icon?: GlyphName; children: React.ReactNode; tone?: 'info' | 'warning' | 'success' }) {
  const { c } = useTheme();
  const s = useStyles();
  const color = tone === 'warning' ? c.danger : tone === 'success' ? c.success : c.accentText;
  const bg = tone === 'warning' ? c.dangerTint : tone === 'success' ? c.successTint : c.accentTint;
  return (
    <View style={[s.note, { backgroundColor: bg }]}>
      <View style={s.noteIcon}>
        <Glyph name={icon} size={15} color={color} />
      </View>
      <Text style={s.noteText}>{children}</Text>
    </View>
  );
}

/** Icon tile + title + body, for the steps of a linking/transfer flow. */
export function FlowCard({ icon, tone = 'brass', title, body, children }: { icon: GlyphName; tone?: 'brass' | 'success' | 'danger'; title: string; body?: string; children?: React.ReactNode }) {
  const { c, type } = useTheme();
  const s = useStyles();
  const color = tone === 'success' ? c.success : tone === 'danger' ? c.danger : c.accentText;
  const bg = tone === 'success' ? c.successTint : tone === 'danger' ? c.dangerTint : c.accentTint;
  return (
    <Animated.View entering={ZoomIn.springify().damping(16)} style={[s.card, { alignItems: 'center', gap: 14, paddingVertical: 26 }]}>
      <View style={[s.flowIcon, { backgroundColor: bg }]}>
        <Glyph name={icon} size={30} color={color} />
      </View>
      <Text style={[type.h2, { textAlign: 'center' }]}>{title}</Text>
      {body ? <Text style={[type.bodyMuted, { textAlign: 'center' }]}>{body}</Text> : null}
      {children}
    </Animated.View>
  );
}

/** Determinate when `value` is a number, a gentle shimmer when null. */
export function ProgressBar({ value }: { value: number | null }) {
  const s = useStyles();
  const pulse = useSharedValue(0.4);
  const width = useSharedValue(0);
  useEffect(() => {
    if (value == null) pulse.value = withRepeat(withSequence(withTiming(1, { duration: 700 }), withTiming(0.4, { duration: 700 })), -1);
    else pulse.value = withTiming(1, { duration: 200 });
  }, [value == null]);
  useEffect(() => {
    width.value = withTiming(Math.min(1, Math.max(0.04, value ?? 0.12)), { duration: 260 });
  }, [value]);
  const a = useAnimatedStyle(() => ({ width: `${width.value * 100}%`, opacity: pulse.value }));
  return (
    <View style={s.track} accessibilityRole="progressbar" accessibilityValue={value == null ? undefined : { min: 0, max: 100, now: Math.round(value * 100) }}>
      <Animated.View style={[s.fill, a]} />
    </View>
  );
}

/** Layout styles for these screens; content is capped and centred for desktop. */
export const useLinkStyles = makeStyles((c, t, f) => ({
  title: { ...t.h2, textAlign: 'center' },
  body: { ...t.bodyMuted, textAlign: 'center' },
  label: { fontFamily: f.semibold, fontSize: 14, color: c.text },
  muted: { ...t.caption },
  content: { padding: 20, gap: 16, paddingBottom: 60, width: '100%', maxWidth: 560, alignSelf: 'center' },
  center: { alignItems: 'center', gap: 12 },
  input: {
    backgroundColor: c.field,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: c.line2,
    color: c.text,
    paddingHorizontal: 14,
    height: 50,
    fontFamily: f.body,
    fontSize: 15,
    outlineStyle: 'none',
  } as any,
  screen: { flex: 1, backgroundColor: c.bg },
}));

const useStyles = makeStyles((c, t, f) => ({
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: c.line, backgroundColor: c.bg },
  card: { backgroundColor: c.panel, borderRadius: 24, borderWidth: 1, borderColor: c.line, padding: 18, gap: 12 },
  note: { flexDirection: 'row', gap: 10, borderRadius: 16, padding: 12, alignItems: 'flex-start' },
  noteIcon: { width: 28, height: 28, borderRadius: 9, backgroundColor: c.raised, alignItems: 'center', justifyContent: 'center' },
  noteText: { flex: 1, fontFamily: f.body, fontSize: 13, lineHeight: f.script === 'latin' ? 19 : 22, color: c.muted, paddingTop: 4 },
  flowIcon: { width: 72, height: 72, borderRadius: 24, alignItems: 'center', justifyContent: 'center' },
  track: { height: 8, borderRadius: 4, backgroundColor: c.field, overflow: 'hidden', width: '100%' },
  fill: { height: 8, borderRadius: 4, backgroundColor: c.accent },
}));

/**
 * Legacy static styles for screens not yet moved to the themed kit (dark palette via the Colors
 * bridge). Prefer useLinkStyles().
 */
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
