import React, { useEffect, useState } from 'react';
import { View, Text, ScrollView, Share, ActivityIndicator } from 'react-native';
import { router } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as Clipboard from 'expo-clipboard';
import { useAuthStore } from '../../src/features/auth/useAuthStore';
import { buildProfileQr, buildProfileWebLink } from '../../src/features/linking/qrPayloads';
import { fingerprintForUser } from '../../src/features/linking/profileQr';
import { QrCodeView } from '../../src/features/linking/QrCodeView';
import { Button, Card, Note, ScreenHeader, ui } from '../../src/features/linking/ui';
import { Colors } from '../../src/shared/theme/theme';

const WEB_URL = process.env.EXPO_PUBLIC_WEB_URL || '';

export default function MyQrScreen() {
  const user = useAuthStore((s) => s.user);
  const isDemo = useAuthStore((s) => s.isDemo);
  const [fingerprint, setFingerprint] = useState<string | null | undefined>(undefined);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!user || isDemo) return;
    let cancelled = false;
    fingerprintForUser(user.id)
      .then((fp) => !cancelled && setFingerprint(fp))
      .catch(() => !cancelled && setFingerprint(null));
    return () => {
      cancelled = true;
    };
  }, [user?.id, isDemo]);

  const username = user?.username;
  const qr = username && fingerprint !== undefined ? buildProfileQr(username, fingerprint) : null;
  const shareLink = username ? (WEB_URL ? buildProfileWebLink(WEB_URL, username) : buildProfileQr(username)) : '';

  const share = async () => {
    try {
      await Share.share({ message: `Chat with me privately on Vero: ${shareLink}` });
    } catch {
      // dismissed
    }
  };

  const copy = async () => {
    await Clipboard.setStringAsync(shareLink);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <SafeAreaView style={ui.screen} edges={['top']}>
      <ScreenHeader title="My QR code" />
      <ScrollView contentContainerStyle={ui.content}>
        {isDemo || !username ? (
          <Note icon="sparkles">Sign in with a real account to get your personal QR code.</Note>
        ) : (
          <>
            <Card style={ui.center}>
              {qr ? <QrCodeView value={qr} size={240} /> : <ActivityIndicator color={Colors.accent} style={{ height: 240 }} />}
              <Text style={ui.title}>{user?.displayName}</Text>
              <Text style={ui.body}>@{username}</Text>
            </Card>

            <Note icon="shield-checkmark" tone="success">
              {fingerprint
                ? 'This code also carries a fingerprint of your device keys. When a friend scans it in person, Vero verifies your safety number automatically.'
                : 'People who scan this code can find you and start an end-to-end encrypted chat.'}
            </Note>

            <Button label="Scan a code" icon="scan-outline" onPress={() => router.push('/qr/scan')} />
            <View style={{ flexDirection: 'row', gap: 12 }}>
              <View style={{ flex: 1 }}>
                <Button label="Share link" icon="share-outline" variant="secondary" onPress={share} />
              </View>
              <View style={{ flex: 1 }}>
                <Button label={copied ? 'Copied' : 'Copy link'} icon={copied ? 'checkmark' : 'copy-outline'} variant="secondary" onPress={copy} />
              </View>
            </View>
            <Text style={[ui.muted, { textAlign: 'center' }]}>{shareLink}</Text>
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}
