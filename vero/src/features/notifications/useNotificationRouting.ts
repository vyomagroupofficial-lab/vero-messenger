/**
 * Opens the right screen when the user taps a notification - including the
 * one that launched the app from a cold start. Only routes once signed in.
 */

import { useEffect, useRef } from 'react';
import { Platform } from 'react-native';
import { router } from 'expo-router';
import * as Notifications from 'expo-notifications';
import { callService } from '../calls/CallService';
import { routeForNotification } from './notificationRoutes';

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
      if (data?.type === 'call') {
        // Answer / Decline / tap: the calls feature verifies the call and rings, answers or declines.
        void callService.handleNotificationResponse(response.actionIdentifier, data);
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
