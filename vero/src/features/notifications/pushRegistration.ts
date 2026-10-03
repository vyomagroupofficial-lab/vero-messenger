/**
 * Registers this device's Expo push token so the `send-push` Edge Function
 * can wake it. Push payloads never contain message content (see function).
 */

import { Platform } from 'react-native';
import Constants from 'expo-constants';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import { supabase } from '../../core/network/supabase';

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

export async function registerForPush(deviceId: string): Promise<void> {
  if (Platform.OS === 'web' || !Device.isDevice) return;
  try {
    const projectId =
      Constants.expoConfig?.extra?.eas?.projectId ?? (Constants as any).easConfig?.projectId;
    if (!projectId) {
      console.info('[Push] No EAS projectId configured; skipping push registration.');
      return;
    }

    if (Platform.OS === 'android') {
      await Notifications.setNotificationChannelAsync('messages', {
        name: 'Messages',
        importance: Notifications.AndroidImportance.HIGH,
      });
    }

    let { status } = await Notifications.getPermissionsAsync();
    if (status !== 'granted') status = (await Notifications.requestPermissionsAsync()).status;
    if (status !== 'granted') return;

    const { data: token } = await Notifications.getExpoPushTokenAsync({ projectId });
    await supabase.from('push_tokens').upsert(
      { device_id: deviceId, token, platform: Platform.OS, updated_at: new Date().toISOString() },
      { onConflict: 'device_id' }
    );
  } catch (e) {
    console.warn('[Push] registration failed:', (e as Error)?.message);
  }
}

export async function unregisterPush(deviceId: string): Promise<void> {
  await supabase.from('push_tokens').delete().eq('device_id', deviceId);
}
