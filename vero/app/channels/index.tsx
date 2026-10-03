import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, FlatList, RefreshControl, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useAuthStore } from '../../src/features/auth/useAuthStore';
import { CHANNELS_E2EE_NOTICE, followersLabel } from '../../src/features/channels/channelUtils';
import { ChannelSummary } from '../../src/features/channels/types';
import { channelsStore, useChannelsStore } from '../../src/features/channels/useChannelsStore';
import { Banner, EntityAvatar, groupStyles as gs, Row, ScreenHeader } from '../../src/features/groups/components/GroupComponents';
import { Colors, Spacing } from '../../src/shared/theme/theme';

type Tab = 'following' | 'discover';

/** Channels hub: channels you follow/run, the public directory, and communities. */
export default function ChannelsScreen() {
  const isDemo = useAuthStore((s) => s.isDemo);
  const mine = useChannelsStore((s) => s.mine);
  const directory = useChannelsStore((s) => s.directory);
  const isLoadingMine = useChannelsStore((s) => s.isLoadingMine);
  const isSearching = useChannelsStore((s) => s.isSearching);
  const [tab, setTab] = useState<Tab>('following');
  const [query, setQuery] = useState('');

  useFocusEffect(
    useCallback(() => {
      if (!isDemo) void channelsStore.getState().loadMine().catch(() => undefined);
    }, [isDemo])
  );

  useEffect(() => {
    if (isDemo || tab !== 'discover') return;
    const t = setTimeout(() => void channelsStore.getState().search(query).catch(() => undefined), 250);
    return () => clearTimeout(t);
  }, [query, tab, isDemo]);

  const renderChannel = ({ item }: { item: ChannelSummary }) => (
    <TouchableOpacity onPress={() => router.push(`/channels/${item.id}`)} activeOpacity={0.7}>
      <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: Spacing.base, paddingVertical: Spacing.md, gap: Spacing.md }}>
        <EntityAvatar name={item.name} dataUri={item.avatarData} size={48} icon="megaphone" />
        <View style={{ flex: 1 }}>
          <Text style={gs.body} numberOfLines={1}>
            {item.name}
            {item.visibility === 'private' ? '  🔒' : ''}
          </Text>
          <Text style={gs.muted} numberOfLines={1}>
            @{item.handle} · {followersLabel(item.followerCount)}
            {item.myRole ? ` · ${item.myRole === 'owner' ? 'Owner' : 'Admin'}` : ''}
            {item.muted ? ' · Muted' : ''}
          </Text>
        </View>
        {tab === 'discover' && item.isFollowing && <Ionicons name="checkmark-circle" size={18} color={Colors.accent} />}
      </View>
    </TouchableOpacity>
  );

  return (
    <SafeAreaView style={gs.container} edges={['top']}>
      <ScreenHeader
        title="Channels"
        subtitle="Broadcast updates"
        onBack={() => router.back()}
        right={
          !isDemo ? (
            <TouchableOpacity onPress={() => router.push('/channels/new')} accessibilityLabel="New channel" style={{ padding: Spacing.sm }}>
              <Ionicons name="add-circle-outline" size={24} color={Colors.accentLight} />
            </TouchableOpacity>
          ) : null
        }
      />

      {isDemo ? (
        <View style={gs.centered}>
          <Text style={gs.muted}>Channels need a real account.</Text>
        </View>
      ) : (
        <>
          <Banner icon="information-circle-outline" tone="warning" text={CHANNELS_E2EE_NOTICE} />
          <Row icon="git-network-outline" label="Communities" sublabel="Groups that belong together, with announcements" onPress={() => router.push('/communities')} />
          <View style={{ flexDirection: 'row', gap: Spacing.sm, padding: Spacing.base }}>
            {(['following', 'discover'] as Tab[]).map((t) => (
              <TouchableOpacity key={t} style={[gs.chip, tab === t && gs.chipActive]} onPress={() => setTab(t)}>
                <Text style={[gs.chipText, tab === t && gs.chipTextActive]}>{t === 'following' ? 'Following' : 'Discover'}</Text>
              </TouchableOpacity>
            ))}
          </View>

          {tab === 'discover' && (
            <TextInput
              style={gs.input}
              value={query}
              onChangeText={setQuery}
              placeholder="Search public channels"
              placeholderTextColor={Colors.textTertiary}
              autoCapitalize="none"
            />
          )}

          <FlatList
            data={tab === 'following' ? mine : directory}
            keyExtractor={(c) => c.id}
            renderItem={renderChannel}
            refreshControl={
              tab === 'following' ? (
                <RefreshControl refreshing={isLoadingMine} onRefresh={() => void channelsStore.getState().loadMine()} tintColor={Colors.accent} />
              ) : undefined
            }
            ListEmptyComponent={
              (tab === 'discover' && isSearching) || (tab === 'following' && isLoadingMine) ? (
                <ActivityIndicator color={Colors.accent} style={{ marginTop: 24 }} />
              ) : (
                <View style={gs.centered}>
                  <Text style={gs.muted}>
                    {tab === 'following' ? "You don't follow any channels yet. Try Discover." : 'No public channels found.'}
                  </Text>
                </View>
              )
            }
          />
        </>
      )}
    </SafeAreaView>
  );
}
