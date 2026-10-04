import React, { useState } from 'react';
import { Linking, Platform, ScrollView, Text, View } from 'react-native';
import Animated, { FadeIn, FadeInDown } from 'react-native-reanimated';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAuthStore } from '../../src/features/auth/useAuthStore';
import { ContactsPermissionError, ContactsUnavailableError, discoveryRepository } from '../../src/features/discovery/DiscoveryRepository';
import type { DiscoveredFriend } from '../../src/features/discovery/hashing';
import { conversationRepository } from '../../src/features/chats/ConversationRepository';
import { friendlyError } from '../../src/core/network/supabase';
import { Card, FlowCard, Note, ProgressBar, ScreenHeader, useLinkStyles } from '../../src/features/linking/ui';
import { makeStyles, useTheme } from '../../src/shared/theme/ThemeProvider';
import { useT } from '../../src/shared/i18n';
import { Avatar, Button, Icon, IconButton, IconName, Rise, confirmAction, notify } from '../../src/shared/ui';

type Phase = 'intro' | 'reading' | 'matching' | 'results';

export default function FindFriendsScreen() {
  const insets = useSafeAreaInsets();
  const { c, type } = useTheme();
  const ui = useLinkStyles();
  const s = useStyles();
  const t = useT();
  const me = useAuthStore((st) => st.user);
  const isDemo = useAuthStore((st) => st.isDemo);
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
      const result = await discoveryRepository.findFriends(contacts, { myEmail: me?.email, onProgress: (done, total) => setProgress(done / total) });
      setFriends(result.friends);
      setStats({ checked: result.checked, prefixesSent: result.prefixesSent });
      setPhase('results');
    } catch (e) {
      setPhase('intro');
      if (e instanceof ContactsPermissionError) {
        if (e.canAskAgain) notify(t('discovery.permissionTitle'), t('discovery.permissionAsk'));
        else confirmAction({ title: t('discovery.permissionTitle'), message: t('discovery.permissionBlocked'), confirmLabel: t('discovery.openSettings'), onConfirm: () => void Linking.openSettings() });
      } else if (e instanceof ContactsUnavailableError) {
        notify(t('discovery.unavailableTitle'), t('discovery.unavailable'));
      } else {
        notify(t('discovery.failed'), friendlyError(e));
      }
    }
  };

  const message = async (f: DiscoveredFriend) => {
    setOpening(f.userId);
    try {
      const id = await conversationRepository.createDirectConversation(f.userId);
      router.push(`/chat/${id}`);
    } catch (e) {
      notify(t('contacts.startFailed'), friendlyError(e));
    } finally {
      setOpening(null);
    }
  };

  const unavailable = Platform.OS === 'web';
  const privacy: [IconName, string][] = [
    ['smartphone', t('discovery.p1')],
    ['key', t('discovery.p2')],
    ['checks', t('discovery.p3')],
    ['eyeOff', t('discovery.p4')],
  ];

  return (
    <View style={[ui.screen, { paddingTop: insets.top }]}>
      <ScreenHeader title={t('discovery.title')} right={<IconButton icon="sliders" label={t('settings.findMe')} onPress={() => router.push('/discovery/settings')} />} />
      <ScrollView contentContainerStyle={[ui.content, { paddingBottom: insets.bottom + 40 }]}>
        {isDemo ? (
          <Note icon="info">{t('discovery.demo')}</Note>
        ) : phase !== 'results' ? (
          <>
            <FlowCard icon="users" title={t('discovery.headline')} body={t('discovery.sub')} />
            <Card>
              <Text style={type.eyebrow}>{t('discovery.howPrivate')}</Text>
              {privacy.map(([icon, text], i) => (
                <Animated.View key={icon} entering={FadeInDown.delay(80 + i * 60)} style={s.row}>
                  <View style={s.rowIcon}>
                    <Icon name={icon} size={17} color={c.accentText} />
                  </View>
                  <Text style={[type.body, { flex: 1, fontSize: 14, color: c.muted }]}>{text}</Text>
                </Animated.View>
              ))}
              <Text style={type.caption}>{t('discovery.bruteForce')}</Text>
            </Card>

            {unavailable ? (
              <Note icon="laptop" tone="warning">
                {t('discovery.mobileOnly')}
              </Note>
            ) : (
              <Button
                label={phase === 'intro' ? t('discovery.allow') : phase === 'reading' ? t('discovery.reading') : t('discovery.matching')}
                icon="search"
                onPress={run}
                loading={phase !== 'intro'}
              />
            )}
            {phase === 'matching' && <ProgressBar value={progress} />}
            <Button label={t('discovery.letFind')} variant="secondary" icon="eye" onPress={() => router.push('/discovery/settings')} />
          </>
        ) : (
          <>
            <Animated.View entering={FadeIn}>
              <FlowCard
                icon={friends.length ? 'users' : 'search'}
                tone={friends.length ? 'success' : 'brass'}
                title={friends.length ? t('discovery.found', { count: friends.length }) : t('discovery.noneTitle')}
                body={friends.length ? undefined : t('discovery.none')}
              />
            </Animated.View>
            {stats && <Text style={[type.caption, { textAlign: 'center' }]}>{t('discovery.stats', { checked: stats.checked, prefixes: stats.prefixesSent })}</Text>}
            {friends.map((f, i) => (
              <Rise key={f.userId} index={Math.min(i, 10)}>
                <View style={s.friend}>
                  <Avatar name={f.displayName} size={46} />
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text style={[type.name, { fontSize: 15.5 }]} numberOfLines={1}>
                      {f.displayName}
                    </Text>
                    <Text style={type.caption} numberOfLines={2}>
                      @{f.username} · {t('discovery.inContacts', { names: f.contactNames.join(', ') })}
                    </Text>
                  </View>
                  <Button label={t('profile.message')} size="sm" variant="secondary" onPress={() => void message(f)} loading={opening === f.userId} />
                </View>
              </Rise>
            ))}
            <Button label={t('contacts.myQr')} variant="secondary" icon="qr" onPress={() => router.push('/qr')} />
          </>
        )}
      </ScrollView>
    </View>
  );
}

const useStyles = makeStyles((c, t, f) => ({
  row: { flexDirection: 'row', gap: 12, alignItems: 'flex-start' },
  rowIcon: { width: 32, height: 32, borderRadius: 10, backgroundColor: c.accentTint, alignItems: 'center', justifyContent: 'center' },
  friend: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 12, borderRadius: 20, backgroundColor: c.panel, borderWidth: 1, borderColor: c.line },
}));
