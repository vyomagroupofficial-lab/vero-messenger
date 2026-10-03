import React, { useEffect, useState } from 'react';
import { ActivityIndicator, ScrollView, Text, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { friendlyError } from '../../src/core/network/supabase';
import { useAuthStore } from '../../src/features/auth/useAuthStore';
import { channelRepository } from '../../src/features/channels/ChannelRepository';
import { CHANNELS_E2EE_NOTICE, followersLabel } from '../../src/features/channels/channelUtils';
import { ChannelInvitePreview } from '../../src/features/channels/types';
import { useChatsStore } from '../../src/features/chats/useChatsStore';
import { Banner, EntityAvatar, groupStyles as gs, PrimaryButton, ScreenHeader } from '../../src/features/groups/components/GroupComponents';
import { groupRepository } from '../../src/features/groups/GroupRepository';
import { inviteStatusMessage, isValidInviteToken, parseInviteLink } from '../../src/features/groups/inviteLinks';
import { InvitePreview } from '../../src/features/groups/types';
import { Colors } from '../../src/shared/theme/theme';

type Preview =
  | { kind: 'loading' }
  | { kind: 'group'; data: InvitePreview }
  | { kind: 'channel'; data: ChannelInvitePreview }
  | { kind: 'error'; message: string };

/**
 * Handles vero://join/<token> and https://<host>/join/<token>: previews a group
 * invite (or a private channel link) and joins on confirmation.
 */
export default function JoinScreen() {
  const params = useLocalSearchParams<{ token: string }>();
  const token = parseInviteLink(params.token ?? '') ?? '';
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const isAuthLoading = useAuthStore((s) => s.isLoading);
  const isDemo = useAuthStore((s) => s.isDemo);
  const [preview, setPreview] = useState<Preview>({ kind: 'loading' });
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  useEffect(() => {
    if (!isAuthenticated || isDemo) return;
    if (!isValidInviteToken(token)) {
      setPreview({ kind: 'error', message: inviteStatusMessage('invalid') });
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const group = await groupRepository.previewInvite(token);
        if (cancelled) return;
        if (group.status !== 'invalid') {
          setPreview(group.status === 'valid' ? { kind: 'group', data: group } : { kind: 'error', message: inviteStatusMessage(group.status) });
          return;
        }
        const channel = await channelRepository.previewInvite(token);
        if (cancelled) return;
        setPreview(channel.status === 'valid' ? { kind: 'channel', data: channel } : { kind: 'error', message: inviteStatusMessage(channel.status) });
      } catch (e) {
        if (!cancelled) setPreview({ kind: 'error', message: friendlyError(e) });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token, isAuthenticated, isDemo]);

  const back = () => (router.canGoBack() ? router.back() : router.replace('/'));

  if (isAuthLoading) {
    return (
      <SafeAreaView style={gs.container}>
        <View style={gs.centered}>
          <ActivityIndicator color={Colors.accent} />
        </View>
      </SafeAreaView>
    );
  }

  if (!isAuthenticated || isDemo) {
    return (
      <SafeAreaView style={gs.container} edges={['top']}>
        <ScreenHeader title="Invite" onBack={back} />
        <View style={gs.centered}>
          <Text style={gs.heroTitle}>You've been invited</Text>
          <Text style={gs.heroSub}>
            {isDemo ? 'Invite links need a real account.' : 'Sign in to Vero, then open this link again to see the invite.'}
          </Text>
          {!isDemo && <PrimaryButton label="Sign in" onPress={() => router.replace('/(auth)/login')} />}
        </View>
      </SafeAreaView>
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
      setResult(inviteStatusMessage(r.status));
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
      setResult(inviteStatusMessage(r.status));
    } catch (e) {
      setResult(friendlyError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <SafeAreaView style={gs.container} edges={['top']}>
      <ScreenHeader title="Invite" onBack={back} />
      <ScrollView contentContainerStyle={gs.scroll}>
        {preview.kind === 'loading' && <ActivityIndicator color={Colors.accent} style={{ marginTop: 48 }} />}

        {preview.kind === 'error' && (
          <View style={gs.hero}>
            <Text style={gs.heroTitle}>Can't open invite</Text>
            <Text style={gs.heroSub}>{preview.message}</Text>
          </View>
        )}

        {preview.kind === 'group' && (
          <>
            <View style={gs.hero}>
              <EntityAvatar name={preview.data.groupName ?? 'Group'} dataUri={preview.data.avatarData} size={96} icon="people" />
              <Text style={gs.heroTitle}>{preview.data.groupName}</Text>
              <Text style={gs.muted}>Group · {preview.data.memberCount} members</Text>
              {!!preview.data.description && <Text style={gs.heroSub}>{preview.data.description}</Text>}
            </View>
            <Banner icon="lock-closed" text="Messages in this group are end-to-end encrypted. Members will see your name and username." />
            {preview.data.requiresApproval && !preview.data.isMember && (
              <Banner icon="hand-left-outline" tone="warning" text="An admin must approve your request before you can see messages." />
            )}
            {result ? (
              <Text style={[gs.heroSub, { marginTop: 16 }]}>{result}</Text>
            ) : (
              <PrimaryButton
                label={
                  preview.data.isMember
                    ? 'Open chat'
                    : preview.data.hasPendingRequest
                      ? 'Request pending'
                      : preview.data.requiresApproval
                        ? 'Request to join'
                        : 'Join group'
                }
                disabled={busy || (preview.data.hasPendingRequest && !preview.data.isMember)}
                onPress={() => void joinGroup(preview.data)}
              />
            )}
          </>
        )}

        {preview.kind === 'channel' && (
          <>
            <View style={gs.hero}>
              <EntityAvatar name={preview.data.name ?? 'Channel'} dataUri={preview.data.avatarData} size={96} icon="megaphone" />
              <Text style={gs.heroTitle}>{preview.data.name}</Text>
              <Text style={gs.muted}>
                @{preview.data.handle} · {followersLabel(preview.data.followerCount ?? 0)} · Private channel
              </Text>
              {!!preview.data.description && <Text style={gs.heroSub}>{preview.data.description}</Text>}
            </View>
            <Banner icon="information-circle-outline" tone="warning" text={CHANNELS_E2EE_NOTICE} />
            {result ? (
              <Text style={[gs.heroSub, { marginTop: 16 }]}>{result}</Text>
            ) : (
              <PrimaryButton
                label={preview.data.isFollowing ? 'Open channel' : 'Follow channel'}
                disabled={busy}
                onPress={() => void followChannel(preview.data)}
              />
            )}
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}
