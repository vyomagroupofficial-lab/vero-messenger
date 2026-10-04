import React from 'react';
import { Pressable, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { makeStyles, useTheme } from '../../shared/theme/ThemeProvider';
import { useT } from '../../shared/i18n';
import { useAppUpdate } from './useAppUpdate';

/** Shown at the top of the app when a newer version is available (Android APK or a new web deploy). */
export function UpdateBanner() {
  const t = useT();
  const theme = useTheme();
  const s = useStyles();
  const insets = useSafeAreaInsets();
  const { update, progress, error, dismissed, dismiss, install } = useAppUpdate({ auto: true });
  if (update.kind === 'none' || dismissed) return null;
  const version = update.kind === 'android' ? update.manifest.version : update.version;
  const busy = progress !== null;
  return (
    <View style={[s.wrap, { bottom: insets.bottom + 72 }]} accessibilityRole="alert">
      <View style={{ flex: 1 }}>
        <Text style={[theme.type.body, s.title]}>{t('updates.available', { version, defaultValue: 'Vero {{version}} is available' })}</Text>
        <Text style={[theme.type.caption, s.sub]}>
          {error ??
            (busy
              ? t('updates.downloading', { pct: Math.round((progress ?? 0) * 100), defaultValue: 'Downloading… {{pct}}%' })
              : update.kind === 'web'
                ? t('updates.reloadHint', { defaultValue: 'Reload to get the latest version.' })
                : t('updates.installHint', { defaultValue: 'Tap Update, then confirm the install.' }))}
        </Text>
      </View>
      {!busy && (
        <Pressable onPress={dismiss} style={s.ghost} accessibilityRole="button">
          <Text style={[theme.type.caption, s.ghostText]}>{t('updates.later', { defaultValue: 'Later' })}</Text>
        </Pressable>
      )}
      <Pressable onPress={install} disabled={busy} style={[s.btn, busy && { opacity: 0.6 }]} accessibilityRole="button">
        <Text style={[theme.type.caption, s.btnText]}>
          {update.kind === 'web' ? t('updates.reload', { defaultValue: 'Reload' }) : t('updates.update', { defaultValue: 'Update' })}
        </Text>
      </Pressable>
    </View>
  );
}

const useStyles = makeStyles((c) => ({
  wrap: { position: 'absolute', left: 12, right: 12, maxWidth: 560, alignSelf: 'center', flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 14, paddingVertical: 10, borderRadius: 16, backgroundColor: c.raised, borderWidth: 1, borderColor: c.accentLine, shadowColor: '#000', shadowOpacity: 0.2, shadowRadius: 12, shadowOffset: { width: 0, height: 4 }, elevation: 6 },
  title: { color: c.text },
  sub: { color: c.muted, marginTop: 2 },
  ghost: { paddingHorizontal: 10, paddingVertical: 8 },
  ghostText: { color: c.muted },
  btn: { backgroundColor: c.accent, borderRadius: 999, paddingHorizontal: 14, paddingVertical: 8 },
  btnText: { color: c.onAccent },
}));
