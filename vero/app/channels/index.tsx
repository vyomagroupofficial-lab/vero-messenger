import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, FlatList, RefreshControl, Text, View } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAuthStore } from '../../src/features/auth/useAuthStore';
import { formatCount } from '../../src/features/channels/channelUtils';
import { ChannelSummary } from '../../src/features/channels/types';
import { channelsStore, useChannelsStore } from '../../src/features/channels/useChannelsStore';
import { Banner, EntityAvatar, Row, ScreenHeader, useGroupStyles } from '../../src/features/groups/components/GroupComponents';
import { makeStyles, useTheme } from '../../src/shared/theme/ThemeProvider';
import { useT } from '../../src/shared/i18n';
import { Chip, EmptyState, Grain, Icon, IconButton, Pressy, Rise, SearchField } from '../../src/shared/ui';

type Tab = 'following' | 'discover';

/** Channels hub: channels you follow/run, the public directory, and communities. */
export default function ChannelsScreen() {
  const insets = useSafeAreaInsets();
  const { c } = useTheme();
  const gs = useGroupStyles();
  const s = useStyles();
  const t = useT();
  const isDemo = useAuthStore((st) => st.isDemo);
  const mine = useChannelsStore((st) => st.mine);
  const directory = useChannelsStore((st) => st.directory);
  const isLoadingMine = useChannelsStore((st) => st.isLoadingMine);
  const isSearching = useChannelsStore((st) => st.isSearching);
  const [tab, setTab] = useState<Tab>('following');
  const [query, setQuery] = useState('');

  useFocusEffect(
    useCallback(() => {
      if (!isDemo) void channelsStore.getState().loadMine().catch(() => undefined);
    }, [isDemo])
  );

  useEffect(() => {
    if (isDemo || tab !== 'discover') return;
    const timer = setTimeout(() => void channelsStore.getState().search(query).catch(() => undefined), 250);
    return () => clearTimeout(timer);
  }, [query, tab, isDemo]);

  const renderChannel = ({ item, index }: { item: ChannelSummary; index: number }) => {
    const meta = [
      `@${item.handle}`,
      t('channels.followers', { count: item.followerCount, n: formatCount(item.followerCount) }),
      item.myRole ? (item.myRole === 'owner' ? t('thread.role_owner') : t('thread.role_admin')) : null,
      item.muted ? t('channels.muted') : null,
    ].filter(Boolean);
    return (
      <Rise index={Math.min(index, 10)}>
        <Pressy onPress={() => router.push(`/channels/${item.id}`)} scaleTo={0.98} hoverStyle={{ backgroundColor: c.tint }} style={s.item} accessibilityLabel={item.name}>
          <EntityAvatar name={item.name} dataUri={item.avatarData} size={50} icon="megaphone" />
          <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <Text style={s.name} numberOfLines={1}>
                {item.name}
              </Text>
              {item.visibility === 'private' && <Icon name="lock" size={13} color={c.muted} />}
            </View>
            <Text style={s.meta} numberOfLines={1}>
              {meta.join(' · ')}
            </Text>
          </View>
          {tab === 'discover' && item.isFollowing && (
            <View style={s.following}>
              <Icon name="check" size={13} color={c.success} strokeWidth={2.4} />
            </View>
          )}
        </Pressy>
      </Rise>
    );
  };

  return (
    <View style={[gs.container, { paddingTop: insets.top }]}>
      <Grain />
      <ScreenHeader
        title={t('channels.title')}
        subtitle={t('channels.subtitle')}
        onBack={() => (router.canGoBack() ? router.back() : router.replace('/(tabs)/chats'))}
        right={!isDemo ? <IconButton icon="plus" label={t('channels.new')} variant="brass" onPress={() => router.push('/channels/new')} /> : null}
      />

      {isDemo ? (
        <EmptyState icon="megaphone" title={t('channels.title')} body={t('channels.demo')} />
      ) : (
        <View style={s.inner}>
          <FlatList
            data={tab === 'following' ? mine : directory}
            keyExtractor={(ch) => ch.id}
            renderItem={renderChannel}
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={{ paddingBottom: insets.bottom + 32 }}
            ListHeaderComponent={
              <View style={{ gap: 6, paddingTop: 8 }}>
                <Banner icon="info" tone="warning" text={t('channels.notice')} />
                <Row icon="grid" label={t('communities.title')} sublabel={t('communities.subtitle')} onPress={() => router.push('/communities')} />
                <View style={s.tabs}>
                  <Chip label={t('channels.following')} active={tab === 'following'} onPress={() => setTab('following')} />
                  <Chip label={t('channels.discover')} active={tab === 'discover'} onPress={() => setTab('discover')} />
                </View>
                {tab === 'discover' && (
                  <SearchField value={query} onChangeText={setQuery} placeholder={t('channels.search')} onClear={() => setQuery('')} style={{ marginHorizontal: 16, marginBottom: 6 }} />
                )}
              </View>
            }
            refreshControl={
              tab === 'following' ? <RefreshControl refreshing={isLoadingMine} onRefresh={() => void channelsStore.getState().loadMine()} tintColor={c.accent} /> : undefined
            }
            ListEmptyComponent={
              (tab === 'discover' && isSearching) || (tab === 'following' && isLoadingMine) ? (
                <ActivityIndicator color={c.accent} style={{ marginTop: 24 }} />
              ) : (
                <EmptyState
                  icon="megaphone"
                  title={tab === 'following' ? t('channels.noneFollowing') : t('channels.noneFound')}
                  body={tab === 'following' ? t('channels.noneFollowingBody') : t('channels.noneFoundBody')}
                />
              )
            }
          />
        </View>
      )}
    </View>
  );
}

const useStyles = makeStyles((c, t, f) => ({
  inner: { flex: 1, width: '100%', maxWidth: 760, alignSelf: 'center' },
  tabs: { flexDirection: 'row', gap: 8, paddingHorizontal: 16, paddingVertical: 10 },
  item: { flexDirection: 'row', alignItems: 'center', gap: 13, marginHorizontal: 8, paddingHorizontal: 12, paddingVertical: 10, borderRadius: 18 },
  name: { fontFamily: f.semibold, fontSize: 16, color: c.text, flexShrink: 1 },
  meta: { fontFamily: f.body, fontSize: 13, color: c.muted },
  following: { width: 26, height: 26, borderRadius: 13, backgroundColor: c.successTint, alignItems: 'center', justifyContent: 'center' },
}));
