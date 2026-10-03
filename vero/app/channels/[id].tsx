import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, FlatList, Image, KeyboardAvoidingView, Platform, ScrollView, Text, TextInput, View } from 'react-native';
import Animated, { FadeIn, FadeInDown, ZoomIn } from 'react-native-reanimated';
import { router, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as ImagePicker from 'expo-image-picker';
import dayjs from 'dayjs';
import { friendlyError } from '../../src/core/network/supabase';
import { useAuthStore } from '../../src/features/auth/useAuthStore';
import { conversationRepository } from '../../src/features/chats/ConversationRepository';
import { channelRepository } from '../../src/features/channels/ChannelRepository';
import { CHANNEL_REACTIONS, formatCount, MAX_POST_LENGTH, sortedReactions } from '../../src/features/channels/channelUtils';
import { ChannelPost } from '../../src/features/channels/types';
import { channelsStore, useChannelRealtime, useChannelsStore } from '../../src/features/channels/useChannelsStore';
import { pickAvatarDataUri } from '../../src/features/groups/avatarPicker';
import { Banner, EntityAvatar, Row, ScreenHeader, SectionHeader, ToggleRow, useGroupStyles } from '../../src/features/groups/components/GroupComponents';
import { ActionSheet, confirmAction, notify, SheetOption, shareLink } from '../../src/features/groups/components/ui';
import { INVITE_HOST, shareableInviteUrl } from '../../src/features/groups/config';
import { User } from '../../src/shared/models/Message';
import { makeStyles, useTheme } from '../../src/shared/theme/ThemeProvider';
import { useT } from '../../src/shared/i18n';
import { Avatar, Button, DotWall, EmptyState, Icon, IconButton, Pill, Pressy, SearchField, Sheet, TextField } from '../../src/shared/ui';

const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

function PostImage({ path }: { path: string }) {
  const { c } = useTheme();
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void channelRepository.imageUrl(path).then((u) => !cancelled && setUrl(u));
    return () => {
      cancelled = true;
    };
  }, [path]);
  if (!url) return <View style={{ height: 220, borderRadius: 16, backgroundColor: c.field, marginBottom: 10 }} />;
  return (
    <Animated.View entering={FadeIn}>
      <Image source={{ uri: url }} style={{ width: '100%', height: 240, borderRadius: 16, marginBottom: 10 }} resizeMode="cover" />
    </Animated.View>
  );
}

function PostCard({ post, index, myReaction, canReact, onReact, onLongPress }: {
  post: ChannelPost;
  index: number;
  myReaction: string | null;
  canReact: boolean;
  onReact: (emoji: string) => void;
  onLongPress?: () => void;
}) {
  const { c, type } = useTheme();
  const s = useStyles();
  const t = useT();
  const [picker, setPicker] = useState(false);
  return (
    <Animated.View entering={FadeInDown.delay(Math.min(index, 6) * 40).springify().damping(18)}>
      <Pressy onLongPress={onLongPress} scaleTo={onLongPress ? 0.99 : 1} style={s.post}>
        {post.mediaPath && <PostImage path={post.mediaPath} />}
        {!!post.body && <Text style={[type.body, { fontSize: 15.5 }]}>{post.body}</Text>}
        <Text style={[type.caption, { marginTop: 8 }]}>
          {dayjs(post.createdAt).format('D MMM, HH:mm')}
          {post.editedAt ? ` · ${t('thread.edited')}` : ''}
        </Text>
        <View style={s.reactions}>
          {sortedReactions(post.reactionCounts).map(({ emoji, count }) => (
            <Pressy
              key={emoji}
              disabled={!canReact}
              onPress={() => onReact(emoji)}
              scaleTo={0.9}
              style={[s.reaction, myReaction === emoji && { backgroundColor: c.accentTint2, borderColor: c.accentLine }]}
              accessibilityLabel={`${emoji} ${count}`}
            >
              <Text style={{ fontSize: 14 }}>{emoji}</Text>
              <Text style={[s.reactionCount, myReaction === emoji && { color: c.accentText }]}>{count}</Text>
            </Pressy>
          ))}
          {canReact && (
            <Pressy onPress={() => setPicker((v) => !v)} scaleTo={0.9} style={s.reaction} accessibilityLabel={t('channels.react')}>
              <Icon name="smile" size={16} color={c.muted} />
            </Pressy>
          )}
        </View>
        {picker && (
          <Animated.View entering={ZoomIn.springify().damping(15)} style={s.picker}>
            {CHANNEL_REACTIONS.map((e) => (
              <Pressy
                key={e}
                onPress={() => {
                  setPicker(false);
                  onReact(e);
                }}
                scaleTo={0.8}
                style={s.pickerItem}
                accessibilityLabel={e}
              >
                <Text style={{ fontSize: 24 }}>{e}</Text>
              </Pressy>
            ))}
          </Animated.View>
        )}
      </Pressy>
    </Animated.View>
  );
}

export default function ChannelScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const channelId = id ?? '';
  const insets = useSafeAreaInsets();
  const { c, type } = useTheme();
  const gs = useGroupStyles();
  const s = useStyles();
  const t = useT();
  const isDemo = useAuthStore((st) => st.isDemo);
  const channel = useChannelsStore((st) => st.channels[channelId]);
  const posts = useChannelsStore((st) => st.posts[channelId]) ?? [];
  const myReactions = useChannelsStore((st) => st.myReactions);
  const deleted = useChannelsStore((st) => st.deleted[channelId]);
  const store = channelsStore.getState();

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [image, setImage] = useState<{ uri: string; mime: string } | null>(null);
  const [posting, setPosting] = useState(false);
  const [menu, setMenu] = useState(false);
  const [postMenu, setPostMenu] = useState<ChannelPost | null>(null);
  const [editing, setEditing] = useState(false);
  const [adminsOpen, setAdminsOpen] = useState(false);

  useChannelRealtime(channelId, !isDemo && !!channel);

  const reload = useCallback(async () => {
    try {
      await channelsStore.getState().open(channelId);
      setLoadError(null);
    } catch (e) {
      setLoadError(friendlyError(e));
    } finally {
      setLoading(false);
    }
  }, [channelId]);

  useEffect(() => {
    if (!isDemo && channelId) void reload();
  }, [channelId, isDemo, reload]);

  const isAdmin = !!channel?.myRole;
  const isOwner = channel?.myRole === 'owner';
  const canReact = !!channel && (channel.isFollowing || isAdmin || channel.visibility === 'public');
  const back = () => (router.canGoBack() ? router.back() : router.replace('/channels'));

  const react = (postId: string, emoji: string) => void store.react(channelId, postId, emoji).catch((e) => notify(t('channels.reactFailed'), friendlyError(e)));

  const pickImage = async () => {
    try {
      const { granted } = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!granted) throw new Error(t('channels.photoPermission'));
      const r = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 0.8 });
      const asset = r.assets?.[0];
      if (r.canceled || !asset) return;
      const mime = asset.mimeType && ALLOWED_IMAGE_TYPES.includes(asset.mimeType) ? asset.mimeType : 'image/jpeg';
      if ((asset.fileSize ?? 0) > 10 * 1024 * 1024) throw new Error(t('channels.photoTooBig'));
      setImage({ uri: asset.uri, mime });
    } catch (e) {
      notify(t('channels.photoFailed'), friendlyError(e));
    }
  };

  const publish = async () => {
    if (!draft.trim() && !image) return;
    setPosting(true);
    try {
      const media = image ? { path: await channelRepository.uploadImage(channelId, image.uri, image.mime), mime: image.mime } : null;
      await store.publish(channelId, draft.trim() || null, media);
      setDraft('');
      setImage(null);
    } catch (e) {
      notify(t('channels.postFailed'), friendlyError(e));
    } finally {
      setPosting(false);
    }
  };

  const shareChannel = async () => {
    if (!channel) return;
    try {
      if (channel.visibility === 'private') {
        const token = await channelRepository.getInviteToken(channelId);
        if (!token) throw new Error(t('channels.noInvite'));
        await shareLink(shareableInviteUrl(token), t('channels.followShare', { name: channel.name }));
      } else {
        const url = INVITE_HOST ? `https://${INVITE_HOST}/channels/${channelId}` : `vero://channels/${channelId}`;
        await shareLink(url, t('channels.followShareHandle', { name: channel.name, handle: channel.handle }));
      }
    } catch (e) {
      notify(t('channels.shareFailed'), friendlyError(e));
    }
  };

  const menuOptions = (): SheetOption[] => {
    if (!channel) return [];
    const o: SheetOption[] = [];
    if (channel.isFollowing) {
      o.push({
        label: channel.muted ? t('channels.unmute') : t('channels.mute'),
        icon: channel.muted ? 'bell' : 'bellOff',
        onPress: () => void store.setMuted(channelId, !channel.muted).catch((e) => notify(t('channels.updateFailed'), friendlyError(e))),
      });
    }
    if (channel.visibility === 'public' || isAdmin) o.push({ label: t('channels.share'), icon: 'share', onPress: () => void shareChannel() });
    if (isAdmin) {
      o.push({ label: t('channels.edit'), icon: 'edit', onPress: () => setEditing(true) });
      if (channel.visibility === 'private') {
        o.push({
          label: t('channels.resetInvite'),
          icon: 'link',
          onPress: async () => {
            if (await confirmAction(t('channels.resetInvite'), t('channels.resetInviteBody'), t('groups.reset'))) {
              await channelRepository.rotateInvite(channelId).catch((e) => notify(t('groups.resetFailed'), friendlyError(e)));
            }
          },
        });
      }
      o.push({ label: t('channels.admins'), icon: 'shieldCheck', onPress: () => setAdminsOpen(true) });
    }
    if (channel.isFollowing) {
      o.push({ label: t('channels.unfollow'), icon: 'close', destructive: true, onPress: () => void store.unfollow(channelId).catch((e) => notify(t('channels.unfollowFailed'), friendlyError(e))) });
    }
    if (isOwner) {
      o.push({
        label: t('channels.delete'),
        icon: 'trash',
        destructive: true,
        onPress: async () => {
          if (await confirmAction(t('channels.delete'), t('channels.deleteBody'), t('common.delete'), true)) {
            try {
              await channelRepository.remove(channelId);
              void store.loadMine().catch(() => undefined);
              back();
            } catch (e) {
              notify(t('thread.deleteFailed'), friendlyError(e));
            }
          }
        },
      });
    }
    return o;
  };

  if (isDemo || !channel || deleted) {
    return (
      <View style={[gs.container, { paddingTop: insets.top }]}>
        <ScreenHeader title={t('channels.channel')} onBack={back} />
        <View style={gs.centered}>
          {isDemo ? (
            <Text style={gs.muted}>{t('channels.demo')}</Text>
          ) : loading && !deleted ? (
            <ActivityIndicator color={c.accent} />
          ) : (
            <Text style={gs.muted}>{deleted ? t('channels.deleted') : loadError || t('channels.missing')}</Text>
          )}
        </View>
      </View>
    );
  }

  const followers = t('channels.followers', { count: channel.followerCount, n: formatCount(channel.followerCount) });
  const canPost = !!draft.trim() || !!image;

  return (
    <View style={[gs.container, { paddingTop: insets.top }]}>
      <ScreenHeader
        title={channel.name}
        subtitle={`@${channel.handle} · ${followers}${channel.visibility === 'private' ? ` · ${t('channels.privateShort')}` : ''}`}
        onBack={back}
        right={<IconButton icon="more" label={t('channels.options')} onPress={() => setMenu(true)} />}
      />
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <DotWall />
        <FlatList
          data={posts}
          keyExtractor={(p) => p.id}
          onEndReached={() => void store.loadOlder(channelId).catch(() => undefined)}
          onEndReachedThreshold={0.4}
          contentContainerStyle={s.feed}
          ListHeaderComponent={
            <View style={{ gap: 4, marginBottom: 6 }}>
              <View style={gs.hero}>
                <Animated.View entering={ZoomIn.springify().damping(14)}>
                  <EntityAvatar name={channel.name} dataUri={channel.avatarData} size={88} icon="megaphone" />
                </Animated.View>
                <Text style={gs.heroTitle}>{channel.name}</Text>
                {!!channel.description && <Text style={gs.heroSub}>{channel.description}</Text>}
                <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap', justifyContent: 'center' }}>
                  <Pill icon="users" label={followers} tone="brass" />
                  {channel.muted && <Pill icon="bellOff" label={t('channels.muted')} tone="stage" />}
                </View>
                {!channel.isFollowing && !isAdmin && (
                  <Button
                    label={t('channels.follow')}
                    icon="plus"
                    size="md"
                    onPress={() => void store.follow(channelId).catch((e) => notify(t('channels.followFailed'), friendlyError(e)))}
                    style={{ marginTop: 6, paddingHorizontal: 28 }}
                  />
                )}
              </View>
              <View style={{ marginHorizontal: -16 }}>
                <Banner icon="info" tone="warning" text={t('channels.notice')} />
              </View>
            </View>
          }
          ListEmptyComponent={<EmptyState icon="megaphone" title={t('channels.noUpdates')} body={isAdmin ? t('channels.noUpdatesAdmin') : t('channels.noUpdatesBody')} />}
          renderItem={({ item, index }) => (
            <PostCard post={item} index={index} myReaction={myReactions[item.id] ?? null} canReact={canReact} onReact={(e) => react(item.id, e)} onLongPress={isAdmin ? () => setPostMenu(item) : undefined} />
          )}
        />

        {isAdmin && (
          <View style={[s.composerWrap, { paddingBottom: Math.max(insets.bottom, 12) }]}>
            <View style={s.composerInner}>
              {image && (
                <Animated.View entering={FadeInDown} style={s.attachment}>
                  <Image source={{ uri: image.uri }} style={{ width: 52, height: 52, borderRadius: 12 }} />
                  <Text style={[type.caption, { flex: 1 }]}>{t('channels.photoAttached')}</Text>
                  <IconButton icon="close" label={t('channels.removePhoto')} size={36} onPress={() => setImage(null)} />
                </Animated.View>
              )}
              <View style={s.composer}>
                <IconButton icon="image" label={t('channels.addPhoto')} variant="filled" size={46} onPress={() => void pickImage()} />
                <View style={s.field}>
                  <TextInput
                    style={s.input}
                    value={draft}
                    onChangeText={setDraft}
                    multiline
                    maxLength={MAX_POST_LENGTH}
                    placeholder={t('channels.postPlaceholder')}
                    placeholderTextColor={c.faint}
                    selectionColor={c.accent}
                    {...(Platform.OS === 'web' ? { numberOfLines: 1 } : {})}
                  />
                </View>
                <IconButton icon="send" label={t('channels.post')} variant={canPost ? 'brass' : 'filled'} size={46} disabled={posting || !canPost} onPress={() => void publish()} />
              </View>
            </View>
          </View>
        )}
      </KeyboardAvoidingView>

      <ActionSheet visible={menu} title={channel.name} options={menuOptions()} onClose={() => setMenu(false)} />
      <ActionSheet
        visible={!!postMenu}
        title={t('channels.update')}
        options={
          postMenu
            ? [
                {
                  label: t('channels.deleteUpdate'),
                  icon: 'trash',
                  destructive: true,
                  onPress: async () => {
                    const p = postMenu;
                    if (await confirmAction(t('channels.deleteUpdate'), t('channels.deleteUpdateBody'), t('common.delete'), true)) {
                      await store.deletePost(channelId, p).catch((e) => notify(t('thread.deleteFailed'), friendlyError(e)));
                    }
                  },
                },
              ]
            : []
        }
        onClose={() => setPostMenu(null)}
      />
      <EditChannelSheet channelId={channelId} visible={editing} onClose={() => setEditing(false)} />
      {adminsOpen && <AdminsSheet channelId={channelId} isOwner={isOwner} onClose={() => setAdminsOpen(false)} />}
    </View>
  );
}

function EditChannelSheet({ channelId, visible, onClose }: { channelId: string; visible: boolean; onClose: () => void }) {
  const { c, type } = useTheme();
  const t = useT();
  const channel = useChannelsStore((st) => st.channels[channelId]);
  const [name, setName] = useState(channel?.name ?? '');
  const [description, setDescription] = useState(channel?.description ?? '');
  const [isPrivate, setIsPrivate] = useState(channel?.visibility === 'private');
  const [avatar, setAvatar] = useState<string | null | undefined>(undefined);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!visible) return;
    setName(channel?.name ?? '');
    setDescription(channel?.description ?? '');
    setIsPrivate(channel?.visibility === 'private');
    setAvatar(undefined);
  }, [visible]);

  const save = async () => {
    setSaving(true);
    try {
      await channelRepository.update(channelId, {
        name: name.trim(),
        description: description.trim(),
        visibility: isPrivate ? 'private' : 'public',
        avatarData: avatar || undefined,
        clearAvatar: avatar === null,
      });
      await channelsStore.getState().open(channelId);
      onClose();
    } catch (e) {
      notify(t('groups.saveFailed'), friendlyError(e));
    } finally {
      setSaving(false);
    }
  };

  const shown = avatar === undefined ? channel?.avatarData : avatar;
  return (
    <Sheet visible={visible} onClose={onClose} title={t('channels.edit')}>
      <ScrollView keyboardShouldPersistTaps="handled" style={{ maxHeight: 520 }} contentContainerStyle={{ gap: 14 }}>
        <View style={{ alignItems: 'center', gap: 8 }}>
          <Pressy
            onPress={() =>
              void pickAvatarDataUri()
                .then((u) => u && setAvatar(u))
                .catch((e) => notify(t('groups.photoFailed'), friendlyError(e)))
            }
            scaleTo={0.95}
            accessibilityLabel={t('groups.changePhoto')}
          >
            <EntityAvatar name={name || t('channels.channel')} dataUri={shown} size={76} icon="megaphone" />
          </Pressy>
          <Text style={type.caption}>{t('channels.tapPhoto')}</Text>
          {!!shown && <Button label={t('channels.removePhoto')} variant="dangerSoft" size="sm" onPress={() => setAvatar(null)} />}
        </View>
        <TextField label={t('channels.name')} value={name} onChangeText={setName} maxLength={64} />
        <TextField label={t('channels.description')} value={description} onChangeText={setDescription} maxLength={1024} multiline />
        <View style={{ marginHorizontal: -16 }}>
          <ToggleRow label={t('channels.private')} sublabel={t('channels.privateHint')} value={isPrivate} onChange={setIsPrivate} />
        </View>
        <Button label={t('common.save')} loading={saving} disabled={!name.trim()} onPress={() => void save()} />
      </ScrollView>
    </Sheet>
  );
}

function AdminsSheet({ channelId, isOwner, onClose }: { channelId: string; isOwner: boolean; onClose: () => void }) {
  const t = useT();
  const me = useAuthStore((st) => st.user?.id);
  const [admins, setAdmins] = useState<{ userId: string; role: 'owner' | 'admin'; displayName: string; username: string }[]>([]);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<User[]>([]);

  const load = useCallback(() => {
    channelRepository.listAdmins(channelId).then(setAdmins).catch(() => undefined);
  }, [channelId]);
  useEffect(load, [load]);

  useEffect(() => {
    if (query.trim().length < 2) {
      setResults([]);
      return;
    }
    const timer = setTimeout(() => {
      conversationRepository.searchUsers(query).then(setResults).catch(() => setResults([]));
    }, 300);
    return () => clearTimeout(timer);
  }, [query]);

  const act = async (fn: () => Promise<void>) => {
    try {
      await fn();
      load();
    } catch (e) {
      notify(t('channels.adminsFailed'), friendlyError(e));
    }
  };

  return (
    <Sheet visible onClose={onClose} title={t('channels.admins')}>
      <ScrollView keyboardShouldPersistTaps="handled" style={{ maxHeight: 520 }}>
        <View style={{ marginHorizontal: -16 }}>
          <SectionHeader title={t('channels.adminsHint')} />
          {admins.map((a) => (
            <Row
              key={a.userId}
              label={a.userId === me ? t('common.you') : a.displayName}
              sublabel={`@${a.username} · ${a.role === 'owner' ? t('thread.role_owner') : t('thread.role_admin')}`}
              right={
                a.role === 'admin' && (isOwner || a.userId === me) ? (
                  <Button
                    label={a.userId === me ? t('groups.stepDown') : t('groups.removeConfirm')}
                    variant="dangerSoft"
                    size="sm"
                    onPress={() => void act(() => channelRepository.removeAdmin(channelId, a.userId))}
                  />
                ) : null
              }
            />
          ))}
          {isOwner && (
            <>
              <SectionHeader title={t('channels.addAdmin')} />
              <SearchField value={query} onChangeText={setQuery} placeholder={t('newGroup.search')} onClear={() => setQuery('')} style={{ marginHorizontal: 16, marginBottom: 6 }} />
              {results
                .filter((u) => !admins.some((a) => a.userId === u.id))
                .map((u) => (
                  <Row
                    key={u.id}
                    icon="userPlus"
                    label={u.displayName}
                    sublabel={`@${u.username}`}
                    onPress={() =>
                      void act(async () => {
                        await channelRepository.addAdmin(channelId, u.id);
                        setQuery('');
                      })
                    }
                  />
                ))}
            </>
          )}
        </View>
      </ScrollView>
      <Button label={t('common.done')} variant="ghost" onPress={onClose} />
    </Sheet>
  );
}

const useStyles = makeStyles((c, t, f) => ({
  feed: { width: '100%', maxWidth: 680, alignSelf: 'center', paddingHorizontal: 16, paddingBottom: 24, gap: 12 },
  post: { backgroundColor: c.panel, borderRadius: 22, borderWidth: 1, borderColor: c.line, padding: 14 },
  reactions: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 10 },
  reaction: { flexDirection: 'row', alignItems: 'center', gap: 5, height: 30, paddingHorizontal: 10, borderRadius: 15, backgroundColor: c.raised, borderWidth: 1, borderColor: c.line },
  reactionCount: { fontFamily: f.mono, fontSize: 12, color: c.muted },
  picker: { flexDirection: 'row', gap: 4, marginTop: 10, padding: 6, borderRadius: 22, backgroundColor: c.raised, alignSelf: 'flex-start', borderWidth: 1, borderColor: c.line },
  pickerItem: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  composerWrap: { borderTopWidth: 1, borderTopColor: c.line, backgroundColor: c.panel, paddingTop: 10, paddingHorizontal: 12 },
  composerInner: { width: '100%', maxWidth: 680, alignSelf: 'center', gap: 8 },
  attachment: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 6, borderRadius: 16, backgroundColor: c.raised },
  composer: { flexDirection: 'row', alignItems: 'flex-end', gap: 8 },
  field: { flex: 1, minHeight: 46, borderRadius: 23, backgroundColor: c.field, borderWidth: 1, borderColor: c.line, paddingHorizontal: 16, justifyContent: 'center' },
  input: { fontFamily: f.body, fontSize: 15.5, color: c.text, paddingVertical: 11, maxHeight: 120, outlineStyle: 'none' } as any,
}));
