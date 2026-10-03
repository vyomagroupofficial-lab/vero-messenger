import { useEffect } from 'react';
import { Stack, router } from 'expo-router';
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
import { Colors } from '../src/shared/theme/theme';

export default function RootLayout() {
  const { initialize, isAuthenticated, user } = useAuthStore();
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
    initialize();
  }, []);

  useEffect(() => {
    if (isAuthenticated && user?.id) {
      callService.listenForIncomingCalls(user.id);
      const unsub = callService.subscribe((activeCall) => {
        if (activeCall && activeCall.status === 'ringing' && !activeCall.isInitiator) {
          router.push(`/call/${activeCall.id}` as any);
        }
      });
      return () => unsub();
    }
  }, [isAuthenticated, user?.id]);

  // Fonts are bundled, so this is a single frame of ink — never a flash of system type.
  if (!fontsLoaded && !fontError) {
    return <View style={styles.root} />;
  }

  return (
    <GestureHandlerRootView style={styles.root}>
      <StatusBar style="light" />
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: Colors.ink },
          animation: 'slide_from_right',
          animationDuration: 280,
        }}
      >
        <Stack.Screen name="index" options={{ animation: 'none' }} />
        <Stack.Screen name="splash" options={{ animation: 'none' }} />
        <Stack.Screen name="(auth)" options={{ animation: 'fade' }} />
        <Stack.Screen name="(tabs)" options={{ animation: 'fade' }} />
        <Stack.Screen name="chat/[id]" />
        <Stack.Screen name="call/[id]" options={{ animation: 'fade_from_bottom' }} />
        <Stack.Screen name="profile/[id]" />
        <Stack.Screen name="new-group" options={{ animation: 'slide_from_bottom' }} />
        <Stack.Screen name="verify-safety-number" />
        <Stack.Screen name="media-viewer" options={{ animation: 'fade', presentation: 'fullScreenModal' }} />
      </Stack>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: Colors.ink },
});
