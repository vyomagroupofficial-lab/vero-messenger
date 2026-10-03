/**
 * Presentational kit shared by the group / channel / community screens, in the Ink & Brass design.
 * Theme-aware: every piece follows the light/dark setting.
 */

import React from 'react';
import { Image, Text, View } from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';
import { makeStyles, useTheme } from '../../../shared/theme/ThemeProvider';
import { useT } from '../../../shared/i18n';
import { Avatar, Button, Glyph, GlyphName, IconButton, Pressy, Toggle } from '../../../shared/ui';

export function EntityAvatar({ name, dataUri, size = 48, icon }: { name: string; dataUri?: string | null; size?: number; icon?: GlyphName }) {
  const { c } = useTheme();
  const radius = Math.round(size * 0.3);
  if (dataUri) {
    return <Image source={{ uri: dataUri }} style={{ width: size, height: size, borderRadius: radius, backgroundColor: c.raised }} accessibilityIgnoresInvertColors />;
  }
  if (icon && !name.trim()) {
    return (
      <View style={{ width: size, height: size, borderRadius: radius, backgroundColor: c.accentTint, borderWidth: 1, borderColor: c.accentTint2, alignItems: 'center', justifyContent: 'center' }}>
        <Glyph name={icon} size={size * 0.45} color={c.accentText} />
      </View>
    );
  }
  return <Avatar name={name || '?'} size={size} square />;
}

export function AdminsOnlyNotice({ text }: { text?: string }) {
  const { c } = useTheme();
  const s = useStyles();
  const t = useT();
  return (
    <Animated.View entering={FadeIn} style={s.notice} accessibilityRole="text">
      <Glyph name="megaphone" size={16} color={c.muted} />
      <Text style={s.noticeText}>{text ?? t('thread.adminsOnly')}</Text>
    </Animated.View>
  );
}

export function SectionHeader({ title }: { title: string }) {
  const { f } = useTheme();
  const s = useStyles();
  if (!title) return <View style={{ height: 18 }} />;
  return <Text style={s.sectionHeader}>{f.script === 'latin' ? title.toUpperCase() : title}</Text>;
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
  icon?: GlyphName;
  label: string;
  sublabel?: string | null;
  onPress?: () => void;
  danger?: boolean;
  right?: React.ReactNode;
  disabled?: boolean;
}) {
  const { c, type } = useTheme();
  const s = useStyles();
  const content = (
    <View style={[s.row, disabled && { opacity: 0.5 }]}>
      {icon && (
        <View style={[s.rowIcon, danger && { backgroundColor: c.dangerTint }]}>
          <Glyph name={icon} size={18} color={danger ? c.danger : c.accentText} />
        </View>
      )}
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <Text style={[s.rowLabel, danger && { color: c.danger }]} numberOfLines={2}>
          {label}
        </Text>
        {!!sublabel && <Text style={type.caption}>{sublabel}</Text>}
      </View>
      {right ?? (onPress && !danger ? <Glyph name="forwardChevron" size={17} color={c.faint} /> : null)}
    </View>
  );
  return onPress ? (
    <Pressy onPress={onPress} disabled={disabled} scaleTo={0.985} hoverStyle={{ backgroundColor: c.tint }} style={s.rowPress} accessibilityLabel={label}>
      {content}
    </Pressy>
  ) : (
    <View style={s.rowPress}>{content}</View>
  );
}

export function ToggleRow({ label, sublabel, value, onChange, disabled }: { label: string; sublabel?: string; value: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return <Row label={label} sublabel={sublabel} disabled={disabled} right={<Toggle label={label} value={value} onValueChange={onChange} disabled={disabled} />} />;
}

export function ScreenHeader({ title, subtitle, onBack, right }: { title: string; subtitle?: string; onBack: () => void; right?: React.ReactNode }) {
  const { type } = useTheme();
  const s = useStyles();
  const t = useT();
  return (
    <View style={s.header}>
      <IconButton icon="back" label={t('common.back')} onPress={onBack} />
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={[type.name, { fontSize: 18 }]} numberOfLines={1} accessibilityRole="header">
          {title}
        </Text>
        {!!subtitle && (
          <Text style={type.caption} numberOfLines={1}>
            {subtitle}
          </Text>
        )}
      </View>
      {right}
    </View>
  );
}

export function Banner({ icon, text, tone = 'info' }: { icon: GlyphName; text: string; tone?: 'info' | 'warning' }) {
  const { c } = useTheme();
  const s = useStyles();
  const warn = tone === 'warning';
  return (
    <View style={[s.banner, warn && { backgroundColor: c.dangerTint, borderColor: c.dangerTint }]}>
      <View style={[s.bannerIcon, warn && { backgroundColor: c.raised }]}>
        <Glyph name={icon} size={15} color={warn ? c.danger : c.accentText} />
      </View>
      <Text style={s.bannerText}>{text}</Text>
    </View>
  );
}

export function PrimaryButton({ label, onPress, disabled, danger }: { label: string; onPress: () => void; disabled?: boolean; danger?: boolean }) {
  return <Button label={label} onPress={onPress} disabled={disabled} variant={danger ? 'danger' : 'primary'} size="md" style={{ marginHorizontal: 16, marginVertical: 8 }} />;
}

/** Layout styles for the group-family screens. Content is centred and capped for desktop. */
export const useGroupStyles = makeStyles((c, t, f) => ({
  container: { flex: 1, backgroundColor: c.bg },
  scroll: { paddingBottom: 48, width: '100%', maxWidth: 760, alignSelf: 'center' },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 12 },
  hero: { alignItems: 'center', paddingVertical: 24, gap: 8, paddingHorizontal: 16 },
  heroTitle: { ...t.h2, textAlign: 'center' },
  heroSub: { ...t.bodyMuted, textAlign: 'center', maxWidth: 480 },
  body: { ...t.body },
  muted: { ...t.caption, textAlign: 'center' },
  input: {
    backgroundColor: c.field,
    borderColor: c.line2,
    borderWidth: 1,
    borderRadius: 14,
    color: c.text,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontFamily: f.body,
    fontSize: 15,
    marginHorizontal: 16,
    marginBottom: 10,
    outlineStyle: 'none',
  } as any,
  card: { backgroundColor: c.panel, borderRadius: 20, borderWidth: 1, borderColor: c.line, marginHorizontal: 16, marginBottom: 10, padding: 14 },
  chip: { paddingHorizontal: 14, height: 36, justifyContent: 'center', borderRadius: 18, borderWidth: 1, borderColor: c.line2, backgroundColor: c.raised },
  chipActive: { borderColor: c.text, backgroundColor: c.text },
  chipText: { fontFamily: f.medium, color: c.muted, fontSize: 13.5 },
  chipTextActive: { color: c.bg, fontFamily: f.semibold },
  sheetTitle: { ...t.h3, paddingHorizontal: 4 },
}));

const useStyles = makeStyles((c, t, f) => ({
  notice: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingVertical: 16, paddingHorizontal: 16, borderTopWidth: 1, borderTopColor: c.line, backgroundColor: c.panel },
  noticeText: { fontFamily: f.medium, fontSize: 13.5, color: c.muted },
  sectionHeader: { ...t.eyebrow, paddingHorizontal: 20, paddingTop: 22, paddingBottom: 8 },
  rowPress: { marginHorizontal: 8, borderRadius: 16 },
  row: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 10, minHeight: 58, gap: 13 },
  rowIcon: { width: 38, height: 38, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: c.raised },
  rowLabel: { fontFamily: f.medium, fontSize: 15.5, color: c.text },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8, paddingVertical: 8, gap: 6, borderBottomWidth: 1, borderBottomColor: c.line },
  banner: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, marginHorizontal: 16, marginVertical: 8, padding: 12, borderRadius: 16, borderWidth: 1, borderColor: c.accentTint2, backgroundColor: c.accentTint },
  bannerIcon: { width: 28, height: 28, borderRadius: 9, backgroundColor: c.raised, alignItems: 'center', justifyContent: 'center' },
  bannerText: { flex: 1, fontFamily: f.body, fontSize: 13, lineHeight: f.script === 'latin' ? 19 : 22, color: c.muted, paddingTop: 4 },
}));

const INVITE_STATUSES = new Set(['joined', 'already_member', 'requested', 'already_requested', 'following', 'revoked', 'expired', 'full', 'group_full', 'rate_limited']);

/** Translated message for an invite/join result status. */
export function inviteStatusText(t: (k: string) => string, status: string): string {
  return t(`join.status_${INVITE_STATUSES.has(status) ? status : 'invalid'}`);
}
