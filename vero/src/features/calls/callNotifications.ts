/**
 * Incoming-call notifications (sent by the `call-push` Edge Function when the
 * app is in the background or closed).
 *
 *   category `incoming_call`: Accept (opens the app and answers) / Decline
 *   Android channel `calls`: max importance, ringtone sound, vibration
 *
 * Decline without opening the app:
 *   - Android: handled by the background task in callNotificationTask.native.ts
 *     (expo-notifications runs it for action taps even when the app was killed).
 *   - iOS: delivered to the response listener below when iOS wakes the app; if
 *     it doesn't, the caller's 45 s ring timeout ends the call as missed.
 * Real lock-screen call UI needs CallKit (iOS) / ConnectionService (Android):
 * see README "Calls" (future upgrade).
 */

import { Platform } from 'react-native';
import * as Notifications from 'expo-notifications';

export const CALL_CATEGORY = 'incoming_call';
export const CALL_CHANNEL = 'calls';
export const CALL_ACTION_ACCEPT = 'accept';
export const CALL_ACTION_DECLINE = 'decline';

export interface CallPushData {
  callId: string;
  conversationId: string;
  callType: 'voice' | 'video';
  isGroup: boolean;
  groupName: string | null;
  callerId: string;
  callerDeviceId: string | null;
  callerName: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Validates the (untrusted) data of a call push. */
export function parseCallPushData(data: unknown): CallPushData | null {
  const d = data as Record<string, unknown> | null;
  if (!d || d.type !== 'call') return null;
  const callId = String(d.callId ?? '');
  const conversationId = String(d.conversationId ?? '');
  const callerId = String(d.callerId ?? '');
  if (!UUID.test(callId) || !UUID.test(conversationId) || !UUID.test(callerId)) return null;
  const callerDeviceId = typeof d.callerDeviceId === 'string' && UUID.test(d.callerDeviceId) ? d.callerDeviceId : null;
  return {
    callId,
    conversationId,
    callType: d.callType === 'video' ? 'video' : 'voice',
    isGroup: d.isGroup === true,
    groupName: typeof d.groupName === 'string' ? d.groupName.slice(0, 64) : null,
    callerId,
    callerDeviceId,
    callerName: typeof d.callerName === 'string' && d.callerName ? d.callerName.slice(0, 64) : 'Unknown caller',
  };
}

let setupDone = false;

/** Registers the Accept/Decline category and the `calls` channel. Safe to call repeatedly. */
export async function setupCallNotifications(): Promise<void> {
  if (setupDone || Platform.OS === 'web') return;
  setupDone = true;
  try {
    await Notifications.setNotificationCategoryAsync(CALL_CATEGORY, [
      {
        identifier: CALL_ACTION_ACCEPT,
        buttonTitle: 'Accept',
        options: { opensAppToForeground: true },
      },
      {
        identifier: CALL_ACTION_DECLINE,
        buttonTitle: 'Decline',
        options: { opensAppToForeground: false, isDestructive: true },
      },
    ]);
    if (Platform.OS === 'android') {
      await Notifications.setNotificationChannelAsync(CALL_CHANNEL, {
        name: 'Calls',
        description: 'Incoming voice and video calls',
        importance: Notifications.AndroidImportance.MAX,
        sound: 'default',
        vibrationPattern: [0, 800, 1200, 800, 1200],
        lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
        enableVibrate: true,
      });
    }
  } catch (e) {
    setupDone = false;
    console.warn('[Calls] notification setup failed:', (e as Error)?.message);
  }
}

export type CallNotificationAction = 'accept' | 'decline' | 'open';

export interface CallNotificationResponse {
  action: CallNotificationAction;
  data: CallPushData;
  notificationId: string;
}

function toCallResponse(response: Notifications.NotificationResponse | null): CallNotificationResponse | null {
  if (!response) return null;
  const data = parseCallPushData(response.notification.request.content.data);
  if (!data) return null;
  const id = response.actionIdentifier;
  const action: CallNotificationAction =
    id === CALL_ACTION_ACCEPT ? 'accept' : id === CALL_ACTION_DECLINE ? 'decline' : 'open';
  return { action, data, notificationId: response.notification.request.identifier };
}

/**
 * Calls `handler` for taps on call notifications, including the one that
 * launched the app. Returns an unsubscribe function.
 */
export function listenForCallNotificationResponses(handler: (r: CallNotificationResponse) => void): () => void {
  if (Platform.OS === 'web') return () => {};
  const seen = new Set<string>();
  const deliver = (response: Notifications.NotificationResponse | null) => {
    const r = toCallResponse(response);
    if (!r) return;
    const key = `${r.notificationId}|${r.action}`;
    if (seen.has(key)) return;
    seen.add(key);
    handler(r);
  };
  const sub = Notifications.addNotificationResponseReceivedListener(deliver);
  void Notifications.getLastNotificationResponseAsync()
    .then((last) => {
      // Only a recent tap (the ring lasts 45 s) should answer a call.
      const sentAt = last?.notification?.date ?? 0;
      if (last && Date.now() - sentAt < 60_000) deliver(last);
    })
    .catch(() => {});
  return () => sub.remove();
}

/** Removes the incoming-call notification(s) of a call (answered, declined, ended). */
export async function dismissCallNotifications(callId: string): Promise<void> {
  if (Platform.OS === 'web') return;
  try {
    const presented = await Notifications.getPresentedNotificationsAsync();
    await Promise.all(
      presented
        .filter((n) => parseCallPushData(n.request.content.data)?.callId === callId)
        .map((n) => Notifications.dismissNotificationAsync(n.request.identifier))
    );
  } catch {
    // best effort
  }
}
