import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Image,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import * as ImagePicker from 'expo-image-picker';
import dayjs from 'dayjs';
import { friendlyError } from '../../src/core/network/supabase';
import { useAuthStore } from '../../src/features/auth/useAuthStore';
import { conversationRepository } from '../../src/features/chats/ConversationRepository';
import { channelRepository } from '../../src/features/channels/ChannelRepository';
import {
  CHANNEL_REACTIONS,
  CHANNELS_E2EE_NOTICE,
  followersLabel,
  MAX_POST_LENGTH,
  sortedReactions,
} from '../../src/features/channels/channelUtils';
import { ChannelPost } from '../../src/features/channels/types';
import { channelsStore, useChannelRealtime, useChannelsStore } from '../../src/features/channels/useChannelsStore';
import { pickAvatarDataUri } from '../../src/features/groups/avatarPicker';
import { Banner, EntityAvatar, groupStyles as gs, PrimaryButton, Row, ScreenHeader, SectionHeader, ToggleRow } from '../../src/features/groups/components/GroupComponents';
import { ActionSheet, confirmAction, notify, SheetOption, shareLink } from '../../src/features/groups/components/ui';
import { INVITE_HOST, shareableInviteUrl } from '../../src/features/groups/config';
import { User } from '../../src/shared/models/Message';
import { BorderRadius, Colors, Spacing, Typography } from '../../src/shared/theme/theme';

const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

function PostImage({ path }: { path: string }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void channelRepository.imageUrl(path).then((u) => !cancelled && setUrl(u));
    return () => {
      cancelled = true;
    };
  }, [path]);
  if (!url) return <View style={{ height: 200, borderRadius: BorderRadius.md, backgroundColor: Colors.surfaceHighlight, marginBottom: Spacing.sm }} />;
  return <Image source={{ uri: url }} style={{ width: '100%', height: 220, borderRadius: BorderRadius.md, marginBottom: Spacing.sm }} resizeMode="cover" />;
}

function PostCard({
  post,
  myReaction,
  canReact,
  onReact,
  onLongPress,
}: {
  post: ChannelPost;
  myReaction: string | null;
  canReact: boolean;
  onReact: (emoji: string) => void;
  onLongPress?: () => void;
}) {
  const [picker, setPicker] = useState(false);
  return (
    <Pressable onLongPress={onLongPress} style={gs.card}>
      {post.mediaPath && <PostImage path={post.mediaPath} />}
      {!!post.body && <Text style={gs.body}>{post.body}</Text>}
      <Text style={[gs.muted, { marginTop: Spacing.xs, fontSize: Typography.xs }]}>
        {dayjs(post.createdAt).format('D MMM, HH:mm')}
        {post.editedAt ? ' · edited' : ''}
      </Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.xs, marginTop: Spacing.sm }}>
        {sortedReactions(post.reactionCounts).map(({ emoji, count }) => (
          <TouchableOpacity
            key={emoji}
            disabled={!canReact}
            onPress={() => onReact(emoji)}
            style={[gs.chip, { paddingVertical: 2 }, myReaction === emoji && gs.chipActive]}
          >
            <Text style={[gs.chipText, myReaction === emoji && gs.chipTextActive]}>
              {emoji} {count}
            </Text>
          </TouchableOpacity>
        ))}
        {canReact && (
          <TouchableOpacity onPress={() => setPicker((v) => !v)} style={[gs.chip, { paddingVertical: 2 }]} accessibilityLabel="React">
            <Ionicons name="happy-outline" size={16} color={Colors.textSecondary} />
          </TouchableOpacity>
        )}
      </View>
      {picker && (
        <View style={{ flexDirection: 'row', gap: Spacing.md, marginTop: Spacing.sm }}>
          {CHANNEL_REACTIONS.map((e) => (
            <TouchableOpacity
              key={e}
              onPress={() => {
                setPicker(false);
                onReact(e);
              }}
            >
              <Text style={{ fontSize: 24 }}>{e}</Text>
            </TouchableOpacity>
          ))}
        </View>
      )}
    </Pressable>
  );
}

export default function ChannelScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const channelId = id ?? '';
  const isDemo = useAuthStore((s) => s.isDemo);
  const channel = useChannelsStore((s) => s.channels[channelId]);
  const posts = useChannelsStore((s) => s.posts[channelId]) ?? [];
  const myReactions = useChannelsStore((s) => s.myReactions);
  const deleted = useChannelsStore((s) => s.deleted[channelId]);
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

  const react = (postId: string, emoji: string) =>
    void store.react(channelId, postId, emoji).catch((e) => notify('Reaction not saved', friendlyError(e)));

  const pickImage = async () => {
    try {
      const { granted } = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!granted) throw new Error('Allow photo library access in Settings to post photos.');
      const r = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 0.8 });
      const asset = r.assets?.[0];
      if (r.canceled || !asset) return;
      const mime = asset.mimeType && ALLOWED_IMAGE_TYPES.includes(asset.mimeType) ? asset.mimeType : 'image/jpeg';
      if ((asset.fileSize ?? 0) > 10 * 1024 * 1024) throw new Error('Images must be under 10 MB.');
      setImage({ uri: asset.uri, mime });
    } catch (e) {
      notify('Could not add photo', friendlyError(e));
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
      notify('Could not post', friendlyError(e));
    } finally {
      setPosting(false);
    }
  };

  const shareChannel = async () => {
    if (!channel) return;
    try {
      if (channel.visibility === 'private') {
        const token = await channelRepository.getInviteToken(channelId);
        if (!token) throw new Error('No invite link yet');
        await shareLink(shareableInviteUrl(token), `Follow "${channel.name}" on Vero`);
      } else {
        const url = INVITE_HOST ? `https://${INVITE_HOST}/channels/${channelId}` : `vero://channels/${channelId}`;
        await shareLink(url, `Follow "${channel.name}" (@${channel.handle}) on Vero`);
      }
    } catch (e) {
      notify('Could not share', friendlyError(e));
    }
  };

  const menuOptions = (): SheetOption[] => {
    if (!channel) return [];
    const o: SheetOption[] = [];
    if (channel.isFollowing) {
      o.push({
        label: channel.muted ? 'Unmute' : 'Mute',
        icon: channel.muted ? 'notifications-outline' : 'notifications-off-outline',
        onPress: () => void store.setMuted(channelId, !channel.muted).catch((e) => notify('Could not update', friendlyError(e))),
      });
    }
    if (channel.visibility === 'public' || isAdmin) o.push({ label: 'Share channel', icon: 'share-outline', onPress: () => void shareChannel() });
    if (isAdmin) {
      o.push({ label: 'Edit channel', icon: 'create-outline', onPress: () => setEditing(true) });
      if (channel.visibility === 'private') {
        o.push({
          label: 'Reset invite link',
          icon: 'refresh-outline',
          onPress: async () => {
            if (await confirmAction('Reset invite link', 'The old link stops working. Current followers keep following.', 'Reset')) {
              await channelRepository.rotateInvite(channelId).catch((e) => notify('Could not reset', friendlyError(e)));
            }
          },
        });
      }
      o.push({ label: 'Admins', icon: 'shield-outline', onPress: () => setAdminsOpen(true) });
    }
    if (channel.isFollowing) {
      o.push({
        label: 'Unfollow',
        icon: 'remove-circle-outline',
        destructive: true,
        onPress: () => void store.unfollow(channelId).catch((e) => notify('Could not unfollow', friendlyError(e))),
      });
    }
    if (isOwner) {
      o.push({
        label: 'Delete channel',
        icon: 'trash-outline',
        destructive: true,
        onPress: async () => {
          if (await confirmAction('Delete channel', 'All posts are deleted for every follower. This cannot be undone.', 'Delete', true)) {
            try {
              await channelRepository.remove(channelId);
              void store.loadMine().catch(() => undefined);
              router.back();
            } catch (e) {
              notify('Could not delete', friendlyError(e));
            }
          }
        },
      });
    }
    return o;
  };

  if (isDemo) {
    return (
      <SafeAreaView style={gs.container} edges={['top']}>
        <ScreenHeader title="Channel" onBack={() => router.back()} />
        <View style={gs.centered}>
          <Text style={gs.muted}>Channels need a real account.</Text>
        </View>
      </SafeAreaView>
    );
  }

  if (!channel || deleted) {
    return (
      <SafeAreaView style={gs.container} edges={['top']}>
        <ScreenHeader title="Channel" onBack={() => router.back()} />
        <View style={gs.centered}>
          {loading && !deleted ? (
            <ActivityIndicator color={Colors.accent} />
          ) : (
            <Text style={gs.muted}>{deleted ? 'This channel was deleted.' : loadError || "This channel doesn't exist or is private."}</Text>
          )}
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={gs.container} edges={['top', 'bottom']}>
      <ScreenHeader
        title={channel.name}
        subtitle={`@${channel.handle} · ${followersLabel(channel.followerCount)}${channel.visibility === 'private' ? ' · Private' : ''}`}
        onBack={() => router.back()}
        right={
          <TouchableOpacity onPress={() => setMenu(true)} style={{ padding: Spacing.sm }} accessibilityLabel="Channel options">
            <Ionicons name="ellipsis-vertical" size={20} color={Colors.textPrimary} />
          </TouchableOpacity>
        }
      />
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <FlatList
          data={posts}
          keyExtractor={(p) => p.id}
          onEndReached={() => void store.loadOlder(channelId).catch(() => undefined)}
          onEndReachedThreshold={0.4}
          ListHeaderComponent={
            <>
              <View style={gs.hero}>
                <EntityAvatar name={channel.name} dataUri={channel.avatarData} size={80} icon="megaphone" />
                {!!channel.description && <Text style={gs.heroSub}>{channel.description}</Text>}
              </View>
              <Banner icon="information-circle-outline" tone="warning" text={CHANNELS_E2EE_NOTICE} />
              {!channel.isFollowing && !isAdmin && (
                <PrimaryButton label="Follow" onPress={() => void store.follow(channelId).catch((e) => notify('Could not follow', friendlyError(e)))} />
              )}
            </>
          }
          ListEmptyComponent={
            <View style={gs.centered}>
              <Text style={gs.muted}>{isAdmin ? 'No updates yet. Post the first one below.' : 'No updates yet.'}</Text>
            </View>
          }
          renderItem={({ item }) => (
            <PostCard
              post={item}
              myReaction={myReactions[item.id] ?? null}
              canReact={canReact}
              onReact={(e) => react(item.id, e)}
              onLongPress={isAdmin ? () => setPostMenu(item) : undefined}
            />
          )}
        />

        {isAdmin && (
          <View style={{ borderTopWidth: 1, borderTopColor: Colors.divider, padding: Spacing.sm }}>
            {image && (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: Spacing.sm, marginBottom: Spacing.sm }}>
                <Image source={{ uri: image.uri }} style={{ width: 48, height: 48, borderRadius: BorderRadius.sm }} />
                <TouchableOpacity onPress={() => setImage(null)}>
                  <Text style={{ color: Colors.error }}>Remove</Text>
                </TouchableOpacity>
              </View>
            )}
            <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: Spacing.sm }}>
              <TouchableOpacity onPress={() => void pickImage()} style={{ padding: Spacing.sm }} accessibilityLabel="Add photo">
                <Ionicons name="image-outline" size={24} color={Colors.accent} />
              </TouchableOpacity>
              <TextInput
                style={[gs.input, { flex: 1, marginHorizontal: 0, marginBottom: 0, maxHeight: 120 }]}
                value={draft}
                onChangeText={setDraft}
                multiline
                maxLength={MAX_POST_LENGTH}
                placeholder="Post an update (not end-to-end encrypted)"
                placeholderTextColor={Colors.textTertiary}
              />
              <TouchableOpacity onPress={() => void publish()} disabled={posting || (!draft.trim() && !image)} style={{ padding: Spacing.sm }} accessibilityLabel="Post">
                {posting ? <ActivityIndicator color={Colors.accent} /> : <Ionicons name="send" size={22} color={draft.trim() || image ? Colors.accent : Colors.textTertiary} />}
              </TouchableOpacity>
            </View>
          </View>
        )}
      </KeyboardAvoidingView>

      <ActionSheet visible={menu} title={channel.name} options={menuOptions()} onClose={() => setMenu(false)} />
      <ActionSheet
        visible={!!postMenu}
        title="Update"
        options={
          postMenu
            ? [
                {
                  label: 'Delete update',
                  icon: 'trash-outline',
                  destructive: true,
                  onPress: async () => {
                    const p = postMenu;
                    if (await confirmAction('Delete update', 'Remove this update for all followers?', 'Delete', true)) {
                      await store.deletePost(channelId, p).catch((e) => notify('Could not delete', friendlyError(e)));
                    }
                  },
                },
              ]
            : []
        }
        onClose={() => setPostMenu(null)}
      />
      {editing && <EditChannelModal channelId={channelId} onClose={() => setEditing(false)} />}
      {adminsOpen && <AdminsModal channelId={channelId} isOwner={isOwner} onClose={() => setAdminsOpen(false)} />}
    </SafeAreaView>
  );
}

function EditChannelModal({ channelId, onClose }: { channelId: string; onClose: () => void }) {
  const channel = useChannelsStore((s) => s.channels[channelId]);
  const [name, setName] = useState(channel?.name ?? '');
  const [description, setDescription] = useState(channel?.description ?? '');
  const [isPrivate, setIsPrivate] = useState(channel?.visibility === 'private');
  const [avatar, setAvatar] = useState<string | null | undefined>(undefined);
  const [saving, setSaving] = useState(false);

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
      notify('Could not save', friendlyError(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={{ flex: 1, backgroundColor: Colors.overlay, justifyContent: 'flex-end' }} onPress={onClose}>
        <Pressable style={{ backgroundColor: Colors.surfaceElevated, paddingVertical: Spacing.lg }} onPress={() => undefined}>
          <ScrollView keyboardShouldPersistTaps="handled">
            <View style={gs.hero}>
              <TouchableOpacity
                onPress={() =>
                  void pickAvatarDataUri()
                    .then((u) => u && setAvatar(u))
                    .catch((e) => notify('Could not use photo', friendlyError(e)))
                }
              >
                <EntityAvatar name={name || 'Channel'} dataUri={avatar === undefined ? channel?.avatarData : avatar} size={72} icon="megaphone" />
              </TouchableOpacity>
              <Text style={gs.muted}>Tap to change photo</Text>
              {(avatar ?? channel?.avatarData) && (
                <TouchableOpacity onPress={() => setAvatar(null)}>
                  <Text style={{ color: Colors.error }}>Remove photo</Text>
                </TouchableOpacity>
              )}
            </View>
            <SectionHeader title="Name" />
            <TextInput style={gs.input} value={name} onChangeText={setName} maxLength={64} placeholderTextColor={Colors.textTertiary} />
            <SectionHeader title="Description" />
            <TextInput style={[gs.input, { minHeight: 70 }]} value={description} onChangeText={setDescription} maxLength={1024} multiline placeholderTextColor={Colors.textTertiary} />
            <ToggleRow label="Private channel" sublabel="Hidden from search; followed via invite link" value={isPrivate} onChange={setIsPrivate} />
            <PrimaryButton label="Save" onPress={() => void save()} disabled={saving || !name.trim()} />
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function AdminsModal({ channelId, isOwner, onClose }: { channelId: string; isOwner: boolean; onClose: () => void }) {
  const me = useAuthStore((s) => s.user?.id);
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
    const t = setTimeout(() => {
      conversationRepository.searchUsers(query).then(setResults).catch(() => setResults([]));
    }, 300);
    return () => clearTimeout(t);
  }, [query]);

  const act = async (fn: () => Promise<void>) => {
    try {
      await fn();
      load();
    } catch (e) {
      notify('Could not update admins', friendlyError(e));
    }
  };

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={{ flex: 1, backgroundColor: Colors.overlay, justifyContent: 'flex-end' }} onPress={onClose}>
        <Pressable style={{ backgroundColor: Colors.surfaceElevated, paddingVertical: Spacing.lg, maxHeight: '80%' }} onPress={() => undefined}>
          <ScrollView keyboardShouldPersistTaps="handled">
            <SectionHeader title="Admins can post and edit the channel" />
            {admins.map((a) => (
              <Row
                key={a.userId}
                label={a.userId === me ? 'You' : a.displayName}
                sublabel={`@${a.username} · ${a.role === 'owner' ? 'Owner' : 'Admin'}`}
                right={
                  a.role === 'admin' && (isOwner || a.userId === me) ? (
                    <TouchableOpacity onPress={() => void act(() => channelRepository.removeAdmin(channelId, a.userId))}>
                      <Text style={{ color: Colors.error }}>{a.userId === me ? 'Step down' : 'Remove'}</Text>
                    </TouchableOpacity>
                  ) : null
                }
              />
            ))}
            {isOwner && (
              <>
                <SectionHeader title="Add an admin" />
                <TextInput
                  style={gs.input}
                  value={query}
                  onChangeText={setQuery}
                  autoCapitalize="none"
                  placeholder="Search by name or @username"
                  placeholderTextColor={Colors.textTertiary}
                />
                {results
                  .filter((u) => !admins.some((a) => a.userId === u.id))
                  .map((u) => (
                    <Row
                      key={u.id}
                      label={u.displayName}
                      sublabel={`@${u.username}`}
                      onPress={() =>
                        void act(async () => {
                          await channelRepository.addAdmin(channelId, u.id);
                          setQuery('');
                        })
                      }
                      right={<Ionicons name="add-circle-outline" size={22} color={Colors.accent} />}
                    />
                  ))}
              </>
            )}
            <PrimaryButton label="Done" onPress={onClose} />
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}
