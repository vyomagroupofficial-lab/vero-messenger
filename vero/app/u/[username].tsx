import React, { useEffect, useState } from 'react';
import { Text, ScrollView, ActivityIndicator, Alert } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useAuthStore } from '../../src/features/auth/useAuthStore';
import { conversationRepository } from '../../src/features/chats/ConversationRepository';
import { resolveUsername, verifyContactFromQr } from '../../src/features/linking/profileQr';
import { FINGERPRINT_RE, USERNAME_RE } from '../../src/features/linking/qrPayloads';
import { friendlyError } from '../../src/core/network/supabase';
import { Button, Card, Note, ScreenHeader, ui } from '../../src/features/linking/ui';
import { Colors } from '../../src/shared/theme/theme';
import type { User } from '../../src/shared/models/Message';

/**
 * Target of vero://u/<username> deep links, https://<web>/u/<username> links
 * and scanned profile QR codes.
 */
export default function UserLinkScreen() {
  const params = useLocalSearchParams<{ username: string; fp?: string }>();
  const username = String(params.username || '').toLowerCase();
  const fingerprint = params.fp && FINGERPRINT_RE.test(String(params.fp)) ? String(params.fp) : null;
  const me = useAuthStore((s) => s.user);
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const isDemo = useAuthStore((s) => s.isDemo);
  const authLoading = useAuthStore((s) => s.isLoading);

  const [profile, setProfile] = useState<User | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (authLoading || !isAuthenticated || isDemo) return;
    if (!USERNAME_RE.test(username)) {
      setProfile(null);
      return;
    }
    let cancelled = false;
    resolveUsername(username)
      .then((p) => !cancelled && setProfile(p))
      .catch((e) => {
        if (cancelled) return;
        setError(friendlyError(e));
        setProfile(null);
      });
    return () => {
      cancelled = true;
    };
  }, [username, authLoading, isAuthenticated, isDemo]);

  const startChat = async () => {
    if (!profile || !me) return;
    if (profile.id === me.id) {
      router.replace('/qr');
      return;
    }
    setBusy(true);
    try {
      const conversationId = await conversationRepository.createDirectConversation(profile.id);
      if (fingerprint) {
        const result = await verifyContactFromQr(me.id, profile.id, fingerprint).catch(() => 'unavailable' as const);
        if (result === 'verified') {
          Alert.alert('Verified', `${profile.displayName}'s keys match their QR code. Your safety number is marked as verified.`);
        } else if (result === 'mismatch') {
          Alert.alert(
            'Keys do not match',
            `The keys Vero's server lists for ${profile.displayName} differ from the ones on their phone. They may have just added a device; if not, someone could be intercepting. Compare safety numbers in person before sharing anything sensitive.`
          );
        }
      }
      router.replace(`/chat/${conversationId}`);
    } catch (e) {
      Alert.alert('Could not start chat', friendlyError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <SafeAreaView style={ui.screen} edges={['top']}>
      <ScreenHeader title="Add contact" />
      <ScrollView contentContainerStyle={ui.content}>
        {authLoading ? (
          <ActivityIndicator color={Colors.accent} />
        ) : !isAuthenticated ? (
          <>
            <Note>Sign in to Vero to chat with @{username}.</Note>
            <Button label="Sign in" onPress={() => router.replace('/(auth)/login')} />
          </>
        ) : isDemo ? (
          <Note icon="sparkles">The offline demo can't add real contacts. Create an account to chat with @{username}.</Note>
        ) : profile === undefined ? (
          <ActivityIndicator color={Colors.accent} />
        ) : profile === null ? (
          <Note icon="alert-circle" tone="warning">{error || `No Vero user called @${username}.`}</Note>
        ) : (
          <>
            <Card style={ui.center}>
              <Text style={ui.title}>{profile.displayName}</Text>
              <Text style={ui.body}>@{profile.username}</Text>
              {profile.about ? <Text style={ui.muted}>{profile.about}</Text> : null}
            </Card>
            {fingerprint && (
              <Note icon="shield-checkmark" tone="success">
                This code includes a fingerprint of {profile.displayName}'s device keys. Vero checks it against the
                server's keys when you start the chat and marks your safety number verified if they match.
              </Note>
            )}
            <Button
              label={profile.id === me?.id ? 'This is you' : 'Message'}
              icon="chatbubble-ellipses"
              onPress={startChat}
              loading={busy}
            />
            {profile.id !== me?.id && (
              <Button label="View profile" variant="secondary" onPress={() => router.push(`/profile/${profile.id}`)} />
            )}
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}
