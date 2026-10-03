import React, { useEffect, useMemo, useState } from 'react';
import {
  View,
  Text,
  FlatList,
  StyleSheet,
  TouchableOpacity,
  TextInput,
  StatusBar,
  ActivityIndicator,
  Alert,
} from 'react-native';
import { router } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useAuthStore } from '../../src/features/auth/useAuthStore';
import { conversationRepository } from '../../src/features/chats/ConversationRepository';
import { useChatsStore } from '../../src/features/chats/useChatsStore';
import { DEMO_CONTACTS } from '../../src/features/demo/demoData';
import { friendlyError } from '../../src/core/network/supabase';
import { User } from '../../src/shared/models/Message';
import { Colors, Typography, Spacing, BorderRadius } from '../../src/shared/theme/theme';

export default function ContactsScreen() {
  const isDemo = useAuthStore((s) => s.isDemo);
  const conversations = useChatsStore((s) => s.conversations);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<User[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [openingId, setOpeningId] = useState<string | null>(null);

  // People you already talk to (from your direct chats).
  const knownContacts = useMemo<User[]>(() => {
    if (isDemo) return DEMO_CONTACTS;
    const seen = new Map<string, User>();
    for (const c of conversations) if (c.otherUser) seen.set(c.otherUser.id, c.otherUser);
    return [...seen.values()].sort((a, b) => a.displayName.localeCompare(b.displayName));
  }, [conversations, isDemo]);

  // Debounced directory search.
  useEffect(() => {
    const q = searchQuery.trim();
    if (q.length < 2) {
      setSearchResults([]);
      setIsSearching(false);
      return;
    }
    if (isDemo) {
      setSearchResults(
        DEMO_CONTACTS.filter((u) => `${u.displayName} ${u.username}`.toLowerCase().includes(q.toLowerCase()))
      );
      return;
    }
    setIsSearching(true);
    let cancelled = false;
    const t = setTimeout(async () => {
      try {
        const results = await conversationRepository.searchUsers(q);
        if (!cancelled) setSearchResults(results);
      } catch {
        if (!cancelled) setSearchResults([]);
      } finally {
        if (!cancelled) setIsSearching(false);
      }
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [searchQuery, isDemo]);

  const handleSearch = (query: string) => setSearchQuery(query);

  const handleStartChat = async (otherUser: User) => {
    if (isDemo) {
      const existing = conversations.find((c) => c.otherUser?.id === otherUser.id);
      if (existing) router.push(`/chat/${existing.id}`);
      else Alert.alert('Demo mode', 'Create a real account to start new encrypted chats.');
      return;
    }
    setOpeningId(otherUser.id);
    try {
      const conversationId = await conversationRepository.createDirectConversation(otherUser.id);
      router.push(`/chat/${conversationId}`);
    } catch (e) {
      Alert.alert('Could not start chat', friendlyError(e));
    } finally {
      setOpeningId(null);
    }
  };

  const renderUser = ({ item }: { item: User }) => {
    const initials = item.displayName.slice(0, 2).toUpperCase();
    const avatarColors = ['#06B6D4', '#8B5CF6', '#10B981', '#F59E0B'];
    const bgStart = avatarColors[Math.abs(item.id.charCodeAt(item.id.length - 1)) % avatarColors.length];

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
          </View>
          <Text style={styles.username}>@{item.username}</Text>
          {item.about && <Text style={styles.userBio}>{item.about}</Text>}
        </View>

        <View style={styles.chatIconWrapper}>
          {openingId === item.id ? (
            <ActivityIndicator size="small" color={Colors.accentLight} />
          ) : (
            <Ionicons name="chatbubble-ellipses" size={17} color={Colors.accentLight} />
          )}
        </View>
      </TouchableOpacity>
    );
  };

  const displayedList = searchQuery.trim().length >= 2 ? searchResults : knownContacts;

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <StatusBar barStyle="light-content" backgroundColor={Colors.background} />

      {/* Header */}
      <View style={[styles.header, { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }]}>
        <Text style={styles.headerTitle}>Contacts</Text>
        {!isDemo && (
          <View style={{ flexDirection: 'row', gap: Spacing.md }}>
            <TouchableOpacity onPress={() => router.push('/discovery')} accessibilityLabel="Find friends from contacts">
              <Ionicons name="person-add-outline" size={22} color={Colors.accentLight} />
            </TouchableOpacity>
            <TouchableOpacity onPress={() => router.push('/qr')} accessibilityLabel="My QR code">
              <Ionicons name="qr-code-outline" size={22} color={Colors.accentLight} />
            </TouchableOpacity>
          </View>
        )}
      </View>

      {/* Search Bar */}
      <View style={styles.searchSection}>
        <View style={styles.searchBar}>
          <Ionicons name="search" size={18} color={Colors.accentLight} />
          <TextInput
            style={styles.searchInput}
            placeholder="Search people by name or @username"
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
          onPress={() => router.push('/new-group')}
          activeOpacity={0.8}
        >
          <View style={styles.newGroupIcon}>
            <Ionicons name="people" size={22} color={Colors.purpleLight} />
          </View>
          <View style={styles.newGroupText}>
            <Text style={styles.newGroupTitle}>New group</Text>
            <Text style={styles.newGroupSubtitle}>Every member's devices get their own key slot</Text>
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
            {searchQuery.trim().length >= 2
              ? isSearching
                ? 'Searching…'
                : `${searchResults.length} result${searchResults.length !== 1 ? 's' : ''}`
              : knownContacts.length
                ? 'People you chat with'
                : 'Search for someone by name or username to start a chat'}
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
