import React, { useEffect, useState } from 'react';
import { ActivityIndicator, ScrollView, Text, View } from 'react-native';
import Animated, { FadeIn, ZoomIn } from 'react-native-reanimated';
import { router, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { friendlyError } from '../../src/core/network/supabase';
import { useAuthStore } from '../../src/features/auth/useAuthStore';
import { channelRepository } from '../../src/features/channels/ChannelRepository';
import { formatCount } from '../../src/features/channels/channelUtils';
import { ChannelInvitePreview } from '../../src/features/channels/types';
import { useChatsStore } from '../../src/features/chats/useChatsStore';
import { Banner, EntityAvatar, inviteStatusText, ScreenHeader, useGroupStyles } from '../../src/features/groups/components/GroupComponents';
import { groupRepository } from '../../src/features/groups/GroupRepository';
import { isValidInviteToken, parseInviteLink } from '../../src/features/groups/inviteLinks';
import { InvitePreview } from '../../src/features/groups/types';
import { makeStyles, useTheme } from '../../src/shared/theme/ThemeProvider';
import { useT } from '../../src/shared/i18n';
import { Button, DotWall, Icon, Pill, Ripple } from '../../src/shared/ui';

type Preview = { kind: 'loading' } | { kind: 'group'; data: InvitePreview } | { kind: 'channel'; data: ChannelInvitePreview } | { kind: 'error'; message: string };

/**
 * Handles vero://join/<token> and https://<host>/join/<token>: previews a group
 * invite (or a private channel link) and joins on confirmation.
 */
export default function JoinScreen() {
  const params = useLocalSearchParams<{ token: string }>();
  const token = parseInviteLink(params.token ?? '') ?? '';
  const insets = useSafeAreaInsets();
  const { c, type } = useTheme();
  const gs = useGroupStyles();
  const s = useStyles();
  const t = useT();
  const isAuthenticated = useAuthStore((st) => st.isAuthenticated);
  const isAuthLoading = useAuthStore((st) => st.isLoading);
  const isDemo = useAuthStore((st) => st.isDemo);
  const [preview, setPreview] = useState<Preview>({ kind: 'loading' });
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  useEffect(() => {
    if (!isAuthenticated || isDemo) return;
    if (!isValidInviteToken(token)) {
      setPreview({ kind: 'error', message: inviteStatusText(t, 'invalid') });
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const group = await groupRepository.previewInvite(token);
        if (cancelled) return;
        if (group.status !== 'invalid') {
          setPreview(group.status === 'valid' ? { kind: 'group', data: group } : { kind: 'error', message: inviteStatusText(t, group.status) });
          return;
        }
        const channel = await channelRepository.previewInvite(token);
        if (cancelled) return;
        setPreview(channel.status === 'valid' ? { kind: 'channel', data: channel } : { kind: 'error', message: inviteStatusText(t, channel.status) });
      } catch (e) {
        if (!cancelled) setPreview({ kind: 'error', message: friendlyError(e) });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token, isAuthenticated, isDemo]);

  const back = () => (router.canGoBack() ? router.back() : router.replace('/'));

  const shell = (children: React.ReactNode) => (
    <View style={[gs.container, { paddingTop: insets.top }]}>
      <ScreenHeader title={t('join.title')} onBack={back} />
      <View style={{ flex: 1 }}>
        <DotWall />
        <ScrollView contentContainerStyle={s.body}>{children}</ScrollView>
      </View>
    </View>
  );

  if (isAuthLoading) {
    return (
      <View style={gs.container}>
        <View style={gs.centered}>
          <ActivityIndicator color={c.accent} />
        </View>
      </View>
    );
  }

  if (!isAuthenticated || isDemo) {
    return shell(
      <Animated.View entering={FadeIn} style={s.card}>
        <View style={s.glyph}>
          <Icon name="link" size={30} color={c.accentText} />
        </View>
        <Text style={gs.heroTitle}>{t('join.invited')}</Text>
        <Text style={gs.heroSub}>{isDemo ? t('join.demo') : t('join.signIn')}</Text>
        {!isDemo && <Button label={t('auth.signIn')} iconRight="arrowRight" onPress={() => router.replace('/(auth)/login')} style={{ alignSelf: 'stretch' }} />}
      </Animated.View>
    );
  }

  const joinGroup = async (data: InvitePreview) => {
    setBusy(true);
    try {
      if (data.isMember && data.conversationId) {
        router.replace(`/chat/${data.conversationId}`);
        return;
      }
      const r = await groupRepository.joinViaInvite(token);
      if ((r.status === 'joined' || r.status === 'already_member') && r.conversationId) {
        void useChatsStore.getState().load({ sync: false });
        router.replace(`/chat/${r.conversationId}`);
        return;
      }
      setResult(inviteStatusText(t, r.status));
    } catch (e) {
      setResult(friendlyError(e));
    } finally {
      setBusy(false);
    }
  };

  const followChannel = async (data: ChannelInvitePreview) => {
    setBusy(true);
    try {
      const r = data.isFollowing ? { status: 'following', channelId: data.channelId } : await channelRepository.followViaInvite(token);
      if (r.status === 'following' && r.channelId) {
        router.replace(`/channels/${r.channelId}`);
        return;
      }
      setResult(inviteStatusText(t, r.status));
    } catch (e) {
      setResult(friendlyError(e));
    } finally {
      setBusy(false);
    }
  };

  if (preview.kind === 'loading') return shell(<ActivityIndicator color={c.accent} style={{ marginTop: 48 }} />);

  if (preview.kind === 'error') {
    return shell(
      <Animated.View entering={FadeIn} style={s.card}>
        <View style={[s.glyph, { backgroundColor: c.dangerTint, borderColor: c.dangerTint }]}>
          <Icon name="link" size={30} color={c.danger} />
        </View>
        <Text style={gs.heroTitle}>{t('join.cantOpen')}</Text>
        <Text style={gs.heroSub}>{preview.message}</Text>
        <Button label={t('common.back')} variant="ghost" onPress={back} style={{ alignSelf: 'stretch' }} />
      </Animated.View>
    );
  }

  const isGroup = preview.kind === 'group';
  const g = isGroup ? (preview.data as InvitePreview) : null;
  const ch = !isGroup ? (preview.data as ChannelInvitePreview) : null;
  const name = (g ? g.groupName : ch?.name) ?? (g ? t('communities.group') : t('channels.channel'));

  const label = g
    ? g.isMember
      ? t('join.openChat')
      : g.hasPendingRequest
      ? t('join.pending')
      : g.requiresApproval
      ? t('join.request')
      : t('join.joinGroup')
    : ch?.isFollowing
    ? t('join.openChannel')
    : t('join.followChannel');

  return shell(
    <View style={{ gap: 12, width: '100%' }}>
      <Animated.View entering={FadeIn} style={s.card}>
        <Animated.View entering={ZoomIn.springify().damping(14)}>
          <Ripple size={104} color={c.accentLine}>
            <EntityAvatar name={name} dataUri={g ? g.avatarData : ch?.avatarData} size={104} icon={g ? 'users' : 'megaphone'} />
          </Ripple>
        </Animated.View>
        <Text style={gs.heroTitle}>{name}</Text>
        <Pill
          icon={g ? 'users' : 'megaphone'}
          tone="brass"
          label={
            g
              ? t('groups.groupMembers', { count: g.memberCount ?? 0 })
              : `@${ch?.handle} · ${t('channels.followers', { count: ch?.followerCount ?? 0, n: formatCount(ch?.followerCount ?? 0) })}`
          }
        />
        {!!(g ? g.description : ch?.description) && <Text style={gs.heroSub}>{g ? g.description : ch?.description}</Text>}
        {result ? (
          <Animated.Text entering={FadeIn} style={[type.body, { textAlign: 'center', color: c.accentText }]}>
            {result}
          </Animated.Text>
        ) : (
          <Button
            label={label}
            icon={g ? 'users' : 'megaphone'}
            loading={busy}
            disabled={!!g && g.hasPendingRequest && !g.isMember}
            onPress={() => void (g ? joinGroup(g) : followChannel(ch!))}
            style={{ alignSelf: 'stretch' }}
          />
        )}
      </Animated.View>
      <View style={{ marginHorizontal: -16 }}>
        {g ? <Banner icon="lock" text={t('join.groupNote')} /> : <Banner icon="info" tone="warning" text={t('channels.notice')} />}
        {g?.requiresApproval && !g.isMember && <Banner icon="info" tone="warning" text={t('join.approvalNote')} />}
      </View>
    </View>
  );
}

const useStyles = makeStyles((c, t, f) => ({
  body: { flexGrow: 1, alignItems: 'center', justifyContent: 'center', padding: 16, paddingVertical: 40, width: '100%', maxWidth: 520, alignSelf: 'center' },
  card: { width: '100%', alignItems: 'center', gap: 14, padding: 24, borderRadius: 28, backgroundColor: c.panel, borderWidth: 1, borderColor: c.line },
  glyph: { width: 72, height: 72, borderRadius: 24, backgroundColor: c.accentTint, borderWidth: 1, borderColor: c.accentTint2, alignItems: 'center', justifyContent: 'center' },
}));
