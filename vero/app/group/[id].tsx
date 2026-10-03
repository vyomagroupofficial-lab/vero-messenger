import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, ScrollView, Text, TextInput, View } from 'react-native';
import Animated, { FadeIn, ZoomIn } from 'react-native-reanimated';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import dayjs from 'dayjs';
import { friendlyError } from '../../src/core/network/supabase';
import { useAuthStore } from '../../src/features/auth/useAuthStore';
import { conversationRepository } from '../../src/features/chats/ConversationRepository';
import { useChatsStore } from '../../src/features/chats/useChatsStore';
import { pickAvatarDataUri } from '../../src/features/groups/avatarPicker';
import { Banner, EntityAvatar, PrimaryButton, Row, ScreenHeader, SectionHeader, ToggleRow, useGroupStyles } from '../../src/features/groups/components/GroupComponents';
import { ActionSheet, confirmAction, copyLink, notify, SheetOption, shareLink } from '../../src/features/groups/components/ui';
import { shareableInviteUrl } from '../../src/features/groups/config';
import { INVITE_EXPIRY_CHOICES, INVITE_MAX_USES_CHOICES, inviteState } from '../../src/features/groups/inviteLinks';
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
import { makeStyles, useTheme } from '../../src/shared/theme/ThemeProvider';
import { useT } from '../../src/shared/i18n';
import { Avatar, Button, Chip, Icon, Pill, Pressy, Sheet } from '../../src/shared/ui';

export const expiryLabel = (t: (k: string, o?: any) => string, seconds: number | null) =>
  seconds == null ? t('groups.never') : seconds < 86400 ? t('groups.hours', { count: seconds / 3600 }) : t('groups.days', { count: seconds / 86400 });
export const usesLabel = (t: (k: string, o?: any) => string, uses: number | null) => (uses == null ? t('groups.noLimit') : t('groups.people', { count: uses }));

export default function GroupInfoScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const conversationId = id ?? '';
  const { c, type } = useTheme();
  const gs = useGroupStyles();
  const s = useStyles();
  const t = useT();
  const me = useAuthStore((st) => st.user?.id ?? null);
  const isDemo = useAuthStore((st) => st.isDemo);

  const details = useGroupStore((st) => st.details[conversationId]);
  const invites = useGroupStore((st) => st.invites[conversationId]) ?? [];
  const requests = useGroupStore((st) => st.requests[conversationId]) ?? [];
  const loading = useGroupStore((st) => st.loading[conversationId]);
  const error = useGroupStore((st) => st.errors[conversationId]);
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

  const back = () => (router.canGoBack() ? router.back() : router.replace('/(tabs)/chats'));

  if (isDemo || !details) {
    return (
      <SafeAreaView style={gs.container} edges={['top']}>
        <ScreenHeader title={t('groups.info')} onBack={back} />
        <View style={gs.centered}>
          {isDemo ? (
            <Text style={gs.muted}>{t('groups.demo')}</Text>
          ) : loading || details === undefined ? (
            <ActivityIndicator color={c.accent} />
          ) : (
            <Text style={gs.muted}>{error || t('groups.unavailable')}</Text>
          )}
        </View>
      </SafeAreaView>
    );
  }

  const editable = !!settings && canEditInfo(myRole, settings);
  const isAdmin = canChangeSettings(myRole);
  const joinTitle = t('groups.joinShare', { name: details.name });

  const saveInfo = () =>
    run(async () => {
      await store.updateInfo(conversationId, {
        name: name.trim() !== details.name ? name.trim() : undefined,
        description: description.trim() !== (settings?.description ?? '') ? description.trim() : undefined,
      });
      setEditing(false);
      void useChatsStore.getState().load({ sync: false });
    }, t('groups.saveFailed'));

  const changePhoto = () =>
    run(async () => {
      const uri = await pickAvatarDataUri();
      if (uri) await store.updateInfo(conversationId, { avatarData: uri });
    }, t('groups.photoFailed'));

  const createInvite = () =>
    run(async () => {
      const invite = await store.createInvite(conversationId, { expiresInSeconds: expiry, maxUses, requiresApproval: approval });
      setInviteSheet(false);
      await shareLink(shareableInviteUrl(invite.token), joinTitle);
    }, t('groups.linkFailed'));

  const memberOptions = (m: GroupMemberInfo): SheetOption[] => {
    const actor = { id: me ?? '', role: myRole };
    const opts: SheetOption[] = [];
    if (m.id !== me) {
      opts.push({
        label: t('groups.messagePerson', { name: m.displayName }),
        icon: 'chat',
        onPress: () =>
          void run(async () => {
            const convId = await conversationRepository.createDirectConversation(m.id);
            router.push(`/chat/${convId}`);
          }, t('thread.openFailed')),
      });
      opts.push({ label: t('thread.viewProfile'), icon: 'user', onPress: () => router.push(`/profile/${m.id}`) });
    }
    if (canChangeRole(actor, m, 'admin')) {
      opts.push({ label: t('groups.makeAdmin'), icon: 'shieldCheck', onPress: () => void run(() => store.setRole(conversationId, m.id, 'admin'), t('groups.roleFailed')) });
    }
    if (canChangeRole(actor, m, 'member')) {
      opts.push({
        label: m.id === me ? t('groups.stepDown') : t('groups.dismissAdmin'),
        icon: 'shield',
        onPress: () => void run(() => store.setRole(conversationId, m.id, 'member'), t('groups.roleFailed')),
      });
    }
    if (canTransferOwnership(myRole) && m.id !== me) {
      opts.push({
        label: t('groups.transfer'),
        icon: 'key',
        onPress: async () => {
          if (await confirmAction(t('groups.transfer'), t('groups.transferBody', { name: m.displayName }), t('groups.transferConfirm'))) {
            void run(() => store.transferOwnership(conversationId, m.id), t('groups.transferFailed'));
          }
        },
      });
    }
    if (canRemoveMember(actor, m)) {
      opts.push({
        label: t('groups.removePerson', { name: m.displayName }),
        icon: 'ban',
        destructive: true,
        onPress: async () => {
          if (await confirmAction(t('groups.removeTitle'), t('groups.removeBody', { name: m.displayName }), t('groups.removeConfirm'), true)) {
            void run(() => store.removeMember(conversationId, m.id), t('groups.removeFailed'));
          }
        },
      });
    }
    return opts;
  };

  const leave = async () => {
    const owner = myRole === 'owner';
    const ok = await confirmAction(t('thread.leave'), owner ? t('groups.leaveOwnerBody') : t('thread.leaveBody'), t('thread.leaveConfirm'), true);
    if (!ok) return;
    await run(async () => {
      await store.leave(conversationId);
      void useChatsStore.getState().load({ sync: false });
      router.replace('/(tabs)/chats');
    }, t('thread.leaveFailed'));
  };

  const deleteGroup = async () => {
    const ok = await confirmAction(t('groups.deleteTitle'), t('groups.deleteBody'), t('common.delete'), true);
    if (!ok) return;
    await run(async () => {
      await store.deleteGroup(conversationId);
      void useChatsStore.getState().load({ sync: false });
      router.replace('/(tabs)/chats');
    }, t('groups.deleteFailed'));
  };

  const roleLabel = (r: string) => (r === 'owner' ? t('thread.role_owner') : t('thread.role_admin'));

  return (
    <SafeAreaView style={gs.container} edges={['top']}>
      <ScreenHeader
        title={t('groups.info')}
        subtitle={t('thread.members', { count: members.length })}
        onBack={back}
        right={busy ? <ActivityIndicator color={c.accent} style={{ marginRight: 12 }} /> : null}
      />
      <ScrollView contentContainerStyle={gs.scroll}>
        <View style={gs.hero}>
          <Animated.View entering={ZoomIn.springify().damping(14)}>
            <Pressy disabled={!editable} onPress={changePhoto} scaleTo={0.95} accessibilityLabel={t('groups.changePhoto')}>
              <EntityAvatar name={details.name} dataUri={settings?.avatarData} size={96} icon="users" />
              {editable && (
                <View style={s.camBadge}>
                  <Icon name="camera" size={15} color={c.onAccent} />
                </View>
              )}
            </Pressy>
          </Animated.View>
          {editing ? (
            <Animated.View entering={FadeIn} style={{ alignSelf: 'stretch', gap: 4, paddingTop: 8 }}>
              <TextInput style={gs.input} value={name} onChangeText={setName} maxLength={64} placeholder={t('groups.namePlaceholder')} placeholderTextColor={c.placeholder} />
              <TextInput
                style={[gs.input, { minHeight: 84, textAlignVertical: 'top' }]}
                value={description}
                onChangeText={setDescription}
                maxLength={512}
                multiline
                placeholder={t('groups.descriptionPlaceholder')}
                placeholderTextColor={c.placeholder}
              />
              <View style={{ flexDirection: 'row', gap: 10, paddingHorizontal: 16 }}>
                <Button label={t('common.cancel')} variant="secondary" size="md" onPress={() => setEditing(false)} style={{ flex: 1 }} />
                <Button label={t('common.save')} size="md" onPress={saveInfo} disabled={!name.trim() || busy} style={{ flex: 1 }} />
              </View>
            </Animated.View>
          ) : (
            <Animated.View entering={FadeIn.delay(80)} style={{ alignItems: 'center', gap: 6 }}>
              <Text style={gs.heroTitle}>{details.name}</Text>
              {!!settings?.description && <Text style={gs.heroSub}>{settings.description}</Text>}
              <Pill icon="users" label={t('groups.groupMembers', { count: members.length })} tone="brass" />
            </Animated.View>
          )}
        </View>

        <Banner icon="lock" text={t('groups.metadataNote')} />

        {editable && !editing && (
          <>
            <Row icon="edit" label={t('groups.editInfo')} onPress={() => setEditing(true)} />
            <Row icon="image" label={t('groups.changePhoto')} onPress={changePhoto} />
            {!!settings?.avatarData && (
              <Row icon="trash" label={t('groups.removePhoto')} onPress={() => void run(() => store.updateInfo(conversationId, { clearAvatar: true }), t('groups.photoFailed'))} />
            )}
          </>
        )}

        {details.community && (
          <Row
            icon="grid"
            label={details.community.isAnnouncements ? t('groups.communityAnnouncements') : t('groups.partOfCommunity')}
            sublabel={t('groups.openCommunity')}
            onPress={() => router.push(`/communities/${details.community!.id}`)}
          />
        )}

        {isAdmin && settings && (
          <>
            <SectionHeader title={t('groups.settings')} />
            <ToggleRow
              label={t('thread.adminsOnly')}
              sublabel={t('groups.adminsOnlyHint')}
              value={settings.onlyAdminsSend}
              onChange={(v) => void run(() => store.setPermissions(conversationId, { onlyAdminsSend: v }), t('groups.settingFailed'))}
            />
            <ToggleRow
              label={t('groups.adminsEdit')}
              sublabel={t('groups.adminsEditHint')}
              value={settings.onlyAdminsEditInfo}
              onChange={(v) => void run(() => store.setPermissions(conversationId, { onlyAdminsEditInfo: v }), t('groups.settingFailed'))}
            />
            <ToggleRow
              label={t('groups.approve')}
              sublabel={t('groups.approveHint')}
              value={settings.joinApprovalRequired}
              onChange={(v) => void run(() => store.setPermissions(conversationId, { joinApprovalRequired: v }), t('groups.settingFailed'))}
            />
          </>
        )}

        {isAdmin && requests.length > 0 && (
          <>
            <SectionHeader title={t('groups.requests', { count: requests.length })} />
            {requests.map((r) => (
              <Row
                key={r.id}
                icon="userPlus"
                label={r.user?.displayName ?? t('common.someone')}
                sublabel={`${r.user?.username ? '@' + r.user.username + ' · ' : ''}${r.via === 'community' ? t('groups.viaCommunity') : t('groups.viaLink')}`}
                right={
                  <View style={{ flexDirection: 'row', gap: 8 }}>
                    <Button label={t('groups.deny')} variant="dangerSoft" size="sm" onPress={() => void run(() => store.decideRequest(conversationId, r.id, false), t('groups.denyFailed'))} />
                    <Button label={t('groups.approveBtn')} size="sm" onPress={() => void run(() => store.decideRequest(conversationId, r.id, true), t('groups.approveFailed'))} />
                  </View>
                }
              />
            ))}
          </>
        )}

        {canManageInvites(myRole) && (
          <>
            <SectionHeader title={t('groups.inviteLinks')} />
            <Row icon="link" label={t('groups.createLink')} sublabel={t('groups.createLinkHint')} onPress={() => setInviteSheet(true)} />
            {invites.map((inv) => {
              const state = inviteState(inv);
              const url = shareableInviteUrl(inv.token);
              const parts = [
                t(`groups.state_${state}`),
                inv.maxUses != null ? t('groups.usedOf', { uses: inv.uses, max: inv.maxUses }) : t('groups.used', { count: inv.uses }),
                inv.expiresAt ? t('groups.expires', { date: dayjs(inv.expiresAt).format('D MMM, HH:mm') }) : t('groups.neverExpires'),
                inv.requiresApproval ? t('groups.needsApproval') : null,
              ].filter(Boolean);
              return (
                <View key={inv.id} style={[s.invite, state !== 'active' && { opacity: 0.55 }]}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                    <View style={[s.inviteIcon, state === 'active' && { backgroundColor: c.successTint }]}>
                      <Text style={[type.mono, { fontSize: 11, color: state === 'active' ? c.success : c.faint }]}>{state === 'active' ? '●' : '○'}</Text>
                    </View>
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <Text style={[type.mono, { fontSize: 14 }]} numberOfLines={1}>{`…/${inv.token.slice(-8)}`}</Text>
                      <Text style={type.caption}>{parts.join(' · ')}</Text>
                    </View>
                  </View>
                  {state === 'active' && (
                    <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
                      <Button label={t('common.share')} icon="share" size="sm" variant="secondary" onPress={() => void shareLink(url, joinTitle)} />
                      <Button label={t('groups.copy')} icon="copy" size="sm" variant="secondary" onPress={() => void copyLink(url)} />
                      <Button
                        label={t('groups.reset')}
                        size="sm"
                        variant="dangerSoft"
                        onPress={async () => {
                          if (await confirmAction(t('groups.resetTitle'), t('groups.resetBody'), t('groups.reset'), true)) {
                            void run(() => store.revokeInvite(conversationId, inv.id), t('groups.resetFailed'));
                          }
                        }}
                      />
                    </View>
                  )}
                </View>
              );
            })}
          </>
        )}

        <SectionHeader title={t('thread.members', { count: members.length })} />
        {canManageMembers(myRole) && <Row icon="userPlus" label={t('groups.addMembers')} onPress={() => router.push(`/group/add/${conversationId}`)} />}
        {members.map((m) => (
          <Pressy key={m.id} onPress={() => setMemberSheet(m)} scaleTo={0.985} hoverStyle={{ backgroundColor: c.tint }} style={s.member} accessibilityLabel={m.displayName}>
            <Avatar name={m.displayName} size={42} />
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={s.memberName} numberOfLines={1}>
                {m.id === me ? t('common.you') : m.displayName}
              </Text>
              {m.username ? <Text style={s.handle}>@{m.username}</Text> : null}
            </View>
            {m.role !== 'member' && <Pill label={roleLabel(m.role)} tone={m.role === 'owner' ? 'brass' : 'sage'} />}
          </Pressy>
        ))}

        <SectionHeader title="" />
        <Row icon="logout" label={t('thread.leave')} danger onPress={() => void leave()} />
        {canDeleteGroup(myRole) && !details.community?.isAnnouncements && <Row icon="trash" label={t('groups.deleteTitle')} danger onPress={() => void deleteGroup()} />}
      </ScrollView>

      <ActionSheet
        visible={!!memberSheet}
        title={memberSheet ? (memberSheet.id === me ? t('common.you') : memberSheet.displayName) : undefined}
        options={memberSheet ? memberOptions(memberSheet) : []}
        onClose={() => setMemberSheet(null)}
      />

      <Sheet visible={inviteSheet} onClose={() => setInviteSheet(false)} title={t('groups.newLink')}>
        <View style={{ gap: 10 }}>
          <Text style={type.eyebrow}>{t('groups.expiresAfter')}</Text>
          <View style={s.chips}>
            {INVITE_EXPIRY_CHOICES.map((ch) => (
              <Chip key={String(ch.seconds)} label={expiryLabel(t, ch.seconds)} active={expiry === ch.seconds} onPress={() => setExpiry(ch.seconds)} />
            ))}
          </View>
          <Text style={[type.eyebrow, { marginTop: 6 }]}>{t('groups.usableBy')}</Text>
          <View style={s.chips}>
            {INVITE_MAX_USES_CHOICES.map((ch) => (
              <Chip key={String(ch.uses)} label={usesLabel(t, ch.uses)} active={maxUses === ch.uses} onPress={() => setMaxUses(ch.uses)} />
            ))}
          </View>
        </View>
        <View style={{ marginHorizontal: -8 }}>
          <ToggleRow label={t('groups.approvalRequired')} value={approval} onChange={setApproval} />
        </View>
        <Button label={t('groups.createAndShare')} icon="share" loading={busy} onPress={() => void createInvite()} />
      </Sheet>
    </SafeAreaView>
  );
}

const useStyles = makeStyles((c, t, f) => ({
  camBadge: { position: 'absolute', right: -4, bottom: -4, width: 32, height: 32, borderRadius: 16, backgroundColor: c.accent, borderWidth: 3, borderColor: c.bg, alignItems: 'center', justifyContent: 'center' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  invite: { marginHorizontal: 16, marginBottom: 10, padding: 14, gap: 12, borderRadius: 18, backgroundColor: c.panel, borderWidth: 1, borderColor: c.line },
  inviteIcon: { width: 28, height: 28, borderRadius: 9, backgroundColor: c.raised, alignItems: 'center', justifyContent: 'center' },
  member: { flexDirection: 'row', alignItems: 'center', gap: 12, marginHorizontal: 8, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 16 },
  memberName: { fontFamily: f.semibold, fontSize: 15.5, color: c.text },
  handle: { fontFamily: f.script === 'latin' ? f.mono : f.body, fontSize: 12.5, color: c.muted },
}));
