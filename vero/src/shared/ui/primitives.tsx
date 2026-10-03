import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  PressableProps,
  ScrollView,
  StyleProp,
  StyleSheet,
  Text,
  TextInput,
  TextInputProps,
  TextStyle,
  View,
  ViewStyle,
  useWindowDimensions,
} from 'react-native';
import Animated, {
  Easing,
  FadeIn,
  FadeInDown,
  SlideInDown,
  ZoomIn,
  interpolateColor,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withRepeat,
  withSequence,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { Colors, Fonts, Motion, Type, initialsOf, toneFor } from '../theme/theme';
import { Icon, IconName } from './Icon';
import { Grain } from './Brand';

// ── Layout ──────────────────────────────────────────────────────────────────

export const WIDE_BREAKPOINT = 900;

export function useLayout() {
  const { width, height } = useWindowDimensions();
  return { width, height, isWide: width >= WIDE_BREAKPOINT, isXL: width >= 1240 };
}

// ── Press feedback ──────────────────────────────────────────────────────────

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

type PressyProps = Omit<PressableProps, 'style'> & {
  style?: StyleProp<ViewStyle>;
  hoverStyle?: StyleProp<ViewStyle>;
  scaleTo?: number;
};

/** A Pressable that springs down when touched and back when released. */
export function Pressy({ style, hoverStyle, scaleTo = Motion.press, children, ...rest }: PressyProps) {
  const scale = useSharedValue(1);
  const [hovered, setHovered] = useState(false);
  const anim = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));

  return (
    <AnimatedPressable
      accessibilityRole={rest.accessibilityRole ?? 'button'}
      {...rest}
      onPressIn={(e) => {
        scale.value = withSpring(scaleTo, { damping: 22, stiffness: 420 });
        rest.onPressIn?.(e);
      }}
      onPressOut={(e) => {
        scale.value = withSpring(1, Motion.spring);
        rest.onPressOut?.(e);
      }}
      onHoverIn={(e) => {
        setHovered(true);
        rest.onHoverIn?.(e);
      }}
      onHoverOut={(e) => {
        setHovered(false);
        rest.onHoverOut?.(e);
      }}
      style={[style, hovered && hoverStyle, anim]}
    >
      {children as React.ReactNode}
    </AnimatedPressable>
  );
}

// ── Entrance ────────────────────────────────────────────────────────────────

/** Rises into place on mount — pass an index to stagger lists. */
export function Rise({
  index = 0,
  delay = 0,
  style,
  children,
}: {
  index?: number;
  delay?: number;
  style?: StyleProp<ViewStyle>;
  children: React.ReactNode;
}) {
  const d = delay + Math.min(index, 12) * Motion.stagger;
  return (
    <Animated.View entering={FadeInDown.delay(d).duration(460).easing(Easing.bezier(0.2, 0.8, 0.2, 1))} style={style}>
      {children}
    </Animated.View>
  );
}

export function Pop({ delay = 0, style, children }: { delay?: number; style?: StyleProp<ViewStyle>; children: React.ReactNode }) {
  return (
    <Animated.View entering={ZoomIn.delay(delay).springify().damping(14)} style={style}>
      {children}
    </Animated.View>
  );
}

// ── Screen & surfaces ───────────────────────────────────────────────────────

export function Screen({ children, style, grain = true }: { children: React.ReactNode; style?: StyleProp<ViewStyle>; grain?: boolean }) {
  return (
    <View style={[styles.screen, style]}>
      {grain && <Grain />}
      {children}
    </View>
  );
}

export function Panel({ children, style }: { children: React.ReactNode; style?: StyleProp<ViewStyle> }) {
  return <View style={[styles.panel, style]}>{children}</View>;
}

export function Eyebrow({ children, style }: { children: React.ReactNode; style?: StyleProp<TextStyle> }) {
  return <Text style={[Type.eyebrow, style]}>{typeof children === 'string' ? children.toUpperCase() : children}</Text>;
}

export function Divider({ inset = 0 }: { inset?: number }) {
  return <View style={{ height: 1, backgroundColor: Colors.divider, marginLeft: inset }} />;
}

// ── Avatar ──────────────────────────────────────────────────────────────────

interface AvatarProps {
  name: string;
  size?: number;
  tone?: string;
  square?: boolean;
  online?: boolean;
  ring?: boolean;
  ringColor?: string;
  cutout?: string; // colour behind the online dot
  icon?: IconName;
  style?: StyleProp<ViewStyle>;
}

export function Avatar({ name, size = 48, tone, square, online, ring, ringColor, cutout = Colors.ink, icon, style }: AvatarProps) {
  const bg = tone ?? toneFor(name);
  const radius = square ? size * 0.32 : size / 2;
  const dot = Math.min(20, Math.max(10, Math.round(size * 0.25)));
  // Sit the dot on the circle's edge at 45°, whatever the avatar size.
  const edge = square ? 0 : Math.max(0, Math.round((size / 2) * 0.293 - dot / 2 - 1));
  return (
    <View
      style={[
        { width: size, height: size },
        ring && { padding: 3, width: size + 6, height: size + 6, borderRadius: radius + 3, borderWidth: 1.5, borderColor: ringColor ?? Colors.brassLine },
        style,
      ]}
    >
      <View style={{ width: size, height: size, borderRadius: radius, backgroundColor: bg, alignItems: 'center', justifyContent: 'center' }}>
        {icon ? (
          <Icon name={icon} size={size * 0.42} color={Colors.avatarText} />
        ) : (
          <Text style={{ fontFamily: Fonts.display, fontSize: size * 0.34, color: Colors.avatarText, letterSpacing: 0.3 }}>
            {initialsOf(name)}
          </Text>
        )}
      </View>
      {online && <OnlineDot size={dot} cutout={cutout} style={{ position: 'absolute', right: (ring ? 4.5 : 0) + edge, bottom: (ring ? 4.5 : 0) + edge }} />}
    </View>
  );
}

export function OnlineDot({ size = 12, cutout = Colors.ink, style }: { size?: number; cutout?: string; style?: StyleProp<ViewStyle> }) {
  const pulse = useSharedValue(0);
  useEffect(() => {
    pulse.value = withRepeat(withTiming(1, { duration: 2200, easing: Easing.out(Easing.quad) }), -1, false);
  }, []);
  const ringStyle = useAnimatedStyle(() => ({
    opacity: 0.5 * (1 - pulse.value),
    transform: [{ scale: 1 + pulse.value * 1.2 }],
  }));
  return (
    <View style={[{ width: size, height: size }, style]}>
      <Animated.View style={[{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, borderRadius: size, backgroundColor: Colors.sage }, ringStyle]} />
      <View style={{ width: size, height: size, borderRadius: size, backgroundColor: Colors.sage, borderWidth: 2.5, borderColor: cutout }} />
    </View>
  );
}

// ── Buttons ─────────────────────────────────────────────────────────────────

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'dangerSoft' | 'sage';

interface ButtonProps {
  label: string;
  onPress?: () => void;
  icon?: IconName;
  iconRight?: IconName;
  variant?: ButtonVariant;
  loading?: boolean;
  disabled?: boolean;
  size?: 'md' | 'lg';
  style?: StyleProp<ViewStyle>;
}

const BTN: Record<ButtonVariant, { bg: string; fg: string; border?: string; hover: string }> = {
  primary: { bg: Colors.brass, fg: Colors.brassInk, hover: Colors.brassLight },
  secondary: { bg: 'transparent', fg: Colors.cream, border: Colors.line2, hover: Colors.raised },
  ghost: { bg: Colors.raised, fg: Colors.cream, border: Colors.line, hover: Colors.field },
  danger: { bg: Colors.emberDeep, fg: '#FBEFE6', hover: '#C9502F' },
  dangerSoft: { bg: Colors.emberTint, fg: Colors.ember, hover: 'rgba(224,105,74,0.16)' },
  sage: { bg: Colors.sageTint, fg: Colors.sage, border: Colors.sageLine, hover: 'rgba(134,192,159,0.16)' },
};

export function Button({ label, onPress, icon, iconRight, variant = 'primary', loading, disabled, size = 'lg', style }: ButtonProps) {
  const v = BTN[variant];
  const h = size === 'lg' ? 54 : 44;
  return (
    <Pressy
      onPress={onPress}
      disabled={disabled || loading}
      accessibilityLabel={label}
      scaleTo={0.97}
      hoverStyle={{ backgroundColor: v.hover }}
      style={[
        styles.button,
        { height: h, backgroundColor: v.bg, borderRadius: size === 'lg' ? 16 : 13 },
        v.border ? { borderWidth: 1, borderColor: v.border } : null,
        (disabled || loading) && { opacity: 0.55 },
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator color={v.fg} size="small" />
      ) : (
        <>
          {icon && <Icon name={icon} size={19} color={v.fg} />}
          <Text style={[Type.button, { color: v.fg, fontSize: size === 'lg' ? 15.5 : 14 }]}>{label}</Text>
          {iconRight && <Icon name={iconRight} size={19} color={v.fg} />}
        </>
      )}
    </Pressy>
  );
}

type IconButtonVariant = 'plain' | 'filled' | 'brass' | 'glass' | 'outline';

export function IconButton({
  icon,
  onPress,
  label,
  size = 44,
  iconSize,
  variant = 'plain',
  color,
  active,
  style,
}: {
  icon: IconName;
  onPress?: () => void;
  label: string;
  size?: number;
  iconSize?: number;
  variant?: IconButtonVariant;
  color?: string;
  active?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const base: Record<IconButtonVariant, ViewStyle> = {
    plain: {},
    filled: { backgroundColor: Colors.raised, borderWidth: 1, borderColor: Colors.line },
    brass: { backgroundColor: Colors.brass },
    glass: { backgroundColor: 'rgba(237,231,217,0.1)' },
    outline: { borderWidth: 1, borderColor: Colors.brassLine },
  };
  const fg = color ?? (variant === 'brass' ? Colors.brassInk : active ? Colors.ink : Colors.cream);
  return (
    <Pressy
      onPress={onPress}
      accessibilityLabel={label}
      scaleTo={0.9}
      hoverStyle={variant === 'brass' ? { backgroundColor: Colors.brassLight } : { backgroundColor: Colors.raised }}
      style={[
        { width: size, height: size, borderRadius: size * 0.32, alignItems: 'center', justifyContent: 'center' },
        base[variant],
        active && { backgroundColor: Colors.cream },
        style,
      ]}
    >
      <Icon name={icon} size={iconSize ?? Math.round(size * 0.46)} color={fg} />
    </Pressy>
  );
}

export function Chip({ label, active, onPress }: { label: string; active?: boolean; onPress?: () => void }) {
  return (
    <Pressy
      onPress={onPress}
      accessibilityState={{ selected: active }}
      scaleTo={0.94}
      hoverStyle={!active ? { borderColor: Colors.line3 } : undefined}
      style={[styles.chip, active && styles.chipActive]}
    >
      <Text style={[styles.chipText, active && { color: Colors.ink }]}>{label}</Text>
    </Pressy>
  );
}

export function Badge({ count }: { count: number }) {
  return (
    <Animated.View entering={ZoomIn.springify().damping(12)} style={styles.badge}>
      <Text style={styles.badgeText}>{count > 99 ? '99+' : count}</Text>
    </Animated.View>
  );
}

export function Pill({ icon, label, tone = 'sage', style }: { icon?: IconName; label: string; tone?: 'sage' | 'brass' | 'ember' | 'cream'; style?: StyleProp<ViewStyle> }) {
  const map = {
    sage: { bg: Colors.sageTint, fg: Colors.sage },
    brass: { bg: Colors.brassTint, fg: Colors.brassLight },
    ember: { bg: Colors.emberTint, fg: Colors.ember },
    cream: { bg: 'rgba(12,14,13,0.5)', fg: Colors.cream },
  }[tone];
  return (
    <View style={[styles.pill, { backgroundColor: map.bg }, style]}>
      {icon && <Icon name={icon} size={14} color={map.fg} />}
      <Text style={{ fontFamily: Fonts.medium, fontSize: 12.5, color: map.fg }}>{label}</Text>
    </View>
  );
}

// ── Toggle ──────────────────────────────────────────────────────────────────

export function Toggle({ value, onValueChange, label }: { value: boolean; onValueChange: (v: boolean) => void; label: string }) {
  const p = useSharedValue(value ? 1 : 0);
  useEffect(() => {
    p.value = withSpring(value ? 1 : 0, { damping: 15, stiffness: 260 });
  }, [value]);
  const track = useAnimatedStyle(() => ({
    backgroundColor: interpolateColor(p.value, [0, 1], [Colors.field, Colors.pine]),
    borderColor: interpolateColor(p.value, [0, 1], [Colors.line2, Colors.sageLine]),
  }));
  const knob = useAnimatedStyle(() => ({
    transform: [{ translateX: p.value * 20 }],
    backgroundColor: interpolateColor(p.value, [0, 1], [Colors.faint, Colors.cream]),
  }));
  return (
    <Pressable
      accessibilityRole="switch"
      accessibilityLabel={label}
      accessibilityState={{ checked: value }}
      onPress={() => onValueChange(!value)}
      hitSlop={8}
    >
      <Animated.View style={[styles.toggleTrack, track]}>
        <Animated.View style={[styles.toggleKnob, knob]} />
      </Animated.View>
    </Pressable>
  );
}

// ── Text field ──────────────────────────────────────────────────────────────

interface FieldProps extends TextInputProps {
  label?: string;
  icon?: IconName;
  error?: string;
  right?: React.ReactNode;
  containerStyle?: StyleProp<ViewStyle>;
}

export function TextField({ label, icon, error, right, containerStyle, onFocus, onBlur, ...rest }: FieldProps) {
  const [focused, setFocused] = useState(false);
  return (
    <View style={[{ gap: 8 }, containerStyle]}>
      {label ? <Text style={Type.label}>{label}</Text> : null}
      <View
        style={[
          styles.field,
          focused && { borderColor: Colors.brass, borderWidth: 1.5 },
          !!error && { borderColor: Colors.ember, borderWidth: 1.5 },
        ]}
      >
        {icon && <Icon name={icon} size={19} color={focused ? Colors.brass : Colors.faint} />}
        <TextInput
          placeholderTextColor="#7D7A6E"
          selectionColor={Colors.brass}
          {...rest}
          onFocus={(e) => {
            setFocused(true);
            onFocus?.(e);
          }}
          onBlur={(e) => {
            setFocused(false);
            onBlur?.(e);
          }}
          style={[styles.fieldInput, rest.style]}
        />
        {right}
      </View>
      {error ? (
        <Animated.Text entering={FadeIn.duration(200)} style={{ fontFamily: Fonts.medium, fontSize: 12.5, color: Colors.ember }}>
          {error}
        </Animated.Text>
      ) : null}
    </View>
  );
}

export function SearchField({ value, onChangeText, placeholder, autoFocus, onClear, style }: {
  value: string;
  onChangeText: (t: string) => void;
  placeholder: string;
  autoFocus?: boolean;
  onClear?: () => void;
  style?: StyleProp<ViewStyle>;
}) {
  const [focused, setFocused] = useState(false);
  return (
    <View style={[styles.search, focused && { borderColor: Colors.brassLine }, style]}>
      <Icon name="search" size={18} color={Colors.faint} />
      <TextInput
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={Colors.faint}
        selectionColor={Colors.brass}
        autoFocus={autoFocus}
        autoCapitalize="none"
        accessibilityLabel={placeholder}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        style={styles.searchInput}
      />
      {value.length > 0 && (
        <Pressy onPress={onClear ?? (() => onChangeText(''))} accessibilityLabel="Clear search" style={{ padding: 4 }}>
          <Icon name="close" size={16} color={Colors.muted} />
        </Pressy>
      )}
    </View>
  );
}

// ── Sheets & dialogs ────────────────────────────────────────────────────────

export function Sheet({ visible, onClose, title, children }: { visible: boolean; onClose: () => void; title?: string; children: React.ReactNode }) {
  const { isWide } = useLayout();
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose} statusBarTranslucent>
      <Pressable style={[styles.backdrop, isWide && { justifyContent: 'center', alignItems: 'center', padding: 24 }]} onPress={onClose} accessibilityLabel="Close">
        <Animated.View
          entering={isWide ? ZoomIn.springify().damping(18) : SlideInDown.springify().damping(20).stiffness(180)}
          style={[styles.sheet, isWide && styles.dialog]}
        >
          <Pressable onPress={() => {}} style={{ gap: 14 }}>
            {!isWide && <View style={styles.handle} />}
            {title ? <Text style={Type.h3}>{title}</Text> : null}
            {children}
          </Pressable>
        </Animated.View>
      </Pressable>
    </Modal>
  );
}

export function SheetRow({ icon, label, onPress, tone = 'cream', detail }: { icon: IconName; label: string; onPress?: () => void; tone?: 'cream' | 'ember' | 'brass'; detail?: string }) {
  const color = tone === 'ember' ? Colors.ember : tone === 'brass' ? Colors.brass : Colors.cream;
  return (
    <Pressy onPress={onPress} scaleTo={0.98} hoverStyle={{ backgroundColor: Colors.creamTint }} style={styles.sheetRow}>
      <View style={[styles.sheetRowIcon, tone === 'ember' && { backgroundColor: Colors.emberTint }]}>
        <Icon name={icon} size={19} color={tone === 'cream' ? Colors.brass : color} />
      </View>
      <Text style={[Type.body, { color, flex: 1, fontFamily: Fonts.medium }]}>{label}</Text>
      {detail ? <Text style={Type.caption}>{detail}</Text> : null}
    </Pressy>
  );
}

// ── Messaging bits ──────────────────────────────────────────────────────────

function Dot({ delay }: { delay: number }) {
  const v = useSharedValue(0);
  useEffect(() => {
    v.value = withDelay(
      delay,
      withRepeat(withSequence(withTiming(1, { duration: 320 }), withTiming(0, { duration: 320 }), withTiming(0, { duration: 560 })), -1)
    );
  }, []);
  const a = useAnimatedStyle(() => ({ opacity: 0.4 + v.value * 0.6, transform: [{ translateY: -4 * v.value }] }));
  return <Animated.View style={[styles.typingDot, a]} />;
}

export function TypingDots() {
  return (
    <Animated.View entering={FadeInDown.springify().damping(16)} style={styles.typing} accessibilityLabel="typing">
      <Dot delay={0} />
      <Dot delay={150} />
      <Dot delay={300} />
    </Animated.View>
  );
}

const WAVE = [8, 14, 22, 12, 26, 18, 10, 24, 28, 16, 9, 20, 26, 14, 8, 18, 24, 12, 20, 28, 16, 10, 22, 14, 8, 18];

function WaveBar({ h, i, color, playing }: { h: number; i: number; color: string; playing: boolean }) {
  const v = useSharedValue(1);
  useEffect(() => {
    if (playing) {
      v.value = withDelay((i % 7) * 90, withRepeat(withSequence(withTiming(0.4, { duration: 420 }), withTiming(1.1, { duration: 420 })), -1, true));
    } else {
      v.value = withTiming(1, { duration: 200 });
    }
  }, [playing]);
  const a = useAnimatedStyle(() => ({ transform: [{ scaleY: v.value }] }));
  return <Animated.View style={[{ width: 3, height: h, borderRadius: 2, backgroundColor: color }, a]} />;
}

export function Waveform({ progress = 0.35, playing = false, active = Colors.brass, rest = 'rgba(237,231,217,0.45)', bars = WAVE }: {
  progress?: number;
  playing?: boolean;
  active?: string;
  rest?: string;
  bars?: number[];
}) {
  const played = Math.round(bars.length * (playing ? 1 : progress));
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 2, height: 30, flex: 1 }}>
      {bars.map((h, i) => (
        <WaveBar key={i} h={h} i={i} playing={playing} color={i < played ? active : rest} />
      ))}
    </View>
  );
}

export function EmptyState({ icon, title, body, action }: { icon: IconName; title: string; body: string; action?: React.ReactNode }) {
  return (
    <Rise style={styles.empty}>
      <View style={styles.emptyIcon}>
        <Icon name={icon} size={30} color={Colors.brass} />
      </View>
      <Text style={[Type.h3, { textAlign: 'center' }]}>{title}</Text>
      <Text style={[Type.bodyMuted, { textAlign: 'center', maxWidth: 300 }]}>{body}</Text>
      {action}
    </Rise>
  );
}

export function ScrollArea({ children, contentContainerStyle, style }: { children: React.ReactNode; contentContainerStyle?: StyleProp<ViewStyle>; style?: StyleProp<ViewStyle> }) {
  return (
    <ScrollView style={style} contentContainerStyle={contentContainerStyle} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
      {children}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: Colors.ink },
  panel: {
    backgroundColor: Colors.panel,
    borderRadius: 22,
    borderWidth: 1,
    borderColor: Colors.line,
    paddingHorizontal: 18,
    overflow: 'hidden',
  },
  button: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10, paddingHorizontal: 22 },
  chip: { height: 34, paddingHorizontal: 15, borderRadius: 999, borderWidth: 1, borderColor: Colors.line2, justifyContent: 'center' },
  chipActive: { backgroundColor: Colors.cream, borderColor: Colors.cream },
  chipText: { fontFamily: Fonts.medium, fontSize: 13, color: Colors.muted },
  badge: {
    minWidth: 22,
    height: 22,
    paddingHorizontal: 7,
    borderRadius: 11,
    backgroundColor: Colors.brass,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeText: { fontFamily: Fonts.bold, fontSize: 12, color: Colors.brassInk },
  pill: { flexDirection: 'row', alignItems: 'center', gap: 6, height: 30, paddingHorizontal: 12, borderRadius: 999, alignSelf: 'flex-start' },
  toggleTrack: { width: 52, height: 32, borderRadius: 16, borderWidth: 1, justifyContent: 'center', paddingHorizontal: 3 },
  toggleKnob: { width: 24, height: 24, borderRadius: 12 },
  field: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    height: 54,
    paddingHorizontal: 16,
    borderRadius: 16,
    backgroundColor: Colors.raised,
    borderWidth: 1,
    borderColor: 'rgba(237,231,217,0.1)',
  },
  fieldInput: { flex: 1, minWidth: 0, height: '100%', fontFamily: Fonts.body, fontSize: 16, color: Colors.cream, outlineStyle: 'none' } as any,
  search: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    height: 46,
    paddingHorizontal: 16,
    borderRadius: 15,
    backgroundColor: Colors.raised,
    borderWidth: 1,
    borderColor: Colors.line,
  },
  searchInput: { flex: 1, minWidth: 0, height: '100%', fontFamily: Fonts.body, fontSize: 15, color: Colors.cream, outlineStyle: 'none' } as any,
  backdrop: { flex: 1, backgroundColor: Colors.overlay, justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: Colors.panel,
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    borderWidth: 1,
    borderColor: Colors.line,
    padding: 22,
    paddingBottom: 34,
  },
  dialog: { width: '100%', maxWidth: 460, borderRadius: 26, paddingBottom: 22 },
  handle: { alignSelf: 'center', width: 40, height: 4, borderRadius: 2, backgroundColor: Colors.line3, marginBottom: 4 },
  sheetRow: { flexDirection: 'row', alignItems: 'center', gap: 14, minHeight: 54, paddingHorizontal: 6, borderRadius: 14 },
  sheetRowIcon: { width: 38, height: 38, borderRadius: 12, backgroundColor: Colors.raised, alignItems: 'center', justifyContent: 'center' },
  typing: {
    flexDirection: 'row',
    gap: 4,
    paddingVertical: 14,
    paddingHorizontal: 16,
    borderRadius: 20,
    borderBottomLeftRadius: 6,
    backgroundColor: Colors.raised,
    borderWidth: 1,
    borderColor: Colors.line,
    alignSelf: 'flex-start',
    marginVertical: 4,
  },
  typingDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: Colors.muted },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 10, padding: 32 },
  emptyIcon: {
    width: 76,
    height: 76,
    borderRadius: 24,
    backgroundColor: Colors.brassTint,
    borderWidth: 1,
    borderColor: 'rgba(214,166,87,0.2)',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 6,
  },
});

// ── Ripple rings (calls) ────────────────────────────────────────────────────

function Ring({ size, delay, color, duration }: { size: number; delay: number; color: string; duration: number }) {
  const v = useSharedValue(0);
  useEffect(() => {
    v.value = withDelay(delay, withRepeat(withTiming(1, { duration, easing: Easing.out(Easing.quad) }), -1, false));
  }, []);
  const a = useAnimatedStyle(() => ({ opacity: 0.6 * (1 - v.value), transform: [{ scale: 1 + v.value * 0.9 }] }));
  return (
    <Animated.View
      pointerEvents="none"
      style={[{ position: 'absolute', width: size, height: size, borderRadius: size / 2, borderWidth: 2, borderColor: color }, a]}
    />
  );
}

/** Concentric rings that breathe out from an avatar while a call is live. */
export function Ripple({ size, color = 'rgba(214,166,87,0.55)', count = 3, duration = 2600, children }: {
  size: number;
  color?: string;
  count?: number;
  duration?: number;
  children: React.ReactNode;
}) {
  return (
    <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
      {Array.from({ length: count }, (_, i) => (
        <Ring key={i} size={size} delay={(i * duration) / count} color={color} duration={duration} />
      ))}
      <View style={{ zIndex: 1 }}>{children}</View>
    </View>
  );
}

/** Horizontal "no" shake for rejected forms. */
export function useShake() {
  const x = useSharedValue(0);
  const style = useAnimatedStyle(() => ({ transform: [{ translateX: x.value }] }));
  const shake = () => {
    x.value = withSequence(
      withTiming(10, { duration: 50 }),
      withTiming(-10, { duration: 50 }),
      withTiming(8, { duration: 50 }),
      withTiming(-8, { duration: 50 }),
      withSpring(0, { damping: 8, stiffness: 300 })
    );
  };
  return { style, shake };
}
