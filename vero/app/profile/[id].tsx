import React, { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import Animated, { FadeIn, ZoomIn } from 'react-native-reanimated';
import { router, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { supabase } from '../../src/core/network/supabase';
import { useAuthStore } from '../../src/features/auth/useAuthStore';
import { conversationRepository } from '../../src/features/chats/ConversationRepository';
import { callService } from '../../src/features/calls/CallService';
import { databaseService } from '../../src/core/storage/DatabaseService';
import { DEMO_CONTACTS, DEMO_ONLINE, DEMO_USER_ID, demoConversationFor } from '../../src/features/demo/demoData';
import { Colors, Fonts, Type } from '../../src/shared/theme/theme';
import {
  Avatar,
  Grain,
  Hatch,
  Icon,
  IconButton,
  IconName,
  PhotoArt,
  Pill,
  Pressy,
  Rise,
  Toggle,
  confirmAction,
  notify,
  useLayout,
} from '../../src/shared/ui';

const withTimeout = <T,>(p: Promise<T>, ms = 2000) => Promise.race([p, new Promise<T | null>((r) => setTimeout(() => r(null), ms))]);

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
  const body = (
    <View style={[styles.item, !first && styles.itemBorder]}>
      <View style={[styles.itemIcon, danger && { backgroundColor: Colors.emberTint }]}>
        <Icon name={icon} size={19} color={danger ? Colors.ember : Colors.brass} />
      </View>
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={[styles.itemLabel, danger && { color: Colors.ember }]}>{label}</Text>
        {hint ? <Text style={[Type.caption, hintColor ? { color: hintColor } : null]}>{hint}</Text> : null}
      </View>
      {right ?? (onPress && !danger ? <Icon name="forwardChevron" size={18} color={Colors.faint} /> : null)}
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
  const { id, name } = useLocalSearchParams<{ id: string; name?: string }>();
  const { user } = useAuthStore();
  const demo = DEMO_CONTACTS.find((c) => c.id === id);

  const [displayName, setDisplayName] = useState(demo?.displayName || name || 'Contact');
  const [username, setUsername] = useState(demo?.username || 'user');
  const [about, setAbout] = useState(demo?.about || '');
  const [isVerified, setIsVerified] = useState(false);
  const [muted, setMuted] = useState(false);

  useEffect(() => {
    if (!id) return;
    (async () => {
      if (user?.id !== DEMO_USER_ID && !demo) {
        try {
          const res: any = await withTimeout(
            supabase.from('profiles').select('id, display_name, username, about').eq('id', id).single() as any
          );
          const data = res?.data;
          if (data) {
            setDisplayName(data.display_name || 'Contact');
            setUsername(data.username || 'user');
            if (data.about) setAbout(data.about);
          }
        } catch {}
      }
      const safety = await withTimeout(databaseService.getSafetyNumber(id).catch(() => null), 1500);
      if (safety) setIsVerified(safety.isVerified);
    })();
  }, [id]);

  const online = !!id && DEMO_ONLINE.has(id);
  const first = displayName.split(' ')[0];

  const startChat = async () => {
    if (!user?.id || !id) return;
    if (user.id === DEMO_USER_ID) {
      const cid = demoConversationFor(id) || `demo-chat-${username}`;
      router.push({ pathname: '/chat/[id]', params: { id: cid, name: displayName, group: '0' } } as any);
      return;
    }
    const res = await conversationRepository.createDirectConversation(user.id, id);
    if (res) router.push({ pathname: '/chat/[id]', params: { id: res.conversationId, name: displayName, group: '0' } } as any);
  };

  const startCall = async (type: 'voice' | 'video') => {
    if (!user?.id || !id) return;
    const callId = await callService.startCall({
      peerId: id,
      peerName: displayName,
      callType: type,
      currentUserId: user.id,
      currentUserName: user.displayName || user.username || 'You',
    });
    router.push(`/call/${callId}` as any);
  };

  const openVerify = () => id && router.push(`/verify-safety-number?userId=${id}&displayName=${encodeURIComponent(displayName)}` as any);
  const openMedia = (i: number) =>
    router.push({ pathname: '/media-viewer', params: { name: displayName, seed: `${id}-${i}`, scene: String(i), caption: '' } } as any);

  const block = () =>
    confirmAction({
      title: `Block ${first}?`,
      message: `${first} won’t be able to message or call you. They won’t be told.`,
      confirmLabel: 'Block',
      destructive: true,
      onConfirm: () => notify(`${first} is blocked`),
    });
  const report = () =>
    confirmAction({
      title: `Report ${first}?`,
      message: 'The last few messages from this chat are sent to Vero for review. They stay encrypted for everyone else.',
      confirmLabel: 'Report',
      destructive: true,
      onConfirm: () => notify('Thanks — we’ll take a look'),
    });

  const actions: [IconName, string, () => void][] = [
    ['chat', 'Message', startChat],
    ['phone', 'Voice', () => startCall('voice')],
    ['video', 'Video', () => startCall('video')],
    [muted ? 'bellOff' : 'bell', muted ? 'Muted' : 'Mute', () => setMuted((m) => !m)],
  ];

  const hero = (
    <View style={[styles.hero, isWide && styles.heroWide]}>
      {isWide && <Hatch color="rgba(214,166,87,0.03)" />}
      <Animated.View entering={ZoomIn.springify().damping(13)}>
        <Avatar name={displayName} size={isWide ? 148 : 120} ring online={online} />
      </Animated.View>
      <Animated.View entering={FadeIn.delay(100)} style={{ alignItems: 'center', gap: 4 }}>
        <Text style={[Type.title, { fontSize: isWide ? 34 : 28, textAlign: 'center' }]}>{displayName}</Text>
        <Text style={Type.bodyMuted}>
          @{username}
          {online ? ' · online' : ''}
        </Text>
      </Animated.View>
      {about ? (
        <Animated.Text entering={FadeIn.delay(160)} style={[Type.body, { textAlign: 'center', color: '#D9D2C1', maxWidth: 340 }]}>
          {about}
        </Animated.Text>
      ) : null}
      <Animated.View entering={FadeIn.delay(200)}>
        {isVerified ? <Pill icon="shieldCheck" label="Safety number verified" /> : <Pill icon="shield" label="Not verified yet" tone="brass" />}
      </Animated.View>
      <View style={styles.actions}>
        {actions.map(([icon, label, fn], i) => (
          <Rise key={label} index={i} delay={150} style={{ flex: 1 }}>
            <Pressy onPress={fn} style={styles.action} scaleTo={0.94} hoverStyle={{ backgroundColor: Colors.field }} accessibilityLabel={label}>
              <Icon name={icon} size={22} color={Colors.brass} />
              <Text style={styles.actionLabel}>{label}</Text>
            </Pressy>
          </Rise>
        ))}
      </View>
    </View>
  );

  const media = (
    <Rise index={1} style={styles.panel}>
      <View style={styles.panelHead}>
        <Text style={Type.eyebrow}>SHARED MEDIA</Text>
        <Pressy onPress={() => openMedia(0)} accessibilityRole="link">
          <Text style={styles.seeAll}>See all</Text>
        </Pressy>
      </View>
      <View style={styles.thumbs}>
        {Array.from({ length: isWide ? 6 : 4 }, (_, i) => (
          <Pressy key={i} onPress={() => openMedia(i)} scaleTo={0.94} style={styles.thumb} accessibilityLabel={`Open photo ${i + 1}`}>
            <PhotoArt scene={i} width="100%" height="100%" city={false} />
          </Pressy>
        ))}
      </View>
    </Rise>
  );

  const privacy = (
    <Rise index={2} style={[styles.panel, { paddingVertical: 4 }]}>
      <Item
        first
        icon="shieldCheck"
        label="Safety number"
        hint={isVerified ? 'Verified' : 'Compare to make sure it’s really them'}
        hintColor={isVerified ? Colors.sage : undefined}
        onPress={openVerify}
      />
      <Item icon="timer" label="Disappearing messages" hint="Off" onPress={startChat} />
      <Item icon="bell" label="Mute notifications" right={<Toggle label="Mute notifications" value={muted} onValueChange={setMuted} />} />
    </Rise>
  );

  const danger = (
    <Rise index={3} style={[styles.panel, { paddingVertical: 4 }]}>
      <Item first icon="ban" label={`Block ${first}`} danger onPress={block} />
      <Item icon="flag" label={`Report ${first}`} danger onPress={report} />
    </Rise>
  );

  return (
    <View style={styles.container}>
      <Grain />
      <View style={[styles.top, { paddingTop: insets.top + 8 }]}>
        <IconButton icon="back" label="Back" onPress={() => (router.canGoBack() ? router.back() : router.replace('/(tabs)/chats'))} />
        <IconButton icon="share" label="Share contact" onPress={() => notify('Share contact', `@${username}`)} />
      </View>
      <ScrollView contentContainerStyle={[styles.scroll, { paddingBottom: insets.bottom + 40 }]} showsVerticalScrollIndicator={false}>
        {isWide ? (
          <View style={styles.wideRow}>
            <View style={{ flex: 1, minWidth: 380 }}>{hero}</View>
            <View style={{ flex: 1.3, minWidth: 420, gap: 18 }}>
              {media}
              {privacy}
              {danger}
            </View>
          </View>
        ) : (
          <View style={{ gap: 16 }}>
            {hero}
            {media}
            {privacy}
            {danger}
          </View>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.ink },
  top: { flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: 8 },
  scroll: { paddingHorizontal: 16, maxWidth: 1180, width: '100%', alignSelf: 'center' },
  wideRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 22, paddingTop: 8 },
  hero: { alignItems: 'center', gap: 12, paddingBottom: 6 },
  heroWide: {
    padding: 32,
    paddingTop: 40,
    borderRadius: 26,
    backgroundColor: Colors.panel,
    borderWidth: 1,
    borderColor: Colors.line,
    overflow: 'hidden',
    gap: 16,
  },
  actions: { flexDirection: 'row', gap: 8, width: '100%', marginTop: 8 },
  action: {
    height: 76,
    borderRadius: 18,
    backgroundColor: Colors.raised,
    borderWidth: 1,
    borderColor: Colors.line,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
  },
  actionLabel: { fontFamily: Fonts.medium, fontSize: 12.5, color: Colors.cream },
  panel: { backgroundColor: Colors.panel, borderRadius: 22, borderWidth: 1, borderColor: Colors.line, paddingHorizontal: 16, paddingVertical: 14 },
  panelHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 },
  seeAll: { fontFamily: Fonts.medium, fontSize: 13, color: Colors.brass },
  thumbs: { flexDirection: 'row', gap: 8 },
  thumb: { flex: 1, aspectRatio: 1, borderRadius: 14, overflow: 'hidden' },
  item: { flexDirection: 'row', alignItems: 'center', gap: 14, minHeight: 62, paddingVertical: 8 },
  itemBorder: { borderTopWidth: 1, borderTopColor: Colors.divider },
  itemIcon: { width: 38, height: 38, borderRadius: 12, backgroundColor: Colors.raised, alignItems: 'center', justifyContent: 'center' },
  itemLabel: { fontFamily: Fonts.medium, fontSize: 15.5, color: Colors.cream },
});
