import React, { useCallback, useMemo, useState } from 'react';
import { ActivityIndicator, ScrollView, Text, View } from 'react-native';
import Animated, { ZoomIn } from 'react-native-reanimated';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { friendlyError } from '../../src/core/network/supabase';
import { useAuthStore } from '../../src/features/auth/useAuthStore';
import { useChatsStore } from '../../src/features/chats/useChatsStore';
import { communityRepository } from '../../src/features/communities/CommunityRepository';
import { communityGroupAction, isCommunityAdmin } from '../../src/features/communities/types';
import { communitiesStore, useCommunitiesStore } from '../../src/features/communities/useCommunitiesStore';
import { pickAvatarDataUri } from '../../src/features/groups/avatarPicker';
import { Banner, EntityAvatar, inviteStatusText, Row, ScreenHeader, SectionHeader, useGroupStyles } from '../../src/features/groups/components/GroupComponents';
import { ActionSheet, confirmAction, notify, SheetOption, shareLink } from '../../src/features/groups/components/ui';
import { shareableInviteUrl } from '../../src/features/groups/config';
import { groupRepository } from '../../src/features/groups/GroupRepository';
import { makeStyles, useTheme } from '../../src/shared/theme/ThemeProvider';
import { useT } from '../../src/shared/i18n';
import { Avatar, Button, Icon, IconButton, Pill, Pressy, Rise, Sheet, TextField } from '../../src/shared/ui';

export default function CommunityScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const communityId = id ?? '';
  const insets = useSafeAreaInsets();
  const { c, type } = useTheme();
  const gs = useGroupStyles();
  const s = useStyles();
  const t = useT();
  const me = useAuthStore((st) => st.user?.id);
  const isDemo = useAuthStore((st) => st.isDemo);
  const details = useCommunitiesStore((st) => st.details[communityId]);
  const groups = useCommunitiesStore((st) => st.groups[communityId]) ?? [];
  const members = useCommunitiesStore((st) => st.members[communityId]);
  const conversations = useChatsStore((st) => st.conversations);
  const store = communitiesStore.getState();

  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [menu, setMenu] = useState(false);
  const [linkPicker, setLinkPicker] = useState(false);
  const [newGroupName, setNewGroupName] = useState<string | null>(null);
  const [showMembers, setShowMembers] = useState(false);

  useFocusEffect(
    useCallback(() => {
      if (isDemo || !communityId) return;
      void communitiesStore
        .getState()
        .open(communityId)
        .catch(() => undefined)
        .finally(() => setLoaded(true));
    }, [communityId, isDemo])
  );

  const isAdmin = isCommunityAdmin(details?.myRole);
  const isOwner = details?.myRole === 'owner';
  const linkedIds = useMemo(() => new Set(groups.map((g) => g.conversationId)), [groups]);
  // Groups I admin that aren't already in this community (the server also rejects groups that belong to another community).
  const linkable = useMemo(
    () => conversations.filter((cv) => cv.conversationType === 'group' && !linkedIds.has(cv.id) && cv.members.some((m) => m.id === me && (m.role === 'admin' || m.role === 'owner'))),
    [conversations, linkedIds, me]
  );

  const run = async (fn: () => Promise<unknown>, failTitle: string) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      notify(failTitle, friendlyError(e));
    } finally {
      setBusy(false);
    }
  };

  const back = () => (router.canGoBack() ? router.back() : router.replace('/communities'));

  if (isDemo || !details) {
    return (
      <View style={[gs.container, { paddingTop: insets.top }]}>
        <ScreenHeader title={t('communities.community')} onBack={back} />
        <View style={gs.centered}>
          {isDemo ? <Text style={gs.muted}>{t('communities.demo')}</Text> : !loaded ? <ActivityIndicator color={c.accent} /> : <Text style={gs.muted}>{t('communities.unavailable')}</Text>}
        </View>
      </View>
    );
  }

  const invite = () =>
    run(async () => {
      if (!details.announcementsConversationId) throw new Error(t('communities.noAnnouncements'));
      const inv = await groupRepository.createInvite(details.announcementsConversationId, { expiresInSeconds: 7 * 86400, maxUses: null, requiresApproval: false });
      await shareLink(shareableInviteUrl(inv.token), t('communities.joinShare', { name: details.name }));
    }, t('communities.inviteFailed'));

  const joinGroup = (conversationId: string) =>
    run(async () => {
      const status = await store.joinGroup(communityId, conversationId);
      if (status === 'joined' || status === 'already_member') {
        void useChatsStore.getState().load({ sync: false });
        router.push(`/chat/${conversationId}`);
      } else {
        notify(inviteStatusText(t, status));
      }
    }, t('communities.joinFailed'));

  const menuOptions: SheetOption[] = [
    ...(isAdmin
      ? [
          { label: t('communities.invite'), icon: 'link' as const, onPress: () => void invite() },
          {
            label: t('communities.changePhoto'),
            icon: 'image' as const,
            onPress: () =>
              void run(async () => {
                const uri = await pickAvatarDataUri();
                if (uri) {
                  await communityRepository.update(communityId, { avatarData: uri });
                  await store.open(communityId);
                }
              }, t('groups.photoFailed')),
          },
          {
            label: t('newGroup.members'),
            icon: 'users' as const,
            onPress: () => {
              setShowMembers(true);
              void store.loadMembers(communityId).catch((e) => notify(t('communities.membersFailed'), friendlyError(e)));
            },
          },
        ]
      : []),
    ...(!isOwner
      ? [
          {
            label: t('communities.leave'),
            icon: 'logout' as const,
            destructive: true,
            onPress: async () => {
              if (await confirmAction(t('communities.leave'), t('communities.leaveBody'), t('thread.leaveConfirm'), true)) {
                void run(async () => {
                  await store.leave(communityId);
                  void useChatsStore.getState().load({ sync: false });
                  back();
                }, t('communities.leaveFailed'));
              }
            },
          },
        ]
      : [
          {
            label: t('communities.delete'),
            icon: 'trash' as const,
            destructive: true,
            onPress: async () => {
              if (await confirmAction(t('communities.delete'), t('communities.deleteBody'), t('common.delete'), true)) {
                void run(async () => {
                  await store.remove(communityId);
                  void useChatsStore.getState().load({ sync: false });
                  back();
                }, t('thread.deleteFailed'));
              }
            },
          },
        ]),
  ];

  const announcements = groups.find((g) => g.isAnnouncements);
  const others = groups.filter((g) => !g.isAnnouncements);

  return (
    <View style={[gs.container, { paddingTop: insets.top }]}>
      <ScreenHeader
        title={details.name}
        subtitle={t('communities.subtitleCount', { count: details.memberCount })}
        onBack={back}
        right={busy ? <ActivityIndicator color={c.accent} style={{ marginRight: 12 }} /> : <IconButton icon="more" label={t('communities.options')} onPress={() => setMenu(true)} />}
      />
      <ScrollView contentContainerStyle={[gs.scroll, { paddingBottom: insets.bottom + 40 }]}>
        <View style={gs.hero}>
          <Animated.View entering={ZoomIn.springify().damping(14)}>
            <EntityAvatar name={details.name} dataUri={details.avatarData} size={92} icon="grid" />
          </Animated.View>
          <Text style={gs.heroTitle}>{details.name}</Text>
          {!!details.description && <Text style={gs.heroSub}>{details.description}</Text>}
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <Pill icon="users" label={t('communities.members', { count: details.memberCount })} tone="brass" />
            <Pill icon="grid" label={t('communities.groups', { count: others.length })} tone="stage" />
          </View>
        </View>
        <Banner icon="lock" text={t('communities.privacyNote')} />

        {announcements && (
          <>
            <SectionHeader title={t('communities.announcements')} />
            <Pressy onPress={() => router.push(`/chat/${announcements.conversationId}`)} scaleTo={0.98} hoverStyle={{ borderColor: c.accentLine }} style={s.announce} accessibilityLabel={announcements.name}>
              <View style={s.announceIcon}>
                <Icon name="megaphone" size={22} color={c.onAccent} />
              </View>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={s.groupName} numberOfLines={1}>
                  {announcements.name}
                </Text>
                <Text style={type.caption}>{t('communities.adminsPost')}</Text>
              </View>
              <Icon name="forwardChevron" size={18} color={c.faint} />
            </Pressy>
          </>
        )}

        <SectionHeader title={t('communities.groupsCount', { count: others.length })} />
        {isAdmin && (
          <>
            <Row icon="plus" label={t('communities.createGroup')} onPress={() => setNewGroupName('')} />
            <Row icon="link" label={t('communities.addExisting')} sublabel={t('communities.addExistingHint')} onPress={() => setLinkPicker(true)} />
          </>
        )}
        {others.map((g, i) => {
          const action = communityGroupAction(g);
          return (
            <Rise key={g.conversationId} index={Math.min(i, 8)}>
              <Pressy
                onPress={action === 'open' ? () => router.push(`/chat/${g.conversationId}`) : undefined}
                disabled={action !== 'open'}
                scaleTo={0.985}
                hoverStyle={{ backgroundColor: c.tint }}
                style={s.group}
                accessibilityLabel={g.name}
              >
                <Avatar name={g.name} size={44} square icon="users" />
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={s.groupName} numberOfLines={1}>
                    {g.name}
                  </Text>
                  <Text style={type.caption}>
                    {t('communities.members', { count: g.memberCount })}
                    {g.joinApprovalRequired ? ` · ${t('communities.approvalNeeded')}` : ''}
                  </Text>
                </View>
                {action === 'open' ? (
                  <Icon name="forwardChevron" size={18} color={c.faint} />
                ) : action === 'requested' ? (
                  <Pill label={t('communities.requested')} tone="stage" />
                ) : (
                  <Button label={action === 'request' ? t('communities.request') : t('communities.join')} size="sm" onPress={() => void joinGroup(g.conversationId)} />
                )}
              </Pressy>
            </Rise>
          );
        })}
        {others.length === 0 && <Text style={[gs.muted, { paddingVertical: 12 }]}>{t('communities.noGroups')}</Text>}

        {isAdmin && others.length > 0 && (
          <>
            <SectionHeader title={t('communities.manage')} />
            {others.map((g) => (
              <Row
                key={`rm-${g.conversationId}`}
                icon="close"
                danger
                label={t('communities.removeGroup', { name: g.name })}
                onPress={async () => {
                  if (await confirmAction(t('communities.removeGroupTitle'), t('communities.removeGroupBody'), t('groups.removeConfirm'), true)) {
                    void run(() => store.unlinkGroup(communityId, g.conversationId), t('communities.removeGroupFailed'));
                  }
                }}
              />
            ))}
          </>
        )}
      </ScrollView>

      <ActionSheet visible={menu} title={details.name} options={menuOptions} onClose={() => setMenu(false)} />

      <ActionSheet
        visible={linkPicker}
        title={linkable.length ? t('communities.pickGroup') : t('communities.noLinkable')}
        options={linkable.map((cv) => ({
          label: cv.groupName || t('communities.group'),
          icon: 'users' as const,
          onPress: () => void run(() => store.linkGroup(communityId, cv.id), t('communities.addGroupFailed')),
        }))}
        onClose={() => setLinkPicker(false)}
      />

      <Sheet visible={newGroupName !== null} onClose={() => setNewGroupName(null)} title={t('communities.newGroup')}>
        <TextField label={t('newGroup.name')} icon="users" value={newGroupName ?? ''} onChangeText={setNewGroupName} maxLength={64} placeholder={t('newGroup.namePlaceholder')} autoFocus />
        <Button
          label={t('newGroup.create')}
          loading={busy}
          disabled={!newGroupName?.trim()}
          onPress={() =>
            void run(async () => {
              const conv = await store.createGroup(communityId, newGroupName ?? '');
              setNewGroupName(null);
              void useChatsStore.getState().load({ sync: false });
              router.push(`/chat/${conv}`);
            }, t('newGroup.failed'))
          }
        />
      </Sheet>

      <Sheet visible={showMembers} onClose={() => setShowMembers(false)} title={t('communities.membersTitle', { count: members?.length ?? 0 })}>
        <Text style={type.caption}>{t('communities.membersPrivate')}</Text>
        <ScrollView style={{ maxHeight: 440 }} contentContainerStyle={{ gap: 4 }}>
          {!members && <ActivityIndicator color={c.accent} style={{ marginVertical: 16 }} />}
          {members?.map((m) => (
            <View key={m.userId} style={s.member}>
              <Avatar name={m.displayName} size={38} />
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={s.groupName} numberOfLines={1}>
                  {m.userId === me ? t('common.you') : m.displayName}
                </Text>
                <Text style={type.caption}>
                  @{m.username} · {m.role === 'owner' ? t('thread.role_owner') : m.role === 'admin' ? t('thread.role_admin') : t('communities.member')}
                </Text>
              </View>
              {m.role !== 'owner' && m.userId !== me && (m.role === 'member' || isOwner) && (
                <View style={{ flexDirection: 'row', gap: 6 }}>
                  <Button
                    label={m.role === 'admin' ? t('groups.dismissAdmin') : t('groups.makeAdmin')}
                    size="sm"
                    variant="secondary"
                    onPress={() => void run(() => store.setRole(communityId, m.userId, m.role === 'admin' ? 'member' : 'admin'), t('groups.roleFailed'))}
                  />
                  <IconButton
                    icon="close"
                    label={t('groups.removePerson', { name: m.displayName })}
                    size={34}
                    color={c.danger}
                    onPress={async () => {
                      if (await confirmAction(t('groups.removeTitle'), t('communities.removeMemberBody', { name: m.displayName }), t('groups.removeConfirm'), true)) {
                        void run(() => store.removeMember(communityId, m.userId), t('groups.removeFailed'));
                      }
                    }}
                  />
                </View>
              )}
            </View>
          ))}
        </ScrollView>
        <Button label={t('common.done')} variant="ghost" onPress={() => setShowMembers(false)} />
      </Sheet>
    </View>
  );
}

const useStyles = makeStyles((c, t, f) => ({
  announce: { flexDirection: 'row', alignItems: 'center', gap: 14, marginHorizontal: 16, padding: 14, borderRadius: 20, backgroundColor: c.accentTint, borderWidth: 1, borderColor: c.accentTint2 },
  announceIcon: { width: 46, height: 46, borderRadius: 15, backgroundColor: c.accent, alignItems: 'center', justifyContent: 'center' },
  group: { flexDirection: 'row', alignItems: 'center', gap: 12, marginHorizontal: 8, paddingHorizontal: 12, paddingVertical: 9, borderRadius: 16 },
  groupName: { fontFamily: f.semibold, fontSize: 15.5, color: c.text },
  member: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 6 },
}));
