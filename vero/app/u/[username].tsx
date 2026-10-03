import React, { useEffect, useState } from 'react';
import { ActivityIndicator, ScrollView, Text, View } from 'react-native';
import Animated, { FadeIn, ZoomIn } from 'react-native-reanimated';
import { router, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAuthStore } from '../../src/features/auth/useAuthStore';
import { conversationRepository } from '../../src/features/chats/ConversationRepository';
import { resolveUsername, verifyContactFromQr } from '../../src/features/linking/profileQr';
import { FINGERPRINT_RE, USERNAME_RE } from '../../src/features/linking/qrPayloads';
import { friendlyError } from '../../src/core/network/supabase';
import { Note, ScreenHeader, useLinkStyles } from '../../src/features/linking/ui';
import { makeStyles, useTheme } from '../../src/shared/theme/ThemeProvider';
import { useT } from '../../src/shared/i18n';
import { Avatar, Button, DotWall, Pill, Ripple, notify } from '../../src/shared/ui';
import type { User } from '../../src/shared/models/Message';

/**
 * Target of vero://u/<username> deep links, https://<web>/u/<username> links
 * and scanned profile QR codes.
 */
export default function UserLinkScreen() {
  const params = useLocalSearchParams<{ username: string; fp?: string }>();
  const username = String(params.username || '').toLowerCase();
  const fingerprint = params.fp && FINGERPRINT_RE.test(String(params.fp)) ? String(params.fp) : null;
  const insets = useSafeAreaInsets();
  const { c, type } = useTheme();
  const ui = useLinkStyles();
  const s = useStyles();
  const t = useT();
  const me = useAuthStore((st) => st.user);
  const isAuthenticated = useAuthStore((st) => st.isAuthenticated);
  const isDemo = useAuthStore((st) => st.isDemo);
  const authLoading = useAuthStore((st) => st.isLoading);

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
        if (result === 'verified') notify(t('verify.states.verified'), t('ulink.verifiedBody', { name: profile.displayName }));
        else if (result === 'mismatch') notify(t('ulink.mismatch'), t('ulink.mismatchBody', { name: profile.displayName }));
      }
      router.replace(`/chat/${conversationId}`);
    } catch (e) {
      notify(t('contacts.startFailed'), friendlyError(e));
    } finally {
      setBusy(false);
    }
  };

  let body: React.ReactNode;
  if (authLoading || (isAuthenticated && !isDemo && profile === undefined)) body = <ActivityIndicator color={c.accent} style={{ marginTop: 40 }} />;
  else if (!isAuthenticated)
    body = (
      <>
        <Note>{t('ulink.signIn', { username })}</Note>
        <Button label={t('auth.signIn')} iconRight="arrowRight" onPress={() => router.replace('/(auth)/login')} />
      </>
    );
  else if (isDemo) body = <Note icon="info">{t('ulink.demo', { username })}</Note>;
  else if (profile === null)
    body = (
      <Note icon="info" tone="warning">
        {error || t('ulink.notFound', { username })}
      </Note>
    );
  else if (profile)
    body = (
      <>
        <Animated.View entering={FadeIn} style={s.card}>
          <Animated.View entering={ZoomIn.springify().damping(14)}>
            <Ripple size={108} color={c.accentLine}>
              <Avatar name={profile.displayName} size={108} />
            </Ripple>
          </Animated.View>
          <View style={{ alignItems: 'center', gap: 4 }}>
            <Text style={ui.title}>{profile.displayName}</Text>
            <Text style={s.handle}>@{profile.username}</Text>
          </View>
          {profile.about ? <Text style={[type.body, { color: c.muted, textAlign: 'center' }]}>{profile.about}</Text> : null}
          {fingerprint && <Pill icon="shieldCheck" label={t('ulink.hasFingerprint')} />}
        </Animated.View>
        {fingerprint && (
          <Note icon="shieldCheck" tone="success">
            {t('ulink.fingerprintNote', { name: profile.displayName })}
          </Note>
        )}
        <Button label={profile.id === me?.id ? t('ulink.thisIsYou') : t('profile.message')} icon="chat" onPress={startChat} loading={busy} />
        {profile.id !== me?.id && <Button label={t('thread.viewProfile')} variant="secondary" onPress={() => router.push(`/profile/${profile.id}`)} />}
      </>
    );

  return (
    <View style={[ui.screen, { paddingTop: insets.top }]}>
      <ScreenHeader title={t('ulink.title')} />
      <View style={{ flex: 1 }}>
        <DotWall />
        <ScrollView contentContainerStyle={[ui.content, { paddingBottom: insets.bottom + 40 }]}>{body}</ScrollView>
      </View>
    </View>
  );
}

const useStyles = makeStyles((c, t, f) => ({
  card: { alignItems: 'center', gap: 16, padding: 26, borderRadius: 28, backgroundColor: c.panel, borderWidth: 1, borderColor: c.line },
  handle: { fontFamily: f.script === 'latin' ? f.mono : f.body, fontSize: 14, color: c.muted },
}));
