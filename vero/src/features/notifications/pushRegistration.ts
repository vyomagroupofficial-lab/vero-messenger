/**
 * Push notifications on the device:
 *   - Android channels `messages` and `calls`, iOS/Android category `incoming_call`
 *   - registers this device's Expo push token (needs an EAS projectId; without
 *     one this is a logged no-op) so the `send-push` Edge Function can wake it
 *   - decides which notifications to show while the app is open
 *
 * Payloads never contain message content (supabase/functions/_shared/pushPayload.ts).
 */

import { Platform } from 'react-native';
import Constants from 'expo-constants';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import { supabase } from '../../core/network/supabase';
import { useChatsStore } from '../chats/useChatsStore';
import { shouldPresentInForeground } from './notificationRoutes';
import { isConversationMuted } from './useMuteStore';

export const INCOMING_CALL_CATEGORY = 'incoming_call';
export const CALL_ACTION_ANSWER = 'answer';
export const CALL_ACTION_DECLINE = 'decline';

const supported = Platform.OS !== 'web';

if (supported) {
  Notifications.setNotificationHandler({
    handleNotification: async (notification) => {
      const show = shouldPresentInForeground(notification.request.content.data, {
        openConversationId: useChatsStore.getState().openConversationId,
        isMuted: isConversationMuted,
      });
      return {
        shouldShowBanner: show,
        shouldShowList: show,
        shouldPlaySound: show,
        shouldSetBadge: false,
      };
    },
  });
}

let configured: Promise<void> | null = null;

/** Channels + categories. Safe to call repeatedly. */
export function configureNotifications(): Promise<void> {
  if (!supported) return Promise.resolve();
  if (!configured) {
    configured = (async () => {
      if (Platform.OS === 'android') {
        await Notifications.setNotificationChannelAsync('messages', {
          name: 'Messages',
          description: 'New messages. Never includes message content.',
          importance: Notifications.AndroidImportance.HIGH,
          lockscreenVisibility: Notifications.AndroidNotificationVisibility.PRIVATE,
          sound: 'default',
        });
        await Notifications.setNotificationChannelAsync('calls', {
          name: 'Calls',
          description: 'Incoming voice and video calls',
          importance: Notifications.AndroidImportance.MAX,
          lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
          sound: 'default',
          vibrationPattern: [0, 800, 400, 800],
          bypassDnd: false,
        });
      }
      await Notifications.setNotificationCategoryAsync(INCOMING_CALL_CATEGORY, [
        { identifier: CALL_ACTION_ANSWER, buttonTitle: 'Answer', options: { opensAppToForeground: true } },
        { identifier: CALL_ACTION_DECLINE, buttonTitle: 'Decline', options: { opensAppToForeground: true, isDestructive: true } },
      ]);
    })().catch((e) => {
      configured = null;
      console.warn('[Push] could not configure channels:', (e as Error)?.message);
    });
  }
  return configured;
}

export function easProjectId(): string | null {
  const id = Constants.expoConfig?.extra?.eas?.projectId ?? (Constants as any).easConfig?.projectId;
  return typeof id === 'string' && id.length > 0 ? id : null;
}

async function saveToken(deviceId: string, token: string): Promise<void> {
  const { error } = await supabase.from('push_tokens').upsert(
    { device_id: deviceId, token, platform: Platform.OS, updated_at: new Date().toISOString() },
    { onConflict: 'device_id' }
  );
  if (error) throw error;
}

let tokenSubscription: { remove: () => void } | null = null;

/**
 * Asks for permission (if needed) and registers the Expo push token for this
 * device. Returns a short status for the settings screen.
 */
export async function registerForPush(
  deviceId: string
): Promise<'registered' | 'unsupported' | 'no-project-id' | 'denied' | 'error'> {
  if (!supported || !Device.isDevice) return 'unsupported';
  try {
    await configureNotifications();
    const projectId = easProjectId();
    if (!projectId) {
      console.info('[Push] No EAS projectId configured (extra.eas.projectId); push notifications are disabled.');
      return 'no-project-id';
    }

    let { status } = await Notifications.getPermissionsAsync();
    if (status !== 'granted') status = (await Notifications.requestPermissionsAsync()).status;
    if (status !== 'granted') return 'denied';

    const { data: token } = await Notifications.getExpoPushTokenAsync({ projectId });
    await saveToken(deviceId, token);

    // The native token can rotate; re-register the Expo token when it does.
    tokenSubscription?.remove();
    tokenSubscription = Notifications.addPushTokenListener(() => {
      void Notifications.getExpoPushTokenAsync({ projectId })
        .then(({ data }) => saveToken(deviceId, data))
        .catch((e) => console.warn('[Push] token refresh failed:', (e as Error)?.message));
    });
    return 'registered';
  } catch (e) {
    console.warn('[Push] registration failed:', (e as Error)?.message);
    return 'error';
  }
}

export async function unregisterPush(deviceId: string): Promise<void> {
  tokenSubscription?.remove();
  tokenSubscription = null;
  const { error } = await supabase.from('push_tokens').delete().eq('device_id', deviceId);
  if (error) throw error;
}
