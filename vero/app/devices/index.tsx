import React from 'react';
import { View, Text, ScrollView, TouchableOpacity, StyleSheet } from 'react-native';
import { router } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useAuthStore } from '../../src/features/auth/useAuthStore';
import { Note, ScreenHeader, ui } from '../../src/features/linking/ui';
import { Colors, Spacing, Typography, BorderRadius } from '../../src/shared/theme/theme';

const ITEMS: { icon: keyof typeof Ionicons.glyphMap; title: string; desc: string; go: () => void }[] = [
  {
    icon: 'desktop-outline',
    title: 'Link a device',
    desc: 'Scan the QR code shown by Vero on the web or desktop. It gets its own keys and your recent chats.',
    go: () => router.push({ pathname: '/qr/scan', params: { expect: 'link' } }),
  },
  {
    icon: 'arrow-redo-outline',
    title: 'Transfer chats to a new phone',
    desc: 'Use this on your OLD phone: scan the code on the new phone to send your full chat history, encrypted.',
    go: () => router.push({ pathname: '/qr/scan', params: { expect: 'transfer' } }),
  },
  {
    icon: 'arrow-undo-outline',
    title: 'Receive chats from old phone',
    desc: 'Use this on your NEW phone after signing in: shows a code for your old phone to scan.',
    go: () => router.push('/devices/receive-transfer'),
  },
];

export default function DevicesHubScreen() {
  const isDemo = useAuthStore((s) => s.isDemo);
  return (
    <SafeAreaView style={ui.screen} edges={['top']}>
      <ScreenHeader title="Devices & transfer" />
      <ScrollView contentContainerStyle={ui.content}>
        {isDemo ? (
          <Note icon="sparkles">Linking devices needs a real account.</Note>
        ) : (
          ITEMS.map((item) => (
            <TouchableOpacity key={item.title} style={styles.item} onPress={item.go} activeOpacity={0.8}>
              <View style={styles.icon}>
                <Ionicons name={item.icon} size={22} color={Colors.accent} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={ui.label}>{item.title}</Text>
                <Text style={styles.desc}>{item.desc}</Text>
              </View>
              <Ionicons name="chevron-forward" size={18} color={Colors.textTertiary} />
            </TouchableOpacity>
          ))
        )}
        <Note icon="key-outline">
          Private keys never leave a device. Every device registers its own keys, so your contacts will see that your
          safety number changed after you add one - that is expected.
        </Note>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  item: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    padding: Spacing.lg,
    backgroundColor: Colors.surface,
    borderRadius: BorderRadius.xl,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  icon: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: Colors.accentSubtle,
    alignItems: 'center',
    justifyContent: 'center',
  },
  desc: { fontSize: Typography.xs, color: Colors.textSecondary, marginTop: 2, lineHeight: 17 },
});
