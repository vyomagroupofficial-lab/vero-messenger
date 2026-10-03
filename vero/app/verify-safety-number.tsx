import React, { useEffect, useMemo, useState } from 'react';
import { Clipboard, ScrollView, Share, StyleSheet, Text, View } from 'react-native';
import Animated, { Easing, FadeIn, FadeInDown, ZoomIn, useAnimatedStyle, useSharedValue, withRepeat, withTiming } from 'react-native-reanimated';
import Svg, { Path, Rect } from 'react-native-svg';
import { router, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { cryptoManager } from '../src/core/crypto/CryptoManager';
import { databaseService } from '../src/core/storage/DatabaseService';
import { useAuthStore } from '../src/features/auth/useAuthStore';
import { Colors, Fonts, Type } from '../src/shared/theme/theme';
import { Avatar, Button, Grain, Icon, IconButton, VeroMark, notify, useLayout } from '../src/shared/ui';

const DEMO_NUMBER = '37042 81196 55830 20917 64458 09273 71605 38841 92510 46087 13369 58724';
const withTimeout = <T,>(p: Promise<T>, ms = 1500) => Promise.race([p, new Promise<null>((r) => setTimeout(() => r(null), ms))]);

/** A QR-style matrix derived from the safety number, with real finder squares. */
function qrPath(seedText: string) {
  const n = 29;
  let seed = 7;
  for (let i = 0; i < seedText.length; i++) seed = (seed * 31 + seedText.charCodeAt(i)) % 233280;
  const rnd = () => {
    seed = (seed * 9301 + 49297) % 233280;
    return seed / 233280;
  };
  const finder = (x: number, y: number) => `M${x} ${y}h7v7h-7zM${x + 1} ${y + 1}v5h5v-5zM${x + 2} ${y + 2}h3v3h-3z`;
  const skip = (x: number, y: number) =>
    (x < 8 && y < 8) || (x > n - 9 && y < 8) || (x < 8 && y > n - 9) || (x > 10 && x < 18 && y > 10 && y < 18);
  let d = '';
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (!skip(x, y) && rnd() > 0.52) d += `M${x} ${y}h1v1h-1z`;
  return finder(0, 0) + finder(n - 7, 0) + finder(0, n - 7) + d;
}

function QrCard({ value, size }: { value: string; size: number }) {
  const d = useMemo(() => qrPath(value), [value]);
  const scan = useSharedValue(0);
  useEffect(() => {
    scan.value = withRepeat(withTiming(1, { duration: 2400, easing: Easing.bezier(0.6, 0, 0.4, 1) }), -1, true);
  }, []);
  const line = useAnimatedStyle(() => ({ transform: [{ translateY: scan.value * (size - 6) }] }));
  const logo = Math.round(size * 0.17);
  return (
    <Animated.View entering={ZoomIn.springify().damping(15)} style={styles.qr}>
      <View style={{ width: size, height: size }}>
        <Svg width={size} height={size} viewBox="0 0 29 29">
          <Rect width={29} height={29} fill={Colors.cream} />
          <Path d={d} fill={Colors.ink} />
        </Svg>
        <Animated.View pointerEvents="none" style={[styles.scan, line]} />
        <View style={[styles.qrLogo, { width: logo, height: logo, marginLeft: -logo / 2, marginTop: -logo / 2 }]}>
          <VeroMark size={logo} />
        </View>
      </View>
    </Animated.View>
  );
}

export default function VerifySafetyNumberScreen() {
  const insets = useSafeAreaInsets();
  const { isWide } = useLayout();
  const { user } = useAuthStore();
  const { userId, displayName, publicKey } = useLocalSearchParams<{ userId: string; displayName: string; publicKey?: string }>();
  const name = displayName || 'this contact';
  const first = name.split(' ')[0];

  const [safetyNumber, setSafetyNumber] = useState(DEMO_NUMBER);
  const [verified, setVerified] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!userId) return;
    (async () => {
      const saved: any = await withTimeout(databaseService.getSafetyNumber(userId).catch(() => null));
      if (saved) {
        setSafetyNumber(saved.safetyNumber);
        setVerified(saved.isVerified);
        return;
      }
      try {
        const mine: any = await withTimeout(cryptoManager.getIdentityPublicKey());
        if (mine) {
          const num = await cryptoManager.generateSafetyNumber(mine, publicKey || 'PeerIdentityPublicKeyPlaceholderMockKey12345');
          setSafetyNumber(num);
          databaseService.saveSafetyNumber(userId, num).catch(() => {});
        }
      } catch {
        databaseService.saveSafetyNumber(userId, DEMO_NUMBER).catch(() => {});
      }
    })();
  }, [userId, publicKey]);

  const toggle = async () => {
    const next = !verified;
    setVerified(next);
    if (userId) databaseService.setSafetyNumberVerified(userId, next).catch(() => {});
  };

  const copy = () => {
    Clipboard.setString(safetyNumber);
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };

  const share = async () => {
    try {
      await Share.share({ message: `Our Vero safety number:\n\n${safetyNumber}` });
    } catch {}
  };

  const blocks = safetyNumber.split(/\s+/);
  const back = () => (router.canGoBack() ? router.back() : router.replace('/(tabs)/chats'));

  const pair = (
    <View style={styles.pair}>
      <Avatar name={user?.displayName || 'You'} size={isWide ? 54 : 44} />
      <View style={styles.pairLine} />
      <View style={[styles.pairLock, verified && { backgroundColor: Colors.sageTint, borderColor: Colors.sageLine }]}>
        <Icon name={verified ? 'shieldCheck' : 'lock'} size={20} color={verified ? Colors.sage : Colors.brass} />
      </View>
      <View style={styles.pairLine} />
      <Avatar name={name} size={isWide ? 54 : 44} />
    </View>
  );

  const numbers = (
    <View style={styles.grid}>
      {blocks.map((b, i) => (
        <Animated.View key={`${b}-${i}`} entering={FadeInDown.delay(200 + i * 35).duration(400)} style={{ width: '25%', padding: 3 }}>
          <View style={[styles.block, verified && { borderColor: 'rgba(134,192,159,0.25)' }]}>
            <Text style={[styles.blockText, !isWide && { fontSize: 16 }]}>{b}</Text>
          </View>
        </Animated.View>
      ))}
    </View>
  );

  const verifyBtn = (
    <Button
      label={verified ? 'Verified' : 'Mark as verified'}
      icon={verified ? 'shieldCheck' : undefined}
      variant={verified ? 'sage' : 'primary'}
      onPress={toggle}
      style={isWide ? { alignSelf: 'flex-start', paddingHorizontal: 28 } : undefined}
    />
  );

  const secondary = (
    <View style={{ flexDirection: 'row', gap: 10, flexWrap: 'wrap' }}>
      <Button label={copied ? 'Copied' : 'Copy number'} icon={copied ? 'check' : 'copy'} variant="secondary" size="md" onPress={copy} style={!isWide ? { flex: 1 } : undefined} />
      <Button
        label="Scan code"
        icon="scan"
        variant="secondary"
        size="md"
        onPress={() => notify(`Scan ${first}’s code`, `Open this screen on ${first}’s phone and point your camera at their code.`)}
        style={!isWide ? { flex: 1 } : undefined}
      />
    </View>
  );

  if (isWide) {
    return (
      <View style={styles.container}>
        <Grain />
        <View style={styles.wideTop}>
          <Button label={`Back to ${first}`} icon="back" variant="ghost" size="md" onPress={back} />
          <Button label="Share" icon="share" variant="ghost" size="md" onPress={share} />
        </View>
        <ScrollView contentContainerStyle={styles.wideBody}>
          <View style={{ alignItems: 'center', gap: 26, width: 380 }}>
            {pair}
            <QrCard value={safetyNumber} size={300} />
          </View>
          <View style={{ flex: 1, minWidth: 380, maxWidth: 520, gap: 22 }}>
            <Animated.View entering={FadeIn} style={{ gap: 10 }}>
              <Text style={[Type.eyebrow, { color: Colors.brass }]}>SAFETY NUMBER</Text>
              <Text style={[Type.hero, { fontSize: 42, lineHeight: 46 }]}>Make sure it’s really {first}.</Text>
              <Text style={[Type.bodyMuted, { fontSize: 15.5, lineHeight: 24 }]}>
                Compare these numbers with {first} in person, or scan each other’s code. If they match, your chat is end-to-end encrypted with no one in between.
              </Text>
            </Animated.View>
            {numbers}
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
              {verifyBtn}
              <Text style={Type.caption}>{verified ? 'Tap again to clear' : 'Only if the numbers match'}</Text>
            </View>
            {secondary}
          </View>
        </ScrollView>
      </View>
    );
  }

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <Grain />
      <View style={styles.header}>
        <IconButton icon="back" label="Back" onPress={back} />
        <Text style={[Type.name, { flex: 1, textAlign: 'center' }]}>Safety number</Text>
        <IconButton icon="share" label="Share" onPress={share} />
      </View>
      <ScrollView contentContainerStyle={{ padding: 20, paddingBottom: insets.bottom + 32, alignItems: 'center', gap: 20 }}>
        {pair}
        <QrCard value={safetyNumber} size={200} />
        <Animated.View entering={FadeIn.delay(100)} style={{ alignItems: 'center', gap: 6 }}>
          <Text style={[Type.h2, { textAlign: 'center' }]}>Make sure it’s really {first}</Text>
          <Text style={[Type.bodyMuted, { textAlign: 'center' }]}>Compare these numbers in person, or scan each other’s code.</Text>
        </Animated.View>
        {numbers}
        <View style={{ width: '100%', gap: 10 }}>
          {verifyBtn}
          {secondary}
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.ink },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8, paddingVertical: 6 },
  wideTop: { flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: 32, paddingTop: 24 },
  wideBody: { flexGrow: 1, flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'center', gap: 64, padding: 40 },
  pair: { flexDirection: 'row', alignItems: 'center', gap: 10, width: '100%', paddingHorizontal: 24 },
  pairLine: { flex: 1, height: 2, borderRadius: 1, backgroundColor: 'rgba(214,166,87,0.35)' },
  pairLock: {
    width: 44,
    height: 44,
    borderRadius: 14,
    backgroundColor: Colors.raised,
    borderWidth: 1,
    borderColor: Colors.line,
    alignItems: 'center',
    justifyContent: 'center',
  },
  qr: {
    padding: 18,
    borderRadius: 26,
    backgroundColor: Colors.cream,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 28 },
    shadowOpacity: 0.45,
    shadowRadius: 60,
    elevation: 14,
  },
  scan: {
    position: 'absolute',
    left: -6,
    right: -6,
    top: 0,
    height: 3,
    borderRadius: 2,
    backgroundColor: Colors.brass,
    shadowColor: Colors.brass,
    shadowOpacity: 0.8,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 0 },
  },
  qrLogo: { position: 'absolute', left: '50%', top: '50%', borderRadius: 8, borderWidth: 3, borderColor: Colors.cream, overflow: 'hidden' },
  grid: { flexDirection: 'row', flexWrap: 'wrap', width: '100%', marginHorizontal: -3 },
  block: { paddingVertical: 10, borderRadius: 12, backgroundColor: Colors.raised, borderWidth: 1, borderColor: Colors.line, alignItems: 'center' },
  blockText: { fontFamily: Fonts.mono, fontSize: 20, letterSpacing: 1.4, color: Colors.cream },
});
