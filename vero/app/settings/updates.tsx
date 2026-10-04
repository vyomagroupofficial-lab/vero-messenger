import React from 'react';
import { Linking, Platform, Pressable, ScrollView, Text, View } from 'react-native';
import { Stack } from 'expo-router';
import { makeStyles, useTheme } from '../../src/shared/theme/ThemeProvider';
import { useT } from '../../src/shared/i18n';
import { useAppUpdate } from '../../src/features/updates/useAppUpdate';
import { installedVersion, RELEASES_URL } from '../../src/features/updates/UpdateService';

export default function UpdatesScreen() {
  const t = useT();
  const theme = useTheme();
  const s = useStyles();
  const { update, checking, progress, error, check, install } = useAppUpdate();
  const busy = progress !== null;
  const status = checking
    ? t('updates.checking', { defaultValue: 'Checking…' })
    : update.kind === 'none'
      ? t('updates.upToDate', { defaultValue: 'You have the latest version.' })
      : t('updates.available', { version: update.kind === 'android' ? update.manifest.version : update.version, defaultValue: 'Vero {{version}} is available' });
  return (
    <ScrollView style={{ flex: 1, backgroundColor: theme.c.bg }} contentContainerStyle={s.body}>
      <Stack.Screen options={{ title: t('updates.title', { defaultValue: 'App updates' }) }} />
      <Text style={[theme.type.caption, s.muted]}>{t('updates.installed', { version: installedVersion(), defaultValue: 'Installed version {{version}}' })}</Text>
      <Text style={[theme.type.body, s.text]}>{status}</Text>
      {update.kind === 'android' && update.manifest.notes ? <Text style={[theme.type.caption, s.muted]}>{update.manifest.notes}</Text> : null}
      {busy && <Text style={[theme.type.caption, s.muted]}>{t('updates.downloading', { pct: Math.round((progress ?? 0) * 100), defaultValue: 'Downloading… {{pct}}%' })}</Text>}
      {error && <Text style={[theme.type.caption, { color: theme.c.danger }]}>{error}</Text>}
      <View style={s.row}>
        <Pressable style={s.btn} onPress={check} disabled={checking || busy}>
          <Text style={[theme.type.caption, s.btnText]}>{t('updates.checkNow', { defaultValue: 'Check for updates' })}</Text>
        </Pressable>
        {update.kind !== 'none' && (
          <Pressable style={s.btn} onPress={install} disabled={busy}>
            <Text style={[theme.type.caption, s.btnText]}>
              {update.kind === 'web' ? t('updates.reload', { defaultValue: 'Reload' }) : t('updates.update', { defaultValue: 'Update' })}
            </Text>
          </Pressable>
        )}
      </View>
      {Platform.OS === 'ios' && <Text style={[theme.type.caption, s.muted]}>{t('updates.ios', { defaultValue: 'On iPhone, updates arrive through the App Store or TestFlight.' })}</Text>}
      <Pressable onPress={() => Linking.openURL(RELEASES_URL)}>
        <Text style={[theme.type.caption, { color: theme.c.accentText }]}>{t('updates.allReleases', { defaultValue: 'All downloads (Android, Windows, macOS, Linux, web)' })}</Text>
      </Pressable>
    </ScrollView>
  );
}

const useStyles = makeStyles((c) => ({
  body: { padding: 16, gap: 12 },
  text: { color: c.text },
  muted: { color: c.muted },
  row: { flexDirection: 'row', gap: 10 },
  btn: { backgroundColor: c.accent, borderRadius: 999, paddingHorizontal: 16, paddingVertical: 10 },
  btnText: { color: c.onAccent },
}));
