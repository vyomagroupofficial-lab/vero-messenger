import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  PressableProps,
  ScrollView,
  StyleProp,
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
import { Motion, Palette, initialsOf, toneFor } from '../theme/theme';
import { makeStyles, useTheme } from '../theme/ThemeProvider';
import { useT } from '../i18n';
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
export function Rise({ index = 0, delay = 0, style, children }: { index?: number; delay?: number; style?: StyleProp<ViewStyle>; children: React.ReactNode }) {
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
  const s = useStyles();
  return (
    <View style={[s.screen, style]}>
      {grain && <Grain />}
      {children}
    </View>
  );
}

export function Panel({ children, style }: { children: React.ReactNode; style?: StyleProp<ViewStyle> }) {
  const s = useStyles();
  return <View style={[s.panel, style]}>{children}</View>;
}

export function Eyebrow({ children, style }: { children: React.ReactNode; style?: StyleProp<TextStyle> }) {
  const { type, f } = useTheme();
  const text = typeof children === 'string' && f.script === 'latin' ? children.toUpperCase() : children;
  return <Text style={[type.eyebrow, style]}>{text}</Text>;
}

export function Divider({ inset = 0 }: { inset?: number }) {
  const { c } = useTheme();
  return <View style={{ height: 1, backgroundColor: c.line, marginLeft: inset }} />;
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

export function Avatar({ name, size = 48, tone, square, online, ring, ringColor, cutout, icon, style }: AvatarProps) {
  const { c, f } = useTheme();
  const bg = tone ?? toneFor(name);
  const radius = square ? size * 0.32 : size / 2;
  const dot = Math.min(20, Math.max(10, Math.round(size * 0.25)));
  // Sit the dot on the circle's edge at 45°, whatever the avatar size.
  const edge = square ? 0 : Math.max(0, Math.round((size / 2) * 0.293 - dot / 2 - 1));
  return (
    <View
      style={[
        { width: size, height: size },
        ring && { padding: 3, width: size + 6, height: size + 6, borderRadius: radius + 3, borderWidth: 1.5, borderColor: ringColor ?? c.accentLine },
        style,
      ]}
    >
      <View style={{ width: size, height: size, borderRadius: radius, backgroundColor: bg, alignItems: 'center', justifyContent: 'center' }}>
        {icon ? (
          <Icon name={icon} size={size * 0.42} color={c.avatarText} />
        ) : (
          <Text style={{ fontFamily: f.display, fontSize: size * 0.34, color: c.avatarText, letterSpacing: f.script === 'latin' ? 0.3 : 0 }}>
            {initialsOf(name)}
          </Text>
        )}
      </View>
      {online && (
        <OnlineDot
          size={dot}
          cutout={cutout ?? c.bg}
          style={{ position: 'absolute', right: (ring ? 4.5 : 0) + edge, bottom: (ring ? 4.5 : 0) + edge }}
        />
      )}
    </View>
  );
}

export function OnlineDot({ size = 12, cutout, style }: { size?: number; cutout?: string; style?: StyleProp<ViewStyle> }) {
  const { c } = useTheme();
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
      <Animated.View style={[{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, borderRadius: size, backgroundColor: c.success }, ringStyle]} />
      <View style={{ width: size, height: size, borderRadius: size, backgroundColor: c.success, borderWidth: 2.5, borderColor: cutout ?? c.bg }} />
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
  size?: 'sm' | 'md' | 'lg';
  style?: StyleProp<ViewStyle>;
}

function buttonColors(c: Palette, v: ButtonVariant): { bg: string; fg: string; border?: string; hover: string } {
  switch (v) {
    case 'primary':
      return { bg: c.accent, fg: c.onAccent, hover: c.accentHover };
    case 'secondary':
      return { bg: 'transparent', fg: c.text, border: c.line2, hover: c.raised };
    case 'ghost':
      return { bg: c.raised, fg: c.text, border: c.line, hover: c.field };
    case 'danger':
      return { bg: c.dangerFill, fg: c.onDanger, hover: c.danger };
    case 'dangerSoft':
      return { bg: c.dangerTint, fg: c.danger, hover: c.dangerTint };
    case 'sage':
      return { bg: c.successTint, fg: c.success, border: c.successLine, hover: c.successTint };
  }
}

export function Button({ label, onPress, icon, iconRight, variant = 'primary', loading, disabled, size = 'lg', style }: ButtonProps) {
  const { c, type } = useTheme();
  const s = useStyles();
  const v = buttonColors(c, variant);
  const h = size === 'lg' ? 54 : size === 'md' ? 44 : 34;
  return (
    <Pressy
      onPress={onPress}
      disabled={disabled || loading}
      accessibilityLabel={label}
      accessibilityState={{ disabled: disabled || loading, busy: loading }}
      scaleTo={0.97}
      hoverStyle={{ backgroundColor: v.hover }}
      style={[
        s.button,
        { height: h, backgroundColor: v.bg, borderRadius: size === 'lg' ? 16 : size === 'md' ? 13 : 10 },
        size === 'sm' && { paddingHorizontal: 12, gap: 6 },
        v.border ? { borderWidth: 1, borderColor: v.border } : null,
        (disabled || loading) && { opacity: 0.55 },
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator color={v.fg} size="small" />
      ) : (
        <>
          {icon && <Icon name={icon} size={size === 'sm' ? 15 : 19} color={v.fg} />}
          <Text style={[type.button, { color: v.fg, fontSize: size === 'lg' ? 15.5 : size === 'md' ? 14 : 13 }]} numberOfLines={1}>
            {label}
          </Text>
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
  disabled,
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
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const { c } = useTheme();
  const base: Record<IconButtonVariant, ViewStyle> = {
    plain: {},
    filled: { backgroundColor: c.raised, borderWidth: 1, borderColor: c.line },
    brass: { backgroundColor: c.accent },
    glass: { backgroundColor: 'rgba(237,231,217,0.1)' },
    outline: { borderWidth: 1, borderColor: c.accentLine },
  };
  const fg = color ?? (variant === 'brass' ? c.onAccent : variant === 'glass' ? c.onStage : active ? c.bg : c.text);
  return (
    <Pressy
      onPress={onPress}
      disabled={disabled}
      accessibilityLabel={label}
      scaleTo={0.9}
      hoverStyle={variant === 'brass' ? { backgroundColor: c.accentHover } : variant === 'glass' ? { backgroundColor: 'rgba(237,231,217,0.18)' } : { backgroundColor: c.raised }}
      style={[
        { width: size, height: size, borderRadius: size * 0.32, alignItems: 'center', justifyContent: 'center' },
        base[variant],
        active && { backgroundColor: c.text },
        disabled && { opacity: 0.45 },
        style,
      ]}
    >
      <Icon name={icon} size={iconSize ?? Math.round(size * 0.46)} color={fg} />
    </Pressy>
  );
}

export function Chip({ label, active, onPress }: { label: string; active?: boolean; onPress?: () => void }) {
  const { c } = useTheme();
  const s = useStyles();
  return (
    <Pressy
      onPress={onPress}
      accessibilityState={{ selected: active }}
      scaleTo={0.94}
      hoverStyle={!active ? { borderColor: c.line3 } : undefined}
      style={[s.chip, active && s.chipActive]}
    >
      <Text style={[s.chipText, active && { color: c.bg }]}>{label}</Text>
    </Pressy>
  );
}

export function Badge({ count }: { count: number }) {
  const s = useStyles();
  return (
    <Animated.View entering={ZoomIn.springify().damping(12)} style={s.badge}>
      <Text style={s.badgeText}>{count > 99 ? '99+' : count}</Text>
    </Animated.View>
  );
}

export function Pill({ icon, label, tone = 'sage', style }: { icon?: IconName; label: string; tone?: 'sage' | 'brass' | 'ember' | 'stage'; style?: StyleProp<ViewStyle> }) {
  const { c, f } = useTheme();
  const s = useStyles();
  const map = {
    sage: { bg: c.successTint, fg: c.success },
    brass: { bg: c.accentTint, fg: c.accentText },
    ember: { bg: c.dangerTint, fg: c.danger },
    stage: { bg: 'rgba(12,14,13,0.5)', fg: c.onStage },
  }[tone];
  return (
    <View style={[s.pill, { backgroundColor: map.bg }, style]}>
      {icon && <Icon name={icon} size={14} color={map.fg} />}
      <Text style={{ fontFamily: f.medium, fontSize: 12.5, color: map.fg }}>{label}</Text>
    </View>
  );
}

// ── Toggle ──────────────────────────────────────────────────────────────────

export function Toggle({ value, onValueChange, label, disabled }: { value: boolean; onValueChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  const { c } = useTheme();
  const s = useStyles();
  const p = useSharedValue(value ? 1 : 0);
  useEffect(() => {
    p.value = withSpring(value ? 1 : 0, { damping: 15, stiffness: 260 });
  }, [value]);
  const offTrack = c.field;
  const onTrack = c.mine;
  const offLine = c.line2;
  const onLine = c.successLine;
  const offKnob = c.faint;
  const onKnob = c.onMine;
  const track = useAnimatedStyle(() => ({
    backgroundColor: interpolateColor(p.value, [0, 1], [offTrack, onTrack]),
    borderColor: interpolateColor(p.value, [0, 1], [offLine, onLine]),
  }));
  const knob = useAnimatedStyle(() => ({
    transform: [{ translateX: p.value * 20 }],
    backgroundColor: interpolateColor(p.value, [0, 1], [offKnob, onKnob]),
  }));
  return (
    <Pressable
      accessibilityRole="switch"
      accessibilityLabel={label}
      accessibilityState={{ checked: value, disabled }}
      disabled={disabled}
      onPress={() => onValueChange(!value)}
      hitSlop={8}
      style={disabled ? { opacity: 0.5 } : undefined}
    >
      <Animated.View style={[s.toggleTrack, track]}>
        <Animated.View style={[s.toggleKnob, knob]} />
      </Animated.View>
    </Pressable>
  );
}

/** Segmented control, e.g. theme or timer pickers. */
export function Segmented<T extends string>({ options, value, onChange, label }: { options: { value: T; label: string }[]; value: T; onChange: (v: T) => void; label: string }) {
  const { c } = useTheme();
  const s = useStyles();
  return (
    <View style={s.segment} accessibilityRole="radiogroup" accessibilityLabel={label}>
      {options.map((o) => {
        const on = o.value === value;
        return (
          <Pressy
            key={o.value}
            onPress={() => onChange(o.value)}
            scaleTo={0.95}
            accessibilityRole="radio"
            accessibilityState={{ selected: on }}
            accessibilityLabel={o.label}
            style={[s.segBtn, on && { backgroundColor: c.text }]}
          >
            <Text style={[s.segText, on && { color: c.bg }]}>{o.label}</Text>
          </Pressy>
        );
      })}
    </View>
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
  const { c, type } = useTheme();
  const s = useStyles();
  const [focused, setFocused] = useState(false);
  return (
    <View style={[{ gap: 8 }, containerStyle]}>
      {label ? <Text style={type.label}>{label}</Text> : null}
      <View style={[s.field, focused && { borderColor: c.accent, borderWidth: 1.5 }, !!error && { borderColor: c.danger, borderWidth: 1.5 }]}>
        {icon && <Icon name={icon} size={19} color={focused ? c.accentText : c.faint} />}
        <TextInput
          placeholderTextColor={c.placeholder}
          selectionColor={c.accent}
          accessibilityLabel={label}
          {...rest}
          onFocus={(e) => {
            setFocused(true);
            onFocus?.(e);
          }}
          onBlur={(e) => {
            setFocused(false);
            onBlur?.(e);
          }}
          style={[s.fieldInput, rest.style]}
        />
        {right}
      </View>
      {error ? (
        <Animated.Text entering={FadeIn.duration(200)} style={[type.caption, { color: c.danger }]}>
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
  const { c } = useTheme();
  const s = useStyles();
  const t = useT();
  const [focused, setFocused] = useState(false);
  return (
    <View style={[s.search, focused && { borderColor: c.accentLine }, style]}>
      <Icon name="search" size={18} color={c.faint} />
      <TextInput
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={c.faint}
        selectionColor={c.accent}
        autoFocus={autoFocus}
        autoCapitalize="none"
        accessibilityLabel={placeholder}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        style={s.searchInput}
      />
      {value.length > 0 && (
        <Pressy onPress={onClear ?? (() => onChangeText(''))} accessibilityLabel={t('common.clearSearch')} style={{ padding: 4 }}>
          <Icon name="close" size={16} color={c.muted} />
        </Pressy>
      )}
    </View>
  );
}

// ── Sheets & dialogs ────────────────────────────────────────────────────────

export function Sheet({ visible, onClose, title, children }: { visible: boolean; onClose: () => void; title?: string; children: React.ReactNode }) {
  const { isWide } = useLayout();
  const { type } = useTheme();
  const s = useStyles();
  const t = useT();
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose} statusBarTranslucent>
      <Pressable style={[s.backdrop, isWide && { justifyContent: 'center', alignItems: 'center', padding: 24 }]} onPress={onClose} accessibilityLabel={t('common.close')}>
        <Animated.View entering={isWide ? ZoomIn.springify().damping(18) : SlideInDown.springify().damping(20).stiffness(180)} style={[s.sheet, isWide && s.dialog]}>
          <Pressable onPress={() => {}} style={{ gap: 14 }} accessibilityViewIsModal>
            {!isWide && <View style={s.handle} />}
            {title ? <Text style={type.h3}>{title}</Text> : null}
            {children}
          </Pressable>
        </Animated.View>
      </Pressable>
    </Modal>
  );
}

export function SheetRow({ icon, label, onPress, tone = 'default', detail, selected }: {
  icon: IconName;
  label: string;
  onPress?: () => void;
  tone?: 'default' | 'ember' | 'brass';
  detail?: string;
  selected?: boolean;
}) {
  const { c, type, f } = useTheme();
  const s = useStyles();
  const color = tone === 'ember' ? c.danger : tone === 'brass' ? c.accentText : c.text;
  return (
    <Pressy onPress={onPress} scaleTo={0.98} hoverStyle={{ backgroundColor: c.tint }} style={s.sheetRow} accessibilityLabel={label} accessibilityState={{ selected }}>
      <View style={[s.sheetRowIcon, tone === 'ember' && { backgroundColor: c.dangerTint }]}>
        <Icon name={icon} size={19} color={tone === 'default' ? c.accentText : color} />
      </View>
      <Text style={[type.body, { color, flex: 1, fontFamily: f.medium }]}>{label}</Text>
      {detail ? <Text style={type.caption}>{detail}</Text> : null}
      {selected ? <Icon name="check" size={18} color={c.accentText} /> : null}
    </Pressy>
  );
}

// ── Messaging bits ──────────────────────────────────────────────────────────

function Dot({ delay }: { delay: number }) {
  const s = useStyles();
  const v = useSharedValue(0);
  useEffect(() => {
    v.value = withDelay(delay, withRepeat(withSequence(withTiming(1, { duration: 320 }), withTiming(0, { duration: 320 }), withTiming(0, { duration: 560 })), -1));
  }, []);
  const a = useAnimatedStyle(() => ({ opacity: 0.4 + v.value * 0.6, transform: [{ translateY: -4 * v.value }] }));
  return <Animated.View style={[s.typingDot, a]} />;
}

export function TypingDots() {
  const s = useStyles();
  const t = useT();
  return (
    <Animated.View entering={FadeInDown.springify().damping(16)} style={s.typing} accessibilityLabel={t('thread.typing')}>
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

export function Waveform({ progress = 0.35, playing = false, active, rest = 'rgba(237,231,217,0.45)', bars = WAVE }: {
  progress?: number;
  playing?: boolean;
  active?: string;
  rest?: string;
  bars?: number[];
}) {
  const { c } = useTheme();
  const played = Math.round(bars.length * (playing ? 1 : progress));
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 2, height: 30, flex: 1 }}>
      {bars.map((h, i) => (
        <WaveBar key={i} h={h} i={i} playing={playing} color={i < played ? active ?? c.accent : rest} />
      ))}
    </View>
  );
}

export function EmptyState({ icon, title, body, action }: { icon: IconName; title: string; body: string; action?: React.ReactNode }) {
  const { c, type } = useTheme();
  const s = useStyles();
  return (
    <Rise style={s.empty}>
      <View style={s.emptyIcon}>
        <Icon name={icon} size={30} color={c.accentText} />
      </View>
      <Text style={[type.h3, { textAlign: 'center' }]}>{title}</Text>
      <Text style={[type.bodyMuted, { textAlign: 'center', maxWidth: 300 }]}>{body}</Text>
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

// ── Ripple rings (calls) ────────────────────────────────────────────────────

function Ring({ size, delay, color, duration }: { size: number; delay: number; color: string; duration: number }) {
  const v = useSharedValue(0);
  useEffect(() => {
    v.value = withDelay(delay, withRepeat(withTiming(1, { duration, easing: Easing.out(Easing.quad) }), -1, false));
  }, []);
  const a = useAnimatedStyle(() => ({ opacity: 0.6 * (1 - v.value), transform: [{ scale: 1 + v.value * 0.9 }] }));
  return <Animated.View pointerEvents="none" style={[{ position: 'absolute', width: size, height: size, borderRadius: size / 2, borderWidth: 2, borderColor: color }, a]} />;
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

const useStyles = makeStyles((c, t, f) => ({
  screen: { flex: 1, backgroundColor: c.bg },
  panel: { backgroundColor: c.panel, borderRadius: 22, borderWidth: 1, borderColor: c.line, paddingHorizontal: 18, overflow: 'hidden' },
  button: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10, paddingHorizontal: 22 },
  chip: { minHeight: 34, paddingHorizontal: 15, paddingVertical: 6, borderRadius: 999, borderWidth: 1, borderColor: c.line2, justifyContent: 'center' },
  chipActive: { backgroundColor: c.text, borderColor: c.text },
  chipText: { fontFamily: f.medium, fontSize: 13, color: c.muted },
  badge: { minWidth: 22, height: 22, paddingHorizontal: 7, borderRadius: 11, backgroundColor: c.accent, alignItems: 'center', justifyContent: 'center' },
  badgeText: { fontFamily: f.bold, fontSize: 12, color: c.onAccent },
  pill: { flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 30, paddingHorizontal: 12, paddingVertical: 4, borderRadius: 999, alignSelf: 'flex-start' },
  toggleTrack: { width: 52, height: 32, borderRadius: 16, borderWidth: 1, justifyContent: 'center', paddingHorizontal: 3 },
  toggleKnob: { width: 24, height: 24, borderRadius: 12 },
  segment: { flexDirection: 'row', flexWrap: 'wrap', gap: 4, padding: 4, borderRadius: 14, backgroundColor: c.raised, borderWidth: 1, borderColor: c.line, alignSelf: 'flex-start' },
  segBtn: { minHeight: 36, paddingHorizontal: 14, borderRadius: 10, justifyContent: 'center' },
  segText: { fontFamily: f.medium, fontSize: 13.5, color: c.muted },
  field: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    height: 54,
    paddingHorizontal: 16,
    borderRadius: 16,
    backgroundColor: c.raised,
    borderWidth: 1,
    borderColor: c.line2,
  },
  fieldInput: { flex: 1, minWidth: 0, height: '100%', fontFamily: f.body, fontSize: 16, color: c.text, outlineStyle: 'none' } as any,
  search: { flexDirection: 'row', alignItems: 'center', gap: 10, height: 46, paddingHorizontal: 16, borderRadius: 15, backgroundColor: c.raised, borderWidth: 1, borderColor: c.line },
  searchInput: { flex: 1, minWidth: 0, height: '100%', fontFamily: f.body, fontSize: 15, color: c.text, outlineStyle: 'none' } as any,
  backdrop: { flex: 1, backgroundColor: c.overlay, justifyContent: 'flex-end' },
  sheet: { backgroundColor: c.panel, borderTopLeftRadius: 28, borderTopRightRadius: 28, borderWidth: 1, borderColor: c.line, padding: 22, paddingBottom: 34 },
  dialog: { width: '100%', maxWidth: 460, borderRadius: 26, paddingBottom: 22 },
  handle: { alignSelf: 'center', width: 40, height: 4, borderRadius: 2, backgroundColor: c.line3, marginBottom: 4 },
  sheetRow: { flexDirection: 'row', alignItems: 'center', gap: 14, minHeight: 54, paddingHorizontal: 6, borderRadius: 14 },
  sheetRowIcon: { width: 38, height: 38, borderRadius: 12, backgroundColor: c.raised, alignItems: 'center', justifyContent: 'center' },
  typing: {
    flexDirection: 'row',
    gap: 4,
    paddingVertical: 14,
    paddingHorizontal: 16,
    borderRadius: 20,
    borderBottomLeftRadius: 6,
    backgroundColor: c.theirs,
    borderWidth: 1,
    borderColor: c.line,
    alignSelf: 'flex-start',
    marginVertical: 4,
  },
  typingDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: c.muted },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 10, padding: 32 },
  emptyIcon: { width: 76, height: 76, borderRadius: 24, backgroundColor: c.accentTint, borderWidth: 1, borderColor: c.accentTint2, alignItems: 'center', justifyContent: 'center', marginBottom: 6 },
}));
