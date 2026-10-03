import React, { useEffect } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Animated, {
  Easing,
  FadeInDown,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withRepeat,
  withTiming,
  ZoomIn,
} from 'react-native-reanimated';
import { Colors, Fonts } from '../src/shared/theme/theme';
import { Grain, Icon, Ripple, VeroMark, Wordmark, useLayout } from '../src/shared/ui';

function LoadingBar({ width }: { width: number }) {
  const x = useSharedValue(0);
  useEffect(() => {
    x.value = withDelay(1300, withRepeat(withTiming(1, { duration: 1500, easing: Easing.bezier(0.6, 0, 0.3, 1) }), -1, false));
  }, []);
  const a = useAnimatedStyle(() => ({ transform: [{ translateX: -width * 0.45 + x.value * width * 1.45 }] }));
  return (
    <Animated.View entering={FadeInDown.delay(1200).duration(500)} style={[styles.track, { width }]} accessibilityRole="progressbar" accessibilityLabel="Loading">
      <Animated.View style={[styles.bar, { width: width * 0.4 }, a]} />
    </Animated.View>
  );
}

export default function SplashScreen() {
  const { isWide } = useLayout();
  const mark = isWide ? 112 : 88;

  return (
    <View style={styles.container}>
      <Grain opacity={0.08} />
      <View style={styles.center}>
        <Animated.View entering={ZoomIn.springify().damping(12).stiffness(140)}>
          <Ripple size={mark} color="rgba(214,166,87,0.22)" duration={4000}>
            <VeroMark size={mark} animate />
          </Ripple>
        </Animated.View>
        <Animated.View entering={FadeInDown.delay(850).duration(700)} style={{ alignItems: 'center', gap: 8, marginTop: 10 }}>
          <Wordmark size={isWide ? 72 : 54} />
          <Text style={styles.tag}>{isWide ? 'Private by default. Personal by design.' : 'Private by default.'}</Text>
        </Animated.View>
        <LoadingBar width={isWide ? 180 : 120} />
      </View>
      <Animated.View entering={FadeInDown.delay(1500).duration(600)} style={styles.footer}>
        <Icon name="lock" size={14} color={Colors.sage} />
        <Text style={styles.footerText}>End-to-end encrypted</Text>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.ink },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 26, paddingBottom: 40 },
  tag: { fontFamily: Fonts.body, fontSize: 16, color: Colors.muted },
  track: { height: 3, borderRadius: 2, backgroundColor: 'rgba(237,231,217,0.1)', overflow: 'hidden' },
  bar: { height: 3, borderRadius: 2, backgroundColor: Colors.brass },
  footer: { position: 'absolute', bottom: 44, left: 0, right: 0, flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 8 },
  footerText: { fontFamily: Fonts.body, fontSize: 13, color: Colors.faint },
});
