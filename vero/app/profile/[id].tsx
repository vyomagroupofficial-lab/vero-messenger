import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Platform, ScrollView, Share, Text, View } from 'react-native';
import Animated, { FadeIn, ZoomIn } from 'react-native-reanimated';
import { router, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Clipboard from 'expo-clipboard';
import { friendlyError } from '../../src/core/network/supabase';
import { useAuthStore } from '../../src/features/auth/useAuthStore';
import { useChatsStore } from '../../src/features/chats/useChatsStore';
import { DEMO_CONTACTS } from '../../src/features/demo/demoData';
import { conversationRepository } from '../../src/features/chats/ConversationRepository';
import { callService } from '../../src/features/calls/CallService';
import { databaseService } from '../../src/core/storage/DatabaseService';
import { makeStyles, useTheme } from '../../src/shared/theme/ThemeProvider';
import { useT } from '../../src/shared/i18n';
import { Avatar, Eyebrow, Grain, Hatch, Icon, IconButton, IconName, Pill, Pressy, Rise, Sheet, SheetRow, confirmAction, notify, useLayout } from '../../src/shared/ui';

function Item({ icon, label, hint, hintColor, onPress, right, first, danger }: {
  icon: IconName;
  label: string;
  hint?: string;
  hintColor?: string;
  onPress?: () => void;
  right?: React.ReactNode;
  first?: boolean;
  danger?: boolean;
}) {
  const { c, type } = useTheme();
  const s = useStyles();
  const body = (
    <View style={[s.item, !first && s.itemBorder]}>
      <View style={[s.itemIcon, danger && { backgroundColor: c.dangerTint }]}>
        <Icon name={icon} size={19} color={danger ? c.danger : c.accentText} />
      </View>
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={[s.itemLabel, danger && { color: c.danger }]}>{label}</Text>
        {hint ? <Text style={[type.caption, hintColor ? { color: hintColor } : null]}>{hint}</Text> : null}
      </View>
      {right ?? (onPress && !danger ? <Icon name="forwardChevron" size={18} color={c.faint} /> : null)}
    </View>
  );
  return onPress ? (
    <Pressy onPress={onPress} scaleTo={0.985} accessibilityLabel={label}>
      {body}
    </Pressy>
  ) : (
    body
  );
}

export default function ProfileScreen() {
  const insets = useSafeAreaInsets();
  const { isWide } = useLayout();
  const { c, type } = useTheme();
  const s = useStyles();
  const t = useT();
  const { id } = useLocalSearchParams<{ id: string }>();
  const isDemo = useAuthStore((st) => st.isDemo);
  const conversations = useChatsStore((st) => st.conversations);

  const [displayName, setDisplayName] = useState(t('profile.contact'));
  const [username, setUsername] = useState('');
  const [about, setAbout] = useState<string | null>(null);
  const [isVerified, setIsVerified] = useState(false);
  const [isBlocked, setIsBlocked] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [showReport, setShowReport] = useState(false);

  const directConversation = conversations.find((cv) => cv.otherUser?.id === id);

  useEffect(() => {
    let cancelled = false;
    async function loadProfile() {
      if (!id) return;
      try {
        const demo = DEMO_CONTACTS.find((u) => u.id === id);
        const profile = isDemo ? demo ?? null : await conversationRepository.getProfile(id);
        if (cancelled) return;
        if (profile) {
          setDisplayName(profile.displayName);
          setUsername(profile.username);
          setAbout(profile.about ?? null);
        }
        if (!isDemo) {
          const [verified, blocked] = await Promise.all([databaseService.getVerifiedSafetyNumber(id), conversationRepository.isBlocked(id)]);
          if (cancelled) return;
          setIsVerified(verified !== null);
          setIsBlocked(blocked);
        }
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }
    void loadProfile();
    return () => {
      cancelled = true;
    };
  }, [id, isDemo]);

  const handleStartChat = async () => {
    if (!id) return;
    if (directConversation) {
      router.push(`/chat/${directConversation.id}`);
      return;
    }
    if (isDemo) return notify(t('profile.demoTitle'), t('profile.demoBody'));
    try {
      const conversationId = await conversationRepository.createDirectConversation(id);
      router.push(`/chat/${conversationId}`);
    } catch (e) {
      notify(t('contacts.startFailed'), friendlyError(e));
    }
  };

  const handleStartCall = async (callType: 'voice' | 'video') => {
    if (!id) return;
    try {
      const conversationId = directConversation?.id ?? (isDemo ? null : await conversationRepository.createDirectConversation(id));
      if (!conversationId) return notify(t('profile.demoTitle'), t('profile.demoBody'));
      const callId = await callService.startCall({ conversationId, peerId: id, peerName: displayName, callType });
      router.push(`/call/${callId}`);
    } catch (e) {
      notify(t('calls.failed'), friendlyError(e));
    }
  };

  const handleOpenVerification = () => {
    if (!id) return;
    router.push({ pathname: '/verify-safety-number', params: { userId: id, displayName } });
  };

  const handleToggleBlock = () => {
    if (!id || isDemo) return notify(t('profile.demoTitle'), t('profile.demoBody'));
    if (isBlocked) {
      conversationRepository
        .unblockUser(id)
        .then(() => setIsBlocked(false))
        .catch((e) => notify(t('profile.unblockFailed'), friendlyError(e)));
      return;
    }
    confirmAction({
      title: t('profile.blockTitle'),
      message: t('profile.blockBody', { name: displayName }),
      confirmLabel: t('profile.blockConfirm'),
      destructive: true,
      onConfirm: () =>
        conversationRepository
          .blockUser(id)
          .then(() => setIsBlocked(true))
          .catch((e) => notify(t('profile.blockFailed'), friendlyError(e))),
    });
  };

  const submitReport = (reason: string) => {
    setShowReport(false);
    if (!id || isDemo) return;
    conversationRepository
      .reportUser(id, reason, directConversation?.id)
      .then(() => notify(t('profile.reportSent'), t('profile.reportSentBody')))
      .catch((e) => notify(t('profile.reportFailed'), friendlyError(e)));
  };

  const shareContact = async () => {
    const text = t('profile.shareText', { name: displayName, username });
    try {
      if (Platform.OS === 'web' && !(typeof navigator !== 'undefined' && 'share' in navigator)) throw new Error('no share');
      await Share.share({ message: text });
    } catch {
      await Clipboard.setStringAsync(text).catch(() => undefined);
      notify(t('settings.keys.copied'), text);
    }
  };

  const actions: [IconName, string, () => void][] = [
    ['chat', t('profile.message'), handleStartChat],
    ['phone', t('profile.voice'), () => handleStartCall('voice')],
    ['video', t('profile.video'), () => handleStartCall('video')],
  ];

  const hero = (
    <View style={[s.hero, isWide && s.heroWide]}>
      {isWide && <Hatch />}
      <Animated.View entering={ZoomIn.springify().damping(13)}>
        <Avatar name={displayName} size={isWide ? 148 : 120} ring />
      </Animated.View>
      <Animated.View entering={FadeIn.delay(100)} style={{ alignItems: 'center', gap: 4 }}>
        <Text style={[type.title, { fontSize: isWide ? 34 : 28, textAlign: 'center' }]}>{displayName}</Text>
        {username ? <Text style={s.handle}>@{username}</Text> : null}
      </Animated.View>
      {about ? (
        <Animated.Text entering={FadeIn.delay(160)} style={[type.body, { textAlign: 'center', color: c.muted, maxWidth: 360 }]}>
          {about}
        </Animated.Text>
      ) : null}
      <Animated.View entering={FadeIn.delay(200)} style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap', justifyContent: 'center' }}>
        {isVerified ? <Pill icon="shieldCheck" label={t('profile.verified')} /> : <Pill icon="shield" label={t('profile.notVerified')} tone="brass" />}
        {isBlocked && <Pill icon="ban" label={t('profile.blocked')} tone="ember" />}
      </Animated.View>
      <View style={s.actions}>
        {actions.map(([icon, label, fn], i) => (
          <Rise key={label} index={i} delay={150} style={{ flex: 1 }}>
            <Pressy onPress={fn} style={s.action} scaleTo={0.94} hoverStyle={{ backgroundColor: c.field }} accessibilityLabel={label}>
              <Icon name={icon} size={22} color={c.accentText} />
              <Text style={s.actionLabel}>{label}</Text>
            </Pressy>
          </Rise>
        ))}
      </View>
    </View>
  );

  const encryption = (
    <Rise index={1} style={{ gap: 8 }}>
      <Eyebrow style={{ paddingHorizontal: 4 }}>{t('profile.encryption')}</Eyebrow>
      <View style={s.panel}>
        <Item
          first
          icon="shieldCheck"
          label={t('profile.safetyNumber')}
          hint={isVerified ? t('profile.safetyVerifiedHint') : t('profile.safetyHint')}
          hintColor={isVerified ? c.success : undefined}
          onPress={handleOpenVerification}
        />
        <Item icon="lock" label={t('profile.cipher')} hint={t('profile.cipherHint')} right={<Pill label="256-bit" tone="sage" />} />
      </View>
    </Rise>
  );

  const privacy = (
    <Rise index={2} style={{ gap: 8 }}>
      <Eyebrow style={{ paddingHorizontal: 4 }}>{t('profile.privacy')}</Eyebrow>
      <View style={s.panel}>
        <Item
          first
          icon="ban"
          label={isBlocked ? t('profile.unblock', { name: displayName }) : t('profile.block', { name: displayName })}
          hint={isBlocked ? t('profile.blockedHint') : t('profile.blockHint')}
          danger
          onPress={handleToggleBlock}
        />
        <Item icon="flag" label={t('profile.report', { name: displayName })} hint={t('profile.reportHint')} danger onPress={() => (isDemo ? notify(t('profile.demoTitle'), t('profile.demoBody')) : setShowReport(true))} />
      </View>
    </Rise>
  );

  return (
    <View style={s.container}>
      <Grain />
      <View style={[s.top, { paddingTop: insets.top + 8 }]}>
        <IconButton icon="back" label={t('common.back')} onPress={() => (router.canGoBack() ? router.back() : router.replace('/(tabs)/chats'))} />
        {!!username && <IconButton icon="share" label={t('profile.share')} onPress={shareContact} />}
      </View>
      {isLoading ? (
        <ActivityIndicator size="large" color={c.accent} style={{ marginTop: 60 }} />
      ) : (
        <ScrollView contentContainerStyle={[s.scroll, { paddingBottom: insets.bottom + 40 }]} showsVerticalScrollIndicator={false}>
          {isWide ? (
            <View style={s.wideRow}>
              <View style={{ flex: 1, minWidth: 380 }}>{hero}</View>
              <View style={{ flex: 1.2, minWidth: 420, gap: 22 }}>
                {encryption}
                {privacy}
              </View>
            </View>
          ) : (
            <View style={{ gap: 20 }}>
              {hero}
              {encryption}
              {privacy}
            </View>
          )}
        </ScrollView>
      )}
      <Sheet visible={showReport} onClose={() => setShowReport(false)} title={t('profile.reportTitle')}>
        {(['spam', 'harassment', 'impersonation'] as const).map((r) => (
          <SheetRow key={r} icon="flag" tone="ember" label={t(`profile.reasons.${r}`)} onPress={() => submitReport(r)} />
        ))}
        <SheetRow icon="close" label={t('common.cancel')} onPress={() => setShowReport(false)} />
      </Sheet>
    </View>
  );
}

const useStyles = makeStyles((c, t, f) => ({
  container: { flex: 1, backgroundColor: c.bg },
  top: { flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: 8 },
  scroll: { paddingHorizontal: 16, maxWidth: 1180, width: '100%', alignSelf: 'center' },
  wideRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 22, paddingTop: 8 },
  hero: { alignItems: 'center', gap: 12, paddingBottom: 6 },
  heroWide: { padding: 32, paddingTop: 40, borderRadius: 26, backgroundColor: c.panel, borderWidth: 1, borderColor: c.line, overflow: 'hidden', gap: 16 },
  handle: { fontFamily: f.script === 'latin' ? f.mono : f.body, fontSize: 14, color: c.muted },
  actions: { flexDirection: 'row', gap: 8, width: '100%', marginTop: 8 },
  action: { height: 76, borderRadius: 18, backgroundColor: c.raised, borderWidth: 1, borderColor: c.line, alignItems: 'center', justifyContent: 'center', gap: 6 },
  actionLabel: { fontFamily: f.medium, fontSize: 12.5, color: c.text },
  panel: { backgroundColor: c.panel, borderRadius: 22, borderWidth: 1, borderColor: c.line, paddingHorizontal: 16, paddingVertical: 4 },
  item: { flexDirection: 'row', alignItems: 'center', gap: 14, minHeight: 62, paddingVertical: 8 },
  itemBorder: { borderTopWidth: 1, borderTopColor: c.line },
  itemIcon: { width: 38, height: 38, borderRadius: 12, backgroundColor: c.raised, alignItems: 'center', justifyContent: 'center' },
  itemLabel: { fontFamily: f.medium, fontSize: 15.5, color: c.text },
}));
