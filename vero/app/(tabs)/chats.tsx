import React, { useEffect, useState, useCallback, useMemo } from 'react';
import {
  View,
  Text,
  FlatList,
  StyleSheet,
  TouchableOpacity,
  TextInput,
  RefreshControl,
  ActivityIndicator,
  Animated,
  StatusBar,
  Platform,
} from 'react-native';
import { router } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useAuthStore } from '../../src/features/auth/useAuthStore';
import { conversationRepository } from '../../src/features/chats/ConversationRepository';
import { Conversation, Message } from '../../src/shared/models/Message';
import { databaseService } from '../../src/core/storage/DatabaseService';
import { Colors, Typography, Spacing, BorderRadius, Shadows } from '../../src/shared/theme/theme';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';

dayjs.extend(relativeTime);

const CATEGORIES = ['All', 'Direct', 'Groups', 'Unread'] as const;
type Category = typeof CATEGORIES[number];

// ──────────────────────────────────────────────────────────────────────────
// Chat List Item Component
// ──────────────────────────────────────────────────────────────────────────

interface ChatListItemProps {
  conversation: Conversation;
  onPress: () => void;
}

function ChatListItem({ conversation, onPress }: ChatListItemProps) {
  const isDirect = conversation.conversationType === 'direct';
  const name = isDirect
    ? (conversation.otherUser?.displayName || 'Unknown')
    : (conversation.groupName || 'Vero Group');

  const initials = name.slice(0, 2).toUpperCase();
  const lastMsgTime = conversation.lastMessage
    ? dayjs(conversation.lastMessage.createdAt).fromNow(true)
    : '';

  const lastMsg = conversation.lastMessage;
  const isOwn = lastMsg?.isOwn;

  const avatarGradients = [
    ['#06B6D4', '#0284C7'],
    ['#8B5CF6', '#6D28D9'],
    ['#10B981', '#059669'],
    ['#F59E0B', '#D97706'],
    ['#EC4899', '#BE185D'],
  ];
  const colorIndex = Math.abs(name.charCodeAt(0)) % avatarGradients.length;
  const [bgStart, bgEnd] = avatarGradients[colorIndex];

  return (
    <TouchableOpacity
      style={styles.chatItem}
      onPress={onPress}
      activeOpacity={0.75}
    >
      {/* Avatar with Glow and Badge */}
      <View style={styles.avatarWrapper}>
        <View style={[styles.avatar, { backgroundColor: bgStart }]}>
          {isDirect ? (
            <Text style={styles.avatarText}>{initials}</Text>
          ) : (
            <Ionicons name="people" size={24} color="#FFF" />
          )}
        </View>

        {/* Live Status indicator */}
        <View style={styles.onlineDot} />
      </View>

      {/* Conversation Details */}
      <View style={styles.chatContent}>
        <View style={styles.chatHeader}>
          <View style={styles.nameRow}>
            <Text style={styles.chatName} numberOfLines={1}>
              {name}
            </Text>
            <View style={styles.e2eeShieldMini}>
              <Ionicons name="shield-checkmark" size={12} color={Colors.emerald} />
            </View>
          </View>
          <Text style={styles.chatTime}>{lastMsgTime}</Text>
        </View>

        <View style={styles.chatFooter}>
          <View style={styles.previewRow}>
            {isOwn && (
              <Ionicons
                name="checkmark-done"
                size={15}
                color={lastMsg?.content ? Colors.accentLight : Colors.textTertiary}
                style={styles.receiptIcon}
              />
            )}
            <Text
              style={[
                styles.chatPreview,
                (conversation.unreadCount || 0) > 0 && styles.chatPreviewUnread,
              ]}
              numberOfLines={1}
            >
              {lastMsg?.content || '🔒 End-to-end encrypted message'}
            </Text>
          </View>

          {/* Meta & Unread Pill */}
          <View style={styles.chatMeta}>
            {(conversation.unreadCount || 0) > 0 && (
              <View style={styles.unreadBadge}>
                <Text style={styles.unreadCount}>
                  {conversation.unreadCount! > 99 ? '99+' : conversation.unreadCount}
                </Text>
              </View>
            )}
          </View>
        </View>
      </View>
    </TouchableOpacity>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Demo Conversations Seed
// ──────────────────────────────────────────────────────────────────────────

const DEMO_CONVERSATIONS: Conversation[] = [
  {
    id: 'demo-chat-sarah',
    conversationType: 'direct',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    otherUser: {
      id: 'sarah-connor-01',
      username: 'sarah_c',
      displayName: 'Sarah Connor',
      avatarReference: 'https://images.unsplash.com/photo-1494790108377-be9c29b29330?auto=format&fit=crop&w=200&q=80',
    },
    lastMessage: {
      content: 'Verified our 60-digit safety number! All green 🔒',
      messageType: 'text',
      senderDisplayName: 'Sarah Connor',
      isOwn: false,
      createdAt: new Date(Date.now() - 1000 * 60 * 12).toISOString(),
    },
    unreadCount: 0,
  },
  {
    id: 'demo-chat-marcus',
    conversationType: 'direct',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    otherUser: {
      id: 'marcus-vance-02',
      username: 'marcus_v',
      displayName: 'Marcus Vance (DevOps)',
      avatarReference: 'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?auto=format&fit=crop&w=200&q=80',
    },
    lastMessage: {
      content: '📷 Encrypted media transfer complete via Drive proxy',
      messageType: 'image',
      senderDisplayName: 'Alex Chen',
      isOwn: true,
      createdAt: new Date(Date.now() - 1000 * 60 * 45).toISOString(),
    },
    unreadCount: 2,
  },
  {
    id: 'demo-group-core',
    conversationType: 'group',
    groupName: 'Vero Security Core',
    groupAvatar: 'https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?auto=format&fit=crop&w=200&q=80',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    lastMessage: {
      content: 'Zero-Knowledge audit verified: No plaintexts in Supabase.',
      messageType: 'text',
      senderDisplayName: 'Security Ops',
      isOwn: false,
      createdAt: new Date(Date.now() - 1000 * 60 * 120).toISOString(),
    },
    unreadCount: 0,
  },
];

// ──────────────────────────────────────────────────────────────────────────
// Main Chats Screen
// ──────────────────────────────────────────────────────────────────────────

export default function ChatsScreen() {
  const { user } = useAuthStore();
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [filteredConversations, setFilteredConversations] = useState<Conversation[]>([]);
  const [selectedCategory, setSelectedCategory] = useState<Category>('All');
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [showSearch, setShowSearch] = useState(false);
  const [matchedMessages, setMatchedMessages] = useState<Message[]>([]);

  const loadConversations = useCallback(async () => {
    if (!user?.id) return;
    try {
      const data = await conversationRepository.getConversations(user.id);
      const list = data && data.length > 0 ? data : DEMO_CONVERSATIONS;
      setConversations(list);
      setFilteredConversations(list);
    } catch (e) {
      console.error('[ChatsScreen] load error:', e);
      setConversations(DEMO_CONVERSATIONS);
      setFilteredConversations(DEMO_CONVERSATIONS);
    } finally {
      setIsLoading(false);
      setIsRefreshing(false);
    }
  }, [user?.id]);

  useEffect(() => {
    loadConversations();
  }, [loadConversations]);

  useEffect(() => {
    if (!searchQuery.trim()) {
      setFilteredConversations(conversations);
      setMatchedMessages([]);
      return;
    }
    const query = searchQuery.toLowerCase();
    setFilteredConversations(
      conversations.filter((c) => {
        const name = c.conversationType === 'direct'
          ? c.otherUser?.displayName?.toLowerCase()
          : c.groupName?.toLowerCase();
        return name?.includes(query);
      })
    );

    databaseService.searchMessages(searchQuery).then((results) => {
      setMatchedMessages(results);
    });
  }, [searchQuery, conversations]);

  const displayedConversations = useMemo(() => {
    let list = filteredConversations;
    if (selectedCategory === 'Direct') {
      list = list.filter((c) => c.conversationType === 'direct');
    } else if (selectedCategory === 'Groups') {
      list = list.filter((c) => c.conversationType === 'group');
    } else if (selectedCategory === 'Unread') {
      list = list.filter((c) => (c.unreadCount || 0) > 0);
    }
    return list;
  }, [filteredConversations, selectedCategory]);

  const handleRefresh = () => {
    setIsRefreshing(true);
    loadConversations();
  };

  const handleChatPress = (conversation: Conversation) => {
    router.push(`/chat/${conversation.id}` as any);
  };

  const handleNewChat = () => {
    router.push('/contacts' as any);
  };

  const handleNewGroup = () => {
    router.push('/new-group' as any);
  };

  if (isLoading) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.loadingContainer}>
          <View style={styles.loadingPulseShield}>
            <Ionicons name="shield-checkmark" size={38} color={Colors.accent} />
          </View>
          <ActivityIndicator size="small" color={Colors.accent} style={{ marginTop: 16 }} />
          <Text style={styles.loadingText}>Decrypting local enclave...</Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <StatusBar barStyle="light-content" backgroundColor={Colors.background} />

      {/* Top Cyber Defense Header */}
      <View style={styles.header}>
        {showSearch ? (
          <View style={styles.searchBar}>
            <Ionicons name="search" size={18} color={Colors.accentLight} style={styles.searchIcon} />
            <TextInput
              style={styles.searchInput}
              placeholder="Search encrypted chats & messages..."
              placeholderTextColor={Colors.textTertiary}
              value={searchQuery}
              onChangeText={setSearchQuery}
              autoFocus
            />
            <TouchableOpacity
              onPress={() => {
                setShowSearch(false);
                setSearchQuery('');
              }}
              style={styles.searchCloseBtn}
            >
              <Ionicons name="close-circle" size={18} color={Colors.textSecondary} />
            </TouchableOpacity>
          </View>
        ) : (
          <>
            <View style={styles.brandRow}>
              <View style={styles.brandIconCircle}>
                <Ionicons name="shield-checkmark" size={20} color={Colors.accent} />
              </View>
              <View>
                <Text style={styles.brandTitle}>VERO</Text>
                <View style={styles.statusBadge}>
                  <View style={styles.statusDotLive} />
                  <Text style={styles.statusText}>E2EE ACTIVE</Text>
                </View>
              </View>
            </View>

            <View style={styles.headerActions}>
              <TouchableOpacity
                style={styles.headerActionBtn}
                onPress={() => setShowSearch(true)}
                activeOpacity={0.7}
              >
                <Ionicons name="search-outline" size={20} color={Colors.textPrimary} />
              </TouchableOpacity>

              <TouchableOpacity
                style={styles.headerActionBtn}
                onPress={handleNewGroup}
                activeOpacity={0.7}
              >
                <Ionicons name="people-outline" size={20} color={Colors.textPrimary} />
              </TouchableOpacity>

              <TouchableOpacity
                style={[styles.headerActionBtn, styles.headerActionBtnPrimary]}
                onPress={handleNewChat}
                activeOpacity={0.7}
              >
                <Ionicons name="create-outline" size={20} color={Colors.accentLight} />
              </TouchableOpacity>
            </View>
          </>
        )}
      </View>

      {/* Category Pills Navigation */}
      {!showSearch && (
        <View style={styles.categoriesBar}>
          {CATEGORIES.map((cat) => {
            const isActive = selectedCategory === cat;
            return (
              <TouchableOpacity
                key={cat}
                style={[styles.categoryChip, isActive && styles.categoryChipActive]}
                onPress={() => setSelectedCategory(cat)}
                activeOpacity={0.7}
              >
                <Text style={[styles.categoryText, isActive && styles.categoryTextActive]}>
                  {cat}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>
      )}

      {/* Main Conversation List */}
      {displayedConversations.length === 0 ? (
        <View style={styles.emptyState}>
          <View style={styles.emptyIcon}>
            <Ionicons name="chatbubbles-outline" size={42} color={Colors.accent} />
          </View>
          <Text style={styles.emptyTitle}>
            {searchQuery ? 'No matching conversations' : 'No chats found'}
          </Text>
          <Text style={styles.emptySubtitle}>
            {searchQuery
              ? 'Try searching by name or decrypted keyword'
              : 'Start a high-security end-to-end encrypted session with contacts'}
          </Text>
          {!searchQuery && (
            <TouchableOpacity
              style={styles.startChatButton}
              onPress={handleNewChat}
              activeOpacity={0.8}
            >
              <Ionicons name="paper-plane" size={16} color="#FFF" style={{ marginRight: 8 }} />
              <Text style={styles.startChatButtonText}>Start New Chat</Text>
            </TouchableOpacity>
          )}
        </View>
      ) : (
        <FlatList
          data={displayedConversations}
          keyExtractor={(item) => item.id}
          renderItem={({ item }) => (
            <ChatListItem
              conversation={item}
              onPress={() => handleChatPress(item)}
            />
          )}
          refreshControl={
            <RefreshControl
              refreshing={isRefreshing}
              onRefresh={handleRefresh}
              tintColor={Colors.accent}
            />
          }
          showsVerticalScrollIndicator={false}
          contentContainerStyle={styles.listContent}
          ItemSeparatorComponent={() => <View style={styles.separator} />}
          ListFooterComponent={
            matchedMessages.length > 0 ? (
              <View style={styles.messagesSearchSection}>
                <View style={styles.searchSectionHeader}>
                  <Ionicons name="lock-closed" size={13} color={Colors.accent} />
                  <Text style={styles.searchSectionTitle}>Decrypted Local Search Matches</Text>
                </View>
                {matchedMessages.map((msg) => (
                  <TouchableOpacity
                    key={msg.id}
                    style={styles.messageSearchResult}
                    onPress={() => router.push(`/chat/${msg.conversationId}` as any)}
                  >
                    <Ionicons name="chatbubble-ellipses-outline" size={18} color={Colors.accentLight} />
                    <View style={{ flex: 1 }}>
                      <Text style={styles.messageSearchText} numberOfLines={1}>
                        {msg.content}
                      </Text>
                      <Text style={styles.messageSearchMeta}>
                        {dayjs(msg.createdAt).format('MMM D, h:mm A')}
                      </Text>
                    </View>
                  </TouchableOpacity>
                ))}
              </View>
            ) : null
          }
        />
      )}

      {/* Floating Action Button */}
      <TouchableOpacity
        style={styles.fab}
        onPress={handleNewChat}
        activeOpacity={0.85}
      >
        <Ionicons name="chatbubble-ellipses" size={24} color="#FFF" />
      </TouchableOpacity>
    </SafeAreaView>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Styles
// ──────────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: Colors.background,
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    gap: 8,
  },
  loadingPulseShield: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: 'rgba(6, 182, 212, 0.12)',
    borderWidth: 1.5,
    borderColor: 'rgba(6, 182, 212, 0.35)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  loadingText: {
    fontSize: Typography.sm,
    color: Colors.textSecondary,
    letterSpacing: 0.4,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.xl,
    paddingTop: Spacing.md,
    paddingBottom: Spacing.sm,
    backgroundColor: Colors.background,
  },
  brandRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
  },
  brandIconCircle: {
    width: 38,
    height: 38,
    borderRadius: 12,
    backgroundColor: 'rgba(6, 182, 212, 0.12)',
    borderWidth: 1,
    borderColor: 'rgba(6, 182, 212, 0.3)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  brandTitle: {
    fontSize: Typography.xl,
    fontWeight: Typography.extrabold,
    color: Colors.textPrimary,
    letterSpacing: 3,
  },
  statusBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    marginTop: 1,
  },
  statusDotLive: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: Colors.emerald,
  },
  statusText: {
    fontSize: 9,
    fontWeight: Typography.bold,
    color: Colors.emerald,
    letterSpacing: 0.8,
  },
  headerActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
  },
  headerActionBtn: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: 'rgba(255, 255, 255, 0.04)',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.08)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  headerActionBtnPrimary: {
    backgroundColor: 'rgba(6, 182, 212, 0.12)',
    borderColor: 'rgba(6, 182, 212, 0.3)',
  },
  searchBar: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#0B1322',
    borderRadius: BorderRadius.lg,
    paddingHorizontal: Spacing.md,
    height: 44,
    borderWidth: 1,
    borderColor: 'rgba(6, 182, 212, 0.3)',
  },
  searchIcon: {
    marginRight: Spacing.sm,
  },
  searchInput: {
    flex: 1,
    color: Colors.textPrimary,
    fontSize: Typography.sm,
    height: '100%',
  },
  searchCloseBtn: {
    padding: 4,
  },
  categoriesBar: {
    flexDirection: 'row',
    paddingHorizontal: Spacing.xl,
    paddingVertical: Spacing.sm,
    gap: Spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255, 255, 255, 0.05)',
  },
  categoryChip: {
    paddingHorizontal: Spacing.md,
    paddingVertical: 6,
    borderRadius: BorderRadius.full,
    backgroundColor: 'rgba(255, 255, 255, 0.04)',
    borderWidth: 1,
    borderColor: 'transparent',
  },
  categoryChipActive: {
    backgroundColor: 'rgba(6, 182, 212, 0.15)',
    borderColor: 'rgba(6, 182, 212, 0.35)',
  },
  categoryText: {
    fontSize: Typography.xs,
    fontWeight: Typography.semibold,
    color: Colors.textTertiary,
    letterSpacing: 0.2,
  },
  categoryTextActive: {
    color: Colors.accentLight,
  },
  listContent: {
    paddingVertical: Spacing.sm,
  },
  chatItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: Spacing.xl,
    paddingVertical: Spacing.md,
    backgroundColor: 'transparent',
  },
  avatarWrapper: {
    position: 'relative',
    marginRight: Spacing.base,
  },
  avatar: {
    width: 52,
    height: 52,
    borderRadius: 26,
    justifyContent: 'center',
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.3,
    shadowRadius: 6,
    elevation: 3,
  },
  avatarText: {
    fontSize: Typography.base,
    fontWeight: Typography.bold,
    color: '#FFF',
    letterSpacing: 0.5,
  },
  onlineDot: {
    position: 'absolute',
    bottom: 0,
    right: 0,
    width: 13,
    height: 13,
    borderRadius: 7,
    backgroundColor: Colors.emerald,
    borderWidth: 2,
    borderColor: Colors.background,
  },
  chatContent: {
    flex: 1,
  },
  chatHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 4,
  },
  nameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    flex: 1,
  },
  chatName: {
    fontSize: Typography.base,
    fontWeight: Typography.semibold,
    color: Colors.textPrimary,
  },
  e2eeShieldMini: {
    opacity: 0.9,
  },
  chatTime: {
    fontSize: Typography.xs,
    color: Colors.textTertiary,
  },
  chatFooter: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  previewRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
    marginRight: Spacing.sm,
  },
  receiptIcon: {
    marginRight: 4,
  },
  chatPreview: {
    fontSize: Typography.sm,
    color: Colors.textSecondary,
    flex: 1,
  },
  chatPreviewUnread: {
    color: Colors.textPrimary,
    fontWeight: Typography.semibold,
  },
  chatMeta: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  unreadBadge: {
    backgroundColor: Colors.accent,
    borderRadius: BorderRadius.full,
    minWidth: 20,
    height: 20,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 6,
    shadowColor: Colors.accent,
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.4,
    shadowRadius: 6,
    elevation: 4,
  },
  unreadCount: {
    fontSize: 10,
    fontWeight: Typography.bold,
    color: '#FFF',
  },
  separator: {
    height: 1,
    backgroundColor: 'rgba(255, 255, 255, 0.04)',
    marginLeft: 84,
  },
  emptyState: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: Spacing['2xl'],
    gap: Spacing.sm,
  },
  emptyIcon: {
    width: 80,
    height: 80,
    borderRadius: 40,
    backgroundColor: 'rgba(6, 182, 212, 0.08)',
    borderWidth: 1,
    borderColor: 'rgba(6, 182, 212, 0.25)',
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: Spacing.md,
  },
  emptyTitle: {
    fontSize: Typography.lg,
    fontWeight: Typography.bold,
    color: Colors.textPrimary,
  },
  emptySubtitle: {
    fontSize: Typography.sm,
    color: Colors.textSecondary,
    textAlign: 'center',
    lineHeight: 20,
    maxWidth: 280,
  },
  startChatButton: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: Colors.accent,
    borderRadius: BorderRadius.lg,
    paddingHorizontal: Spacing.xl,
    paddingVertical: Spacing.md,
    marginTop: Spacing.md,
    shadowColor: Colors.accent,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.4,
    shadowRadius: 10,
    elevation: 6,
  },
  startChatButtonText: {
    color: '#FFF',
    fontSize: Typography.sm,
    fontWeight: Typography.bold,
    letterSpacing: 0.3,
  },
  fab: {
    position: 'absolute',
    bottom: 24,
    right: 20,
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: Colors.accent,
    justifyContent: 'center',
    alignItems: 'center',
    shadowColor: Colors.accent,
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.5,
    shadowRadius: 16,
    elevation: 10,
  },
  messagesSearchSection: {
    marginTop: Spacing.base,
    paddingTop: Spacing.sm,
    borderTopWidth: 1,
    borderTopColor: 'rgba(255, 255, 255, 0.08)',
    paddingHorizontal: Spacing.xl,
  },
  searchSectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: Spacing.sm,
  },
  searchSectionTitle: {
    fontSize: Typography.xs,
    fontWeight: Typography.bold,
    color: Colors.accentLight,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  },
  messageSearchResult: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    paddingVertical: Spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255, 255, 255, 0.04)',
  },
  messageSearchText: {
    fontSize: Typography.sm,
    color: Colors.textPrimary,
  },
  messageSearchMeta: {
    fontSize: Typography.xs,
    color: Colors.textTertiary,
    marginTop: 2,
  },
});
