/**
 * Privacy & notifications: every switch here is persisted (user_settings or
 * this device) and enforced (see privacy.ts and 005_settings_push_backup.sql).
 */

import React, { useEffect, useState } from 'react';
import { tx } from '../../../shared/i18n/phrases';
import { Alert, Platform, ScrollView } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { friendlyError } from '../../../core/network/supabase';
import { useAuthStore } from '../../auth/useAuthStore';
import { Note, ScreenHeader, useUi } from '../../linking/ui';
import { easProjectId, registerForPush, unregisterPush } from '../../notifications/pushRegistration';
import { APP_LOCK_TIMEOUTS, appLockSupport, authenticate, LockSupport, useAppLockStore } from '../appLock';
import { ChoiceRow, Section, ToggleRow } from '../components/SettingsUi';
import { DEFAULT_DISAPPEARING_OPTIONS, LAST_SEEN_OPTIONS, PrivacySettings } from '../privacy';
import { loadPrivacySettings, updatePrivacySettings } from '../settingsSync';
import { useSettingsStore } from '../useSettingsStore';
import { makeStyles, useLegacyColors } from '../../../shared/theme/ThemeProvider';
import { Glyph } from '../../../shared/ui';

export default function PrivacyScreen() {
  const Colors = useLegacyColors();
  const ui = useUi();
  const deviceId = useAuthStore((s) => s.deviceId);
  const isDemo = useAuthStore((s) => s.isDemo);
  const settings = useSettingsStore();
  const lock = useAppLockStore();
  const [busy, setBusy] = useState<string | null>(null);
  const [lockSupport, setLockSupport] = useState<LockSupport | null>(null);
  const [pushNote, setPushNote] = useState<string | null>(null);

  useEffect(() => {
    void loadPrivacySettings();
    void appLockSupport().then(setLockSupport);
    if (Platform.OS !== 'web' && !easProjectId()) {
      setPushNote(tx('Push notifications are not configured for this build (no EAS project id).'));
    }
  }, []);

  const save = async (key: string, patch: Partial<PrivacySettings>) => {
    setBusy(key);
    try {
      await updatePrivacySettings(patch);
    } catch (e) {
      Alert.alert(tx('Could not save'), friendlyError(e));
    } finally {
      setBusy(null);
    }
  };

  const toggleNotifications = async (enabled: boolean) => {
    if (!deviceId || isDemo) {
      settings.set({ notifications: enabled });
      return;
    }
    setBusy('push');
    try {
      if (enabled) {
        const result = await registerForPush(deviceId);
        if (result === 'registered') {
          settings.set({ notifications: true });
          setPushNote(null);
        } else {
          const why =
            result === 'denied'
              ? tx('Notifications are blocked for Vero in the system settings.')
              : result === 'no-project-id'
                ? tx('Push notifications are not configured for this build (no EAS project id).')
                : result === 'unsupported'
                  ? tx('Push notifications need the iOS or Android app on a real device.')
                  : tx('Could not register for push notifications. Try again later.');
          setPushNote(why);
          Alert.alert(tx('Notifications'), why);
        }
      } else {
        await unregisterPush(deviceId);
        settings.set({ notifications: false });
      }
    } catch (e) {
      Alert.alert(tx('Could not change notifications'), friendlyError(e));
    } finally {
      setBusy(null);
    }
  };

  const toggleAppLock = async (enabled: boolean) => {
    if (enabled) {
      const support = lockSupport ?? (await appLockSupport());
      if (!support.available) {
        Alert.alert(tx('App lock'), support.reason);
        return;
      }
      // Confirm the user can actually unlock before turning it on.
      if (!(await authenticate(tx('Turn on app lock')))) return;
    }
    lock.setEnabled(enabled);
  };

  return (
    <SafeAreaView style={ui.screen} edges={['top']}>
      <ScreenHeader title={tx("Privacy")} />
      <ScrollView contentContainerStyle={ui.content}>
        {isDemo ? <Note icon="sparkles">{tx("Demo account: settings are kept on this device only.")}</Note> : null}

        <Section title={tx("Messages")}>
          <ToggleRow
            icon="checkmark-done-outline"
            label={tx("Read receipts")}
            description={tx("Off: others only see that your messages were delivered, and you won't see when they read yours.")}
            value={settings.readReceipts}
            busy={busy === 'readReceipts'}
            onChange={(v) => void save('readReceipts', { readReceipts: v })}
          />
          <ToggleRow
            icon="create-outline"
            label={tx("Typing indicators")}
            description={tx("Off: nobody sees when you are typing.")}
            value={settings.typingIndicators}
            busy={busy === 'typingIndicators'}
            onChange={(v) => void save('typingIndicators', { typingIndicators: v })}
          />
        </Section>

        <Section title={tx("Default message timer")} footer={tx("New chats you start will have disappearing messages set to this timer.")}>
          {DEFAULT_DISAPPEARING_OPTIONS.map((o) => (
            <ChoiceRow
              key={o.seconds}
              label={o.label}
              selected={settings.defaultDisappearingSeconds === o.seconds}
              onPress={() => void save('timer', { defaultDisappearingSeconds: o.seconds })}
            />
          ))}
        </Section>

        <Section title={tx("Last seen")}>
          {LAST_SEEN_OPTIONS.map((o) => (
            <ChoiceRow
              key={o.value}
              label={o.label}
              description={o.description}
              selected={settings.lastSeen === o.value}
              onPress={() => void save('lastSeen', { lastSeen: o.value })}
            />
          ))}
        </Section>

        <Section title={tx("Online")}>
          <ToggleRow
            icon="radio-button-on-outline"
            label={tx("Show when I'm online")}
            description={tx("Only people you chat with can see it. Off: you won't see when others are online either.")}
            value={settings.showOnline}
            busy={busy === 'showOnline'}
            onChange={(v) => void save('showOnline', { showOnline: v })}
          />
        </Section>

        <Section title={tx("Notifications")} footer={pushNote ?? tx('Notifications never include message text.')}>
          <ToggleRow
            icon="notifications-outline"
            label={tx("Push notifications on this device")}
            value={settings.notifications}
            busy={busy === 'push'}
            onChange={(v) => void toggleNotifications(v)}
          />
          <ToggleRow
            icon="person-outline"
            label={tx("Show sender name")}
            description={tx('Off: notifications only say "New message".')}
            value={settings.notificationPreviews}
            busy={busy === 'previews'}
            onChange={(v) => void save('previews', { notificationPreviews: v })}
          />
        </Section>

        <Section
          title={tx("App lock")}
          footer={
            lockSupport && !lockSupport.available
              ? lockSupport.reason
              : tx('Require Face ID, fingerprint or your device passcode to open Vero. The app is hidden in the app switcher while locked.')
          }
        >
          <ToggleRow
            icon="lock-closed-outline"
            label={lockSupport?.available ? tx('Lock with {{method}}', { method: lockSupport.label }) : tx('App lock')}
            value={lock.enabled}
            disabled={!!lockSupport && !lockSupport.available && !lock.enabled}
            onChange={(v) => void toggleAppLock(v)}
          />
          {lock.enabled
            ? APP_LOCK_TIMEOUTS.map((t) => (
                <ChoiceRow
                  key={t.seconds}
                  label={t.label}
                  selected={lock.timeoutSeconds === t.seconds}
                  onPress={() => lock.setTimeoutSeconds(t.seconds)}
                />
              ))
            : null}
        </Section>
      </ScrollView>
    </SafeAreaView>
  );
}
