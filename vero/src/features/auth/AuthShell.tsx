import React, { useEffect } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, Text, View } from 'react-native';
import Animated, { Easing, FadeInDown, SlideInDown, useAnimatedStyle, useSharedValue, withRepeat, withSequence, withTiming } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { makeStyles, useTheme } from '../../shared/theme/ThemeProvider';
import { useT } from '../../shared/i18n';
import { Grain, Hatch, Icon, IconName, VeroMark, Wordmark, useLayout } from '../../shared/ui';

/** Gentle drifting chat bubbles on the brand panel. */
function Floaters() {
  const s = useStyles();
  const t = useT();
  const y = useSharedValue(0);
  useEffect(() => {
    y.value = withRepeat(
      withSequence(withTiming(1, { duration: 3000, easing: Easing.inOut(Easing.sin) }), withTiming(0, { duration: 3000, easing: Easing.inOut(Easing.sin) })),
      -1
    );
  }, []);
  const a = useAnimatedStyle(() => ({ transform: [{ translateY: -10 * y.value }, { rotate: `${-4 + 2 * y.value}deg` }] }));
  return (
    <Animated.View pointerEvents="none" style={[s.floaters, a]} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <View style={[s.floatBubble, s.floatA]}>
        <Text style={s.floatAText}>{t('auth.floatA')}</Text>
      </View>
      <View style={[s.floatBubble, s.floatB]}>
        <Text style={s.floatBText}>{t('auth.floatB')}</Text>
      </View>
    </Animated.View>
  );
}

/** A selling point on the pine brand panel (always light text on pine). */
export function Point({ icon, title, body, index }: { icon: IconName; title: string; body: string; index: number }) {
  const { c } = useTheme();
  const s = useStyles();
  return (
    <Animated.View entering={FadeInDown.delay(150 + index * 100).duration(600)} style={s.point}>
      <View style={s.pointIcon}>
        <Icon name={icon} size={20} color={c.accentHover} />
      </View>
      <View style={{ flex: 1, gap: 3 }}>
        <Text style={s.pointTitle}>{title}</Text>
        <Text style={s.pointBody}>{body}</Text>
      </View>
    </Animated.View>
  );
}

/**
 * Sign-in / sign-up frame. Desktop: brand panel left, form right. Mobile: brand header with the form
 * sliding up as a sheet. `tone="pine"` keeps the panel pine in both themes; `tone="surface"` follows the theme.
 */
export function AuthShell({
  headline,
  mobileHeadline,
  panel,
  tone = 'pine',
  children,
  topBar,
}: {
  headline: string;
  mobileHeadline?: string;
  panel: React.ReactNode;
  tone?: 'pine' | 'surface';
  children: React.ReactNode;
  topBar?: React.ReactNode;
}) {
  const { isWide } = useLayout();
  const insets = useSafeAreaInsets();
  const { c } = useTheme();
  const s = useStyles();
  const t = useT();
  const pine = tone === 'pine';
  const panelStyle = pine ? s.panelPine : s.panelSurface;
  const headStyle = pine ? s.headlinePine : s.headlineSurface;

  if (isWide) {
    return (
      <View style={s.wide}>
        <View style={[s.brandPanel, panelStyle]}>
          <Hatch color={pine ? 'rgba(237,231,217,0.035)' : c.hatch} />
          <Grain tone={pine ? 'light' : 'auto'} opacity={0.08} />
          <View style={s.brandRow}>
            <VeroMark size={40} />
            <Wordmark size={28} color={pine ? c.onMine : undefined} />
          </View>
          <View style={{ gap: 32, maxWidth: 520 }}>
            <Animated.Text entering={FadeInDown.duration(700)} style={[s.headline, headStyle]} accessibilityRole="header">
              {headline}
            </Animated.Text>
            {panel}
          </View>
          {pine && <Floaters />}
          <Text style={[s.legal, !pine && { color: c.faint }]}>
            {t('common.copyright')} · {t('common.privacy')} · {t('common.terms')}
          </Text>
        </View>
        <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <Grain />
          <ScrollView contentContainerStyle={s.formScroll} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
            <View style={{ width: '100%', maxWidth: 420 }}>{children}</View>
          </ScrollView>
        </KeyboardAvoidingView>
      </View>
    );
  }

  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: c.bg }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView contentContainerStyle={{ flexGrow: 1 }} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false} bounces={false}>
        <View style={[s.mobileTop, panelStyle, { paddingTop: insets.top + 24 }]}>
          <Hatch color={pine ? 'rgba(237,231,217,0.035)' : c.hatch} />
          <Grain tone={pine ? 'light' : 'auto'} opacity={0.08} />
          {topBar}
          <View style={s.brandRow}>
            <VeroMark size={34} />
            <Wordmark size={24} color={pine ? c.onMine : undefined} />
          </View>
          <Animated.Text entering={FadeInDown.duration(700)} style={[s.headline, s.headlineMobile, headStyle]} accessibilityRole="header">
            {mobileHeadline ?? headline}
          </Animated.Text>
        </View>
        <Animated.View entering={SlideInDown.springify().damping(20)} style={[s.sheet, { paddingBottom: insets.bottom + 28 }]}>
          {children}
        </Animated.View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const useStyles = makeStyles((c, t, f) => {
  const latin = f.script === 'latin';
  return {
    wide: { flex: 1, flexDirection: 'row', backgroundColor: c.bg },
    brandPanel: { flex: 1, padding: 56, paddingTop: 48, justifyContent: 'space-between', overflow: 'hidden' },
    panelPine: { backgroundColor: c.mine },
    panelSurface: { backgroundColor: c.panel, borderRightWidth: 1, borderRightColor: c.line },
    brandRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
    headline: { fontFamily: f.display, fontSize: 58, lineHeight: latin ? 60 : 80, letterSpacing: latin ? -1.8 : 0 },
    headlineMobile: { fontSize: 36, lineHeight: latin ? 38 : 52 },
    headlinePine: { color: c.onMine },
    headlineSurface: { color: c.text },
    legal: { fontFamily: f.body, fontSize: 13, color: 'rgba(244,238,225,0.65)' },
    formScroll: { flexGrow: 1, alignItems: 'center', justifyContent: 'center', padding: 48 },
    floaters: { position: 'absolute', right: 32, bottom: 110, gap: 10, width: 230 },
    floatBubble: { paddingVertical: 10, paddingHorizontal: 14, borderRadius: 18 },
    floatA: { backgroundColor: '#0C0E0D', alignSelf: 'flex-start', borderBottomLeftRadius: 6 },
    floatB: { backgroundColor: c.accent, alignSelf: 'flex-end', borderBottomRightRadius: 6 },
    floatAText: { fontFamily: f.body, fontSize: 14, color: '#EDE7D9' },
    floatBText: { fontFamily: f.medium, fontSize: 14, color: c.onAccent },
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
    pointTitle: { fontFamily: f.semibold, fontSize: 16, color: c.onMine },
    pointBody: { fontFamily: f.body, fontSize: 14, lineHeight: latin ? 20 : 22, color: 'rgba(244,238,225,0.75)' },
    mobileTop: { minHeight: 300, paddingHorizontal: 24, paddingBottom: 60, justifyContent: 'space-between', gap: 28, overflow: 'hidden' },
    sheet: { flex: 1, marginTop: -30, borderTopLeftRadius: 30, borderTopRightRadius: 30, backgroundColor: c.bg, paddingHorizontal: 24, paddingTop: 28 },
  };
});
