/**
 * Incoming-call push notifications, call side.
 *
 * The push stack (src/features/notifications, send-push, 005) owns the
 * Android channel `calls`, the category `incoming_call` (Answer / Decline)
 * and the tap listener; for `type: 'call'` it hands the response to
 * callService.handleNotificationResponse(). Pushes are sent by send-push using
 * get_call_push_targets (extended for group calls in 090_cross_feature_wiring).
 *
 * The push payload is never trusted: CallService re-reads the call from the
 * server (RLS) before ringing or answering.
 *
 * Real lock-screen call UI needs CallKit (iOS) / ConnectionService (Android):
 * see README "Calls" (future upgrade).
 */

import { Platform } from 'react-native';
import * as Notifications from 'expo-notifications';

/** Matches CALL_ACTION_ANSWER / CALL_ACTION_DECLINE in notifications/pushRegistration.ts. */
export const CALL_ACTION_ANSWER = 'answer';
export const CALL_ACTION_DECLINE = 'decline';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The call id of a call push (`data: { type: 'call', callId, ... }`), or null. */
export function callIdFromPushData(data: unknown): string | null {
  const d = data as Record<string, unknown> | null | undefined;
  if (!d || d.type !== 'call') return null;
  const id = String(d.callId ?? d.call_id ?? '');
  return UUID.test(id) ? id : null;
}

export type CallNotificationAction = 'answer' | 'decline' | 'open';

export function callNotificationAction(actionIdentifier: string): CallNotificationAction {
  if (actionIdentifier === CALL_ACTION_ANSWER) return 'answer';
  if (actionIdentifier === CALL_ACTION_DECLINE) return 'decline';
  return 'open';
}

/** Removes the incoming-call notification(s) of a call (answered, declined, ended). */
export async function dismissCallNotifications(callId: string): Promise<void> {
  if (Platform.OS === 'web') return;
  try {
    const presented = await Notifications.getPresentedNotificationsAsync();
    await Promise.all(
      presented
        .filter((n) => callIdFromPushData(n.request.content.data) === callId)
        .map((n) => Notifications.dismissNotificationAsync(n.request.identifier))
    );
  } catch {
    // best effort
  }
}
