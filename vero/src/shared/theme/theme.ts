// Vero Design System — "Ink & Brass" (dark) and "Paper & Brass" (light).
// Solid colours, one brass accent, pine for your own voice, film grain — never neon.
// Screens read colours from useTheme(); these static values exist for non-React code.

import { TextStyle } from 'react-native';

export interface Palette {
  name: 'dark' | 'light';
  bg: string; // screen ground
  panel: string; // side panes, cards
  raised: string; // inputs, chips, received bubbles
  field: string; // pressed / secondary fills
  text: string;
  muted: string;
  faint: string;
  accent: string; // brass fill
  accentHover: string;
  onAccent: string; // text on brass
  accentText: string; // brass used as text/icon on bg
  accentTint: string;
  accentTint2: string;
  accentLine: string;
  mine: string; // own bubble (pine)
  onMine: string;
  mineMeta: string;
  theirs: string;
  success: string;
  successTint: string;
  successLine: string;
  successInk: string; // text on success tint
  danger: string;
  dangerFill: string;
  onDanger: string;
  dangerTint: string;
  wall: string;
  wallDot: string;
  line: string;
  line2: string;
  line3: string;
  tint: string; // hover wash
  tint2: string;
  overlay: string;
  notice: string; // text on brass tint
  grain: string;
  grainOpacity: number;
  hatch: string;
  placeholder: string;
  // Immersive surfaces (calls, media) stay dark in both themes.
  stage: string;
  black: string;
  onStage: string;
  onStageMuted: string;
  avatarText: string;
}

export const dark: Palette = {
  name: 'dark',
  bg: '#0C0E0D',
  panel: '#121513',
  raised: '#191D1A',
  field: '#232824',
  text: '#EDE7D9',
  muted: '#A9A595',
  faint: '#8C897C',
  accent: '#D6A657',
  accentHover: '#E7BD72',
  onAccent: '#1A1406',
  accentText: '#D6A657',
  accentTint: 'rgba(214,166,87,0.10)',
  accentTint2: 'rgba(214,166,87,0.18)',
  accentLine: 'rgba(214,166,87,0.35)',
  mine: '#1F4E40',
  onMine: '#EDE7D9',
  mineMeta: 'rgba(237,231,217,0.6)',
  theirs: '#191D1A',
  success: '#86C09F',
  successTint: 'rgba(134,192,159,0.10)',
  successLine: 'rgba(134,192,159,0.40)',
  successInk: '#B7D3C1',
  danger: '#E0694A',
  dangerFill: '#B5432A',
  onDanger: '#FBEFE6',
  dangerTint: 'rgba(224,105,74,0.10)',
  wall: '#0E100F',
  wallDot: 'rgba(237,231,217,0.06)',
  line: 'rgba(237,231,217,0.08)',
  line2: 'rgba(237,231,217,0.14)',
  line3: 'rgba(237,231,217,0.25)',
  tint: 'rgba(237,231,217,0.04)',
  tint2: 'rgba(237,231,217,0.08)',
  overlay: 'rgba(6,7,7,0.72)',
  notice: '#D9C9A4',
  grain: '#EDE7D9',
  grainOpacity: 0.07,
  hatch: 'rgba(214,166,87,0.04)',
  placeholder: '#7D7A6E',
  stage: '#14231E',
  black: '#070808',
  onStage: '#EDE7D9',
  onStageMuted: '#D9D2C1',
  avatarText: '#F4EEE1',
};

export const light: Palette = {
  name: 'light',
  bg: '#F4EFE4',
  panel: '#FAF7F0',
  raised: '#FFFFFF',
  field: '#ECE6D8',
  text: '#1B1D1B',
  muted: '#5E5B51',
  faint: '#716D60',
  accent: '#D6A657',
  accentHover: '#E2B56B',
  onAccent: '#1A1406',
  accentText: '#8A5F1E',
  accentTint: 'rgba(214,166,87,0.16)',
  accentTint2: 'rgba(214,166,87,0.26)',
  accentLine: 'rgba(138,95,30,0.35)',
  mine: '#1F4E40',
  onMine: '#F4EEE1',
  mineMeta: 'rgba(244,238,225,0.7)',
  theirs: '#FFFFFF',
  success: '#2F7350',
  successTint: 'rgba(47,115,80,0.10)',
  successLine: 'rgba(47,115,80,0.35)',
  successInk: '#285E44',
  danger: '#B5432A',
  dangerFill: '#B5432A',
  onDanger: '#FFF6EF',
  dangerTint: 'rgba(181,67,42,0.10)',
  wall: '#EFE9DC',
  wallDot: 'rgba(27,29,27,0.07)',
  line: 'rgba(27,29,27,0.09)',
  line2: 'rgba(27,29,27,0.15)',
  line3: 'rgba(27,29,27,0.28)',
  tint: 'rgba(27,29,27,0.04)',
  tint2: 'rgba(27,29,27,0.07)',
  overlay: 'rgba(20,20,18,0.45)',
  notice: '#6B4A17',
  grain: '#1B1D1B',
  grainOpacity: 0.05,
  hatch: 'rgba(138,95,30,0.05)',
  placeholder: '#8A8676',
  stage: '#14231E',
  black: '#070808',
  onStage: '#EDE7D9',
  onStageMuted: '#D9D2C1',
  avatarText: '#F4EEE1',
};

/** Solid, muted avatar tones — cream initials read clearly on every one, in both themes. */
export const AvatarTones = ['#9C5B43', '#3F5A73', '#5E6B3A', '#6B4A5E', '#7A5A2E', '#2F5F5F', '#4D4A73', '#7D4B3B'] as const;

export function toneFor(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0;
  return AvatarTones[Math.abs(h) % AvatarTones.length];
}

export function initialsOf(name: string): string {
  const parts = name.replace(/[()[\]{}@._,·|/\\'"!?:;&+*#-]/g, ' ').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return Array.from(parts[0]).slice(0, 2).join('').toUpperCase();
  return (Array.from(parts[0])[0] + Array.from(parts[1])[0]).toUpperCase();
}

// ── Fonts per script ─────────────────────────────────────────────────────────

export type Script = 'latin' | 'deva' | 'beng' | 'taml' | 'telu';

export interface FontSet {
  script: Script;
  display: string;
  displayHeavy: string;
  body: string;
  medium: string;
  semibold: string;
  bold: string;
  mono: string;
  monoMedium: string;
}

const noto = (family: string, script: Script): FontSet => ({
  script,
  display: `${family}_700Bold`,
  displayHeavy: `${family}_800ExtraBold`,
  body: `${family}_400Regular`,
  medium: `${family}_500Medium`,
  semibold: `${family}_600SemiBold`,
  bold: `${family}_700Bold`,
  mono: 'GeistMono_400Regular',
  monoMedium: 'GeistMono_500Medium',
});

export const FONT_SETS: Record<Script, FontSet> = {
  latin: {
    script: 'latin',
    display: 'BricolageGrotesque_700Bold',
    displayHeavy: 'BricolageGrotesque_800ExtraBold',
    body: 'Geist_400Regular',
    medium: 'Geist_500Medium',
    semibold: 'Geist_600SemiBold',
    bold: 'Geist_700Bold',
    mono: 'GeistMono_400Regular',
    monoMedium: 'GeistMono_500Medium',
  },
  deva: noto('NotoSansDevanagari', 'deva'),
  beng: noto('NotoSansBengali', 'beng'),
  taml: noto('NotoSansTamil', 'taml'),
  telu: noto('NotoSansTelugu', 'telu'),
};

/** Static Latin set, for code that renders outside the provider. */
export const Fonts = FONT_SETS.latin;

// ── Type scale ───────────────────────────────────────────────────────────────

export interface TypeSet {
  hero: TextStyle;
  title: TextStyle;
  h2: TextStyle;
  h3: TextStyle;
  name: TextStyle;
  body: TextStyle;
  bodyMuted: TextStyle;
  label: TextStyle;
  caption: TextStyle;
  small: TextStyle;
  eyebrow: TextStyle;
  mono: TextStyle;
  button: TextStyle;
}

/**
 * Indic scripts get no letter-spacing (it breaks conjuncts) and roomier line-heights
 * for matras above and below the line. Latin keeps the tight display tracking.
 */
export function buildType(c: Palette, f: FontSet): TypeSet {
  const latin = f.script === 'latin';
  const ls = (v: number) => (latin ? v : 0);
  const lh = (size: number, latinRatio: number) => Math.round(size * (latin ? latinRatio : Math.max(latinRatio, 1.45)));
  return {
    hero: { fontFamily: f.display, fontSize: 40, lineHeight: lh(40, 1.1), letterSpacing: ls(-1.2), color: c.text },
    title: { fontFamily: f.display, fontSize: 30, lineHeight: lh(30, 1.15), letterSpacing: ls(-0.6), color: c.text },
    h2: { fontFamily: f.display, fontSize: 24, lineHeight: lh(24, 1.2), letterSpacing: ls(-0.5), color: c.text },
    h3: { fontFamily: f.display, fontSize: 19, lineHeight: lh(19, 1.25), letterSpacing: ls(-0.3), color: c.text },
    name: { fontFamily: f.semibold, fontSize: 16, lineHeight: lh(16, 1.3), color: c.text },
    body: { fontFamily: f.body, fontSize: 15, lineHeight: lh(15, 1.42), color: c.text },
    bodyMuted: { fontFamily: f.body, fontSize: 14, lineHeight: lh(14, 1.45), color: c.muted },
    label: { fontFamily: f.medium, fontSize: 13, lineHeight: lh(13, 1.35), color: c.muted },
    caption: { fontFamily: f.body, fontSize: 12.5, lineHeight: lh(12.5, 1.4), color: c.muted },
    small: { fontFamily: f.medium, fontSize: 11, lineHeight: lh(11, 1.35), color: c.faint },
    eyebrow: latin
      ? { fontFamily: f.mono, fontSize: 11, letterSpacing: 1.1, color: c.faint }
      : { fontFamily: f.semibold, fontSize: 12, lineHeight: 18, color: c.faint },
    mono: { fontFamily: f.mono, fontSize: 15, letterSpacing: 1, color: c.text },
    button: { fontFamily: f.semibold, fontSize: 15, lineHeight: lh(15, 1.3) },
  };
}

/** Motion: spring for things that arrive, quick timing for state changes. */
export const Motion = {
  spring: { damping: 16, stiffness: 220, mass: 0.9 },
  softSpring: { damping: 20, stiffness: 160 },
  press: 0.95,
  fast: 160,
  normal: 260,
  slow: 420,
  stagger: 40,
} as const;

/**
 * Static dark palette under the old names, for code outside React — and a bridge for screens
 * not yet moved to useTheme(): the pre-redesign token names map onto Ink & Brass.
 */
/** Legacy color names for one palette, so older screens follow the light/dark setting. */
export function legacyColors(p: Palette) {
  return {
  ...p,
  ink: p.bg,
  cream: p.text,
  brass: p.accent,
  sage: p.success,
  ember: p.danger,
  // Legacy names
  background: p.bg,
  backgroundSecondary: p.panel,
  surface: p.panel,
  surfaceElevated: p.raised,
  surfaceHighlight: p.field,
  surfaceGlass: 'rgba(25,29,26,0.86)',
  surfaceGlassLight: p.tint,
  accentLight: p.accentHover,
  accentDark: '#B88A3E',
  accentGlow: p.accentLine,
  accentSubtle: p.accentTint,
  emerald: p.success,
  emeraldLight: p.successInk,
  emeraldGlow: p.successLine,
  emeraldSubtle: p.successTint,
  purple: '#9C8BC4',
  purpleLight: '#B8AAD9',
  purpleGlow: 'rgba(156,139,196,0.35)',
  purpleSubtle: 'rgba(156,139,196,0.12)',
  teal: '#7FB5A8',
  online: p.success,
  offline: p.faint,
  error: p.danger,
  warning: p.accentHover,
  textPrimary: p.text,
  textSecondary: p.muted,
  textTertiary: p.faint,
  textInverse: p.bg,
  textMuted: p.placeholder,
  bubbleSent: p.mine,
  bubbleSentGradientStart: p.mine,
  bubbleSentGradientEnd: '#173D32',
  bubbleReceived: p.theirs,
  bubbleReceivedBorder: p.line,
  border: p.line,
  borderLight: p.line2,
  borderAccent: p.accentLine,
  borderEmerald: p.successLine,
  divider: p.line,
  glass: 'rgba(18,21,19,0.88)',
  glassHighlight: p.accentTint,
  inputBackground: p.field,
  inputBorder: p.line2,
  inputFocusBorder: p.accent,
  white: '#FFFFFF',
  };
}

export const Colors = legacyColors(dark);

/** Legacy scales, kept for screens not yet on makeStyles(). */
export const Typography = {
  fontSans: FONT_SETS.latin.body,
  xs: 11,
  sm: 13,
  base: 15,
  md: 16,
  lg: 18,
  xl: 20,
  '2xl': 24,
  '3xl': 28,
  '4xl': 34,
  regular: '400' as const,
  medium: '500' as const,
  semibold: '600' as const,
  bold: '700' as const,
  extrabold: '800' as const,
  tight: 1.2,
  normal: 1.5,
  relaxed: 1.8,
} as const;

export const Spacing = { xs: 4, sm: 8, md: 12, base: 16, lg: 20, xl: 24, '2xl': 32, '3xl': 40, '4xl': 48, '5xl': 64 } as const;

export const BorderRadius = {
  sm: 6,
  md: 10,
  lg: 14,
  xl: 18,
  '2xl': 22,
  '3xl': 28,
  full: 9999,
  bubbleSent: 20,
  bubbleReceived: 20,
  bubbleTailSent: 4,
  bubbleTailReceived: 4,
} as const;
