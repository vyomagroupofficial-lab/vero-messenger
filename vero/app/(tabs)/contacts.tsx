import React, { useState } from 'react';
import {
  View,
  Text,
  FlatList,
  StyleSheet,
  TouchableOpacity,
  TextInput,
  StatusBar,
} from 'react-native';
import { router } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useAuthStore } from '../../src/features/auth/useAuthStore';
import { conversationRepository } from '../../src/features/chats/ConversationRepository';
import { User } from '../../src/shared/models/Message';
import { Colors, Typography, Spacing, BorderRadius } from '../../src/shared/theme/theme';

const SEED_CONTACTS: User[] = [
  { id: 'sarah-connor-01', username: 'sarah_c', displayName: 'Sarah Connor (Security Lead)', about: 'X25519 Verified · 0x8a1...9b2' },
  { id: 'marcus-vance-02', username: 'marcus_v', displayName: 'Marcus Vance', about: 'Core Protocol Engineer · 0x4f2...7c1' },
  { id: 'elena-rostova-03', username: 'elena_r', displayName: 'Elena Rostova', about: 'Zero-Knowledge Cryptographer · 0x9e1...12a' },
  { id: 'david-kim-04', username: 'david_k', displayName: 'David Kim', about: 'Vero Systems Auditor · 0x3d4...88f' },
];

export default function ContactsScreen() {
  const { user } = useAuthStore();
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<User[]>([]);
  const [isSearching, setIsSearching] = useState(false);

  const handleSearch = async (query: string) => {
    setSearchQuery(query);
    if (!query.trim() || !user?.id) {
      setSearchResults([]);
      return;
    }
    setIsSearching(true);
    try {
      const results = await conversationRepository.searchUsers(query, user.id);
      setSearchResults(results);
    } finally {
      setIsSearching(false);
    }
  };

  const handleStartChat = async (otherUser: User) => {
    if (!user?.id) return;
    const result = await conversationRepository.createDirectConversation(user.id, otherUser.id);
    if (result) {
      router.push(`/chat/${result.conversationId}` as any);
    } else {
      // Fallback for demo contacts
      router.push(`/chat/demo-chat-${otherUser.username.split('_')[0]}` as any);
    }
  };

  const renderUser = ({ item }: { item: User }) => {
    const initials = item.displayName.slice(0, 2).toUpperCase();
    const avatarGradients = [
      ['#06B6D4', '#0284C7'],
      ['#8B5CF6', '#6D28D9'],
      ['#10B981', '#059669'],
      ['#F59E0B', '#D97706'],
    ];
    const colorIndex = Math.abs(item.displayName.charCodeAt(0)) % avatarGradients.length;
    const [bgStart] = avatarGradients[colorIndex];

    return (
      <TouchableOpacity
        style={styles.userItem}
        onPress={() => handleStartChat(item)}
        activeOpacity={0.75}
      >
        <View style={[styles.avatar, { backgroundColor: bgStart }]}>
          <Text style={styles.avatarText}>{initials}</Text>
        </View>

        <View style={styles.userInfo}>
          <View style={styles.nameRow}>
            <Text style={styles.displayName}>{item.displayName}</Text>
            <Ionicons name="shield-checkmark" size={13} color={Colors.emerald} />
          </View>
          <Text style={styles.username}>@{item.username}</Text>
          {item.about && <Text style={styles.userBio}>{item.about}</Text>}
        </View>

        <View style={styles.chatIconWrapper}>
          <Ionicons name="chatbubble-ellipses" size={17} color={Colors.accentLight} />
        </View>
      </TouchableOpacity>
    );
  };

  const displayedList = searchQuery ? searchResults : SEED_CONTACTS;

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <StatusBar barStyle="light-content" backgroundColor={Colors.background} />

      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Contacts & Directory</Text>
      </View>

      {/* Search Bar */}
      <View style={styles.searchSection}>
        <View style={styles.searchBar}>
          <Ionicons name="search" size={18} color={Colors.accentLight} />
          <TextInput
            style={styles.searchInput}
            placeholder="Search by username or identity key..."
            placeholderTextColor={Colors.textTertiary}
            value={searchQuery}
            onChangeText={handleSearch}
            autoCapitalize="none"
          />
          {searchQuery ? (
            <TouchableOpacity onPress={() => { setSearchQuery(''); setSearchResults([]); }}>
              <Ionicons name="close-circle" size={18} color={Colors.textSecondary} />
            </TouchableOpacity>
          ) : null}
        </View>
      </View>

      {/* New Group Action Banner */}
      {!searchQuery && (
        <TouchableOpacity
          style={styles.newGroupBtn}
          onPress={() => router.push('/new-group' as any)}
          activeOpacity={0.8}
        >
          <View style={styles.newGroupIcon}>
            <Ionicons name="people" size={22} color={Colors.purpleLight} />
          </View>
          <View style={styles.newGroupText}>
            <Text style={styles.newGroupTitle}>Create Encrypted Group</Text>
            <Text style={styles.newGroupSubtitle}>Pairwise sender keys & admin roles</Text>
          </View>
          <Ionicons name="chevron-forward" size={18} color={Colors.textTertiary} />
        </TouchableOpacity>
      )}

      {/* Directory Contacts List */}
      <FlatList
        data={displayedList}
        keyExtractor={(item) => item.id}
        renderItem={renderUser}
        contentContainerStyle={styles.listContent}
        ItemSeparatorComponent={() => <View style={styles.separator} />}
        showsVerticalScrollIndicator={false}
        ListHeaderComponent={
          <Text style={styles.resultsHeader}>
            {searchQuery
              ? `${searchResults.length} matching result${searchResults.length !== 1 ? 's' : ''}`
              : 'Verified Encrypted Directory'}
          </Text>
        }
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: Colors.background,
  },
  header: {
    paddingHorizontal: Spacing.xl,
    paddingTop: Spacing.md,
    paddingBottom: Spacing.sm,
    backgroundColor: Colors.background,
  },
  headerTitle: {
    fontSize: Typography['2xl'],
    fontWeight: Typography.extrabold,
    color: Colors.textPrimary,
    letterSpacing: -0.5,
  },
  searchSection: {
    paddingHorizontal: Spacing.xl,
    paddingVertical: Spacing.sm,
  },
  searchBar: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#0B1322',
    borderRadius: BorderRadius.lg,
    paddingHorizontal: Spacing.md,
    height: 46,
    gap: Spacing.sm,
    borderWidth: 1,
    borderColor: 'rgba(6, 182, 212, 0.25)',
  },
  searchInput: {
    flex: 1,
    color: Colors.textPrimary,
    fontSize: Typography.sm,
  },
  newGroupBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    marginHorizontal: Spacing.xl,
    marginTop: Spacing.xs,
    marginBottom: Spacing.sm,
    padding: Spacing.md,
    backgroundColor: 'rgba(139, 92, 246, 0.08)',
    borderRadius: BorderRadius.xl,
    borderWidth: 1,
    borderColor: 'rgba(139, 92, 246, 0.25)',
  },
  newGroupIcon: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: 'rgba(139, 92, 246, 0.18)',
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: Spacing.md,
  },
  newGroupText: {
    flex: 1,
  },
  newGroupTitle: {
    fontSize: Typography.base,
    fontWeight: Typography.semibold,
    color: Colors.textPrimary,
  },
  newGroupSubtitle: {
    fontSize: Typography.xs,
    color: Colors.textSecondary,
    marginTop: 2,
  },
  listContent: {
    paddingHorizontal: Spacing.xl,
    paddingBottom: 90,
  },
  resultsHeader: {
    fontSize: Typography.xs,
    fontWeight: Typography.bold,
    color: Colors.textTertiary,
    marginTop: Spacing.base,
    marginBottom: Spacing.sm,
    letterSpacing: 0.8,
    textTransform: 'uppercase',
  },
  userItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: Spacing.md,
  },
  avatar: {
    width: 48,
    height: 48,
    borderRadius: 24,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: Spacing.md,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.3,
    shadowRadius: 6,
  },
  avatarText: {
    fontSize: Typography.base,
    fontWeight: Typography.bold,
    color: '#FFF',
  },
  userInfo: {
    flex: 1,
  },
  nameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: 2,
  },
  displayName: {
    fontSize: Typography.base,
    fontWeight: Typography.semibold,
    color: Colors.textPrimary,
  },
  username: {
    fontSize: Typography.xs,
    color: Colors.textTertiary,
    marginBottom: 2,
  },
  userBio: {
    fontSize: 11,
    color: Colors.emerald,
    letterSpacing: 0.2,
  },
  chatIconWrapper: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: 'rgba(6, 182, 212, 0.12)',
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: 'rgba(6, 182, 212, 0.25)',
  },
  separator: {
    height: 1,
    backgroundColor: 'rgba(255, 255, 255, 0.04)',
    marginLeft: 64,
  },
});
