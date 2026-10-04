import { useEffect, useMemo } from 'react';
import { DarkTheme, DefaultTheme, Stack, ThemeProvider as NavThemeProvider, router } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { StyleSheet, View } from 'react-native';
import { useFonts } from 'expo-font';
import {
  BricolageGrotesque_600SemiBold,
  BricolageGrotesque_700Bold,
  BricolageGrotesque_800ExtraBold,
} from '@expo-google-fonts/bricolage-grotesque';
import { Geist_400Regular, Geist_500Medium, Geist_600SemiBold, Geist_700Bold } from '@expo-google-fonts/geist';
import { GeistMono_400Regular, GeistMono_500Medium } from '@expo-google-fonts/geist-mono';
import { useAuthStore } from '../src/features/auth/useAuthStore';
import { callService } from '../src/features/calls/CallService';
import { startInbox, useChatsStore } from '../src/features/chats/useChatsStore';
import { closeAllConversationChannels } from '../src/features/messages/useMessagesStore';
import { userChannel } from '../src/core/network/realtime';
import { ThemeProvider, useTheme } from '../src/shared/theme/ThemeProvider';
import { dark } from '../src/shared/theme/theme';
import '../src/shared/i18n';
import { AppLockGate } from '../src/features/settings/AppLockGate';
import { UpdateBanner } from '../src/features/updates/UpdateBanner';
import { useAccountServices } from '../src/features/settings/useAccountServices';

function ThemedStack() {
  const { c, isDark } = useTheme();

  // React Navigation's own theme drives card backgrounds and transitions between screens.
  const navTheme = useMemo(() => {
    const base = isDark ? DarkTheme : DefaultTheme;
    return {
      ...base,
      colors: { ...base.colors, primary: c.accent, background: c.bg, card: c.bg, text: c.text, border: c.line, notification: c.accent },
    };
  }, [c, isDark]);

  return (
    <NavThemeProvider value={navTheme}>
      <StatusBar style={isDark ? 'light' : 'dark'} />
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: c.bg },
          animation: 'slide_from_right',
          animationDuration: 280,
        }}
      >
        <Stack.Screen name="index" options={{ animation: 'none' }} />
        <Stack.Screen name="splash" options={{ animation: 'none' }} />
        <Stack.Screen name="(auth)" options={{ animation: 'fade' }} />
        <Stack.Screen name="(tabs)" options={{ animation: 'fade' }} />
        <Stack.Screen name="chat/[id]" />
        <Stack.Screen name="call/[id]" options={{ animation: 'fade_from_bottom', contentStyle: { backgroundColor: c.stage } }} />
        <Stack.Screen name="profile/[id]" />
        <Stack.Screen name="new-group" options={{ animation: 'slide_from_bottom' }} />
        <Stack.Screen name="verify-safety-number" />
        <Stack.Screen name="media-viewer" options={{ animation: 'fade', presentation: 'fullScreenModal', contentStyle: { backgroundColor: c.black } }} />
      </Stack>
    </NavThemeProvider>
  );
}

export default function RootLayout() {
  const initialize = useAuthStore((s) => s.initialize);
  const userId = useAuthStore((s) => s.user?.id);
  const deviceId = useAuthStore((s) => s.deviceId);
  const isDemo = useAuthStore((s) => s.isDemo);

  const [fontsLoaded, fontError] = useFonts({
    BricolageGrotesque_600SemiBold,
    BricolageGrotesque_700Bold,
    BricolageGrotesque_800ExtraBold,
    Geist_400Regular,
    Geist_500Medium,
    Geist_600SemiBold,
    Geist_700Bold,
    GeistMono_400Regular,
    GeistMono_500Medium,
  });

  useEffect(() => {
    void initialize();
  }, [initialize]);

  // Push, privacy settings, presence, mutes, backups (src/features/settings/useAccountServices.ts).
  useAccountServices(userId, deviceId, isDemo);

  // Per-session lifecycle: realtime inbox, incoming calls.
  useEffect(() => {
    if (!userId || !deviceId) return;
    let stopInbox: (() => void) | null = null;
    if (!isDemo) {
      void userChannel.start(userId);
      stopInbox = startInbox();
      callService.start();
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

  // Fonts are bundled, so this is a single frame — never a flash of system type.
  if (!fontsLoaded && !fontError) {
    return <View style={styles.boot} />;
  }

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <ThemeProvider>
        <AppLockGate>
          <ThemedStack />
          <UpdateBanner />
        </AppLockGate>
      </ThemeProvider>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  boot: { flex: 1, backgroundColor: dark.bg },
});
