// Vero Design System — "Ink & Brass"
// Warm ink grounds, one confident brass accent, deep pine for your own voice.
// Solid colours, film grain and a quiet dotted wallpaper — never neon.

const ink = '#0C0E0D';
const panel = '#121513';
const raised = '#191D1A';
const field = '#232824';
const cream = '#EDE7D9';
const muted = '#A9A595';
const faint = '#8C897C';
const brass = '#D6A657';
const brassLight = '#E7BD72';
const pine = '#1F4E40';
const pineLight = '#2A6352';
const sage = '#86C09F';
const ember = '#E0694A';
const emberDeep = '#B5432A';

export const Colors = {
  // Core palette
  ink,
  panel,
  raised,
  field,
  cream,
  muted,
  faint,
  brass,
  brassLight,
  brassInk: '#1A1406', // text on brass
  pine,
  pineLight,
  sage,
  ember,
  emberDeep,
  wallpaper: '#0E100F',
  stage: '#14231E', // call backgrounds
  black: '#070808',
  avatarText: '#F4EEE1',

  // Lines
  line: 'rgba(237,231,217,0.08)',
  line2: 'rgba(237,231,217,0.14)',
  line3: 'rgba(237,231,217,0.25)',

  // Tints
  brassTint: 'rgba(214,166,87,0.10)',
  brassTint2: 'rgba(214,166,87,0.18)',
  brassLine: 'rgba(214,166,87,0.35)',
  sageTint: 'rgba(134,192,159,0.10)',
  sageLine: 'rgba(134,192,159,0.40)',
  emberTint: 'rgba(224,105,74,0.10)',
  creamTint: 'rgba(237,231,217,0.04)',
  creamTint2: 'rgba(237,231,217,0.08)',
  overlay: 'rgba(6,7,7,0.72)',

  // Semantic aliases (kept for older call-sites)
  background: ink,
  backgroundSecondary: panel,
  surface: panel,
  surfaceElevated: raised,
  surfaceHighlight: field,
  accent: brass,
  accentLight: brassLight,
  accentDark: '#B38641',
  accentSubtle: 'rgba(214,166,87,0.12)',
  emerald: sage,
  emeraldLight: sage,
  online: sage,
  offline: faint,
  error: ember,
  warning: brassLight,
  success: sage,
  purple: '#8D7AB0',
  purpleLight: '#B49AD6',
  teal: '#6FA89A',
  textPrimary: cream,
  textSecondary: muted,
  textTertiary: faint,
  textInverse: ink,
  textMuted: '#6F6C62',
  bubbleSent: pine,
  bubbleReceived: raised,
  border: 'rgba(237,231,217,0.08)',
  borderLight: 'rgba(237,231,217,0.14)',
  divider: 'rgba(237,231,217,0.07)',
  glassHighlight: 'rgba(214,166,87,0.10)',
  inputBackground: raised,
  white: '#FFFFFF',
} as const;

/** Solid, muted avatar tones — cream initials read clearly on every one. */
export const AvatarTones = [
  '#9C5B43', // clay
  '#3F5A73', // slate
  '#5E6B3A', // olive
  '#6B4A5E', // plum
  '#7A5A2E', // ochre
  '#2F5F5F', // teal
  '#4D4A73', // dusk
  '#7D4B3B', // rust
] as const;

export function toneFor(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0;
  return AvatarTones[Math.abs(h) % AvatarTones.length];
}

export function initialsOf(name: string): string {
  const parts = name.replace(/[()[\]{}@._,·|/\\'"!?:;&+*#-]/g, ' ').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

export const Fonts = {
  display: 'BricolageGrotesque_700Bold',
  displayHeavy: 'BricolageGrotesque_800ExtraBold',
  displayMedium: 'BricolageGrotesque_600SemiBold',
  body: 'Geist_400Regular',
  medium: 'Geist_500Medium',
  semibold: 'Geist_600SemiBold',
  bold: 'Geist_700Bold',
  mono: 'GeistMono_400Regular',
  monoMedium: 'GeistMono_500Medium',
} as const;

/** Ready-made text styles. Font weight lives in the family, never in fontWeight. */
export const Type = {
  hero: { fontFamily: Fonts.display, fontSize: 40, letterSpacing: -1.2, color: cream },
  title: { fontFamily: Fonts.display, fontSize: 30, letterSpacing: -0.6, color: cream },
  h2: { fontFamily: Fonts.display, fontSize: 24, letterSpacing: -0.5, color: cream },
  h3: { fontFamily: Fonts.display, fontSize: 19, letterSpacing: -0.3, color: cream },
  name: { fontFamily: Fonts.semibold, fontSize: 16, color: cream },
  body: { fontFamily: Fonts.body, fontSize: 15, lineHeight: 21, color: cream },
  bodyMuted: { fontFamily: Fonts.body, fontSize: 14, lineHeight: 20, color: muted },
  label: { fontFamily: Fonts.medium, fontSize: 13, color: muted },
  caption: { fontFamily: Fonts.body, fontSize: 12.5, color: muted },
  small: { fontFamily: Fonts.medium, fontSize: 11, color: faint },
  eyebrow: { fontFamily: Fonts.mono, fontSize: 11, letterSpacing: 1.1, color: faint },
  mono: { fontFamily: Fonts.mono, fontSize: 15, letterSpacing: 1, color: cream },
  button: { fontFamily: Fonts.semibold, fontSize: 15 },
} as const;

export const Typography = {
  fontSans: Fonts.body,
  xs: 11,
  sm: 13,
  base: 15,
  md: 16,
  lg: 18,
  xl: 20,
  '2xl': 24,
  '3xl': 30,
  '4xl': 40,
  regular: '400' as const,
  medium: '500' as const,
  semibold: '600' as const,
  bold: '700' as const,
  extrabold: '800' as const,
  tight: 1.2,
  normal: 1.45,
  relaxed: 1.6,
} as const;

export const Spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  base: 16,
  lg: 20,
  xl: 24,
  '2xl': 32,
  '3xl': 40,
  '4xl': 48,
  '5xl': 64,
} as const;

export const BorderRadius = {
  sm: 8,
  md: 12,
  lg: 15,
  xl: 18,
  '2xl': 22,
  '3xl': 28,
  full: 9999,
  bubble: 20,
  bubbleTail: 6,
} as const;

export const Shadows = {
  sm: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.3,
    shadowRadius: 4,
    elevation: 2,
  },
  md: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.4,
    shadowRadius: 24,
    elevation: 8,
  },
  lg: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 24 },
    shadowOpacity: 0.55,
    shadowRadius: 50,
    elevation: 16,
  },
} as const;

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

export const Animation = Motion;
