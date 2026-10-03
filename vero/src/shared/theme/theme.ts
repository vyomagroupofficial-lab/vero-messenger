// Vero Messenger Design System
// Ultra-Premium Dark Cyber-Defense UI with Electric Cyan, Emerald, and Violet accents

export const Colors = {
  // Primary backgrounds - Obsidian Black & Deep Space
  background: '#030712',
  backgroundSecondary: '#050B17',
  surface: '#080E1A',
  surfaceElevated: '#0E1726',
  surfaceHighlight: '#142036',
  surfaceGlass: 'rgba(14, 23, 38, 0.82)',
  surfaceGlassLight: 'rgba(255, 255, 255, 0.04)',

  // Accent colors - Electric Cyan & Cyber Neon
  accent: '#06B6D4',           // Electric Cyan
  accentLight: '#22D3EE',
  accentDark: '#0891B2',
  accentGlow: 'rgba(6, 182, 212, 0.35)',
  accentSubtle: 'rgba(6, 182, 212, 0.12)',

  // Security & Cryptographic status
  emerald: '#10B981',          // Verified E2EE Emerald
  emeraldLight: '#34D399',
  emeraldGlow: 'rgba(16, 185, 129, 0.35)',
  emeraldSubtle: 'rgba(16, 185, 129, 0.12)',

  // Secondary Accents
  purple: '#8B5CF6',           // Royal Violet for Groups & Key Exchange
  purpleLight: '#A78BFA',
  purpleGlow: 'rgba(139, 92, 246, 0.35)',
  purpleSubtle: 'rgba(139, 92, 246, 0.12)',
  teal: '#14B8A6',

  // Status colors
  online: '#10B981',
  offline: '#64748B',
  error: '#F43F5E',            // Neon Rose
  warning: '#F59E0B',
  success: '#10B981',

  // Text
  textPrimary: '#F8FAFC',
  textSecondary: '#94A3B8',
  textTertiary: '#64748B',
  textInverse: '#030712',
  textMuted: '#475569',

  // Message bubbles
  bubbleSent: '#0284C7',
  bubbleSentGradientStart: '#0284C7',
  bubbleSentGradientEnd: '#0369A1',
  bubbleReceived: '#0F172A',
  bubbleReceivedBorder: 'rgba(255, 255, 255, 0.07)',

  // Borders & dividers
  border: 'rgba(255, 255, 255, 0.08)',
  borderLight: 'rgba(255, 255, 255, 0.14)',
  borderAccent: 'rgba(6, 182, 212, 0.3)',
  borderEmerald: 'rgba(16, 185, 129, 0.3)',
  divider: 'rgba(255, 255, 255, 0.06)',

  // Glass effect
  glass: 'rgba(8, 14, 26, 0.85)',
  glassHighlight: 'rgba(6, 182, 212, 0.1)',

  // Input
  inputBackground: '#0B1322',
  inputBorder: 'rgba(255, 255, 255, 0.1)',
  inputFocusBorder: '#06B6D4',

  // Overlay
  overlay: 'rgba(3, 7, 18, 0.85)',

  // White/Dark
  white: '#FFFFFF',
  black: '#000000',
} as const;

export const Typography = {
  // Font families
  fontSans: 'System',

  // Font sizes
  xs: 11,
  sm: 13,
  base: 15,
  md: 16,
  lg: 18,
  xl: 20,
  '2xl': 24,
  '3xl': 28,
  '4xl': 34,

  // Font weights
  regular: '400' as const,
  medium: '500' as const,
  semibold: '600' as const,
  bold: '700' as const,
  extrabold: '800' as const,

  // Line heights
  tight: 1.2,
  normal: 1.5,
  relaxed: 1.8,
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
  sm: 6,
  md: 10,
  lg: 14,
  xl: 18,
  '2xl': 22,
  '3xl': 28,
  full: 9999,

  // Message bubble specific
  bubbleSent: 20,
  bubbleReceived: 20,
  bubbleTailSent: 4,
  bubbleTailReceived: 4,
} as const;

export const Shadows = {
  sm: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.35,
    shadowRadius: 3,
    elevation: 2,
  },
  md: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.45,
    shadowRadius: 10,
    elevation: 5,
  },
  lg: {
    shadowColor: '#06B6D4',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.25,
    shadowRadius: 20,
    elevation: 10,
  },
  glow: {
    shadowColor: '#06B6D4',
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.6,
    shadowRadius: 24,
    elevation: 15,
  },
  emeraldGlow: {
    shadowColor: '#10B981',
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.5,
    shadowRadius: 20,
    elevation: 12,
  },
  purpleGlow: {
    shadowColor: '#8B5CF6',
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.5,
    shadowRadius: 20,
    elevation: 12,
  },
} as const;

export const Animation = {
  fast: 150,
  normal: 250,
  slow: 400,
} as const;
