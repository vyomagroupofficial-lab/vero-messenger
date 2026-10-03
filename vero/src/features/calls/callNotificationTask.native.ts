/**
 * Background handler for the incoming-call notification's Decline button
 * (Android runs it even when the app was closed). Imported from the app entry
 * (index.ts) so the task is defined before expo-task-manager needs it.
 *
 * Kept tiny on purpose: it runs headless, without the UI.
 */

import * as TaskManager from 'expo-task-manager';
import * as Notifications from 'expo-notifications';
import { supabase, isSupabaseConfigured } from '../../core/network/supabase';
import { CALL_ACTION_DECLINE, parseCallPushData } from './callNotifications';

export const CALL_NOTIFICATION_TASK = 'vero-call-notification-actions';

TaskManager.defineTask<Notifications.NotificationTaskPayload>(CALL_NOTIFICATION_TASK, async ({ data, error }) => {
  if (error || !data || !('actionIdentifier' in data)) return Notifications.BackgroundNotificationTaskResult.NoData;
  if (data.actionIdentifier !== CALL_ACTION_DECLINE) return Notifications.BackgroundNotificationTaskResult.NoData;
  const call = parseCallPushData(data.notification.request.content.data);
  if (!call) return Notifications.BackgroundNotificationTaskResult.NoData;
  try {
    await Notifications.dismissNotificationAsync(data.notification.request.identifier);
    // Group invites need no server call: declining just stops the ringing here.
    if (!call.isGroup && isSupabaseConfigured) {
      await supabase.rpc('update_call_status', { p_call_id: call.callId, p_status: 'rejected' });
    }
    return Notifications.BackgroundNotificationTaskResult.NewData;
  } catch {
    return Notifications.BackgroundNotificationTaskResult.Failed;
  }
});

let registered = false;

export async function registerCallNotificationTask(): Promise<void> {
  if (registered) return;
  registered = true;
  try {
    await Notifications.registerTaskAsync(CALL_NOTIFICATION_TASK);
  } catch (e) {
    registered = false;
    console.info('[Calls] background notification task unavailable:', (e as Error)?.message);
  }
}
