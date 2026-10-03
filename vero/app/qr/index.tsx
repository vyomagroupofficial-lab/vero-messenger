import React, { useEffect, useState } from 'react';
import { ActivityIndicator, ScrollView, Share, Text, View } from 'react-native';
import Animated, { FadeIn, ZoomIn } from 'react-native-reanimated';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Clipboard from 'expo-clipboard';
import { useAuthStore } from '../../src/features/auth/useAuthStore';
import { buildProfileQr, buildProfileWebLink } from '../../src/features/linking/qrPayloads';
import { fingerprintForUser } from '../../src/features/linking/profileQr';
import { QrCodeView } from '../../src/features/linking/QrCodeView';
import { Note, ScreenHeader, useLinkStyles } from '../../src/features/linking/ui';
import { makeStyles, useTheme } from '../../src/shared/theme/ThemeProvider';
import { useT } from '../../src/shared/i18n';
import { Avatar, Button, DotWall, Hatch } from '../../src/shared/ui';

const WEB_URL = process.env.EXPO_PUBLIC_WEB_URL || '';

export default function MyQrScreen() {
  const insets = useSafeAreaInsets();
  const { c, type } = useTheme();
  const ui = useLinkStyles();
  const s = useStyles();
  const t = useT();
  const user = useAuthStore((st) => st.user);
  const isDemo = useAuthStore((st) => st.isDemo);
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
      await Share.share({ message: t('qr.shareText', { link: shareLink }) });
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
    <View style={[ui.screen, { paddingTop: insets.top }]}>
      <ScreenHeader title={t('qr.title')} />
      <View style={{ flex: 1 }}>
        <DotWall />
        <ScrollView contentContainerStyle={[ui.content, { paddingBottom: insets.bottom + 40 }]}>
          {isDemo || !username ? (
            <Note icon="qr">{t('qr.demo')}</Note>
          ) : (
            <>
              <Animated.View entering={ZoomIn.springify().damping(15)} style={s.card}>
                <Hatch gap={12} />
                <View style={s.who}>
                  <Avatar name={user?.displayName || username} size={52} ring />
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text style={[type.name, { fontSize: 18 }]} numberOfLines={1}>
                      {user?.displayName}
                    </Text>
                    <Text style={s.handle}>@{username}</Text>
                  </View>
                </View>
                <View style={s.qrFrame}>{qr ? <QrCodeView value={qr} size={236} /> : <ActivityIndicator color={c.accent} style={{ height: 236, width: 236 }} />}</View>
                <Text style={[type.caption, { textAlign: 'center' }]}>{t('qr.scanHint')}</Text>
              </Animated.View>

              <Animated.View entering={FadeIn.delay(120)} style={{ gap: 12 }}>
                <Note icon="shieldCheck" tone="success">
                  {fingerprint ? t('qr.fingerprintNote') : t('qr.plainNote')}
                </Note>
                <Button label={t('qr.scan')} icon="scan" onPress={() => router.push('/qr/scan')} />
                <View style={{ flexDirection: 'row', gap: 10 }}>
                  <Button label={t('qr.shareLink')} icon="share" variant="secondary" onPress={share} style={{ flex: 1 }} />
                  <Button label={copied ? t('verify.copied') : t('qr.copyLink')} icon={copied ? 'check' : 'copy'} variant="secondary" onPress={copy} style={{ flex: 1 }} />
                </View>
                <Text style={[type.mono, { fontSize: 12, color: c.faint, textAlign: 'center' }]} selectable>
                  {shareLink}
                </Text>
              </Animated.View>
            </>
          )}
        </ScrollView>
      </View>
    </View>
  );
}

const useStyles = makeStyles((c, t, f) => ({
  card: { alignItems: 'center', gap: 18, padding: 22, borderRadius: 30, backgroundColor: c.panel, borderWidth: 1, borderColor: c.line, overflow: 'hidden' },
  who: { flexDirection: 'row', alignItems: 'center', gap: 12, alignSelf: 'stretch' },
  handle: { fontFamily: f.script === 'latin' ? f.mono : f.body, fontSize: 13, color: c.muted },
  qrFrame: { padding: 14, borderRadius: 24, backgroundColor: '#FFFFFF', borderWidth: 3, borderColor: c.accent },
}));
