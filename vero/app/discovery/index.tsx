import React, { useState } from 'react';
import { View, Text, ScrollView, TouchableOpacity, StyleSheet, Alert, Platform, Linking } from 'react-native';
import { router } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useAuthStore } from '../../src/features/auth/useAuthStore';
import {
  ContactsPermissionError,
  ContactsUnavailableError,
  discoveryRepository,
} from '../../src/features/discovery/DiscoveryRepository';
import type { DiscoveredFriend } from '../../src/features/discovery/hashing';
import { conversationRepository } from '../../src/features/chats/ConversationRepository';
import { friendlyError } from '../../src/core/network/supabase';
import { Button, Card, Note, ProgressBar, ScreenHeader, ui } from '../../src/features/linking/ui';
import { Colors, Spacing, Typography } from '../../src/shared/theme/theme';

type Phase = 'intro' | 'reading' | 'matching' | 'results';

export default function FindFriendsScreen() {
  const me = useAuthStore((s) => s.user);
  const isDemo = useAuthStore((s) => s.isDemo);
  const [phase, setPhase] = useState<Phase>('intro');
  const [progress, setProgress] = useState<number | null>(null);
  const [friends, setFriends] = useState<DiscoveredFriend[]>([]);
  const [stats, setStats] = useState<{ checked: number; prefixesSent: number } | null>(null);
  const [opening, setOpening] = useState<string | null>(null);

  const run = async () => {
    try {
      setPhase('reading');
      const contacts = await discoveryRepository.readAddressBook();
      setPhase('matching');
      setProgress(0);
      const result = await discoveryRepository.findFriends(contacts, {
        myEmail: me?.email,
        onProgress: (done, total) => setProgress(done / total),
      });
      setFriends(result.friends);
      setStats({ checked: result.checked, prefixesSent: result.prefixesSent });
      setPhase('results');
    } catch (e) {
      setPhase('intro');
      if (e instanceof ContactsPermissionError) {
        Alert.alert(
          'Contacts access needed',
          e.canAskAgain ? 'Allow access to look for friends.' : 'Enable contacts access for Vero in your system settings.',
          e.canAskAgain ? undefined : [{ text: 'Cancel', style: 'cancel' }, { text: 'Open settings', onPress: () => void Linking.openSettings() }]
        );
      } else if (e instanceof ContactsUnavailableError) {
        Alert.alert('Not available here', e.message);
      } else {
        Alert.alert('Could not check contacts', friendlyError(e));
      }
    }
  };

  const message = async (f: DiscoveredFriend) => {
    setOpening(f.userId);
    try {
      const id = await conversationRepository.createDirectConversation(f.userId);
      router.push(`/chat/${id}`);
    } catch (e) {
      Alert.alert('Could not start chat', friendlyError(e));
    } finally {
      setOpening(null);
    }
  };

  const unavailable = Platform.OS === 'web';

  return (
    <SafeAreaView style={ui.screen} edges={['top']}>
      <ScreenHeader
        title="Find friends"
        right={
          <TouchableOpacity onPress={() => router.push('/discovery/settings')} accessibilityLabel="Discovery settings">
            <Ionicons name="options-outline" size={22} color={Colors.textPrimary} />
          </TouchableOpacity>
        }
      />
      <ScrollView contentContainerStyle={ui.content}>
        {isDemo ? (
          <Note icon="sparkles">Create an account to find friends from your contacts.</Note>
        ) : phase !== 'results' ? (
          <>
            <Card style={ui.center}>
              <Ionicons name="people-circle-outline" size={56} color={Colors.accent} />
              <Text style={ui.title}>See which contacts use Vero</Text>
              <Text style={ui.body}>Your address book never leaves this phone.</Text>
            </Card>

            <Card>
              <Text style={ui.label}>How it stays private</Text>
              {[
                ['phone-portrait-outline', 'Numbers and emails are normalised and hashed (SHA-256) on this phone.'],
                ['cut-outline', 'Only the first 4 characters of each hash are sent. Each one is shared by thousands of possible numbers, so Vero can\'t tell which contacts you have.'],
                ['git-compare-outline', 'The server returns everyone registered under those short prefixes; your phone keeps only exact matches.'],
                ['eye-off-outline', 'Only people who chose to be discoverable can be found. Nothing about your contacts is stored.'],
              ].map(([icon, text]) => (
                <View key={text} style={styles.row}>
                  <Ionicons name={icon as any} size={18} color={Colors.accentLight} />
                  <Text style={styles.rowText}>{text}</Text>
                </View>
              ))}
              <Text style={ui.muted}>
                Hashes of phone numbers can be guessed by brute force, which is why being discoverable is opt-in and
                lookups are rate-limited.
              </Text>
            </Card>

            {unavailable ? (
              <Note icon="desktop-outline" tone="warning">
                Contacts are only available in the mobile app. On a computer, use username search or a QR code.
              </Note>
            ) : (
              <Button
                label={phase === 'intro' ? 'Allow contacts & search' : phase === 'reading' ? 'Reading contacts…' : 'Matching…'}
                icon="search"
                onPress={run}
                loading={phase !== 'intro'}
              />
            )}
            {phase === 'matching' && <ProgressBar value={progress} />}
            <Button label="Let friends find me" variant="secondary" icon="eye-outline" onPress={() => router.push('/discovery/settings')} />
          </>
        ) : (
          <>
            <Text style={ui.body}>
              {friends.length
                ? `${friends.length} of your contacts ${friends.length === 1 ? 'is' : 'are'} on Vero.`
                : 'None of your contacts are discoverable on Vero yet. Invite them, or share your QR code.'}
            </Text>
            {stats && (
              <Text style={[ui.muted, { textAlign: 'center' }]}>
                Checked {stats.checked} numbers/emails by sending {stats.prefixesSent} short hash prefixes.
              </Text>
            )}
            {friends.map((f) => (
              <Card key={f.userId} style={styles.friend}>
                <View style={{ flex: 1 }}>
                  <Text style={ui.label}>{f.displayName}</Text>
                  <Text style={ui.muted}>
                    @{f.username} · in your contacts as {f.contactNames.join(', ')}
                  </Text>
                </View>
                <View style={{ width: 120 }}>
                  <Button label="Message" variant="secondary" onPress={() => void message(f)} loading={opening === f.userId} />
                </View>
              </Card>
            ))}
            <Button label="My QR code" variant="secondary" icon="qr-code-outline" onPress={() => router.push('/qr')} />
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', gap: Spacing.sm, alignItems: 'flex-start' },
  rowText: { flex: 1, fontSize: Typography.sm, color: Colors.textSecondary, lineHeight: 19 },
  friend: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md },
});
