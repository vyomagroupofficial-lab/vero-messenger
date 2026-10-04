/**
 * Linked devices, from the `devices` table (RLS: own rows only).
 * "Log out" on another device revokes it: it stops receiving new messages
 * (no key slots), can no longer send, and its push token is deleted by the
 * devices_revoked_clear_push trigger (005).
 */

import React, { useCallback, useEffect, useState } from 'react';
import { tx } from '../../../shared/i18n/phrases';
import { ActivityIndicator, Alert, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { router } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import dayjs from 'dayjs';
import { friendlyError, supabase } from '../../../core/network/supabase';
import { authRepository } from '../../auth/AuthRepository';
import { useAuthStore } from '../../auth/useAuthStore';
import { Button, Note, ScreenHeader, useUi } from '../../linking/ui';
import { makeStyles, useLegacyColors } from '../../../shared/theme/ThemeProvider';
import { BorderRadius, Spacing, Typography, legacyColors } from '../../../shared/theme/theme';
import { Glyph } from '../../../shared/ui';

type LinkedDevice = Awaited<ReturnType<typeof authRepository.listDevices>>[number];

export default function DevicesScreen() {
  const Colors = useLegacyColors();
  const styles = useStyles();
  const ui = useUi();
  const deviceId = useAuthStore((s) => s.deviceId);
  const isDemo = useAuthStore((s) => s.isDemo);
  const logout = useAuthStore((s) => s.logout);
  const [devices, setDevices] = useState<LinkedDevice[] | null>(null);
  const [working, setWorking] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setDevices(await authRepository.listDevices());
    } catch (e) {
      setDevices([]);
      Alert.alert(tx('Could not load devices'), friendlyError(e));
    }
  }, []);

  useEffect(() => {
    if (!isDemo) void load();
  }, [isDemo, load]);

  const active = (devices ?? []).filter((d) => !d.revokedAt);
  const others = active.filter((d) => d.id !== deviceId);

  const logOutDevice = (d: LinkedDevice) => {
    Alert.alert(
      tx('Log out device'),
      tx('Log out "{{name}}"? It stops receiving new messages and notifications and can no longer send. Messages already on it stay there.', { name: d.deviceLabel }),
      [
        { text: tx('Cancel'), style: 'cancel' },
        {
          text: tx('Log out'),
          style: 'destructive',
          onPress: async () => {
            setWorking(d.id);
            try {
              await authRepository.revokeDevice(d.id);
              await load();
            } catch (e) {
              Alert.alert(tx('Could not log out the device'), friendlyError(e));
            } finally {
              setWorking(null);
            }
          },
        },
      ]
    );
  };

  const logOutOthers = () => {
    Alert.alert(
      tx('Log out all other devices'),
      tx('Every other device is unlinked and signed out of your account. Only this device keeps working.'),
      [
        { text: tx('Cancel'), style: 'cancel' },
        {
          text: tx('Log out others'),
          style: 'destructive',
          onPress: async () => {
            setWorking('others');
            try {
              for (const d of others) await authRepository.revokeDevice(d.id);
              // Also ends their Supabase sessions (refresh tokens).
              await supabase.auth.signOut({ scope: 'others' });
              await load();
            } catch (e) {
              Alert.alert(tx('Could not log out other devices'), friendlyError(e));
            } finally {
              setWorking(null);
            }
          },
        },
      ]
    );
  };

  const logOutThis = () => {
    Alert.alert(
      tx('Log out'),
      tx('Sign out on this device? Notifications stop. Your keys and chats stay on this device so you can sign back in.'),
      [
        { text: tx('Cancel'), style: 'cancel' },
        {
          text: tx('Log out'),
          style: 'destructive',
          onPress: async () => {
            await logout();
            router.replace('/(auth)/login');
          },
        },
      ]
    );
  };

  return (
    <SafeAreaView style={ui.screen} edges={['top']}>
      <ScreenHeader title={tx("Linked devices")} />
      <ScrollView contentContainerStyle={ui.content}>
        {isDemo ? (
          <Note icon="sparkles">{tx("Linked devices need a real account.")}</Note>
        ) : devices === null ? (
          <ActivityIndicator color={Colors.accent} style={{ marginTop: Spacing.xl }} />
        ) : (
          <>
            {active.map((d) => {
              const isThis = d.id === deviceId;
              return (
                <View key={d.id} style={styles.device}>
                  <View style={styles.icon}>
                    <Glyph name={/web|desktop|browser/i.test(d.deviceLabel) ? 'desktop-outline' : 'phone-portrait-outline'} size={22} color={Colors.accent} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.name} numberOfLines={1}>
                      {d.deviceLabel}
                      {isThis ? ' (this device)' : ''}
                    </Text>
                    <Text style={styles.meta}>
                      Linked {dayjs(d.createdAt).format('D MMM YYYY')} · active {dayjs(d.lastSeenAt).format('D MMM, HH:mm')}
                    </Text>
                  </View>
                  {working === d.id ? (
                    <ActivityIndicator color={Colors.error} />
                  ) : (
                    <TouchableOpacity
                      style={styles.logout}
                      onPress={() => (isThis ? logOutThis() : logOutDevice(d))}
                      accessibilityLabel={tx('Log out {{name}}', { name: d.deviceLabel })}
                    >
                      <Text style={styles.logoutText}>{tx("Log out")}</Text>
                    </TouchableOpacity>
                  )}
                </View>
              );
            })}
            {others.length > 0 ? (
              <Button label={tx("Log out all other devices")} icon="log-out-outline" variant="danger" loading={working === 'others'} onPress={logOutOthers} />
            ) : null}
            <Button label={tx("Link a device")} icon="qr-code-outline" variant="secondary" onPress={() => router.push('/devices')} />
            <Note icon="key-outline">
              Each device has its own keys; messages are encrypted separately for every linked device. A logged-out
              device no longer receives new messages or notifications.
            </Note>
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const useStyles = makeStyles((c) => {
  const Colors = legacyColors(c);
  return {
  device: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    padding: Spacing.base,
    backgroundColor: Colors.surface,
    borderRadius: BorderRadius.xl,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  icon: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: Colors.accentSubtle,
    alignItems: 'center',
    justifyContent: 'center',
  },
  name: { fontSize: Typography.base, fontWeight: Typography.semibold, color: Colors.textPrimary },
  meta: { fontSize: Typography.xs, color: Colors.textTertiary, marginTop: 2 },
  logout: {
    paddingHorizontal: Spacing.md,
    paddingVertical: 6,
    borderRadius: BorderRadius.md,
    borderWidth: 1,
    borderColor: `${Colors.error}66`,
  },
  logoutText: { color: Colors.error, fontSize: Typography.sm, fontWeight: Typography.semibold },
} as const;
});
