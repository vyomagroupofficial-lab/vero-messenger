import React, { useEffect } from 'react';
import { Platform, StyleSheet, Text, View } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withSpring, withTiming } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { Colors, Fonts } from '../theme/theme';
import { Icon, IconName } from './Icon';
import { VeroMark } from './Brand';
import { Avatar, Pressy } from './primitives';
import { useAuthStore } from '../../features/auth/useAuthStore';

export const TAB_META: Record<string, { label: string; icon: IconName }> = {
  chats: { label: 'Chats', icon: 'chat' },
  calls: { label: 'Calls', icon: 'phone' },
  contacts: { label: 'Contacts', icon: 'users' },
  settings: { label: 'Settings', icon: 'sliders' },
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

function BottomItem({ name, focused, onPress }: { name: string; focused: boolean; onPress: () => void }) {
  const meta = TAB_META[name];
  const p = useFocus(focused);
  const pill = useAnimatedStyle(() => ({ opacity: p.value, transform: [{ scaleX: 0.6 + p.value * 0.4 }] }));
  if (!meta) return null;
  return (
    <Pressy
      onPress={onPress}
      accessibilityRole="tab"
      accessibilityState={{ selected: focused }}
      accessibilityLabel={meta.label}
      scaleTo={0.9}
      style={styles.bottomItem}
    >
      <View style={styles.pillWrap}>
        <Animated.View style={[StyleSheet.absoluteFill, styles.pill, pill]} />
        <View style={{ zIndex: 1 }}>
          <Icon name={meta.icon} size={22} color={focused ? Colors.brass : Colors.faint} />
        </View>
      </View>
      <Text style={[styles.bottomLabel, focused && { color: Colors.cream }]}>{meta.label}</Text>
    </Pressy>
  );
}

function RailItem({ name, focused, onPress }: { name: string; focused: boolean; onPress: () => void }) {
  const meta = TAB_META[name];
  const p = useFocus(focused);
  const bar = useAnimatedStyle(() => ({ opacity: p.value, transform: [{ scaleY: p.value }] }));
  const bg = useAnimatedStyle(() => ({ opacity: withTiming(focused ? 1 : 0, { duration: 180 }) }));
  if (!meta) return null;
  return (
    <Pressy
      onPress={onPress}
      accessibilityRole="tab"
      accessibilityState={{ selected: focused }}
      accessibilityLabel={meta.label}
      scaleTo={0.9}
      hoverStyle={!focused ? { backgroundColor: Colors.raised } : undefined}
      style={styles.railItem}
    >
      <Animated.View style={[StyleSheet.absoluteFill, { backgroundColor: Colors.raised, borderRadius: 14 }, bg]} />
      <Animated.View style={[styles.railBar, bar]} />
      <View style={{ zIndex: 1 }}>
        <Icon name={meta.icon} size={22} color={focused ? Colors.brass : Colors.faint} />
      </View>
    </Pressy>
  );
}

export function VeroTabBar({ state, navigation, wide }: TabBarProps) {
  const insets = useSafeAreaInsets();
  const user = useAuthStore((s) => s.user);

  const go = (route: { key: string; name: string }, focused: boolean) => {
    const event = navigation.emit({ type: 'tabPress', target: route.key, canPreventDefault: true });
    if (!focused && !event.defaultPrevented) navigation.navigate(route.name);
  };

  if (wide) {
    return (
      <View style={[styles.rail, { paddingTop: 20 + insets.top, paddingBottom: 20 + insets.bottom }]} accessibilityRole="tablist">
        <View style={{ marginBottom: 18 }}>
          <VeroMark size={40} />
        </View>
        {state.routes.map((r, i) => (
          <RailItem key={r.key} name={r.name} focused={state.index === i} onPress={() => go(r, state.index === i)} />
        ))}
        <View style={{ flex: 1 }} />
        <Pressy
          accessibilityLabel="Your profile and settings"
          onPress={() => router.navigate('/(tabs)/settings' as any)}
          scaleTo={0.92}
        >
          <Avatar name={user?.displayName || 'You'} size={40} ring />
        </Pressy>
      </View>
    );
  }

  return (
    <View style={[styles.bottom, { paddingBottom: Math.max(insets.bottom, 10) }]} accessibilityRole="tablist">
      {state.routes.map((r, i) => (
        <BottomItem key={r.key} name={r.name} focused={state.index === i} onPress={() => go(r, state.index === i)} />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  bottom: {
    flexDirection: 'row',
    paddingTop: 8,
    paddingHorizontal: 8,
    backgroundColor: 'rgba(12,14,13,0.96)',
    borderTopWidth: 1,
    borderTopColor: Colors.line,
    ...(Platform.OS === 'web' ? ({ backdropFilter: 'blur(14px)' } as any) : {}),
  },
  bottomItem: { flex: 1, alignItems: 'center', gap: 4, paddingVertical: 2 },
  pillWrap: { width: 58, height: 32, alignItems: 'center', justifyContent: 'center' },
  pill: { borderRadius: 16, backgroundColor: 'rgba(214,166,87,0.16)' },
  bottomLabel: { fontFamily: Fonts.medium, fontSize: 11, color: Colors.faint },
  rail: {
    width: 80,
    alignItems: 'center',
    gap: 8,
    backgroundColor: Colors.ink,
    borderRightWidth: 1,
    borderRightColor: Colors.line,
  },
  railItem: { width: 48, height: 48, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  railBar: {
    position: 'absolute',
    left: -16,
    top: 14,
    width: 4,
    height: 20,
    borderTopRightRadius: 4,
    borderBottomRightRadius: 4,
    backgroundColor: Colors.brass,
  },
});
