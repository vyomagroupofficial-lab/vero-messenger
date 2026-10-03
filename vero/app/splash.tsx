import React, { useEffect } from 'react';
import { Text, View } from 'react-native';
import Animated, { Easing, FadeInDown, ZoomIn, useAnimatedStyle, useSharedValue, withDelay, withRepeat, withTiming } from 'react-native-reanimated';
import { makeStyles, useTheme } from '../src/shared/theme/ThemeProvider';
import { useT } from '../src/shared/i18n';
import { Grain, Icon, Ripple, VeroMark, Wordmark, useLayout } from '../src/shared/ui';

function LoadingBar({ width }: { width: number }) {
  const s = useStyles();
  const t = useT();
  const x = useSharedValue(0);
  useEffect(() => {
    x.value = withDelay(1300, withRepeat(withTiming(1, { duration: 1500, easing: Easing.bezier(0.6, 0, 0.3, 1) }), -1, false));
  }, []);
  const a = useAnimatedStyle(() => ({ transform: [{ translateX: -width * 0.45 + x.value * width * 1.45 }] }));
  return (
    <Animated.View entering={FadeInDown.delay(1200).duration(500)} style={[s.track, { width }]} accessibilityRole="progressbar" accessibilityLabel={t('brand.loading')}>
      <Animated.View style={[s.bar, { width: width * 0.4 }, a]} />
    </Animated.View>
  );
}

export default function SplashScreen() {
  const { isWide } = useLayout();
  const { c } = useTheme();
  const s = useStyles();
  const t = useT();
  const mark = isWide ? 112 : 88;

  return (
    <View style={s.container}>
      <Grain opacity={0.08} />
      <View style={s.center}>
        <Animated.View entering={ZoomIn.springify().damping(12).stiffness(140)}>
          <Ripple size={mark} color={c.accentLine} duration={4000}>
            <VeroMark size={mark} animate />
          </Ripple>
        </Animated.View>
        <Animated.View entering={FadeInDown.delay(850).duration(700)} style={{ alignItems: 'center', gap: 8, marginTop: 10 }}>
          <Wordmark size={isWide ? 72 : 54} />
          <Text style={s.tag}>{isWide ? t('brand.tagline') : t('brand.taglineShort')}</Text>
        </Animated.View>
        <LoadingBar width={isWide ? 180 : 120} />
      </View>
      <Animated.View entering={FadeInDown.delay(1500).duration(600)} style={s.footer}>
        <Icon name="lock" size={14} color={c.success} />
        <Text style={s.footerText}>{t('common.endToEnd')}</Text>
      </Animated.View>
    </View>
  );
}

const useStyles = makeStyles((c, t, f) => ({
  container: { flex: 1, backgroundColor: c.bg },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 26, paddingBottom: 40, paddingHorizontal: 24 },
  tag: { ...t.body, fontSize: 16, color: c.muted, textAlign: 'center' },
  track: { height: 3, borderRadius: 2, backgroundColor: c.line2, overflow: 'hidden' },
  bar: { height: 3, borderRadius: 2, backgroundColor: c.accent },
  footer: { position: 'absolute', bottom: 44, left: 0, right: 0, flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 8 },
  footerText: { fontFamily: f.body, fontSize: 13, color: c.faint },
}));
