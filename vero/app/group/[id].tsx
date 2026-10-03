import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Modal, Pressable, ScrollView, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { friendlyError } from '../../src/core/network/supabase';
import { useAuthStore } from '../../src/features/auth/useAuthStore';
import { conversationRepository } from '../../src/features/chats/ConversationRepository';
import { useChatsStore } from '../../src/features/chats/useChatsStore';
import { pickAvatarDataUri } from '../../src/features/groups/avatarPicker';
import {
  Banner,
  EntityAvatar,
  groupStyles as gs,
  PrimaryButton,
  Row,
  ScreenHeader,
  SectionHeader,
  ToggleRow,
} from '../../src/features/groups/components/GroupComponents';
import { ActionSheet, confirmAction, copyLink, notify, SheetOption, shareLink } from '../../src/features/groups/components/ui';
import { shareableInviteUrl } from '../../src/features/groups/config';
import {
  INVITE_EXPIRY_CHOICES,
  INVITE_MAX_USES_CHOICES,
  inviteState,
} from '../../src/features/groups/inviteLinks';
import {
  canChangeRole,
  canChangeSettings,
  canDeleteGroup,
  canEditInfo,
  canManageInvites,
  canManageMembers,
  canRemoveMember,
  canTransferOwnership,
  sortMembers,
} from '../../src/features/groups/permissions';
import { GroupMemberInfo } from '../../src/features/groups/types';
import { useGroupStore, groupStore } from '../../src/features/groups/useGroupStore';
import { Colors, Spacing, Typography } from '../../src/shared/theme/theme';

export default function GroupInfoScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const conversationId = id ?? '';
  const me = useAuthStore((s) => s.user?.id ?? null);
  const isDemo = useAuthStore((s) => s.isDemo);

  const details = useGroupStore((s) => s.details[conversationId]);
  const invites = useGroupStore((s) => s.invites[conversationId]) ?? [];
  const requests = useGroupStore((s) => s.requests[conversationId]) ?? [];
  const loading = useGroupStore((s) => s.loading[conversationId]);
  const error = useGroupStore((s) => s.errors[conversationId]);
  const store = groupStore.getState();

  const [editing, setEditing] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [inviteSheet, setInviteSheet] = useState(false);
  const [expiry, setExpiry] = useState<number | null>(7 * 86400);
  const [maxUses, setMaxUses] = useState<number | null>(null);
  const [approval, setApproval] = useState(false);
  const [memberSheet, setMemberSheet] = useState<GroupMemberInfo | null>(null);

  useFocusEffect(
    useCallback(() => {
      if (conversationId && !isDemo) void groupStore.getState().load(conversationId);
    }, [conversationId, isDemo])
  );

  const myRole = details?.members.find((m) => m.id === me)?.role ?? null;
  const members = useMemo(() => sortMembers(details?.members ?? []), [details?.members]);
  const settings = details?.settings;

  useEffect(() => {
    if (details && !editing) {
      setName(details.name);
      setDescription(details.settings.description ?? '');
    }
  }, [details, editing]);

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

  if (isDemo) {
    return (
      <SafeAreaView style={gs.container} edges={['top']}>
        <ScreenHeader title="Group info" onBack={() => router.back()} />
        <View style={gs.centered}>
          <Text style={gs.muted}>Group admin tools need a real account.</Text>
        </View>
      </SafeAreaView>
    );
  }

  if (!details) {
    return (
      <SafeAreaView style={gs.container} edges={['top']}>
        <ScreenHeader title="Group info" onBack={() => router.back()} />
        <View style={gs.centered}>
          {loading || details === undefined ? (
            <ActivityIndicator color={Colors.accent} />
          ) : (
            <Text style={gs.muted}>{error || "This group isn't available. You may have left it."}</Text>
          )}
        </View>
      </SafeAreaView>
    );
  }

  const editable = !!settings && canEditInfo(myRole, settings);
  const isAdmin = canChangeSettings(myRole);

  const saveInfo = () =>
    run(async () => {
      await store.updateInfo(conversationId, {
        name: name.trim() !== details.name ? name.trim() : undefined,
        description: description.trim() !== (settings?.description ?? '') ? description.trim() : undefined,
      });
      setEditing(false);
      void useChatsStore.getState().load({ sync: false });
    }, 'Could not save');

  const changePhoto = () =>
    run(async () => {
      const uri = await pickAvatarDataUri();
      if (uri) await store.updateInfo(conversationId, { avatarData: uri });
    }, 'Could not change photo');

  const createInvite = () =>
    run(async () => {
      const invite = await store.createInvite(conversationId, {
        expiresInSeconds: expiry,
        maxUses,
        requiresApproval: approval,
      });
      setInviteSheet(false);
      await shareLink(shareableInviteUrl(invite.token), `Join "${details.name}" on Vero`);
    }, 'Could not create link');

  const memberOptions = (m: GroupMemberInfo): SheetOption[] => {
    const actor = { id: me ?? '', role: myRole };
    const opts: SheetOption[] = [];
    if (m.id !== me) {
      opts.push({
        label: `Message ${m.displayName}`,
        icon: 'chatbubble-outline',
        onPress: () =>
          void run(async () => {
            const convId = await conversationRepository.createDirectConversation(m.id);
            router.push(`/chat/${convId}`);
          }, 'Could not open chat'),
      });
      opts.push({ label: 'View profile', icon: 'person-outline', onPress: () => router.push(`/profile/${m.id}`) });
    }
    if (canChangeRole(actor, m, 'admin')) {
      opts.push({ label: 'Make group admin', icon: 'shield-outline', onPress: () => void run(() => store.setRole(conversationId, m.id, 'admin'), 'Could not change role') });
    }
    if (canChangeRole(actor, m, 'member')) {
      opts.push({
        label: m.id === me ? 'Step down as admin' : 'Dismiss as admin',
        icon: 'shield-half-outline',
        onPress: () => void run(() => store.setRole(conversationId, m.id, 'member'), 'Could not change role'),
      });
    }
    if (canTransferOwnership(myRole) && m.id !== me) {
      opts.push({
        label: 'Transfer ownership',
        icon: 'key-outline',
        onPress: async () => {
          if (await confirmAction('Transfer ownership', `${m.displayName} will own this group and you'll stay an admin.`, 'Transfer')) {
            void run(() => store.transferOwnership(conversationId, m.id), 'Could not transfer');
          }
        },
      });
    }
    if (canRemoveMember(actor, m)) {
      opts.push({
        label: `Remove ${m.displayName}`,
        icon: 'person-remove-outline',
        destructive: true,
        onPress: async () => {
          if (await confirmAction('Remove member', `Remove ${m.displayName} from the group? Their devices stop receiving new messages.`, 'Remove', true)) {
            void run(() => store.removeMember(conversationId, m.id), 'Could not remove');
          }
        },
      });
    }
    return opts;
  };

  const leave = async () => {
    const owner = myRole === 'owner';
    const ok = await confirmAction(
      'Leave group',
      owner ? 'Ownership passes to the longest-serving admin (or member).' : 'You will stop receiving new messages from this group.',
      'Leave',
      true
    );
    if (!ok) return;
    await run(async () => {
      await store.leave(conversationId);
      void useChatsStore.getState().load({ sync: false });
      router.replace('/(tabs)/chats');
    }, 'Could not leave group');
  };

  const deleteGroup = async () => {
    const ok = await confirmAction(
      'Delete group',
      'Everyone is removed and the encrypted history is deleted from the server. This cannot be undone.',
      'Delete',
      true
    );
    if (!ok) return;
    await run(async () => {
      await store.deleteGroup(conversationId);
      void useChatsStore.getState().load({ sync: false });
      router.replace('/(tabs)/chats');
    }, 'Could not delete group');
  };

  return (
    <SafeAreaView style={gs.container} edges={['top']}>
      <ScreenHeader title="Group info" subtitle={`${members.length} members`} onBack={() => router.back()} right={busy ? <ActivityIndicator color={Colors.accent} /> : null} />
      <ScrollView contentContainerStyle={gs.scroll}>
        <View style={gs.hero}>
          <TouchableOpacity disabled={!editable} onPress={changePhoto} accessibilityLabel="Change group photo">
            <EntityAvatar name={details.name} dataUri={settings?.avatarData} size={88} icon="people" />
          </TouchableOpacity>
          {editing ? (
            <View style={{ alignSelf: 'stretch' }}>
              <TextInput style={gs.input} value={name} onChangeText={setName} maxLength={64} placeholder="Group name" placeholderTextColor={Colors.textTertiary} />
              <TextInput
                style={[gs.input, { minHeight: 70 }]}
                value={description}
                onChangeText={setDescription}
                maxLength={512}
                multiline
                placeholder="Description (optional)"
                placeholderTextColor={Colors.textTertiary}
              />
              <View style={{ flexDirection: 'row', justifyContent: 'center' }}>
                <PrimaryButton label="Save" onPress={saveInfo} disabled={!name.trim() || busy} />
                <PrimaryButton label="Cancel" onPress={() => setEditing(false)} />
              </View>
            </View>
          ) : (
            <>
              <Text style={gs.heroTitle}>{details.name}</Text>
              {!!settings?.description && <Text style={gs.heroSub}>{settings.description}</Text>}
              <Text style={gs.muted}>Group · {members.length} members</Text>
            </>
          )}
        </View>

        <Banner
          icon="lock-closed"
          text="Messages are end-to-end encrypted. The group's name, description, photo and member list are visible to Vero's servers."
        />

        {editable && !editing && (
          <>
            <Row icon="create-outline" label="Edit name and description" onPress={() => setEditing(true)} />
            <Row icon="image-outline" label="Change group photo" onPress={changePhoto} />
            {!!settings?.avatarData && (
              <Row icon="trash-outline" label="Remove group photo" onPress={() => void run(() => store.updateInfo(conversationId, { clearAvatar: true }), 'Could not remove photo')} />
            )}
          </>
        )}

        {details.community && (
          <Row
            icon="git-network-outline"
            label={details.community.isAnnouncements ? 'Community announcements' : 'Part of a community'}
            sublabel="Open community"
            onPress={() => router.push(`/communities/${details.community!.id}`)}
          />
        )}

        {isAdmin && settings && (
          <>
            <SectionHeader title="Group settings" />
            <ToggleRow
              label="Only admins can send messages"
              sublabel="Members can still read everything"
              value={settings.onlyAdminsSend}
              onChange={(v) => void run(() => store.setPermissions(conversationId, { onlyAdminsSend: v }), 'Could not update setting')}
            />
            <ToggleRow
              label="Only admins can edit group info"
              sublabel="Name, description and photo"
              value={settings.onlyAdminsEditInfo}
              onChange={(v) => void run(() => store.setPermissions(conversationId, { onlyAdminsEditInfo: v }), 'Could not update setting')}
            />
            <ToggleRow
              label="Approve new members"
              sublabel="People joining via a link need an admin's approval"
              value={settings.joinApprovalRequired}
              onChange={(v) => void run(() => store.setPermissions(conversationId, { joinApprovalRequired: v }), 'Could not update setting')}
            />
          </>
        )}

        {isAdmin && requests.length > 0 && (
          <>
            <SectionHeader title={`Join requests (${requests.length})`} />
            {requests.map((r) => (
              <Row
                key={r.id}
                icon="person-add-outline"
                label={r.user?.displayName ?? 'Someone'}
                sublabel={`${r.user?.username ? '@' + r.user.username + ' · ' : ''}via ${r.via === 'community' ? 'community' : 'invite link'}`}
                right={
                  <View style={{ flexDirection: 'row', gap: Spacing.md }}>
                    <TouchableOpacity onPress={() => void run(() => store.decideRequest(conversationId, r.id, false), 'Could not deny')}>
                      <Text style={{ color: Colors.error, fontWeight: Typography.semibold }}>Deny</Text>
                    </TouchableOpacity>
                    <TouchableOpacity onPress={() => void run(() => store.decideRequest(conversationId, r.id, true), 'Could not approve')}>
                      <Text style={{ color: Colors.accentLight, fontWeight: Typography.semibold }}>Approve</Text>
                    </TouchableOpacity>
                  </View>
                }
              />
            ))}
          </>
        )}

        {canManageInvites(myRole) && (
          <>
            <SectionHeader title="Invite links" />
            <Row icon="link-outline" label="Create invite link" sublabel="Anyone with the link can see the group's name and photo" onPress={() => setInviteSheet(true)} />
            {invites.map((inv) => {
              const state = inviteState(inv);
              const url = shareableInviteUrl(inv.token);
              const parts = [
                state === 'active' ? 'Active' : state[0].toUpperCase() + state.slice(1),
                `${inv.uses}${inv.maxUses != null ? '/' + inv.maxUses : ''} used`,
                inv.expiresAt ? `expires ${new Date(inv.expiresAt).toLocaleString()}` : 'never expires',
                inv.requiresApproval ? 'needs approval' : null,
              ].filter(Boolean);
              return (
                <Row
                  key={inv.id}
                  icon={state === 'active' ? 'link' : 'unlink-outline'}
                  label={`…${inv.token.slice(-8)}`}
                  sublabel={parts.join(' · ')}
                  disabled={state !== 'active'}
                  right={
                    state === 'active' ? (
                      <View style={{ flexDirection: 'row', gap: Spacing.md }}>
                        <TouchableOpacity onPress={() => void shareLink(url, `Join "${details.name}" on Vero`)}>
                          <Text style={{ color: Colors.accentLight }}>Share</Text>
                        </TouchableOpacity>
                        <TouchableOpacity onPress={() => void copyLink(url)}>
                          <Text style={{ color: Colors.accentLight }}>Copy</Text>
                        </TouchableOpacity>
                        <TouchableOpacity
                          onPress={async () => {
                            if (await confirmAction('Reset link', 'People can no longer join with this link.', 'Reset', true)) {
                              void run(() => store.revokeInvite(conversationId, inv.id), 'Could not reset link');
                            }
                          }}
                        >
                          <Text style={{ color: Colors.error }}>Reset</Text>
                        </TouchableOpacity>
                      </View>
                    ) : null
                  }
                />
              );
            })}
          </>
        )}

        <SectionHeader title={`${members.length} members`} />
        {canManageMembers(myRole) && (
          <Row icon="person-add-outline" label="Add members" onPress={() => router.push(`/group/add/${conversationId}`)} />
        )}
        {members.map((m) => (
          <Row
            key={m.id}
            label={m.id === me ? 'You' : m.displayName}
            sublabel={m.username ? `@${m.username}` : null}
            onPress={() => setMemberSheet(m)}
            right={m.role !== 'member' ? <Text style={{ color: Colors.accentLight, fontSize: Typography.xs }}>{m.role === 'owner' ? 'Owner' : 'Admin'}</Text> : null}
          />
        ))}

        <SectionHeader title="" />
        <Row icon="exit-outline" label="Leave group" danger onPress={() => void leave()} />
        {canDeleteGroup(myRole) && !details.community?.isAnnouncements && (
          <Row icon="trash-outline" label="Delete group for everyone" danger onPress={() => void deleteGroup()} />
        )}
      </ScrollView>

      <ActionSheet
        visible={!!memberSheet}
        title={memberSheet ? (memberSheet.id === me ? 'You' : memberSheet.displayName) : undefined}
        options={memberSheet ? memberOptions(memberSheet) : []}
        onClose={() => setMemberSheet(null)}
      />

      <Modal visible={inviteSheet} transparent animationType="fade" onRequestClose={() => setInviteSheet(false)}>
        <Pressable style={{ flex: 1, backgroundColor: Colors.overlay, justifyContent: 'flex-end' }} onPress={() => setInviteSheet(false)}>
          <Pressable style={{ backgroundColor: Colors.surfaceElevated, paddingVertical: Spacing.lg }} onPress={() => undefined}>
            <Text style={[gs.heroTitle, { fontSize: Typography.lg }]}>New invite link</Text>
            <SectionHeader title="Expires after" />
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.sm, paddingHorizontal: Spacing.base }}>
              {INVITE_EXPIRY_CHOICES.map((c) => (
                <TouchableOpacity key={c.label} style={[gs.chip, expiry === c.seconds && gs.chipActive]} onPress={() => setExpiry(c.seconds)}>
                  <Text style={[gs.chipText, expiry === c.seconds && gs.chipTextActive]}>{c.label}</Text>
                </TouchableOpacity>
              ))}
            </View>
            <SectionHeader title="Can be used by" />
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.sm, paddingHorizontal: Spacing.base }}>
              {INVITE_MAX_USES_CHOICES.map((c) => (
                <TouchableOpacity key={c.label} style={[gs.chip, maxUses === c.uses && gs.chipActive]} onPress={() => setMaxUses(c.uses)}>
                  <Text style={[gs.chipText, maxUses === c.uses && gs.chipTextActive]}>{c.label}</Text>
                </TouchableOpacity>
              ))}
            </View>
            <ToggleRow label="Admin approval required" value={approval} onChange={setApproval} />
            <PrimaryButton label="Create and share" onPress={() => void createInvite()} disabled={busy} />
          </Pressable>
        </Pressable>
      </Modal>
    </SafeAreaView>
  );
}
