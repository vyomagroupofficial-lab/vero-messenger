import React, { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Platform, ScrollView, Share, Text, View } from 'react-native';
import Animated, { FadeIn, FadeInDown, ZoomIn } from 'react-native-reanimated';
import Svg, { Rect } from 'react-native-svg';
import { router, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Clipboard from 'expo-clipboard';
import { cryptoManager } from '../src/core/crypto/CryptoManager';
import { databaseService } from '../src/core/storage/DatabaseService';
import { keyDirectory } from '../src/features/keys/KeyDirectory';
import { useAuthStore } from '../src/features/auth/useAuthStore';
import { friendlyError } from '../src/core/network/supabase';
import { makeStyles, useTheme } from '../src/shared/theme/ThemeProvider';
import { useT } from '../src/shared/i18n';
import { Avatar, Button, Eyebrow, Grain, Icon, IconButton, IconName, notify, useLayout } from '../src/shared/ui';

type VerifyState = 'loading' | 'unverified' | 'verified' | 'changed' | 'unavailable';

/**
 * A mirrored 8×8 pattern drawn straight from the safety number's digits — the same digits always
 * draw the same picture, so two people can compare at a glance before reading all 60 digits.
 */
function Fingerprint({ number, size }: { number: string; size: number }) {
  const { c } = useTheme();
  const s = useStyles();
  const digits = useMemo(() => number.replace(/\D/g, ''), [number]);
  const cells = useMemo(() => {
    const out: { x: number; y: number; tone: 0 | 1 }[] = [];
    for (let y = 0; y < 8; y++)
      for (let x = 0; x < 4; x++) {
        const d = Number(digits[(y * 4 + x) % digits.length] ?? 0);
        const e = Number(digits[(y * 4 + x + 32) % digits.length] ?? 0);
        if (d % 2 === 0) {
          const tone = e > 5 ? 1 : 0;
          out.push({ x, y, tone }, { x: 7 - x, y, tone });
        }
      }
    return out;
  }, [digits]);
  return (
    <Animated.View entering={ZoomIn.springify().damping(15)} style={s.print}>
      <Svg width={size} height={size} viewBox="0 0 8 8">
        {cells.map((cell, i) => (
          <Rect key={i} x={cell.x + 0.08} y={cell.y + 0.08} width={0.84} height={0.84} rx={0.22} fill={cell.tone ? c.success : c.accent} />
        ))}
      </Svg>
    </Animated.View>
  );
}

export default function VerifySafetyNumberScreen() {
  const insets = useSafeAreaInsets();
  const { isWide } = useLayout();
  const { c, type } = useTheme();
  const s = useStyles();
  const t = useT();
  const { userId, displayName } = useLocalSearchParams<{ userId: string; displayName?: string }>();
  const me = useAuthStore((st) => st.user);
  const isDemo = useAuthStore((st) => st.isDemo);
  const name = displayName || t('verify.thisContact');
  const first = name.split(' ')[0];

  const [safetyNumber, setSafetyNumber] = useState<string | null>(null);
  const [state, setState] = useState<VerifyState>('loading');
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      if (!userId || !me) return;
      if (isDemo) {
        setError(t('verify.demoBody'));
        setState('unavailable');
        return;
      }
      try {
        const [myKeys, theirKeys] = await Promise.all([keyDirectory.getUserKeys(me.id), keyDirectory.getUserKeys(userId)]);
        if (!theirKeys.length) throw new Error(t('verify.noDevices', { name }));
        const number = await cryptoManager.computeSafetyNumber({ userId: me.id, keys: myKeys }, { userId, keys: theirKeys });
        const verified = await databaseService.getVerifiedSafetyNumber(userId);
        if (cancelled) return;
        setSafetyNumber(number);
        setState(verified === null ? 'unverified' : verified === number ? 'verified' : 'changed');
      } catch (e) {
        if (cancelled) return;
        setError(friendlyError(e, t('verify.computeFailed')));
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
    notify(t('verify.markedTitle'), t('verify.markedBody', { name }));
  };

  const handleCopy = async () => {
    if (!safetyNumber) return;
    await Clipboard.setStringAsync(safetyNumber);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleShare = async () => {
    if (!safetyNumber) return;
    const message = t('verify.shareText', { number: safetyNumber });
    try {
      if (Platform.OS === 'web' && !(typeof navigator !== 'undefined' && 'share' in navigator)) return handleCopy();
      await Share.share({ message });
    } catch {
      // dismissed
    }
  };

  const back = () => (router.canGoBack() ? router.back() : router.replace('/(tabs)/chats'));
  const blocks = safetyNumber ? safetyNumber.split(/\s+/) : [];
  const tone = isVerified ? c.success : state === 'changed' ? c.danger : c.accentText;
  const statusIcon: IconName = isVerified ? 'shieldCheck' : state === 'changed' ? 'info' : 'shield';
  const statusBody =
    state === 'verified'
      ? t('verify.verifiedBody')
      : state === 'changed'
      ? t('verify.changedBody', { name })
      : state === 'unavailable'
      ? error
      : t('verify.unverifiedBody');

  const pair = (
    <View style={s.pair}>
      <Avatar name={me?.displayName || t('common.you')} size={isWide ? 54 : 44} />
      <View style={[s.pairLine, isVerified && { backgroundColor: c.successLine }]} />
      <View style={[s.pairLock, isVerified && { backgroundColor: c.successTint, borderColor: c.successLine }]}>
        <Icon name={isVerified ? 'shieldCheck' : 'lock'} size={20} color={isVerified ? c.success : c.accentText} />
      </View>
      <View style={[s.pairLine, isVerified && { backgroundColor: c.successLine }]} />
      <Avatar name={name} size={isWide ? 54 : 44} />
    </View>
  );

  const status = (
    <Animated.View key={state} entering={FadeIn} style={[s.status, { borderColor: state === 'changed' ? c.dangerTint : isVerified ? c.successLine : c.line }]}>
      <View style={[s.statusIcon, { backgroundColor: state === 'changed' ? c.dangerTint : isVerified ? c.successTint : c.accentTint }]}>
        {state === 'loading' ? <ActivityIndicator size="small" color={c.accent} /> : <Icon name={statusIcon} size={20} color={tone} />}
      </View>
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={[type.name, { color: state === 'loading' ? c.text : tone }]}>{t(`verify.states.${state}`)}</Text>
        {state !== 'loading' && statusBody ? <Text style={type.caption}>{statusBody}</Text> : null}
      </View>
    </Animated.View>
  );

  const numbers = safetyNumber ? (
    <View style={s.grid} accessibilityLabel={safetyNumber}>
      {blocks.map((b, i) => (
        <Animated.View key={`${b}-${i}`} entering={FadeInDown.delay(120 + i * 35).duration(400)} style={{ width: isWide ? '25%' : '33.333%', padding: 3 }}>
          <View style={[s.block, isVerified && { borderColor: c.successLine }]}>
            <Text style={s.blockText} selectable>
              {b}
            </Text>
          </View>
        </Animated.View>
      ))}
    </View>
  ) : null;

  const controls = safetyNumber ? (
    <View style={{ gap: 12 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
        <Button
          label={isVerified ? t('verify.verifiedBtn') : t('verify.markVerified')}
          icon={isVerified ? 'shieldCheck' : undefined}
          variant={isVerified ? 'sage' : 'primary'}
          onPress={toggleVerified}
          style={isWide ? { alignSelf: 'flex-start', paddingHorizontal: 28 } : { flex: 1 }}
        />
        {isWide && <Text style={type.caption}>{isVerified ? t('verify.clearHint') : t('verify.onlyIfMatch')}</Text>}
      </View>
      <Button label={copied ? t('verify.copied') : t('verify.copy')} icon={copied ? 'check' : 'copy'} variant="secondary" size="md" onPress={handleCopy} style={isWide ? { alignSelf: 'flex-start' } : undefined} />
    </View>
  ) : null;

  const how = (
    <View style={s.how}>
      <Icon name="key" size={16} color={c.accentText} />
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={[type.body, { fontSize: 14 }]}>{t('verify.howTitle')}</Text>
        <Text style={type.caption}>{t('verify.howBody')}</Text>
      </View>
    </View>
  );

  const fingerprint = safetyNumber ? (
    <View style={{ alignItems: 'center', gap: 10 }}>
      <Fingerprint number={safetyNumber} size={isWide ? 220 : 150} />
      <Text style={[type.caption, { textAlign: 'center' }]}>{t('verify.fingerprintHint')}</Text>
    </View>
  ) : null;

  if (isWide) {
    return (
      <View style={s.container}>
        <Grain />
        <View style={s.wideTop}>
          <Button label={t('verify.backTo', { name: first })} icon="back" variant="ghost" size="md" onPress={back} />
          {safetyNumber && <Button label={t('verify.share')} icon="share" variant="ghost" size="md" onPress={handleShare} />}
        </View>
        <ScrollView contentContainerStyle={s.wideBody}>
          <View style={{ alignItems: 'center', gap: 28, width: 380 }}>
            {pair}
            {fingerprint}
          </View>
          <View style={{ flex: 1, minWidth: 380, maxWidth: 540, gap: 22 }}>
            <Animated.View entering={FadeIn} style={{ gap: 10 }}>
              <Eyebrow style={{ color: c.accentText }}>{t('verify.eyebrow')}</Eyebrow>
              <Text style={[type.hero, { fontSize: 42, lineHeight: 50 }]}>{t('verify.headline', { name: first })}</Text>
              <Text style={[type.bodyMuted, { fontSize: 15.5, lineHeight: 24 }]}>{t('verify.lede')}</Text>
            </Animated.View>
            {status}
            {numbers}
            {controls}
            {how}
          </View>
        </ScrollView>
      </View>
    );
  }

  return (
    <View style={[s.container, { paddingTop: insets.top }]}>
      <Grain />
      <View style={s.header}>
        <IconButton icon="back" label={t('common.back')} onPress={back} />
        <Text style={[type.name, { flex: 1, textAlign: 'center' }]} accessibilityRole="header">
          {t('verify.title')}
        </Text>
        <IconButton icon="share" label={t('verify.share')} onPress={handleShare} disabled={!safetyNumber} />
      </View>
      <ScrollView contentContainerStyle={{ padding: 20, paddingBottom: insets.bottom + 32, gap: 20 }}>
        {pair}
        <Animated.View entering={FadeIn.delay(100)} style={{ alignItems: 'center', gap: 6 }}>
          <Text style={[type.h2, { textAlign: 'center' }]}>{t('verify.headline', { name: first })}</Text>
        </Animated.View>
        {status}
        {fingerprint}
        {numbers}
        {controls}
        {how}
      </ScrollView>
    </View>
  );
}

const useStyles = makeStyles((c, t, f) => ({
  container: { flex: 1, backgroundColor: c.bg },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8, paddingVertical: 6 },
  wideTop: { flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: 32, paddingTop: 24 },
  wideBody: { flexGrow: 1, flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'center', gap: 64, padding: 40 },
  pair: { flexDirection: 'row', alignItems: 'center', gap: 10, width: '100%', paddingHorizontal: 24 },
  pairLine: { flex: 1, height: 2, borderRadius: 1, backgroundColor: c.accentLine },
  pairLock: { width: 44, height: 44, borderRadius: 14, backgroundColor: c.raised, borderWidth: 1, borderColor: c.line, alignItems: 'center', justifyContent: 'center' },
  print: { padding: 16, borderRadius: 26, backgroundColor: c.panel, borderWidth: 1, borderColor: c.line },
  status: { flexDirection: 'row', alignItems: 'flex-start', gap: 12, padding: 14, borderRadius: 18, backgroundColor: c.panel, borderWidth: 1 },
  statusIcon: { width: 40, height: 40, borderRadius: 13, alignItems: 'center', justifyContent: 'center' },
  grid: { flexDirection: 'row', flexWrap: 'wrap', marginHorizontal: -3 },
  block: { height: 52, borderRadius: 14, backgroundColor: c.raised, borderWidth: 1, borderColor: c.line, alignItems: 'center', justifyContent: 'center' },
  blockText: { fontFamily: f.monoMedium, fontSize: 18, letterSpacing: 1.5, color: c.text },
  how: { flexDirection: 'row', gap: 12, alignItems: 'flex-start', padding: 14, borderRadius: 18, backgroundColor: c.tint },
}));
