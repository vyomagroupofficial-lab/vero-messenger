import React, { useCallback } from 'react';
import { ActivityIndicator, FlatList, RefreshControl, Text, View } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAuthStore } from '../../src/features/auth/useAuthStore';
import { communitiesStore, useCommunitiesStore } from '../../src/features/communities/useCommunitiesStore';
import { Banner, EntityAvatar, ScreenHeader, useGroupStyles } from '../../src/features/groups/components/GroupComponents';
import { makeStyles, useTheme } from '../../src/shared/theme/ThemeProvider';
import { useT } from '../../src/shared/i18n';
import { Button, EmptyState, Grain, Icon, IconButton, Pill, Pressy, Rise } from '../../src/shared/ui';

export default function CommunitiesScreen() {
  const insets = useSafeAreaInsets();
  const { c } = useTheme();
  const gs = useGroupStyles();
  const s = useStyles();
  const t = useT();
  const isDemo = useAuthStore((st) => st.isDemo);
  const list = useCommunitiesStore((st) => st.list);
  const isLoading = useCommunitiesStore((st) => st.isLoading);

  useFocusEffect(
    useCallback(() => {
      if (!isDemo) void communitiesStore.getState().loadMine().catch(() => undefined);
    }, [isDemo])
  );

  return (
    <View style={[gs.container, { paddingTop: insets.top }]}>
      <Grain />
      <ScreenHeader
        title={t('communities.title')}
        onBack={() => (router.canGoBack() ? router.back() : router.replace('/channels'))}
        right={!isDemo ? <IconButton icon="plus" label={t('communities.new')} variant="brass" onPress={() => router.push('/communities/new')} /> : null}
      />
      {isDemo ? (
        <EmptyState icon="grid" title={t('communities.title')} body={t('communities.demo')} />
      ) : (
        <FlatList
          data={list}
          keyExtractor={(cm) => cm.id}
          contentContainerStyle={[s.list, { paddingBottom: insets.bottom + 32 }]}
          refreshControl={<RefreshControl refreshing={isLoading} onRefresh={() => void communitiesStore.getState().loadMine()} tintColor={c.accent} />}
          ListHeaderComponent={
            <View style={{ marginHorizontal: -16, paddingTop: 8 }}>
              <Banner icon="lock" text={t('communities.notice')} />
            </View>
          }
          ListEmptyComponent={
            isLoading ? (
              <ActivityIndicator color={c.accent} style={{ marginTop: 24 }} />
            ) : (
              <EmptyState
                icon="grid"
                title={t('communities.emptyTitle')}
                body={t('communities.emptyBody')}
                action={<Button label={t('communities.new')} icon="plus" size="md" onPress={() => router.push('/communities/new')} />}
              />
            )
          }
          renderItem={({ item, index }) => (
            <Rise index={Math.min(index, 10)}>
              <Pressy onPress={() => router.push(`/communities/${item.id}`)} scaleTo={0.98} hoverStyle={{ borderColor: c.accentLine }} style={s.card} accessibilityLabel={item.name}>
                <EntityAvatar name={item.name} dataUri={item.avatarData} size={56} icon="grid" />
                <View style={{ flex: 1, minWidth: 0, gap: 6 }}>
                  <Text style={s.name} numberOfLines={1}>
                    {item.name}
                  </Text>
                  <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>
                    <Pill icon="grid" label={t('communities.groups', { count: item.groupCount })} tone="stage" />
                    <Pill icon="users" label={t('communities.members', { count: item.memberCount })} tone="stage" />
                    {item.myRole && item.myRole !== 'member' && <Pill label={item.myRole === 'owner' ? t('thread.role_owner') : t('thread.role_admin')} tone="brass" />}
                  </View>
                </View>
                <Icon name="forwardChevron" size={18} color={c.faint} />
              </Pressy>
            </Rise>
          )}
        />
      )}
    </View>
  );
}

const useStyles = makeStyles((c, t, f) => ({
  list: { width: '100%', maxWidth: 760, alignSelf: 'center', paddingHorizontal: 16, gap: 10 },
  card: { flexDirection: 'row', alignItems: 'center', gap: 14, padding: 14, borderRadius: 22, backgroundColor: c.panel, borderWidth: 1, borderColor: c.line },
  name: { fontFamily: f.semibold, fontSize: 16.5, color: c.text },
}));
