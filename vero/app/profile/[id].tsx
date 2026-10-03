import React, { useEffect, useState } from 'react';
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  TouchableOpacity,
  Alert,
  ActivityIndicator,
} from 'react-native';
import { useLocalSearchParams, router } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { Colors, Typography, Spacing, BorderRadius } from '../../src/shared/theme/theme';
import { supabase } from '../../src/core/network/supabase';
import { useAuthStore } from '../../src/features/auth/useAuthStore';
import { conversationRepository } from '../../src/features/chats/ConversationRepository';
import { callService } from '../../src/features/calls/CallService';
import { databaseService } from '../../src/core/storage/DatabaseService';

export default function ProfileScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { user } = useAuthStore();

  const [displayName, setDisplayName] = useState('Contact');
  const [username, setUsername] = useState('user');
  const [about, setAbout] = useState('🔐 Privacy is not a crime. Zero-knowledge is freedom.');
  const [isVerified, setIsVerified] = useState(false);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    async function loadProfile() {
      if (!id) return;
      try {
        const { data } = await supabase
          .from('profiles')
          .select('id, display_name, username, about')
          .eq('id', id)
          .single();

        if (data) {
          setDisplayName(data.display_name || 'Contact');
          setUsername(data.username || 'user');
          if (data.about) setAbout(data.about);
        }

        // Check verification status
        const safetyInfo = await databaseService.getSafetyNumber(id);
        if (safetyInfo) {
          setIsVerified(safetyInfo.isVerified);
        }
      } catch (e) {
        // Fallback demo info
      } finally {
        setIsLoading(false);
      }
    }
    loadProfile();
  }, [id]);

  const handleStartChat = async () => {
    if (!user?.id || !id) return;
    const res = await conversationRepository.createDirectConversation(user.id, id);
    if (res) {
      router.push(`/chat/${res.conversationId}` as any);
    }
  };

  const handleStartCall = async (type: 'voice' | 'video') => {
    if (!user?.id || !id) return;
    const callId = await callService.startCall({
      peerId: id,
      peerName: displayName,
      callType: type,
      currentUserId: user.id,
      currentUserName: user.displayName || user.username || 'You',
    });
    router.push(`/call/${callId}` as any);
  };

  const handleOpenVerification = () => {
    if (!id) return;
    router.push(`/verify-safety-number?userId=${id}&displayName=${displayName}` as any);
  };

  const initials = displayName.slice(0, 2).toUpperCase();

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.scrollContent}>
        {/* Frosted Glass Cyber Header */}
        <View style={styles.header}>
          <TouchableOpacity style={styles.backBtn} onPress={() => router.back()} activeOpacity={0.7}>
            <Ionicons name="arrow-back" size={20} color={Colors.textPrimary} />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>Cryptographic Identity</Text>
          <TouchableOpacity style={styles.moreBtn} activeOpacity={0.7}>
            <Ionicons name="shield-outline" size={20} color={Colors.accent} />
          </TouchableOpacity>
        </View>

        {isLoading ? (
          <ActivityIndicator size="large" color={Colors.accent} style={{ marginTop: 40 }} />
        ) : (
          <>
            {/* Cyber Hero Avatar Section */}
            <View style={styles.avatarSection}>
              <View style={styles.avatarHalo}>
                <View style={styles.avatar}>
                  <Text style={styles.avatarText}>{initials}</Text>
                </View>
                <View style={styles.onlineBadge}>
                  <View style={styles.onlineInner} />
                </View>
              </View>

              <View style={styles.nameRow}>
                <Text style={styles.displayName}>{displayName}</Text>
                {isVerified ? (
                  <View style={styles.verifiedBadge}>
                    <Ionicons name="shield-checkmark" size={14} color={Colors.online} />
                    <Text style={styles.verifiedText}>VERIFIED</Text>
                  </View>
                ) : (
                  <View style={styles.unverifiedBadge}>
                    <Text style={styles.unverifiedText}>UNVERIFIED</Text>
                  </View>
                )}
              </View>

              <Text style={styles.username}>@{username} • Curve25519</Text>

              {about ? (
                <View style={styles.aboutCard}>
                  <Ionicons name="finger-print-outline" size={14} color={Colors.accent} />
                  <Text style={styles.about}>{about}</Text>
                </View>
              ) : null}
            </View>

            {/* Quick Action Matrix */}
            <View style={styles.actionsContainer}>
              <TouchableOpacity style={styles.actionBtn} onPress={handleStartChat} activeOpacity={0.8}>
                <View style={[styles.actionIconWrap, { borderColor: 'rgba(6, 182, 212, 0.4)' }]}>
                  <Ionicons name="chatbubble-ellipses-outline" size={22} color={Colors.accent} />
                </View>
                <Text style={styles.actionLabel}>Encrypted Chat</Text>
              </TouchableOpacity>

              <TouchableOpacity style={styles.actionBtn} onPress={() => handleStartCall('voice')} activeOpacity={0.8}>
                <View style={[styles.actionIconWrap, { borderColor: 'rgba(139, 92, 246, 0.4)' }]}>
                  <Ionicons name="call-outline" size={22} color="#8B5CF6" />
                </View>
                <Text style={[styles.actionLabel, { color: '#8B5CF6' }]}>P2P Voice</Text>
              </TouchableOpacity>

              <TouchableOpacity style={styles.actionBtn} onPress={() => handleStartCall('video')} activeOpacity={0.8}>
                <View style={[styles.actionIconWrap, { borderColor: 'rgba(16, 185, 129, 0.4)' }]}>
                  <Ionicons name="videocam-outline" size={22} color={Colors.online} />
                </View>
                <Text style={[styles.actionLabel, { color: Colors.online }]}>P2P Video</Text>
              </TouchableOpacity>
            </View>

            {/* Cryptographic Verification Card */}
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>CRYPTOGRAPHIC VERIFICATION</Text>
              <View style={styles.card}>
                <TouchableOpacity
                  style={styles.cardRowInteractive}
                  onPress={handleOpenVerification}
                  activeOpacity={0.7}
                >
                  <View style={styles.rowIconWrap}>
                    <Ionicons name="qr-code-outline" size={22} color={Colors.accent} />
                  </View>
                  <View style={styles.rowContent}>
                    <View style={styles.rowHeaderLine}>
                      <Text style={styles.rowTitle}>Verify Safety Number</Text>
                      {isVerified ? (
                        <View style={styles.statusPillActive}>
                          <Text style={styles.statusPillActiveText}>MATCH CONFIRMED</Text>
                        </View>
                      ) : (
                        <View style={styles.statusPillPending}>
                          <Text style={styles.statusPillPendingText}>COMPARE FINGERPRINT</Text>
                        </View>
                      )}
                    </View>
                    <Text style={styles.rowSub}>
                      {isVerified
                        ? '60-digit public key fingerprint verified via QR code'
                        : 'Compare 60-digit safety numbers to prevent MITM attacks'}
                    </Text>
                  </View>
                  <Ionicons name="chevron-forward" size={16} color={Colors.textTertiary} />
                </TouchableOpacity>

                <View style={styles.divider} />

                <View style={styles.cardRow}>
                  <View style={styles.rowIconWrap}>
                    <Ionicons name="lock-closed" size={20} color={Colors.online} />
                  </View>
                  <View style={styles.rowContent}>
                    <Text style={styles.rowTitle}>Cipher Suite</Text>
                    <Text style={styles.rowSub}>Curve25519 • XSalsa20 • Poly1305 MAC</Text>
                  </View>
                  <View style={styles.badgePill}>
                    <Text style={styles.badgePillText}>256-BIT</Text>
                  </View>
                </View>

                <View style={styles.divider} />

                <View style={styles.cardRow}>
                  <View style={styles.rowIconWrap}>
                    <Ionicons name="timer-outline" size={20} color="#F59E0B" />
                  </View>
                  <View style={styles.rowContent}>
                    <Text style={styles.rowTitle}>Disappearing Messages</Text>
                    <Text style={styles.rowSub}>Ephemeral self-destruct timers available</Text>
                  </View>
                  <Ionicons name="chevron-forward" size={16} color={Colors.textTertiary} />
                </View>
              </View>
            </View>

            {/* Media & Shared Links */}
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>SHARED ASSETS</Text>
              <View style={styles.card}>
                <TouchableOpacity style={styles.cardRow} activeOpacity={0.7}>
                  <View style={styles.rowIconWrap}>
                    <Ionicons name="images-outline" size={20} color={Colors.accent} />
                  </View>
                  <View style={styles.rowContent}>
                    <Text style={styles.rowTitle}>Media, Files & Links</Text>
                    <Text style={styles.rowSub}>Encrypted attachments stored in Google Drive</Text>
                  </View>
                  <Ionicons name="chevron-forward" size={16} color={Colors.textTertiary} />
                </TouchableOpacity>
              </View>
            </View>

            {/* Privacy Controls & Danger Zone */}
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>SECURITY & PRIVACY ACTIONS</Text>
              <View style={styles.card}>
                <TouchableOpacity
                  style={styles.cardRow}
                  activeOpacity={0.7}
                  onPress={() =>
                    Alert.alert(
                      'Block Identity',
                      `Block ${displayName}? All incoming sessions and calls will be rejected at the cryptographic handshake layer.`,
                      [
                        { text: 'Cancel', style: 'cancel' },
                        { text: 'Block Identity', style: 'destructive' },
                      ]
                    )
                  }
                >
                  <View style={[styles.rowIconWrap, { backgroundColor: 'rgba(239, 68, 68, 0.1)' }]}>
                    <Ionicons name="ban-outline" size={20} color={Colors.error} />
                  </View>
                  <View style={styles.rowContent}>
                    <Text style={[styles.rowTitle, { color: Colors.error }]}>Block {displayName}</Text>
                    <Text style={styles.rowSub}>Prevent any incoming ratcheted handshakes</Text>
                  </View>
                </TouchableOpacity>

                <View style={styles.divider} />

                <TouchableOpacity
                  style={styles.cardRow}
                  activeOpacity={0.7}
                  onPress={() =>
                    Alert.alert(
                      'Report Abuse',
                      `Submit an encrypted diagnostic report for spam or malicious key rotation?`,
                      [
                        { text: 'Cancel', style: 'cancel' },
                        { text: 'Report', style: 'destructive' },
                      ]
                    )
                  }
                >
                  <View style={[styles.rowIconWrap, { backgroundColor: 'rgba(239, 68, 68, 0.1)' }]}>
                    <Ionicons name="flag-outline" size={20} color={Colors.error} />
                  </View>
                  <View style={styles.rowContent}>
                    <Text style={[styles.rowTitle, { color: Colors.error }]}>Report Contact</Text>
                    <Text style={styles.rowSub}>Flag identity impersonation or abuse</Text>
                  </View>
                </TouchableOpacity>
              </View>
            </View>
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: Colors.background,
  },
  scrollContent: {
    paddingBottom: Spacing['3xl'],
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
  backBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: '#0E1726',
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#1E293B',
  },
  headerTitle: {
    fontSize: Typography.base,
    fontWeight: Typography.bold,
    color: Colors.textPrimary,
  },
  moreBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: '#0E1726',
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: 'rgba(6, 182, 212, 0.25)',
  },
  avatarSection: {
    alignItems: 'center',
    paddingVertical: Spacing['2xl'],
    paddingHorizontal: Spacing.base,
    backgroundColor: '#080E1A',
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(6, 182, 212, 0.12)',
  },
  avatarHalo: {
    padding: 6,
    borderRadius: 54,
    backgroundColor: 'rgba(6, 182, 212, 0.08)',
    borderWidth: 1.5,
    borderColor: 'rgba(6, 182, 212, 0.35)',
    position: 'relative',
    marginBottom: Spacing.md,
  },
  avatar: {
    width: 88,
    height: 88,
    borderRadius: 44,
    backgroundColor: '#0284C7',
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 2,
    borderColor: 'rgba(255, 255, 255, 0.15)',
    shadowColor: Colors.accent,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.5,
    shadowRadius: 16,
    elevation: 8,
  },
  avatarText: {
    fontSize: Typography['3xl'],
    fontWeight: Typography.extrabold,
    color: Colors.white,
    letterSpacing: -0.5,
  },
  onlineBadge: {
    position: 'absolute',
    bottom: 6,
    right: 6,
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: '#080E1A',
    justifyContent: 'center',
    alignItems: 'center',
  },
  onlineInner: {
    width: 14,
    height: 14,
    borderRadius: 7,
    backgroundColor: Colors.online,
  },
  nameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 4,
  },
  displayName: {
    fontSize: Typography['2xl'],
    fontWeight: Typography.bold,
    color: Colors.textPrimary,
  },
  verifiedBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: 'rgba(16, 185, 129, 0.15)',
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: BorderRadius.full,
    borderWidth: 1,
    borderColor: 'rgba(16, 185, 129, 0.35)',
  },
  verifiedText: {
    fontSize: 9.5,
    fontWeight: Typography.bold,
    color: Colors.online,
    letterSpacing: 0.5,
  },
  unverifiedBadge: {
    backgroundColor: 'rgba(100, 116, 139, 0.2)',
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: BorderRadius.full,
  },
  unverifiedText: {
    fontSize: 9.5,
    fontWeight: Typography.semibold,
    color: Colors.textTertiary,
  },
  username: {
    fontSize: Typography.xs,
    color: Colors.accent,
    letterSpacing: 0.4,
    marginBottom: Spacing.sm,
  },
  aboutCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: '#0E1726',
    borderRadius: BorderRadius.full,
    paddingHorizontal: Spacing.md,
    paddingVertical: 6,
    borderWidth: 1,
    borderColor: '#1E293B',
    marginTop: 4,
  },
  about: {
    fontSize: Typography.xs,
    color: Colors.textSecondary,
  },
  actionsContainer: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    paddingVertical: Spacing.lg,
    paddingHorizontal: Spacing.base,
    backgroundColor: '#060B16',
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(6, 182, 212, 0.1)',
  },
  actionBtn: {
    alignItems: 'center',
    gap: 6,
  },
  actionIconWrap: {
    width: 50,
    height: 50,
    borderRadius: 25,
    backgroundColor: '#0E1726',
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 1.5,
  },
  actionLabel: {
    fontSize: 11,
    fontWeight: Typography.semibold,
    color: Colors.accent,
  },
  section: {
    paddingHorizontal: Spacing.base,
    marginTop: Spacing.lg,
  },
  sectionTitle: {
    fontSize: 10.5,
    fontWeight: Typography.bold,
    color: Colors.textSecondary,
    letterSpacing: 0.8,
    marginBottom: Spacing.sm,
  },
  card: {
    backgroundColor: '#080E1A',
    borderRadius: BorderRadius.xl,
    borderWidth: 1,
    borderColor: 'rgba(6, 182, 212, 0.15)',
    overflow: 'hidden',
  },
  cardRow: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: Spacing.base,
    gap: Spacing.md,
  },
  cardRowInteractive: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: Spacing.base,
    gap: Spacing.md,
  },
  rowIconWrap: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: 'rgba(6, 182, 212, 0.1)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  rowContent: {
    flex: 1,
  },
  rowHeaderLine: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 2,
  },
  rowTitle: {
    fontSize: Typography.sm,
    fontWeight: Typography.semibold,
    color: Colors.textPrimary,
  },
  rowSub: {
    fontSize: 11,
    color: Colors.textSecondary,
    marginTop: 2,
    lineHeight: 15,
  },
  statusPillActive: {
    backgroundColor: 'rgba(16, 185, 129, 0.15)',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: 'rgba(16, 185, 129, 0.3)',
  },
  statusPillActiveText: {
    fontSize: 9,
    fontWeight: Typography.bold,
    color: Colors.online,
  },
  statusPillPending: {
    backgroundColor: 'rgba(6, 182, 212, 0.15)',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: 'rgba(6, 182, 212, 0.3)',
  },
  statusPillPendingText: {
    fontSize: 9,
    fontWeight: Typography.bold,
    color: Colors.accent,
  },
  badgePill: {
    backgroundColor: 'rgba(16, 185, 129, 0.12)',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: BorderRadius.full,
    borderWidth: 1,
    borderColor: 'rgba(16, 185, 129, 0.3)',
  },
  badgePillText: {
    fontSize: 9,
    fontWeight: Typography.bold,
    color: Colors.online,
  },
  divider: {
    height: 1,
    backgroundColor: '#142036',
    marginLeft: 58,
  },
});

