import React, { useCallback, useMemo, useState } from 'react';
import { ActivityIndicator, Modal, Pressable, ScrollView, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { friendlyError } from '../../src/core/network/supabase';
import { useAuthStore } from '../../src/features/auth/useAuthStore';
import { useChatsStore } from '../../src/features/chats/useChatsStore';
import { communityRepository } from '../../src/features/communities/CommunityRepository';
import { communityGroupAction, isCommunityAdmin } from '../../src/features/communities/types';
import { communitiesStore, useCommunitiesStore } from '../../src/features/communities/useCommunitiesStore';
import { pickAvatarDataUri } from '../../src/features/groups/avatarPicker';
import { Banner, EntityAvatar, groupStyles as gs, PrimaryButton, Row, ScreenHeader, SectionHeader } from '../../src/features/groups/components/GroupComponents';
import { ActionSheet, confirmAction, notify, SheetOption, shareLink } from '../../src/features/groups/components/ui';
import { shareableInviteUrl } from '../../src/features/groups/config';
import { groupRepository } from '../../src/features/groups/GroupRepository';
import { inviteStatusMessage } from '../../src/features/groups/inviteLinks';
import { Colors, Spacing, Typography } from '../../src/shared/theme/theme';

export default function CommunityScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const communityId = id ?? '';
  const me = useAuthStore((s) => s.user?.id);
  const isDemo = useAuthStore((s) => s.isDemo);
  const details = useCommunitiesStore((s) => s.details[communityId]);
  const groups = useCommunitiesStore((s) => s.groups[communityId]) ?? [];
  const members = useCommunitiesStore((s) => s.members[communityId]);
  const conversations = useChatsStore((s) => s.conversations);
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
  // Groups I admin that aren't already in this community (the server also
  // rejects groups that belong to another community).
  const linkable = useMemo(
    () =>
      conversations.filter(
        (c) =>
          c.conversationType === 'group' &&
          !linkedIds.has(c.id) &&
          c.members.some((m) => m.id === me && (m.role === 'admin' || m.role === 'owner'))
      ),
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

  if (isDemo || !details) {
    return (
      <SafeAreaView style={gs.container} edges={['top']}>
        <ScreenHeader title="Community" onBack={() => router.back()} />
        <View style={gs.centered}>
          {isDemo ? (
            <Text style={gs.muted}>Communities need a real account.</Text>
          ) : !loaded ? (
            <ActivityIndicator color={Colors.accent} />
          ) : (
            <Text style={gs.muted}>This community isn't available.</Text>
          )}
        </View>
      </SafeAreaView>
    );
  }

  const invite = () =>
    run(async () => {
      if (!details.announcementsConversationId) throw new Error('No announcements group');
      const inv = await groupRepository.createInvite(details.announcementsConversationId, {
        expiresInSeconds: 7 * 86400,
        maxUses: null,
        requiresApproval: false,
      });
      await shareLink(shareableInviteUrl(inv.token), `Join the "${details.name}" community on Vero`);
    }, 'Could not create invite');

  const joinGroup = (conversationId: string) =>
    run(async () => {
      const status = await store.joinGroup(communityId, conversationId);
      if (status === 'joined' || status === 'already_member') {
        void useChatsStore.getState().load({ sync: false });
        router.push(`/chat/${conversationId}`);
      } else {
        notify(inviteStatusMessage(status));
      }
    }, 'Could not join');

  const menuOptions: SheetOption[] = [
    ...(isAdmin
      ? [
          { label: 'Invite people', icon: 'link-outline' as const, onPress: () => void invite() },
          {
            label: 'Change photo',
            icon: 'image-outline' as const,
            onPress: () =>
              void run(async () => {
                const uri = await pickAvatarDataUri();
                if (uri) {
                  await communityRepository.update(communityId, { avatarData: uri });
                  await store.open(communityId);
                }
              }, 'Could not change photo'),
          },
          {
            label: 'Members',
            icon: 'people-outline' as const,
            onPress: () => {
              setShowMembers(true);
              void store.loadMembers(communityId).catch((e) => notify('Could not load members', friendlyError(e)));
            },
          },
        ]
      : []),
    ...(!isOwner
      ? [
          {
            label: 'Leave community',
            icon: 'exit-outline' as const,
            destructive: true,
            onPress: async () => {
              if (await confirmAction('Leave community', "You'll leave the announcements group. You stay in groups you joined.", 'Leave', true)) {
                void run(async () => {
                  await store.leave(communityId);
                  void useChatsStore.getState().load({ sync: false });
                  router.back();
                }, 'Could not leave');
              }
            },
          },
        ]
      : [
          {
            label: 'Delete community',
            icon: 'trash-outline' as const,
            destructive: true,
            onPress: async () => {
              if (await confirmAction('Delete community', 'The announcements group is deleted. Linked groups keep existing on their own.', 'Delete', true)) {
                void run(async () => {
                  await store.remove(communityId);
                  void useChatsStore.getState().load({ sync: false });
                  router.back();
                }, 'Could not delete');
              }
            },
          },
        ]),
  ];

  const announcements = groups.find((g) => g.isAnnouncements);
  const others = groups.filter((g) => !g.isAnnouncements);

  return (
    <SafeAreaView style={gs.container} edges={['top']}>
      <ScreenHeader
        title={details.name}
        subtitle={`Community · ${details.memberCount} members`}
        onBack={() => router.back()}
        right={
          <TouchableOpacity onPress={() => setMenu(true)} style={{ padding: Spacing.sm }} accessibilityLabel="Community options">
            {busy ? <ActivityIndicator color={Colors.accent} /> : <Ionicons name="ellipsis-vertical" size={20} color={Colors.textPrimary} />}
          </TouchableOpacity>
        }
      />
      <ScrollView contentContainerStyle={gs.scroll}>
        <View style={gs.hero}>
          <EntityAvatar name={details.name} dataUri={details.avatarData} size={80} icon="git-network" />
          <Text style={gs.heroTitle}>{details.name}</Text>
          {!!details.description && <Text style={gs.heroSub}>{details.description}</Text>}
        </View>
        <Banner icon="lock-closed" text="Groups and announcements are end-to-end encrypted. Members of the community don't see each other unless they share a group." />

        {announcements && (
          <>
            <SectionHeader title="Announcements" />
            <Row
              icon="megaphone-outline"
              label={announcements.name}
              sublabel="Only admins can post"
              onPress={() => router.push(`/chat/${announcements.conversationId}`)}
            />
          </>
        )}

        <SectionHeader title={`Groups (${others.length})`} />
        {isAdmin && (
          <>
            <Row icon="add-circle-outline" label="Create new group" onPress={() => setNewGroupName('')} />
            <Row icon="git-merge-outline" label="Add existing group" sublabel="Groups where you're an admin" onPress={() => setLinkPicker(true)} />
          </>
        )}
        {others.map((g) => {
          const action = communityGroupAction(g);
          return (
            <Row
              key={g.conversationId}
              label={g.name}
              sublabel={`${g.memberCount} members${g.joinApprovalRequired ? ' · approval needed' : ''}`}
              onPress={action === 'open' ? () => router.push(`/chat/${g.conversationId}`) : undefined}
              right={
                action === 'open' ? null : action === 'requested' ? (
                  <Text style={gs.muted}>Requested</Text>
                ) : (
                  <TouchableOpacity onPress={() => void joinGroup(g.conversationId)}>
                    <Text style={{ color: Colors.accentLight, fontWeight: Typography.semibold }}>{action === 'request' ? 'Request' : 'Join'}</Text>
                  </TouchableOpacity>
                )
              }
            />
          );
        })}
        {others.length === 0 && <Text style={[gs.muted, { paddingHorizontal: Spacing.base }]}>No groups yet.</Text>}

        {isAdmin && others.length > 0 && (
          <>
            <SectionHeader title="Manage" />
            {others.map((g) => (
                <Row
                  key={`rm-${g.conversationId}`}
                  icon="remove-circle-outline"
                  label={`Remove "${g.name}" from community`}
                  onPress={async () => {
                    if (await confirmAction('Remove group', 'The group keeps existing; it just leaves this community.', 'Remove', true)) {
                      void run(() => store.unlinkGroup(communityId, g.conversationId), 'Could not remove group');
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
        title={linkable.length ? 'Add a group you admin' : 'No groups you admin are available'}
        options={linkable.map((c) => ({
          label: c.groupName || 'Group',
          icon: 'people-outline' as const,
          onPress: () => void run(() => store.linkGroup(communityId, c.id), 'Could not add group'),
        }))}
        onClose={() => setLinkPicker(false)}
      />

      <Modal visible={newGroupName !== null} transparent animationType="fade" onRequestClose={() => setNewGroupName(null)}>
        <Pressable style={{ flex: 1, backgroundColor: Colors.overlay, justifyContent: 'flex-end' }} onPress={() => setNewGroupName(null)}>
          <Pressable style={{ backgroundColor: Colors.surfaceElevated, paddingVertical: Spacing.lg }} onPress={() => undefined}>
            <SectionHeader title="New community group" />
            <TextInput
              style={gs.input}
              value={newGroupName ?? ''}
              onChangeText={setNewGroupName}
              maxLength={64}
              placeholder="Group name"
              placeholderTextColor={Colors.textTertiary}
              autoFocus
            />
            <PrimaryButton
              label="Create"
              disabled={!newGroupName?.trim() || busy}
              onPress={() =>
                void run(async () => {
                  const conv = await store.createGroup(communityId, newGroupName ?? '');
                  setNewGroupName(null);
                  void useChatsStore.getState().load({ sync: false });
                  router.push(`/chat/${conv}`);
                }, 'Could not create group')
              }
            />
          </Pressable>
        </Pressable>
      </Modal>

      <Modal visible={showMembers} transparent animationType="fade" onRequestClose={() => setShowMembers(false)}>
        <Pressable style={{ flex: 1, backgroundColor: Colors.overlay, justifyContent: 'flex-end' }} onPress={() => setShowMembers(false)}>
          <Pressable style={{ backgroundColor: Colors.surfaceElevated, paddingVertical: Spacing.lg, maxHeight: '80%' }} onPress={() => undefined}>
            <ScrollView>
              <SectionHeader title={`Members (${members?.length ?? 0}) · visible to admins only`} />
              {!members && <ActivityIndicator color={Colors.accent} />}
              {members?.map((m) => (
                <Row
                  key={m.userId}
                  label={m.userId === me ? 'You' : m.displayName}
                  sublabel={`@${m.username} · ${m.role === 'owner' ? 'Owner' : m.role === 'admin' ? 'Admin' : 'Member'}`}
                  right={
                    m.role !== 'owner' && m.userId !== me ? (
                      <View style={{ flexDirection: 'row', gap: Spacing.md }}>
                        {(m.role === 'member' || isOwner) && (
                          <TouchableOpacity
                            onPress={() =>
                              void run(() => store.setRole(communityId, m.userId, m.role === 'admin' ? 'member' : 'admin'), 'Could not change role')
                            }
                          >
                            <Text style={{ color: Colors.accentLight }}>{m.role === 'admin' ? 'Dismiss' : 'Make admin'}</Text>
                          </TouchableOpacity>
                        )}
                        {(m.role === 'member' || isOwner) && (
                          <TouchableOpacity
                            onPress={async () => {
                              if (await confirmAction('Remove member', `Remove ${m.displayName} from the community and its announcements?`, 'Remove', true)) {
                                void run(() => store.removeMember(communityId, m.userId), 'Could not remove');
                              }
                            }}
                          >
                            <Text style={{ color: Colors.error }}>Remove</Text>
                          </TouchableOpacity>
                        )}
                      </View>
                    ) : null
                  }
                />
              ))}
              <PrimaryButton label="Done" onPress={() => setShowMembers(false)} />
            </ScrollView>
          </Pressable>
        </Pressable>
      </Modal>
    </SafeAreaView>
  );
}
