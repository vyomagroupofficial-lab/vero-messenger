import React, { useEffect } from 'react';
import { Platform, StyleSheet, Text, View } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withSpring, withTiming } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { makeStyles, useTheme } from '../theme/ThemeProvider';
import { useT } from '../i18n';
import { Icon, IconName } from './Icon';
import { VeroMark } from './Brand';
import { Avatar, Badge, Pressy } from './primitives';
import { useAuthStore } from '../../features/auth/useAuthStore';
import { useTotalUnread } from '../../features/chats/useChatsStore';

export const TAB_META: Record<string, { labelKey: string; icon: IconName }> = {
  chats: { labelKey: 'tabs.chats', icon: 'chat' },
  calls: { labelKey: 'tabs.calls', icon: 'phone' },
  contacts: { labelKey: 'tabs.contacts', icon: 'users' },
  settings: { labelKey: 'tabs.settings', icon: 'sliders' },
};

interface TabBarProps {
  state: { index: number; routes: { key: string; name: string }[] };
  navigation: { emit: (e: any) => any; navigate: (name: string) => void };
  wide: boolean;
}

function useFocus(focused: boolean) {
  const p = useSharedValue(focused ? 1 : 0);
  useEffect(() => {
    p.value = withSpring(focused ? 1 : 0, { damping: 16, stiffness: 240 });
  }, [focused]);
  return p;
}

/** Unread messages across non-archived chats, the same rule the chat list uses. */
function useUnreadChats() {
  return useTotalUnread();
}

function BottomItem({ name, focused, onPress, badge }: { name: string; focused: boolean; onPress: () => void; badge?: number }) {
  const meta = TAB_META[name];
  const { c } = useTheme();
  const s = useStyles();
  const t = useT();
  const p = useFocus(focused);
  const pill = useAnimatedStyle(() => ({ opacity: p.value, transform: [{ scaleX: 0.6 + p.value * 0.4 }] }));
  if (!meta) return null;
  const label = t(meta.labelKey);
  return (
    <Pressy
      onPress={onPress}
      accessibilityRole="tab"
      accessibilityState={{ selected: focused }}
      accessibilityLabel={badge ? t('tabs.withUnread', { label, count: badge }) : label}
      scaleTo={0.9}
      style={s.bottomItem}
    >
      <View style={s.pillWrap}>
        <Animated.View style={[StyleSheet.absoluteFill, s.pill, pill]} />
        <View style={{ zIndex: 1 }}>
          <Icon name={meta.icon} size={22} color={focused ? c.accentText : c.faint} />
        </View>
        {!!badge && (
          <View style={s.badgeSpot}>
            <Badge count={badge} />
          </View>
        )}
      </View>
      <Text style={[s.bottomLabel, focused && { color: c.text }]} numberOfLines={1}>
        {label}
      </Text>
    </Pressy>
  );
}

function RailItem({ name, focused, onPress, badge }: { name: string; focused: boolean; onPress: () => void; badge?: number }) {
  const meta = TAB_META[name];
  const { c } = useTheme();
  const s = useStyles();
  const t = useT();
  const p = useFocus(focused);
  const bar = useAnimatedStyle(() => ({ opacity: p.value, transform: [{ scaleY: p.value }] }));
  const bg = useAnimatedStyle(() => ({ opacity: withTiming(focused ? 1 : 0, { duration: 180 }) }));
  if (!meta) return null;
  const label = t(meta.labelKey);
  return (
    <Pressy
      onPress={onPress}
      accessibilityRole="tab"
      accessibilityState={{ selected: focused }}
      accessibilityLabel={badge ? t('tabs.withUnread', { label, count: badge }) : label}
      scaleTo={0.9}
      hoverStyle={!focused ? { backgroundColor: c.raised } : undefined}
      style={s.railItem}
    >
      <Animated.View style={[StyleSheet.absoluteFill, { backgroundColor: c.raised, borderRadius: 14 }, bg]} />
      <Animated.View style={[s.railBar, bar]} />
      <View style={{ zIndex: 1 }}>
        <Icon name={meta.icon} size={22} color={focused ? c.accentText : c.faint} />
      </View>
      {!!badge && <View style={s.railDot} />}
    </Pressy>
  );
}

export function VeroTabBar({ state, navigation, wide }: TabBarProps) {
  const insets = useSafeAreaInsets();
  const s = useStyles();
  const t = useT();
  const user = useAuthStore((st) => st.user);
  const unread = useUnreadChats();

  const go = (route: { key: string; name: string }, focused: boolean) => {
    const event = navigation.emit({ type: 'tabPress', target: route.key, canPreventDefault: true });
    if (!focused && !event.defaultPrevented) navigation.navigate(route.name);
  };

  if (wide) {
    return (
      <View style={[s.rail, { paddingTop: 20 + insets.top, paddingBottom: 20 + insets.bottom }]} accessibilityRole="tablist">
        <View style={{ marginBottom: 18 }}>
          <VeroMark size={40} />
        </View>
        {state.routes.map((r, i) => (
          <RailItem key={r.key} name={r.name} focused={state.index === i} badge={r.name === 'chats' ? unread : 0} onPress={() => go(r, state.index === i)} />
        ))}
        <View style={{ flex: 1 }} />
        <Pressy accessibilityLabel={t('tabs.profile')} onPress={() => router.navigate('/(tabs)/settings')} scaleTo={0.92}>
          <Avatar name={user?.displayName || '?'} size={40} ring />
        </Pressy>
      </View>
    );
  }

  return (
    <View style={[s.bottom, { paddingBottom: Math.max(insets.bottom, 10) }]} accessibilityRole="tablist">
      {state.routes.map((r, i) => (
        <BottomItem key={r.key} name={r.name} focused={state.index === i} badge={r.name === 'chats' ? unread : 0} onPress={() => go(r, state.index === i)} />
      ))}
    </View>
  );
}

const useStyles = makeStyles((c, t, f) => ({
  bottom: {
    flexDirection: 'row',
    paddingTop: 8,
    paddingHorizontal: 8,
    backgroundColor: c.bg,
    borderTopWidth: 1,
    borderTopColor: c.line,
    ...(Platform.OS === 'web' ? ({ backdropFilter: 'blur(14px)' } as any) : {}),
  },
  bottomItem: { flex: 1, alignItems: 'center', gap: 4, paddingVertical: 2 },
  pillWrap: { width: 58, height: 32, alignItems: 'center', justifyContent: 'center' },
  pill: { borderRadius: 16, backgroundColor: c.accentTint2 },
  badgeSpot: { position: 'absolute', top: -6, right: 2, zIndex: 2, transform: [{ scale: 0.82 }] },
  bottomLabel: { fontFamily: f.medium, fontSize: 11, color: c.faint },
  rail: { width: 80, alignItems: 'center', gap: 8, backgroundColor: c.bg, borderRightWidth: 1, borderRightColor: c.line },
  railItem: { width: 48, height: 48, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  railBar: {
    position: 'absolute',
    left: -16,
    top: 14,
    width: 4,
    height: 20,
    borderTopRightRadius: 4,
    borderBottomRightRadius: 4,
    backgroundColor: c.accent,
  },
  railDot: { position: 'absolute', top: 9, right: 9, width: 8, height: 8, borderRadius: 4, backgroundColor: c.accent, borderWidth: 2, borderColor: c.bg, zIndex: 2 },
}));
