import React, { useCallback, useEffect, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  Switch,
  Alert,
  Modal,
  Pressable,
  ActivityIndicator,
  TextInput,
} from 'react-native';
import { router } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import dayjs from 'dayjs';
import { useAuthStore } from '../../src/features/auth/useAuthStore';
import { authRepository } from '../../src/features/auth/AuthRepository';
import { cryptoManager } from '../../src/core/crypto/CryptoManager';
import { databaseService } from '../../src/core/storage/DatabaseService';
import { friendlyError } from '../../src/core/network/supabase';
import { mediaRepository } from '../../src/features/media/MediaRepository';
import { useSettingsStore } from '../../src/features/settings/useSettingsStore';
import { registerForPush, unregisterPush } from '../../src/features/notifications/pushRegistration';
import { Colors, Typography, Spacing, BorderRadius } from '../../src/shared/theme/theme';

interface SettingItem {
  icon: keyof typeof Ionicons.glyphMap;
  iconColor?: string;
  label: string;
  value?: string;
  onPress?: () => void;
  toggle?: boolean;
  toggleValue?: boolean;
  onToggle?: (v: boolean) => void;
  danger?: boolean;
}

function SettingRow({ item }: { item: SettingItem }) {
  return (
    <TouchableOpacity
      style={styles.settingRow}
      onPress={item.onPress}
      disabled={item.toggle || !item.onPress}
      activeOpacity={item.onPress ? 0.7 : 1}
    >
      <View style={[styles.settingIcon, { backgroundColor: `${item.iconColor || Colors.accent}20` }]}>
        <Ionicons name={item.icon} size={20} color={item.iconColor || Colors.accent} />
      </View>
      <View style={styles.settingContent}>
        <Text style={[styles.settingLabel, item.danger && styles.settingLabelDanger]}>{item.label}</Text>
        {item.value ? <Text style={styles.settingValue}>{item.value}</Text> : null}
      </View>
      {item.toggle ? (
        <Switch
          value={item.toggleValue}
          onValueChange={item.onToggle}
          trackColor={{ false: Colors.border, true: `${Colors.accent}80` }}
          thumbColor={item.toggleValue ? Colors.accent : Colors.textTertiary}
        />
      ) : item.onPress ? (
        <Ionicons name="chevron-forward" size={18} color={Colors.textTertiary} />
      ) : null}
    </TouchableOpacity>
  );
}

function SettingSection({ title, items }: { title: string; items: SettingItem[] }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      <View style={styles.sectionContent}>
        {items.map((item, index) => (
          <React.Fragment key={item.label}>
            <SettingRow item={item} />
            {index < items.length - 1 && <View style={styles.settingSeparator} />}
          </React.Fragment>
        ))}
      </View>
    </View>
  );
}

type LinkedDevice = Awaited<ReturnType<typeof authRepository.listDevices>>[number];

export default function SettingsScreen() {
  const user = useAuthStore((s) => s.user);
  const deviceId = useAuthStore((s) => s.deviceId);
  const isDemo = useAuthStore((s) => s.isDemo);
  const logout = useAuthStore((s) => s.logout);
  const updateProfile = useAuthStore((s) => s.updateProfile);
  const settings = useSettingsStore();

  const [showKeysModal, setShowKeysModal] = useState(false);
  const [showDevicesModal, setShowDevicesModal] = useState(false);
  const [showAuditModal, setShowAuditModal] = useState(false);
  const [showProfileModal, setShowProfileModal] = useState(false);
  const [publicKey, setPublicKey] = useState<string | null>(null);
  const [devices, setDevices] = useState<LinkedDevice[] | null>(null);
  const [draftName, setDraftName] = useState('');
  const [draftAbout, setDraftAbout] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (user && !isDemo) void cryptoManager.getIdentityPublicKey(user.id).then(setPublicKey);
  }, [user?.id, isDemo]);

  const loadDevices = useCallback(async () => {
    setDevices(null);
    try {
      setDevices(await authRepository.listDevices());
    } catch (e) {
      setDevices([]);
      Alert.alert('Could not load devices', friendlyError(e));
    }
  }, []);

  const activeDevices = devices?.filter((d) => !d.revokedAt) ?? [];

  const handleRevoke = (device: LinkedDevice) => {
    Alert.alert(
      'Unlink device',
      `Unlink "${device.deviceLabel}"? New messages will no longer be encrypted for it and it will be signed out of encryption.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Unlink',
          style: 'destructive',
          onPress: async () => {
            try {
              await authRepository.revokeDevice(device.id);
              await loadDevices();
            } catch (e) {
              Alert.alert('Could not unlink device', friendlyError(e));
            }
          },
        },
      ]
    );
  };

  const handleLogout = () => {
    Alert.alert(
      isDemo ? 'Leave demo' : 'Log out',
      isDemo
        ? 'Return to the sign-in screen?'
        : 'Your encryption keys and message history stay on this device so you can sign back in. To remove them, use "Erase this device" instead.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: isDemo ? 'Leave' : 'Log out',
          style: 'destructive',
          onPress: async () => {
            await logout();
            router.replace('/(auth)/login');
          },
        },
      ]
    );
  };

  const handleEraseDevice = () => {
    Alert.alert(
      'Erase this device',
      'This deletes all decrypted messages, cached media and this device\'s encryption keys, unlinks it from your account and signs out. Messages sent before now can no longer be read here.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Erase',
          style: 'destructive',
          onPress: async () => {
            try {
              if (user && deviceId && !isDemo) {
                await authRepository.revokeDevice(deviceId).catch(() => undefined);
                await cryptoManager.clearIdentity(user.id);
              }
              await databaseService.clearAllData();
              mediaRepository.clearCache();
            } finally {
              await logout();
              router.replace('/(auth)/login');
            }
          },
        },
      ]
    );
  };

  const handleClearCache = () => {
    Alert.alert('Clear media cache', 'Removes decrypted copies of photos, videos and files from this device. They can be downloaded again.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Clear',
        style: 'destructive',
        onPress: () => {
          try {
            mediaRepository.clearCache();
            Alert.alert('Done', 'Media cache cleared.');
          } catch (e) {
            Alert.alert('Could not clear cache', friendlyError(e));
          }
        },
      },
    ]);
  };

  const toggleNotifications = async (enabled: boolean) => {
    settings.set({ notifications: enabled });
    if (!deviceId || isDemo) return;
    if (enabled) await registerForPush(deviceId);
    else await unregisterPush(deviceId).catch(() => undefined);
  };

  const openProfileEditor = () => {
    setDraftName(user?.displayName || '');
    setDraftAbout(user?.about || '');
    setShowProfileModal(true);
  };

  const saveProfile = async () => {
    if (!draftName.trim()) return Alert.alert('Name required', 'Please enter a display name.');
    setSaving(true);
    const result = await updateProfile({ displayName: draftName, about: draftAbout });
    setSaving(false);
    if (result.success) setShowProfileModal(false);
    else Alert.alert('Could not save profile', result.error);
  };

  const initials = (user?.displayName || user?.email || 'U').slice(0, 2).toUpperCase();

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <ScrollView showsVerticalScrollIndicator={false}>
        <View style={styles.header}>
          <Text style={styles.headerTitle}>Settings</Text>
        </View>

        <TouchableOpacity style={styles.profileCard} onPress={openProfileEditor} activeOpacity={0.8}>
          <View style={styles.profileAvatar}>
            <Text style={styles.profileAvatarText}>{initials}</Text>
          </View>
          <View style={styles.profileInfo}>
            <Text style={styles.profileName}>{user?.displayName || 'Set your name'}</Text>
            <Text style={styles.profileUsername}>@{user?.username || 'username'}</Text>
            <View style={styles.profileStatus}>
              <Ionicons name={isDemo ? 'sparkles' : 'create-outline'} size={13} color={Colors.accent} />
              <Text style={styles.profileStatusText}>{isDemo ? 'Demo account' : 'Tap to edit profile'}</Text>
            </View>
          </View>
        </TouchableOpacity>

        <SettingSection
          title="Privacy"
          items={[
            {
              icon: 'checkmark-done-outline',
              label: 'Read receipts',
              value: 'If off, others only see that messages were delivered',
              toggle: true,
              toggleValue: settings.readReceipts,
              onToggle: (v) => settings.set({ readReceipts: v }),
              iconColor: Colors.teal,
            },
            {
              icon: 'create-outline',
              label: 'Typing indicators',
              value: 'Let others see when you are typing',
              toggle: true,
              toggleValue: settings.typingIndicators,
              onToggle: (v) => settings.set({ typingIndicators: v }),
              iconColor: Colors.purple,
            },
            {
              icon: 'notifications-outline',
              label: 'Notifications',
              value: 'Push alerts never include message content',
              toggle: true,
              toggleValue: settings.notifications,
              onToggle: (v) => void toggleNotifications(v),
              iconColor: Colors.warning,
            },
          ]}
        />

        <SettingSection
          title="Security"
          items={[
            ...(isDemo
              ? []
              : [
                  {
                    icon: 'phone-portrait-outline' as const,
                    label: 'Linked devices',
                    value: 'See and unlink devices that can read your messages',
                    onPress: () => {
                      setShowDevicesModal(true);
                      void loadDevices();
                    },
                    iconColor: Colors.accent,
                  },
                  {
                    icon: 'qr-code-outline' as const,
                    label: 'Devices & transfer',
                    value: 'Link a computer by QR, move chats to a new phone',
                    onPress: () => router.push('/devices'),
                    iconColor: Colors.purple,
                  },
                  {
                    icon: 'eye-outline' as const,
                    label: 'Who can find me',
                    value: 'Contact discovery by email or phone (off by default)',
                    onPress: () => router.push('/discovery/settings'),
                    iconColor: Colors.teal,
                  },
                  {
                    icon: 'key-outline' as const,
                    label: 'This device\'s identity key',
                    value: 'Public key only',
                    onPress: () => setShowKeysModal(true),
                    iconColor: Colors.warning,
                  },
                ]),
            {
              icon: 'shield-checkmark-outline',
              label: 'How Vero protects you',
              onPress: () => setShowAuditModal(true),
              iconColor: Colors.teal,
            },
          ]}
        />

        <SettingSection
          title="Storage"
          items={[
            { icon: 'images-outline', label: 'Clear media cache', onPress: handleClearCache, iconColor: Colors.warning },
            {
              icon: 'nuclear-outline',
              label: 'Erase this device',
              value: 'Delete local messages and keys, then sign out',
              onPress: handleEraseDevice,
              iconColor: Colors.error,
              danger: true,
            },
          ]}
        />

        <View style={styles.section}>
          <TouchableOpacity style={styles.logoutBtn} onPress={handleLogout}>
            <Ionicons name="log-out-outline" size={20} color={Colors.error} />
            <Text style={styles.logoutText}>{isDemo ? 'Leave demo' : 'Log out'}</Text>
          </TouchableOpacity>
        </View>
      </ScrollView>

      {/* Edit profile */}
      <Modal visible={showProfileModal} transparent animationType="slide" onRequestClose={() => setShowProfileModal(false)}>
        <Pressable style={styles.modalBackdrop} onPress={() => setShowProfileModal(false)}>
          <Pressable style={styles.sheet} onPress={() => undefined}>
            <View style={styles.sheetHandle} />
            <Text style={styles.sheetTitle}>Edit profile</Text>
            <Text style={styles.keyLabel}>Display name</Text>
            <TextInput style={styles.input} value={draftName} onChangeText={setDraftName} maxLength={64} />
            <Text style={styles.keyLabel}>About</Text>
            <TextInput
              style={[styles.input, { minHeight: 70 }]}
              value={draftAbout}
              onChangeText={setDraftAbout}
              maxLength={280}
              multiline
            />
            <Text style={styles.sheetDescription}>Your profile is visible to other Vero users. It is not end-to-end encrypted.</Text>
            <TouchableOpacity style={[styles.primaryActionBtn, saving && { opacity: 0.6 }]} onPress={saveProfile} disabled={saving}>
              {saving ? <ActivityIndicator color={Colors.white} /> : <Text style={styles.primaryActionText}>Save</Text>}
            </TouchableOpacity>
            <TouchableOpacity style={styles.closeBtn} onPress={() => setShowProfileModal(false)}>
              <Text style={styles.closeBtnText}>Cancel</Text>
            </TouchableOpacity>
          </Pressable>
        </Pressable>
      </Modal>

      {/* Identity key */}
      <Modal visible={showKeysModal} transparent animationType="slide" onRequestClose={() => setShowKeysModal(false)}>
        <Pressable style={styles.modalBackdrop} onPress={() => setShowKeysModal(false)}>
          <View style={styles.sheet}>
            <View style={styles.sheetHandle} />
            <Text style={styles.sheetTitle}>This device</Text>
            <View style={styles.keyBlock}>
              <Text style={styles.keyLabel}>Identity public key (X25519)</Text>
              <Text style={styles.keyValue} selectable>
                {publicKey || '—'}
              </Text>
            </View>
            <View style={styles.keyBlock}>
              <Text style={styles.keyLabel}>Device ID</Text>
              <Text style={styles.keyValue} selectable>
                {deviceId || '—'}
              </Text>
            </View>
            <View style={styles.noticeBox}>
              <Ionicons name="shield-checkmark" size={16} color={Colors.accent} />
              <Text style={styles.noticeText}>
                The matching private key is stored in this device's secure keystore and never leaves it.
              </Text>
            </View>
            <TouchableOpacity style={styles.closeBtn} onPress={() => setShowKeysModal(false)}>
              <Text style={styles.closeBtnText}>Done</Text>
            </TouchableOpacity>
          </View>
        </Pressable>
      </Modal>

      {/* Linked devices */}
      <Modal visible={showDevicesModal} transparent animationType="slide" onRequestClose={() => setShowDevicesModal(false)}>
        <Pressable style={styles.modalBackdrop} onPress={() => setShowDevicesModal(false)}>
          <Pressable style={styles.sheet} onPress={() => undefined}>
            <View style={styles.sheetHandle} />
            <Text style={styles.sheetTitle}>Linked devices</Text>
            {devices === null ? (
              <ActivityIndicator color={Colors.accent} style={{ marginVertical: 20 }} />
            ) : (
              <ScrollView style={{ maxHeight: 320 }}>
                {activeDevices.map((d) => (
                  <View key={d.id} style={styles.deviceRow}>
                    <View style={styles.deviceIcon}>
                      <Ionicons name="phone-portrait" size={24} color={Colors.accent} />
                    </View>
                    <View style={styles.deviceInfo}>
                      <Text style={styles.deviceName}>
                        {d.deviceLabel}
                        {d.id === deviceId ? ' (this device)' : ''}
                      </Text>
                      <Text style={styles.deviceIdText}>
                        Added {dayjs(d.createdAt).format('MMM D, YYYY')} · last active {dayjs(d.lastSeenAt).format('MMM D')}
                      </Text>
                    </View>
                    {d.id !== deviceId && (
                      <TouchableOpacity onPress={() => handleRevoke(d)}>
                        <Ionicons name="close-circle-outline" size={22} color={Colors.error} />
                      </TouchableOpacity>
                    )}
                  </View>
                ))}
              </ScrollView>
            )}
            <View style={styles.noticeBox}>
              <Ionicons name="information-circle" size={16} color={Colors.accent} />
              <Text style={styles.noticeText}>
                Each device has its own key. Messages are encrypted separately for every linked device, so a new
                device can't read messages sent before it was linked.
              </Text>
            </View>
            <TouchableOpacity style={styles.closeBtn} onPress={() => setShowDevicesModal(false)}>
              <Text style={styles.closeBtnText}>Done</Text>
            </TouchableOpacity>
          </Pressable>
        </Pressable>
      </Modal>

      {/* Security overview (honest, including limitations) */}
      <Modal visible={showAuditModal} transparent animationType="slide" onRequestClose={() => setShowAuditModal(false)}>
        <Pressable style={styles.modalBackdrop} onPress={() => setShowAuditModal(false)}>
          <View style={styles.sheet}>
            <View style={styles.sheetHandle} />
            <Text style={styles.sheetTitle}>How Vero protects you</Text>
            <ScrollView style={{ maxHeight: 380 }} showsVerticalScrollIndicator={false}>
              {[
                { ok: true, title: 'End-to-end encrypted messages', desc: 'Messages are encrypted on your device for each recipient device (X25519 + XChaCha20-Poly1305). Servers store ciphertext only.' },
                { ok: true, title: 'Encrypted attachments', desc: 'Every file gets its own random key before upload; Google Drive only stores ciphertext.' },
                { ok: true, title: 'Keys stay on your device', desc: 'Private keys live in the platform keystore (Keychain / Keystore).' },
                { ok: true, title: 'Server-side access control', desc: 'Row-level security and private realtime channels limit metadata to conversation members.' },
                { ok: true, title: 'Key pinning & safety numbers', desc: 'A device key change is rejected, and safety numbers let you rule out key substitution.' },
                { ok: false, title: 'Not yet: forward secrecy', desc: 'Messages use long-term device keys. A ratcheting protocol (Double Ratchet/MLS) is on the roadmap.' },
                { ok: false, title: 'Visible metadata', desc: 'Servers can see who talks to whom and when, group names, and profile details.' },
              ].map((item) => (
                <View key={item.title} style={styles.auditItem}>
                  <Ionicons
                    name={item.ok ? 'checkmark-circle' : 'alert-circle'}
                    size={20}
                    color={item.ok ? Colors.online : Colors.warning}
                  />
                  <View style={{ flex: 1 }}>
                    <Text style={styles.auditTitle}>{item.title}</Text>
                    <Text style={styles.auditDesc}>{item.desc}</Text>
                  </View>
                </View>
              ))}
            </ScrollView>
            <TouchableOpacity style={styles.closeBtn} onPress={() => setShowAuditModal(false)}>
              <Text style={styles.closeBtnText}>Got it</Text>
            </TouchableOpacity>
          </View>
        </Pressable>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  input: {
    backgroundColor: '#0B1322',
    borderRadius: BorderRadius.md,
    borderWidth: 1,
    borderColor: Colors.border,
    color: Colors.textPrimary,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
    marginBottom: Spacing.md,
    fontSize: Typography.base,
  },
  container: { flex: 1, backgroundColor: Colors.background },
  header: {
    paddingHorizontal: Spacing.base,
    paddingVertical: Spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
  },
  headerTitle: {
    fontSize: Typography['2xl'],
    fontWeight: Typography.bold,
    color: Colors.textPrimary,
  },
  profileCard: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: Spacing.lg,
    backgroundColor: '#0A1324',
    marginHorizontal: Spacing.xl,
    marginTop: Spacing.md,
    marginBottom: Spacing.lg,
    borderRadius: BorderRadius.xl,
    borderWidth: 1,
    borderColor: 'rgba(6, 182, 212, 0.25)',
  },
  profileAvatar: {
    width: 60,
    height: 60,
    borderRadius: 30,
    backgroundColor: '#0284C7',
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: Spacing.base,
    borderWidth: 2,
    borderColor: Colors.accentLight,
  },
  profileAvatarText: {
    fontSize: Typography.xl,
    fontWeight: Typography.bold,
    color: Colors.white,
  },
  profileInfo: {
    flex: 1,
  },
  profileName: {
    fontSize: Typography.lg,
    fontWeight: Typography.bold,
    color: Colors.textPrimary,
  },
  profileUsername: {
    fontSize: Typography.sm,
    color: Colors.textSecondary,
    marginBottom: 4,
  },
  profileStatus: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  profileStatusText: {
    fontSize: Typography.xs,
    color: Colors.emerald,
    fontWeight: Typography.medium,
  },
  section: {
    marginBottom: Spacing.lg,
    paddingHorizontal: Spacing.xl,
  },
  sectionTitle: {
    fontSize: Typography.xs,
    fontWeight: Typography.bold,
    color: Colors.textTertiary,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    marginBottom: Spacing.sm,
  },
  sectionContent: {
    backgroundColor: '#091220',
    borderRadius: BorderRadius.xl,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.08)',
    overflow: 'hidden',
  },
  settingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: Spacing.base,
    gap: Spacing.md,
  },
  settingIcon: {
    width: 36,
    height: 36,
    borderRadius: 18,
    justifyContent: 'center',
    alignItems: 'center',
  },
  settingContent: {
    flex: 1,
  },
  settingLabel: {
    fontSize: Typography.base,
    color: Colors.textPrimary,
  },
  settingLabelDanger: {
    color: Colors.error,
  },
  settingValue: {
    fontSize: Typography.xs,
    color: Colors.textSecondary,
    marginTop: 2,
  },
  settingSeparator: {
    height: 1,
    backgroundColor: Colors.border,
    marginLeft: 56,
  },
  logoutBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.sm,
    paddingVertical: Spacing.md,
    backgroundColor: Colors.surface,
    borderRadius: BorderRadius.lg,
    borderWidth: 1,
    borderColor: `${Colors.error}40`,
    marginTop: Spacing.sm,
    marginBottom: Spacing['3xl'],
  },
  logoutText: {
    fontSize: Typography.base,
    fontWeight: Typography.semibold,
    color: Colors.error,
  },
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.65)',
    justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: Colors.surface,
    borderTopLeftRadius: BorderRadius.xl,
    borderTopRightRadius: BorderRadius.xl,
    padding: Spacing.base,
    paddingBottom: Spacing['3xl'],
    gap: Spacing.md,
  },
  sheetHandle: {
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: Colors.border,
    alignSelf: 'center',
  },
  sheetTitle: {
    fontSize: Typography.lg,
    fontWeight: Typography.bold,
    color: Colors.textPrimary,
    textAlign: 'center',
  },
  sheetDescription: {
    fontSize: Typography.sm,
    color: Colors.textSecondary,
    textAlign: 'center',
    lineHeight: 20,
  },
  keyBlock: {
    backgroundColor: Colors.background,
    padding: Spacing.md,
    borderRadius: BorderRadius.md,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  keyLabel: {
    fontSize: Typography.xs,
    color: Colors.textSecondary,
    marginBottom: 4,
    fontWeight: Typography.medium,
  },
  keyValue: {
    fontSize: Typography.xs,
    color: Colors.accent,
    fontFamily: 'monospace',
  },
  noticeBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    backgroundColor: `${Colors.accent}15`,
    padding: Spacing.md,
    borderRadius: BorderRadius.md,
  },
  noticeText: {
    flex: 1,
    fontSize: Typography.xs,
    color: Colors.textPrimary,
    lineHeight: 16,
  },
  closeBtn: {
    paddingVertical: Spacing.md,
    alignItems: 'center',
    borderRadius: BorderRadius.lg,
    backgroundColor: Colors.surfaceElevated,
    marginTop: Spacing.sm,
  },
  closeBtnText: {
    color: Colors.textPrimary,
    fontWeight: Typography.semibold,
    fontSize: Typography.base,
  },
  deviceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    padding: Spacing.md,
    backgroundColor: Colors.background,
    borderRadius: BorderRadius.lg,
  },
  deviceIcon: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: `${Colors.accent}20`,
    justifyContent: 'center',
    alignItems: 'center',
  },
  deviceInfo: {
    flex: 1,
  },
  deviceName: {
    fontSize: Typography.base,
    fontWeight: Typography.semibold,
    color: Colors.textPrimary,
  },
  deviceIdText: {
    fontSize: Typography.xs,
    color: Colors.textTertiary,
    fontFamily: 'monospace',
  },
  activeTag: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginTop: 4,
  },
  activeDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: Colors.online,
  },
  activeTagText: {
    fontSize: 10,
    color: Colors.online,
    fontWeight: Typography.medium,
  },
  backupStatsCard: {
    backgroundColor: Colors.background,
    padding: Spacing.md,
    borderRadius: BorderRadius.lg,
    gap: Spacing.xs,
  },
  backupStatRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  backupStatLabel: {
    fontSize: Typography.xs,
    color: Colors.textSecondary,
  },
  backupStatVal: {
    fontSize: Typography.xs,
    color: Colors.textPrimary,
    fontWeight: Typography.medium,
  },
  primaryActionBtn: {
    backgroundColor: Colors.accent,
    paddingVertical: Spacing.md,
    borderRadius: BorderRadius.lg,
    alignItems: 'center',
    marginTop: Spacing.xs,
  },
  primaryActionText: {
    color: Colors.white,
    fontWeight: Typography.bold,
    fontSize: Typography.base,
  },
  auditItem: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: Spacing.md,
    paddingVertical: Spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
  },
  auditTitle: {
    fontSize: Typography.sm,
    fontWeight: Typography.semibold,
    color: Colors.textPrimary,
  },
  auditDesc: {
    fontSize: Typography.xs,
    color: Colors.textSecondary,
    marginTop: 2,
    lineHeight: 16,
  },
});
