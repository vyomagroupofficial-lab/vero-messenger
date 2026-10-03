import React, { useEffect, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  Alert,
  Share,
  StatusBar,
  ActivityIndicator,
} from 'react-native';
import { useLocalSearchParams, router } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import { Colors, Typography, Spacing, BorderRadius } from '../src/shared/theme/theme';
import { cryptoManager } from '../src/core/crypto/CryptoManager';
import { databaseService } from '../src/core/storage/DatabaseService';
import { keyDirectory } from '../src/features/keys/KeyDirectory';
import { useAuthStore } from '../src/features/auth/useAuthStore';
import { friendlyError } from '../src/core/network/supabase';

type VerifyState = 'loading' | 'unverified' | 'verified' | 'changed' | 'unavailable';

export default function VerifySafetyNumberScreen() {
  const { userId, displayName } = useLocalSearchParams<{ userId: string; displayName?: string }>();
  const me = useAuthStore((s) => s.user);
  const isDemo = useAuthStore((s) => s.isDemo);

  const [safetyNumber, setSafetyNumber] = useState<string | null>(null);
  const [state, setState] = useState<VerifyState>('loading');
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      if (!userId || !me) return;
      if (isDemo) {
        setError('Safety numbers are computed from real device keys. Sign in with a real account to verify contacts.');
        setState('unavailable');
        return;
      }
      try {
        const [myKeys, theirKeys] = await Promise.all([
          keyDirectory.getUserKeys(me.id),
          keyDirectory.getUserKeys(userId),
        ]);
        if (!theirKeys.length) throw new Error(`${displayName || 'This contact'} has no active devices yet.`);
        const number = await cryptoManager.computeSafetyNumber(
          { userId: me.id, keys: myKeys },
          { userId, keys: theirKeys }
        );
        const verified = await databaseService.getVerifiedSafetyNumber(userId);
        if (cancelled) return;
        setSafetyNumber(number);
        setState(verified === null ? 'unverified' : verified === number ? 'verified' : 'changed');
      } catch (e) {
        if (cancelled) return;
        setError(friendlyError(e, 'Could not compute the safety number.'));
        setState('unavailable');
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [userId, me?.id, isDemo]);

  const isVerified = state === 'verified';

  const toggleVerified = async () => {
    if (!userId || !safetyNumber) return;
    if (isVerified) {
      await databaseService.setVerifiedSafetyNumber(userId, null);
      setState('unverified');
      return;
    }
    await databaseService.setVerifiedSafetyNumber(userId, safetyNumber);
    setState('verified');
    Alert.alert(
      'Marked as verified',
      `If ${displayName || 'this contact'} adds or replaces a device, the number will change and Vero will show it as changed.`
    );
  };

  const handleCopy = async () => {
    if (!safetyNumber) return;
    await Clipboard.setStringAsync(safetyNumber);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleShare = async () => {
    if (!safetyNumber) return;
    try {
      await Share.share({ message: `Our Vero safety number:\n\n${safetyNumber}` });
    } catch {
      // dismissed
    }
  };

  const numberBlocks = safetyNumber ? safetyNumber.split(/\s+/) : [];
  const bannerTitle =
    state === 'verified'
      ? 'Verified'
      : state === 'changed'
        ? 'Safety number changed'
        : state === 'unavailable'
          ? 'Not available'
          : state === 'loading'
            ? 'Computing…'
            : 'Not verified yet';
  const bannerSubtitle =
    state === 'verified'
      ? 'You confirmed this number matches on both devices.'
      : state === 'changed'
        ? `${displayName || 'This contact'} (or you) added or replaced a device since you verified. Compare the new number again.`
        : state === 'unavailable'
          ? error
          : 'Compare this number with the one on their phone, in person or over a trusted channel.';

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <StatusBar barStyle="light-content" backgroundColor={Colors.background} />

      <View style={styles.header}>
        <TouchableOpacity style={styles.backBtn} onPress={() => router.back()}>
          <Ionicons name="arrow-back" size={22} color={Colors.textPrimary} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Verify safety number</Text>
        <TouchableOpacity style={styles.backBtn} onPress={handleShare} disabled={!safetyNumber}>
          <Ionicons name="share-outline" size={22} color={safetyNumber ? Colors.textPrimary : Colors.textTertiary} />
        </TouchableOpacity>
      </View>

      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <View style={[styles.statusBanner, isVerified ? styles.statusBannerVerified : styles.statusBannerUnverified]}>
          <Ionicons
            name={isVerified ? 'shield-checkmark' : state === 'changed' ? 'warning' : 'shield-outline'}
            size={28}
            color={isVerified ? Colors.emerald : Colors.warning}
          />
          <View style={styles.bannerText}>
            <Text style={[styles.bannerTitle, isVerified && { color: Colors.emerald }]}>{bannerTitle}</Text>
            <Text style={styles.bannerSubtitle}>{bannerSubtitle}</Text>
          </View>
        </View>

        {state === 'loading' && <ActivityIndicator color={Colors.accent} style={{ marginVertical: 24 }} />}

        {safetyNumber && (
          <View style={styles.codeCard}>
            <View style={styles.codeHeader}>
              <Text style={styles.codeTitle}>Safety number with {displayName || 'contact'}</Text>
              <TouchableOpacity style={styles.copyBtn} onPress={handleCopy} activeOpacity={0.7}>
                <Ionicons
                  name={copied ? 'checkmark' : 'copy-outline'}
                  size={14}
                  color={copied ? Colors.emerald : Colors.accentLight}
                />
                <Text style={[styles.copyBtnText, copied && { color: Colors.emerald }]}>{copied ? 'Copied' : 'Copy'}</Text>
              </TouchableOpacity>
            </View>

            <View style={styles.blocksGrid}>
              {numberBlocks.map((block, i) => (
                <View key={i} style={styles.blockChip}>
                  <Text style={styles.blockText}>{block}</Text>
                </View>
              ))}
            </View>

            <Text style={styles.codeHint}>
              Both of you see the same 60 digits. If they match, nobody (including Vero's servers) has swapped in
              their own keys between you.
            </Text>
          </View>
        )}

        {safetyNumber && (
          <TouchableOpacity
            style={[styles.verifyButton, isVerified ? styles.verifyButtonActive : styles.verifyButtonInactive]}
            onPress={toggleVerified}
            activeOpacity={0.85}
          >
            <Ionicons name={isVerified ? 'checkmark-circle' : 'shield-checkmark'} size={22} color="#FFF" />
            <Text style={styles.verifyButtonText}>{isVerified ? 'Verified (tap to clear)' : 'Mark as verified'}</Text>
          </TouchableOpacity>
        )}

        <View style={styles.explainerCard}>
          <View style={styles.explainerRow}>
            <Ionicons name="key" size={18} color={Colors.accentLight} />
            <Text style={styles.explainerHeading}>How it works</Text>
          </View>
          <Text style={styles.explainerBody}>
            The number is derived (iterated BLAKE2b) from the public identity keys of every active device on both
            accounts. Private keys never leave your devices.
          </Text>
        </View>
      </ScrollView>
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
    paddingVertical: Spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255, 255, 255, 0.08)',
    backgroundColor: Colors.background,
  },
  backBtn: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: 'rgba(255, 255, 255, 0.04)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  headerTitle: {
    fontSize: Typography.lg,
    fontWeight: Typography.bold,
    color: Colors.textPrimary,
  },
  content: {
    padding: Spacing.xl,
    gap: Spacing.lg,
    paddingBottom: 60,
  },
  statusBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: Spacing.lg,
    borderRadius: BorderRadius.xl,
    gap: Spacing.md,
    borderWidth: 1,
  },
  statusBannerVerified: {
    backgroundColor: 'rgba(16, 185, 129, 0.08)',
    borderColor: 'rgba(16, 185, 129, 0.3)',
  },
  statusBannerUnverified: {
    backgroundColor: 'rgba(245, 158, 11, 0.08)',
    borderColor: 'rgba(245, 158, 11, 0.3)',
  },
  bannerText: {
    flex: 1,
  },
  bannerTitle: {
    fontSize: Typography.base,
    fontWeight: Typography.bold,
    color: Colors.textPrimary,
  },
  bannerSubtitle: {
    fontSize: Typography.xs,
    color: Colors.textSecondary,
    marginTop: 2,
    lineHeight: 16,
  },
  qrCard: {
    backgroundColor: '#0A1222',
    padding: Spacing.lg,
    borderRadius: BorderRadius.xl,
    borderWidth: 1,
    borderColor: 'rgba(6, 182, 212, 0.2)',
    alignItems: 'center',
    gap: Spacing.md,
  },
  qrMatrixFrame: {
    padding: Spacing.md,
    backgroundColor: '#070D18',
    borderRadius: BorderRadius.lg,
    borderWidth: 1,
    borderColor: 'rgba(6, 182, 212, 0.3)',
  },
  qrHint: {
    fontSize: Typography.xs,
    color: Colors.textTertiary,
    textAlign: 'center',
  },
  codeCard: {
    backgroundColor: '#0A1222',
    padding: Spacing.lg,
    borderRadius: BorderRadius.xl,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.08)',
    gap: Spacing.md,
  },
  codeHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  codeTitle: {
    fontSize: Typography.sm,
    fontWeight: Typography.semibold,
    color: Colors.textSecondary,
  },
  copyBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: 'rgba(6, 182, 212, 0.12)',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: BorderRadius.md,
    borderWidth: 1,
    borderColor: 'rgba(6, 182, 212, 0.25)',
  },
  copyBtnText: {
    fontSize: Typography.xs,
    fontWeight: Typography.bold,
    color: Colors.accentLight,
  },
  blocksGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    gap: 8,
  },
  blockChip: {
    width: '31%',
    backgroundColor: '#070D18',
    paddingVertical: 8,
    borderRadius: BorderRadius.md,
    borderWidth: 1,
    borderColor: 'rgba(6, 182, 212, 0.18)',
    alignItems: 'center',
  },
  blockText: {
    fontFamily: 'monospace',
    fontSize: Typography.sm,
    fontWeight: Typography.bold,
    color: Colors.accentLight,
    letterSpacing: 1,
  },
  codeHint: {
    fontSize: Typography.xs,
    color: Colors.textTertiary,
    textAlign: 'center',
    lineHeight: 17,
  },
  verifyButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.sm,
    paddingVertical: Spacing.base,
    borderRadius: BorderRadius.lg,
  },
  verifyButtonInactive: {
    backgroundColor: Colors.accent,
    shadowColor: Colors.accent,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.4,
    shadowRadius: 10,
    elevation: 6,
  },
  verifyButtonActive: {
    backgroundColor: Colors.emerald,
    shadowColor: Colors.emerald,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.4,
    shadowRadius: 10,
    elevation: 6,
  },
  verifyButtonText: {
    fontSize: Typography.base,
    fontWeight: Typography.bold,
    color: '#FFF',
  },
  explainerCard: {
    backgroundColor: '#091220',
    padding: Spacing.base,
    borderRadius: BorderRadius.lg,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.08)',
    gap: Spacing.xs,
  },
  explainerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.xs,
  },
  explainerHeading: {
    fontSize: Typography.sm,
    fontWeight: Typography.semibold,
    color: Colors.textPrimary,
  },
  explainerBody: {
    fontSize: Typography.xs,
    color: Colors.textSecondary,
    lineHeight: 18,
  },
});
