import React, { useState, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  FlatList,
  RefreshControl,
  StatusBar,
  Alert,
} from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { Colors, Typography, Spacing, BorderRadius } from '../../src/shared/theme/theme';
import { databaseService, LocalCallRecord } from '../../src/core/storage/DatabaseService';
import { callService } from '../../src/features/calls/CallService';
import { useAuthStore } from '../../src/features/auth/useAuthStore';
import { useChatsStore } from '../../src/features/chats/useChatsStore';
import { conversationRepository } from '../../src/features/chats/ConversationRepository';
import { friendlyError } from '../../src/core/network/supabase';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';

dayjs.extend(relativeTime);

function CallListItem({ call, onRecall }: { call: LocalCallRecord; onRecall: () => void }) {
  const initials = call.peerName.slice(0, 2).toUpperCase();
  const isMissed = call.direction === 'missed';

  const getCallColor = () => {
    if (isMissed) return Colors.error;
    if (call.direction === 'outgoing') return Colors.accentLight;
    return Colors.emerald;
  };

  const getArrowIcon = () => {
    if (call.direction === 'incoming') return 'arrow-down';
    if (call.direction === 'outgoing') return 'arrow-up';
    return 'close';
  };

  const formatDuration = (sec: number) => {
    if (!sec) return '';
    const mins = Math.floor(sec / 60);
    const remaining = sec % 60;
    return ` (${mins}:${remaining.toString().padStart(2, '0')})`;
  };

  return (
    <TouchableOpacity style={styles.callItem} activeOpacity={0.75} onPress={onRecall}>
      <View style={styles.callAvatar}>
        <Text style={styles.callAvatarText}>{initials}</Text>
      </View>

      <View style={styles.callInfo}>
        <Text style={[styles.callName, isMissed && styles.callNameMissed]} numberOfLines={1}>
          {call.peerName}
        </Text>
        <View style={styles.callMeta}>
          <View style={[styles.directionPill, { backgroundColor: `${getCallColor()}18` }]}>
            <Ionicons name={getArrowIcon() as any} size={11} color={getCallColor()} />
            <Text style={[styles.callType, { color: getCallColor() }]}>
              {call.direction}
            </Text>
          </View>
          <Text style={styles.callTime}> · {dayjs(call.createdAt).fromNow()}</Text>
          {call.duration > 0 && <Text style={styles.callDuration}>{formatDuration(call.duration)}</Text>}
        </View>
      </View>

      <View style={styles.callActions}>
        <TouchableOpacity style={styles.callActionBtn} onPress={onRecall} activeOpacity={0.8}>
          <Ionicons
            name={call.callType === 'video' ? 'videocam' : 'call'}
            size={18}
            color={Colors.accentLight}
          />
        </TouchableOpacity>
      </View>
    </TouchableOpacity>
  );
}

export default function CallsScreen() {
  const user = useAuthStore((s) => s.user);
  const isDemo = useAuthStore((s) => s.isDemo);
  const [calls, setCalls] = useState<LocalCallRecord[]>([]);
  const [isRefreshing, setIsRefreshing] = useState(false);

  const loadCalls = useCallback(async () => {
    setCalls(await databaseService.getCallLogs(50));
    setIsRefreshing(false);
  }, []);

  useFocusEffect(
    useCallback(() => {
      void loadCalls();
    }, [loadCalls])
  );

  const handleStartCall = async (peerId: string, peerName: string, callType: 'voice' | 'video' = 'voice') => {
    if (!user?.id) return;
    try {
      const existing = useChatsStore.getState().conversations.find((c) => c.otherUser?.id === peerId);
      const conversationId =
        existing?.id ?? (isDemo ? null : await conversationRepository.createDirectConversation(peerId));
      if (!conversationId) return;
      const callId = await callService.startCall({ conversationId, peerId, peerName, callType });
      router.push(`/call/${callId}`);
    } catch (e) {
      Alert.alert('Call failed', friendlyError(e));
    }
  };

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <StatusBar barStyle="light-content" backgroundColor={Colors.background} />

      {/* Header */}
      <View style={styles.header}>
        <View style={styles.headerLeft}>
          <Text style={styles.headerTitle}>Calls</Text>
          <View style={styles.webrtcPill}>
            <Ionicons name="radio" size={11} color={Colors.emerald} />
            <Text style={styles.webrtcPillText}>BETA</Text>
          </View>
        </View>
        <TouchableOpacity
          style={styles.headerButton}
          onPress={() => router.push('/(tabs)/contacts')}
          activeOpacity={0.8}
        >
          <Ionicons name="call" size={18} color={Colors.accentLight} />
        </TouchableOpacity>
      </View>

      {/* Security Telemetry Banner */}
      <View style={styles.securityBanner}>
        <View style={styles.securityIconCircle}>
          <Ionicons name="shield-checkmark" size={16} color={Colors.emerald} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={styles.securityTitle}>Calling is in beta</Text>
          <Text style={styles.securityText}>
            Ringing, answering and call history work today. Encrypted audio/video streaming (WebRTC) is coming next.
          </Text>
        </View>
      </View>

      {/* Call list */}
      <FlatList
        data={calls}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => (
          <CallListItem
            call={item}
            onRecall={() => handleStartCall(item.peerId, item.peerName, item.callType)}
          />
        )}
        ItemSeparatorComponent={() => <View style={styles.separator} />}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.listContent}
        refreshControl={
          <RefreshControl
            refreshing={isRefreshing}
            onRefresh={() => {
              setIsRefreshing(true);
              void loadCalls();
            }}
            tintColor={Colors.accent}
          />
        }
        ListHeaderComponent={
          <Text style={styles.listHeader}>{calls.length ? 'Recent calls (stored on this device)' : 'No calls yet'}</Text>
        }
      />

      {/* New Call FAB */}
      <TouchableOpacity
        style={styles.fab}
        onPress={() => router.push('/(tabs)/contacts')}
        activeOpacity={0.85}
      >
        <Ionicons name="call" size={24} color="#FFF" />
      </TouchableOpacity>
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
    paddingHorizontal: Spacing.xl,
    paddingTop: Spacing.md,
    paddingBottom: Spacing.sm,
    backgroundColor: Colors.background,
  },
  headerLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
  },
  headerTitle: {
    fontSize: Typography['2xl'],
    fontWeight: Typography.extrabold,
    color: Colors.textPrimary,
    letterSpacing: -0.5,
  },
  webrtcPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: 'rgba(16, 185, 129, 0.12)',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: BorderRadius.full,
    borderWidth: 1,
    borderColor: 'rgba(16, 185, 129, 0.25)',
  },
  webrtcPillText: {
    fontSize: 9,
    fontWeight: Typography.bold,
    color: Colors.emerald,
    letterSpacing: 0.5,
  },
  headerButton: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: 'rgba(6, 182, 212, 0.12)',
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: 'rgba(6, 182, 212, 0.3)',
  },
  securityBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    marginHorizontal: Spacing.xl,
    marginTop: Spacing.sm,
    marginBottom: Spacing.sm,
    padding: Spacing.md,
    backgroundColor: 'rgba(16, 185, 129, 0.08)',
    borderRadius: BorderRadius.lg,
    borderWidth: 1,
    borderColor: 'rgba(16, 185, 129, 0.2)',
  },
  securityIconCircle: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: 'rgba(16, 185, 129, 0.16)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  securityTitle: {
    fontSize: Typography.xs,
    fontWeight: Typography.bold,
    color: Colors.emerald,
    letterSpacing: 0.4,
    textTransform: 'uppercase',
  },
  securityText: {
    fontSize: 11,
    color: Colors.textSecondary,
    lineHeight: 16,
    marginTop: 2,
  },
  listContent: {
    paddingHorizontal: Spacing.xl,
    paddingBottom: 90,
  },
  listHeader: {
    fontSize: Typography.xs,
    fontWeight: Typography.bold,
    color: Colors.textTertiary,
    letterSpacing: 0.8,
    textTransform: 'uppercase',
    marginTop: Spacing.base,
    marginBottom: Spacing.sm,
  },
  callItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: Spacing.md,
  },
  callAvatar: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: '#8B5CF6',
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: Spacing.md,
    shadowColor: '#8B5CF6',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.25,
    shadowRadius: 6,
  },
  callAvatarText: {
    fontSize: Typography.base,
    fontWeight: Typography.bold,
    color: '#FFF',
  },
  callInfo: {
    flex: 1,
    gap: 4,
  },
  callName: {
    fontSize: Typography.base,
    fontWeight: Typography.semibold,
    color: Colors.textPrimary,
  },
  callNameMissed: {
    color: Colors.error,
  },
  callMeta: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  directionPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: BorderRadius.full,
  },
  callType: {
    fontSize: 10,
    fontWeight: Typography.bold,
    textTransform: 'capitalize',
  },
  callTime: {
    fontSize: Typography.xs,
    color: Colors.textTertiary,
  },
  callDuration: {
    fontSize: Typography.xs,
    color: Colors.textTertiary,
  },
  callActions: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  callActionBtn: {
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
});
