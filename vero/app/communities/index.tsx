import React, { useCallback } from 'react';
import { ActivityIndicator, FlatList, RefreshControl, Text, TouchableOpacity, View } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useAuthStore } from '../../src/features/auth/useAuthStore';
import { communitiesStore, useCommunitiesStore } from '../../src/features/communities/useCommunitiesStore';
import { Banner, EntityAvatar, groupStyles as gs, ScreenHeader } from '../../src/features/groups/components/GroupComponents';
import { Colors, Spacing } from '../../src/shared/theme/theme';

export default function CommunitiesScreen() {
  const isDemo = useAuthStore((s) => s.isDemo);
  const list = useCommunitiesStore((s) => s.list);
  const isLoading = useCommunitiesStore((s) => s.isLoading);

  useFocusEffect(
    useCallback(() => {
      if (!isDemo) void communitiesStore.getState().loadMine().catch(() => undefined);
    }, [isDemo])
  );

  return (
    <SafeAreaView style={gs.container} edges={['top']}>
      <ScreenHeader
        title="Communities"
        onBack={() => router.back()}
        right={
          !isDemo ? (
            <TouchableOpacity onPress={() => router.push('/communities/new')} accessibilityLabel="New community" style={{ padding: Spacing.sm }}>
              <Ionicons name="add-circle-outline" size={24} color={Colors.accentLight} />
            </TouchableOpacity>
          ) : null
        }
      />
      {isDemo ? (
        <View style={gs.centered}>
          <Text style={gs.muted}>Communities need a real account.</Text>
        </View>
      ) : (
        <FlatList
          data={list}
          keyExtractor={(c) => c.id}
          refreshControl={<RefreshControl refreshing={isLoading} onRefresh={() => void communitiesStore.getState().loadMine()} tintColor={Colors.accent} />}
          ListHeaderComponent={
            <Banner icon="lock-closed" text="Community groups and announcements are end-to-end encrypted. Community and group names are visible to Vero's servers." />
          }
          ListEmptyComponent={
            isLoading ? (
              <ActivityIndicator color={Colors.accent} style={{ marginTop: 24 }} />
            ) : (
              <View style={gs.centered}>
                <Text style={gs.heroTitle}>Bring groups together</Text>
                <Text style={gs.heroSub}>
                  A community keeps related groups in one place, with an announcements group where only admins post.
                </Text>
              </View>
            )
          }
          renderItem={({ item }) => (
            <TouchableOpacity onPress={() => router.push(`/communities/${item.id}`)} activeOpacity={0.7}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: Spacing.md, paddingHorizontal: Spacing.base, paddingVertical: Spacing.md }}>
                <EntityAvatar name={item.name} dataUri={item.avatarData} size={48} icon="git-network" />
                <View style={{ flex: 1 }}>
                  <Text style={gs.body} numberOfLines={1}>
                    {item.name}
                  </Text>
                  <Text style={gs.muted} numberOfLines={1}>
                    {item.groupCount} groups · {item.memberCount} members
                    {item.myRole && item.myRole !== 'member' ? ` · ${item.myRole === 'owner' ? 'Owner' : 'Admin'}` : ''}
                  </Text>
                </View>
              </View>
            </TouchableOpacity>
          )}
        />
      )}
    </SafeAreaView>
  );
}
