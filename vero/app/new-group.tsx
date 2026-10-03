import React, { useState, useEffect, useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  TextInput,
  FlatList,
  Alert,
  ActivityIndicator,
  ScrollView,
} from 'react-native';
import { router } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { Colors, Typography, Spacing, BorderRadius } from '../src/shared/theme/theme';
import { useAuthStore } from '../src/features/auth/useAuthStore';
import { conversationRepository } from '../src/features/chats/ConversationRepository';
import { useChatsStore } from '../src/features/chats/useChatsStore';
import { friendlyError } from '../src/core/network/supabase';
import { User } from '../src/shared/models/Message';

const AVATAR_GRADIENTS = [
  '#0284C7',
  '#7C3AED',
  '#0D9488',
  '#D97706',
  '#E11D48',
  '#4F46E5',
];

export default function NewGroupScreen() {
  const isDemo = useAuthStore((s) => s.isDemo);
  const conversations = useChatsStore((s) => s.conversations);
  const [groupName, setGroupName] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<User[]>([]);
  const [selected, setSelected] = useState<Map<string, User>>(new Map());
  const [isLoading, setIsLoading] = useState(false);
  const [isCreating, setIsCreating] = useState(false);

  const knownContacts = useMemo<User[]>(() => {
    const seen = new Map<string, User>();
    for (const c of conversations) if (c.otherUser) seen.set(c.otherUser.id, c.otherUser);
    return [...seen.values()];
  }, [conversations]);

  // Directory search for people you haven't chatted with yet.
  useEffect(() => {
    const q = searchQuery.trim();
    if (q.length < 2 || isDemo) {
      setSearchResults([]);
      return;
    }
    setIsLoading(true);
    let cancelled = false;
    const t = setTimeout(async () => {
      try {
        const results = await conversationRepository.searchUsers(q);
        if (!cancelled) setSearchResults(results);
      } catch {
        if (!cancelled) setSearchResults([]);
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [searchQuery, isDemo]);

  const selectedUserIds = useMemo(() => new Set(selected.keys()), [selected]);

  const toggleSelectUser = (id: string) => {
    const updated = new Map(selected);
    if (updated.has(id)) updated.delete(id);
    else {
      const u = [...knownContacts, ...searchResults].find((c) => c.id === id);
      if (u) updated.set(id, u);
    }
    setSelected(updated);
  };

  const removeSelectedUser = (id: string) => {
    const updated = new Map(selected);
    updated.delete(id);
    setSelected(updated);
  };

  const handleCreateGroup = async () => {
    if (isDemo) {
      Alert.alert('Demo mode', 'Create a real account to start encrypted groups.');
      return;
    }
    if (!groupName.trim()) {
      Alert.alert('Group name required', 'Please enter a name for this group.');
      return;
    }
    if (selected.size === 0) {
      Alert.alert('Add participants', 'Please select at least one participant.');
      return;
    }
    setIsCreating(true);
    try {
      const conversationId = await conversationRepository.createGroupConversation(groupName.trim(), [...selected.keys()]);
      void useChatsStore.getState().load({ sync: false });
      router.replace(`/chat/${conversationId}`);
    } catch (e) {
      Alert.alert('Could not create group', friendlyError(e));
    } finally {
      setIsCreating(false);
    }
  };

  const selectedUsersList = [...selected.values()];
  const q = searchQuery.trim().toLowerCase();
  const pool = q.length >= 2 ? [...knownContacts, ...searchResults.filter((r) => !knownContacts.some((k) => k.id === r.id))] : knownContacts;
  const filteredContacts = pool.filter(
    (c) => !q || c.displayName.toLowerCase().includes(q) || c.username.toLowerCase().includes(q)
  );

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      {/* Frosted Glass Cyber Header */}
      <View style={styles.header}>
        <TouchableOpacity style={styles.iconBtn} onPress={() => router.back()} activeOpacity={0.7}>
          <Ionicons name="arrow-back" size={20} color={Colors.textPrimary} />
        </TouchableOpacity>
        <View style={styles.headerTitleContainer}>
          <Text style={styles.headerTitle}>New group</Text>
          <Text style={styles.headerSub}>End-to-end encrypted</Text>
        </View>
        <TouchableOpacity
          style={[styles.createBtn, (!groupName.trim() || selectedUserIds.size === 0) && styles.createBtnDisabled]}
          onPress={handleCreateGroup}
          disabled={!groupName.trim() || selectedUserIds.size === 0 || isCreating}
          activeOpacity={0.85}
        >
          {isCreating ? (
            <ActivityIndicator size="small" color={Colors.white} />
          ) : (
            <Text style={styles.createBtnText}>Create</Text>
          )}
        </TouchableOpacity>
      </View>

      {/* Group Info Input Card */}
      <View style={styles.groupInfoCard}>
        <View style={styles.groupAvatarPlaceholder}>
          <Ionicons name="people" size={26} color={Colors.accent} />
          <View style={styles.cameraBadge}>
            <Ionicons name="camera" size={10} color={Colors.white} />
          </View>
        </View>
        <View style={styles.groupInputWrap}>
          <TextInput
            style={styles.groupNameInput}
            placeholder="Group subject..."
            placeholderTextColor={Colors.textTertiary}
            value={groupName}
            onChangeText={setGroupName}
            maxLength={50}
          />
          <Text style={styles.charCounter}>{groupName.length}/50</Text>
        </View>
      </View>

      {/* Selected Members Carousel */}
      {selectedUsersList.length > 0 && (
        <View style={styles.selectedSection}>
          <Text style={styles.selectedCountText}>
            PARTICIPANTS ({selectedUsersList.length})
          </Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.selectedChipsList}>
            {selectedUsersList.map((item) => (
              <View key={item.id} style={styles.selectedChip}>
                <View style={styles.chipAvatar}>
                  <Text style={styles.chipAvatarText}>{item.displayName.slice(0, 1)}</Text>
                </View>
                <Text style={styles.chipName} numberOfLines={1}>{item.displayName.split(' ')[0]}</Text>
                <TouchableOpacity onPress={() => removeSelectedUser(item.id)} style={styles.chipRemove}>
                  <Ionicons name="close-circle" size={16} color={Colors.textSecondary} />
                </TouchableOpacity>
              </View>
            ))}
          </ScrollView>
        </View>
      )}

      {/* Search Input Bar */}
      <View style={styles.searchSection}>
        <View style={styles.searchBar}>
          <Ionicons name="search" size={17} color={Colors.accent} />
          <TextInput
            style={styles.searchInput}
            placeholder="Search directory by name or @handle..."
            placeholderTextColor={Colors.textTertiary}
            value={searchQuery}
            onChangeText={setSearchQuery}
          />
          {searchQuery.length > 0 && (
            <TouchableOpacity onPress={() => setSearchQuery('')}>
              <Ionicons name="close" size={16} color={Colors.textTertiary} />
            </TouchableOpacity>
          )}
        </View>
      </View>

      {/* Security Info Card */}
      <View style={styles.secNotice}>
        <Ionicons name="shield-checkmark" size={14} color={Colors.online} />
        <Text style={styles.secNoticeText}>Each group member will maintain independent end-to-end ratchet sessions.</Text>
      </View>

      {/* Contact List */}
      <FlatList
        data={filteredContacts}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.listContent}
        showsVerticalScrollIndicator={false}
        ListEmptyComponent={
          isLoading ? (
            <ActivityIndicator color={Colors.accent} style={{ marginTop: 30 }} />
          ) : (
            <View style={styles.emptyWrap}>
              <Ionicons name="search-outline" size={36} color={Colors.textTertiary} />
              <Text style={styles.emptyText}>{q.length >= 2 ? 'No one found' : 'Search for people by name or @username'}</Text>
            </View>
          )
        }
        renderItem={({ item, index }) => {
          const isSelected = selectedUserIds.has(item.id);
          const avatarColor = AVATAR_GRADIENTS[index % AVATAR_GRADIENTS.length];
          const initials = item.displayName.slice(0, 2).toUpperCase();

          return (
            <TouchableOpacity
              style={[styles.contactRow, isSelected && styles.contactRowSelected]}
              onPress={() => toggleSelectUser(item.id)}
              activeOpacity={0.75}
            >
              <View style={[styles.avatar, { backgroundColor: avatarColor }]}>
                <Text style={styles.avatarText}>{initials}</Text>
              </View>

              <View style={styles.contactInfo}>
                <Text style={styles.displayName}>{item.displayName}</Text>
                <Text style={styles.username}>@{item.username}</Text>
              </View>

              <View style={[styles.checkbox, isSelected && styles.checkboxSelected]}>
                {isSelected ? (
                  <Ionicons name="checkmark" size={14} color={Colors.white} />
                ) : (
                  <View style={styles.checkboxInnerUnchecked} />
                )}
              </View>
            </TouchableOpacity>
          );
        }}
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
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.base,
    paddingVertical: Spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(6, 182, 212, 0.15)',
    backgroundColor: 'rgba(8, 14, 26, 0.95)',
  },
  iconBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: '#0E1726',
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#1E293B',
  },
  headerTitleContainer: {
    flex: 1,
    alignItems: 'center',
    marginHorizontal: Spacing.sm,
  },
  headerTitle: {
    fontSize: Typography.base,
    fontWeight: Typography.bold,
    color: Colors.textPrimary,
  },
  headerSub: {
    fontSize: 10,
    color: Colors.accent,
    letterSpacing: 0.3,
  },
  createBtn: {
    backgroundColor: Colors.accent,
    paddingHorizontal: 16,
    paddingVertical: 7,
    borderRadius: BorderRadius.full,
    shadowColor: Colors.accent,
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.4,
    shadowRadius: 6,
    elevation: 4,
  },
  createBtnDisabled: {
    opacity: 0.4,
    shadowOpacity: 0,
  },
  createBtnText: {
    color: Colors.white,
    fontWeight: Typography.bold,
    fontSize: Typography.sm,
  },
  groupInfoCard: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: Spacing.base,
    backgroundColor: '#080E1A',
    gap: Spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(6, 182, 212, 0.1)',
  },
  groupAvatarPlaceholder: {
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: 'rgba(6, 182, 212, 0.12)',
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: 'rgba(6, 182, 212, 0.3)',
    position: 'relative',
  },
  cameraBadge: {
    position: 'absolute',
    bottom: -2,
    right: -2,
    width: 18,
    height: 18,
    borderRadius: 9,
    backgroundColor: Colors.accent,
    justifyContent: 'center',
    alignItems: 'center',
  },
  groupInputWrap: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    borderBottomWidth: 1,
    borderBottomColor: '#1E293B',
    paddingBottom: 4,
  },
  groupNameInput: {
    flex: 1,
    color: Colors.textPrimary,
    fontSize: Typography.base,
    fontWeight: Typography.medium,
  },
  charCounter: {
    fontSize: 10,
    color: Colors.textTertiary,
    marginLeft: 6,
  },
  selectedSection: {
    paddingVertical: Spacing.sm,
    backgroundColor: '#050A14',
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(6, 182, 212, 0.08)',
  },
  selectedCountText: {
    fontSize: 10,
    fontWeight: Typography.bold,
    color: Colors.textSecondary,
    letterSpacing: 0.8,
    paddingHorizontal: Spacing.base,
    marginBottom: 6,
  },
  selectedChipsList: {
    paddingHorizontal: Spacing.base,
    gap: 8,
  },
  selectedChip: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#0E1726',
    borderRadius: BorderRadius.full,
    paddingVertical: 3,
    paddingLeft: 4,
    paddingRight: 8,
    borderWidth: 1,
    borderColor: 'rgba(6, 182, 212, 0.25)',
    gap: 6,
  },
  chipAvatar: {
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: Colors.accent,
    justifyContent: 'center',
    alignItems: 'center',
  },
  chipAvatarText: {
    fontSize: 10,
    fontWeight: Typography.bold,
    color: Colors.white,
  },
  chipName: {
    fontSize: Typography.xs,
    color: Colors.textPrimary,
    fontWeight: Typography.medium,
    maxWidth: 80,
  },
  chipRemove: {
    padding: 1,
  },
  searchSection: {
    paddingHorizontal: Spacing.base,
    paddingTop: Spacing.sm,
    paddingBottom: 6,
  },
  searchBar: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#080E1A',
    borderRadius: BorderRadius.xl,
    paddingHorizontal: Spacing.md,
    height: 42,
    gap: Spacing.sm,
    borderWidth: 1,
    borderColor: '#1E293B',
  },
  searchInput: {
    flex: 1,
    color: Colors.textPrimary,
    fontSize: Typography.sm,
  },
  secNotice: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: Spacing.base,
    paddingVertical: 6,
  },
  secNoticeText: {
    fontSize: 10.5,
    color: Colors.textTertiary,
  },
  listContent: {
    paddingHorizontal: Spacing.base,
    paddingBottom: Spacing['2xl'],
  },
  contactRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    paddingHorizontal: 8,
    borderRadius: BorderRadius.lg,
    marginVertical: 1,
  },
  contactRowSelected: {
    backgroundColor: 'rgba(6, 182, 212, 0.08)',
  },
  avatar: {
    width: 44,
    height: 44,
    borderRadius: 22,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: Spacing.md,
  },
  avatarText: {
    color: Colors.white,
    fontWeight: Typography.bold,
    fontSize: Typography.sm,
  },
  contactInfo: {
    flex: 1,
  },
  displayName: {
    fontSize: Typography.base,
    fontWeight: Typography.semibold,
    color: Colors.textPrimary,
  },
  username: {
    fontSize: Typography.xs,
    color: Colors.textSecondary,
    marginTop: 1,
  },
  checkbox: {
    width: 24,
    height: 24,
    borderRadius: 12,
    borderWidth: 1.5,
    borderColor: '#334155',
    justifyContent: 'center',
    alignItems: 'center',
  },
  checkboxInnerUnchecked: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: 'transparent',
  },
  checkboxSelected: {
    backgroundColor: Colors.accent,
    borderColor: Colors.accent,
    shadowColor: Colors.accent,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.6,
    shadowRadius: 6,
  },
  emptyWrap: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingTop: 40,
    gap: 8,
  },
  emptyText: {
    fontSize: Typography.sm,
    color: Colors.textTertiary,
  },
});

