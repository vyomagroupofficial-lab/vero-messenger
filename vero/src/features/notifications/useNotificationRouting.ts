/**
 * Opens the right screen when the user taps a notification - including the
 * one that launched the app from a cold start. Only routes once signed in.
 */

import { useEffect, useRef } from 'react';
import { Platform } from 'react-native';
import { router } from 'expo-router';
import * as Notifications from 'expo-notifications';
import { supabase } from '../../core/network/supabase';
import { routeForNotification } from './notificationRoutes';
import { CALL_ACTION_DECLINE } from './pushRegistration';

export function useNotificationRouting(signedIn: boolean): void {
  const handled = useRef(new Set<string>());

  useEffect(() => {
    if (!signedIn || Platform.OS === 'web') return;

    const open = (response: Notifications.NotificationResponse | null) => {
      if (!response) return;
      const id = response.notification.request.identifier;
      if (handled.current.has(id)) return;
      handled.current.add(id);
      const data = response.notification.request.content.data as Record<string, unknown> | undefined;
      if (response.actionIdentifier === CALL_ACTION_DECLINE && data?.type === 'call' && typeof data.callId === 'string') {
        void supabase
          .rpc('update_call_status', { p_call_id: data.callId, p_status: 'rejected' })
          .then(({ error }) => error && console.warn('[Push] decline failed:', error.message));
        return;
      }
      const route = routeForNotification(data);
      if (route) router.push(route as any);
    };

    // Cold start: the tap that launched the app.
    void Notifications.getLastNotificationResponseAsync()
      .then((r) => {
        open(r);
        return Notifications.clearLastNotificationResponseAsync();
      })
      .catch(() => undefined);

    const sub = Notifications.addNotificationResponseReceivedListener(open);
    return () => sub.remove();
  }, [signedIn]);
}
