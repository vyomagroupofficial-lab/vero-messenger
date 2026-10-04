// Mirrors vero/src/shared/theme/theme.ts so the trailer matches the app 1:1.
export const C = {
  bg: '#030712',
  bg2: '#050B17',
  callBg: '#050A14',
  surface: '#080E1A',
  surfaceElevated: '#0E1726',
  surfaceHighlight: '#142036',
  accent: '#06B6D4',
  accentLight: '#22D3EE',
  accentDark: '#0891B2',
  accentGlow: 'rgba(6, 182, 212, 0.35)',
  emerald: '#10B981',
  emeraldLight: '#34D399',
  purple: '#8B5CF6',
  purpleLight: '#A78BFA',
  warning: '#F59E0B',
  error: '#F43F5E',
  text: '#F8FAFC',
  text2: '#94A3B8',
  text3: '#64748B',
  muted: '#475569',
  bubbleSent: '#0284C7',
  bubbleSentEnd: '#0369A1',
  bubbleReceived: '#0F172A',
  border: 'rgba(255, 255, 255, 0.08)',
  input: '#0B1322',
  white: '#FFFFFF',
} as const;

export const AVATARS = ['#06B6D4', '#8B5CF6', '#10B981', '#F59E0B', '#EC4899'];
export const avatarColor = (name: string) => AVATARS[Math.abs(name.charCodeAt(0)) % AVATARS.length];
