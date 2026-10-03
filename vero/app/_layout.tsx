import { useEffect } from 'react';
import { Stack, router } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { StyleSheet, View, Platform } from 'react-native';
import { useAuthStore } from '../src/features/auth/useAuthStore';
import { callService } from '../src/features/calls/CallService';
import { startInbox, useChatsStore } from '../src/features/chats/useChatsStore';
import { closeAllConversationChannels } from '../src/features/messages/useMessagesStore';
import { userChannel } from '../src/core/network/realtime';
import { registerForPush } from '../src/features/notifications/pushRegistration';
import { useSettingsStore } from '../src/features/settings/useSettingsStore';
import { Colors } from '../src/shared/theme/theme';

export default function RootLayout() {
  const initialize = useAuthStore((s) => s.initialize);
  const userId = useAuthStore((s) => s.user?.id);
  const deviceId = useAuthStore((s) => s.deviceId);
  const isDemo = useAuthStore((s) => s.isDemo);

  useEffect(() => {
    void initialize();
  }, [initialize]);

  // Per-session lifecycle: realtime inbox, incoming calls, push registration.
  useEffect(() => {
    if (!userId || !deviceId) return;
    let stopInbox: (() => void) | null = null;
    if (!isDemo) {
      void userChannel.start(userId);
      stopInbox = startInbox();
      callService.start();
      if (useSettingsStore.getState().notifications) void registerForPush(deviceId);
    }
    const unsubscribeCalls = callService.subscribe((call) => {
      if (call && call.status === 'ringing' && !call.isInitiator) {
        router.push(`/call/${call.id}`);
      }
    });
    return () => {
      unsubscribeCalls();
      stopInbox?.();
      callService.stop();
      userChannel.stop();
      closeAllConversationChannels();
      useChatsStore.getState().reset();
    };
  }, [userId, deviceId, isDemo]);

  return (
    <GestureHandlerRootView style={styles.root}>
      <StatusBar style="light" />
      <View style={styles.appShell}>
        <Stack
          screenOptions={{
            headerShown: false,
            contentStyle: { backgroundColor: Colors.background },
            animation: 'slide_from_right',
          }}
        >
          <Stack.Screen name="index" options={{ animation: 'none' }} />
          <Stack.Screen name="splash" options={{ animation: 'none' }} />
          <Stack.Screen name="(auth)" options={{ animation: 'none' }} />
          <Stack.Screen name="(tabs)" options={{ animation: 'none' }} />
          <Stack.Screen name="chat/[id]" />
          <Stack.Screen name="call/[id]" />
          <Stack.Screen name="profile/[id]" />
          <Stack.Screen name="new-group" />
          <Stack.Screen name="verify-safety-number" />
          <Stack.Screen
            name="media-viewer"
            options={{ animation: 'fade', presentation: 'fullScreenModal' }}
          />
        </Stack>
      </View>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: '#02050D',
    justifyContent: 'center',
    alignItems: 'center',
  },
  appShell: {
    flex: 1,
    width: '100%',
    maxWidth: Platform.OS === 'web' ? 620 : undefined,
    height: '100%',
    backgroundColor: Colors.background,
    ...(Platform.OS === 'web'
      ? ({
          boxShadow: '0 0 80px rgba(6, 182, 212, 0.09), 0 0 1px rgba(255, 255, 255, 0.12)',
          borderLeftWidth: 1,
          borderRightWidth: 1,
          borderColor: 'rgba(255, 255, 255, 0.08)',
          overflow: 'hidden',
        } as any)
      : {}),
  },
});
