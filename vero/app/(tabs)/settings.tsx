import React, { useEffect, useRef, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import Animated, { FadeIn, FadeInDown, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAuthStore } from '../../src/features/auth/useAuthStore';
import { cryptoManager, DeviceKeys } from '../../src/core/crypto/CryptoManager';
import { mediaRepository } from '../../src/features/media/MediaRepository';
import { Colors, Fonts, Type } from '../../src/shared/theme/theme';
import {
  Avatar,
  Button,
  Grain,
  Hatch,
  Icon,
  IconButton,
  IconName,
  Pressy,
  Rise,
  Sheet,
  Toggle,
  confirmAction,
  notify,
  useLayout,
} from '../../src/shared/ui';

type Section = 'Privacy' | 'Security & keys' | 'Linked devices' | 'Backup & storage';
const SECTIONS: { key: Section; icon: IconName }[] = [
  { key: 'Privacy', icon: 'eye' },
  { key: 'Security & keys', icon: 'shieldCheck' },
  { key: 'Linked devices', icon: 'devices' },
  { key: 'Backup & storage', icon: 'cloud' },
];
const TIMERS = ['Off', '24 hours', '7 days', '90 days'];

const GUARANTEES = [
  { title: 'Nothing readable on our servers', desc: 'Messages are stored only as encrypted envelopes.' },
  { title: 'Photos and files encrypted first', desc: 'Every attachment is locked on your device before upload.' },
  { title: 'Keys stay on this device', desc: 'Private keys live in the device’s secure storage and never leave it.' },
  { title: 'Your data is walled off', desc: 'Database rules stop anyone else from reading your records.' },
  { title: 'Calls go device to device', desc: 'Audio and video stream directly between people on the call.' },
];

function Row({ icon, iconBg = Colors.raised, label, hint, right, onPress, first, tone }: {
  icon?: IconName;
  iconBg?: string;
  label: string;
  hint?: string;
  right?: React.ReactNode;
  onPress?: () => void;
  first?: boolean;
  tone?: 'ember';
}) {
  const body = (
    <View style={[styles.row, !first && styles.rowBorder]}>
      {icon && (
        <View style={[styles.rowIcon, { backgroundColor: tone === 'ember' ? Colors.emberTint : iconBg }]}>
          <Icon name={icon} size={18} color={tone === 'ember' ? Colors.ember : iconBg === Colors.raised ? Colors.brass : Colors.cream} />
        </View>
      )}
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={[styles.rowLabel, tone === 'ember' && { color: Colors.ember }]}>{label}</Text>
        {hint ? <Text style={Type.caption}>{hint}</Text> : null}
      </View>
      {right ?? (onPress ? <Icon name="forwardChevron" size={18} color={Colors.faint} /> : null)}
    </View>
  );
  return onPress ? (
    <Pressy onPress={onPress} scaleTo={0.985} accessibilityLabel={label}>
      {body}
    </Pressy>
  ) : (
    body
  );
}

function Card({ title, children, index = 0 }: { title?: string; children: React.ReactNode; index?: number }) {
  return (
    <Rise index={index} style={{ gap: 8 }}>
      {title ? <Text style={[Type.eyebrow, { paddingHorizontal: 4 }]}>{title.toUpperCase()}</Text> : null}
      <View style={styles.card}>{children}</View>
    </Rise>
  );
}

function Progress({ pct }: { pct: number }) {
  const w = useSharedValue(0);
  useEffect(() => {
    w.value = withTiming(pct, { duration: 240 });
  }, [pct]);
  const a = useAnimatedStyle(() => ({ width: `${w.value}%` }));
  return (
    <View style={styles.track}>
      <Animated.View style={[styles.fill, a]} />
    </View>
  );
}

export default function SettingsScreen() {
  const insets = useSafeAreaInsets();
  const { isWide } = useLayout();
  const { user, deviceId, logout } = useAuthStore();

  const [onlineStatus, setOnlineStatus] = useState(true);
  const [readReceipts, setReadReceipts] = useState(true);
  const [typingIndicators, setTypingIndicators] = useState(true);
  const [notifications, setNotifications] = useState(true);
  const [appLock, setAppLock] = useState(false);
  const [timer, setTimer] = useState('Off');

  const [section, setSection] = useState<Section>('Privacy');
  const [showKeys, setShowKeys] = useState(false);
  const [showAudit, setShowAudit] = useState(false);
  const [deviceKeys, setDeviceKeys] = useState<DeviceKeys | null>(null);

  const [backingUp, setBackingUp] = useState(false);
  const [pct, setPct] = useState(0);
  const [lastBackup, setLastBackup] = useState('Never');
  const tick = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    cryptoManager.getDeviceKeys().then(setDeviceKeys).catch(() => {});
    return () => {
      if (tick.current) clearInterval(tick.current);
    };
  }, []);

  const name = user?.displayName || 'Your name';

  const startBackup = () => {
    if (backingUp) return;
    setBackingUp(true);
    setPct(0);
    tick.current = setInterval(() => {
      setPct((p) => {
        const next = Math.min(100, p + 7);
        if (next >= 100 && tick.current) {
          clearInterval(tick.current);
          setTimeout(() => {
            setBackingUp(false);
            setLastBackup('Just now');
          }, 300);
        }
        return next;
      });
    }, 160);
  };

  const handleLogout = () =>
    confirmAction({
      title: 'Log out of Vero?',
      message: 'Your private keys will be removed from this device. Your chats stay safe on your other devices.',
      confirmLabel: 'Log out',
      destructive: true,
      onConfirm: async () => {
        await logout();
        router.replace('/(auth)/login');
      },
    });

  const clearCache = () =>
    confirmAction({
      title: 'Clear media cache?',
      message: 'Removes decrypted photos and files saved on this device. Your chats aren’t affected.',
      confirmLabel: 'Clear',
      destructive: true,
      onConfirm: async () => {
        await mediaRepository.clearMediaCache().catch(() => {});
        notify('Media cache cleared');
      },
    });

  // ── Section bodies ──

  const privacy = (
    <>
      <Card title="Visibility" index={0}>
        <Row first label="Online status" hint="Show when you’re online" right={<Toggle label="Online status" value={onlineStatus} onValueChange={setOnlineStatus} />} />
        <Row label="Read receipts" hint="Let people know when you’ve read their messages" right={<Toggle label="Read receipts" value={readReceipts} onValueChange={setReadReceipts} />} />
        <Row label="Typing indicators" hint="Show when you’re typing" right={<Toggle label="Typing indicators" value={typingIndicators} onValueChange={setTypingIndicators} />} />
        <Row label="Notifications" hint="Message previews stay hidden until you unlock" right={<Toggle label="Notifications" value={notifications} onValueChange={setNotifications} />} />
      </Card>
      <Card title="Disappearing messages" index={1}>
        <View style={{ paddingVertical: 16, gap: 12 }}>
          <Text style={Type.bodyMuted}>Default timer for new chats you start</Text>
          <View style={styles.segment}>
            {TIMERS.map((t) => (
              <Pressy
                key={t}
                onPress={() => setTimer(t)}
                scaleTo={0.95}
                accessibilityState={{ selected: timer === t }}
                accessibilityLabel={`Timer ${t}`}
                style={[styles.segBtn, timer === t && styles.segOn]}
              >
                <Text style={[styles.segText, timer === t && { color: Colors.ink }]}>{t}</Text>
              </Pressy>
            ))}
          </View>
        </View>
      </Card>
    </>
  );

  const security = (
    <>
      <Card title="Lock" index={0}>
        <Row
          first
          icon="lock"
          label="App lock"
          hint="Require Face ID, fingerprint or PIN to open Vero"
          right={<Toggle label="App lock" value={appLock} onValueChange={setAppLock} />}
        />
      </Card>
      <Card title="Encryption" index={1}>
        <Row first icon="key" label="Your encryption keys" hint="Public keys for this device" onPress={() => setShowKeys(true)} />
        <Row icon="shieldCheck" label="How Vero keeps you private" hint="Our five guarantees" onPress={() => setShowAudit(true)} />
      </Card>
    </>
  );

  const devices = (
    <Card title="Linked devices" index={0}>
      <View style={[styles.row, { paddingVertical: 14 }]}>
        <View style={[styles.rowIcon, { width: 44, height: 44 }]}>
          <Icon name={isWide ? 'laptop' : 'smartphone'} size={21} color={Colors.cream} />
        </View>
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={styles.rowLabel}>This device · primary</Text>
          <Text style={[Type.caption, { color: Colors.sage }]}>Active now</Text>
          <Text style={[Type.caption, { fontFamily: Fonts.mono, fontSize: 11 }]}>ID {deviceId?.slice(0, 16) || '—'}</Text>
        </View>
      </View>
      <View style={[styles.rowBorder, { paddingVertical: 14, gap: 12 }]}>
        <Text style={Type.bodyMuted}>Each device has its own keys. Messages sync between the devices you link.</Text>
        <Button
          label="Link a new device"
          icon="qr"
          variant="secondary"
          size="md"
          style={{ alignSelf: 'flex-start' }}
          onPress={() => notify('Link a device', 'Open Vero on your other device and scan the QR code shown there.')}
        />
      </View>
    </Card>
  );

  const backup = (
    <>
      <Card title="Encrypted backup" index={0}>
        <View style={{ paddingVertical: 16, gap: 14 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}>
            <View style={[styles.rowIcon, { width: 48, height: 48, backgroundColor: Colors.pine }]}>
              <Icon name="cloudUp" size={22} color={Colors.cream} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.rowLabel}>Google Drive</Text>
              <Animated.Text key={String(backingUp)} entering={FadeIn} style={Type.caption}>
                {backingUp ? `Encrypting and uploading… ${pct}%` : `Last backup: ${lastBackup}`}
              </Animated.Text>
            </View>
            {!isWide ? null : <Button label={backingUp ? 'Backing up' : 'Back up now'} size="md" loading={backingUp} onPress={startBackup} />}
          </View>
          {backingUp && (
            <Animated.View entering={FadeInDown}>
              <Progress pct={pct} />
            </Animated.View>
          )}
          {!isWide && <Button label={backingUp ? 'Backing up' : 'Back up now'} icon="cloudUp" size="md" loading={backingUp} onPress={startBackup} />}
          <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
            <Icon name="lock" size={14} color={Colors.sage} />
            <Text style={[Type.caption, { flex: 1 }]}>Encrypted on this device before upload — Google can’t read it.</Text>
          </View>
        </View>
      </Card>
      <Card title="Storage" index={1}>
        <Row first icon="trash" label="Clear media cache" hint="Free up space on this device" onPress={clearCache} />
      </Card>
    </>
  );

  const bodies: Record<Section, React.ReactNode> = {
    Privacy: privacy,
    'Security & keys': security,
    'Linked devices': devices,
    'Backup & storage': backup,
  };

  const profileCard = (
    <Rise>
      <View style={styles.profile}>
        <Hatch color="rgba(214,166,87,0.05)" gap={12} />
        <Pressy
          onPress={() => notify('Your profile', `@${user?.username || 'username'}`)}
          scaleTo={0.98}
          style={{ flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 14 }}
          accessibilityLabel="Your profile"
        >
          <Avatar name={name} size={isWide ? 48 : 58} ring />
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={[Type.name, { fontSize: isWide ? 15.5 : 17 }]} numberOfLines={1}>
              {name}
            </Text>
            <Text style={Type.caption} numberOfLines={1}>
              @{user?.username || 'username'}
            </Text>
          </View>
        </Pressy>
        <IconButton icon="qr" label="Your QR code" size={38} variant="filled" color={Colors.brass} onPress={() => notify('Your QR code', 'Let a friend scan this to add you.')} />
      </View>
    </Rise>
  );

  const sheets = (
    <>
      <Sheet visible={showKeys} onClose={() => setShowKeys(false)} title="Your encryption keys">
        {[
          ['Identity key', deviceKeys?.identityPublicKey],
          ['Signing key', deviceKeys?.signingPublicKey],
          ['Registration ID', deviceKeys?.registrationId ? String(deviceKeys.registrationId) : undefined],
        ].map(([label, val]) => (
          <View key={label} style={styles.keyBlock}>
            <Text style={Type.eyebrow}>{String(label).toUpperCase()}</Text>
            <Text selectable style={styles.keyText}>
              {val || 'Generating…'}
            </Text>
          </View>
        ))}
        <View style={styles.sheetNote}>
          <Icon name="lock" size={14} color={Colors.sage} />
          <Text style={[Type.caption, { flex: 1 }]}>Private keys never leave this device. Only these public keys are shared.</Text>
        </View>
        <Button label="Done" variant="ghost" onPress={() => setShowKeys(false)} />
      </Sheet>

      <Sheet visible={showAudit} onClose={() => setShowAudit(false)} title="How Vero keeps you private">
        {GUARANTEES.map((g, i) => (
          <Animated.View key={g.title} entering={FadeInDown.delay(i * 60)} style={styles.guarantee}>
            <View style={styles.check}>
              <Icon name="check" size={14} color={Colors.ink} strokeWidth={2.4} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={[Type.body, { fontFamily: Fonts.semibold }]}>{g.title}</Text>
              <Text style={Type.caption}>{g.desc}</Text>
            </View>
          </Animated.View>
        ))}
        <Button label="Got it" variant="ghost" onPress={() => setShowAudit(false)} />
      </Sheet>
    </>
  );

  if (isWide) {
    return (
      <View style={[styles.container, { flexDirection: 'row' }]}>
        <View style={styles.subnav}>
          <Grain />
          <Text style={[Type.title, { marginLeft: 8, marginBottom: 14 }]}>Settings</Text>
          {profileCard}
          <View style={{ height: 10 }} />
          {SECTIONS.map((s) => (
            <Pressy
              key={s.key}
              onPress={() => setSection(s.key)}
              scaleTo={0.98}
              hoverStyle={section !== s.key ? { backgroundColor: Colors.creamTint } : undefined}
              accessibilityState={{ selected: section === s.key }}
              style={[styles.navItem, section === s.key && styles.navOn]}
            >
              <Icon name={s.icon} size={19} color={section === s.key ? Colors.brass : Colors.faint} />
              <Text style={[styles.navText, section === s.key && { color: Colors.cream }]}>{s.key}</Text>
            </Pressy>
          ))}
          <View style={{ flex: 1 }} />
          <Pressy onPress={handleLogout} style={styles.navItem} hoverStyle={{ backgroundColor: Colors.emberTint }} accessibilityLabel="Log out">
            <Icon name="logout" size={19} color={Colors.ember} />
            <Text style={[styles.navText, { color: Colors.ember }]}>Log out</Text>
          </Pressy>
        </View>
        <ScrollView style={{ flex: 1 }} contentContainerStyle={styles.wideContent}>
          <Grain />
          <Animated.View key={section} entering={FadeIn.duration(260)} style={{ gap: 6, marginBottom: 8 }}>
            <Text style={[Type.title, { fontSize: 32 }]}>{section}</Text>
            <Text style={Type.bodyMuted}>Your messages are always end-to-end encrypted, whatever you choose here.</Text>
          </Animated.View>
          <View key={`${section}-body`} style={{ gap: 22 }}>
            {bodies[section]}
          </View>
        </ScrollView>
        {sheets}
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <Grain />
      <ScrollView contentContainerStyle={{ paddingTop: insets.top + 16, paddingHorizontal: 16, paddingBottom: 48, gap: 22 }} showsVerticalScrollIndicator={false}>
        <Text style={[Type.title, { paddingHorizontal: 4 }]}>Settings</Text>
        {profileCard}
        {privacy}
        {security}
        {devices}
        {backup}
        <Rise index={4}>
          <View style={styles.card}>
            <Row first icon="logout" label="Log out" tone="ember" onPress={handleLogout} />
          </View>
        </Rise>
        <Text style={[Type.caption, { textAlign: 'center' }]}>Vero · end-to-end encrypted</Text>
      </ScrollView>
      {sheets}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.ink },
  card: { backgroundColor: Colors.panel, borderRadius: 22, borderWidth: 1, borderColor: Colors.line, paddingHorizontal: 16 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 14, minHeight: 66, paddingVertical: 10 },
  rowBorder: { borderTopWidth: 1, borderTopColor: Colors.divider },
  rowIcon: { width: 38, height: 38, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: Colors.raised },
  rowLabel: { fontFamily: Fonts.medium, fontSize: 15.5, color: Colors.cream },
  segment: { flexDirection: 'row', gap: 4, padding: 4, borderRadius: 14, backgroundColor: Colors.raised, alignSelf: 'flex-start', flexWrap: 'wrap' },
  segBtn: { height: 36, paddingHorizontal: 14, borderRadius: 10, justifyContent: 'center' },
  segOn: { backgroundColor: Colors.cream },
  segText: { fontFamily: Fonts.medium, fontSize: 13.5, color: Colors.muted },
  track: { height: 6, borderRadius: 3, backgroundColor: Colors.field, overflow: 'hidden' },
  fill: { height: '100%', borderRadius: 3, backgroundColor: Colors.brass },
  profile: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    padding: 14,
    borderRadius: 22,
    backgroundColor: Colors.panel,
    borderWidth: 1,
    borderColor: Colors.line,
    overflow: 'hidden',
  },
  subnav: {
    width: 300,
    paddingHorizontal: 16,
    paddingTop: 24,
    paddingBottom: 20,
    gap: 4,
    backgroundColor: Colors.panel,
    borderRightWidth: 1,
    borderRightColor: Colors.line,
  },
  navItem: { flexDirection: 'row', alignItems: 'center', gap: 12, height: 46, paddingHorizontal: 14, borderRadius: 14 },
  navOn: { backgroundColor: Colors.raised },
  navText: { fontFamily: Fonts.medium, fontSize: 14.5, color: Colors.muted },
  wideContent: { padding: 40, gap: 22, maxWidth: 820, width: '100%', alignSelf: 'center' },
  keyBlock: { gap: 6, padding: 14, borderRadius: 14, backgroundColor: Colors.raised, borderWidth: 1, borderColor: Colors.line },
  keyText: { fontFamily: Fonts.mono, fontSize: 12.5, lineHeight: 18, color: Colors.cream },
  sheetNote: { flexDirection: 'row', gap: 8, alignItems: 'center' },
  guarantee: { flexDirection: 'row', gap: 12, alignItems: 'flex-start' },
  check: { width: 24, height: 24, borderRadius: 12, backgroundColor: Colors.sage, alignItems: 'center', justifyContent: 'center', marginTop: 1 },
});
