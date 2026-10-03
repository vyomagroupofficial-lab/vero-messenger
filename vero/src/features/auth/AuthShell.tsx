import React, { useEffect } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, View } from 'react-native';
import Animated, {
  FadeInDown,
  SlideInDown,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSequence,
  withTiming,
  Easing,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Colors, Fonts, Type } from '../../shared/theme/theme';
import { Grain, Hatch, Icon, IconName, VeroMark, Wordmark, useLayout } from '../../shared/ui';

/** Gentle drifting chat bubbles on the brand panel. */
function Floaters() {
  const y = useSharedValue(0);
  useEffect(() => {
    y.value = withRepeat(withSequence(withTiming(1, { duration: 3000, easing: Easing.inOut(Easing.sin) }), withTiming(0, { duration: 3000, easing: Easing.inOut(Easing.sin) })), -1);
  }, []);
  const a = useAnimatedStyle(() => ({ transform: [{ translateY: -10 * y.value }, { rotate: `${-4 + 2 * y.value}deg` }] }));
  return (
    <Animated.View pointerEvents="none" style={[styles.floaters, a]}>
      <View style={[styles.floatBubble, { backgroundColor: Colors.ink, alignSelf: 'flex-start', borderBottomLeftRadius: 6 }]}>
        <Text style={[Type.body, { fontSize: 14 }]}>See you at 7?</Text>
      </View>
      <View style={[styles.floatBubble, { backgroundColor: Colors.brass, alignSelf: 'flex-end', borderBottomRightRadius: 6 }]}>
        <Text style={[Type.body, { fontSize: 14, color: Colors.brassInk, fontFamily: Fonts.medium }]}>Rooftop. Bring the camera</Text>
      </View>
    </Animated.View>
  );
}

export function Point({ icon, title, body, index }: { icon: IconName; title: string; body: string; index: number }) {
  return (
    <Animated.View entering={FadeInDown.delay(150 + index * 100).duration(600)} style={styles.point}>
      <View style={styles.pointIcon}>
        <Icon name={icon} size={20} color={Colors.brassLight} />
      </View>
      <View style={{ flex: 1, gap: 3 }}>
        <Text style={[Type.name, { fontSize: 16 }]}>{title}</Text>
        <Text style={[Type.body, { fontSize: 14, color: 'rgba(237,231,217,0.72)' }]}>{body}</Text>
      </View>
    </Animated.View>
  );
}

export function AuthShell({
  headline,
  mobileHeadline,
  panel,
  panelTone = 'pine',
  children,
  topBar,
}: {
  headline: string;
  mobileHeadline?: string;
  panel: React.ReactNode;
  panelTone?: 'pine' | 'ink';
  children: React.ReactNode;
  topBar?: React.ReactNode;
}) {
  const { isWide } = useLayout();
  const insets = useSafeAreaInsets();
  const panelBg = panelTone === 'pine' ? Colors.pine : Colors.panel;
  const hatch = panelTone === 'pine' ? 'rgba(237,231,217,0.035)' : 'rgba(214,166,87,0.04)';

  if (isWide) {
    return (
      <View style={styles.wide}>
        <View style={[styles.brandPanel, { backgroundColor: panelBg }, panelTone === 'ink' && { borderRightWidth: 1, borderRightColor: Colors.line }]}>
          <Hatch color={hatch} />
          <Grain opacity={0.08} />
          <View style={styles.brandRow}>
            <VeroMark size={40} />
            <Wordmark size={28} />
          </View>
          <View style={{ gap: 32, maxWidth: 520 }}>
            <Animated.Text entering={FadeInDown.duration(700)} style={styles.headline}>
              {headline}
            </Animated.Text>
            {panel}
          </View>
          {panelTone === 'pine' && <Floaters />}
          <Text style={styles.legal}>© Vero · Privacy · Terms</Text>
        </View>
        <KeyboardAvoidingView style={styles.formSide} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <Grain />
          <ScrollView contentContainerStyle={styles.formScroll} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
            <View style={{ width: '100%', maxWidth: 420 }}>{children}</View>
          </ScrollView>
        </KeyboardAvoidingView>
      </View>
    );
  }

  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: Colors.ink }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView contentContainerStyle={{ flexGrow: 1 }} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false} bounces={false}>
        <View style={[styles.mobileTop, { backgroundColor: panelBg, paddingTop: insets.top + 24 }]}>
          <Hatch color={hatch} />
          <Grain opacity={0.08} />
          {topBar}
          <View style={styles.brandRow}>
            <VeroMark size={34} />
            <Wordmark size={24} />
          </View>
          <Animated.Text entering={FadeInDown.duration(700)} style={[styles.headline, { fontSize: 36, lineHeight: 38 }]}>
            {mobileHeadline ?? headline}
          </Animated.Text>
        </View>
        <Animated.View entering={SlideInDown.springify().damping(20)} style={[styles.sheet, { paddingBottom: insets.bottom + 28 }]}>
          {children}
        </Animated.View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  wide: { flex: 1, flexDirection: 'row', backgroundColor: Colors.ink },
  brandPanel: { flex: 1, padding: 56, paddingTop: 48, justifyContent: 'space-between', overflow: 'hidden' },
  brandRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  headline: { fontFamily: Fonts.display, fontSize: 58, lineHeight: 60, letterSpacing: -1.8, color: Colors.cream },
  legal: { fontFamily: Fonts.body, fontSize: 13, color: 'rgba(237,231,217,0.6)' },
  formSide: { flex: 1 },
  formScroll: { flexGrow: 1, alignItems: 'center', justifyContent: 'center', padding: 48 },
  floaters: { position: 'absolute', right: 32, bottom: 110, gap: 10, width: 230 },
  floatBubble: { paddingVertical: 10, paddingHorizontal: 14, borderRadius: 18 },
  point: { flexDirection: 'row', gap: 14, alignItems: 'flex-start' },
  pointIcon: {
    width: 42,
    height: 42,
    borderRadius: 13,
    backgroundColor: 'rgba(12,14,13,0.35)',
    borderWidth: 1,
    borderColor: 'rgba(237,231,217,0.12)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  mobileTop: { minHeight: 300, paddingHorizontal: 24, paddingBottom: 60, justifyContent: 'space-between', gap: 28, overflow: 'hidden' },
  sheet: { flex: 1, marginTop: -30, borderTopLeftRadius: 30, borderTopRightRadius: 30, backgroundColor: Colors.ink, paddingHorizontal: 24, paddingTop: 28 },
});
